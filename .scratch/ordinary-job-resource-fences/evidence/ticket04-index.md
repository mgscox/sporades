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
| PostgreSQL runtime resource-lock identifiers remain dialect-quoted; public resource adapter method remains shared | `test/database-adapter.test.js` — `Postgres resource-lock storage preserves its declared camel-case identifiers through the dialect` and `resource transactions retain the shared public adapter method and a symbol-keyed engine primitive`. The first reads `information_schema` after a real resource transaction; the second proves SQLite and PostgreSQL expose the shared method body, keeps the primitive at a descriptor-checked symbol boundary, rejects nested scope entry, and exercises PostgreSQL's private dedicated-session primitive. |
| Bootstrap schema is committed before the first protected callback, but protected application writes are still uncommitted | `test/resource-postgres-publication.test.js` — `Postgres dedicated resource first use publishes lock and receipt schema before its held callback, while hiding application writes` and `Postgres public mutation and endpoint first use publish schema before held callbacks while hiding outer writes`. Each drops the resource schema for first use, holds the real callback after a write, and uses an independent PostgreSQL connection to assert the exact `information_schema` columns for both resource tables while asserting that the callback write is absent. The dedicated case also proves a distinct initialized resource can enter. |
| Authorization-anchor lock ordering under concurrent revocation | `test/resource-transactions.test.js` — `Postgres Job locks the authorization anchor before a concurrent revocation can commit`. The only barrier is the public protected callback, which cannot begin until `resources.run` has authorized and locked the real generic `anchors` resource row; a separate PostgreSQL connection's revocation remains pending until that callback releases and settlement completes. No adapter, statement, or SQL-text monkey patch participates. |
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
