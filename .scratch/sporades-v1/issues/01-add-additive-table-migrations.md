# Add additive table migrations

Status: done

## What to build

Implement the first incremental migration path for Capsules: when a developer adds a new table to the schema, Sporades should update the existing SQLite database without dropping existing app tables or losing data. The Dev session and Container session should both use the same migration behavior during Capsule startup.

## Acceptance criteria

- [x] Starting a Capsule with an added table creates that table while preserving existing tables and rows.
- [x] The system table records enough migration/schema metadata for Sporades to distinguish unchanged schemas from additive table changes.
- [x] The new table includes Sporades-managed `id`, `createdAt`, and `updatedAt` fields.
- [x] Queries and mutations can use the newly added table immediately after startup.
- [x] Unsupported schema changes still fail with a structured error and actionable hint instead of silently dropping data.
- [x] The behavior is covered for both Dev session startup and Container session startup.

## Blocked by

None - can start immediately
