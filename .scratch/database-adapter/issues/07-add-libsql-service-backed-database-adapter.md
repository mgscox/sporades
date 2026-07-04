Status: done

# Add LibSQL Service-Backed Database Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Add the first production service-backed SQLite-compatible Database adapter using
the libSQL Capsule service already declared by `services.database` with
`engine: "libsql"`.

The adapter should connect to the server-only database service URL injected by
Dev sessions and local Container sessions, keep Capsule code on the existing
Sporades DB API, and avoid broad SQL dialect portability work.

## Acceptance criteria

- [x] Dev sessions can select the libSQL service-backed adapter when `services.database.engine` is `libsql`.
- [x] Local Container sessions can select the libSQL service-backed adapter and connect over the generated Compose network.
- [x] App table, schema migration, auth, file metadata, log index, transaction, health, and inspection paths pass against libSQL.
- [x] The adapter owns libSQL connection details, transaction/session handling, result normalization, and migration batching.
- [x] JSON output and server-only env handling do not leak service credentials.
- [x] Embedded SQLite remains the default until the service-backed adapter is explicitly selected by runtime configuration.
- [x] Docs explain the local-only service-backed database adapter behavior and Hosted Capsule limitations.

## Blocked by

- .scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md
