# Define and emit Privileged audit event envelope

Status: done

## Parent

`.scratch/privileged-audit-event-contract/PRD.md`

## What to build

Add the runtime-owned Privileged audit event envelope on top of the existing
JSONL log stream and recent Log index behavior. The implementation should give
Sporades platform/runtime code a narrow internal way to emit structured,
redacted, bounded audit events without exposing a Capsule app API that can
forge privileged activity.

This slice should establish the stable contract for event category/name,
Capsule identity, release identity when available, actor kind, operation, call
site or API surface, correlation identity, target resource kind, outcome, safe
error code, source, and redacted metadata. It should make denial versus failure
semantics explicit and keep the broader centralized JSON logging feature out of
scope.

User stories covered: 1-17, 23-26, 28-32.

## Acceptance criteria

- [ ] Runtime/platform code can emit a Privileged audit event through the existing JSONL log stream without using app `ctx.log`.
- [ ] Audit events include the required contract fields for actor kind, operation, Capsule identity, call site/API surface, correlation identity where available, target resource kind, outcome, and safe error code where applicable.
- [ ] Actor kind distinguishes at least `privileged-server-role`, `captured-user`, `platform`, and `unknown`.
- [ ] Outcome vocabulary distinguishes at least `requested`, `allowed`, `denied`, `succeeded`, `failed`, and `skipped`, with denial and failure semantics documented in code/tests.
- [ ] Redaction and payload caps prevent raw request bodies, full authorized keys, private keys, Server env values, session tokens, cookies, authorization headers, passwords, client secrets, and raw stack traces from appearing in audit events.
- [ ] Audit events appear in `sporades logs --json` and `sporades logs tail --json` through the existing logging surfaces.
- [ ] Log index failures degrade inspection without failing the workflow that emitted the audit event.
- [ ] Tests prove the event envelope shape, redaction, payload caps, safe error codes, anti-forgery boundary, JSONL visibility, and Log index degradation behavior.

## Blocked by

None - can start immediately.
