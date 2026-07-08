# Document audit contract and update roadmap

Status: done

## Parent

`.scratch/privileged-audit-event-contract/PRD.md`

## What to build

Document the implemented Privileged audit event contract and update planning
state once the core event envelope and Sporades-controlled SSH audit events are
implemented. The documentation should explain the event vocabulary, required
fields, redaction boundaries, inspection surfaces, SSH coverage boundary,
security-officer use cases, and relationship to future Privileged server role,
Job queue, Job scheduling, centralized JSON logging, and real SSH session
capture work.

User stories covered: 16-17, 23-32.

## Acceptance criteria

- [ ] Product docs describe the Privileged audit event contract as a narrow structured JSONL audit surface rather than a new audit database or centralized logging release.
- [ ] Docs list the required event fields, actor kinds, outcome vocabulary, redaction rules, and payload-cap expectations.
- [ ] Docs show how audit events are inspected through existing log surfaces such as `sporades logs --json`, `sporades logs tail --json`, and Hosted Capsule log paths where applicable.
- [ ] Docs explain that app `ctx.log` cannot forge Privileged audit events and that browser/client credentials do not carry privileged authority.
- [ ] Docs explain SSH audit coverage: Sporades-controlled config/lifecycle/inspection events are implemented, while real login/session capture remains separate unless the scanner spike has landed.
- [ ] Docs capture the security-officer use cases for incident timelines, outcome review, anti-forgery boundaries, and redacted evidence.
- [ ] `docs/ROADMAP.md` is updated according to the Promotion Rule after the feature is implemented and documented.
- [ ] Docs tests or focused checks prevent stale roadmap/PRD claims from drifting after implementation.

## Blocked by

- `.scratch/privileged-audit-event-contract/issues/01-define-and-emit-privileged-audit-event-envelope.md`
- `.scratch/privileged-audit-event-contract/issues/02-audit-ssh-lifecycle-and-inspection-events.md`
