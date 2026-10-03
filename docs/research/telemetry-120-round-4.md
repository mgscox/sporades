# Availability round-4 validation fixes

Date: 2026-10-03. Starting PR head: `27bf1b4e`. QA report:
[Barbara round 3](https://github.com/mgscox/sporades/pull/204#issuecomment-5968616467).
Merged main `3e59f886` in `da258877`; generated conflicts were resolved by rebuilding.
The two Host test conflicts concerned comments around the already-shared macOS tar
metadata safeguards, which remain in place. No real Host, cloud or SSH operations.

## Notification deadline

The old loop used `Date.now()` both to stop observing and to report notification
latency. Its verdict depended on request dispatch, observer scheduling and wall-clock
changes. A minimized replay of the actual old loop from `27bf1b4e` reproduced its
rejection of a recorded 95-second receipt after a forward wall-clock change.
This demonstrates a harness race; the original QA run did not retain the event
timeline needed to prove which delay or clock condition occurred in that run.

The blocked endpoint now records its actual start, rather than treating the client's
dispatch time as the outage start. Both it and the webhook receiver record
`process.hrtime.bigint()` timestamps on the same Docker Linux VM. The strict SLA
assertion compares those events, using integer nanoseconds, and rejects delivery
even one nanosecond after 120 seconds. A late poll may discover an on-time receipt,
but it cannot make a genuinely late receipt pass. Observer waits use monotonic
time independently; the finite 100-second blocked loop also uses monotonic time.
The starting rule must have observed a healthy target before the drill proceeds.

The private fixture retains blocked/recovered markers, probe and scrape samples,
Prometheus pending/firing state, Alertmanager state and webhook receipts in a unique
per-run timeline, including on failure. Unix timestamps are diagnostic context only;
they do not decide the SLA. Fixture scripts remain read-only; a separate evidence
mount is writable. Cleanup runs even if writing the timeline fails.

Six deterministic regressions cover frozen/backward/forward wall clocks, delayed
observation, exact deadline equality, late receipt rejection, stale/other/recovery
delivery exclusion and bounded missing-evidence failure. Together with the todo
and child-cleanup checks below, ten consecutive invocations passed **90 tests**
(nine per invocation), with no failures, skips or cancelled tests.

Three complete local Docker passes received firing at **94,933.351 ms**,
**98,941.846 ms** and **85,503.114 ms**. Each completed resolved recovery, healthy
maximum-length prefix siblings, genuine absence of only the stopped sibling, and
acknowledged-stop removal. Run 3 includes the final additional firing snapshot:
pending was observed at 22,949 ms, firing and active Alertmanager state at 81,504 ms,
then receipt at 85,503 ms. These observer samples are approximate; the receipt SLA
uses the recorded event timestamps.

Evidence:

- [Run 1](telemetry-120/round-4-docker-1.json) and
  [timeline](telemetry-120/round-4-docker-1-timeline.json).
- [Run 2](telemetry-120/round-4-docker-2.json) and
  [timeline](telemetry-120/round-4-docker-2-timeline.json).
- [Run 3](telemetry-120/round-4-docker-3.json) and
  [timeline](telemetry-120/round-4-docker-3-timeline.json).

## Full-run failure classification

The exact four tests ran on QA's pinned main `4473caea`, rebuilt from its sources,
with the same short private uid-501/gid-20 mode-0700 temp root used for this PR.
That invocation finished **one passed, three failed**. A separate invocation on
the merged main `3e59f886` finished **four passed, zero failed**. Later passes do
not erase the pinned-main reproductions or make QA's complete PR suite green.

| QA failure | Main comparison and action |
| --- | --- |
| Exact framed ClamAV readiness | Failed on `4473caea` at the same `stdout-lf` assertion. Existing [#190](https://github.com/mgscox/sporades/issues/190); unchanged here. Passed separately on `3e59f886`. |
| PDF retry after frozen-clock lazy-load expiry | Failed on `4473caea` at `file-ingress.test.js:252`, matching [#208](https://github.com/mgscox/sporades/issues/208). The test begins at line 240; line 252 is its retry assertion. Unchanged here. Passed separately on `3e59f886`. |
| Scaffolded todo WebSocket timeout | Reproduced on `4473caea`; passed separately on `3e59f886`. The one-shot test reader can lose a query refresh arriving in the same turn as the mutation result. This PR switches that fixture to the existing buffered reader and adds a same-turn burst regression. Runtime and scaffold behavior are unchanged by this fix. |
| ClamAV managed-child cleanup | Passed on both main revisions and in ten separate pinned-main invocations. A minimized probe reliably failed the original five-millisecond fixture budget after a 20 ms event-loop stall. The existing injected `now`/`delay` seam makes TERM/KILL and exit observation deterministic, while retaining the five-millisecond logical budget, both children and the existing stubborn-child/termination-failure tests. No ClamAV runtime changes. |

Existing anonymous sign-in [#194](https://github.com/mgscox/sporades/issues/194)
remains separate. No claim that successful retries repair a failed full run.

## Checks and complete-suite result

- Build, typecheck, generated-bin/source-manifest and whitespace checks passed.
- 56 focused tests passed: inventory/exporter/worker/availability/stack/CLI/relay,
  merged HTTP admission and generated-source manifests.
- Six deadline tests and the affected file-ingress file passed together: 137/137.
- Ten repeated deadline/todo/burst/child-cleanup invocations: 90/90.
- `npm run docs:check`: 53 passed and VitePress build passed. Updated documentation
  checked at desktop 1440 px and phone 390 px with no horizontal overflow; only the
  local preview favicon returned 404. Browser and port-5218 server were stopped.
- Each Docker drill also ran all eight pinned Prometheus rule scenarios and
  Alertmanager configuration validation.

The fresh complete sequential `npm test` (including pretest build and generated checks)
finished **2,970 tests: 2,762 passed, 0 failed, 208 skipped, 0 cancelled**; exit 0,
duration 1,286,942 ms. It used Node 24.19.0 and `/tmp/ken204r4-T56Wke`, mode
0700, uid 501, gid 20, with `SPORADES_CONFIG_DIR` inside this worktree and
`COPYFILE_DISABLE=1`. All four QA failure cases passed within this complete run.
No isolated retry is substituted for that complete result. Barbara's earlier
2,741/4/207 run and Ken's earlier 2,743/2/207 run remain separate failed results.

## Reproduction and boundaries

Baseline command, run from this worktree with each detached baseline checkout:

```sh
SPORADES_CONFIG_DIR="$PWD/.ken-config" TMPDIR=<short-private-uid/gid-root> COPYFILE_DISABLE=1 \
  node --test --test-concurrency=1 \
  --test-name-pattern='a scaffolded capsule can add and read todos over WebSocket|PDF inspection fail-closes expired fresh and concurrent lazy loads before operator work|ClamAV health requires a bounded PING and shutdown awaits both managed children|Dev ClamAV readiness accepts only an exact newline-framed stdout control' \
  <baseline>/test/dev.test.js <baseline>/test/file-ingress.test.js <baseline>/test/dev-clamav-sidecar.test.js
```

The baseline checkouts and config live inside this worktree; the short test root
was created owner-only and explicitly assigned the current user's group. Logs are
under `.sporades/issue-120/round-4`: `main-exact.log`, `current-main-exact.log`,
`main-cleanup-repeat.log`, `clock-race-before.log`, `cleanup-race-proof.log`,
`repeated-fixes.log`, `focused.log`, `docker-{1,2,3}.log` and `full-suite.log`.
This agent started no other full-suite workloads or Docker drills alongside the
complete run.

Fresh infrastructure evidence covers one local Docker Desktop VM and a test
webhook. It does not revalidate older separate-VM evidence or a production canary.
Operators still need to rebuild/restart older long-ID Capsule bundles, apply the
corrected monitoring assets and verify their real notification channel. Task-owned
Compose resources, the browser, docs server and baseline checkout were removed.
