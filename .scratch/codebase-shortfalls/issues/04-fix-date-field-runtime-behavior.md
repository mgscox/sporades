# Fix Date field runtime behavior

Status: done

## What to build

Make `Date()` fields behave consistently through schema migration, mutations, queries, endpoint table filters, and database inspection. The currently failing Date-field coverage should become stable, and Date fields should preserve the documented ISO string representation while accepting JavaScript `Date` values where the table API promises to accept them.

This slice should focus on the narrow Date path rather than broad schema or handler architecture.

## Acceptance criteria

- [ ] The Date-field Dev session test passes reliably in the full test suite.
- [ ] Date defaults are applied consistently to existing rows during additive field migration.
- [ ] Nullable Date fields without defaults have the same API behavior after migration as they do in a fresh database.
- [ ] Updating and filtering Date fields through the table API preserves normalized ISO string values.
- [ ] Invalid Date values fail with structured errors and actionable hints.

## Blocked by

- .scratch/codebase-shortfalls/issues/03-build-schema-from-actual-capsule-definition.md
