# Add additive field migrations

Status: ready-for-agent

## What to build

Extend incremental migrations so a developer can add a new field to an existing table without losing existing rows. Existing data should remain queryable, and the added field should behave consistently through the table API, WebSocket query subscriptions, mutations, and database inspection.

## Acceptance criteria

- [ ] Starting a Capsule with an added field updates the existing SQLite table without dropping rows.
- [ ] Added fields with defaults populate existing rows consistently with the field builder's default behavior.
- [ ] Added fields without defaults have a clear nullable or structured-error behavior documented by the implementation.
- [ ] Query subscriptions return the added field in result rows after migration.
- [ ] Mutations can insert and update values for the added field after migration.
- [ ] Unsupported field changes still fail with a structured error and actionable hint instead of silently corrupting or dropping data.

## Blocked by

- .scratch/sporades-v1/issues/01-add-additive-table-migrations.md
