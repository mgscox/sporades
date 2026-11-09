import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTeamBillingDefinition } from '../dist/team-billing-runtime.js';

function declaration() {
  return { catalogue: { kitchen: { quantity: { kind: 'fixed', value: 1 }, stripe: {
    sandbox: { productId: 'prod_kitchen', portalConfigurationId: 'bpc_kitchen', prices: {
      'month:1': { priceId: 'price_month' }, 'year:1': { priceId: 'price_year' },
    } },
    live: { productId: 'prod_live_kitchen', portalConfigurationId: 'bpc_live_kitchen', prices: {
      'month:1': { priceId: 'price_live_month' }, 'year:1': { priceId: 'price_live_year' },
    } },
  } } }, authorize: () => ({ allow: true }), checkout: { successPath: '/billing', cancelPath: '/billing' }, portal: { returnPath: '/billing' } };
}

test('interval catalogue preserves product Portal configuration and rejects ambiguous Prices', () => {
  const normalized = normalizeTeamBillingDefinition(declaration());
  assert.equal(normalized.catalogue.kitchen.stripe.sandbox.prices['year:1'].priceId, 'price_year');
  assert.ok(Object.isFrozen(normalized.catalogue.kitchen.stripe.sandbox.prices['year:1']));
  for (const change of [
    d => { d.catalogue.other = d.catalogue.kitchen; },
    d => { d.catalogue.kitchen.stripe.live.prices['year:1'].priceId = 'price_month'; },
    d => { d.catalogue.kitchen.stripe.sandbox.prices['year:1'].priceId = 'price_month'; },
    d => { d.catalogue.kitchen.stripe.sandbox.priceId = 'price_legacy'; },
    d => { d.catalogue.kitchen.stripe.sandbox.prices = {}; },
    d => { d.catalogue.kitchen.stripe.sandbox.prices['month:0'] = { priceId: 'price_bad' }; },
    d => { d.catalogue.kitchen.stripe.sandbox.prices['month:01'] = { priceId: 'price_bad' }; },
    d => { d.catalogue.kitchen.stripe.sandbox.prices['year:4'] = { priceId: 'price_bad' }; },
  ]) {
    const d = declaration(); change(d);
    assert.throws(() => normalizeTeamBillingDefinition(d), { code: 'INVALID_TEAM_BILLING_DECLARATION' });
  }
});

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
import { startTeamBillingCheckout, readCurrentUserTeamBilling, startTeamBillingPortal } from '../dist/team-billing-runtime.js';
import { requestTeamBillingPlanTransition, repairTeamBillingDesiredState, stageTeamBillingMembershipChange } from '../dist/team-billing-management.js';

for (const billingMode of ["classic", "flexible"]) for (const initial of ['month:1', 'year:1']) test(`WebSocket Checkout ${initial} (${billingMode}), interval transitions, Portal and cancellation converge through signed callbacks`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'billing-intervals-'));
  const teamId = randomUUID();
  let actor;
  const checks = [];
  const d = declaration();
  if (initial === "year:1" || billingMode === "flexible") d.catalogue.kitchen.quantity = { kind: "team-members" };
  if (initial === "month:1" && billingMode === "flexible") Object.assign(d.portal, {
    prorationBehavior: "always_invoice", billingCycleAnchor: "now", scheduleAtPeriodEnd: ["shortening_interval"],
  });
  d.authorize = (_ctx, input) => { checks.push(input); return { allow: true }; };
  const config = { enabled: true, secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/webhook', apiVersion: '2026-08-26.dahlia', livemode: false, requestTimeoutMs: 1000 };
  const env = { STRIPE_SECRET_KEY: 'sk_test_intervals', STRIPE_WEBHOOK_SECRET: 'whsec_intervals' };
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', env, { name: 'intervals', auth: { providers: { anonymous: true, email: true } }, payments: { stripe: config } }, { name: 'intervals', schema: {}, teamBilling: d }, { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  const callback = createServer(async (req, res) => { try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); } catch { res.writeHead(500).end(); } });
  const hub = createWebSocketHub(() => database);
  callback.on('upgrade', (req, socket) => hub.accept(req, socket));
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const fake = await createStripeTeamBillingFake({ webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${callback.address().port}/stripe/webhook`, delivery: 'manual', catalogue: {
    products: [{ id: 'prod_kitchen', prices: [{ id: 'price_month', recurring: 'month' }, { id: 'price_year', recurring: 'year', unitAmount: 10000 }] }],
    portalConfigurations: [{ id: 'bpc_kitchen', prorationBehavior: d.portal.prorationBehavior, billingCycleAnchor: d.portal.billingCycleAnchor, scheduleAtPeriodEnd: d.portal.scheduleAtPeriodEnd, products: [{ product: 'prod_kitchen', prices: ['price_month', 'price_year'] }] }],
  } });
  t.after(async () => { await fake.close(); hub.disconnectAll(); callback.closeAllConnections(); await new Promise(resolve => callback.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); });
  database.stripeApiBaseUrl = fake.origin; await database.init();
  const ws = new WebSocket(`ws://127.0.0.1:${callback.address().port}/?connectionToken=${hub.createConnectionToken()}`);
  await once(ws, 'open');
  const send = message => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error(`Timeout: ${message.type}`)); }, 10000);
    const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener('message', listener); resolve(result); } };
    ws.addEventListener('message', listener); ws.send(JSON.stringify({ ...message, id }));
  });
  const signup = await send({ type: 'auth.signUp', provider: 'email', credentials: { email: 'buyer@example.test', password: 'password-123', name: 'Buyer' } });
  assert.equal(signup.error, null, JSON.stringify(signup));
  actor = signup.data.auth;
  const now = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Kitchen', ?, ?)").run(teamId, now, actor.userId);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)").run(teamId, actor.userId, now);
  const read = () => readCurrentUserTeamBilling(database, actor, teamId);
  const drain = async () => { for (let i = 0; i < 10; i++) { await runCurrentUserJobWorker(database); await new Promise(r => setTimeout(r, 10)); } };
  const deliver = async () => { assert.ok((await fake.events.deliver()).every(r => r.status === 200)); await drain(); };
  for (const interval of [undefined, 'week:1', 'year:01', null]) await assert.rejects(startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'kitchen', interval), { code: 'TEAM_BILLING_DENIED' });
  const requestId = randomUUID();
  const checkoutReply = await send({ type: 'teamBilling.startCheckout', input: { teamId, requestId, productKey: 'kitchen', interval: initial } });
  assert.equal(checkoutReply.error, null, JSON.stringify(checkoutReply)); await drain();
  const opposite = initial === 'month:1' ? 'year:1' : 'month:1';
  await assert.rejects(startTeamBillingCheckout(database, actor, teamId, requestId, 'kitchen', opposite), { code: 'TEAM_BILLING_REQUEST_CONFLICT' });
  assert.ok(checks.some(c => c.operation === 'checkout' && c.interval === initial));
  const session = fake.state().checkouts[0]; assert.equal(session.line_items.data[0].price.id, initial === 'month:1' ? 'price_month' : 'price_year');
  const completed = await fake.checkout.complete(session.id, { billingMode }); await deliver();
  assert.equal((await read()).interval, initial);
  assert.equal(database.adapter.prepare('SELECT [billingMode] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?').get(teamId).billingMode, billingMode);
  const originalDefinition = database.teamBillingDefinition;
  const redeclared = declaration();
  // A redeploy cannot relabel already-verified monthly evidence as annual.
  const prices = redeclared.catalogue.kitchen.stripe.sandbox.prices;
  [prices['month:1'], prices['year:1']] = [prices['year:1'], prices['month:1']];
  database.teamBillingDefinition = normalizeTeamBillingDefinition(redeclared);
  assert.deepEqual(await read(), { state: 'attention-required', teamId, reason: 'catalogue-mismatch' });
  database.teamBillingDefinition = originalDefinition;
  const invalid = fake.subscriptions.get(completed.subscription);
  invalid.items.data[0].price.recurring.interval = initial === 'month:1' ? 'year' : 'month';
  await fake.events.emit('customer.subscription.updated', invalid); await deliver();
  assert.deepEqual(await read(), { state: 'attention-required', teamId, reason: 'catalogue-mismatch' });
  await fake.subscriptions.setStatus(completed.subscription, 'active'); await deliver();
  assert.equal((await read()).interval, initial);
  const transition = randomUUID();
  const transitionReply = await send({ type: 'teamBilling.requestPlanTransition', input: { teamId, requestId: transition, productKey: 'kitchen', interval: opposite } });
  assert.equal(transitionReply.error, null, JSON.stringify(transitionReply));
  if (initial === "month:1" && billingMode === "flexible") {
    // Refreshing accepted seats before dispatch must retain the annual reset intent.
    database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'queued-member', 'member', ?)").run(teamId, now);
  }
  // A restart must not confuse equal product/quantity with an equal target Price.
  await repairTeamBillingDesiredState(database); await drain();
  assert.equal((await read()).state, 'pending');
  await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, transition, 'kitchen', initial), { code: 'TEAM_BILLING_REQUEST_CONFLICT' });
  assert.ok(checks.some(c => c.operation === 'plan-transition' && c.interval === opposite));
  const update = fake.requests().find(r => r.operation === 'subscriptions.update');
  assert.equal(update.parameters.proration_behavior, initial === 'month:1' ? 'always_invoice' : 'create_prorations');
  assert.equal(update.parameters.billing_cycle_anchor, initial === 'month:1' ? 'now' : undefined);
  if (initial === 'month:1') assert.equal(fake.state().invoices[0].lines.data[0].amount, billingMode === "flexible" ? 20000 : 10000);
  await deliver(); assert.equal((await read()).interval, opposite); assert.equal((await read()).state, 'active');
  await startTeamBillingPortal(database, actor, teamId, randomUUID()); await drain();
  assert.equal(fake.state().portalSessions.length, 1, 'Portal attests both Prices for the same Product');
  await fake.portal.switchPrice(completed.subscription, initial === 'month:1' ? 'price_month' : 'price_year'); await deliver();
  assert.equal((await read()).interval, initial);
  if (initial === 'year:1') {
    database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'second-member', 'member', ?)").run(teamId, now);
    await stageTeamBillingMembershipChange(database, teamId); await drain(); await deliver();
    assert.equal((await read()).quantity, 2);
    assert.equal((await read()).interval, 'year:1', 'seat changes preserve the observed annual Price');
  }
  await fake.subscriptions.setStatus(completed.subscription, 'past_due'); await deliver(); assert.equal((await read()).state, 'past-due'); assert.equal((await read()).interval, initial);
  await fake.subscriptions.setStatus(completed.subscription, 'active'); await deliver();
  await fake.portal.cancelAtPeriodEnd(completed.subscription); await deliver(); assert.equal((await read()).state, 'cancelling');
  const sub = fake.subscriptions.get(completed.subscription);
  await fake.clock.advance(sub.items.data[0].current_period_end - fake.state().now); await deliver();
  assert.equal((await read()).state, 'cancelled'); assert.equal((await read()).interval, initial);
});
