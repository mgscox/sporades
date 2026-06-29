# Add additive table migrations

Status: ready-for-agent

## What to build

Implement the first incremental migration path for Capsules: when a developer adds a new table to the schema, Sporades should update the existing SQLite database without dropping existing app tables or losing data. The Dev session and Container session should both use the same migration behavior during Capsule startup.

## Acceptance criteria

- [ ] Starting a Capsule with an added table creates that table while preserving existing tables and rows.
- [ ] The system table records enough migration/schema metadata for Sporades to distinguish unchanged schemas from additive table changes.
- [ ] The new table includes Sporades-managed `id`, `createdAt`, and `updatedAt` fields.
- [ ] Queries and mutations can use the newly added table immediately after startup.
- [ ] Unsupported schema changes still fail with a structured error and actionable hint instead of silently dropping data.
- [ ] The behavior is covered for both Dev session startup and Container session startup.

## Blocked by

None - can start immediately
