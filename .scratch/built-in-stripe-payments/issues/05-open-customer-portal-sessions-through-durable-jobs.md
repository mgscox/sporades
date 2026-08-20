# 05 — Open Customer Portal sessions through durable Jobs

**What to build:** Let an authorized linked customer request a short-lived Stripe Customer Portal session through the same durable payment Job pattern, while keeping Customer association and billing authority in Capsule policy and returning only a validated redirect URL.

**Blocked by:** 03 — Start one-time Checkout through a durable Job.

**Status:** complete

- [x] The Stripe integration exposes one narrow Customer Portal Session operation rather than a general billing or provider client.
- [x] A normal Capsule mutation authenticates a linked user and requires explicit Capsule authorization before enqueueing the Portal Job.
- [x] Capsule code resolves the authorized user or Team to an existing Stripe Customer identity; Sporades does not invent, persist, enumerate, or infer Customer ownership.
- [x] Unknown Customers, unauthorized actors, deleted Teams, and missing billing authority fail before Job enqueue without disclosing unrelated provider or Team state.
- [x] Anonymous actors cannot receive Customer Portal authority, including actors permitted to use explicit guest one-time Checkout.
- [x] Portal creation runs after the originating Database Transaction commits and uses stable namespaced idempotency across retries.
- [x] The return location is a same-origin absolute path resolved against the trusted configured public Capsule origin.
- [x] The adapter returns only a safe Portal Session identity and validated short-lived Stripe-hosted URL.
- [x] Known-Job query behavior exposes pending, successful, and safely failed Portal state only to the authorized initiating actor.
- [x] Provider timeouts, transient failures, permanent rejection, cancellation, and malformed returned URLs follow the existing bounded Job and redaction policies.
- [x] Customer Portal is documented as the preferred surface for ordinary customer-managed payment methods, invoices, cancellations, and supported subscription changes; Capsule policy still decides who may enter it.
- [x] A protocol-faithful local provider fake proves success, denial, retry, idempotency, Customer resolution, trusted return paths, and URL validation without a live Stripe account.
- [x] Generated blank output, public declarations, canonical docs, and bundled acceptance tests agree on the Portal contract.
