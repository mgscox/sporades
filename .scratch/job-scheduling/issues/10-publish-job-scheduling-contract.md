# 10 — Publish The Job Scheduling Contract

**What to build:** Publish one consistent Capsule-author, operator, and maintainer contract for recurring Job scheduling and mark the roadmap feature implemented once every prior slice is complete.

Status: done

## Parent

.scratch/job-scheduling/PRD.md

## Blocked by

.scratch/job-scheduling/issues/09-extend-inspection-to-container-and-hosted-capsules.md

- [ ] Public server API docs and generated declarations describe schedule authoring, five-field cron restrictions, payload and retry behavior, and server-only authority.
- [ ] User guidance explains IANA timezone and daylight-saving behavior, `skip` and `latest` missed-run policies, restart recovery, declaration changes, and duplicate protection.
- [ ] Docs distinguish one-time Job Queue `availableAt` from recurring Job scheduling.
- [ ] Docs state that scheduled Jobs execute as the Privileged server role and retain Job Queue at-least-once attempt semantics.
- [ ] Dev, Container, and Hosted schedule inspection commands and their JSON-only contract are documented.
- [ ] The domain glossary defines any accepted scheduling terms without implementation details.
- [ ] The PRD and source planning marker remain available for traceability, and the roadmap moves Job scheduling from `ready` to implemented.
- [ ] Documentation, type, and generated-runtime parity tests keep the published contract synchronized.
