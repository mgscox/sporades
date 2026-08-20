# Built-in Stripe payment foundation

Status: ready-for-agent

## Problem Statement

Most useful Capsules eventually need to take a payment, begin a subscription,
or let a customer manage existing billing. The blank Capsule is the basis for
most derived work, but it currently provides no payment foundation. Capsule
authors and agents must repeatedly rediscover Stripe setup, secret handling,
Checkout and Customer Portal creation, webhook signature verification,
idempotency, durable retry, and safe reconciliation.

That repetition is both expensive and dangerous. A superficially working
Stripe call can hold a Database Transaction open across remote I/O, accept a
forged callback after parsing away the signed request bytes, create duplicate
provider objects after retry, trust a browser-supplied Price identifier, or
confuse Stripe transport mechanics with Capsule-specific subscription and
authorization policy.

Payments are normal application infrastructure rather than a special Capsule
genre. A dedicated payment template would fragment the template catalogue and
would not help the many Capsules derived from the blank scaffold. Sporades
therefore needs a safe built-in payment foundation in the blank scaffold while
preserving the distinction between runtime-owned provider mechanics and
Capsule-owned commercial policy.

## Solution

Every newly created blank Capsule will contain a dormant, production-shaped
Stripe payment foundation. Sporades will ship the provider implementation and
the blank scaffold will contain the Capsule wiring needed to start Checkout,
open the Customer Portal, inspect the resulting durable Job, and consume
verified Stripe events. The generated Capsule remains runnable without a Stripe
account or credentials.

Stripe support becomes active only through explicit validated project
configuration backed by Sealed Server env. Enabling it without the required
credentials fails safely before a Capsule accepts payment traffic. When Stripe
support is disabled, no Stripe callback route is registered and no payment
operation can reach the provider.

User-initiated outbound operations use the existing Job Queue. A normal Capsule
mutation authenticates and authorizes the actor, maps a public product choice
to a server-owned Price, and atomically enqueues an idempotent Job. The Job
performs remote Stripe I/O outside the originating mutation's Database
Transaction. Capsule query behavior exposes bounded state for that known Job so
the browser can show progress and redirect to the returned Checkout or Customer
Portal URL after success.

Stripe callbacks enter through a runtime-owned HTTP route. Sporades retains the
exact bounded request bytes, verifies the Stripe signature before accepting the
payload, and atomically enqueues one Privileged Job per provider event identity.
Capsule code decides what a verified event means for its own billing records,
Team access, entitlements, notifications, exports, erasure, and retention.

The first release supports Stripe-hosted Checkout for one-time and subscription
payments, Stripe Customer Portal sessions, and verified webhook-to-Job
delivery. It deliberately avoids a generic provider request escape hatch or a
Sporades-owned subscription model.

## User Stories

1. As a Capsule author, I want every new blank Capsule to include a payment foundation, so that adding ordinary commercial behavior does not require redesigning the server architecture.
2. As a Capsule author, I want the payment foundation to be part of the blank scaffold rather than a dedicated template, so that derived Capsules inherit it naturally.
3. As a Capsule author, I want a newly scaffolded Capsule to run without Stripe credentials, so that payment infrastructure does not obstruct early development.
4. As a Capsule operator, I want Stripe support to require explicit activation, so that an unused integration exposes no callback route or provider authority.
5. As a Capsule operator, I want Stripe secrets stored only in Sealed Server env, so that credentials do not enter source files, project configuration, logs, Bundles, or browser code.
6. As a Capsule operator, I want activation to fail before serving traffic when required Stripe configuration is incomplete, so that a partially configured Capsule does not fail unpredictably during payment.
7. As a Capsule author, I want a server-owned Price catalogue, so that browsers choose products rather than supplying trusted Stripe Price identifiers.
8. As a Capsule author, I want separate Price configuration for development and hosted environments, so that test and live Stripe objects cannot be accidentally confused.
9. As an authenticated customer, I want to start a Stripe-hosted one-time Checkout, so that I can pay without the Capsule handling card details.
10. As an authenticated customer, I want to start a Stripe-hosted subscription Checkout, so that I can begin recurring billing through a familiar provider flow.
11. As a Capsule author, I want one common Checkout operation for one-time and subscription modes, so that the integration stays small while supporting both ordinary cases.
12. As a Capsule author, I want Checkout to return only the safe identity and redirect URL the Capsule needs, so that provider response details do not leak throughout app code.
13. As a customer with a Stripe Customer identity, I want to open a short-lived Customer Portal session, so that I can manage supported billing details without a bespoke Capsule billing interface.
14. As a Capsule author, I want the Capsule to resolve its own user or Team to a Stripe Customer, so that Sporades does not invent ownership policy.
15. As a Capsule author, I want the generated payment mutation to require a linked authenticated user by default, so that payment authority starts from a safe baseline.
16. As a Capsule author selling to guests, I want an explicit documented way to permit anonymous one-time Checkout, so that guest commerce is possible without silently weakening every Capsule.
17. As a billing administrator, I want Capsule policy to decide who may begin Checkout or open the Customer Portal, so that provider availability does not bypass Team or app authorization.
18. As a Capsule author, I want success, cancellation, and portal return locations constrained to the configured Capsule origin, so that payment redirects cannot become open redirects.
19. As a Capsule operator, I want hosted payment return URLs to require a trusted HTTPS public origin, so that production customers do not return through attacker-controlled or plaintext locations.
20. As a local developer, I want the same return-path behavior to support explicit localhost origins, so that payment flows can be tested in a Dev session.
21. As a customer who retries an action, I want the Capsule to reuse a stable business-derived idempotency key, so that retries do not create duplicate Checkout or Portal sessions.
22. As a Capsule author, I want idempotency keys namespaced by Capsule and operation, so that unrelated payment actions cannot collide.
23. As a Capsule author, I want payment Jobs to preserve their stable identity across retries, so that at-least-once execution does not become duplicate business work.
24. As a browser user, I want to observe that my payment action is pending, succeeded, or failed, so that remote provider latency is visible rather than appearing as a frozen mutation.
25. As a browser user, I want to redirect only after a payment Job returns a validated Stripe URL, so that failed or incomplete provider calls cannot navigate me away.
26. As a Capsule author, I want browser payment state to use ordinary Capsule mutations and queries, so that no new provider-specific client transport is required.
27. As a Capsule operator, I want Stripe calls to occur outside the originating mutation's Database Transaction, so that remote latency does not hold app writes or adapter locks open.
28. As a Capsule author, I want the enqueue and any related app writes to commit atomically, so that a payment Job cannot exist without the local intent that authorized it.
29. As a Capsule operator, I want transient Stripe failures retried through bounded Job policy, so that temporary network or provider failures recover durably.
30. As a Capsule operator, I want permanent provider rejection to become bounded safe Job failure metadata, so that inspection is useful without exposing credentials or raw provider responses.
31. As a Stripe account owner, I want incoming webhook signatures checked against the exact bytes Stripe sent, so that parsed or rewritten JSON cannot be accepted as authentic.
32. As a Capsule author, I want verified Stripe callbacks delivered through one stable Capsule authoring seam, so that app code does not own HTTP verification mechanics.
33. As a Capsule operator, I want invalid signatures rejected with an opaque response, so that attackers learn nothing useful about secrets or verification failures.
34. As a Capsule operator, I want malformed verified payloads rejected without crashing the runtime, so that hostile callback input remains bounded.
35. As a Capsule author, I want duplicate Stripe events to resolve to the same durable Job, so that provider retry does not repeat local consequences.
36. As a Capsule author, I want event handlers to tolerate out-of-order delivery, so that access decisions do not assume webhook ordering Stripe does not guarantee.
37. As a Capsule author, I want verified event processing to run as explicit Privileged server work, so that system-owned billing reconciliation never impersonates a connected user.
38. As a security reviewer, I want Privileged event execution audited through the existing lifecycle, so that payment-driven authority has normal Sporades provenance.
39. As a Capsule author, I want Stripe event identity, type, creation time, mode, and relevant object identifiers available to my handler, so that I can reconcile app state without parsing an HTTP request.
40. As a Capsule author, I want access to the verified provider event when genuinely needed, so that new Stripe event types do not immediately require a Sporades release.
41. As a privacy reviewer, I want Sporades not to persist raw Stripe events by default, so that payment data retention remains deliberate and Capsule-owned.
42. As a privacy reviewer, I want logs to omit raw callback bodies, signatures, secrets, full provider errors, and short-lived URLs, so that normal diagnostics do not become a payment-data leak.
43. As a Capsule author, I want my app to decide which verified events change subscriptions, access, invoices, or notifications, so that Sporades does not become the commercial domain model.
44. As a Team-based Capsule author, I want subscriptions and Stripe Customers to remain explicitly associated by app policy with Teams, so that provider integration does not replace Team ownership rules.
45. As a Team billing administrator, I want membership counts and billing-holder rules applied before an Agency-seat reconciliation Job is enqueued, so that transport helpers cannot widen billing authority.
46. As a Capsule author, I want direct subscription quantity reconciliation to remain a later narrow operation, so that the first release does not expose a broad Stripe client unnecessarily.
47. As a Capsule author, I want Customer Portal behavior preferred for ordinary customer-managed changes, so that the Capsule does not reproduce provider billing UI and policy.
48. As a maintainer, I want Stripe transport code shipped once by Sporades rather than copied into every generated Capsule, so that provider fixes have locality.
49. As a maintainer, I want the blank scaffold to contain only wiring and Capsule policy placeholders, so that regenerated projects do not carry a forked Stripe implementation.
50. As a maintainer, I want no generic provider-request method in the public interface, so that the supported security and compatibility surface remains reviewable.
51. As a maintainer, I want the official Stripe server library pinned to a tested compatible range, so that provider protocol behavior is explicit and reproducible.
52. As a maintainer, I want the Stripe library completely bundled into the server Bundle, so that Container sessions and Hosted Capsules retain the no-runtime-resolution invariant.
53. As a maintainer, I want disabled payment code excluded from active runtime registration, so that built-in source does not imply built-in authority.
54. As an agent, I want generated payment files and instructions to state which sections are platform wiring and which require Capsule decisions, so that I do not mistake placeholders for finished billing policy.
55. As an agent, I want structured configuration and Job failures with actionable hints, so that I can diagnose setup without scraping logs or revealing secrets.
56. As a developer upgrading Sporades, I want existing Capsules without payment configuration to preserve their current behavior, so that the feature is backward compatible.
57. As a developer creating a non-blank demonstration template, I want its current domain behavior to remain unchanged unless it deliberately adopts the blank payment foundation, so that this feature does not trigger an unrelated template rewrite.
58. As a release reviewer, I want source, public declarations, generated runtime artifacts, canonical documentation, and packed contents to describe the same payment contract, so that repository-only success cannot hide a broken release.
59. As a release reviewer, I want a generated blank Capsule exercised through its real Bundle, Database adapter, Job worker, HTTP route, and client transport, so that helper-only tests cannot claim end-to-end completion.
60. As a release reviewer, I want automated provider tests to use a protocol-faithful local Stripe adapter or HTTP fake, so that the suite is deterministic and never spends money or depends on a live account.

## Implementation Decisions

- The blank scaffold is the product seam for built-in payments. Stripe is not a
  dedicated Capsule template and the first implementation does not introduce a
  general-purpose feature-scaffold command.
- The generated blank Capsule always contains payment wiring, payment Jobs,
  bounded payment-status queries, shared payment state, an empty server-owned
  Price catalogue, and activation instructions.
- Sporades owns the Stripe implementation in a separately exported server-only
  integration module. Generated Capsules import that module rather than
  containing copies of request, signature, retry, or error-mapping code.
- The Stripe integration module is a deep module with explicit operations for
  Checkout Session creation, Customer Portal Session creation, and verified
  event admission. It returns narrow Sporades values rather than complete
  Stripe SDK objects.
- There is no generic Stripe request interface. New direct operations require
  their own reviewed interface and demonstrated repeated Capsule need.
- Stripe Checkout Sessions are the first payment-collection mechanism. The
  integration supports both one-time payment and subscription modes while
  relying on Stripe-hosted payment UI.
- Customer Portal Sessions are the default mechanism for customer-managed
  payment methods, invoices, cancellations, and supported subscription changes.
- Project configuration gains an optional Stripe payment section with an
  explicit enabled flag, a callback path, Server env key references, a public
  origin reference, and any stable provider compatibility settings required by
  the adapter.
- The blank scaffold writes the Stripe payment configuration in its disabled
  form. Disabled configuration registers no callback route and exposes no
  usable provider operation.
- Enabling Stripe validates the complete configuration before runtime
  publication. Missing or malformed secrets, origins, callback paths, or
  compatibility settings fail with structured errors and actionable hints.
- Secret keys and webhook signing secrets exist only in Sealed Server env. The
  project configuration contains references to Server env keys, never secret
  values.
- Price identifiers are server-owned configuration. Browser input selects an
  app-defined product or plan key, which Capsule code maps to an allowlisted
  Price after authorization.
- A trusted public Capsule origin is configuration rather than a value inferred
  from an incoming Host header. Checkout success and cancellation paths and
  Customer Portal return paths must remain same-origin absolute paths.
- HTTPS is required for a hosted public origin. Explicit loopback HTTP origins
  are admitted for local development and tests.
- Generated payment mutations require a linked authenticated user by default.
  Anonymous one-time Checkout requires a deliberate Capsule change and must not
  grant Customer Portal or Team billing authority.
- Capsule code owns customer association, product selection, Team ownership,
  billing-holder authorization, subscription records, entitlements, taxes,
  refunds, retention, export, and erasure decisions.
- Outbound Stripe calls are performed by ordinary durable Jobs, not inline in
  the mutation that authorizes them. The mutation atomically records any app
  intent and enqueues the Job; dispatch begins after commit.
- The browser uses ordinary Capsule mutations and queries to begin an operation
  and observe its known Job. No Stripe-specific browser transport or direct
  client secret is introduced.
- Every provider-creating or provider-mutating Job requires a stable
  business-derived idempotency key. Keys are namespaced by Capsule identity,
  operation, and business reference and remain stable across Job attempts.
- Stripe timeouts, abort behavior, retry classification, request identities,
  and safe provider-error translation are owned by the integration module.
- The endpoint request contract retains one bounded copy of the exact received
  body bytes alongside the parsed body. Exact bytes are available only to
  server endpoint processing, are never automatically logged, and obey the
  existing request-body size limit.
- The runtime-owned Stripe callback route verifies the signature over the exact
  body bytes before parsing or dispatching an event. Invalid or malformed input
  cannot reach Capsule code.
- Callback route collision detection covers Capsule endpoints and all enabled
  runtime-owned provider routes before runtime publication.
- Each accepted Stripe Event identity atomically enqueues one Privileged Job.
  Repeated delivery returns the existing Job rather than creating another.
- A successful callback response means signature verification, bounded parsing,
  and durable Job enqueue have committed. Capsule event-processing failure is
  then governed by Job retry rather than by keeping the provider HTTP request
  open.
- Verified Stripe event Jobs run under the Privileged server role with explicit
  audit provenance. Provider event identity is provenance and idempotency input;
  it grants no Capsule user or Team authority.
- The handler receives a verified provider event rather than an HTTP request.
  Sporades does not persist raw event data outside the durable Job payload by
  default and does not create app billing tables.
- Event consumers must be idempotent and order-independent. App state
  transitions ratchet from authoritative provider state or reject stale
  observations rather than trusting callback arrival order.
- Raw event bodies, signatures, Server env, secret keys, provider authorization
  headers, full provider failures, and short-lived Checkout or Portal URLs are
  excluded from routine structured logs and safe failure metadata.
- The official Stripe server library is a direct tested runtime dependency of
  Sporades. The Bundle pipeline must inline it, preserving the rule that a
  deployed Capsule resolves no package from `node_modules` at runtime.
- Existing Capsules remain compatible because the new project configuration is
  optional and disabled when absent. Existing generated projects are not
  rewritten automatically.
- Existing non-blank example templates are not required to gain payment UI or
  domain behavior in this slice. New work derived from blank receives the
  foundation through the ordinary scaffold path.
- Canonical domain documentation must define the built-in payment foundation,
  Stripe payment configuration, Stripe payment Job, and verified Stripe event
  without redefining Capsule, Job, Privileged server role, or Database
  Transaction.
- Public runtime behavior, server declarations, generated outputs, reference
  documentation, scaffold output, CLI help, and packed package contents change
  together as one shipped contract.

## Testing Decisions

- The primary acceptance seam is a newly generated blank Capsule. Tests create
  it with the real CLI, verify it boots with payments disabled, activate its
  Stripe configuration, build its real server Bundle, and exercise payment
  behavior through the same HTTP, client transport, Database adapter, and Job
  worker surfaces used by a Dev session or Hosted Capsule.
- Tests assert observable behavior at the blank Capsule seam rather than the
  contents of generator helper functions. Internal unit tests are appropriate
  only for cryptographic verification, configuration normalization, URL
  validation, and provider error classification that cannot be diagnosed
  clearly through one end-to-end failure.
- Existing scaffold tests are prior art for exact generated project shape,
  runnable output, dependency policy, and unchanged blank behavior outside the
  newly declared payment foundation.
- Existing server-bundle module-graph tests are prior art for booting the actual
  release Bundle and proving that every non-builtin dependency is inlined.
- Existing Job Queue and Privileged Job tests are prior art for atomic enqueue,
  post-commit dispatch, stable idempotency, at-least-once retry, restart
  recovery, bounded result state, actor provenance, audit lifecycle, and
  revocation.
- Existing email-provider callback tests are prior art for runtime-owned route
  collision checks, provider verification, consolidated dispatch, opaque
  rejection, log redaction, and the separation between provider adapters and
  Capsule event consequences.
- Existing endpoint and deployment tests are prior art for bounded body reads,
  identical Dev and Container behavior, safe HTTP errors, and request-body
  non-disclosure.
- Exact-body tests send byte-distinct JSON documents with the same parsed value
  and prove that only the originally signed bytes verify. Invalid JSON,
  oversized bodies, absent signatures, wrong secrets, stale signatures, and
  modified encodings are rejected without invoking Capsule code.
- Disabled-mode tests prove a credential-free blank Capsule boots, has no Stripe
  callback route, makes no provider request, and returns a structured disabled
  result if payment wiring is invoked incorrectly.
- Activation tests prove incomplete configuration fails before runtime
  publication and does not leave a partially registered route.
- Checkout tests cover one-time and subscription modes, server-side Price
  allowlisting, linked-user defaults, explicit guest behavior, trusted redirect
  construction, narrow result shape, timeout, cancellation, retryable failure,
  permanent failure, and stable idempotency across repeated Job attempts.
- Customer Portal tests cover Capsule-owned Customer resolution, authorization,
  trusted return paths, short-lived URL handling, narrow results, and the
  absence of Portal authority for anonymous actors.
- Webhook tests cover valid verification, duplicate delivery, concurrent
  duplicate delivery, out-of-order events, unknown event types, malformed
  payloads, callback acknowledgement after durable enqueue, Job retry after
  handler failure, and no automatic persistence into app tables.
- Security tests prove browser input cannot select an arbitrary Price, customer,
  return origin, callback path, idempotency namespace, execution actor, or
  webhook event identity.
- Redaction tests scan stdout, stderr, structured runtime logs, Job failure
  state, CLI JSON, Bundles, generated source, and packed files for fixture
  secrets, signatures, raw payload markers, and short-lived URLs.
- Cross-adapter tests prove the enqueue and app-intent transaction behaves
  consistently on each supported Database adapter. Provider transport itself
  uses a protocol-faithful local fake or injected mock adapter and never calls a
  live Stripe account in the automated suite.
- Generated-contract tests prove TypeScript declarations, compiled runtime,
  generated manifests, reference documentation, CLI help, and the raw npm
  tarball all contain the same enabled, disabled, action, event, and error
  contracts.
- A release candidate is not complete merely because helper tests pass. It must
  demonstrate a generated blank Capsule reaching a successful Checkout URL, a
  successful Customer Portal URL, and one verified callback-driven Privileged
  Job through the bundled runtime.

## Out of Scope

- A dedicated Stripe or payments Capsule template.
- A general-purpose `sporades add` feature-scaffold engine.
- Automatic rewriting or migration of existing Capsule source trees.
- Payment Intents, Elements, or Capsule-hosted card-entry UI.
- Stripe Connect, marketplaces, destination charges, transfers, or connected
  account onboarding.
- Refund, dispute, payout, credit-note, quote, invoice-creation, or tax-return
  workflows.
- Automatic Product, Price, Coupon, Promotion Code, Customer, or Customer Portal
  configuration creation in a Stripe account.
- Automatic Stripe webhook registration, deletion, or reconciliation at Capsule
  startup.
- A generic Stripe request method or exposure of the complete Stripe SDK through
  Capsule context.
- A Sporades-owned Customer, subscription, invoice, entitlement, order, billing
  holder, or seat model.
- Capsule-specific Team subscription policy, seat proration rules, access
  transitions, notification copy, export, erasure, or retention behavior.
- Direct subscription quantity mutation in the first release. It may follow as
  a separately reviewed narrow Job operation when repeated Capsule demand is
  demonstrated.
- Retrofitting payment UI into every existing demonstration template.
- Live Stripe calls in the automated test suite.

## Further Notes

- “Built-in” means present, documented, and ready to configure; it does not mean
  silently enabled or authorized.
- Stripe-hosted Checkout is preferred over lower-level Payment Intents for the
  first release because it covers the common one-time and subscription cases
  with less Capsule-owned payment state.
- Customer Portal is preferred over app-owned billing-management mutations for
  ordinary customer changes. Capsule policy still decides who receives a
  Portal session.
- Stripe event delivery is asynchronous, duplicated, and potentially
  out-of-order. The durable Job is the delivery mechanism, not proof that a
  particular billing or entitlement transition is safe.
- External callback registration remains an explicit operator action. Runtime
  startup validates local configuration but must not mutate the Stripe account.
- The implementation should reuse the established provider-adapter,
  consolidated-dispatcher, Privileged execution, Sealed Server env, and Job
  Queue patterns rather than creating a parallel payment runtime.
