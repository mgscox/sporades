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
| App mutation execution | `requires-fix` | Custom mutations, generated mutations, mutation hooks, ACL write checks, and pending ACL writes must share one Mutation transaction and roll back together. | `.scratch/verify-transaction-coverage/issues/02-prove-mutation-and-hook-rollback.md` |
| App table single-row helper writes | `single-statement` | Direct insert, update, and delete helpers are individual SQL writes; they are safe only when called inside the workflow boundary that owns atomicity. | Issue 02 verifies mutation-level usage. |
| Schema table creation and additive field migrations | `requires-fix` | Schema/data changes and schema metadata must commit as one schema migration outcome when multiple statements are involved. | `.scratch/verify-transaction-coverage/issues/05-close-schema-metadata-and-roadmap-loop.md` |
| Schema/system metadata writes | `requires-fix` | `schemaVersion`, `schemaHash`, and stored schema JSON must not advance unless the schema/data changes they describe also commit. | `.scratch/verify-transaction-coverage/issues/05-close-schema-metadata-and-roadmap-loop.md` |
| Runtime auth storage setup | `transactional` | Auth table creation and lifecycle-column backfills are startup schema work owned by the Database adapter path. | Issue 03 verifies auth workflow outcomes; Issue 05 verifies schema metadata behavior. |
| Auth user insert/profile/link helper writes | `single-statement` | `insertAuthUser`, `updateAuthUserProfile`, and `linkAuthUser` are individual SQL writes; workflows that pair them with credentials, Sessions, OAuth state, or preferences own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| Auth Session insert/delete/refresh/rotate helper writes | `single-statement` | Session helper writes are individual SQL writes; rotation workflows that pair Session changes with preference migration or auth state changes own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| Email credential insertion | `single-statement` | `insertEmailCredential` is one credential row write; sign-up workflows that pair it with user and Session writes own the Auth transaction. | Issue 03 verifies workflow-level usage. |
| OAuth state insertion | `single-statement` | Creating an OAuth state row is one SQL insert. | Issue 03 verifies OAuth callback outcomes. |
| OAuth state consumption | `requires-fix` | Consuming OAuth state performs read/delete behavior and must leave state spent when downstream callback work fails. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Anonymous session creation | `requires-fix` | Creating a fresh Anonymous session inserts both an auth user and a Session token, so the workflow needs a known Auth transaction outcome. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Local identity simulation | `requires-fix` | Local identity simulation can update or insert an auth user and then insert a Session token, so the workflow needs a known Auth transaction outcome. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Email sign-up | `requires-fix` | User, email credential, and Session token creation must be one Auth transaction; a failed sign-up must leave no usable partial auth state. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Email sign-in and Session token rotation | `requires-fix` | Failed rotation must leave the old Session token valid and must not expose a new token. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Provider linking and OAuth callback handling | `requires-fix` | Provider link, user/session updates, and OAuth state consumption need known Auth transaction outcomes; a failed OAuth callback spends state so the flow restarts. | `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md` |
| Sign-out, Session refresh, and expired-token cleanup | `single-statement` | Deleting one Session token or refreshing one Session expiry is intentionally database-atomic when not paired with other auth writes. | Issue 03 verifies user-visible auth outcomes. |
| Current-user preference storage setup | `transactional` | Preference table creation is Database-adapter-owned startup schema work and must remain available on SQLite and service-backed SQLite-compatible adapters. | Issue 03 verifies runtime-facing preference behavior. |
| Current-user preference save helper write | `single-statement` | `saveUserPreferences` is one upsert row write; read-modify-write preference workflows own the Preference transaction. | Issue 03 verifies workflow-level usage. |
| Current-user preference updates | `transactional` | Preference updates read current state, validate the patch, save the next JSON, and report/broadcast only committed state inside a Preference transaction. | Issue 03 adds rollback coverage for failed saves. |
| Anonymous preference migration | `transactional` | Moving Anonymous session preferences to a linked or signed-in user reads source/target preferences and saves the merged target inside a transaction. | Issue 03 verifies auth-linked preference outcomes. |
| Custom endpoint app-table writes | `requires-fix` | Custom endpoints receive `ctx.db`; app-table writes from endpoint handlers need an explicit workflow boundary or documented intentional single-statement behavior. | `.scratch/verify-transaction-coverage/issues/06-verify-endpoint-and-app-message-db-write-boundaries.md` |
| App message handler app-table writes | `requires-fix` | App message handlers receive the mutation-style context and can use `ctx.db`; app-table writes from message handlers need an explicit workflow boundary or documented intentional single-statement behavior. | `.scratch/verify-transaction-coverage/issues/06-verify-endpoint-and-app-message-db-write-boundaries.md` |
| File storage table setup | `transactional` | File metadata table setup is Database-adapter-owned startup schema work. | Issue 04 verifies file workflow outcomes. |
| File bucket creation | `single-statement` | Creating one File bucket is an individual SQL write unless paired with upload/file metadata changes by a workflow. | Issue 04 verifies paired file metadata behavior. |
| Pending upload creation | `transactional` | Path lock lookup, stale pending upload cleanup, bucket/file metadata setup, and pending upload insertion are one File metadata transaction. | `.scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md` |
| Upload completion and replacement | `requires-fix` | Completion, supersession, Public file URL changes, and metadata updates need one File metadata transaction; new bytes require compensating cleanup when metadata commit fails. | `.scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md` |
| Public file URL creation | `requires-fix` | File ownership/live-version validation and URL record creation must be one transaction or one conditional database statement. | `.scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md` |
| Public file URL revocation | `single-statement` | Revoking one Public file URL is an intentionally atomic update when not paired with file deletion. | Issue 04 verifies paired deletion behavior. |
| File deletion | `requires-fix` | Marking File metadata deleted and revoking Public file URLs must be one database outcome; physical byte removal may remain later or best effort. | `.scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md` |
| Log index event insert | `non-fatal-index` | Log index writes support inspection and must not roll back app/auth/file workflows when indexing fails. | `.scratch/verify-transaction-coverage/issues/05-close-schema-metadata-and-roadmap-loop.md` |
| Log index pruning | `non-fatal-index` | Prune failure should degrade inspection rather than fail or roll back the workflow that emitted logs. | `.scratch/verify-transaction-coverage/issues/05-close-schema-metadata-and-roadmap-loop.md` |
| Dev-session SQLite runtime writes | `transactional` | Dev sessions use the same runtime Database adapter boundaries as hosted and local Container runtime code for SQL-backed state. | Covered by the relevant workflow issues above. |
| Local Container session SQLite runtime writes | `transactional` | Container sessions mount persistent SQLite data but use the same runtime Database adapter boundaries. | Covered by the relevant workflow issues above. |
| Hosted Capsule SQLite/runtime database writes | `transactional` | Hosted Capsules use the same runtime Database adapter boundaries for Capsule SQL-backed state. | Covered by the relevant workflow issues above. |
| Host server registry writes | `non-db-state` | Hosted Capsule registration, release pointers, route state, and lifecycle metadata are Host server JSON registry state, not Database adapter state. They use Host server locking and atomic replacement. | No DB transaction follow-up required. |
| Host helper release/archive writes | `non-db-state` | Release archives and generated Host helper files are filesystem state rather than SQL-backed runtime state. | No DB transaction follow-up required. |

## Required Follow-Up Coverage

The following rows intentionally remain `requires-fix` until their linked issues
land and are reviewed:

- Mutation transaction coverage: `.scratch/verify-transaction-coverage/issues/02-prove-mutation-and-hook-rollback.md`
- Auth transaction and Preference transaction coverage: `.scratch/verify-transaction-coverage/issues/03-harden-runtime-auth-and-preference-writes.md`
- File metadata transaction and byte-side-effect cleanup coverage: `.scratch/verify-transaction-coverage/issues/04-harden-file-metadata-and-upload-writes.md`
- Schema metadata and Log index closeout coverage: `.scratch/verify-transaction-coverage/issues/05-close-schema-metadata-and-roadmap-loop.md`
- Custom endpoint and App message app-table write coverage: `.scratch/verify-transaction-coverage/issues/06-verify-endpoint-and-app-message-db-write-boundaries.md`

The feature is not complete while any `requires-fix` row remains without an
implemented fix or an explicit deferral decision.

## Adapter Coverage Note

SQLite and service-backed SQLite-compatible adapter mechanics belong at the
Database adapter boundary. Workflow-level tests should use runtime-facing paths
once unless this audit or a follow-up issue finds behavior that differs by
engine.
