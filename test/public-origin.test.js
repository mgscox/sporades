import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePublicOrigin, normalizePublicOrigin } from '../dist/public-origin.js';
import { resolvePasswordResetConfig } from '../dist/auth-runtime.js';
import { resolveTeamJoinLinkConfig } from '../dist/teams-runtime.js';

test('public origin resolves by session without trusting request or app env values', () => {
  assert.equal(resolvePublicOrigin({ __sporadesSession: 'dev', dev: { port: 5688 }, deploy: { publicOrigin: 'https://container.example' } }), 'http://localhost:5688');
  assert.equal(resolvePublicOrigin({ __sporadesSession: 'container', deploy: { publicOrigin: 'https://container.example/' }, __sporadesPublicOrigin: 'https://env.example' }), 'https://container.example');
  assert.equal(resolvePublicOrigin({ __sporadesSession: 'container', __sporadesPublicOrigin: 'https://env.example' }), 'https://env.example');
  assert.equal(resolvePublicOrigin({ __sporadesSession: 'container', deploy: { port: 5689 } }), 'http://localhost:5689');
  const hosted = { __sporadesSession: 'hosted', __sporadesPublicOrigin: 'https://canonical.example', deploy: { publicOrigin: 'https://ignored.example' } };
  assert.equal(resolvePublicOrigin(hosted), 'https://canonical.example');
  assert.equal(resolvePasswordResetConfig(hosted).origin, 'https://canonical.example');
  assert.equal(resolveTeamJoinLinkConfig(hosted).origin, 'https://canonical.example');
});

test('public origin accepts only HTTP origins without credentials, paths or URL payloads', () => {
  for (const value of ['https://user:secret@example.com', 'https://example.com/path', 'https://example.com?secret', 'https://example.com#secret', 'file:///tmp', 'garbage', 'https://example.com\\evil']) assert.equal(normalizePublicOrigin(value), null, value);
  assert.equal(normalizePublicOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runDoctorChecks } from '../dist/cli/doctor.js';
import { validatePublicOriginConfig } from '../dist/cli/project-config.js';

test('doctor reports Dev and Container configured origins and rejects invalid project origins', async () => {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(path.resolve('.scratch/origin-doctor-'));
  try {
    await writeFile(path.join(dir, 'sporades.json'), JSON.stringify({ name: 'origin-doctor', dev: { port: 5688 }, deploy: { publicOrigin: 'https://container.example' } }));
    const dev = await runDoctorChecks({ projectDir: dir });
    assert.equal(dev.find(c => c.id === 'doctor.public-origin').details.publicOrigin, 'http://localhost:5688');
    const container = await runDoctorChecks({ projectDir: dir, session: 'container' });
    assert.equal(container.find(c => c.id === 'doctor.public-origin').details.publicOrigin, 'https://container.example');
    assert.throws(() => validatePublicOriginConfig({ deploy: { publicOrigin: 'https://user:password@example.com/path' } }), { code: 'INVALID_PUBLIC_ORIGIN' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { capsule, query, mutation } from '../dist/server.js';
import { openDevDatabase, resolveAnonymousSession, signUpWithEmail, runQuery, runMutation, createEmailPasswordResetLink } from '../dist/server-runtime-source.js';
import { createTeamJoinLink, listCurrentUserTeams } from '../dist/teams-runtime.js';

test('server contexts and built-in reset/join links share the canonical origin', async () => {
  const dir = await mkdtemp(path.resolve('.scratch/origin-runtime-'));
  let database;
  try {
    const definition = capsule({ name: 'origin-contexts', queries: { origin: query(ctx => ({ origin: ctx.app.publicOrigin, frozen: Object.isFrozen(ctx.app) })) },
      mutations: { origin: mutation(ctx => ({ origin: ctx.app.publicOrigin })) } });
    database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: definition.name, __sporadesSession: 'hosted', __sporadesPublicOrigin: 'https://canonical.example', auth: { providers: { anonymous: true, email: true } } }, definition);
    const guest = await resolveAnonymousSession(database, null);
    const owner = await signUpWithEmail(database, guest, 'email', { email: 'owner@example.com', password: 'password-123' });
    assert.equal(owner.ok, true, owner.error?.message);
    assert.deepEqual((await runQuery(database, owner.auth, 'origin')).data, { origin: 'https://canonical.example', frozen: true });
    assert.deepEqual((await runMutation(database, owner.auth, 'origin', [])).data, { origin: 'https://canonical.example' });
    const reset = await createEmailPasswordResetLink(database, owner, 'owner@example.com');
    assert.equal(reset.ok, true, reset.error?.message);
    assert.equal(new URL(reset.link).origin, 'https://canonical.example');
    const team = (await listCurrentUserTeams(database, owner.auth)).teams[0];
    const join = await createTeamJoinLink(database, owner.auth, team.id, 'recipient@example.com');
    assert.equal(new URL(join.link).origin, 'https://canonical.example');
    database.contextMiddleware = ['ctx => ({ ...ctx, app: { publicOrigin: "https://spoof.example" } })'];
    assert.equal((await runQuery(database, owner.auth, 'origin')).error.code, 'INVALID_CONTEXT_MIDDLEWARE_RESULT');
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});
