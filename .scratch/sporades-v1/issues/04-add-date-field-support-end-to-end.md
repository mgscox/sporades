# Add `Date()` field support end-to-end

Status: ready-for-agent

## What to build

Add a first-class `Date()` field builder so Capsules can model dates and timestamps without hand-rolled string conventions. The field should work through schema registration, SQLite persistence, table API operations, WebSocket transport, client hooks, database inspection, and additive field migrations.

## Acceptance criteria

- [ ] `Date()` can be imported from `sporades/server` and used in a Capsule table schema.
- [ ] Date values have a documented JavaScript representation and SQLite representation.
- [ ] The table API supports inserting, updating, filtering, ordering, and returning date fields.
- [ ] Query subscriptions and mutation responses preserve date values according to the documented representation.
- [ ] Defaults for date fields work for new rows and additive field migrations.
- [ ] Invalid date values fail with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v1/issues/02-add-additive-field-migrations.md
