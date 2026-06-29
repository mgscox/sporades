# Add `Json()` field support end-to-end

Status: ready-for-agent

## What to build

Add a first-class `Json()` field builder for flexible structured values. A Capsule should be able to persist JSON-compatible data, read it back through the table API, receive it through query subscriptions, and evolve schemas with JSON fields through additive migrations.

## Acceptance criteria

- [ ] `Json()` can be imported from `sporades/server` and used in a Capsule table schema.
- [ ] JSON-compatible values are stored in SQLite and read back without losing object, array, boolean, number, string, or null values.
- [ ] The table API supports inserting, updating, and returning JSON fields.
- [ ] Query subscriptions and mutation responses preserve JSON values without exposing serialized strings to app code.
- [ ] Defaults for JSON fields work for new rows and additive field migrations.
- [ ] Non-JSON-compatible values fail with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v1/issues/02-add-additive-field-migrations.md
