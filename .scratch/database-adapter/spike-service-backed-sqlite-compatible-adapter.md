# Spike: Service-Backed SQLite-Compatible Adapter

Date: 2026-07-04

## Recommendation

Use **libSQL server (`sqld`)** as the first service-backed SQLite-compatible Database adapter target.

This is the conservative choice because Sporades already provisions a local
`services.database` Capsule service with `engine: "libsql"` and the
`ghcr.io/tursodatabase/libsql-server:v0.24.32` image. libSQL is also the
closest candidate to the current SQLite dialect: Turso documents libSQL as a
SQLite-compatible fork, exposes SQL over HTTP, and provides JavaScript clients
with transaction/batch APIs.

The adapter is not implementation-ready as a production drop-in yet. The
current Sporades Database adapter contract is synchronous because it was
extracted from Node's `node:sqlite` `DatabaseSync`; libSQL service clients are
HTTP/remote clients and should be treated as async. The next production slice
should first make the internal adapter boundary awaitable, then add the libSQL
adapter.

## Candidate Comparison

| Candidate | Fit | Current Sporades SQL usage | Service/deployment fit | Decision |
| --- | --- | --- | --- | --- |
| libSQL server (`sqld`) | Strongest SQLite-compatible service fit. Official docs describe libSQL as SQLite-compatible and expose HTTP/SDK access. | Expected to support current table DDL, `TEXT`/`INTEGER`/`REAL`, joins, `INSERT OR REPLACE`, `PRAGMA table_info`, `sqlite_schema`, `rowid`, `LIMIT`, and transaction semantics with minor adapter-owned handling. | Already selected by `sporades.json` service declarations and generated Compose. Dev uses `http://127.0.0.1:<port>`; Container sessions use `http://<compose-service>:8080`. | Recommend first target. |
| rqlite | Useful standalone SQLite-backed service with HTTP APIs and HA behavior. | Likely supports much of the SQL syntax, but transaction and consistency semantics are tied to Raft/write endpoints rather than a close SQLite client shape. Inspection may differ. | Not currently provisioned by Sporades services; would add orchestration choice before proving the adapter. | Defer. Consider later for HA-specific work, not first service-backed adapter. |
| dqlite | SQLite-oriented distributed database technology. | SQL compatibility is promising, but official positioning is an embeddable C library, not a ready Node HTTP database service. | Would require binding/client/server integration decisions outside current Compose substrate. | Not ready for this slice. |
| Cloud-hosted SQLite-compatible services | Potentially useful later. | Depends on provider capabilities and auth model. | Does not satisfy local-first Compose proof path; introduces hosted credentials and networking too early. | Defer. |

Sources consulted:

- Turso libSQL overview: https://docs.turso.tech/libsql
- Turso SQL over HTTP quickstart/reference: https://docs.turso.tech/sdk/http/quickstart and https://docs.turso.tech/sdk/http/reference
- Turso TypeScript client reference: https://docs.turso.tech/sdk/ts/reference
- libSQL HTTP protocol spec: https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md
- rqlite API/FAQ docs: https://rqlite.io/docs/api/api/ and https://rqlite.io/docs/faq/
- Canonical dqlite docs: https://canonical.com/dqlite

## Current Sporades SQL Surface

The current adapter proof and runtime code exercise these SQLite-shaped paths:

- Connection/setup: open database, `PRAGMA journal_mode = WAL`, health probe with `SELECT 1`.
- System metadata: `sporades` key/value table, `INSERT OR REPLACE`.
- App migrations: `CREATE TABLE IF NOT EXISTS`, `DROP TABLE`, `ALTER TABLE ... RENAME TO`, temp-table copy migration, `PRAGMA table_info`.
- App table operations: parameterized `INSERT`, `SELECT`, `UPDATE`, `DELETE`, quoted identifiers, equality filters, `ORDER BY`, `LIMIT`.
- References: existence check with `SELECT 1 ... LIMIT 1`.
- Auth storage: runtime-owned tables, joins between sessions/users/credentials, token rotation.
- File metadata: runtime-owned bucket/file/upload/public URL tables and joins.
- Log index: insert/prune/read recent events, `rowid` ordering, JSON payload text.
- Inspection: table listing through `sqlite_schema`, `PRAGMA table_info`, generic read-only `SELECT`, internal log table filtering.
- Transactions: explicit `BEGIN`, `COMMIT`, and `ROLLBACK` around mutation work.

This surface is narrow enough for a libSQL adapter without adding broad SQL
dialect portability. The adapter should own differences such as HTTP result
shape, multiple-statement execution, transaction/session handling, and
inspection metadata queries.

## Proof

Added a test-only service-backed proof:

- `test/database-adapter-service-backed-spike.test.js`
- `test/support/service-backed-sqlite-adapter.js`
- `test/support/sqlite-http-service.js`
- `test/support/sqlite-http-request.js`

The proof starts a child-process HTTP SQLite service and builds an adapter whose
`exec`/`prepare` calls cross the service boundary. It then reuses the existing
Database adapter method shape to run representative app table, auth, file
metadata, log index, transaction rollback, and inspection paths.

This deliberately does **not** add a production adapter. It proves the current
adapter shape can be exercised over a non-embedded connection, while exposing
the main production implication: real libSQL service access should be async.

## Implications

Connection:

- Dev sessions can use injected `SPORADES_SERVICE_DATABASE_URL` from the local
  readiness path.
- Container sessions can use the Compose service DNS name
  `http://sporades-<project>-database:8080`.
- Hosted Capsules need a later Host service contract before production hosted
  libSQL can be supported.

Transactions:

- Current runtime code awaits `adapter.withTransaction(...)`, but most low-level
  adapter operations are synchronous today.
- Production libSQL should use a stateful transaction/session or client batch
  API rather than sending ad hoc `BEGIN`/`COMMIT` across unrelated HTTP calls.

Migrations:

- Existing additive migrations should mostly carry over.
- The libSQL adapter should avoid assuming multi-statement `exec` behavior and
  should split or batch migration statements explicitly.

Inspection:

- `sqlite_schema`, `PRAGMA table_info`, and read-only `SELECT` paths appear
  compatible enough for the first adapter.
- The adapter must continue hiding `sporades_log_events` from generic DB
  inspection.

Deployment:

- Local Dev and Container sessions already provision and inject a libSQL service.
- Hosted Capsule orchestration remains deferred; do not expose hosted service
  adapter configuration until Host service lifecycle, persistence, backup,
  reset, and inspection are designed.

## Follow-Up Issues

- `.scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md`
- `.scratch/database-adapter/issues/07-add-libsql-service-backed-database-adapter.md`
