# Add `Reference()` field support end-to-end

Status: done

## What to build

Add a first-class `Reference()` field builder so Capsules can model relationships between tables. The field should store references consistently, validate them where practical, and work through the table API, WebSocket query subscriptions, database inspection, and additive migrations.

## Acceptance criteria

- [x] `Reference()` can be imported from `sporades/server` and used to reference another Capsule table.
- [x] Reference values are stored in SQLite using the referenced row's Sporades-managed `id`.
- [x] The table API supports inserting, updating, filtering, ordering, and returning reference fields.
- [x] Query subscriptions and mutation responses return reference values without exposing SQLite implementation details.
- [x] Additive migrations can add a reference field to an existing table.
- [x] Invalid references fail with structured errors and actionable hints where validation is possible.

## Blocked by

- .scratch/sporades-v1/issues/01-add-additive-table-migrations.md
- .scratch/sporades-v1/issues/02-add-additive-field-migrations.md
