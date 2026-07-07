Status: done

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

- [x] Schema migration paths that perform multi-statement table rewrites or data backfills have transaction coverage and rollback tests.
- [x] Schema metadata writes such as `schemaVersion`, `schemaHash`, and stored schema JSON commit with the schema/data changes they describe, not before them.
- [x] System/schema metadata writes are classified as transactional or intentionally single-statement.
- [x] Log index writes and pruning are classified with their intended failure behavior.
- [x] At least one regression test proves Log index write or prune failure degrades inspection without failing or rolling back the app, auth, or file workflow that emitted the log.
- [x] The Log index retry queue roadmap candidate is referenced as future enhancement rather than implemented in this feature.
- [x] Hosted-runtime database writes are either covered or explicitly declared not applicable because Host server registry writes are JSON-file based.
- [x] `docs/ROADMAP.md` is updated when the feature is implemented so this item leaves Recommended Next Features.

## Resolution

Schema migration and schema metadata writes now share one adapter-owned
transaction, with SQLite rollback coverage proving additive table changes do
not survive a metadata write failure. Log index insert and prune failures are
best-effort after the durable JSONL log append, with regression coverage proving
inspection degrades to JSONL tail output instead of failing the emitted
workflow. The transaction audit has no remaining `requires-fix` rows, Hosted
Capsule runtime database writes are covered by the same runtime Database
adapter boundaries, and Host server registry writes remain non-database JSON
state protected by Host server locking and atomic replacement. The Log index
retry queue remains a future roadmap candidate.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md
- .scratch/verify-transaction-coverage/issues/02-prove-mutation-and-hook-rollback.md
- .scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md
- .scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md
- .scratch/verify-transaction-coverage/issues/06-verify-endpoint-and-app-message-db-write-boundaries.md
