import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createControllableRuntimeClock, openDevDatabase, routeEndpoint, runCurrentUserJobWorker, recoverExpiredJobLeases } from '../dist/server-runtime-source.js';
import { createStripeCallbackEndpoint } from '../dist/stripe-webhook-runtime.js';
import { createStripeTeamBillingProvider } from '../dist/stripe-team-billing-provider.js';
import { createPrivilegedTeamBillingApi } from '../dist/team-billing-runtime.js';

const secret = 'whsec_late_capture';
const config = { enabled: true, secretKeyEnv: 'STRIPE_KEY', webhookSecretEnv: 'WEBHOOK_KEY', cardIdentityKeyEnv: 'CARD_KEY',
  publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/events', apiVersion: '2026-08-26.dahlia', livemode: false,
  requestTimeoutMs: 1000, tax: { enabled: false } };
const catalogue = { products: [{ id: 'prod_team', prices: [{ id: 'price_team', recurring: 'month' }] }], portalConfigurations: [] };

// A separate CLI process owns provider state. Every control, SDK read and signed callback crosses HTTP.
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'card-capture-http-'));
  const clock = createControllableRuntimeClock(new Date());
  const open = () => openDevDatabase(path.join(dir, 'capture.db'), '',
    { STRIPE_KEY: 'sk_test_capture', WEBHOOK_KEY: secret, CARD_KEY: '0123456789abcdef0123456789abcdef' },
    { name: 'late-card', payments: { stripe: config } }, { name: 'late-card', schema: {}, teamBilling: {
      catalogue: { team: { quantity: { kind: 'fixed', value: 1 }, stripe: {
        sandbox: { priceId: 'price_team' }, live: { priceId: 'price_live_team' },
      } } }, authorize: () => ({ allow: true }),
    } }, { clock, createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  let database = await open();
  const server = createServer(async (req, res) => {
    try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); }
    catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const cataloguePath = path.join(dir, 'catalogue.json'); await writeFile(cataloguePath, JSON.stringify(catalogue));
  const child = spawn(process.execPath, ['bin/sporades.js', 'stripe-fake', '--json', '--port', '0', '--delivery', 'manual',
    '--catalogue', cataloguePath, '--webhook-target', `http://127.0.0.1:${server.address().port}/stripe/events`, '--webhook-secret-stdin'],
    { env: { ...process.env, SPORADES_CONFIG_DIR: path.resolve('.tmp/card-capture-config') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await database.close(); await rm(dir, { recursive: true, force: true });
  });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]).data); });
    child.once('exit', () => reject(new Error(`Emulator exited before startup: ${errors}`)));
  });
  child.stdin.end(`${secret}\n`);
  const origins = await started;
  async function control(operation, ...args) {
    const response = await fetch(`${origins.controlOrigin}/__control/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  }
  database.stripeApiBaseUrl = origins.origin;
  await database.init(); database.scheduleTeamBillingJobDispatch = () => {};
  let api = createPrivilegedTeamBillingApi(database, () => ({ __privilegedRunActive: true }));
  async function deliver(event) {
    assert.ok((await control('events.deliver', event.id)).every(result => result.status === 200));
    await runCurrentUserJobWorker(database);
  }
  async function checkout(options = {}, trialDays = 14) {
    const teamId = randomUUID(), operationId = randomUUID(), now = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Capture', ?, 'admin')").run(teamId, now);
    database.adapter.prepare("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [idempotencyKey], [createdAt], [updatedAt], [mode], [quantity], [providerPriceId]) VALUES (?, ?, ?, 'admin', 'checkout', 'team', 'ready', ?, ?, ?, 'sandbox', 1, 'price_team')").run(operationId, operationId, teamId, operationId, now, now);
    assert.deepEqual(await api.getCardIdentity(teamId), { state: 'none' });
    const provider = createStripeTeamBillingProvider({ config, env: database.serverEnv, apiBaseUrl: origins.origin });
    const created = await provider.create({ operationId, teamId, productKey: 'team', businessReference: operationId,
      mode: 'subscription', priceId: 'price_team', quantity: 1, successPath: '/billing', cancelPath: '/billing',
      idempotencyKey: operationId, providerExpiresAt: Math.floor(Date.now() / 1000) + 3600, ...(trialDays ? { trialDays } : {}) });
    const completed = await control('checkout.complete', created.sessionId, options);
    return { teamId, operationId, completed, event: (await control('events.pending')).find(event => event.type === 'checkout.session.completed' && event.data.object.id === created.sessionId) };
  }
  const pendingRow = op => database.adapter.prepare('SELECT * FROM [sporades_team_billing_card_identities] WHERE [operationId] = ?').get(op.operationId);
  async function exhaust(op) {
    for (let attempt = 1; attempt < 4; attempt++) {
      clock.advanceBy(1001); await runCurrentUserJobWorker(database);
      assert.deepEqual(await api.getCardIdentity(op.teamId), { state: 'pending' });
    }
    assert.equal(pendingRow(op).kind, 'pending');
    const delayed = database.adapter.prepare("SELECT [status], [availableAt] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-card-identity' AND [payload] LIKE ? AND [status] = 'delayed'").all(`%${pendingRow(op).generationId}%`);
    assert.equal(delayed.length, 1); assert.ok(delayed[0].availableAt > clock.now().toISOString());
  }
  const queued = () => database.adapter.prepare("SELECT * FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-card-identity' AND [status] IN ('queued', 'delayed', 'running')").all();
  const reads = async () => (await control('requests')).filter(r => r.operation === 'subscriptions.retrieve').length;
  async function restart() {
    await database.close(); database = await open(); database.stripeApiBaseUrl = origins.origin;
    await database.init(); database.scheduleTeamBillingJobDispatch = () => {};
    api = createPrivilegedTeamBillingApi(database, () => ({ __privilegedRunActive: true }));
  }
  async function spendBudget(op) {
    for (let step = 0; pendingRow(op).kind === 'pending' && step < 30; step++) {
      const [job] = queued(); assert.ok(job);
      clock.advanceBy(Math.max(1001, Date.parse(job.availableAt) - clock.now().getTime()));
      await clock.runDueTimers(); await runCurrentUserJobWorker(database);
    }
    assert.deepEqual(await api.getCardIdentity(op.teamId), { state: 'unavailable' });
    assert.equal(queued().length, 0);
  }
  return { get database() { return database; }, get api() { return api; }, clock, control, checkout, deliver, exhaust, pendingRow, restart, spendBudget, queued, reads };
}

test('HTTP Stripe emulator: attachment order, durable repair, same-card equality, non-card and provider retry', async t => {
  const f = await fixture(t);
  const first = await f.checkout({ paymentMethod: { type: 'card', card: 'shared-card' } });
  await f.deliver(first.event);
  const before = await f.api.getCardIdentity(first.teamId); assert.equal(before.state, 'captured');

  const late = await f.checkout({ deferPaymentMethod: true });
  await f.deliver(late.event);
  assert.deepEqual(await f.api.getCardIdentity(late.teamId), { state: 'pending' });
  await f.exhaust(late);
  await f.control('subscriptions.attachPaymentMethod', late.completed.subscription, { type: 'card', card: 'shared-card' });
  // No attachment webhook is delivered: the durable delayed generation must repair by itself.
  f.clock.advanceBy(60_001); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  const after = await f.api.getCardIdentity(late.teamId);
  assert.equal(after.state, 'captured'); assert.equal(after.card.token, before.card.token);

  const noncard = await f.checkout({ paymentMethod: { type: 'sepa_debit' } }, null);
  await f.deliver(noncard.event);
  assert.equal((await f.api.getCardIdentity(noncard.teamId)).card, null);
  assert.equal((await f.api.getCardIdentity(noncard.teamId)).state, 'captured');

  const retry = await f.checkout({ paymentMethod: { type: 'card', card: 'shared-card' } });
  await f.control('faults.inject', { operation: 'subscriptions.retrieve', status: 503 });
  await f.deliver(retry.event);
  assert.deepEqual(await f.api.getCardIdentity(retry.teamId), { state: 'pending' });
  f.clock.advanceBy(1001); await runCurrentUserJobWorker(f.database);
  assert.equal((await f.api.getCardIdentity(retry.teamId)).card.token, before.card.token);

  const state = await f.control('state');
  for (const method of state.paymentMethods) if (method.card) {
    for (const { name } of f.database.adapter.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      assert.ok(!JSON.stringify(f.database.adapter.prepare(`SELECT * FROM [${name}]`).all()).includes(method.card.fingerprint), name);
    }
  }
});

for (const type of ['customer.subscription.updated', 'setup_intent.succeeded', 'invoice.paid']) {
  test(`verified ${type} wakes only associated stopped capture without refreshing captured cards`, async t => {
    const f = await fixture(t);
    const late = await f.checkout({ deferPaymentMethod: true }); await f.deliver(late.event); await f.spendBudget(late);
    const generation = f.pendingRow(late).generationId;
    const subscription = await f.control('subscriptions.attachPaymentMethod', late.completed.subscription, { type: 'card' });
    const foreign = await f.control('events.emit', 'setup_intent.succeeded', {
      id: 'seti_foreign', object: 'setup_intent', status: 'succeeded', customer: 'cus_foreign', livemode: false,
    });
    await f.deliver(foreign); assert.equal(f.pendingRow(late).generationId, generation);
    const hint = type === 'invoice.paid' ? await f.control('events.emit', type, {
      id: 'in_late_capture', object: 'invoice', status: 'paid', livemode: false, customer: subscription.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: subscription.id } },
    }) : (await f.control('events.pending')).find(event => event.type === type && event.data.object.customer === subscription.customer);
    await f.deliver(hint);
    assert.notEqual(f.pendingRow(late).generationId, generation);
    const captured = await f.api.getCardIdentity(late.teamId); assert.equal(captured.state, 'captured');
    // Later provider hints must not turn a captured card back into pending or refresh its token.
    await f.control('subscriptions.attachPaymentMethod', subscription.id, { type: 'card', card: 'another-card' });
    const later = (await f.control('events.pending')).filter(event => event.type === type).at(-1);
    if (later && later.id !== hint.id) await f.deliver(later);
    assert.deepEqual(await f.api.getCardIdentity(late.teamId), captured);
  });
}


test('capture replacement is atomic and recovers an exhausted interrupted claim', async t => {
  const f = await fixture(t);
  const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event);
  const original = f.pendingRow(op);
  const payload = { operationId: op.operationId, generationId: original.generationId };
  const jobsBefore = f.database.adapter.prepare('SELECT COUNT(*) AS count FROM [sporades_jobs]').get().count;
  const { settleExhaustedTeamBillingCardIdentityJob } = await import('../dist/team-billing-card-identity.js');
  await assert.rejects(f.database.adapter.withTransaction(async tx => {
    await settleExhaustedTeamBillingCardIdentityJob({ ...f.database, adapter: tx, __transactionActive: true }, payload);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(f.pendingRow(op).generationId, original.generationId);
  assert.equal(f.database.adapter.prepare('SELECT COUNT(*) AS count FROM [sporades_jobs]').get().count, jobsBefore);
  const expired = new Date(f.clock.now().getTime() - 1000).toISOString();
  f.database.adapter.prepare("UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 4, [leaseExpiresAt] = ?, [claimToken] = ? WHERE [handler] = '_sporades.team-billing-card-identity' AND [payload] LIKE ?").run(expired, randomUUID(), `%${original.generationId}%`);
  await recoverExpiredJobLeases(f.database);
  assert.notEqual(f.pendingRow(op).generationId, original.generationId);
  assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'pending' });
  await f.control('subscriptions.attachPaymentMethod', op.completed.subscription);
  f.clock.advanceBy(60_001); await f.clock.runDueTimers();
  assert.equal((await f.api.getCardIdentity(op.teamId)).state, 'captured');
});


test('capture backs off exponentially, exhausts its durable budget, and stays idle', async t => {
  const f = await fixture(t);
  const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event);
  for (let generation = 1; generation <= 5; generation++) {
    for (let attempt = 1; attempt < 4; attempt++) {
      f.clock.advanceBy(1001); await runCurrentUserJobWorker(f.database);
    }
    if (generation === 5) break;
    const jobs = f.queued(); assert.equal(jobs.length, 1);
    const delay = Date.parse(jobs[0].availableAt) - f.clock.now().getTime();
    assert.equal(delay, [60_000, 300_000, 1_500_000, 7_500_000][generation - 1], 'each replacement backs off by a factor of five');
    f.clock.advanceBy(delay); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  }
  assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'unavailable' });
  assert.equal(f.queued().length, 0);
  assert.equal(await f.reads(), 20);
  f.clock.advanceBy(30 * 24 * 3600_000); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.equal(f.queued().length, 0); assert.equal(await f.reads(), 20);
});


test('restart preserves generation budget, reserved reads and due time, including stopped rows', async t => {
  const f = await fixture(t);
  const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event); await f.exhaust(op);
  const before = f.pendingRow(op), reads = await f.reads();
  for (let restart = 0; restart < 3; restart++) {
    await f.restart();
    assert.equal(f.pendingRow(op).generationCount, before.generationCount);
    assert.equal(f.pendingRow(op).readAttempts, 0);
    assert.equal(f.pendingRow(op).nextAttemptAt, before.nextAttemptAt);
    assert.equal(f.queued().length, 1);
    await runCurrentUserJobWorker(f.database); assert.equal(await f.reads(), reads);
  }
  f.clock.advanceBy(Date.parse(before.nextAttemptAt) - f.clock.now().getTime());
  await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.equal(f.pendingRow(op).readAttempts, 1);
  await f.restart(); assert.equal(f.pendingRow(op).readAttempts, 1);
  await f.spendBudget(op); assert.equal(await f.reads(), 20);
  await f.restart(); assert.equal(f.pendingRow(op).generationCount, 5);
  f.clock.advanceBy(30 * 24 * 3600_000); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'unavailable' });
  assert.equal(f.queued().length, 0); assert.equal(await f.reads(), 20);
});

test('a verified hint revives a stopped capture for only one bounded generation', async t => {
  const f = await fixture(t);
  const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event); await f.spendBudget(op);
  const hint = await f.control('events.emit', 'setup_intent.succeeded', {
    id: 'seti_still_missing', object: 'setup_intent', status: 'succeeded', customer: op.completed.customer, livemode: false,
  });
  await f.deliver(hint);
  assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'pending' });
  assert.equal(f.pendingRow(op).generationCount, 5);
  await f.restart(); await f.spendBudget(op);
  assert.equal(await f.reads(), 24);
  f.clock.advanceBy(30 * 24 * 3600_000); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.equal(f.queued().length, 0); assert.equal(await f.reads(), 24);
  await f.deliver(hint); assert.equal(f.queued().length, 0); assert.equal(await f.reads(), 24, 'replayed hints cannot replenish reads');
});

for (const delivered of [false, true]) {
  test(`cancelled Subscription stops capture ${delivered ? 'on its verified event' : 'when read from the provider'}`, async t => {
    const f = await fixture(t);
    const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event); await f.exhaust(op);
    const before = await f.reads();
    await f.control('subscriptions.setStatus', op.completed.subscription, 'canceled');
    const event = (await f.control('events.pending')).find(e => e.type === 'customer.subscription.deleted');
    if (delivered) await f.deliver(event);
    else { f.clock.advanceBy(60_001); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database); }
    assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'unavailable' });
    assert.equal(f.queued().length, 0); assert.equal(await f.reads(), before + (delivered ? 0 : 1));
    await f.restart(); f.clock.advanceBy(24 * 3600_000); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
    assert.equal(f.queued().length, 0); assert.equal(await f.reads(), before + (delivered ? 0 : 1));
  });
}

test('replaced Subscription and erased Team cannot keep polling', async t => {
  const f = await fixture(t);
  const op = await f.checkout({ deferPaymentMethod: true }); await f.deliver(op.event); await f.exhaust(op);
  const created = (await f.control('events.pending')).find(e => e.type === 'customer.subscription.created');
  await f.deliver(created);
  f.database.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [replacedBy] = 'sub_replacement' WHERE [providerSubscriptionId] = ?").run(op.completed.subscription);
  const before = await f.reads();
  f.clock.advanceBy(60_001); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.deepEqual(await f.api.getCardIdentity(op.teamId), { state: 'unavailable' });
  assert.equal(f.queued().length, 0); assert.equal(await f.reads(), before);
  const erased = await f.checkout({ deferPaymentMethod: true }); await f.deliver(erased.event); await f.exhaust(erased);
  const reads = await f.reads();
  // Local erasure removes Team authority; stale queued work must never call Stripe or recreate capture.
  f.database.adapter.prepare('DELETE FROM [sporades_teams] WHERE [id] = ?').run(erased.teamId);
  f.database.adapter.prepare('DELETE FROM [sporades_team_billing_card_identities] WHERE [teamId] = ?').run(erased.teamId);
  await f.restart(); f.clock.advanceBy(30 * 24 * 3600_000); await f.clock.runDueTimers(); await runCurrentUserJobWorker(f.database);
  assert.equal(f.queued().length, 0); assert.equal(await f.reads(), reads);
  assert.equal(f.pendingRow(erased), undefined);
});
