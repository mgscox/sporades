Status: done

# Add Minimal `ctx.privileged.run(...)`

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Add the minimal context-scoped Privileged server role API for trusted Capsule server code. `ctx.privileged.run(...)` should require stable operation metadata, validate and redact synchronous structural metadata before entering the privileged path, emit the required audit boundary events, pass callback results through when audit succeeds, and preserve opaque client-visible error behavior.

## Acceptance criteria

- [ ] Trusted server handlers can call `ctx.privileged.run(...)` with required operation metadata and receive the callback result when the callback returns and audit emission succeeds.
- [ ] Missing or invalid required metadata throws before any privileged audit event, privileged context, or callback execution.
- [ ] Metadata generation is synchronous and structural, using already-known call options rather than async DB, file, storage, network, or service work before `started`.
- [ ] A returned callback emits `started`, `completed`, and `finished`; a throwing or rejecting callback emits `started`, `errored`, and `finished`.
- [ ] Public client-visible errors remain opaque and stable unless Capsule code explicitly catches and shapes a safe response.

## Blocked by

- .scratch/privileged-server-role/issues/01-migrate-privileged-audit-outcomes.md
