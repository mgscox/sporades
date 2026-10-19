# Test Team Billing without Stripe

`sporades/testing/stripe` ships `createStripeTeamBillingFake()`, a stateful
loopback HTTP provider for [headless Team Billing](./teams.md#declare-headless-team-billing).
It exercises Sporades' real Stripe SDK requests, provider attestations, callback
verification and billing convergence. It needs fixture credentials only and
never contacts Stripe. Its protocol is pinned to `2026-08-26.dahlia`.

## Use it in an app test

Match the fake's catalogue to the Capsule's sandbox Product, Price and reviewed
Portal configuration bindings. Seal `sk_test_app_fixture` and
`whsec_app_fixture` into the test Capsule's Stripe credential variables. The
webhook target is the local Capsule origin plus its configured callback path.

```ts
import { createStripeTeamBillingFake } from "sporades/testing/stripe";

const fake = await createStripeTeamBillingFake({
  webhookSecret: "whsec_app_fixture",
  webhookTarget: "http://127.0.0.1:5218/stripe/webhook",
  catalogue: {
    products: [{
      id: "prod_team",
      prices: [{ id: "price_team_monthly", recurring: "month" }],
    }],
    portalConfigurations: [{
      id: "bpc_team",
      products: [{ product: "prod_team", prices: ["price_team_monthly"] }],
    }],
  },
});
try {
  // App-owned harness: start the Capsule with the Dev-only origin override.
  const app = await startTestCapsule({
    env: { SPORADES_DEV_STRIPE_API_ORIGIN: fake.origin },
  });
  try {
    await app.billing.requestCheckout({ teamId, productKey: "team" });
    const session = fake.state().checkouts.at(-1);
    await fake.checkout.complete(session.id);
    await app.billing.waitForState(teamId, "active");

    await app.teams.acceptMember(teamId, secondUser);
    await app.billing.waitForQuantity(teamId, 2);
    const subscription = fake.customers.subscriptions(
      fake.state().checkouts.at(-1).customer,
    )[0];
    if (fake.subscriptions.get(subscription.id).items.data[0].quantity !== 2) {
      throw new Error("Provider seat quantity did not converge");
    }

    await fake.subscriptions.failPayment(subscription.id);
    await app.billing.waitForState(teamId, "past-due");
    await fake.subscriptions.setStatus(subscription.id, "active");
    await app.billing.waitForState(teamId, "active");
    // Continue through the app's authorized holder-transfer and erasure flows.
  } finally {
    await app.stop();
  }
} finally {
  await fake.close();
}
```

`startTestCapsule`, `app`, `teamId` and `secondUser` above are your app's test
helpers and fixtures. Await the app's verified billing projection after each
transition: a successful provider response or Checkout event alone does not
grant entitlement. Holder transfer remains the Capsule's authorization policy.
Never navigate the returned Checkout or Portal URLs: their real Stripe hostnames
satisfy redirect attestations, but the fake provides no hosted pages.

The app harness uses the [Dev-only origin setting](./teams.md#test-team-billing-with-a-loopback-provider).
The fake also works independently of that setting. To test SDK requests directly,
construct the installed `stripe` client using `fake.origin`:

```ts
import Stripe from "stripe";
const url = new URL(fake.origin);
const stripe = new Stripe("sk_test_app_fixture", {
  host: url.hostname,
  port: url.port,
  protocol: "http",
  apiVersion: "2026-08-26.dahlia",
  maxNetworkRetries: 0,
  timeout: 1000,
  telemetry: false,
});
```

## Control transitions and delivery

All returned objects are independent JSON snapshots of the supported provider
subset. `state()` includes `catalogue`, `now`, `customers`, `subscriptions`,
`checkouts`, `portalSessions` and `events`. Bearer keys are never logged or
returned. The in-memory state belongs to one fake and lasts until `reset()` or
`close()`; settle outstanding work before resetting it.

| Control | Effect |
| --- | --- |
| `checkout.complete(id, { customerId? })` | Creates or reuses a Customer, creates an active one-item Subscription, emits Checkout completion and Subscription creation. An existing Session Customer cannot be replaced. |
| `checkout.expire(id)` | Expires an open Session and emits expiry. |
| `portal.switchPrice(id, priceId)` | Simulates a Portal Price change and emits an update. |
| `portal.cancelAtPeriodEnd(id)`, `portal.resume(id)` | Schedules or removes cancellation and emits an update. |
| `subscriptions.setStatus(id, status)` | Accepts `active`, `past_due`, `unpaid`, `canceled`; canceled Subscriptions stay terminal. |
| `subscriptions.setQuantity(id, quantity)` | Changes seats and emits an update. |
| `subscriptions.completePayment(id)` | Applies an unexpired pending Price/quantity update after simulated successful payment, clears `pending_update`, and emits an active update. |
| `subscriptions.failPayment(id)` | Moves to `past_due` and emits a Dahlia `invoice.payment_failed`. |
| `subscriptions.renew(id)` | Advances the billing period and emits an active update. |
| `subscriptions.get(id)`, `customers.subscriptions(customerId)` | Inspects provider state. |
| `clock.advance(seconds)` | Moves forward, expiring due Checkouts, pending updates and scheduled cancellations. |
| `requests()`, `state()`, `reset()` | Inspects the request log/state or restores the initial empty state and catalogue. |

Delivery defaults to `"auto"`. With `delivery: "manual"`, `events.pending()`
returns undelivered events. Use `events.deliver(id?)`,
`events.deliverInOrder(ids)` or `events.redeliver(id)`; successful attempts leave
the pending queue. `events.deliveries()` records each HTTP status, or `null`
when transport fails. Failed automatic deliveries remain pending for explicit
retry. Delivery failure never rolls back provider state.

`events.deliver(id, { badSignature: true })` and `{ staleTimestamp: true }`
exercise callback refusal. `{ mutatePayloadSameId: object }` re-signs different
object bytes under an existing Event ID: admission must retain the original
Job payload. `events.emit(type, object, { created? })` creates a fresh Event ID
for malformed-evidence quarantine or unknown-event tests. The fake's event clock
moves forward per object; signatures always use the real wall clock.

## Faults, retries and erasure

```ts
fake.faults.inject({
  operation: "subscriptions.cancel", status: 503, count: 1, when: "after",
});
// Start the app's prepareErasure operation and await its durable retry.
// Cancellation committed despite the failed acknowledgement.
// The runtime must retrieve/list state to prove quiescence.
fake.faults.clear();
```

Operation names mirror SDK calls: `checkout.sessions.create|retrieve|expire`,
`billingPortal.configurations.retrieve`, `billingPortal.sessions.create`,
`subscriptions.retrieve|update|list|cancel`, and `customers.retrieve`.
Fault statuses accept Stripe 4xx/5xx errors (including 409, 429, 500 and 503) or
`"timeout"`. `when: "before"` fails without executing the call; `"after"`
executes it and loses the acknowledgement. Timeout faults hold the connection
beyond the fake's `requestTimeoutMs` (default 10000); set the SDK/runtime timeout
to that value or lower. `count` defaults to one. Special statuses
`"paymentActionRequired"` for `subscriptions.update` and
`"completeDuringExpire"` for `checkout.sessions.expire` exercise payment action
and erasure races.

`paymentActionRequired` retains the existing Subscription item Price and quantity.
The requested item is recorded in `pending_update.subscription_items`, with a
one-hour expiry. Signed update events therefore retain the existing plan/seats
until `subscriptions.completePayment(id)` succeeds and emits fresh applied
evidence. `setStatus(id, "active")` alone does not apply pending changes.
Expiration or cancellation discards them. Retrieve returns current state;
idempotent POST replay returns the original pending response even after payment
or expiration, without reapplying changes or emitting another event. The real
provider attests the exact requested pending item separately from applied items.

POSTs replay committed results for the same key and parameters, scoped to the
test API key. Changed parameters return `idempotency_error`. Before-execution
faults leave no committed response, allowing a retry. GET and DELETE ignore
idempotency keys. A lost DELETE acknowledgement requires retrieve/list
reconciliation. Set `pageSize: 1` to test multi-page Subscription discovery.
Unsupported endpoints, multi-item subscriptions and payment-mode Checkout
return `sporades_fake_unsupported` instead of fabricated success.

## CLI and JSON controls

The same fake is available to non-Node harnesses:

```sh
printf '%s' 'whsec_app_fixture' | sporades stripe-fake --json --port 0 \
  --webhook-target http://127.0.0.1:5218/stripe/webhook \
  --catalogue ./test/stripe-catalogue.json --webhook-secret-stdin
```

Add `--delivery manual` to queue webhooks for explicit JSON delivery controls;
the default is `auto`. The catalogue file has the `catalogue` shape above. Startup prints
`{ ok: true, data: { origin, controlOrigin }, error: null }`.
The secret is accepted only on stdin. Stop with SIGINT or SIGTERM.
Both servers bind to `127.0.0.1`; the API accepts only `sk_test_` bearer keys.
Webhook targets must use literal `127.0.0.1` or `[::1]` and an explicit port;
redirects and non-loopback targets are refused.

POST to `controlOrigin + "/__control/checkout.complete"` with content type
`application/json` and body `{ "args": ["cs_test_…"] }`. Every control in the
JavaScript API has the same dotted name and positional argument array;
`state`, `requests` and `reset` have no prefix. Success returns
`{ ok: true, data }` (void results become `null`); invalid requests return HTTP
400. Controls are never served on the Stripe API port, and browser Origin
headers are refused on the control port.

## What passing tests establish

Record this as **fake-provider acceptance**. It verifies the app against
Sporades' model of Stripe. It does not certify Stripe account configuration,
hosted pages, payment authentication, taxes, invoice amounts, real delivery
schedules, sandbox/live API compatibility, or Hosted Capsule callback TLS.
Those acceptance steps remain separately authorized human work. See
[ADR 0058](../adr/0058-team-billing-test-provider-boundary.md).
