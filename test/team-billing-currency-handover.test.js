import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import { createStripeTeamBillingFake } from 'sporades/testing/stripe';

const catalogue = { products: [{ id: 'prod_team', prices: [{ id: 'price_team', recurring: 'month', currency: 'gbp', unitAmount: 1900, currencyOptions: { eur: { unitAmount: 2500 } } }] }], portalConfigurations: [] };
const config = { enabled: true, secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/webhook', apiVersion: '2026-08-26.dahlia', livemode: false, requestTimeoutMs: 1000 };
const env = { STRIPE_SECRET_KEY: 'sk_test_handover', STRIPE_WEBHOOK_SECRET: 'whsec_handover' };

for (const resetAtAnchor of [false, true]) test(`fake handover replacement preserves flexible billing and resets ${resetAtAnchor ? 'at' : 'before'} its first paid anchor`, async t => {
  const server = createServer((_req, res) => res.writeHead(200).end());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const handoverCatalogue = structuredClone(catalogue);
  handoverCatalogue.products[0].prices.push({ id: 'price_year', recurring: 'year', currency: 'eur', unitAmount: 25000 });
  const fake = await createStripeTeamBillingFake({ catalogue: handoverCatalogue, webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${server.address().port}/stripe/webhook`, delivery: 'manual' });
  t.after(async () => { await fake.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const url = new URL(fake.origin);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: config.apiVersion, host: url.hostname, port: url.port, protocol: 'http', maxNetworkRetries: 0 });
  const operation = '11111111-1111-4111-8111-111111111111';
  const common = { success_url: 'https://billing.example.test/success', cancel_url: 'https://billing.example.test/cancel', client_reference_id: operation, expires_at: fake.state().now + 86400, metadata: { sporades_team_billing_operation: operation } };
  const initial = await stripe.checkout.sessions.create({ ...common, mode: 'subscription', currency: 'gbp', line_items: [{ price: 'price_team', quantity: 1 }], subscription_data: { metadata: common.metadata } });
  const paid = await fake.checkout.complete(initial.id);
  const old = fake.subscriptions.get(paid.subscription);
  const anchor = old.items.data[0].current_period_end;
  const setup = await stripe.checkout.sessions.create({ ...common, mode: 'setup', customer: paid.customer });
  assert.equal(setup.currency, undefined, 'setup does not lock the new currency');
  const completed = await fake.checkout.complete(setup.id);
  assert.equal(completed.payment_status, 'no_payment_required');
  const session = await stripe.checkout.sessions.retrieve(setup.id, { expand: ['setup_intent'] });
  assert.equal(session.setup_intent.status, 'succeeded');
  const replacement = { customer: paid.customer, currency: 'eur', items: [{ price: 'price_team', quantity: 1 }], default_payment_method: session.setup_intent.payment_method, billing_cycle_anchor: anchor, proration_behavior: 'none', metadata: common.metadata };
  await assert.rejects(stripe.subscriptions.create(replacement), /currenc/i);
  await stripe.subscriptions.cancel(old.id, { prorate: false, invoice_now: false });
  const created = await stripe.subscriptions.create(replacement, { idempotencyKey: 'anchored-replacement' });
  assert.equal(created.currency, 'eur');
  assert.equal(created.billing_cycle_anchor, anchor);
  assert.equal(created.items.data[0].current_period_end, anchor);
  assert.equal(fake.state().invoices.length, 0, 'setup, non-prorated cancel and the initial free period charge nothing');
  assert.equal((await stripe.subscriptions.create(replacement, { idempotencyKey: 'anchored-replacement' })).id, created.id);
  await fake.portal.switchPrice(created.id, 'price_year');
  assert.equal(fake.subscriptions.get(created.id).billing_cycle_anchor, anchor, 'implicit flexible interval changes preserve the anchor');
  await fake.portal.switchPrice(created.id, 'price_team');
  assert.equal(fake.state().invoices.length, 0);
  if (resetAtAnchor) {
    await fake.clock.advance(anchor - fake.state().now);
    assert.equal(fake.state().invoices.length, 1);
    assert.equal(fake.state().invoices[0].amount_paid, 2500);
  }
  const update = { items: [{ id: created.items.data[0].id, price: 'price_year', quantity: 1 }],
    billing_cycle_anchor: 'now', proration_behavior: 'always_invoice', proration_date: fake.state().now, payment_behavior: 'pending_if_incomplete' };
  const changed = await stripe.subscriptions.update(created.id, update, { idempotencyKey: 'handover-annual-reset' });
  const invoice = fake.state().invoices.at(-1);
  assert.equal(invoice.lines.data[0].amount, 25000);
  assert.equal(invoice.lines.data[1].amount, resetAtAnchor ? -2500 : 0, 'the free stub period must not generate unused paid-period credit');
  assert.equal(invoice.amount_paid, resetAtAnchor ? 22500 : 25000);
  assert.equal(changed.billing_cycle_anchor, fake.state().now);
  assert.equal((await stripe.subscriptions.update(created.id, update, { idempotencyKey: 'handover-annual-reset' })).latest_invoice, changed.latest_invoice);
  assert.equal(fake.state().invoices.length, resetAtAnchor ? 2 : 1);
  fake.reset();
  assert.deepEqual(fake.state().invoices, []);
  assert.deepEqual(fake.state().subscriptions, []);
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStripeTeamBillingProvider } from '../dist/stripe-team-billing-provider.js';
import { createStripeCallbackEndpoint } from '../dist/stripe-webhook-runtime.js';
import { openDevDatabase, routeEndpoint, runCurrentUserJobWorker, createWebSocketHub } from '../dist/server-runtime-source.js';
import { startTeamBillingCheckout, readCurrentUserTeamBilling } from '../dist/team-billing-runtime.js';

async function fixture(t, counted = false, includeOther = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'billing-handover-'));
  const checks = [];
  let allow = true;
  const teamId = randomUUID();
  const definition = { name: 'handover', schema: {}, teamBilling: {
    catalogue: { team: { quantity: counted ? { kind: 'team-members' } : { kind: 'fixed', value: 1 }, stripe: Object.fromEntries(['sandbox', 'live'].map(mode => [mode, { productId: mode === 'live' ? 'prod_live_team' : 'prod_team', prices: { 'month:1': { priceId: mode === 'live' ? 'price_live_team' : 'price_team', currency: 'gbp', unitAmount: 1900, currencyOptions: { eur: { unitAmount: 2500 } } } } }])) } },
    checkout: { successPath: '/billing', cancelPath: '/billing' },
    authorize: (_ctx, input) => { checks.push(input); return { allow: input.operation === 'read' || allow && (input.operation !== 'currency-handover' || input.fromCurrency === 'gbp') }; },
  } };
  const fakeCatalogue = structuredClone(catalogue);
  if (includeOther) {
    fakeCatalogue.products.push({ id: 'prod_other', prices: [{ id: 'price_other', recurring: 'month', currency: 'gbp', unitAmount: 2900, currencyOptions: { eur: { unitAmount: 3500 } } }] });
    definition.teamBilling.catalogue.other = { quantity: { kind: 'fixed', value: 2 }, stripe: Object.fromEntries(['sandbox', 'live'].map(mode => [mode, { productId: mode === 'live' ? 'prod_live_other' : 'prod_other', prices: { 'month:1': { priceId: mode === 'live' ? 'price_live_other' : 'price_other', currency: 'gbp', unitAmount: 2900, currencyOptions: { eur: { unitAmount: 3500 } } } } }])) };
  }
  const open = () => openDevDatabase(path.join(dir, 'data.db'), '', env, { name: 'handover', auth: { providers: { email: true } }, payments: { stripe: config } }, definition, { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  let database = await open();
  const server = createServer(async (req, res) => { try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); } catch { res.writeHead(500).end(); } });
  const hub = createWebSocketHub(() => database); server.on('upgrade', (req, socket) => hub.accept(req, socket));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fake = await createStripeTeamBillingFake({ catalogue: fakeCatalogue, webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${server.address().port}/stripe/webhook`, delivery: 'manual' });
  t.after(async () => { await fake.close(); hub.disconnectAll(); server.closeAllConnections(); await new Promise(r => server.close(r)); await database.close(); await rm(dir, { recursive: true, force: true }); });
  database.stripeApiBaseUrl = fake.origin; await database.init(); database.scheduleTeamBillingJobDispatch = () => {};
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`); await once(ws, 'open');
  const send = message => new Promise((resolve, reject) => {
    const id = randomUUID(); const timer = setTimeout(() => reject(new Error(`Timeout: ${message.type}`)), 10000);
    const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener('message', listener); resolve(result); } };
    ws.addEventListener('message', listener); ws.send(JSON.stringify({ ...message, id }));
  });
  const signup = await send({ type: 'auth.signUp', provider: 'email', credentials: { email: 'buyer@example.test', password: 'password-123', name: 'Buyer' } }); assert.equal(signup.error, null);
  const actor = signup.data.auth; const now = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Billing', ?, ?)").run(teamId, now, actor.userId);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)").run(teamId, actor.userId, now);
  const drain = async () => { for (let i = 0; i < 5; i++) { await runCurrentUserJobWorker(database); await new Promise(r => setTimeout(r, 10)); } };
  const deliver = async () => { assert.ok((await fake.events.deliver()).every(r => r.status === 200)); await drain(); };
  await startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'team', 'month:1', 'gbp'); await drain();
  const initial = await fake.checkout.complete(fake.state().checkouts[0].id); await deliver();
  assert.equal((await readCurrentUserTeamBilling(database, actor, teamId)).state, 'active');
  const input = { teamId, requestId: randomUUID(), productKey: 'team', interval: 'month:1', currency: 'eur' };
  const start = (patch = {}) => send({ type: 'teamBilling.startCurrencyHandover', input: { ...input, ...patch } });
  return { get database() { return database; }, actor, teamId, fake, checks, initial, input, send, start, drain, deliver,
    read: () => readCurrentUserTeamBilling(database, actor, teamId),
    revoke: () => { allow = false; },
    restart: async () => { await database.close(); database = await open(); database.stripeApiBaseUrl = fake.origin; await database.init(); database.scheduleTeamBillingJobDispatch = () => {}; },
  };
}

test('GBP to EUR handover settles from verified evidence and permits later managed plan changes', async t => {
  const f = await fixture(t, false, true);
  const before = await f.read();
  assert.equal((await f.start()).error, null);
  assert.deepEqual(await f.read(), before, 'collecting consent preserves the current entitlement');
  await f.drain();
  const ready = await f.start(); assert.equal(ready.data.state, 'ready');
  const setup = f.fake.state().checkouts.find(s => s.mode === 'setup');
  assert.ok(setup); assert.equal(setup.customer, f.initial.customer);
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'active', 'no cancellation before verified setup');
  await f.fake.checkout.complete(setup.id);
  await f.deliver();
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'canceled');
  assert.deepEqual(await f.read(), before, 'provider acknowledgement cannot switch entitlement');
  const replacement = f.fake.state().subscriptions.find(s => s.id !== f.initial.subscription);
  assert.equal(replacement.currency, 'eur');
  assert.equal(replacement.billing_cycle_anchor, Date.parse(before.renewsAt) / 1000);
  const cancel = f.fake.requests().find(r => r.operation === 'subscriptions.cancel');
  assert.deepEqual(cancel.parameters, { prorate: 'false', invoice_now: 'false' });
  const create = f.fake.requests().find(r => r.operation === 'subscriptions.create');
  assert.equal(create.parameters.proration_behavior, 'none');
  assert.equal(f.fake.state().invoices.length, 0);
  // The replacement can arrive before the old cancellation webhook.
  const events = f.fake.events.pending();
  const created = events.find(e => e.type === 'customer.subscription.created');
  assert.ok((await f.fake.events.deliver(created.id)).every(r => r.status === 200)); await f.drain();
  assert.equal((await f.read()).currency, 'eur');
  await f.deliver();
  assert.equal((await f.read()).state, 'active'); assert.equal((await f.read()).currency, 'eur');
  assert.equal((await f.start()).data.state, 'completed');
  assert.equal((await f.start({ currency: 'gbp' })).error.code, 'TEAM_BILLING_REQUEST_CONFLICT');
  for (const check of f.checks.filter(c => c.operation === 'currency-handover' && c.currency === 'eur')) { assert.equal(check.currency, 'eur'); assert.equal(check.fromProductKey, 'team'); }
  await f.restart(); assert.equal((await f.read()).currency, 'eur');
  const switched = await f.send({ type: 'teamBilling.requestPlanTransition', input: { teamId: f.teamId, requestId: randomUUID(), productKey: 'other', interval: 'month:1' } });
  assert.equal(switched.error, null);
  await f.drain(); await f.deliver();
  const plan = await f.read();
  assert.equal(plan.state, 'active');
  assert.equal(plan.productKey, 'other');
  assert.equal(plan.currency, 'eur');
  assert.equal(plan.quantity, 2);
  const changed = f.fake.subscriptions.get(replacement.id);
  assert.equal(changed.billing_cycle_anchor, replacement.billing_cycle_anchor, 'a subsequent same-interval plan change preserves the free stub');
  assert.equal(f.fake.state().invoices.length, 0);
});

for (const amount of [-700, 700]) test(`old-currency balance ${amount} refuses safely before collecting setup or canceling`, async t => {
  const f = await fixture(t); const before = await f.read();
  f.fake.customers.setBalance(f.initial.customer, 'gbp', amount);
  assert.equal((await f.start()).error, null); await f.drain();
  const result = await f.start();
  assert.equal(result.data.state, 'failed'); assert.equal(result.data.reason, 'customer-balance-nonzero');
  assert.equal(f.fake.state().checkouts.length, 1);
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'active');
  assert.deepEqual(await f.read(), before);
});

for (const when of ['before', 'after']) test(`lost replacement reply (${when} create) recovers through restart without a second charge or subscription`, async t => {
  const f = await fixture(t); const before = await f.read();
  await f.start(); await f.drain();
  const setup = f.fake.state().checkouts.find(s => s.mode === 'setup');
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 500, count: 100, when });
  await f.fake.checkout.complete(setup.id); await f.deliver();
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'canceled');
  assert.deepEqual(await f.read(), before);
  if (when === 'before') assert.equal(f.fake.state().subscriptions.length, 1);
  f.fake.faults.clear();
  await f.restart();
  assert.deepEqual(await f.read(), before);
  await f.drain(); await f.deliver(); await f.deliver();
  assert.equal((await f.read()).currency, 'eur'); assert.equal((await f.start()).data.state, 'completed');
  assert.equal(f.fake.state().subscriptions.length, 2);
  assert.equal(f.fake.state().invoices.length, 0);
  assert.equal(f.fake.state().subscriptions[1].billing_cycle_anchor, Date.parse(before.renewsAt) / 1000);
});

test('revocation after setup admission prevents provider work and another Team cannot reuse a request', async t => {
  const f = await fixture(t);
  const original = f.fake.requests().length;
  const other = await f.start({ teamId: randomUUID() }); assert.equal(other.error.code, 'TEAM_BILLING_DENIED');
  await f.start(); f.revoke(); await f.drain();
  assert.equal(f.fake.requests().length, original);
  const row = await f.read(); assert.equal(row.currency, 'gbp'); assert.equal(row.state, 'active');
});

test('verified setup is required; a balance introduced during setup prevents cancellation', async t => {
  const f = await fixture(t); await f.start(); await f.drain();
  const setup = f.fake.state().checkouts.find(s => s.mode === 'setup');
  await f.fake.checkout.complete(setup.id);
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'active');
  f.fake.customers.setBalance(f.initial.customer, 'gbp', -100);
  await f.deliver();
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'active');
  assert.equal((await f.start()).data.reason, 'customer-balance-nonzero');
  assert.equal(f.fake.requests().filter(r => r.operation === 'subscriptions.cancel').length, 0);
});

test('an uncertain failed replacement cannot extend the paid-through latch past its anchor', async t => {
  const f = await fixture(t); const before = await f.read();
  await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 500, count: 100 });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  assert.deepEqual(await f.read(), before);
  // Deliberately withhold the cancellation webhook: local source evidence still says active.
  const clock = f.database.clock; f.database.clock = { ...clock, now: () => new Date(Date.parse(before.renewsAt) + 1000) };
  assert.equal((await f.read()).state, 'inactive');
});


test('a refusal on retry after cancellation retains the durable paid-through latch', async t => {
  const f = await fixture(t); const before = await f.read();
  await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 500, count: 100 });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'canceled');
  f.fake.customers.setBalance(f.initial.customer, 'gbp', -100);
  f.fake.faults.clear(); await f.restart(); await f.drain(); await f.deliver();
  assert.equal((await f.start()).data.reason, 'customer-balance-nonzero');
  assert.deepEqual(await f.read(), before);
});


test('membership drift before replacement evidence binds the admitted target then converges seats', async t => {
  const f = await fixture(t, true);
  await f.start(); await f.drain();
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  const now = new Date().toISOString();
  f.database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'second-member', 'member', ?)").run(f.teamId, now);
  await f.deliver(); await f.deliver();
  assert.equal((await f.start()).data.state, 'completed');
  assert.equal((await f.read()).currency, 'eur'); assert.equal((await f.read()).quantity, 2);
});

test('setup completion never restores an admission-time entitlement after verified source drift', async t => {
  const f = await fixture(t, true);
  await f.start(); await f.drain();
  await f.fake.subscriptions.setQuantity(f.initial.subscription, 2); await f.deliver();
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  assert.equal((await f.start()).data.state, 'expired');
  assert.equal((await f.read()).quantity, 2);
  assert.equal(f.fake.requests().filter(r => r.operation === 'subscriptions.cancel').length, 0);
});

test('expired setup releases the durable operation fence without waiting for provider expiry', async t => {
  const f = await fixture(t); await f.start(); await f.drain();
  const clock = f.database.clock; const future = new Date(clock.now().getTime() + 11 * 60_000);
  f.database.clock = { ...clock, now: () => future };
  await f.drain();
  assert.equal((await f.start()).data.state, 'expired');
  assert.equal((await f.start({ requestId: randomUUID() })).error, null);
});

test('an exhausted uncertain create keeps fresh requests fenced until replacement evidence resolves it', async t => {
  const f = await fixture(t); await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 500, when: 'after' });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  f.fake.faults.inject({ operation: 'subscriptions.retrieve', status: 500, count: 100 });
  const clock = f.database.clock; let elapsed = 0;
  f.database.clock = { ...clock, now: () => new Date(clock.now().getTime() + elapsed) };
  for (let i = 0; i < 4; i++) { elapsed += 1100; await f.drain(); }
  assert.equal((await f.start()).data.state, 'failed');
  assert.equal((await f.start({ requestId: randomUUID() })).error.code, 'TEAM_BILLING_CURRENCY_HANDOVER_ACTIVE');
  await assert.rejects(startTeamBillingCheckout(f.database, f.actor, f.teamId, randomUUID(), 'team', 'month:1', 'eur'), { code: 'TEAM_BILLING_CURRENCY_HANDOVER_ACTIVE' });
  f.fake.faults.clear(); await f.deliver();
  assert.equal((await f.start()).data.state, 'completed'); assert.equal((await f.read()).currency, 'eur');
  assert.equal(f.fake.state().subscriptions.length, 2);
});

test('provider-safe erasure expires setup and cancels both sides of a lost replacement acknowledgement', async t => {
  const f = await fixture(t); await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 500, when: 'after' });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  const erased = await f.send({ type: 'teamBilling.prepareErasure', input: { teamId: f.teamId, requestId: randomUUID() } });
  assert.equal(erased.error, null); await f.drain();
  assert.ok(f.fake.state().subscriptions.every(s => s.status === 'canceled'));
  await f.deliver(); assert.equal((await f.read()).state, 'inactive');
});

test('expired failed create is safely closed by provider discovery so ordinary Checkout can recover', async t => {
  const f = await fixture(t); const before = await f.read();
  await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'subscriptions.create', status: 400 });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver(); await f.deliver();
  assert.equal((await f.start()).data.state, 'failed');
  const clock = f.database.clock;
  f.database.clock = { ...clock, now: () => new Date(Date.parse(before.renewsAt) + 1000) };
  await f.drain();
  assert.equal((await startTeamBillingCheckout(f.database, f.actor, f.teamId, randomUUID(), 'team', 'month:1', 'eur')).state, 'pending');
  assert.equal(f.fake.state().subscriptions.length, 1, 'discovery never creates an obsolete anchored subscription');
});


test('deadline discovery restores a source that was never canceled after a preflight outage', async t => {
  const f = await fixture(t); const before = await f.read();
  await f.start(); await f.drain();
  f.fake.faults.inject({ operation: 'customers.retrieve', status: 500, count: 100 });
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  assert.equal(f.fake.subscriptions.get(f.initial.subscription).status, 'active');
  f.fake.faults.clear();
  const clock = f.database.clock; f.database.clock = { ...clock, now: () => new Date(Date.parse(before.renewsAt) + 1000) };
  await f.drain();
  assert.deepEqual(await f.read(), before, 'the handover cannot retire an uncanceled source');
  await f.fake.subscriptions.renew(f.initial.subscription); await f.deliver();
  assert.equal((await f.read()).state, 'active');
  assert.equal((await f.start({ requestId: randomUUID() })).error, null);
});


test('a successful currency handover supersedes an expired failed plan intent across restart', async t => {
  const f = await fixture(t, false, true);
  const { requestTeamBillingPlanTransition } = await import('../dist/team-billing-management.js');
  const planRequest = randomUUID();
  f.fake.faults.inject({ operation: 'subscriptions.update', status: 'paymentActionRequired' });
  await requestTeamBillingPlanTransition(f.database, f.actor, f.teamId, planRequest, 'other', 'month:1'); await f.drain();
  assert.equal((await requestTeamBillingPlanTransition(f.database, f.actor, f.teamId, planRequest, 'other', 'month:1')).reason, 'payment-action-required');
  await f.fake.clock.advance(3600); await f.deliver();
  await f.start(); await f.drain();
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver(); await f.deliver();
  assert.equal((await f.read()).currency, 'eur'); assert.equal((await f.read()).productKey, 'team');
  const writes = f.fake.requests().filter(r => r.operation === 'subscriptions.update').length;
  await f.restart(); await f.drain(); await f.deliver();
  assert.equal(f.fake.requests().filter(r => r.operation === 'subscriptions.update').length, writes, 'restart cannot resurrect the abandoned target');
  assert.equal((await f.read()).productKey, 'team'); assert.equal((await f.read()).currency, 'eur');
});

test('startup repair cannot revive a handover completed while its lifecycle lock was pending', async t => {
  const f = await fixture(t); await f.start(); await f.drain();
  await f.fake.checkout.complete(f.fake.state().checkouts.find(s => s.mode === 'setup').id); await f.deliver();
  const created = f.fake.events.pending().find(e => e.type === 'customer.subscription.created');
  assert.ok(created);
  const { applyVerifiedTeamBillingObservation } = await import('../dist/team-billing-convergence.js');
  const { repairTeamBillingCurrencyHandovers } = await import('../dist/team-billing-currency-handover.js');
  const adapter = f.database.adapter;
  let injected = false;
  const racingAdapter = new Proxy(adapter, { get(target, key) {
    if (key !== 'withTransaction') return Reflect.get(target, key);
    return callback => target.withTransaction(tx => callback(new Proxy(tx, { get(inner, name) {
      if (name !== 'prepare') return Reflect.get(inner, name);
      return sql => {
        const statement = inner.prepare(sql);
        return new Proxy(statement, { get(stmt, method) {
          if (method !== 'all') { const value = Reflect.get(stmt, method); return typeof value === 'function' ? value.bind(stmt) : value; }
          return async (...args) => {
            const rows = await stmt.all(...args);
            if (!injected) {
              injected = true;
              // Model a committed replacement after discovery, before lock admission.
              await applyVerifiedTeamBillingObservation({ ...f.database, adapter: tx }, {
                provider: 'stripe', providerEventId: created.id, type: created.type, livemode: false,
                occurredAt: new Date(created.created * 1000).toISOString(), objectId: created.data.object.id, raw: created,
              });
            }
            return rows;
          };
        } });
      };
    } })));
  } });
  await repairTeamBillingCurrencyHandovers({ ...f.database, adapter: racingAdapter });
  assert.ok(injected);
  assert.equal((await f.start()).data.state, 'completed');
  assert.equal((await f.read()).currency, 'eur');
});
