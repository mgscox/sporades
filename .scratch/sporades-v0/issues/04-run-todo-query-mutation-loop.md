# Run a todo query/mutation loop over WebSocket

Status: done

## What to build

Implement the first true full-stack data path for the scaffold: the client can add a todo, the server mutation persists it in SQLite through the table API, and subscribed query results are delivered back over WebSocket. This should establish the capsule runtime shape for schema registration, field builders, auto fields, row cache invalidation, and the client transport.

## Acceptance criteria

- [ ] `capsule()` registers a schema containing a todo table using `String()` and `Boolean()` field builders.
- [ ] The SQLite database contains Sporades-managed system metadata plus the todo table with automatic `id`, `createdAt`, and `updatedAt` fields.
- [ ] The table API supports the minimum read/write path needed by the todo scaffold: insert, where, orderBy, all, and update/delete if the scaffold exposes completion/removal.
- [ ] A client mutation can add a todo over WebSocket and receives a correlated success or structured error response.
- [ ] A client query subscription receives todo results and refreshes when mutations change the underlying data.
- [ ] Boolean values are serialized to SQLite and deserialized back to JavaScript booleans without exposing `0`/`1` to app code.
- [ ] Repeated reads use a row-level cache, and writes invalidate affected rows so SQLite remains the source of truth.

## Blocked by

- .scratch/sporades-v0/issues/03-expose-logs-and-database-inspection.md
