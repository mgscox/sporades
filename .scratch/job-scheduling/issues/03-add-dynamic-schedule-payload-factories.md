# 03 — Add Dynamic Schedule Payload Factories

**What to build:** Let a Schedule calculate an ordinary JSON-safe Job payload at occurrence time through a bounded synchronous or asynchronous factory with immutable occurrence metadata, cooperative cancellation, and optional explicit Privileged server role access.

**Blocked by:** 02 — Declare And Run A Static Recurring Privileged Job.

**Status:** ready-for-agent

- [ ] A Schedule payload factory may return synchronously or asynchronously; Sporades awaits and validates the resolved JSON-safe value before ordinary enqueue.
- [ ] The factory receives only `{ scheduleName, scheduledFor }` plus scheduling context containing `signal` and the lazy `privileged` accessor, without internal occurrence IDs, claims, or queue state.
- [ ] Payload calculation alone emits no Privileged audit event; explicitly entering `ctx.privileged.run(...)` retains the existing audit contract.
- [ ] Factories are documented as dynamic data-population hooks rather than state-mutation hooks, may run more than once during recovery, and make any privileged side effects the author's responsibility.
- [ ] A throw, rejected promise, invalid resolved value, or timeout logs bounded safe failure metadata, creates no Job, does not retry that occurrence, and moves to the next occurrence.
- [ ] `scheduling.payloadFactoryTimeoutSeconds` in `sporades.json` defaults to 30 and accepts finite positive integers from 1 through 300, with no per-Schedule override.
- [ ] Factory context exposes an `AbortSignal` aborted on timeout; eventual results are discarded, no late Job is created, and docs warn that cancellation cannot undo author side effects.
- [ ] Factories for different Schedules run under a fixed concurrency limit of four, while two occurrences of one Schedule never evaluate concurrently.
- [ ] Simultaneous factories begin in declaration order under the concurrency cap, without imposing Job Queue execution order.
- [ ] A slow or non-cooperative factory cannot block later occurrences or unrelated Schedules beyond the declared timeout/concurrency contract.
- [ ] Type and runtime tests cover synchronous and asynchronous success, ordinary and explicit privileged access, invalid results, throws, rejections, timeout, cancellation, configuration validation, concurrency, and generated-runtime parity.
