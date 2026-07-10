# 09 — Extend Schedule Inspection To Container And Hosted Capsules

**What to build:** Expose the same bounded schedule inspection contract through `sporades deploy schedules` for a bound local Container session and `sporades host schedules --host <alias> --subname <name>` for one Hosted Capsule using the existing Docker and Host-helper transports.

Status: ready-for-agent

## Parent

.scratch/job-scheduling/PRD.md

## Blocked by

.scratch/job-scheduling/issues/08-inspect-dev-session-schedules-from-cli.md

- [ ] Local Container and Hosted commands return the same schedule JSON schema and structured envelope as Dev inspection.
- [ ] Each command targets its explicit runtime location and never guesses between Dev, local Container, and Hosted state.
- [ ] Container inspection invokes the shared one-shot action inside the running Container rather than reading volumes or raw database tables.
- [ ] Hosted inspection uses the Host helper and fails with upgrade guidance when the installed helper does not recognize the action.
- [ ] Missing bindings, stopped Containers, unreachable Host servers, and stopped Hosted Capsules reuse existing structured target errors.
- [ ] Fake Docker and fake SSH/Host-helper tests cover transport parity, redaction, unavailable targets, malformed state, and generated Host-helper parity.
- [ ] The normal suite requires no live Host server; a later Hosted smoke run is useful but not a completion gate.
