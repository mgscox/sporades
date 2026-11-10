# Flexible billing interval changes: evidence and test-clock follow-up

Issue: #366. Local evidence only; no Stripe account was contacted.

The regression was masked by a fake that applied classic interval-reset semantics
to every subscription. The fake now defaults each new subscription to flexible
mode and allows explicit classic fixtures. Signed callback tests store the
observed mode and exercise monthly/annual transitions in both modes. Provider
wire tests cover `billing_cycle_anchor=now` on `2026-08-26.dahlia` and
`billing_cycle_anchor[type]=now` on `2026-09-30.endive`. Managed longer-interval
changes send `always_invoice`; same/shorter intervals retain `create_prorations`.
Reset intent survives restart repair and seat changes while callbacks are delayed.
A lost response is resolved by retrieving the exact applied target without another
reset POST, including after a day has passed. Verified annual evidence stages any
remaining seats without moving the annual anchor or period. Pending payment leaves
the original applied tuple unchanged.

Sources checked on 2026-11-09:

- [Stripe billing-cycle guide](https://docs.stripe.com/billing/subscriptions/billing-cycle):
  flexible mode preserves the anchor on implicit interval changes; explicit reset
  with `always_invoice` requests immediate invoicing. The current guide shows the
  endive object encoding.
- [Stripe subscription update reference, dahlia](https://docs.stripe.com/api/subscriptions/update?api-version=2026-08-26.dahlia):
  dahlia uses the string anchor parameter.
- Installed stripe-node 22.6.2 declarations describe Portal
  `proration_behavior`, `billing_cycle_anchor`, and scheduling conditions. The
  Capsule declaration now attests these fields before creating a Portal Session.

## Manager post-merge check: Stripe sandbox test clocks

Live provider verification is deliberately outstanding. A manager should use an
isolated sandbox and synthetic customer/payment method, with no production data:

1. Pin dahlia. Create monthly USD 10 and annual USD 100 Prices for one Product,
   with fixed quantity 1, and bind the exact sandbox catalogue and reviewed Portal
   configuration. Create separate classic and flexible subscriptions under a test
   clock. Record each subscription's returned `billing_mode.type`.
2. Advance ten days into the paid month. Request monthly → annual through the
   managed operation. Capture the redacted request shape, signed Subscription
   observation, and finalized paid invoice. Expect an explicit `now` anchor,
   `always_invoice`, one full USD 100 annual debit line, unused-month credit,
   a new annual period beginning at the switch, and no second subscription.
   The payable total is annual debit less Stripe's calculated credit.
3. Repeat for classic mode, then same-interval seat changes and annual → monthly.
   Confirm the latter requests omit the explicit reset and retain existing
   `create_prorations` behavior; record the actual flexible period boundaries.
4. Use a payment method requiring action. Confirm no annual entitlement is
   inferred from acknowledgement alone; record pending-update expiry, payment
   completion, anchor/period timestamps and the verified callback result.
5. Repeat under endive with its object anchor encoding. This tests the encoding
   boundary; it does not authorize changing Sporades' default pinned version.
6. Attest a Portal configured to match the declaration; then change each of
   proration, anchor, and scheduling settings independently. Expect a safe failed
   operation and no Portal URL on drift. Restore the reviewed configuration.

Record invoice line amounts, credit rounding, payment timing and pending-anchor
semantics as provider evidence. The fake's USD credit model is deliberately narrow
and does not certify Stripe accounting, taxes, discounts or Portal scheduling.

## Reconciliation with trial transitions

The latest-main merge retains #370's continuing-trial policy: monthly-to-annual
switches during a trial omit the anchor reset and create no immediate invoice.
Trial preservation is durable too: if the provider trial expires before dispatch
or during pending payment, a changed target is refused before any write. A new
request after verified expiry uses a new paid-period intent and reset key. Explicit `transitions.endTrial`
ends the trial and invoices the target period once; attempted trial endings keep
their original tuple until verified evidence stages changed seats. Regression coverage crosses classic and flexible modes, including a
pending payment completed later; both fake update paths share the same invoice
calculation. Live accounting and trial preservation remain manager test-clock
checks.
