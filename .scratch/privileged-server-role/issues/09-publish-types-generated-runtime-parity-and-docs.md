Status: ready-for-agent

# Publish Types, Generated Runtime Parity, And Docs

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Finish the public-facing and generated-surface work for the Privileged server role. Public server types, generated runtime artifacts, API docs, user guide, roadmap, and docs drift tests should all describe the same server-only contract and make the future Job Queue / Job scheduling dependency clear without implementing Jobs.

## Acceptance criteria

- [ ] Public server API types accept valid `ctx.privileged.run(...)` usage and reject client-side or ACL-context misuse.
- [ ] Generated runtime artifacts expose the same Privileged server role behavior as source runtime code.
- [ ] API docs and user guide explain when to use current user identity, future captured user identity, and Privileged server role.
- [ ] Docs state that Privileged server role is not Capsule roles, app admin authorization, Teams, a user, a session, or a browser credential.
- [ ] Roadmap and product docs are updated from design to implemented status when the feature is complete.
- [ ] Docs tests guard the privileged actor boundary, audit vocabulary, cancellation semantics, and generated/runtime parity.

## Blocked by

- .scratch/privileged-server-role/issues/01-migrate-privileged-audit-outcomes.md
- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/04-add-privileged-actor-identity-and-sentinel-guardrails.md
- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md
- .scratch/privileged-server-role/issues/06-preserve-transactions-and-audit-durability-for-privileged-db-work.md
- .scratch/privileged-server-role/issues/07-add-privileged-file-storage-access-through-existing-boundaries.md
- .scratch/privileged-server-role/issues/08-expose-privileged-run-across-trusted-server-surfaces.md
