Status: ready-for-agent

# Close Schema Metadata And Roadmap Loop

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Finish the promoted feature by verifying schema, system metadata, and log index
write coverage, then update roadmap state. Schema migrations that rebuild or
backfill tables should use adapter-owned transactions when rollback is required;
schema metadata must not advance unless the database shape/data changes it
describes also commit. Single-statement metadata and log writes should be
classified clearly. Log index retry or queue behavior is out of scope for this
feature and remains a roadmap enhancement.

## Acceptance criteria

- [ ] Schema migration paths that perform multi-statement table rewrites or data backfills have transaction coverage and rollback tests.
- [ ] Schema metadata writes such as `schemaVersion`, `schemaHash`, and stored schema JSON commit with the schema/data changes they describe, not before them.
- [ ] System/schema metadata writes are classified as transactional or intentionally single-statement.
- [ ] Log index writes and pruning are classified with their intended failure behavior.
- [ ] At least one regression test proves Log index write or prune failure degrades inspection without failing or rolling back the app, auth, or file workflow that emitted the log.
- [ ] The Log index retry queue roadmap candidate is referenced as future enhancement rather than implemented in this feature.
- [ ] Hosted-runtime database writes are either covered or explicitly declared not applicable because Host server registry writes are JSON-file based.
- [ ] `docs/ROADMAP.md` is updated when the feature is implemented so this item leaves Recommended Next Features.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md
- .scratch/verify-transaction-coverage/issues/02-prove-mutation-and-hook-rollback.md
- .scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md
- .scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md
