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
| Connection/backend loss and stale scope revocation | `test/database-adapter.test.js` — `terminating only the owning Postgres backend...`; `test/resource-transactions.test.js` — `Postgres Job backend loss after its final claim check...` |
| Receipt replay, actor/input binding, current authority, deadline reserve, and unknown COMMIT | `test/resource-transactions.test.js` PostgreSQL Job, mutation, endpoint, lost-COMMIT, and backend-loss cases, with the shared SQLite cases in that same file |
| Live paused owner, rollback/restart recovery, and process death/restart | `test/resource-postgres-process.test.js` — both child-process cases. A live `SIGSTOP` owner remains `RESOURCE_BUSY` after an elapsed observation; a hard-killed owner rolls back write and receipt before a successor acquires. |
| Cancellation/recovery conflict and exact claim settlement | `test/resource-transactions.test.js` — `Postgres Job resource authority locks cancellation and recovery through exact claim settlement`. A public cancellation waits behind the real Job's locked `sporades_jobs` row; a separate recovery update receives `55P03`; after release the committed write/receipt remain and the Job settles cancelled once under its exact claim. |
| PostgreSQL process gate | `node --test --test-concurrency=1 test/resource-transactions.test.js test/resource-postgres-process.test.js` with the harness URL set. This is the current focused command; it must not be replaced by a skipped run. |

These assertions are database/resource-authority evidence only. They do not
claim SMTP acceptance or notification delivery; `notifications.accept` remains
unsupported until ticket 06.
