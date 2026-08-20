# 06 — Admit signed Stripe callbacks into one Privileged Job

**What to build:** Let an enabled runtime-owned Stripe callback route verify the exact request bytes, reject unsafe input opaquely, and atomically enqueue exactly one Privileged Job for each accepted Stripe Event identity so provider retries never duplicate durable work.

**Blocked by:** 01 — Preserve exact bounded Custom endpoint body bytes; 03 — Start one-time Checkout through a durable Job.

**Status:** complete

- [x] Stripe activation can enable one runtime-owned callback path whose configuration uses a Sealed Server env signing-secret reference.
- [x] Disabled Stripe configuration registers no callback route, and incomplete enabled callback configuration fails before runtime publication.
- [x] The callback path is a validated same-origin absolute path outside reserved runtime HTTP namespaces.
- [x] Runtime startup rejects method-and-path collisions between the Stripe callback, Capsule Custom endpoints, and every other enabled runtime-owned provider route.
- [x] Signature verification uses the exact bounded body bytes and the Stripe signature header before parsing or dispatching any event.
- [x] Byte changes, whitespace changes, key reordering, wrong secrets, absent signatures, malformed signatures, stale signed timestamps, invalid JSON, and oversized bodies cannot reach durable or Capsule event processing.
- [x] Rejection responses are bounded and opaque and do not reveal the signing secret, expected signature, raw body, parsing details, or provider-library diagnostics.
- [x] A verified payload is parsed into a bounded Stripe Event representation with stable event identity, type, provider creation time, live/test mode, relevant object identity, and the verified raw provider value required for forward compatibility.
- [x] Unsupported but structurally valid Stripe event types can be durably admitted without being mistaken for malformed input.
- [x] Each accepted event atomically enqueues a Job running as the Privileged server role with an idempotency identity derived from Capsule and Stripe Event identity.
- [x] Repeated and concurrently repeated delivery of the same Stripe Event returns or acknowledges the same durable Job rather than creating another Job or execution actor.
- [x] A successful HTTP acknowledgement is sent only after signature verification, bounded parsing, and durable enqueue commit.
- [x] Callback processing does not wait for Capsule event consequences, so later handler retry does not hold the Stripe HTTP request open.
- [x] Event identity records provenance and idempotency but grants no Sporades user, Session, Team membership, Capsule role, or browser authority.
- [x] Raw callback bytes, signatures, secrets, provider authorization headers, complete provider errors, and short-lived URLs do not appear in routine logs, HTTP diagnostics, Job failure summaries, CLI JSON, or browser state.
- [x] Protocol-faithful tests prove valid admission, exact-byte verification, opaque failure, collision rejection, duplicate concurrency, transaction rollback, and acknowledgement ordering through the real runtime HTTP and Job seams.
- [x] Public configuration, runtime behavior, declarations, canonical webhook documentation, and generated artifacts agree on the callback admission contract.
