# Database Adapter

Status: ready-for-agent

## Overview

Introduce an internal runtime-owned Database adapter boundary below the stable Sporades DB API. The adapter translates all SQL-backed Sporades persistence into engine-specific SQL and connection behavior while keeping app code, runtime policy, and inspection surfaces agnostic to the selected database engine.

## Source Planning

- `docs/ROADMAP.md`
- `docs/adr/0021-database-adapter-is-internal-runtime-boundary.md`
- `CONTEXT.md`

## Scope

- Extract current `node:sqlite` behavior into a no-behavior-change SQLite Database adapter.
- Route app table operations, schema migrations, auth storage, file metadata storage, log index, system metadata, transactions, and inspection commands through the adapter boundary.
- Keep `ctx.db` and the Sporades DB API stable for Capsule code.
- Keep the adapter internal until at least two internal adapters prove the shape.
- Prepare for a later service-backed SQLite-compatible adapter once local Capsule service provisioning exists.

## Non-Goals

- Do not expose a public Database adapter plugin API in this release.
- Do not add Postgres or broad SQL dialect portability in the first slice.
- Do not change Capsule authoring APIs.
- Do not couple ACL rules to database-specific SQL.

## Product Decisions

- Code above the Database adapter must remain engine-agnostic.
- The adapter owns engine peculiarities, connection/init behavior, SQL dialect, transactions, schema introspection, and migration DDL.
- Runtime-owned SQL tables are part of the adapter boundary, not a separate SQLite-only path.
- The first implementation is a refactor-only SQLite adapter to isolate abstraction risk.

## User Stories

- As a Capsule author, I can keep using `ctx.db` unchanged while Sporades changes persistence internals.
- As a maintainer, I can extract SQLite behavior behind a clean boundary without changing runtime behavior.
- As a future implementer, I have a single boundary where service-backed database behavior can be added.

## Implementation Issues

- `issues/01-extract-sqlite-database-adapter.md`
- `issues/02-route-app-tables-and-migrations-through-adapter.md`
- `issues/03-route-runtime-storage-through-adapter.md`
- `issues/04-route-inspection-and-transactions-through-adapter.md`
- `issues/05-spike-service-backed-sqlite-compatible-adapter.md`

