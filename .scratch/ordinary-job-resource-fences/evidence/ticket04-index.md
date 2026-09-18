# Ticket 04 PostgreSQL evidence index

| Criterion | Real-engine proof | Result |
| --- | --- | --- |
| Disposable engine | `04-postgres-version.log` | PostgreSQL 17.11 in `sporades-task009-postgres`; dedicated harness targets `127.0.0.1:55432/sporades_w17`. |
| First and existing resource-row contention | `04-green-pg-contention-termination.log` | `test/database-adapter.test.js` holds A through a barrier while B opens an independent adapter. B gets `RESOURCE_BUSY` for first creation and an existing row. The prior `04-red-pg-contention-termination.log` is an assertion-fixture correction: it observed the intended synchronous stale-scope rejection. |
| Terminated owner and stale scope primitive | same green log | A exposes `pg_backend_pid()` after entry; controller terminates that backend, B acquires the same row, resumed A cannot execute SQL and retained scope is inactive. This is adapter primitive proof; the paused real Job/outer-capability matrix remains open. |
| Job receipt | `04-red-pg-job-receipt.log`, `04-green-pg-job-receipt.log` | Earlier receipt proof is provisional: its initial assertion caught a Job error. `04-red-pg-job-diagnosis-2.log` exposed the runtime PostgreSQL `claimToken` quoting defect; the corrected exact Job receipt proof is recorded separately after the current bounded repair. |
| SQLite compatibility | `04-resource-sqlite-repair-2.log` | 70 focused resource checks pass without PostgreSQL substitution. |
| Shared adapter/transaction gate | `04-final-pg-gate-repair.log` | 167 checks, zero skips, passed before the added backend-termination seam. |

The backend-termination test is a database assertion. It makes no SMTP claim;
`notifications.accept` remains unsupported until ticket 06.
