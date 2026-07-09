Status: done

# Harden Privileged Run Failure And Cancellation Semantics

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Complete the failure, cancellation, and nesting semantics for `ctx.privileged.run(...)`. Audit emission is not best-effort; required audit emission failures throw. The API accepts caller-supplied `AbortSignal` input, exposes `privilegedCtx.signal`, provides a fresh non-leaking default signal when omitted, and rejects nested privileged runs.

## Acceptance criteria

- [ ] If `started` audit emission fails, no privileged context is handed out and the callback does not run.
- [ ] If callback settlement audit or `finished` audit emission fails, the thrown audit-emission error includes the original callback error or callback result as server-side structured context.
- [ ] Callback error/result context attached to audit-emission errors is not exposed in default client-visible responses.
- [ ] Already-aborted signals still produce `started`, `errored` with a stable abort safe error code, and `finished`, without executing the callback.
- [ ] Signals that abort while the callback is running do not cause runtime interruption; callback return or throw determines the audit result event before `finished`.
- [ ] If no signal is supplied, `privilegedCtx.signal` is a fresh per-run non-aborted default signal and runtime-owned listeners or bridges are cleaned up at `finished`.
- [ ] Nested `ctx.privileged.run(...)` calls are rejected before the inner callback executes.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
