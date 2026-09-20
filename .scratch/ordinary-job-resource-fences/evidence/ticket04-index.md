# Ticket 04 PostgreSQL criterion-to-test index

The required harness is the disposable task-owned PostgreSQL 17.11 instance at
`127.0.0.1:55432/sporades_w17`, selected only through
`SPORADES_POSTGRES_TEST_URL`. Each listed case has `{ skip: POSTGRES_SKIP_REASON }`;
an unset URL is a skip and is not PostgreSQL support evidence. The historical
`04-pg-child-lifecycle-green.log` is invalid (its boolean/integer fixture failed)
and is deliberately not cited here.

| Criterion | Executable real-engine proof |
| --- | --- |
| Dedicated READ COMMITTED connection, `FOR UPDATE NOWAIT`, first-row and existing-row contention | `test/database-adapter.test.js` — `Postgres resource transactions use a dedicated NOWAIT lock...` and `Postgres resource locks contend deterministically...` |
| Exact Job-row acquisition is immediate and does not enter the resource callback on contention | `test/resource-transactions.test.js` — `Postgres Job exact claim-row contention returns RESOURCE_BUSY without entering its resource callback`. A public Job is paused only after its ordinary claim has committed; an independent real PostgreSQL connection locks that exact `sporades_jobs.id` row, then the public handler enters `resources.run`. The handler settles `RESOURCE_BUSY` before PostgreSQL reports a waiting Job-lock query, and the protected callback counter remains zero. The test releases the actual row lock before awaiting normal Job settlement. This is not timing-only proof. |
| PostgreSQL runtime resource-lock identifiers remain dialect-quoted; public resource adapter method remains shared | `test/database-adapter.test.js` — `Postgres resource-lock storage preserves its declared camel-case identifiers through the dialect` and `resource transactions retain the shared public adapter method and a symbol-keyed engine primitive`. The first reads `information_schema` after a real resource transaction; the second proves SQLite and PostgreSQL expose the shared method body, keeps the primitive at a descriptor-checked symbol boundary, rejects nested scope entry, and exercises PostgreSQL's private dedicated-session primitive. |
| Bootstrap schema is committed before the first protected callback, but protected application writes are still uncommitted | `test/resource-postgres-publication.test.js` — `Postgres dedicated resource first use publishes lock and receipt schema before its held callback, while hiding application writes` and `Postgres public mutation and endpoint first use publish schema before held callbacks while hiding outer writes`. Each drops the resource schema for first use, holds the real callback after a write, and uses an independent PostgreSQL connection to assert the exact `information_schema` columns for both resource tables while asserting that the callback write is absent. The dedicated case also proves a distinct initialized resource can enter. |
| Resource readiness is independent of an unrelated failed root transaction | `test/database-adapter.test.js` — `Postgres resource readiness is independent of an aborted root transaction awaiting rollback`. The test queues an invalid statement in the primary root transaction, immediately starts resource admission so its catalog probe would be next on that client, and only then lets the root callback reject and queue rollback. The independent resource callback still enters on the bootstrap connection. |
| Authorization-anchor lock ordering under concurrent revocation | `test/resource-transactions.test.js` — `Postgres Job locks the authorization anchor before a concurrent revocation can commit` and `Postgres public resource scopes lock the authorization anchor through outer settlement`. The only barriers are public protected callbacks, which cannot begin until `resources.run` has authorized and locked the real generic `anchors` resource row; a separate PostgreSQL connection's revocation remains pending until Job, mutation, or endpoint settlement completes. No adapter, statement, or SQL-text monkey patch participates. |
| Exact runtime schema admission | `test/database-adapter.test.js` — `Postgres resource transactions reject malformed runtime schemas before protected work`. Real PostgreSQL tables with a missing lock primary key or receipt columns that are reordered, mistyped, nullable, or extended all return `RESOURCE_STORAGE_ERROR` before the callback or resource-row insert. Existing fresh initialization and folded-legacy publication tests prove the accepted upgrade paths remain available. |
| Caught public contention cannot falsely settle a rolled-back PostgreSQL transaction | `test/resource-transactions.test.js` — `Postgres caught public resource contention poisons outer settlement without losing prior runtime state`. Independent real transactions lock the runtime resource row for a guarded mutation and the authorization anchor for an endpoint. Both callbacks remain unentered; catching `RESOURCE_BUSY` inside the handler cannot produce success. The mutation also proves its already-consumed runtime-owned reauthentication proof is restored by rollback. |
| PostgreSQL storage failures are fixed and redacted | `test/resource-transactions.test.js` — `Postgres Job resource storage failures are redacted without replacing callback errors` proves a real `23505` does not expose SQLSTATE, constraint, or engine text through a catching Job handler while a deliberate callback error remains unchanged. `Postgres public resource storage failures are redacted without replacing callback errors` captures errors inside mutation and endpoint callbacks and proves the awaited tracked promise itself exposes only `RESOURCE_STORAGE_ERROR`; its detached cases remain handled and poison settlement. `test/database-adapter.test.js` — `Postgres resource precommit connection failures are redacted while callback errors remain unchanged` terminates only the dedicated backend during precommit and proves the same fixed error at the engine seam. Existing lost-COMMIT cases retain `RESOURCE_COMMIT_UNKNOWN`. |
| Connection/backend loss and stale scope revocation | `test/database-adapter.test.js` — `terminating only the owning Postgres backend...`; `test/resource-transactions.test.js` — `Postgres Job backend loss after its final claim check...` |
| Receipt replay, actor/input binding, current authority, deadline reserve, and unknown COMMIT | `test/resource-transactions.test.js` PostgreSQL Job, mutation, endpoint, lost-COMMIT, and backend-loss cases, with the shared SQLite cases in that same file |
| Live paused owner, rollback/restart recovery, and process death/restart | `test/resource-postgres-process.test.js` — both child-process cases. A live `SIGSTOP` owner remains `RESOURCE_BUSY` after an elapsed observation; a hard-killed owner rolls back write and receipt before a successor acquires. |
| Cancellation/recovery conflict and exact claim settlement | `test/resource-transactions.test.js` — `Postgres Job resource authority locks cancellation and recovery through exact claim settlement`. A public cancellation waits behind the real Job's locked `sporades_jobs` row; a separate recovery update receives `55P03`; after release the committed write/receipt remain and the Job settles cancelled once under its exact claim. |
| PostgreSQL process gate | `node --test --test-concurrency=1 test/resource-transactions.test.js test/resource-postgres-process.test.js` with the harness URL set. This is the current focused command; it must not be replaced by a skipped run. |

## Publication regression evidence

The newly added publication-only file was intentionally run against the exact
pre-fix runtime in a separate detached worktree, then against this task's
current runtime. Both batches used the verified PostgreSQL wrapper and only
the new regression file; no ticket 01--03 experiment was rerun.

| Runtime | Exact command | Result |
| --- | --- | --- |
| `cdcc950fbe3a87efbb8199f3f4b9836b23e38371` in `/Volumes/M2_2TB/develop/sporades-task002-ticket04-red` | `python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/resource-postgres-publication.test.js` | 1 pass, 1 fail: the public first-use callback was entered while the independent connection saw no published `sporades_resource_locks` columns. |
| `d4f2b4355e5027aaec2a4eea9ea4928bbed5669b` in this worktree | `python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/resource-postgres-publication.test.js` | 2 pass, 0 fail: both exact schemas were published while every held application write remained invisible. |

Logs: `/Users/mattcox/.codex/state/goal-swarm/task-20260918-011-evidence/04-publication-proof-red-cdcc950f.log` and `/Users/mattcox/.codex/state/goal-swarm/task-20260918-011-evidence/04-publication-proof-green-d4f2b435.log`.

The current complete focused PostgreSQL gate also passed 170/170 with no skips:
`python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/database-adapter.test.js test/resource-transactions.test.js test/resource-postgres-process.test.js test/resource-postgres-publication.test.js`.
Its log is `/Users/mattcox/.codex/state/goal-swarm/task-20260918-011-evidence/04-publication-proof-current-focused.log`.

These assertions are database/resource-authority evidence only. They do not
claim SMTP acceptance or notification delivery; `notifications.accept` remains
unsupported until ticket 06.

## Exact Job-row NOWAIT review rework

The `91ce4717` review found the two PostgreSQL exact-Job acquisitions in
`bindJobResources` used `FOR UPDATE` despite ADR-0054 requiring `FOR UPDATE
NOWAIT`. Before this source change, the complete required four-file real-PG
gate passed 170/170 with no skips; that is compatibility evidence, not proof
of the missing immediate-lock contract. The old and new implementations both
normalize a released lock conflict to public `RESOURCE_BUSY`, so there is no
honest distinct pre-fix public result to label RED. The credible before/after
record is the exact SQL contract (`FOR UPDATE` -> `FOR UPDATE NOWAIT` at both
initial and subsequent claim checks), paired with the synchronized real exact
Job-row contention assertion above. Its post-fix focused result is recorded
by the complete four-file gate: 171 passed, 0 failed, 0 skipped in 22.393s:
`python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/database-adapter.test.js test/resource-transactions.test.js test/resource-postgres-process.test.js test/resource-postgres-publication.test.js`.

## Connector review rework

Review findings `4052671637` and `4052671638` were reproduced against
`0fdfea3d` with real PostgreSQL. The focused RED run failed 0/6: both public
outer paths allowed a concurrent anchor revocation to commit, a lock table
without its primary key leaked PostgreSQL `42P10`, and reordered receipt
columns admitted protected work. The repaired focused run passed 6/6 before the
full malformed-layout matrix was added; the completed matrix then passed 9/9.
The required four-file real-PostgreSQL gate passed 180/180 with no skips in
23.390 seconds. Logs:
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-connector-repair-red.log`,
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-connector-repair-green-focused.log`,
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-connector-repair-green-matrix.log`,
and
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-connector-repair-required-green.log`.

## Connector failure-path rework

Review findings `4052714570` and `4052714573` were reproduced at
`d2dc57cb6c39d08f8f1477c9f0372cbc5f4d3d34` with real PostgreSQL. The focused
RED run failed 0/5 with no skips: caught resource-row and anchor-row contention
returned successful mutation/endpoint results, a Job observed raw PostgreSQL
`23505` plus `writes_value_key`, and a killed dedicated backend exposed
`database is not open`. The deliberate callback error already remained intact.
The same focused command passed 5/5 after the repair. The required four-file
real-PostgreSQL gate passed 185/185 with no skips in 23.519 seconds. Evidence:
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-failure-paths-approved-red.log`,
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-failure-paths-approved-green-focused.log`,
and
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-failure-paths-approved-required-green.log`.

## Public outer storage-redaction review rework

The `6a049ac7` review found PostgreSQL failures from mutation and Custom-endpoint
scoped Database writes and receipt inserts escaped the SQLite-only outer
normalizer. A real PostgreSQL public regression failed 0/1 before the repair:
the mutation returned raw SQLSTATE `23505` and the engine's named
`writes_value_key` diagnostic. After the repair, the same regression passed 1/1
across mutation and endpoint caught and detached duplicate writes, forced named
receipt CHECK failures, and deliberate callback errors carrying a `23505` code.
Every storage failure used the fixed public code and message with no constraint
or detail metadata, every callback error retained its identity, and all writes
and receipts rolled back. Evidence:
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-outer-redaction-red.log` and
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-outer-redaction-green-focused.log`.
The required four-file real-PostgreSQL gate then passed 186/186 with no skips in
23.721 seconds; its log is
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-outer-redaction-required-green.log`.
Build, typecheck, generated-artifact parity, and the 46/46 documentation gate
also passed in the corresponding `task002-outer-redaction-*.log` files.

## Unexpected PostgreSQL index connector rework

Finding `r4054971917` was reproduced at `59005492b11d4c5b6f2350ef96e67c2178c202e1`
with a real non-unique expression index on `sporades_resource_receipts`. Its
immutable index function raises only for the regression operation ID, so the
baseline readiness probe accepted the schema, entered the protected callback
once, and then failed the receipt insert. The exact focused RED run passed 0/1,
failed 1/1, and skipped 0; the failing assertion observed callback count `1`
instead of `0`. After readiness began rejecting every index except the exact
primary-key backing index, the same test passed 1/1 with no skips and returned
the fixed `RESOURCE_STORAGE_ERROR` before callback entry. The required real-PG
`resource-transactions` plus `resource-postgres-process` gate passed 162/162
with zero failures and zero skips.

## Promise redaction and readiness-probe review rework

Review findings `4052793510` and `4052793516` were reproduced at `619e0ab5`
with real PostgreSQL. The focused RED run failed 0/2: callback-local mutation
and endpoint catches observed raw `23505`, `writes_value_key`, and the engine
message, while a resource readiness query queued between an invalid primary
transaction statement and its rollback inherited the aborted transaction and
failed admission. The repaired focused run passed 2/2. The required four-file
real-PostgreSQL gate passed 187/187 with zero skips in 24.534 seconds. Evidence:
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-promise-probe-red.log`,
`/Volumes/M2_2TB/develop/agent-net/scratch/task002-promise-probe-green-focused.log`,
and `/Volumes/M2_2TB/develop/agent-net/scratch/task002-promise-probe-required-green.log`.

## Ordinary ACL dependency contention normalization

Connector finding `r4055053524` was reproduced from exact source baseline
`fa474fd61e11fa289fefbc8d1d7186629ef48e98` with the task's real PostgreSQL
harness. The focused command was
`python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/acl-postgres-contention.test.js`.
The RED run passed 1/4, failed 3/4, and skipped 0: ordinary mutation exposed
`55P03` plus relation `policies`, while File public-URL creation and deletion
exposed `55P03` plus relation `sporades_team_memberships`. The passing guard
proved a real trigger-raised `55P03` after ACL dependency locking retained its
existing error, rather than being broadly normalized. After the catch was
scoped to the dependency `LOCK TABLE ... NOWAIT` statement and only `55P03`,
the same command passed 4/4 with 0 failures and 0 skips. Each contention case
also proves prompt settlement, no protected write or File effect, the fixed
`RESOURCE_BUSY` code and message, and no backend detail or relation metadata.
The required real-PostgreSQL resource/process gate, including this regression
file, passed 166/166 with no failures or skips:
`python3 /Volumes/M2_2TB/develop/agent-net/scratch/task002-with-postgres.py node --test --test-concurrency=1 test/acl-postgres-contention.test.js test/resource-transactions.test.js test/resource-postgres-process.test.js`.
The focused non-Postgres File and ACL regression command
`node --test --test-concurrency=1 test/server-files.test.js test/table-acl.test.js`
passed 47/47 with no failures or skips. Build, generated-bin parity,
`git diff --check`, and the documentation gate also passed; the documentation
tests passed 46/46 with no skips before VitePress completed successfully.
