Status: ready-for-agent

# Extract SQLite Database Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Introduce an internal SQLite Database adapter that owns connection creation, initialization, statement execution, and lifecycle for the existing `node:sqlite` runtime path without changing externally visible behavior.

## Acceptance criteria

- [ ] The runtime opens and closes SQLite through an internal Database adapter boundary.
- [ ] Existing Dev session, Container session, and Hosted Capsule SQLite behavior is unchanged.
- [ ] Adapter construction/init owns SQLite pragmas and database file setup.
- [ ] No public plugin or app-facing API is introduced.
- [ ] Existing test coverage passes without fixture rewrites that mask behavior changes.
- [ ] Focused tests cover adapter lifecycle, query execution, and failure propagation.

## Blocked by

None - can start immediately

