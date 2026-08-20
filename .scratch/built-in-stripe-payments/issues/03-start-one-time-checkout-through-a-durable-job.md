# 03 — Start one-time Checkout through a durable Job

**What to build:** Let an activated blank Capsule authorize a customer, map a public product choice to a server-owned Stripe Price, atomically enqueue an idempotent payment Job, create a Stripe-hosted one-time Checkout outside the originating Database Transaction, and expose bounded progress plus a validated redirect URL through ordinary Capsule behavior.

**Blocked by:** 02 — Build the dormant blank-Capsule payment foundation.

**Status:** ready-for-agent

- [ ] Explicit Stripe activation validates the complete provider configuration before runtime publication and fails closed when required Server env references, credentials, origins, or compatibility settings are absent or malformed.
- [ ] Stripe secret material is read only from Sealed Server env and never appears in project configuration, generated source, browser state, Bundles, routine logs, or safe failures.
- [ ] The generated start-Checkout mutation requires a linked authenticated user by default and leaves further Capsule and Team billing authorization to an explicit Capsule policy seam.
- [ ] Browser input selects a Capsule-defined product key; only server-owned code can map that key to an allowlisted Stripe Price and quantity.
- [ ] Unknown products, invalid quantities, browser-supplied provider identifiers, and unauthorized actors fail before a payment Job is enqueued.
- [ ] The mutation atomically commits any Capsule payment intent and the Job enqueue, and Job dispatch begins only after that Database Transaction commits.
- [ ] The Job performs Stripe network I/O outside the originating mutation's Database Transaction.
- [ ] Every Checkout request uses a stable business-derived idempotency key namespaced by Capsule identity, operation, actor or business subject, and intent; repeated mutation calls and Job attempts cannot create duplicate Checkout Sessions.
- [ ] The provider adapter creates a Stripe-hosted Checkout Session in one-time payment mode and returns only a safe Checkout identity and short-lived redirect URL.
- [ ] Success and cancellation locations are same-origin absolute paths resolved against a trusted configured public Capsule origin rather than an incoming Host header.
- [ ] Hosted public origins require HTTPS, while explicit loopback HTTP origins remain available for Dev-session testing.
- [ ] The returned URL is accepted only when it is a valid Stripe-hosted Checkout URL; malformed or unexpected provider URLs fail safely without navigating the browser.
- [ ] An ordinary Capsule query lets the initiating actor inspect bounded state for the exact known Job without gaining a general browser Job Queue interface.
- [ ] The browser can distinguish pending, succeeded, and safely failed Checkout state and redirects only after observing a successful validated URL.
- [ ] Transient timeouts and provider failures follow bounded Job retry, while permanent rejection becomes bounded redacted Job failure metadata.
- [ ] Anonymous one-time Checkout is possible only through an explicit documented Capsule opt-in with a server-derived business reference; it remains disabled in the generated default and grants no Customer Portal or Team billing authority.
- [ ] A protocol-faithful local provider fake proves success, retry, idempotency, timeout, cancellation, safe failure, Price allowlisting, authorization, and redirect validation without contacting a live Stripe account.
- [ ] The real server Bundle completely inlines the Stripe dependency and resolves no package from `node_modules` at Capsule runtime.
- [ ] Public declarations, generated blank output, canonical payment guidance, Job inspection behavior, and focused end-to-end tests agree on the one-time Checkout contract.
