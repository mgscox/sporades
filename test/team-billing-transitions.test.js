import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStripeTeamBillingFake } from 'sporades/testing/stripe';
import { createStripeTeamBillingProvider } from '../dist/stripe-team-billing-provider.js';
import { createStripeCallbackEndpoint } from '../dist/stripe-webhook-runtime.js';
import { openDevDatabase, routeEndpoint, runCurrentUserJobWorker, createWebSocketHub } from '../dist/server-runtime-source.js';
import { startTeamBillingCheckout, readCurrentUserTeamBilling } from '../dist/team-billing-runtime.js';
import { requestTeamBillingPlanTransition } from '../dist/team-billing-management.js';

for (const source of ['basic', 'legacy']) test(`${source} to offered fixed plan switches in place with source authorization`, async t => {
  const f = await fixture(t, source);
  const { database, actor, teamId, fake, subscriptionId } = f;
  await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), source, 'month:1'), { code: 'TEAM_BILLING_DENIED' });
  const requestId = randomUUID();
  assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, requestId, 'offered', 'month:1')).state, 'pending');
  await f.drain();
  assert.equal((await f.read()).state, 'pending', 'provider acknowledgement grants no entitlement');
  assert.equal(fake.state().checkouts.length, 1);
  assert.equal(fake.state().subscriptions.length, 1);
  const updated = fake.subscriptions.get(subscriptionId);
  assert.equal(updated.items.data[0].price.id, 'price_offered_month');
  assert.equal(updated.items.data[0].quantity, 1);
  assert.ok(f.checks.filter(c => c.operation === 'plan-transition' && c.productKey === 'offered').length >= 2);
  for (const input of f.checks.filter(c => c.operation === 'plan-transition' && c.productKey === 'offered')) {
    assert.equal(input.fromProductKey, source);
    assert.equal(input.fromInterval, 'month:1');
    assert.equal(input.interval, 'month:1');
    assert.ok(Object.isFrozen(input));
  }
  await f.deliver();
  assert.deepEqual(await f.read(), { state: 'active', teamId, productKey: 'offered', interval: 'month:1', quantity: 1, renewsAt: new Date(updated.items.data[0].current_period_end * 1000).toISOString() });
  assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, requestId, 'offered', 'month:1')).state, 'completed');
});

test('Checkout completion alone blocks a second purchase before Subscription evidence arrives', async t => {
  const f = await fixture(t, 'basic', true);
  await assert.rejects(startTeamBillingCheckout(f.database, f.actor, f.teamId, randomUUID(), 'offered', 'year:1'), { code: 'TEAM_BILLING_SUBSCRIPTION_EXISTS' });
  assert.equal(f.fake.state().checkouts.length, 1);
  await f.deliver();
  assert.equal((await f.read()).state, 'active');
});

test('terminal incomplete_expired releases Checkout after quarantined incomplete evidence', async t => {
  const f = await fixture(t);
  await f.fake.subscriptions.setStatus(f.subscriptionId, 'incomplete'); await f.deliver();
  assert.equal((await f.read()).state, 'attention-required');
  await assert.rejects(startTeamBillingCheckout(f.database, f.actor, f.teamId, randomUUID(), 'offered', 'month:1'), { code: 'TEAM_BILLING_SUBSCRIPTION_EXISTS' });
  await f.fake.subscriptions.setStatus(f.subscriptionId, 'incomplete_expired'); await f.deliver();
  assert.equal((await f.read()).state, 'cancelled');
  await assert.rejects(f.fake.subscriptions.setStatus(f.subscriptionId, 'active'));
  const stale = f.fake.subscriptions.get(f.subscriptionId); stale.status = 'active';
  await f.fake.events.emit('customer.subscription.updated', stale); await f.deliver();
  assert.equal((await f.read()).state, 'cancelled', 'terminal expiry cannot be revived by later active evidence');
  assert.equal((await startTeamBillingCheckout(f.database, f.actor, f.teamId, randomUUID(), 'offered', 'month:1')).state, 'pending');
});

test('verified unsafe states refuse transitions and Checkout, and terminal cancellation permits Checkout', async t => {
  const f = await fixture(t);
  const { database, actor, teamId, fake, subscriptionId } = f;
  for (const [change, code] of [
    [() => fake.portal.cancelAtPeriodEnd(subscriptionId), 'TEAM_BILLING_SUBSCRIPTION_CANCELLING'],
    [() => fake.subscriptions.setStatus(subscriptionId, 'past_due'), 'TEAM_BILLING_SUBSCRIPTION_PAST_DUE'],
    [() => fake.subscriptions.setStatus(subscriptionId, 'trialing'), 'TEAM_BILLING_SUBSCRIPTION_TRIALING'],
    [() => fake.subscriptions.setSchedule(subscriptionId, 'sub_sched_foreign'), 'TEAM_BILLING_UNKNOWN_SCHEDULE'],
  ]) {
    await change(); await f.deliver();
    if (code.endsWith('TRIALING')) {
      const truth = await f.read();
      assert.equal(truth.state, 'trialing');
      assert.equal(truth.trialEndsAt, new Date(fake.subscriptions.get(subscriptionId).trial_end * 1000).toISOString());
    }
    const writes = fake.requests().filter(r => r.operation === 'subscriptions.update').length;
    const input = { teamId, requestId: randomUUID(), productKey: 'offered', interval: 'year:1' };
    assert.equal((await f.send({ type: 'teamBilling.requestPlanTransition', input })).error.code, code);
    assert.equal((await f.send({ type: 'teamBilling.startCheckout', input: { ...input, requestId: randomUUID() } })).error.code, 'TEAM_BILLING_SUBSCRIPTION_EXISTS');
    assert.equal(fake.requests().filter(r => r.operation === 'subscriptions.update').length, writes);
    await fake.portal.resume(subscriptionId);
    await fake.subscriptions.setStatus(subscriptionId, 'active');
    await fake.subscriptions.setSchedule(subscriptionId, null); await f.deliver();
  }
  await fake.subscriptions.setStatus(subscriptionId, 'canceled'); await f.deliver();
  assert.equal((await f.read()).state, 'cancelled');
  assert.equal((await startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'offered', 'year:1')).state, 'pending');
  await f.drain();
  assert.equal(fake.state().checkouts.length, 2);
});

test('provider read refuses an unsafe state before its callback has arrived', async t => {
  const f = await fixture(t);
  const { database, actor, teamId, fake, subscriptionId } = f;
  for (const [change, code] of [
    [() => fake.portal.cancelAtPeriodEnd(subscriptionId), 'TEAM_BILLING_SUBSCRIPTION_CANCELLING'],
    [() => fake.subscriptions.setStatus(subscriptionId, 'past_due'), 'TEAM_BILLING_SUBSCRIPTION_PAST_DUE'],
    [() => fake.subscriptions.setStatus(subscriptionId, 'trialing'), 'TEAM_BILLING_SUBSCRIPTION_TRIALING'],
    [() => fake.subscriptions.setSchedule(subscriptionId, 'sub_sched_foreign'), 'TEAM_BILLING_UNKNOWN_SCHEDULE'],
  ]) {
    const requestId = randomUUID();
    await requestTeamBillingPlanTransition(database, actor, teamId, requestId, 'offered', 'year:1');
    const writes = fake.requests().filter(r => r.operation === 'subscriptions.update').length;
    await change(); await f.drain();
    assert.equal(fake.requests().filter(r => r.operation === 'subscriptions.update').length, writes);
    assert.equal(database.adapter.prepare('SELECT [safeFailureCode] FROM [sporades_team_billing_operations] WHERE [requestId] = ?').get(requestId).safeFailureCode, code);
    await fake.portal.resume(subscriptionId);
    await fake.subscriptions.setStatus(subscriptionId, 'active');
    await fake.subscriptions.setSchedule(subscriptionId, null); await f.deliver();
  }
});

async function fixture(t, source = 'basic', checkoutOnly = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'billing-transitions-'));
  const teamId = randomUUID();
  const checks = [];
  const offered = new Set([source, 'offered']);
  const catalogue = Object.fromEntries([source, 'offered'].map(key => [key, {
    quantity: { kind: 'fixed', value: 1 }, stripe: Object.fromEntries(['sandbox', 'live'].map(mode => [mode, {
      productId: `prod_${mode === 'live' ? 'live_' : ''}${key}`, portalConfigurationId: `bpc_${mode}_${key}`,
      prices: { 'month:1': { priceId: `price_${mode === 'live' ? 'live_' : ''}${key}_month` }, 'year:1': { priceId: `price_${mode === 'live' ? 'live_' : ''}${key}_year` } },
    }])),
  }]));
  const config = { enabled: true, secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/webhook', apiVersion: '2026-08-26.dahlia', livemode: false, requestTimeoutMs: 1000 };
  const env = { STRIPE_SECRET_KEY: 'sk_test_transitions', STRIPE_WEBHOOK_SECRET: 'whsec_transitions' };
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', env, { name: 'transitions', auth: { providers: { email: true } }, payments: { stripe: config } }, {
    name: 'transitions', schema: {}, teamBilling: {
      catalogue, transitions: { allowSamePolicy: true }, checkout: { successPath: '/billing', cancelPath: '/billing' },
      authorize: (_ctx, input) => { checks.push(input); return { allow: input.operation === 'read' || offered.has(input.productKey) }; },
    },
  }, { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  const callback = createServer(async (req, res) => { try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); } catch { res.writeHead(500).end(); } });
  const hub = createWebSocketHub(() => database);
  callback.on('upgrade', (req, socket) => hub.accept(req, socket));
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const fake = await createStripeTeamBillingFake({ webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${callback.address().port}/stripe/webhook`, delivery: 'manual', catalogue: {
    products: [source, 'offered'].map(key => ({ id: `prod_${key}`, prices: [{ id: `price_${key}_month`, recurring: 'month' }, { id: `price_${key}_year`, recurring: 'year' }] })), portalConfigurations: [],
  } });
  t.after(async () => { await fake.close(); hub.disconnectAll(); callback.closeAllConnections(); await new Promise(resolve => callback.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); });
  database.stripeApiBaseUrl = fake.origin; await database.init();
  // Drive the durable worker explicitly so state can change between admission and execution.
  database.scheduleTeamBillingJobDispatch = () => {};
  const ws = new WebSocket(`ws://127.0.0.1:${callback.address().port}/?connectionToken=${hub.createConnectionToken()}`);
  await once(ws, 'open');
  const send = message => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error(`Timeout: ${message.type}`)); }, 10000);
    const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener('message', listener); resolve(result); } };
    ws.addEventListener('message', listener); ws.send(JSON.stringify({ ...message, id }));
  });
  const signup = await send({ type: 'auth.signUp', provider: 'email', credentials: { email: 'buyer@example.test', password: 'password-123', name: 'Buyer' } });
  assert.equal(signup.error, null);
  const actor = signup.data.auth;
  const now = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Billing', ?, ?)").run(teamId, now, actor.userId);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)").run(teamId, actor.userId, now);
  const drain = async () => { for (let i = 0; i < 5; i++) { await runCurrentUserJobWorker(database); await new Promise(r => setTimeout(r, 10)); } };
  const deliver = async () => { assert.ok((await fake.events.deliver()).every(r => r.status === 200)); await drain(); };
  await startTeamBillingCheckout(database, actor, teamId, randomUUID(), source, 'month:1'); await drain();
  const completed = await fake.checkout.complete(fake.state().checkouts[0].id);
  if (checkoutOnly) {
    const event = fake.events.pending().find(event => event.type === 'checkout.session.completed');
    assert.ok((await fake.events.deliver(event.id)).every(r => r.status === 200)); await drain();
  } else { await deliver(); assert.equal((await readCurrentUserTeamBilling(database, actor, teamId)).state, 'active'); }
  // Keep source checkout available for setup; exclude it as a transition target afterwards.
  offered.delete(source);
  return { database, actor, teamId, fake, checks, send, drain, deliver, subscriptionId: completed.subscription, read: () => readCurrentUserTeamBilling(database, actor, teamId) };
}
