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

test('Price currencies declare exact regional minor-unit amounts and reject malformed declarations', () => {
  const d = declaration();
  const price = d.catalogue.kitchen.stripe.sandbox.prices['month:1'];
  Object.assign(price, { currency: 'gbp', unitAmount: 1900, currencyOptions: { usd: { unitAmount: 2900 }, eur: { unitAmount: 2500 } } });
  const normalized = normalizeTeamBillingDefinition(d).catalogue.kitchen.stripe.sandbox.prices['month:1'];
  assert.equal(normalized.currencyOptions.usd.unitAmount, 2900);
  assert.ok(Object.isFrozen(normalized.currencyOptions.usd));
  for (const patch of [
    { currency: 'GBP' }, { unitAmount: -1 }, { unitAmount: 1.5 },
    { currencyOptions: { USD: { unitAmount: 2900 } } },
    { currencyOptions: { usd: { unitAmount: NaN } } },
    { currencyOptions: { usd: { unitAmount: 2900, arbitrary: true } } },
    { currency: undefined }, { unitAmount: undefined },
  ]) {
    const invalid = structuredClone({ ...price, ...patch });
    const bad = declaration(); bad.catalogue.kitchen.stripe.sandbox.prices['month:1'] = invalid;
    assert.throws(() => normalizeTeamBillingDefinition(bad), { code: 'INVALID_TEAM_BILLING_DECLARATION' });
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

for (const [initial, currency, trial] of [['month:1', undefined, false], ['year:1', undefined, false], ['month:1', undefined, true], ['year:1', undefined, true], ['month:1', 'usd', false], ['year:1', 'usd', false], ['month:1', 'gbp', false]]) test(`WebSocket ${trial ? 'trial' : 'paid'} Checkout ${initial} ${currency ?? 'legacy'}, interval transitions, Portal and cancellation converge through signed callbacks`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'billing-intervals-'));
  const teamId = randomUUID();
  let actor;
  const checks = [];
  let allowBilling = true;
  const d = declaration();
  if (trial) d.catalogue.kitchen.trialDays = 14;
  if (initial === "year:1") d.catalogue.kitchen.quantity = { kind: "team-members" };
  d.authorize = (_ctx, input) => { checks.push(input); return { allow: allowBilling }; };
  if (currency) for (const mode of ['sandbox', 'live']) for (const price of Object.values(d.catalogue.kitchen.stripe[mode].prices)) {
    Object.assign(price, { currency: 'gbp', unitAmount: 1900, currencyOptions: { usd: { unitAmount: 2900 }, eur: { unitAmount: 2500 } } });
  }
  const config = { enabled: true, secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', publicOrigin: 'https://billing.example.test', callbackPath: '/stripe/webhook', apiVersion: '2026-08-26.dahlia', livemode: false, requestTimeoutMs: 1000 };
  const env = { STRIPE_SECRET_KEY: 'sk_test_intervals', STRIPE_WEBHOOK_SECRET: 'whsec_intervals' };
  const open = () => openDevDatabase(path.join(dir, 'data.db'), '', env, { name: 'intervals', auth: { providers: { anonymous: true, email: true } }, payments: { stripe: config } }, { name: 'intervals', schema: {}, teamBilling: d }, { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  let database = await open();
  const callback = createServer(async (req, res) => { try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); } catch { res.writeHead(500).end(); } });
  const hub = createWebSocketHub(() => database);
  callback.on('upgrade', (req, socket) => hub.accept(req, socket));
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const fake = await createStripeTeamBillingFake({ webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${callback.address().port}/stripe/webhook`, delivery: 'manual', catalogue: {
    products: [{ id: 'prod_kitchen', prices: [{ id: 'price_month', recurring: 'month', ...(currency ? { currency: 'gbp', unitAmount: 1900, currencyOptions: { usd: { unitAmount: 2900 }, eur: { unitAmount: 2500 } } } : {}) }, { id: 'price_year', recurring: 'year', ...(currency ? { currency: 'gbp', unitAmount: 1900, currencyOptions: { usd: { unitAmount: 2900 }, eur: { unitAmount: 2500 } } } : {}) }] }],
    portalConfigurations: [{ id: 'bpc_kitchen', products: [{ product: 'prod_kitchen', prices: ['price_month', 'price_year'] }] }],
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
  for (const unsupported of ['nzd', 'USD', '', null, 1]) {
    const count = fake.requests().length;
    await assert.rejects(startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'kitchen', initial, unsupported), { code: 'TEAM_BILLING_DENIED' });
    assert.equal(fake.requests().length, count);
  }
  if (currency === 'usd') {
    const legacy = { ...d, catalogue: structuredClone(d.catalogue) };
    for (const p of Object.values(legacy.catalogue.kitchen.stripe.sandbox.prices)) {
      delete p.currency; delete p.unitAmount; delete p.currencyOptions;
    }
    database.teamBillingDefinition = normalizeTeamBillingDefinition(legacy);
    const oldRequest = randomUUID();
    await startTeamBillingCheckout(database, actor, teamId, oldRequest, 'kitchen', initial);
    database.teamBillingDefinition = normalizeTeamBillingDefinition(d);
    await drain();
    assert.equal(fake.requests().length, 0, 'legacy queued intent cannot guess a currency on upgrade');
  }
  const requestId = randomUUID();
  const checkoutReply = await send({ type: 'teamBilling.startCheckout', input: { teamId, requestId, productKey: 'kitchen', interval: initial, ...(currency === 'usd' ? { currency } : {}) } });
  assert.equal(checkoutReply.error, null, JSON.stringify(checkoutReply)); await drain();
  const opposite = initial === 'month:1' ? 'year:1' : 'month:1';
  await assert.rejects(startTeamBillingCheckout(database, actor, teamId, requestId, 'kitchen', opposite), { code: 'TEAM_BILLING_REQUEST_CONFLICT' });
  assert.ok(checks.some(c => c.operation === 'checkout' && c.interval === initial));
  const session = fake.state().checkouts[0]; assert.equal(session.line_items.data[0].price.id, initial === 'month:1' ? 'price_month' : 'price_year');
  const completed = await fake.checkout.complete(session.id); await deliver();
  assert.equal((await read()).interval, initial);
  if (currency) {
    assert.equal(session.currency, currency);
    assert.equal(session.amount_total, currency === 'usd' ? 2900 : 1900);
    assert.equal((await read()).currency, currency);
    assert.ok(checks.some(c => c.operation === 'checkout' && c.currency === currency));
    const shaped = fake.subscriptions.get(completed.subscription).items.data[0].price;
    assert.equal(shaped.currency, 'gbp', 'the fake keeps the Price default currency, as the provider does');
    assert.equal(shaped.unit_amount, 1900, 'the fake keeps the Price default amount, as the provider does');
    assert.equal(shaped.currency_options.usd.unit_amount, 2900, 'regional amounts live in currency_options');
    await assert.rejects(startTeamBillingCheckout(database, actor, teamId, requestId, 'kitchen', initial, 'eur'), { code: 'TEAM_BILLING_REQUEST_CONFLICT' });
    const before = fake.requests().length;
    await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'kitchen', opposite, 'eur'), { code: 'TEAM_BILLING_CURRENCY_MISMATCH' });
    assert.equal(fake.requests().length, before);
    const invalid = fake.subscriptions.get(completed.subscription);
    invalid.items.data[0].price.unit_amount = 1;
    await fake.events.emit('customer.subscription.updated', invalid); await deliver();
    assert.deepEqual(await read(), { state: 'attention-required', teamId, reason: 'catalogue-mismatch' });
    if (currency === 'usd') {
      const regional = fake.subscriptions.get(completed.subscription);
      regional.items.data[0].price.unit_amount = 1900;
      regional.items.data[0].price.currency_options.usd.unit_amount = 2500;
      await fake.events.emit('customer.subscription.updated', regional); await deliver();
      assert.deepEqual(await read(), { state: 'attention-required', teamId, reason: 'catalogue-mismatch' });
      regional.items.data[0].price.currency_options.usd.unit_amount = 2900;
    }
    for (const mutate of [
      p => { p.unit_amount_decimal = '2900.1'; },
      p => { p.custom_unit_amount = { enabled: true }; },
      p => { p.transform_quantity = { divide_by: 2, round: 'up' }; },
      p => { p.billing_scheme = 'tiered'; },
    ]) {
      const malformed = fake.subscriptions.get(completed.subscription);
      mutate(malformed.items.data[0].price);
      await fake.events.emit('customer.subscription.updated', malformed); await deliver();
      assert.deepEqual(await read(), { state: 'attention-required', teamId, reason: 'catalogue-mismatch' });
    }
    await fake.subscriptions.setStatus(completed.subscription, 'active'); await deliver();
    assert.equal((await read()).currency, currency);
  }
  if (trial) {
    const trialEndsAt = new Date((fake.state().now + 14 * 86400) * 1000).toISOString();
    assert.equal(completed.payment_status, 'no_payment_required');
    assert.deepEqual(await read(), { state: 'trialing', teamId, productKey: 'kitchen', quantity: 1, interval: initial, trialEndsAt });
    await startTeamBillingPortal(database, actor, teamId, randomUUID()); await drain();
    assert.equal(fake.state().portalSessions.length, 1, 'trialing interval subscriptions admit Portal access');
    if (initial === 'year:1') {
      database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'trial-member', 'member', ?)").run(teamId, now);
      await repairTeamBillingDesiredState(database); await drain(); await deliver();
      assert.deepEqual(await read(), { state: 'trialing', teamId, productKey: 'kitchen', quantity: 2, interval: initial, trialEndsAt });
    }
    await fake.clock.advance(14 * 86400); await deliver();
    assert.equal((await read()).state, 'active');
    assert.equal((await read()).interval, initial);
  }
  if (currency) {
    await database.close(); database = await open(); database.stripeApiBaseUrl = fake.origin; await database.init();
    assert.equal((await read()).currency, currency, 'restart preserves verified currency and amount');
  }
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
  if (currency) {
    const before = fake.requests().length;
    const reply = await send({ type: 'teamBilling.requestPlanTransition', input: { teamId, requestId: randomUUID(), productKey: 'kitchen', interval: opposite, currency: 'eur' } });
    assert.equal(reply.error.code, 'TEAM_BILLING_CURRENCY_MISMATCH');
    assert.match(reply.error.message, /currency/);
    assert.equal(fake.requests().length, before);
    const changed = { ...d, catalogue: structuredClone(d.catalogue) };
    const target = changed.catalogue.kitchen.stripe.sandbox.prices[opposite];
    target.currency = 'aud'; target.unitAmount = 3900; delete target.currencyOptions;
    database.teamBillingDefinition = normalizeTeamBillingDefinition(changed);
    await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, randomUUID(), 'kitchen', opposite), { code: 'TEAM_BILLING_CURRENCY_MISMATCH' });
    assert.equal(fake.requests().length, before);
    database.teamBillingDefinition = originalDefinition;
    const revokedRequest = randomUUID();
    await requestTeamBillingPlanTransition(database, actor, teamId, revokedRequest, 'kitchen', opposite);
    allowBilling = false; await drain(); allowBilling = true;
    assert.equal(fake.requests().length, before, 'revoked policy cannot write the provider');
    assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, revokedRequest, 'kitchen', opposite)).reason, 'authority-changed');
  }
  if (currency === 'usd') fake.faults.inject({ operation: 'subscriptions.update', status: 'paymentActionRequired' });
  const transition = randomUUID();
  const transitionReply = await send({ type: 'teamBilling.requestPlanTransition', input: { teamId, requestId: transition, productKey: 'kitchen', interval: opposite } });
  assert.equal(transitionReply.error, null, JSON.stringify(transitionReply));
  // A restart must not confuse equal product/quantity with an equal target Price.
  await repairTeamBillingDesiredState(database); await drain();
  assert.equal((await read()).state, currency === 'usd' ? 'active' : 'pending');
  await assert.rejects(requestTeamBillingPlanTransition(database, actor, teamId, transition, 'kitchen', initial), { code: 'TEAM_BILLING_REQUEST_CONFLICT' });
  assert.ok(checks.some(c => c.operation === 'plan-transition' && c.interval === opposite));
  assert.ok(fake.requests().some(r => r.operation === 'subscriptions.update' && r.parameters.proration_behavior === 'create_prorations'));
  if (currency === 'usd') {
    assert.equal((await requestTeamBillingPlanTransition(database, actor, teamId, transition, 'kitchen', opposite)).reason, 'payment-action-required');
    assert.equal((await read()).interval, initial, 'pending payment cannot apply the target Price');
    await fake.subscriptions.completePayment(completed.subscription);
  }
  await deliver(); if (currency) assert.equal((await read()).currency, currency); assert.equal((await read()).interval, opposite); assert.equal((await read()).state, 'active');
  if (!trial) { await startTeamBillingPortal(database, actor, teamId, randomUUID()); await drain(); }
  assert.equal(fake.state().portalSessions.length, 1, 'Portal attests both Prices for the same Product');
  await fake.portal.switchPrice(completed.subscription, initial === 'month:1' ? 'price_month' : 'price_year'); await deliver();
  assert.equal((await read()).interval, initial);
  if (initial === 'year:1') {
    database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'second-member', 'member', ?)").run(teamId, now);
    await stageTeamBillingMembershipChange(database, teamId); await drain(); await deliver();
    assert.equal((await read()).quantity, trial ? 3 : 2);
    assert.equal((await read()).interval, 'year:1', 'seat changes preserve the observed annual Price');
  }
  await fake.subscriptions.setStatus(completed.subscription, 'past_due'); await deliver(); assert.equal((await read()).state, 'past-due'); assert.equal((await read()).interval, initial);
  await fake.subscriptions.setStatus(completed.subscription, 'active'); await deliver();
  await fake.portal.cancelAtPeriodEnd(completed.subscription); await deliver(); assert.equal((await read()).state, 'cancelling');
  const sub = fake.subscriptions.get(completed.subscription);
  await fake.clock.advance(sub.items.data[0].current_period_end - fake.state().now); await deliver();
  assert.equal((await read()).state, 'cancelled'); assert.equal((await read()).interval, initial);
  if (currency) {
    const before = fake.requests().length;
    await assert.rejects(startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'kitchen', initial, 'eur'), { code: 'TEAM_BILLING_CURRENCY_MISMATCH' });
    assert.equal(fake.requests().length, before, 'a retained Customer cannot silently acquire a different currency');
  }
  if (trial) await assert.rejects(startTeamBillingCheckout(database, actor, teamId, randomUUID(), 'kitchen', opposite), { code: 'TEAM_BILLING_DENIED' });
});
