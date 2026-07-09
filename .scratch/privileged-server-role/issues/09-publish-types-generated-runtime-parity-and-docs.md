Status: done

# Publish Types, Generated Runtime Parity, And Docs

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Finish the public-facing and generated-surface work for the Privileged server role. Public server types, generated runtime artifacts, API docs, user guide, roadmap, and docs drift tests should all describe the same server-only contract and make the future Job Queue / Job scheduling dependency clear without implementing Jobs.

## Acceptance criteria

- [x] Public server API types accept valid `ctx.privileged.run(...)` usage and reject client-side or ACL-context misuse.
- [x] Generated runtime artifacts expose the same Privileged server role behavior as source runtime code.
- [x] API docs and user guide explain when to use current user identity, future captured user identity, and Privileged server role.
- [x] Docs state that Privileged server role is not Capsule roles, app admin authorization, Teams, a user, a session, or a browser credential.
- [x] Roadmap and product docs are updated from design to implemented status when the feature is complete.
- [x] Docs tests guard the privileged actor boundary, audit vocabulary, cancellation semantics, and generated/runtime parity.

## Blocked by

- .scratch/privileged-server-role/issues/01-migrate-privileged-audit-outcomes.md
- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/04-add-privileged-actor-identity-and-sentinel-guardrails.md
- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md
- .scratch/privileged-server-role/issues/06-preserve-transactions-and-audit-durability-for-privileged-db-work.md
- .scratch/privileged-server-role/issues/07-add-privileged-file-storage-access-through-existing-boundaries.md
- .scratch/privileged-server-role/issues/08-expose-privileged-run-across-trusted-server-surfaces.md

## Verification

- Coordinator implementation with parallel worker reference: 019f4311-0486-73a1-8c23-70a2aff6b3b2
- Review: 019f4316-c063-78c3-b7ba-a791420335bf accepted after PRD implemented/future scope placement fix.
- `npm run docs:api`
- `node --test test/docs.test.js test/types.test.js`
- `npm run build`
- `npm run typecheck`
- `node ./scripts/check-generated-bin.mjs`
- `node --test test/client-runtime.test.js --test-name-pattern "browser client runtime exposes no Privileged server role authority"`
- `node --test test/database-adapter.test.js --test-name-pattern "privileged runs are available across trusted server surfaces|supported lifecycle hooks emit privileged audit events|leaked privileged table APIs|privileged file access can read"`
- `git diff --check`
