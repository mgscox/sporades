# PR #204: Barbara round-eight correction

## Clock regression and main integration

The managed ClamAV health fixture captures one runtime timestamp, advances mocked wall time by one millisecond, and constructs its signature from the captured timestamp. Before the correction, the deterministic regression failed the second PING readiness assertion; after it, BUSY/PONG behavior and both managed children’s TERM/KILL and cleared-reference assertions pass. The logical shutdown budget remains five milliseconds. No ClamAV runtime behavior or public types changed.

Merged `origin/main` at `e9c635e6`, preserving availability probes, inventory, Alertmanager and notification routing alongside main’s per-sender credentials, pipeline rules/diagnostics and maintenance. Both rule files and scrape job sets are present. The stack asset catalogue includes both sets of assets at schema 4; release packaging uses main’s shared catalogue and checksums. Gateway SIGTERM closes availability, UI/ingestion and metrics listeners. Conflicting generated files were rebuilt from merged source. The packed-CLI parity test checks both rule files without depending on their order. Documentation navigation retains all references.

## Historical failures remain failures

The [independent QA report](https://github.com/mgscox/sporades/pull/204#issuecomment-5970638841) at `1517a9de` recorded two failed Docker runs and a third complete pass. Their QA-reported event sequences are retained in [round-8-retained-qa-timelines.json](telemetry-120/round-8-retained-qa-timelines.json). This JSON is explicitly a report-derived summary: original raw QA event files are absent from this checkout. Existing round-four author JSON/timelines are separate evidence and have not been overwritten or relabeled.

- Run `barbara120-3a4d30d4`: firing at 97,169.811 ms and resolved recovery, then absence verification timed out with Prometheus DNS `EAI_AGAIN`. Failed overall; observed DNS/query interruption, underlying infrastructure cause unresolved.
- Run `barbara120-42ba8a7a`: scrape outage reset pending probe state; no webhook. Failed overall; scrape continuity lost, underlying infrastructure cause unresolved.
- Run `barbara120-dcf84605`: firing at 85,667.174 ms, recovery, long-identity siblings, real absence and acknowledged-stop checks passed. This one pass does not replace either failed run.

The earlier QA full suite remains an exit-1 result: 2,760 passed, 2 failed, 208 skipped, zero cancelled. Both failures were deployment ownership expectations (group 20 versus QA root group 0), reproduced on main and corrected by giving the private root group 20. Isolated successful retries did not rewrite that complete result.

## Fresh validation

All CLI configuration is worktree-local. Node 24.19.0; full-suite temporary root mode 0700, uid 501/gid 20, short macOS socket paths; `COPYFILE_DISABLE=1`. No live Host, provider, cloud or production operations.

- `npm ci`, `npm run build`, `npm run typecheck`, `node scripts/check-generated-bin.mjs`, generated artifact freshness and `git diff --check`: passed.
- Twenty consecutive deadline/readiness/ClamAV/PDF/todo capture repetitions: 180 passed, zero failed/skipped/cancelled. The new one-millisecond regression passes all twenty times. Complete deadline file: 6/6 passed.
- Merged packed-stack and gateway checks: 19/19 passed. First focused attempt failed the order-sensitive pipeline rule assertion; the updated test independently verifies both shipped rule entries, and the rerun passed.
- Availability, Host worker, maximum identities, near-limit inventory, pipeline and rule checks: 23 passed, zero failed, one gated infrastructure test skipped.
- `npm run docs:check`: 53/53 plus VitePress build passed. Desktop navigation reaches main’s maintenance reference; phone availability page has width/scrollWidth 390/390. Only favicon 404 appeared in console. Owned port-5203 docs session and browser closed.
- Fresh Docker drill not run: local Docker Desktop did not respond to `docker info`; the read-only query was stopped. No Docker resources were started in this round. Existing successful local and separate-VM author evidence is historical evidence, not newly revalidated; real notification-provider and production-canary acceptance remain outside this run.
- Full `npm test`, including pretest build and generated checks: **3,161 tests; 2,937 passed, zero failed, 224 skipped, zero cancelled; exit 0**, 1,980,116.521 ms. Both deployment ownership assertions, the corrected ClamAV clock fixture, framed readiness and the earlier PDF/todo cases passed in this complete run. Postgres and real-infrastructure gates remain skipped without their explicit environment. There were no full-suite failures requiring a current-main comparison.
- Task-owned short temporary root removed after validation; local command logs retained under ignored `logs/pr-204-round-8/`. No Docker resources were started.
