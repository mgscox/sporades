# Add `Number()` field support end-to-end

Status: done

## What to build

Add a first-class `Number()` field builder that works through the full Sporades path: Capsule schema registration, SQLite persistence, table API reads and writes, WebSocket transport, client hooks, database inspection, and additive field migrations.

## Acceptance criteria

- [ ] `Number()` can be imported from `sporades/server` and used in a Capsule table schema.
- [ ] Numeric values are stored in SQLite using an appropriate numeric representation and read back as JavaScript numbers.
- [ ] The table API supports inserting, updating, filtering, ordering, and returning numeric fields.
- [ ] Query subscriptions and mutation responses preserve numeric values without string coercion.
- [ ] Defaults for numeric fields work for new rows and additive field migrations.
- [ ] Invalid numeric values fail with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v1/issues/02-add-additive-field-migrations.md
