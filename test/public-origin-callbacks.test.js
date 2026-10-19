import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { capsule, query, mutation, table, String as Text } from '../dist/server.js';
import { openDevDatabase, resolveAnonymousSession, signUpWithEmail, runQuery, runMutation, createWebSocketHub } from '../dist/server-runtime-source.js';
import { createTeamJoinLink, joinCurrentUserTeam, listCurrentUserTeams } from '../dist/teams-runtime.js';
import { admitTeamBillingActor } from '../dist/team-billing-runtime.js';
import { createPendingFileUpload } from '../dist/file-storage-runtime.js';
import { probeAppBinding, expectedAppBinding } from './support/app-binding-probe.js';

const origin = 'https://canonical.example';
async function withDatabase(definition, body) {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(path.resolve('.scratch/origin-callbacks-'));
  let database;
  try {
    database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, {
      name: definition.name, __sporadesSession: 'hosted', __sporadesPublicOrigin: origin,
      auth: { providers: { anonymous: true, email: true } },
    }, definition);
    await body(database);
    assert.equal(database.app.publicOrigin, origin);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('table ACL callbacks cannot replace, delete or redefine the canonical app binding', async () => {
  const observations = [];
  const definition = capsule({ name: 'origin-acl', schema: {
    notes: table({ title: Text() }).acl({ read: ({ ctx }) => { observations.push(probeAppBinding(ctx)); return true; }, write: () => true }),
  }, mutations: { add: mutation(ctx => ctx.db.notes.insert({ title: 'visible' })) },
  queries: { notes: query(ctx => ctx.db.notes.all()) } });
  await withDatabase(definition, async database => {
    const guest = await resolveAnonymousSession(database, null);
    assert.equal((await runMutation(database, guest.auth, 'add', [])).error, null);
    observations.length = 0;
    const result = await runQuery(database, guest.auth, 'notes');
    assert.equal(result.error, null);
    assert.equal(result.data.length, 1);
    assert.deepEqual(observations, [expectedAppBinding(origin)]);
  });
});

for (const stage of ['admit', 'finalize']) test(`registration ${stage} cannot replace, delete or redefine the canonical app binding`, async () => {
  const observations = [];
  const definition = capsule({ name: `origin-registration-${stage}`, schema: { claims: table({ origin: Text() }) },
    auth: { registration: {
      admit(ctx) {
        if (stage === 'admit') observations.push(probeAppBinding(ctx));
        return { allow: true };
      },
      async finalize(ctx) {
        if (stage === 'finalize') observations.push(probeAppBinding(ctx));
        await ctx.db.claims.insert({ origin: ctx.app.publicOrigin });
      },
    } }, queries: { claims: query(ctx => ctx.db.claims.all()) } });
  await withDatabase(definition, async database => {
    const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), 'email', {
      email: `${stage}@example.com`, password: 'password-123',
    });
    assert.equal(owner.ok, true, owner.error?.message);
    assert.deepEqual(observations, [expectedAppBinding(origin)]);
    const claims = await runQuery(database, owner.auth, 'claims');
    assert.equal(claims.error, null);
    assert.deepEqual(claims.data.map(claim => claim.origin), [origin]);
  });
});

test('reauthentication policy cannot replace, delete or redefine the canonical app binding', async () => {
  const observations = [];
  const definition = capsule({ name: 'origin-reauth', auth: { reauthentication: {
    purposes: { confirm: { maxAgeSeconds: 300 } },
    authorize(ctx) { observations.push(probeAppBinding(ctx)); return true; },
  } } });
  await withDatabase(definition, async database => {
    const hub = createWebSocketHub(() => database);
    const server = createServer();
    server.on('upgrade', (request, socket) => { request.headers.origin = origin; hub.accept(request, socket); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
      await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
      const send = async message => {
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('WebSocket response timed out')); }, 3000);
          function onMessage(event) {
            const value = JSON.parse(event.data);
            if (value.id !== message.id) return;
            clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve(value);
          }
          socket.addEventListener('message', onMessage);
        });
        socket.send(JSON.stringify(message));
        return response;
      };
      const credentials = { email: 'reauth@example.com', password: 'password-123' };
      assert.equal((await send({ id: 'signup', type: 'auth.signUp', provider: 'email', credentials })).error, null);
      assert.equal((await send({ id: 'confirm', type: 'auth.reauthenticate', provider: 'email', credentials, purpose: 'confirm' })).error, null);
      assert.deepEqual(observations, [expectedAppBinding(origin)]);
    } finally { socket?.close(); hub.disconnectAll(); await new Promise(resolve => server.close(resolve)); }
  });
});

test('Team join policy cannot replace, delete or redefine the canonical app binding', async () => {
  const observations = [];
  const definition = capsule({ name: 'origin-team-join', teams: {
    admitJoin(ctx) { observations.push(probeAppBinding(ctx)); return { allow: true }; },
  } });
  await withDatabase(definition, async database => {
    const signup = async email => signUpWithEmail(database, await resolveAnonymousSession(database, null), 'email', { email, password: 'password-123' });
    const owner = await signup('owner@example.com'); const member = await signup('member@example.com');
    assert.equal(owner.ok, true); assert.equal(member.ok, true);
    const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
    const link = await createTeamJoinLink(database, owner.auth, team.id, 'member@example.com');
    await joinCurrentUserTeam(database, member.auth, new URL(link.link).searchParams.get('code'));
    assert.deepEqual(observations, [expectedAppBinding(origin)]);
    assert((await listCurrentUserTeams(database, member.auth)).teams.some(item => item.id === team.id));
  });
});

test('Team billing policy cannot replace, delete or redefine the canonical app binding', async () => {
  const observations = [];
  const definition = capsule({ name: 'origin-team-billing', teamBilling: {
    catalogue: { basic: { quantity: { kind: 'fixed', value: 1 }, stripe: { sandbox: { priceId: 'price_test_basic' }, live: { priceId: 'price_live_basic' } } } },
    authorize(ctx) { observations.push(probeAppBinding(ctx)); return { allow: true }; },
  } });
  await withDatabase(definition, async database => {
    const owner = await signUpWithEmail(database, await resolveAnonymousSession(database, null), 'email', { email: 'billing@example.com', password: 'password-123' });
    assert.equal(owner.ok, true);
    const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
    const result = await database.adapter.withTransaction(tx => admitTeamBillingActor(database, tx, owner.auth, { operation: 'checkout', teamId: team.id, productKey: 'basic' }));
    assert.deepEqual(result, { admitted: true });
    assert.deepEqual(observations, [expectedAppBinding(origin)]);
  });
});

test('File upload policy preserves the canonical app binding', async () => {
  const observations = [];
  const definition = capsule({ name: 'origin-file-policy', files: { acl: {
    upload(ctx) { observations.push(probeAppBinding(ctx)); return true; },
  } } });
  await withDatabase(definition, async database => {
    const guest = await resolveAnonymousSession(database, null);
    const result = await createPendingFileUpload(database, guest.auth, { file: { name: 'hello.txt', type: 'text/plain', size: 5 } });
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(observations, [expectedAppBinding(origin)]);
  });
});
