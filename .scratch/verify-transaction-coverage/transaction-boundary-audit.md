# Transaction Boundary Audit

## Policy Sources

This audit uses the Transaction boundary language from `CONTEXT.md` and the
policy recorded in
`docs/adr/0026-database-writes-use-intended-transaction-boundaries.md`.

The audit classifies runtime-owned write families by intended boundary. It does
not redefine transaction semantics: multi-write workflows that must succeed or
fail as one unit need Database adapter transactions, single-statement writes may
remain intentionally database-atomic, Log index failures degrade inspection, and
Host server registry writes are non-database state protected by Host server
locking and atomic replacement.

Valid status values are:

- `transactional`
- `single-statement`
- `non-db-state`
- `non-fatal-index`
- `requires-fix`

## Summary

| Write family | Status | Intended boundary | Follow-up |
| --- | --- | --- | --- |
| Database adapter transaction primitives | `transactional` | SQLite and service-backed SQLite-compatible adapters expose `withTransaction(...)`; workflow tests should stay engine-agnostic unless the audit finds engine-specific behavior. | Covered by adapter tests and Issue 05 closeout checks. |
| App mutation execution | `transactional` | Custom mutations, generated mutations, mutation hooks, ACL write checks, and pending ACL writes share one Mutation transaction and roll back together. | Verified by Issue 02 runtime-facing mutation coverage. |
| App table single-row helper writes | `single-statement` | Direct insert, update, and delete helpers are individual SQL writes; they are safe only when called inside the workflow boundary that owns atomicity. | Issue 02 verifies mutation-level usage. |
| Schema table creation and additive field migrations | `transactional` | Schema/data changes and schema metadata commit as one schema migration outcome when multiple statements are involved. SQLite rollback coverage proves additive table changes do not survive metadata failure; service-backed adapters use the same adapter transaction boundary. | Verified by Issue 05. |
| Schema/system metadata writes | `transactional` | `schemaVersion`, `schemaHash`, and stored schema JSON are written inside the schema migration transaction so metadata does not advance unless the schema/data changes it describes also commit. Individual `writeSystemMetadata` helper calls remain single-statement when used outside a schema workflow. | Verified by Issue 05. |
| Runtime auth storage setup | `transactional` | Auth table creation and lifecycle-column backfills are startup schema work owned by the Database adapter path. | Issue 03 verifies auth workflow outcomes; Issue 05 verifies schema metadata behavior. |
| Auth user insert/profile/link helper writes | `single-statement` | `insertAuthUser`, `updateAuthUserProfile`, and `linkAuthUser` are individual SQL writes; workflows that pair them with credentials, Sessions, OAuth state, or preferences own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| Auth Session insert/delete/refresh/rotate helper writes | `single-statement` | Session helper writes are individual SQL writes; rotation workflows that pair Session changes with preference migration or auth state changes own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| Email credential insertion | `single-statement` | `insertEmailCredential` is one credential row write; sign-up workflows that pair it with user and Session writes own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| OAuth state insertion | `single-statement` | Creating an OAuth state row is one SQL insert. | Issue 03 verifies OAuth callback outcomes. |
| OAuth state consumption | `single-statement` | Consuming OAuth state is intentionally spent before downstream callback work, so callback failure requires restarting the OAuth flow rather than replaying the same state. | Verified by Issue 03. |
| Anonymous session creation | `transactional` | Creating a fresh Anonymous session inserts both an auth user and a Session token inside one Auth transaction. | Verified by Issue 03. |
| Local identity simulation | `transactional` | Local identity simulation updates or inserts an auth user and inserts a Session token inside one Auth transaction. | Verified by Issue 03. |
| Email sign-up | `transactional` | User, email credential, and Session token creation use one Auth transaction; a failed sign-up leaves no usable partial auth state. | Verified by Issue 03. |
| Email sign-in and Session token rotation | `transactional` | Session rotation uses one Auth transaction so failed rotation leaves the old Session token valid and does not expose a new token. | Verified by Issue 03. |
| Provider linking and OAuth callback handling | `transactional` | Provider link and user/session updates use one Auth transaction; OAuth state consumption remains intentionally spent before callback work so failed callbacks restart the flow. | Verified by Issue 03. |
| Sign-out, Session refresh, and expired-token cleanup | `single-statement` | Deleting one Session token or refreshing one Session expiry is intentionally database-atomic when not paired with other auth writes. | Issue 03 verifies user-visible auth outcomes. |
| Current-user preference storage setup | `transactional` | Preference table creation is Database-adapter-owned startup schema work and must remain available on SQLite and service-backed SQLite-compatible adapters. | Issue 03 verifies runtime-facing preference behavior. |
| Current-user preference save helper write | `single-statement` | `saveUserPreferences` is one upsert row write; read-modify-write preference workflows own the Preference transaction. | Issue 03 verifies workflow-level usage. |
| Current-user preference updates | `transactional` | Preference updates read current state, validate the patch, save the next JSON, and report/broadcast only committed state inside a Preference transaction. | Issue 03 adds rollback coverage for failed saves. |
| Anonymous preference migration | `transactional` | Moving Anonymous session preferences to a linked or signed-in user reads source/target preferences and saves the merged target inside a transaction. | Issue 03 verifies auth-linked preference outcomes. |
| Custom endpoint app-table writes | `transactional` | Custom endpoint handler execution uses one Database adapter transaction for `ctx.db` app-table work. Multi-write handler failures roll back together; single-statement endpoint writes remain intentionally database-atomic when no adjacent write depends on shared atomicity. | Verified by Issue 06 runtime-facing endpoint coverage. |
| App message handler app-table writes | `transactional` | App message handler execution uses one Database adapter transaction for mutation-style `ctx.db` app-table work. Multi-write handler failures roll back together; single-statement App message writes remain intentionally database-atomic when no adjacent write depends on shared atomicity. | Verified by Issue 06 runtime-facing App message coverage. |
| File storage table setup | `transactional` | File metadata table setup is Database-adapter-owned startup schema work. | Issue 04 verifies file workflow outcomes. |
| File bucket creation | `single-statement` | Creating one File bucket is an individual SQL write unless paired with upload/file metadata changes by a workflow. | Issue 04 verifies paired file metadata behavior. |
| Pending upload creation | `transactional` | Path lock lookup, stale pending upload cleanup, bucket/file metadata setup, and pending upload insertion are one File metadata transaction. | Covered by Issue 04 rollback tests. |
| Upload completion and replacement | `transactional` | Completion, supersession, Public file URL changes, and metadata updates use one File metadata transaction; new bytes use compensating cleanup when metadata commit fails. | Covered by Issue 04 rollback tests. |
| Public file URL creation | `transactional` | File ownership/live-version validation and URL record creation use one File metadata transaction. | Covered by Issue 04. |
| Public file URL revocation | `single-statement` | Revoking one Public file URL is an intentionally atomic update when not paired with file deletion. | Issue 04 verifies paired deletion behavior. |
| File deletion | `transactional` | Marking File metadata deleted and revoking Public file URLs are one database outcome; physical byte removal remains best-effort after the database outcome commits. | Covered by Issue 04 rollback tests. |
| Log index event insert | `non-fatal-index` | Log index writes support inspection and do not roll back app/auth/file workflows when indexing fails; the JSONL stream remains the durable log write. | Verified by Issue 05. |
| Log index pruning | `non-fatal-index` | Prune failure degrades inspection rather than failing or rolling back the workflow that emitted logs; retry queue behavior remains a roadmap candidate. | Verified by Issue 05. |
| Dev-session SQLite runtime writes | `transactional` | Dev sessions use the same runtime Database adapter boundaries as hosted and local Container runtime code for SQL-backed state. | Covered by the relevant workflow issues above. |
| Local Container session SQLite runtime writes | `transactional` | Container sessions mount persistent SQLite data but use the same runtime Database adapter boundaries. | Covered by the relevant workflow issues above. |
| Hosted Capsule SQLite/runtime database writes | `transactional` | Hosted Capsules use the same runtime Database adapter boundaries for Capsule SQL-backed state. | Covered by the relevant workflow issues above. |
| Host server registry writes | `non-db-state` | Hosted Capsule registration, release pointers, route state, and lifecycle metadata are Host server JSON registry state, not Database adapter state. They use Host server locking and atomic replacement. | No DB transaction follow-up required. |
| Host helper release/archive writes | `non-db-state` | Release archives and generated Host helper files are filesystem state rather than SQL-backed runtime state. | No DB transaction follow-up required. |

## Follow-Up Coverage

All rows that were promoted as `requires-fix` in the initial audit have landed
through Issues 02, 03, 04, 05, and 06. No remaining row uses `requires-fix`.
The Log index retry queue remains intentionally outside this feature and is
tracked in `docs/ROADMAP.md` as a future enhancement, not as required coverage
for this audit.

## Adapter Coverage Note

SQLite and service-backed SQLite-compatible adapter mechanics belong at the
Database adapter boundary. Workflow-level tests should use runtime-facing paths
once unless this audit or a follow-up issue finds behavior that differs by
engine.
