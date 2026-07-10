# 01 — Add A Controllable Runtime Clock

**What to build:** Add an internal runtime clock and timer boundary so scheduling behavior can be exercised deterministically without changing the production-time behavior of existing runtime features.

Blocked by: None — can start immediately.

Status: ready-for-agent

- [ ] Full-runtime tests can set the current instant, advance time, and trigger due timers without sleeping or replacing global time functions.
- [ ] Production runtime behavior continues to use the real system clock and timers by default.
- [ ] Existing Job Queue delay, retry, cancellation, lease-expiry, and shutdown behavior remains externally unchanged.
- [ ] The clock boundary is internal test support and is not exposed through Capsule server or client authoring APIs.
- [ ] Focused regression tests prove existing Job Queue behavior stays green under the default clock.
