Status: ready-for-agent

# Route App Tables And Migrations Through Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Move app table creation, schema metadata, additive migrations, reference checks, query building, and mutation row operations onto the Database adapter boundary while preserving the existing Sporades DB API and Capsule behavior.

## Acceptance criteria

- [ ] App table creation and additive migrations execute through the Database adapter.
- [ ] Query, insert, update, delete, reference validation, and row serialization behavior remains compatible.
- [ ] Unsupported schema changes still produce structured errors and hints.
- [ ] `ctx.db` remains unchanged for Capsule handlers.
- [ ] Tests cover fresh schema, additive table/field migrations, unsupported changes, references, and query/mutation behavior.

## Blocked by

- .scratch/database-adapter/issues/01-extract-sqlite-database-adapter.md

