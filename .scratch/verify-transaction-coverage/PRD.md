# Verify Transaction Coverage For Every DB Write

Status: ready-for-agent

## Overview

Audit and harden transaction coverage for every Sporades-owned database write
path. The goal is not to move every single statement into a transaction by
habit, but to make the intended transaction boundary explicit for app-table
writes, runtime-owned auth and preference writes, file metadata writes, schema
and system metadata writes, log index writes, and hosted-runtime write paths
where they touch database-backed state.

When a workflow performs multiple related database writes, or combines a
database write with hook, ACL, file-storage, or session behavior that depends on
atomicity, the workflow must use the Database adapter transaction primitive and
prove rollback behavior with tests. Single-statement writes may remain outside a
transaction only when the implementation records why that is intentional and the
failure mode is already atomic at the database layer.

## Source Planning

- `docs/ROADMAP.md` (Data And Auth Helpers: "Verify transaction coverage for every DB write")
- `docs/adr/0021-database-adapter-is-internal-runtime-boundary.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `docs/adr/0026-database-writes-use-intended-transaction-boundaries.md`
- `.scratch/database-adapter/PRD.md`
- `.scratch/database-and-storage-acl-rules/issues/03-apply-write-acl-transactions.md`

## Scope

- Inventory all SQL-backed write paths exposed through the internal Database
  adapter, including app tables, schema migrations, auth storage, user
  preferences, file metadata, file upload bookkeeping, public file URLs, log
  index storage, and system/schema metadata.
- Verify that mutation handlers, before/after mutation hooks, ACL write checks,
  and pending ACL writes share one mutation transaction and roll back together
  on failure.
- Verify runtime-owned write workflows whose correctness depends on multiple
  writes or read-modify-write behavior, especially sign-up/sign-in/linking,
  OAuth state consumption, session rotation, current-user preference updates,
  pending file uploads, upload completion, public URL revocation, and file
  deletion.
- Verify schema and metadata migration paths that rewrite or backfill data use
  adapter-owned transaction primitives where rollback is required.
- Capture intentional exceptions for single-statement writes and non-database
  Host server registry writes so future work does not mistake them for missed
  transaction coverage.
- Update `docs/ROADMAP.md` when the audit and any promoted fixes are complete.

## Non-Goals

- Do not introduce a public Database adapter API.
- Do not replace the existing Database adapter abstraction.
- Do not redesign Host server JSON registry locking or atomic file writes unless
  the audit finds that they incorrectly touch database-backed state.
- Do not make read-only inspection paths transactional.
- Do not implement a Log index retry queue in this feature; that remains a
  roadmap enhancement.
- Do not add broad distributed transaction semantics between file bytes and
  database metadata. Where file-storage side effects cannot be atomic with the
  database, document and test the compensating behavior.

## Product Decisions

- The Database adapter owns transaction primitives for both SQLite and
  service-backed SQLite-compatible adapters.
- App mutation execution is the primary transaction boundary for Capsule-defined
  app-table writes, mutation hooks, ACL checks, and pending ACL writes.
- Runtime-owned multi-write workflows should enter transactions at the workflow
  level rather than relying on individual adapter helper calls to decide
  atomicity.
- File upload completion may require compensating file-byte cleanup outside the
  database transaction model; the database metadata writes still need an
  explicit intended boundary.
- Single-statement writes are acceptable only when the audit names them and
  their atomicity does not depend on adjacent writes.

## User Stories

- As a Capsule author, I can trust that failed mutations do not persist partial
  app-table writes, hook side effects, or ACL-approved pending writes.
- As a maintainer, I can see which Sporades-owned write workflows are
  transaction-protected and which single-statement writes are intentionally
  outside explicit transactions.
- As a future Database adapter implementer, I have regression tests that prove
  transaction behavior for SQLite and service-backed SQLite-compatible paths.
- As an operator, I can rely on auth, preferences, and file metadata workflows
  to fail cleanly without leaving half-updated runtime state.

## Acceptance Bar

- The audit produces a committed documentation artifact that names each
  runtime-owned database write family and its intended transaction boundary.
- Multi-write workflows have rollback tests at the workflow level, not just
  adapter unit tests.
- Workflow-level transaction semantics remain Database adapter-agnostic; SQLite
  and libSQL/service-backed adapter transaction mechanics remain covered at the
  adapter level, with targeted workflow coverage only for engine-specific
  findings.
- Any discovered missing transaction coverage is fixed in the same feature track
  or promoted into a follow-up issue with an explicit blocker.
- The feature is not complete while any audit row remains `requires-fix` without
  an implemented fix or an explicit deferral decision.
- The roadmap is updated after implementation so this item no longer appears as
  pending next-feature work.

## Implementation Issues

- `issues/01-audit-db-write-transaction-boundaries.md`
- `issues/02-prove-mutation-and-hook-rollback.md`
- `issues/03-harden-runtime-auth-and-preference-writes.md`
- `issues/04-harden-file-metadata-and-upload-writes.md`
- `issues/05-close-schema-metadata-and-roadmap-loop.md`
