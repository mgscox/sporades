Status: ready-for-agent

# Audit DB Write Transaction Boundaries

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Create a committed audit artifact, such as
`.scratch/verify-transaction-coverage/transaction-boundary-audit.md`, covering
every Sporades-owned database write family and its intended transaction
boundary. The audit should cover Database adapter helper writes, app-table
writes, schema/system metadata writes, auth writes, user preference writes, file
metadata writes, file upload bookkeeping, public file URL writes, log index
writes, and hosted-runtime database writes where applicable. Single-statement
writes may be recorded as intentionally atomic, but multi-write workflows must
point to an explicit transaction or a follow-up fix.
Use `CONTEXT.md` and
`docs/adr/0026-database-writes-use-intended-transaction-boundaries.md` as the
canonical language for Transaction boundaries, Mutation transactions, Auth
transactions, Preference transactions, File metadata transactions, Log index
behavior, and Host server registry exclusions. Classify each write family with a
fixed status vocabulary: `transactional`, `single-statement`, `non-db-state`,
`non-fatal-index`, or `requires-fix`.

## Acceptance criteria

- [ ] The audit names each runtime-owned database write family and classifies it as transactional, intentionally single-statement, or requiring a fix.
- [ ] The audit is committed as a readable markdown artifact under `.scratch/verify-transaction-coverage/`.
- [ ] Every audit row uses one of `transactional`, `single-statement`, `non-db-state`, `non-fatal-index`, or `requires-fix`.
- [ ] The audit cites the Transaction boundary glossary and ADR 0026 as the policy source instead of redefining transaction semantics.
- [ ] The audit distinguishes database-backed writes from Host server JSON registry writes that use file locking and atomic renames instead of DB transactions.
- [ ] SQLite and service-backed SQLite-compatible adapter transaction primitives are included in the audit without requiring every workflow test to run against every engine.
- [ ] Any write path that cannot be confidently classified or is classified `requires-fix` is promoted into a concrete linked follow-up issue before this issue is marked done.

## Blocked by

None - can start immediately
