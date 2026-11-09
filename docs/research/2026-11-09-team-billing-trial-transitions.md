# Team Billing trial transitions: fake acceptance and real Stripe follow-up

Issue: [#370](https://github.com/mgscox/sporades/issues/370). This implements
Issue 6 from [the plan-migration research](2026-11-08-team-billing-in-place-plan-migration.md).

Managed plan switches now admit entitled `trialing` Subscriptions. The fake
preserves `trial_end` when changing Price or quantity, including an interval
change. Server-only `transitions.endTrial: true` records an immediate trial end
with the durable intent, sends `trial_end=now`, and the fake starts the target
billing period and records a paid invoice. A payment-action fault retains the
old trial and items until successful payment applies the pending update.
Provider acknowledgement never grants local entitlement.
If the trial expires before dispatch, the final provider read refuses a changed
target without writing `trial_end=now` into a paid period. An already-active
exact target is acknowledged without another write, including lost-ack recovery.

Portal attestation requires `subscription_update.trial_update_behavior` to be
`continue_trial` by default or `end_trial` when the declaration ends trials.
The fake configuration defaults to `continue_trial`; its optional
`trialUpdateBehavior` models either value for attestation tests.

## Manager test-clock check still required

No real Stripe calls were made for this issue. Fake acceptance does not confirm
that a real Stripe Price change during `trialing` preserves the trial via the
API. This remains unconfirmed and requires a manager-run Stripe sandbox test
clock with the repository's pinned API version (`2026-08-26.dahlia`).

On that clock, create a trial Subscription and record `trial_end`, item Price,
quantity and period bounds. Apply the managed update with no `trial_end`, for
both same-interval and monthly-to-annual switches. Confirm the original trial
end remains, no immediate paid invoice is created, and advancing to that end
starts billing at the target Price and quantity. Separately verify
`trial_end=now` ends and invoices immediately, and exercise payment action,
retry, and the Portal's two declared trial behaviors. Record provider evidence
and results before claiming real Stripe acceptance.

The API documents ending a trial with `trial_end=now` and lists `trial_end`
among pending-update attributes:

- [Stripe free trials](https://docs.stripe.com/billing/subscriptions/trials/free-trials)
- [Stripe pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates)

Those references do not replace the preservation test-clock check.
