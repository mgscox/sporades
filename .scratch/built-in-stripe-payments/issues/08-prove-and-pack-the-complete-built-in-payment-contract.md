# 08 — Prove and pack the complete built-in payment contract

**What to build:** Produce one immutable, reviewable Sporades candidate whose generated blank Capsule demonstrably boots with payments disabled, activates safely, reaches one-time and subscription Checkout, opens Customer Portal, and processes a verified Stripe callback through the real Bundle, Database adapter, Job worker, HTTP route, and client transport.

**Blocked by:** 04 — Extend Checkout to recurring subscriptions; 05 — Open Customer Portal sessions through durable Jobs; 07 — Deliver verified Stripe events to Capsule policy.

**Status:** ready-for-agent

- [ ] The candidate contains only the agreed payment foundation, supporting public/generated surfaces, documentation, tests, and any necessary narrow prefactoring.
- [ ] The real CLI generates a blank Capsule whose payment foundation is present, documented, disabled by default, credential-free, installable, type-safe, buildable, and runnable.
- [ ] Disabled acceptance proves no Stripe route, provider request, payment authority, secret, Customer, Price, short-lived URL, or app billing state exists implicitly.
- [ ] Enabled acceptance proves complete preflight validation and rejects partial configuration before runtime publication without leaving a route or worker armed.
- [ ] A protocol-faithful local Stripe fake proves successful linked-user one-time Checkout, explicit guest one-time Checkout, linked-user subscription Checkout, authorized Customer Portal creation, and verified callback-driven Privileged event handling.
- [ ] The acceptance flow crosses ordinary Capsule mutations and queries, atomic Job enqueue, post-commit worker execution, bounded Job observation, the runtime HTTP callback route, exact-byte verification, and the declared event handler.
- [ ] Repeated Checkout attempts, Job retries, repeated callback delivery, and concurrent duplicate callbacks prove stable business and event idempotency rather than merely asserting generated keys.
- [ ] Security acceptance proves browser input cannot choose an arbitrary Price, Customer, return origin, callback path, idempotency namespace, execution actor, event identity, Team, or billing authority.
- [ ] Failure acceptance covers missing secrets, invalid origins, wrong Price mode, unauthorized actors, provider timeout, retryable and permanent provider failures, malformed returned URLs, bad signatures, malformed payloads, handler failure, and runtime restart recovery.
- [ ] Redaction scans cover stdout, stderr, structured runtime logs, HTTP failures, Job state, CLI JSON, generated source, Bundles, documentation fixtures, and packed files for fixture secrets, signatures, raw payload markers, provider authorization, and short-lived URLs.
- [ ] Cross-adapter evidence proves payment-intent writes and Job enqueue commit or roll back together on every supported Database adapter without holding their originating Database Transaction across provider I/O.
- [ ] The server Bundle inlines the complete Stripe runtime dependency and imports nothing except Node builtins or self-contained data at Capsule runtime.
- [ ] Source, public declarations, compiled runtime, generated manifest, blank scaffold, CLI help, canonical domain and reference documentation, and focused parity tests describe the same enabled, disabled, Checkout, Portal, callback, event, Job, error, and authority contracts.
- [ ] A raw npm pack operation produces a tarball containing the reviewed integration implementation, declarations, generated outputs, dependency metadata, and documentation required by consumers.
- [ ] The packed candidate is inspected directly and booted as a consumer artifact; repository source or a dirty checkout is not substituted for shipped-runtime proof.
- [ ] The full relevant test, typecheck, build, generated-parity, documentation-build, and package gates pass, with any environmental limitation reported precisely rather than described as green.
- [ ] Independent review checks public/generated parity, exact-body handling, authorization, Team-policy separation, Privileged lifecycle, transaction boundaries, idempotency, route conflicts, URL validation, redaction, Bundle self-containment, and package contents.
- [ ] No npm publication, downstream Capsule upgrade, live Stripe call, provider-account mutation, or production activation occurs without separate explicit authorization.
