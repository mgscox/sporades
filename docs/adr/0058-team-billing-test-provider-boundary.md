# ADR-0058: Team Billing has a supported loopback test-provider boundary

Status: Proposed

## Context

Headless Team Billing (ADR 0047, ADR 0048, ADR 0049) is runtime-owned. The
Capsule declares `teamBilling`, and Sporades owns the Stripe client, durable
Checkout, Portal, Plan-transition, seat-convergence and erasure Jobs, the
verified callback and the convergence inside the atomic Stripe fence. That
headless boundary is why Capsules cannot test it with their own fakes: no
Capsule code sits between the runtime and Stripe.

The runtime already has an internal seam for this. `createServerRuntime({
stripeApiBaseUrl })` stores the value as `database.stripeApiBaseUrl`, and every
Team Billing provider construction forwards it as `apiBaseUrl` to
`createStripeTeamBillingProvider`. There, `loopbackProvider()` admits only an
`http:` or `https:` origin on `localhost`, `[::1]` or `127.0.0.0/8` with no path,
query, fragment or credentials. The generated payment foundation has the same
check in `stripeProviderAddress()` and exposes it as the public, loopback-only
`apiBaseUrl` option of `createStripePaymentIntegration`. Sporades' own
integration tests start ad-hoc `node:http` servers against both seams.

Nothing outside the repository can reach the Team Billing seam. `createDevRuntime`
and the server Bundle entry in `src/cli/sporades.ts` pass a provider factory to
the runtime but never pass `stripeApiBaseUrl`. So `sporades dev`, and any app test
suite that drives it, always talks to `api.stripe.com`. The internal constructor
option is not a supported app boundary.

`mgscox/daily-build-template` gate #57 shows the cost. Its
`docs/runtime-contracts.md` ("Billing and mail limits of evidence") records that
active Team Checkout and Portal, Plan transitions, verified paid projections,
holder transfer, seat convergence and provider quiescence are **not certified**.
Its dormant refusal tests prove only that billing stays off. Each derived Capsule
that bills a Team has the same gap. The only way to close it today is a live
Stripe test-mode account, which needs separate authorization, network access and
manual setup. That rules it out for CI.

Two things are missing: a supported way to point the runtime's Team Billing
provider at a local fake, and a fake faithful enough that the runtime's strict
attestations and the ADR 0047 and ADR 0048 convergence actually run.

## Decision

### 1. Configuration surface: one Dev-only process variable

A Dev session reads one **process** environment variable:

```sh
SPORADES_DEV_STRIPE_API_ORIGIN=http://127.0.0.1:43123 sporades dev --json
```

When it is set and admitted, the CLI passes it to the Dev runtime as
`stripeApiBaseUrl`. The runtime then gives every runtime-owned Team Billing
provider construction the same `apiBaseUrl`: Checkout, Portal configuration
attestation, Portal session, managed Subscription update and erasure
quiescence. Dev restarts and rebuilds re-read the value from the CLI process, so
a candidate runtime never inherits a stale value from a previous one.

The value is not a `sporades.json` key, a CLI flag or a Server env key:

- Test fakes listen on ephemeral ports, so a committed config value would be
  wrong on every run. A committed value could also travel to a deploy.
- The `SPORADES_` prefix is already reserved, so Server env and Sealed Server
  env reject it. Capsule configuration can never set it, and `ctx.env` never
  exposes it.
- This matches the existing OAuth precedent: insecure loopback provider seams
  are process-only and cannot be enabled from `sporades.json`.

The generated payment foundation is not changed. Its Capsule-owned
`createStripePaymentIntegration` calls keep their explicit public `apiBaseUrl`
option, and the Dev variable is not injected into them. The runtime's Stripe
callback route does no network work: verification is a local HMAC, so it needs
no origin.

### 2. Safety refusals

All refusals fail closed with stable structured errors. They never fall back
silently to `api.stripe.com`.

| Condition | Result |
| --- | --- |
| Variable set on any command other than `sporades dev`: `deploy` and its subcommands, `host push`, `start`, `restart`, `rollback`, `invoke`, or an explicit Bundle build | Command refuses before Docker or Host contact with `STRIPE_TEST_ORIGIN_DEV_ONLY`. It is not ignored. The variable is often exported in a test shell, and ignoring it would hide a misconfigured pipeline. |
| `payments.stripe.livemode` is `true`, or the resolved secret key does not start with `sk_test_` (for example `sk_live_` or `rk_live_`) | `sporades dev` refuses to start with `STRIPE_TEST_ORIGIN_LIVE_MODE`. The usual mode/key check already rejects a mismatch. This refusal is a second check owned by the override itself. |
| Value is not exactly `http://127.0.0.1:<port>`, `http://[::1]:<port>`, or the same with `https:` | Refuses with `STRIPE_API_ORIGIN_INVALID`. An explicit port is required. `localhost`, other `127/8` addresses, hostnames, userinfo, path, query and fragment are rejected. This surface is stricter than the internal `loopbackProvider()` because a `localhost` name depends on host resolution. |
| Value set while `payments.stripe` is dormant or absent | Accepted with a warning. Nothing reaches a provider. |
| Value set and the value is empty or whitespace | Refuses with `STRIPE_API_ORIGIN_INVALID`. An empty value is not treated as "unset". |

These invariants are runtime-owned and covered by tests:

- The value is never written into a server Bundle, a private Dev action Bundle,
  a Container launch environment, a Host launch descriptor, release archives,
  `.sporades/` state or Sealed env. It follows the rule that CLI Dev builds embed
  no telemetry selection.
- A Bundle built while the variable is set is identical to one built without
  it.
- Local Container sessions and Hosted Capsules have no code path that reads
  the variable. The internal `stripeApiBaseUrl` option is still accepted only
  through constructor injection by Sporades' own CLI and tests.
- When the override is active, the `sporades dev --json` `started` event and
  doctor report `payments.stripe.providerOrigin: "loopback-test"`. Neither
  reports the port or the origin. Tests can then assert that they are not
  talking to Stripe. A `warn` platform log event
  (`payments.stripe.test_origin_active`) is emitted once per runtime start.
- A Public Dev session may use the override. The fake is still reachable only
  on loopback, and Public Dev already marks the session as non-production.

### 3. The fake: `createStripeTeamBillingFake()` and `sporades stripe-fake`

Sporades ships one stateful Stripe protocol fake that models exactly the calls
Team Billing makes. It is published as a new test-only subpath export:

```ts
import { createStripeTeamBillingFake } from "sporades/testing/stripe";

const fake = await createStripeTeamBillingFake({
  webhookSecret: "whsec_test_fixture",              // same value sealed into the Capsule
  webhookTarget: "http://127.0.0.1:5203/stripe/webhook", // Dev origin + callbackPath
  catalogue: {                                       // Products/Prices the Capsule binds
    products: [{ id: "prod_team", prices: [{ id: "price_team_monthly", recurring: "month" }] }],
    portalConfigurations: [{ id: "bpc_team", products: [{ product: "prod_team", prices: ["price_team_monthly"] }] }],
  },
});
process.env.SPORADES_DEV_STRIPE_API_ORIGIN = fake.origin; // http://127.0.0.1:<ephemeral>
// ... start `sporades dev`, drive the app, then:
await fake.close();
```

`sporades stripe-fake --json [--port 0] --webhook-target <url> --catalogue
<file>` runs the same object for harnesses that are not written in Node,
such as Playwright or shell-driven suites. It prints `{ ok, data: { origin,
controlOrigin } }`. The webhook secret is read only from stdin
(`--webhook-secret-stdin`), so it never shows up in a process listing. The fake
binds to loopback only, refuses a non-loopback `webhookTarget`, and accepts only
`sk_test_` bearer keys. A `sk_live_` or `rk_live_` key gets a Stripe-shaped 401
before any state is read, as a second guard behind the runtime refusal.

The fake uses only the Node standard library and the pinned `stripe` package
already in the dependency tree. Its responses and event payloads match the pinned
API version `2026-08-26.dahlia`. A request with any other `Stripe-Version` is
rejected with a 400.

#### Stripe endpoints the fake must model

Taken from `src/stripe-team-billing-provider.ts`. Bodies are form-encoded as the
Stripe SDK sends them.

| Endpoint | Runtime caller | Fidelity the runtime attests |
| --- | --- | --- |
| `POST /v1/checkout/sessions` | Checkout Job `create`. Erasure also replays an original Checkout through `checkoutRecoveries` | `mode: "subscription"`, one `line_items` entry, `client_reference_id`, `expires_at`, `metadata.sporades_team_billing_operation`, `subscription_data.metadata`, optional `customer`. Returns `cs_test_…` with `url` `https://checkout.stripe.com/c/pay/<id>`, `livemode: false`, and `expires_at` echoed exactly. |
| `GET /v1/checkout/sessions/:id` | Erasure | `object`, `mode`, `livemode`, and `status` of `open`, `complete` or `expired`. When complete, also `customer` and `subscription`. Unknown ids return an exact 404. |
| `POST /v1/checkout/sessions/:id/expire` | Erasure | Open goes to `expired`. A non-open session returns Stripe's exact 400 `invalid_request_error` "Only Checkout Sessions with a status in [\"open\"] can be expired. This Checkout Session has a status of `complete`." text, which `isCheckoutNonExpireableRace` matches. |
| `GET /v1/billing_portal/configurations/:id?expand[]=features.subscription_update.products` | Portal Job attestation | `bpc_…`, `active`, `livemode`, payment-method update, invoice history, cancel `at_period_end`, `subscription_update.enabled`, `default_allowed_updates: ["price"]`, and products with `adjustable_quantity.enabled: false` and exact price lists, all taken from the fake's catalogue. |
| `POST /v1/billing_portal/sessions` | Portal Job | `customer`, `configuration`, `return_url`. Returns `bps_…` with `url` `https://billing.stripe.com/p/session/<token>`. |
| `GET /v1/subscriptions/:id` | Managed update pre-read, erasure | One-item `items` list (`has_more: false`). The item has `si_…`, a `subscription` back-reference, a quantity, `current_period_start`/`current_period_end`, and a `price` object with `product: prod_…` and `recurring.usage_type: "licensed"`. Also `customer`, `status`, `cancel_at_period_end`, `cancel_at` and `metadata`. |
| `POST /v1/subscriptions/:id` | Plan transition and seat convergence | `items[0][id|price|quantity]`, `proration_behavior: create_prorations`, `proration_date`, `payment_behavior: pending_if_incomplete`. Returns the updated Subscription, or one with `pending_update` set when a payment-action fault is armed. |
| `GET /v1/subscriptions?customer=&status=all&limit=100&starting_after=` | Erasure discovery | A real `list` with `has_more` and cursor paging. Tests can shrink the page size to exercise pagination. |
| `DELETE /v1/subscriptions/:id` | Erasure cancel | Moves the Subscription to `canceled` and emits `customer.subscription.deleted`. Unknown ids return an exact 404. |

Every `POST` honours `Idempotency-Key` the way Stripe API v1 does. The same key
with the same parameters replays the original status and body, with the
`idempotent-replayed: true` header. The same key with different parameters
returns a 400 `idempotency_error`. Keys are scoped to the API key. `GET` and
`DELETE` ignore idempotency keys and do not cache responses by key, matching
[Stripe's idempotency contract](https://docs.stripe.com/api/idempotent_requests).
After a lost cancellation acknowledgement, erasure recovers by retrieving and
listing provider state, attesting that the Subscription is canceled (or safely
absent), and canceling any remaining live Subscriptions. Tests must prove this
reconciliation rather than expect a cached `DELETE` replay.

#### Events the fake must emit

Taken from `SUPPORTED` in `src/team-billing-convergence.ts`. The payloads carry
every field that `applyCheckout`, `normalizeSubscription` and
`applyInvoiceFailure` validate, so a well-formed fake event converges. A test
that wants to see a quarantine through the callback must emit malformed
convergence evidence with a fresh Event ID so admission reaches convergence.

| Event | Emitted when | Fields required by convergence |
| --- | --- | --- |
| `checkout.session.completed` | `checkout.complete` | `status: "complete"`, `customer`, `subscription`, `client_reference_id` equal to the operation id, matching `metadata.sporades_team_billing_operation`. |
| `checkout.session.expired` | `checkout.expire`, or a Checkout past its `expires_at` on `clock.advance` | `status: "expired"`. |
| `customer.subscription.created` | First paid Subscription from a Checkout | Exactly one licensed item, item periods, `cancel_at_period_end`, `cancel_at` either null or equal to the item period end, `metadata.sporades_team_billing_operation`. |
| `customer.subscription.updated` | Managed update, Portal price switch, status change, renewal, period-end cancellation | As for `created`. |
| `customer.subscription.deleted` | `DELETE`, or `subscriptions.setStatus(…, "canceled")` | `status: "canceled"`. |
| `invoice.payment_failed` | `subscriptions.failPayment` | `status: "open"`, `paid: false`, `attempt_count >= 1`, `parent.subscription_details.subscription`, one line item with `parent.subscription_item_details` (`proration: false` and the exact item), `pricing.price_details` (price and product), a quantity, and a period equal to the item's current period. |

Every event is a complete `object: "event"` envelope with `evt_…`, `type`,
`created`, `livemode: false` and `data.object`. The fake signs the exact bytes
it sends: `Stripe-Signature: t=<now>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`
using the configured `webhookSecret`. It POSTs them to `webhookTarget`, so the
Capsule's real runtime callback route verifies them and admits them as
idempotent Stripe Event Jobs. ADR 0045 and ADR 0047 convergence then runs
unchanged. The signature timestamp is always the real wall clock, because
verification has a 300-second tolerance. The event `created` comes from the
fake's clock (described below) and is strictly increasing per object by at least
one second. Same-second ties therefore never decide a ratchet unless a test sets
`created` explicitly.

#### Control API

The JavaScript object and the CLI's `controlOrigin` expose one contract. The CLI
form is the same operations as JSON `POST`s under a reserved `/__control/`
prefix on a second loopback port. The Stripe-facing origin never serves control
routes, so the runtime can never reach them.

- **Checkout outcomes.** `checkout.complete(sessionId, { customerId? })` creates
  or reuses the Customer and an `active` Subscription for the session's Price
  and quantity, then emits `checkout.session.completed` and
  `customer.subscription.created`. `checkout.expire(sessionId)` does the expiry.
  The Checkout and Portal URLs use the real Stripe hostnames, because the
  runtime's validators require them. They are placeholders: the fake serves no
  hosted pages, and browser tests must not follow them.
- **Portal actions** (simulated Customer actions). These are
  `portal.switchPrice(subscriptionId, priceId)`, `portal.cancelAtPeriodEnd(id)`
  and `portal.resume(id)`. Each emits `customer.subscription.updated`.
- **Subscription lifecycle.** `subscriptions.setStatus(id, "active" |
  "past_due" | "unpaid" | "canceled")`. `subscriptions.failPayment(id)` emits
  `invoice.payment_failed` and moves the Subscription to `past_due`.
  `subscriptions.renew(id)` advances the period. `subscriptions.get(id)` and
  `customers.subscriptions(customerId)` let tests assert provider-side quantity,
  Price and status, for example after seat convergence.
- **Time.** The clock defaults to the real time at creation and then only moves
  forward. `clock.advance(seconds)` advances it, and also expires due Checkouts
  and period-end cancellations, emitting their events.
- **Delivery.** Delivery is `"auto"` by default: each event is sent as soon as
  its transition commits. In `"manual"` mode, events queue up, and the test
  calls `events.pending()`, `events.deliver(eventId?)`,
  `events.deliverInOrder(ids)` (to test out-of-order arrival),
  `events.redeliver(eventId)` (a duplicate, testing idempotent admission) and
  `events.emit(type, object)` (an arbitrary or unknown type, testing the ignore
  path). `events.deliveries()` returns each attempt's status code. Delivery
  faults include `badSignature`, `staleTimestamp` (more than 300 seconds old)
  and `mutatePayloadSameId`. After the original Event ID has been admitted,
  `mutatePayloadSameId` tests callback deduplication: the callback returns the
  existing Job, whose original payload is retained and executed. It does not
  reach observation-digest quarantine. Callback-driven quarantine tests use
  `events.emit(type, object)` with malformed convergence evidence and a fresh
  Event ID. Same-ID digest-conflict coverage stays at the lower-level
  `applyVerifiedTeamBillingObservation` boundary, bypassing callback admission.
  Stripe's real retry schedule is not modelled: a test redelivers on purpose.
- **Provider faults.** `faults.inject({ operation, status, count, when })`.
  `operation` names one row of the endpoint table, such as
  `"subscriptions.update"`. `status` is `409`, `429`, `500`, `503`, a Stripe 4xx
  rejection, or `"timeout"` (the request is held past `requestTimeoutMs`).
  `when: "before"` fails without changing state. `when: "after"` applies the
  change, then fails the reply to simulate a lost acknowledgement. For `POST`,
  it records the idempotent response, so a retried Job must reuse the same
  idempotency key and get the original result. For `DELETE`, it records no
  response by key; erasure must reconcile the canceled or safely absent
  Subscription through provider reads. Special faults include
  `paymentActionRequired` (the update returns `pending_update`) and
  `completeDuringExpire`, which makes an open Checkout complete while an
  `expire` request is in flight so the ADR 0049 race is exercised.
  `faults.clear()` removes them.
- **Inspection.** `requests()` returns the ordered request log: method, path,
  operation name, parsed parameters, idempotency key, and whether the response
  was a replay. Bearer keys are never recorded. `state()` returns a JSON
  snapshot. `reset()` returns the fake to its initial catalogue.

Out-of-contract requests get a 400 with a `sporades_fake_unsupported` code and
are logged. Examples are other endpoints, a multi-item Subscription, or `mode:
"payment"`. A runtime change that starts calling a new Stripe endpoint then
fails the fake's parity test instead of passing by accident.

### 4. Conformance of the fake itself

The fake is part of the shipped surface. Its own `node --test` suite drives the
**real** `createStripeTeamBillingProvider` and the real callback verification
against it. The runtime's attestation and convergence validators are the fake's
specification. Parity tests fail if an operation in
`stripe-team-billing-provider.ts`, or a type in `SUPPORTED`, has no entry in the
fake's endpoint or event tables. An end-to-end test scaffolds a Team Billing
Capsule, runs `sporades dev` with the override, and covers six paths: Checkout to
active, seat convergence, Plan transition, past-due, period-end cancellation, and
erasure quiescence with an injected 409, 429 and 5xx on each provider operation.

Conformance expectations distinguish these boundaries:

- `POST` retries with the same key and parameters replay the cached result;
  changed parameters produce `idempotency_error`.
- `GET` and `DELETE` ignore keys. A lost `DELETE` acknowledgement leaves the
  provider cancellation committed, and erasure retries prove quiescence through
  retrieve/list reconciliation without relying on a cached cancellation reply.
- A changed signed payload with an already admitted Event ID returns the
  existing Job and preserves its original payload, without applying the changed
  evidence or creating an observation-digest quarantine.
- Malformed convergence evidence with a fresh Event ID passes real signature
  verification and Job admission, then quarantines through convergence without
  granting entitlement. A separate lower-level convergence test submits
  conflicting digests for the same Event ID directly to
  `applyVerifiedTeamBillingObservation` and asserts digest quarantine.

### What this does not certify

A green run against the fake shows that the Capsule and the Sporades runtime
agree with **Sporades' model** of Stripe. It does not show that Stripe agrees.
These stay human-only, run in an authorized Stripe sandbox and then in live
mode:

- Whether Stripe accepts the real account's Products, Prices, Portal
  configurations, tax, currency and payment-method settings, and whether the
  pinned API version still behaves as modelled.
- Hosted Checkout and Customer Portal pages, payment methods, 3-D Secure/SCA,
  declines, and real proration or invoice amounts.
- Webhook endpoint registration, Stripe's real delivery latency, ordering, retry
  schedule and signing-secret rotation.
- Hosted Capsule reachability, TLS and Edge TLS on the callback route.
- Customer deletion, disputes, refunds, and any event outside `SUPPORTED`.
- Live mode in any form. The boundary refuses it by construction.

Derived Capsules should record fake-provider evidence as **fake-provider
acceptance**, separate from sandbox and live acceptance, as daily-build-template
already does for mail callbacks.

## Alternatives considered

- **Expose a public provider-injection factory** by making the internal
  `createServerRuntime({ createStripeTeamBillingProvider })` option a supported
  API. Rejected. An injected object replaces the very code under test: the Stripe
  SDK request encoding, idempotency headers, and the response attestations in
  `stripe-team-billing-provider.ts`. It would also give Capsule code a way to
  supply billing "truth", which ADR 0047 forbids. An HTTP-level fake exercises
  every runtime byte except the network destination.
- **A `sporades.json` key** such as `dev.stripeApiOrigin`. Rejected. Ports are
  ephemeral, the value would be committed alongside deployable configuration,
  and it breaks the process-only precedent for insecure loopback provider seams.
- **A `sporades dev --stripe-api-origin` flag.** This works equally well for a
  harness. It was rejected only to keep one input. A variable can also be set
  once for a whole suite that restarts Dev sessions. A flag can be added later
  over the same validation if needed.
- **Official `stripe-mock`.** Rejected as the primary fake. It is stateless:
  Checkout never completes, Subscriptions never change, and no webhooks are
  sent. So convergence, ratchets, quiescence discovery and idempotent replay
  cannot be exercised. Its fixtures may still be used in the fake's own suite to
  cross-check response shapes for the pinned API version.
- **Stripe test mode with `stripe listen`.** This is real and valuable, but it
  needs an account, credentials, network access and authorization. It is not
  hermetic or deterministic, cannot inject faults, and is unusable in CI. It
  stays the human sandbox acceptance step.
- **A fake for all of Stripe.** Rejected. Modelling only what Team Billing calls
  keeps the fake small enough to stay exact. The out-of-contract 400 turns any
  scope creep into a visible parity failure.

## Consequences

- Derived Capsules can certify active Team Checkout and Portal, Plan
  transitions, verified paid projections, seat convergence, holder transfer
  (which runs on top of a verified paid projection) and provider quiescence in
  CI, without Stripe credentials or network access.
- New public surface ships together: the `sporades/testing/stripe` export and
  its `src/types` declarations, the `stripe-fake` CLI command, the
  `SPORADES_DEV_STRIPE_API_ORIGIN` variable and its refusal codes, regenerated
  `dist/` and `bin/` artifacts, reference docs (Team Billing testing, the
  configuration reference and the CLI reference), and parity tests.
- The fake becomes a maintained contract. Each change to Team Billing's provider
  calls or `SUPPORTED` events must update the fake in the same change, and the
  parity test enforces it. A Stripe API version bump must re-check the fake
  against the new version.
- The internal `stripeApiBaseUrl` option, `loopbackProvider()` and
  `stripeProviderAddress()` stay as they are. The stricter literal-loopback
  check applies at the CLI surface. Narrowing the internal validators to match
  is optional follow-up work, not part of this decision.
- Risk: a team may treat fake-provider green as production readiness. The
  explicit "does not certify" list, the `loopback-test` marker in started and
  doctor output, and the separate evidence label are there to stop that.
- Implementation is a separate set of issues. This ADR adds no runtime code.
