# 08 — Prove and pack the complete built-in payment contract

**What to build:** Produce one immutable, reviewable Sporades candidate whose generated blank Capsule demonstrably boots with payments disabled, activates safely, reaches one-time and subscription Checkout, opens Customer Portal, and processes a verified Stripe callback through the real Bundle, Database adapter, Job worker, HTTP route, and client transport.

**Blocked by:** 04 — Extend Checkout to recurring subscriptions; 05 — Open Customer Portal sessions through durable Jobs; 07 — Deliver verified Stripe events to Capsule policy.

**Status:** complete

- [x] The candidate contains only the agreed payment foundation, supporting public/generated surfaces, documentation, tests, and any necessary narrow prefactoring.
- [x] The real CLI generates a blank Capsule whose payment foundation is present, documented, disabled by default, credential-free, installable, type-safe, buildable, and runnable.
- [x] Disabled acceptance proves no Stripe route, provider request, payment authority, secret, Customer, Price, short-lived URL, or app billing state exists implicitly.
- [x] Enabled acceptance proves complete preflight validation and rejects partial configuration before runtime publication without leaving a route or worker armed.
- [x] A protocol-faithful local Stripe fake proves successful linked-user one-time Checkout, explicit guest one-time Checkout, linked-user subscription Checkout, authorized Customer Portal creation, and verified callback-driven Privileged event handling.
- [x] The acceptance flow crosses ordinary Capsule mutations and queries, atomic Job enqueue, post-commit worker execution, bounded Job observation, the runtime HTTP callback route, exact-byte verification, and the declared event handler.
- [x] Repeated Checkout attempts, Job retries, repeated callback delivery, and concurrent duplicate callbacks prove stable business and event idempotency rather than merely asserting generated keys.
- [x] Security acceptance proves browser input cannot choose an arbitrary Price, Customer, return origin, callback path, idempotency namespace, execution actor, event identity, Team, or billing authority.
- [x] Failure acceptance covers missing secrets, invalid origins, wrong Price mode, unauthorized actors, provider timeout, retryable and permanent provider failures, malformed returned URLs, bad signatures, malformed payloads, handler failure, and runtime restart recovery.
- [x] Redaction scans cover stdout, stderr, structured runtime logs, HTTP failures, Job state, CLI JSON, generated source, Bundles, documentation fixtures, and packed files for fixture secrets, signatures, raw payload markers, provider authorization, and short-lived URLs.
- [x] Cross-adapter evidence proves payment-intent writes and Job enqueue commit or roll back together on every supported Database adapter without holding their originating Database Transaction across provider I/O.
- [x] The server Bundle inlines the complete Stripe runtime dependency and imports nothing except Node builtins or self-contained data at Capsule runtime.
- [x] Source, public declarations, compiled runtime, generated manifest, blank scaffold, CLI help, canonical domain and reference documentation, and focused parity tests describe the same enabled, disabled, Checkout, Portal, callback, event, Job, error, and authority contracts.
- [x] A raw npm pack operation produces a tarball containing the reviewed integration implementation, declarations, generated outputs, dependency metadata, and documentation required by consumers.
- [x] The packed candidate is inspected directly and booted as a consumer artifact; repository source or a dirty checkout is not substituted for shipped-runtime proof.
- [x] The full relevant test, typecheck, build, generated-parity, documentation-build, and package gates pass, with any environmental limitation reported precisely rather than described as green.
- [x] Independent review checks public/generated parity, exact-body handling, authorization, Team-policy separation, Privileged lifecycle, transaction boundaries, idempotency, route conflicts, URL validation, redaction, Bundle self-containment, and package contents.
- [x] No npm publication, downstream Capsule upgrade, live Stripe call, provider-account mutation, or production activation occurs without separate explicit authorization.

**Release-gate limitation (2026-08-21):** The first whole-repository run
reported 1,874 tests: 1,836 passed, 37 skipped, and one failed. The failure was
`test/runtime-clock.test.js`, whose setup had not initialized the full runtime
before advancing its Job timers. This candidate adds the missing
`await database.init()`; the corrected clock test passes in isolation. A
post-fix whole-repository rerun was not a valid green result: it overlapped an
independent release verifier from another checkout, then the sandbox denied npm
log-directory writes and localhost binding, causing a broad sub-second
Dev/Container failure cluster and retained esbuild handles. That run was
interrupted after its cases had emitted. After the external verifier finished,
the packed dormant and packed activated consumer acceptances passed serially
with the required local permissions (2/2), the SQLite/libSQL/Postgres payment
transaction plus corrected clock proofs passed (4/4), the focused payment suite
passed (78/78), and typecheck, build, generated-bin parity, documentation API,
and documentation build gates passed. No post-fix whole-repository invocation
is described as green.
