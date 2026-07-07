# Add Capsule authoring posture checks

Status: ready-for-agent

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Add doctor checks that inspect the Capsule definition enough to warn about
authoring-time security posture, especially app tables or file metadata access
without declared ACL rules. The checks should be advisory only: missing ACLs
remain allow-by-default today, and doctor must not introduce a hidden policy
engine.

## Acceptance criteria

- [ ] Doctor can load or inspect Capsule schema metadata through an existing safe bundle/runtime path.
- [ ] Doctor warns for app tables that have no declared ACL rules.
- [ ] Doctor distinguishes missing read ACLs, missing write ACLs, and wholly missing ACL declarations where the metadata supports it.
- [ ] Doctor warning text explicitly says missing ACLs are not deny-by-default today.
- [ ] Doctor does not inspect runtime-owned auth, system metadata, logs, or raw storage tables through normal ACL helpers.
- [ ] Doctor does not evaluate arbitrary ACL policy outcomes against live user data.
- [ ] Tests cover a Capsule with no ACLs, partial ACL rules, complete ACL rules, and a load failure with an actionable hint.

## Blocked by

- .scratch/sporades-doctor/issues/01-define-doctor-command-and-check-envelope.md

