import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTeamBillingPriceEvidence } from 'sporades/server/stripe';

const catalogue = { kitchen: { quantity: { kind: 'fixed', value: 1 }, stripe: {
  sandbox: { productId: 'prod_kitchen', prices: { 'month:1': { priceId: 'price_month', currency: 'gbp', unitAmount: 1900,
    currencyOptions: { usd: { unitAmount: 2900 }, eur: { unitAmount: 2500 } } } } },
  live: { priceId: 'price_live' },
} } };
function price() { return { id: 'price_month', object: 'price', active: true, livemode: false, product: 'prod_kitchen',
  type: 'recurring', billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  currency: 'gbp', unit_amount: 1900, currency_options: { gbp: { unit_amount: 1900 }, usd: { unit_amount: 2900 }, eur: { unit_amount: 2500 } },
}; }
test('saved expanded Price evidence verifies every currency, amount, identity and interval without provider I/O', () => {
  const validate = evidence => validateTeamBillingPriceEvidence({ catalogue, mode: 'sandbox', evidence });
  assert.deepEqual(validate([price()]), { ok: true });
  assert.deepEqual(validate({ data: [price()] }), { ok: true });
  for (const mutate of [
    p => { p.currency_options.usd.unit_amount = 1900; },
    p => { delete p.currency_options.eur; },
    p => { delete p.currency_options; },
    p => { p.currency_options.aud = { unit_amount: 3900 }; },
    p => { p.currency_options.gbp.unit_amount = 1; },
    p => { p.currency_options.usd.custom_unit_amount = { enabled: true }; },
    p => { p.currency_options.usd.unit_amount_decimal = '2900.1'; },
    p => { p.recurring.interval = 'year'; }, p => { p.product = 'prod_other'; },
    p => { p.active = false; }, p => { p.livemode = true; },
    p => { p.transform_quantity = { divide_by: 2, round: 'up' }; },
  ]) {
    const p = price(); mutate(p);
    assert.throws(() => validate([p]), { code: 'TEAM_BILLING_PRICE_EVIDENCE_MISMATCH' });
  }
  for (const evidence of [null, {}, [null], [price(), price()]]) {
    assert.throws(() => validate(evidence), { code: 'TEAM_BILLING_PRICE_EVIDENCE_MISMATCH' });
  }
});
