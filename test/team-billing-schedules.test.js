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
import { prepareTeamBillingErasure } from '../dist/team-billing-erasure.js';
import {
  requestTeamBillingPlanTransition, cancelScheduledTeamBillingPlanTransition, stageTeamBillingMembershipChange, repairTeamBillingDesiredState,
} from '../dist/team-billing-management.js';

const SCHEDULE_TEST = { periodEnd: true, counted: false };

test('a period-end downgrade keeps the current plan until the boundary, then switches', async t => {
  const f = await fixture(t, SCHEDULE_TEST);
  const { database, actor, teamId, fake, subscriptionId } = f;
  const requestId = randomUUID();
  assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, requestId, 'offered', 'month:1')).state, 'pending');
  await f.drain();
  const subscription = fake.subscriptions.get(subscriptionId);
  assert.equal(subscription.items.data[0].price.id, 'price_basic_month', 'the current plan is unchanged');
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptions.update').length, 0, 'schedule writes never edit the Subscription directly');
  const schedule = fake.state().schedules.at(-1);
  assert.equal(schedule.status, 'active');
  assert.equal(schedule.phases.length, 2);
  assert.equal(schedule.phases[0].items[0].price.id, 'price_basic_month');
  assert.equal(schedule.phases[0].items[0].quantity, 1);
  assert.equal(schedule.phases[1].items[0].price.id, 'price_offered_month');
  assert.equal(schedule.phases[1].items[0].quantity, 1);
  assert.equal(schedule.phases[1].proration_behavior, 'none');
  assert.equal(schedule.end_behavior, 'release');
  assert.equal(subscription.schedule, schedule.id);
  assert.equal((await f.read()).state, 'pending', 'provider acknowledgement grants no entitlement');
  await fake.clock.advance(subscription.items.data[0].current_period_end - fake.state().now);
  await f.deliver();
  const read = await f.read();
  assert.equal(read.state, 'active');
  assert.equal(read.productKey, 'offered');
  assert.equal(read.interval, 'month:1');
  assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, requestId, 'offered', 'month:1')).state, 'completed');
  assert.equal(fake.state().schedules.at(-1).status, 'released');
  assert.equal(fake.subscriptions.get(subscriptionId).schedule, null);
});

test('cancelScheduledPlanTransition releases the schedule and restores the original plan', async t => {
  const f = await fixture(t, SCHEDULE_TEST);
  const { database, actor, teamId, fake, subscriptionId } = f;
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1');
  await f.drain();
  const scheduleId = fake.subscriptions.get(subscriptionId).schedule;
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptionSchedules.release').length, 0);
  const cancelRequestId = randomUUID();
  assert.equal((await cancelScheduledTeamBillingPlanTransition(database, actor, teamId, cancelRequestId)).state, 'pending');
  await f.drain();
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptionSchedules.release').length, 1);
  await f.deliver();
  assert.equal(fake.state().schedules.at(-1).status, 'released');
  assert.equal(fake.subscriptions.get(subscriptionId).schedule, null);
  assert.equal(fake.subscriptions.get(subscriptionId).items.data[0].price.id, 'price_basic_month');
  const read = await f.read();
  assert.equal(read.state, 'active');
  assert.equal(read.productKey, 'basic', 'the original plan keeps running');
  assert.equal((await cancelScheduledTeamBillingPlanTransition(database, actor, teamId, cancelRequestId)).state, 'completed');
  // After the release a fresh period-end request may schedule again.
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1');
  await f.drain();
  assert.equal(fake.state().schedules.at(-1).status, 'active');
});

test('cancelling without a scheduled change refuses, and a foreign schedule blocks transitions', async t => {
  const f = await fixture(t, SCHEDULE_TEST);
  const { database, actor, teamId, fake, subscriptionId } = f;
  await assert.rejects(cancelScheduledTeamBillingPlanTransition(database, actor, teamId, randomUUID()), { code: 'TEAM_BILLING_DENIED' });
  await fake.subscriptions.setSchedule(subscriptionId, 'sub_sched_foreign_dashboard');
  await f.deliver();
  await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1'), { code: 'TEAM_BILLING_UNKNOWN_SCHEDULE' });
  const read = await f.read();
  assert.equal(read.state, 'active');
  assert.equal(read.productKey, 'basic');
});

test('a later period-end request replaces the pending phase of the same schedule', async t => {
  const f = await fixture(t, SCHEDULE_TEST);
  const { database, actor, teamId, fake, subscriptionId } = f;
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1');
  await f.drain();
  const schedulesBefore = fake.requests().filter(r => r.operation === 'subscriptionSchedules.create').length;
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'year:1');
  await f.drain();
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptionSchedules.create').length, schedulesBefore, 'no second schedule is created');
  const schedule = fake.state().schedules.at(-1);
  assert.equal(schedule.phases[1].items[0].price.id, 'price_offered_year');
  await fake.clock.advance(fake.subscriptions.get(subscriptionId).items.data[0].current_period_end - fake.state().now);
  await f.deliver();
  const read = await f.read();
  assert.equal(read.state, 'active');
  assert.equal(read.productKey, 'offered');
  assert.equal(read.interval, 'year:1');
});

test('seat changes during a schedule land in both phases', async t => {
  const f = await fixture(t, { ...SCHEDULE_TEST, counted: true });
  const { database, actor, teamId, fake, subscriptionId } = f;
  const now = new Date().toISOString();
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1');
  await f.drain();
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'second-seat', 'member', ?)").run(teamId, now);
  const staged = await stageTeamBillingMembershipChange(database, teamId);
  assert.equal(staged.staged, true);
  await f.drain();
  const subscription = fake.subscriptions.get(subscriptionId);
  assert.equal(subscription.items.data[0].quantity, 2, 'the current phase bills the new count immediately');
  const schedule = fake.state().schedules.at(-1);
  assert.equal(schedule.phases[0].items[0].quantity, 2);
  assert.equal(schedule.phases[1].items[0].quantity, 2, 'the future phase keeps the new count');
  await f.deliver();
  await fake.clock.advance(subscription.items.data[0].current_period_end - fake.state().now);
  await f.deliver();
  const read = await f.read();
  assert.equal(read.state, 'active');
  assert.equal(read.productKey, 'offered');
  assert.equal(read.quantity, 2);
});

test('repair never rewrites an acknowledged schedule, and erasure leaves no live subscription or schedule', async t => {
  const f = await fixture(t, SCHEDULE_TEST);
  const { database, actor, teamId, fake, subscriptionId } = f;
  await requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1');
  await f.drain();
  const writesBefore = fake.requests().filter(r => r.operation === 'subscriptionSchedules.update').length;
  await repairTeamBillingDesiredState(database);
  await f.drain();
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptionSchedules.update').length, writesBefore, 'a scheduled change waits for its boundary');
  assert.equal(fake.state().schedules.at(-1).status, 'active');
  await prepareTeamBillingErasure(database, actor, teamId, randomUUID());
  await f.drain();
  assert.equal(fake.subscriptions.get(subscriptionId).status, 'canceled');
  assert.equal(fake.state().schedules.at(-1).status, 'released', 'no live schedule survives the fence');
  assert.equal(fake.requests().filter(r => r.operation === 'subscriptionSchedules.release').length, 1);
  assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_subscriptions]").get().count, 0);
  assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_erasure_state]").get().count, 0);
  const tombstones = database.adapter.prepare("SELECT [kind] FROM [sporades_team_billing_erasure_object_tombstones] ORDER BY [kind]").all();
  assert.deepEqual(tombstones.map(row => row.kind), ['checkout', 'schedule', 'subscription']);
  assert.equal((await f.read()).state, 'inactive');
  await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'offered', 'month:1'), { code: 'TEAM_BILLING_DENIED' });
});

async function fixture(t, options = SCHEDULE_TEST) {
  const dir = await mkdtemp(path.join(tmpdir(), 'billing-schedules-'));
  const teamId = randomUUID();
  const offered = new Set(['basic', 'offered']);
  const catalogue = Object.fromEntries(['basic', 'offered'].map(key => [key, {
    quantity: options.counted ? { kind: 'team-members' } : { kind: 'fixed', value: 1 }, stripe: Object.fromEntries(['sandbox', 'live'].map(mode => [mode, {
      productId: `prod_${mode === 'live' ? 'live_' : ''}${key}`, portalConfigurationId: `bpc_${mode}_${key}`,
      prices: { 'month:1': { priceId: `price_${mode === 'live' ? 'live_' : ''}${key}_month` }, 'year:1': { priceId: `price_${mode === 'live' ? 'live_' : ''}${key}_year` } },
    }])),
  }]));
  const config = { enabled: true, secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/webhook', apiVersion: '2026-08-26.dahlia', livemode: false, requestTimeoutMs: 1000 };
  const env = { STRIPE_SECRET_KEY: 'sk_test_schedules', STRIPE_WEBHOOK_SECRET: 'whsec_schedules' };
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', env, { name: 'schedules', auth: { providers: { email: true } }, payments: { stripe: config } }, {
    name: 'schedules', schema: {}, teamBilling: {
      catalogue, transitions: { allowSamePolicy: true }, checkout: { successPath: '/billing', cancelPath: '/billing' },
      authorize: (_ctx, input) => {
        if (input.operation === 'read' || input.operation === 'erasure' || input.operation === 'checkout') return { allow: true };
        if (input.operation !== 'plan-transition' || (input.productKey !== undefined && !offered.has(input.productKey))) return { allow: false };
        return options.periodEnd ? { allow: true, timing: 'period-end' } : { allow: true };
      },
    },
  }, { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  const callback = createServer(async (req, res) => { try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); } catch { res.writeHead(500).end(); } });
  const hub = createWebSocketHub(() => database);
  callback.on('upgrade', (req, socket) => hub.accept(req, socket));
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const fake = await createStripeTeamBillingFake({ webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${callback.address().port}/stripe/webhook`, delivery: 'manual', catalogue: {
    products: ['basic', 'offered'].map(key => ({ id: `prod_${key}`, prices: [{ id: `price_${key}_month`, recurring: 'month' }, { id: `price_${key}_year`, recurring: 'year' }] })), portalConfigurations: [],
  } });
  t.after(async () => { await fake.close(); hub.disconnectAll(); callback.closeAllConnections(); await new Promise(resolve => callback.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); });
  database.stripeApiBaseUrl = fake.origin; await database.init();
  // Drive the durable worker explicitly so state can change between admission and execution.
  database.scheduleTeamBillingJobDispatch = () => {};
  const signup = await (async () => {
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
    return { auth: signup.data.auth, ws };
  })();
  const actor = signup.auth;
  const now = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Billing', ?, ?)").run(teamId, now, actor.userId);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)").run(teamId, actor.userId, now);
  const drain = async () => { for (let i = 0; i < 5; i++) { await runCurrentUserJobWorker(database); await new Promise(r => setTimeout(r, 10)); } };
  const deliver = async () => { assert.ok((await fake.events.deliver()).every(r => r.status === 200)); await drain(); };
  await startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'basic', 'month:1'); await drain();
  const completed = await fake.checkout.complete(fake.state().checkouts[0].id);
  await deliver();
  assert.equal((await readCurrentUserTeamBilling(database, actor, teamId)).state, 'active');
  return { database, actor, teamId, fake, drain, deliver, subscriptionId: completed.subscription, read: () => readCurrentUserTeamBilling(database, actor, teamId) };
}
