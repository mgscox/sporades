# Ticket 01: external acceptance counterexample

**Result: impossibility under ordinary SMTP and the stated failure model. The
implementation gate remains closed.** This is a deterministic experimental
fixture, not a supported Capsule API, a Job implementation, or adapter conformance.
[ADR-0054](../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md)
records the contract and unresolved requirement. Part of
[#52](https://github.com/mgscox/sporades/issues/52); the parent is unchanged.

## Reproduce

Run on a POSIX host with Node supporting `node:sqlite`, `ps`, and Docker. The
recorded run used Node v24.19.0, Docker 29.7.2 and PostgreSQL 17.11. Dependencies
must be installed inside this worktree; do not symlink `node_modules`.

```sh
npm ci
test -d node_modules && test ! -L node_modules
npm run build
```

First check that port 55432 is free (`lsof -nP -iTCP:55432 -sTCP:LISTEN`) and that
the task-owned container does not already exist. Do not replace another service.
The approved disposable database is loopback-only with no real credentials:

```sh
/usr/local/bin/docker run --detach --name sporades-issue52-ticket01-pg \
  --label sporades.task=task-20260917-011 \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_DB=sporades_w17 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
/usr/local/bin/docker exec sporades-issue52-ticket01-pg pg_isready -U postgres -d sporades_w17
export SPORADES_POSTGRES_TEST_URL=postgres://postgres@127.0.0.1:55432/sporades_w17
SPORADES_FENCE_TRACE=/tmp/issue52-reproduction.jsonl \
  node --test --test-reporter=tap --test-concurrency=1 \
  experiments/issue52-external-contract/proof.test.mjs
node --test --test-concurrency=1 test/job-lease-recovery.test.js \
  test/job-queue.test.js test/table-insert-or-ignore.test.js
npm run typecheck
git diff --check
```

The trace appends JSONL; use a fresh output filename for each run. PostgreSQL is
required: absence of the URL fails the experiment rather than skipping it. The
existing `withPostgresAdapter` harness enforces exactly 127.0.0.1:55432/sporades_w17
before dropping runtime tables and the named fixture table. Run serially with other
repository database tests. SQLite uses a fresh temporary file for every scenario.
Cleanup kills experiment children, closes receiver sockets and drops only the
fixture table; the harness's initial reset is confined to its approved database.
After all database checks, remove only the container created for this task:

```sh
/usr/local/bin/docker rm --force sporades-issue52-ticket01-pg
```

## Mechanism and scope

Each scenario starts A and B with `child_process.fork`; each owns a separate real
Database adapter connection. PostgreSQL backend PIDs and OS PIDs are recorded and
asserted distinct. The parent uses a third database connection for observation and
PG backend termination, plus a loopback SMTP receiver. No real email is sent.
Fixture addresses and Message-IDs use `example.invalid`.

Worker A enters an actual async candidate callback, queries authority, then waits
at an explicit IPC barrier **after its final ownership check**. The test waits for
this acknowledgement before giving B permission to contend. In stopped scenarios,
A receives `SIGSTOP`, and `ps` must report the stopped state before invalidation.
PostgreSQL connection loss uses `pg_terminate_backend(A)` and waits until that
backend disappears. B then acquires, submits and commits (or commits its durable
lease); only after observing B's database authority does the parent resume A and
release its callback barrier. The receiver independently records acceptance.

There is no sleep used to choose a winner. Polls wait for observed process/backend
state with a five-second failure bound; RPC and SMTP timeouts only fail stalled
experiments. SQL `NOWAIT`/SQLite busy rejection makes the contending loser explicit.
No FIFO fairness is claimed. Lease tests use a deterministic supplied clock,
0 → 29999 → 30001, against a stored 30000ms lease. These are conditional-protocol
experiments, not scheduler or wall-clock suspension conformance.

`worker.mjs` intentionally uses raw transaction statements and explicit conditional
SQL through the real adapters. It does not test a new scoped public context, ACLs,
libSQL, or production `ctx.mail`. Its callback exposes the unavoidable gap any
last-check-before-ordinary-SMTP design must close. Stale guarded writes are rejected;
this does not imply ordinary app-table updates automatically carry such predicates.
An aborted local signal is deliberately observed without revoking the independent
socket, illustrating cooperative cancellation's limit.

## Recorded observations

The [raw JSONL](evidence/observations.jsonl) records monotonically ordered events,
PIDs, owner/generation and committed state, callback checks/continuations, receiver
acceptance and sender acknowledgement separately. [TAP](evidence/proof.tap)
contains **16 passed, 0 failed, 0 skipped** (7 SQLite, 9 PostgreSQL).

| Scenario | DB/callback observation | SMTP observation |
| --- | --- | --- |
| Transaction contention, both engines | A wins; B rejects while A holds; observer sees no partial A update; B acquires after A commit | Only A accepted |
| Process death, both | SIGKILL A releases transaction; fresh process connects; B wins deterministically | Only B accepted; dead A cannot resume |
| Live OS pause + lease expiry, both | A checked then stopped; B loses at 29999, wins at 30001; A resumes; A conditional mutation changes 0 rows | B accepted, then stale A accepted; A sees aborted signal |
| Restart + durable lease, both | New process sees retained A owner; loses before deadline; B wins after expiry | Only B accepted |
| Live transaction beyond logical Job deadline, both | B still loses while A is stopped; only A rollback releases engine lock | No submission; expiry alone does not release transaction |
| Connection loss, PostgreSQL | Terminate only A's DB backend; B acquires and commits; live A resumes callback, DB mutation fails | B accepted, then stale A accepted |
| OS pause + connection loss, PostgreSQL | Same sequence while A is verifiably OS-stopped until after B commit | B accepted, then stale A accepted |
| Acceptance + lost reply, both | A reports unknown then DB rollback restores value 0; B retries same operation | A and B both accepted despite identical Message-ID |
| No acceptance + lost reply, both | Same sender unknown and value 0 after rollback | Receiver discarded; zero accepted |

SQLite has no independent remote server connection to terminate. Its process death,
held lock, durable expiry and restart cases are distinct; they are not presented as
SQLite network-partition evidence. PostgreSQL connection loss does not kill A's
process. Restart is a fresh process opening the same storage, not restarting the
PostgreSQL service or receiver. Receiver acceptance is an in-memory test oracle;
receiver crash durability and downstream delivery are outside this experiment.

Existing regression checks are separate: [32 passed, 0 skipped](evidence/scoped-tests.txt)
for Job lease recovery, Job queue and insert-or-ignore (including real PostgreSQL),
and [typecheck passed](evidence/typecheck.txt). No production source changed. Full
suite, libSQL external handoff, ACL conformance and a participating receiver design
are not claimed. Source inspection at base `6570a7ba` confirms the fixed ordinary
Job lease and absence of renewal; ADR-0054 gives the remaining-budget constraint.

## Handoff to tickets 02 and 06

Do not implement either ticket from these counterexample primitives. No safe
ordinary-SMTP API has been selected. The ADR specifies acquisition/loss points,
recovery limits, operation eligibility, actor/lifetime obligations, uncertainty
policy and escaped-capability limits. What remains missing is an implementable
external acceptance/recovery mechanism meeting all of them simultaneously.

A participating acceptance authority must order generation transfer/revocation
with acceptance and expose durable operation reconciliation; checking tokens before
forwarding SMTP is insufficient. A local outbox acceptance contract would need
explicit approval if it changes the protected boundary. No such amendment is
approved by this result, and all dependent tickets remain blocked.
