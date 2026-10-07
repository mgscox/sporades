# Container and Hosted admission lifecycle proof

Status: **Deployed operator evidence collected; final agent regression gate pending**.
Issue #72 is closed and the original Docker harness merged in PR #221 on
2026-10-04. The disposable Container/Hosted operator drill was completed on
2026-10-07 and exposed a `host stats` registry lookup defect. This branch resolves
that exact current release, regenerates the shipped helper and covers normal
push, removed declarations, stale history, legacy metadata and unavailable
inspection. A clean full non-root regression run is still required before #73
can be completed. The operator report's interrupted root run is not a pass.

The extended local runner separately checks a real Caddy process and streamed
File responses. Require a committed run with `runtime-boundary-passed`, both
session reports passing, a Caddy receipt of `proxy-boundary-passed`, and confirmed
resource cleanup. Native driver checks remain distinct from Docker proof, and
local proxy fixtures remain distinct from the actual deployed evidence below.

## Reproducible local checks

From the committed PR checkout:

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/issue-73/config"
npm ci
npm run build
node scripts/verify-admission-lifecycle.mjs --driver-check
node scripts/verify-admission-lifecycle.mjs
```

The first runner checks generated Capsule processes on kernel-assigned ports. It
loads the project seed and supplies a synthetic session/capability in a test-only
epilogue. Its publisher uses the underlying atomic publication implementation.
It explicitly leaves deployed ownership and Host helper publication pending.

The second runner requires a healthy **local Unix Docker socket** and rejects
remote contexts. It archives `HEAD` into a worktree-local validation copy, builds
unique tools and Base images, installs Linux dependencies there, and runs real
hardened Container and Hosted processes. Hosted publication uses the shipped Host
helper against a disposable seeded registry. The runner's administrative
container receives the Docker socket; application containers never receive it.
No SSH, Host profile, cloud service, Cloudflare or Appwrite account is required.
The tools image also installs Caddy from Alpine's package repository. After both
Capsule scenarios, `scripts/verify-admission-caddy.mjs` requires the existing real
Caddy route check to complete once, with no failure, cancellation or skip. It
records the Caddy version and result in `caddy-report.json`. This uses routes
emitted by the shipped Host helper, a real local socket peer and duplicate forged
wire headers. It also proves HTTP/upgrade denial before handler entry, shared
quota/Retry-After semantics and public control-route rejection. Docker and Host service management in that check are stubs; it
does not establish deployed Host readiness or actual route publication. The
Cloudflare allowed-source case is simulated and needs no account.
The Base image build receives only `Dockerfile.base` over stdin. That Dockerfile
has no `COPY` or `ADD` inputs; installed dependencies, npm caches and evidence
are excluded from its context.
The tools runner and Capsule fixtures join one uniquely named user-defined
bridge. Runner probes use each Capsule's Docker DNS name and internal port 5688,
not the runner's loopback. It publishes no fixed workstation port; application
host ports still bind only to `127.0.0.1`. Direct workstation fixture runs use
those loopback publications. Each run removes only its own named resources.

Each invocation keeps reports and logs in its own
`.sporades/issue-73/evidence/run-<id>/` directory, printed as `evidenceRoot` in
the final report. Native session reports are under `fixtures/evidence/` there;
Docker session reports and the Caddy receipt are copied directly into the run directory. Reports include commit,
working-tree dirtiness, scenario and generated-manifest digests, session kind,
Bundle digest, timings, counters, RSS, image and cleanup results. A report remains
`incomplete` after an interrupted assertion. `driver-check-passed` and
`runtime-boundary-passed` have different meanings; neither means complete #73
acceptance. Ownership is atomically journaled before launch, including failed
startup and cold-start attempts. Failed removal stays owned, records each error,
and is retried; only confirmed removal permits fixture deletion. SIGINT/SIGTERM
use the same cleanup path. Runner removal and its retries finish before the
authoritative child-journal inventory. If runner termination cannot be confirmed,
the report marks the scan `blocked-runner-termination`, reports `cleanup-failed`
and retains the validation copy; later image cleanup cannot permit its deletion.
After confirmed termination, the report records every inventoried child and its
removal or recovery requirement. Unresolved child cleanup also retains the copy
even if tools/image removal succeeds. The bridge is journaled before creation
and removed only after confirmed runner and child removal; unresolved owners or
network removal retain the bridge ownership and validation copy. Resource names, attempt history and
retained paths are reported for manual recovery. SIGKILL or machine failure cannot
run cleanup: inspect the per-run and fixture `ownership.json` journals and remove
only the recorded resources before deleting their fixtures. The Docker runner tests committed files, so commit changes
before invoking it. The socket must be accessible to the invoking UID and the
runner's supplemental socket group.

## Evidence collected on 2026-10-04

The native driver passed both session scenarios. The original successful run
measured policy add/change/recovery/removal in 1.3–2.1 seconds, 1,738/1,888
concurrent denied HTTP/upgrade observations, exact counters for each 2,048-request
hostile load, fewer than 22 KiB of total logs, and approximately 20 MiB RSS growth
in the measured load interval. Hosted capability-seam churn retained exactly
10,000 buckets and counted 112 evictions for 10,112 distinct synthetic addresses.
The generated no-policy gate median was approximately 0.011 microseconds.
Subsequent reports are authoritative for the current checkout. After Poirot round
1, replacement uses opposite admitted/denied probe groups and records each gate's
actual digest and outcome in a bounded fixture-only observation file. The observer
delegates unchanged to runtime evidence; it changes neither the immutable policy,
decision logic nor caller-facing responses. This proves per-request attribution
without inferring a generation from a health read before or after a request.
Fake-Docker coverage now exercises failed startup/removal, successful retries,
SIGINT/SIGTERM and outer-runner fixture retention; it creates no real containers.

The agreed budget is a warmed median below **1 microsecond per admission gate
call**, not a network or service-latency guarantee. The generated fixture measures
seven batches of 200,000 calls after warmup and asserts untouched request/response
surfaces. Canonical source coverage remains in `test/http-admission.test.js`.
The 64 MiB RSS-growth and 128 KiB whole-scenario log thresholds are named harness
stress guards, not universal production guarantees. Docker additionally imposes
a 256 MiB container memory limit. Exact request totals, twenty retained sampling
keys and fixed unsigned-64-bit counters are checked separately.

The shared Docker daemon timed out during previous attempts; those
`docker-prerequisite-failed` reports created no resources and remain failed
attempts. An isolated local Lima Linux engine subsequently ran the committed
runner at `e4341b75`, evidence `run-894798673fb8`, with exit 0 and
`runtime-boundary-passed` in the outer report and both session reports. Capsule
probes reached Docker DNS addresses on the private bridge. All five mounted
policy mutation attempts failed in both sessions, with unchanged policy bytes;
invalid configured cold starts exited before listening. Add/change/recovery and
removal activated in 1.04–2.05 seconds. Concurrent traffic recorded 368 Container
and 408 Hosted fixture decisions across four distinguishable generations. Both
2,048-request hostile loads reconciled exact counters within the documented
bounds. Every recorded owner was removed, runner termination was confirmed,
and the authoritative journal scan completed before stage deletion.

The engine used only a worktree mount, a local Unix socket and public downloads;
no provider credentials or actual Host server were used. The shared daemon and
external-volume permissions were unchanged. A previous native Host helper
attempt rejected the group-writable external-volume ancestor; the successful
Linux runner exercised the helper within its controlled trust chain. The local
Hosted fixture still uses a synthetic trusted-identity capability. It does not
prove actual Host deployment, Caddy publication or socket-derived identity.
Subsequent reports remain authoritative for the current checkout.

## Extended local evidence collected on 2026-10-07

The committed runner passed at `e733b0af`, run `run-206ccc6ce924`, using Docker
29.8.2, the Base image's Node 22.14.0 and Caddy 2.11.4. The
[bounded evidence receipt](/evidence/admission-lifecycle-2026-10-07.json) contains
the exact commit, generated/scenario digests, Bundle/image identities, counters,
per-generation decisions, measured bounds and cleanup results. It contains no
client addresses, proxy capabilities or private workstation paths.

| Local measurement | Container | Hosted fixture |
| --- | --- | --- |
| Valid publication activation range | 0.78–2.03 seconds | 1.24–2.05 seconds |
| Hostile denial requests with exact totals | 2,048 | 2,048 |
| Load-interval RSS growth | 7.63 MiB | 6.95 MiB |
| Whole-scenario runtime logs | 20,889 bytes | 26,220 bytes |
| No-policy gate median | 0.0195 microseconds | 0.0285 microseconds |
| Slow File download and reset recovery | 2 MiB, exact bytes, passed | 2 MiB, exact bytes, passed |

Both sessions rejected all five policy mutation attempts, retained enforcement
on truncated/oversized hot updates, recovered healthy state and rejected invalid
configured cold starts before listening. The Hosted capability fixture retained
exactly 10,000 buckets and counted 112 evictions. The separate real Caddy check
completed once with zero failures, skips or cancellations, exercising socket
identity, duplicate-header rewriting, opaque HTTP/upgrade denial, shared quota
and public control-route rejection. Host service management in that check remains
stubbed; these results do not complete the deployed rows below.

All ten ownership records were removed. Runner termination and the final child
inventory were confirmed; independent Docker inspection found all eight distinct
resources absent. Raw transcripts and receipts are retained in the author's
ignored `.sporades/issue-73/evidence/run-206ccc6ce924/` directory. Earlier failed
and interrupted runs remain separate diagnostics, not successful acceptance.

## Deployed operator evidence collected on 2026-10-07

The [operator report on PR #221](https://github.com/mgscox/sporades/pull/221#issuecomment-6040886272)
records the actual disposable Host drill at merged source
`9e460853588a53144509e9f719b47a534314b5f9`, exact archive tree
`a1200bc4c7d678e6e7c7803c3e199a48182e4d13`, Node 24.21.0, Docker 29.1.3 and
Caddy 2.6.2. It used the normal Host helper lifecycle and automatic TLS, with
actual helper-owned Hosted identity capabilities. A bounded trusted observer
recorded unchanged admission decisions; File tests used a synthetic owner/session.

The report and 33-file archive are retained on the evidence box named in the
[issue follow-up](https://github.com/mgscox/sporades/issues/73#issuecomment-6041000103).
The archive SHA-256 was independently checked during this follow-up:
`d9f669aa5973d5d8716d1e2d6045916ef8fef3592ef4cc6800552b69ebefface`.
GitHub archive upload failed; no remotely downloadable raw archive is claimed.
The operator recorded deletion of the owned test Host and a provider 404.
This agent did not contact that Host or a provider, or repeat the deployed drill.

## Acceptance matrix

| Boundary | Local automated scenario | Actual deployed operator evidence |
| --- | --- | --- |
| Add/change/removal without redeploy | Timed atomic publication; Bundle digest and PID/container identity retained | Shipped Container and Hosted publication commands, all valid changes within 10 seconds with unchanged runtime identity |
| Concurrent atomic replacement | Per-request captured digest and opposite HTTP/upgrade probe groups; partial generations fail | Four generations, 544 nonce-correlated witnesses; admits and denials on both transports for every generation; exact handler-entry totals |
| Last-known-good and recovery | Truncated/oversized updates retain enforcement and reconcile failure/recovery events | Degraded health and valid recovery passed; health/doctor evidence available; stats omission repaired by exact-release regression below |
| Invalid configured cold start | Docker exit 1 before listen or runtime-start event | HTTP/upgrade 503 and no application container; valid recovery restored enforcement |
| HTTP and WebSocket outcomes | Opaque 403/429, no-store, Retry-After, shared quota, expiry and query reply | Actual Caddy deny/admit/quota, retry semantics, expiry and pre-handler rejection passed |
| Trusted identity | Hosted capability fixture plus separate socket-derived real Caddy check; Container missing-identity behavior | Actual socket rule, forged forwarding/internal headers, direct-loopback rejection and helper-owned identity passed |
| Runtime policy ownership | Write/truncate/rename/unlink/replace attempts fail; bytes unchanged | All five Capsule mutation attempts failed; stored bytes unchanged |
| Hostile bounds | Parser/state/bucket/log/RSS guards and exact request totals | 2,048 exact hostile requests, about 5 MiB RSS growth, 97,924 log bytes below 128 KiB; 10,112 actual source sockets, 10,000 buckets and 112 evictions; seven invalid publications retained bytes |
| No-policy compatibility | Response bytes, route ordering, streamed POST/File with slow/reset clients, WebSocket, counters/logs and gate budget | Separate undeclared Hosted baseline, removed-policy parity, 2 MiB File bytes/headers, slow/reset recovery, no new counters/events and restart parity; gate medians below 1 microsecond |
| Provider independence | Docker/Node/npm/public downloads only | Mandatory runtime checks used Node/Docker/Caddy/SSH without Cloudflare/Appwrite credentials or paid WAF capabilities; the operator's disposable cloud machine is replaceable by a local test Host |
| Operator security scope | Shipped reference limits OWASP contributions | Operator reconciled Top 10:2025 wording; no comprehensive/signature-WAF or optional Cloudflare coverage claimed |
| Inspection regression | Generated helper tests exact pointer/history lookup, removed declaration, stale history, legacy metadata, malformed and failed probe | Actual health/doctor passed; actual stats omission triggered this source repair. New stats build is tested locally, not redeployed to the deleted Host |

A completed non-root full regression run remains the final agent gate. Focused
retries and an interrupted full run do not satisfy it. The deployed observations
above belong to the operator's recorded baseline; the new helper repair is
supported by the focused generated-helper regression rather than a new cloud run.

## Reproduction and human follow-up steps

1. Reproduce the extended local Docker proof using a healthy local Unix engine.
   If using a Linux VM, mount the checkout at the same absolute path used on the
   client: the daemon resolves sibling Capsule bind sources. Select its socket
   with `DOCKER_HOST=unix:///path/to/docker.sock`; leave shared contexts alone.
   Run the Docker runner from the committed PR and retain its exit code, `docker-report.json`,
   both session reports, `caddy-report.json` and log. Require `runtime-boundary-passed`,
   Caddy `proxy-boundary-passed`, all scenario assertions and successful cleanup.
   A daemon timeout, skip or driver pass does
   not satisfy this step.
2. On a **disposable test Host** with Caddy, use a fresh isolated Sporades config
   directory and the shipped Host helper. Follow the
   [Host provisioning contract](../agents/host-provisioning.md). Use Caddy's
   automatic TLS mode or local HTTP test routing; do not supply provider secrets.
   Register and push a small Capsule with `/blocked`, `/limited`, an observable
   handler-entry marker, an echo endpoint, a File download and a query returning
   a fixed reply. Declare `admissionPolicy.path: "policy.json"` with an empty v1
   seed. The current production helper pins Capsule internal port 4000; this
   operator drill is intentionally deferred from the agent's restricted ports.
3. Retain `sporades host stats <subname> --host <alias> --json`,
   `sporades host health <subname> --host <alias> --json`, and
   `sporades doctor --session hosted --json`. Use
   `sporades host policy publish <file> --host <alias> --subname <subname>` and
   `sporades host policy remove --host <alias> --subname <subname>` for policy
   changes; repeat the Container publication flow using
   `sporades deploy policy publish <file>` / `sporades deploy policy remove`.
   Record elapsed add/change/removal times, active digests, unchanged release and
   container identities. Each valid change must be active within 10 seconds.
4. Through Caddy, match the operator-controlled **actual socket address** with an
   address rule. Forge `Forwarded`, `X-Forwarded-For`, `CF-Connecting-IP`,
   `x-sporades-client-address` and its token. The outcome must still follow the
   socket address. A direct loopback request without the Host capability must
   fail closed for the potentially applicable address/quota rule. Repeat HTTP
   and raw WebSocket upgrade deny/admit/quota cases and successful query replies;
   confirm rejected traffic never enters the handler/query marker. Caddy must
   protect runtime-health controls from unauthenticated public requests.
5. Repeat the generated fixture's concurrent replacement scenario behind the
   disposable Caddy route, preserving its **trusted fixture epilogue observer**
   from `test/admission-lifecycle.acceptance.test.js` (not application code).
   Create policy A with two rules: pathname `/blocked` or `/__sporades/ws`, each
   combined with header `x-proof-group` equal to `a`, action `deny`. Policy B
   uses the same paths but matches header value `b`. Give every publication fresh
   rule IDs and retain the expected digest-to-group map. Send both groups over
   HTTP and WebSocket continuously, with unique `x-proof-observation` nonces;
   obtain a valid connection token so admitted upgrades return 101. In A, group
   `a` must get opaque 403 and group `b` HTTP 200 / upgrade 101; B reverses this.
   Match **each response** to its nonce in `/app/data/observations`, then check
   the captured digest and outcome against the expected complete policy. Require
   admitted and denied observations on both transports for every generation,
   and handler markers only for admitted HTTP. Reject unknown digests, both-group
   denial, both-group admission, or split HTTP/WebSocket results under one digest.
   Do not use a nearby health read as the request's generation witness; a reload
   can occur between reads. The fixture observer is bounded to 4,096 observations;
   shorten or restart the drill before exceeding it. Return to an unconditional
   two-transport deny policy before the failure/recovery checks. As the
   test Host administrator, atomically install a truncated policy and then an
   oversized one in the preserved admission directory. Retain degraded doctor
   and stats output, last-known-good enforcement and redacted failure events.
   Publish valid recovery and retain healthy inspection and recovery events.
   Restart with an invalid configured policy: no application HTTP/upgrade should
   be exposed; the Host route should show its unavailable state. Restore valid
   policy and verify restart recovery.
6. Exercise all five mounted-policy mutation attempts **from Capsule code**.
   Repeat bounded hostile traffic and high-cardinality quota churn; compare exact
   counters with sent requests, resource stats and sampled logs. Keep the load
   local. Inspect evidence for leaked addresses, request values, credentials or
   proxy contents. Do not treat a low sampled event count as a request total.
7. Push a separate undeclared-policy baseline. Compare response bytes and headers,
   endpoint/static ordering, streamed File bytes (including a slow/disconnecting
   client), query/upgrade behavior and logs with the removed-policy session.
   Retain generated source parity, source gate-budget result and measured network
   timings; do not apply the 1 microsecond gate budget to network round trips.
8. Record pass/fail for every row, exact commit/image IDs, digests, observations and
   cleanup under #73. The original operator drill is already recorded above;
   these steps support reproduction or a further human drill if QA requests one.
   Fix harness/product failures and run the complete suite as non-root before
   requesting QA. Close #73 only when all required evidence and regression gates
   pass. Keep a reproduction PR in draft if a required deployed row is pending.

Optional Cloudflare-origin tests are separate from mandatory acceptance. Record
which account capabilities were actually used; do not assume paid managed or
OWASP rulesets. Provider coverage cannot replace local Host/Caddy trust proof.

For any additional deployed row, attach the command or traffic transcript, exit status,
observed result, expected result, release/container identities, active digest,
elapsed publication time and evidence file path. Retain denied handler counts,
redacted inspection and cleanup receipts alongside successful outcomes. Mark a
row **pending** when its environment is unavailable; a skip or a native fixture
pass cannot complete a deployed row. The issue is complete only when
every required row is passed and the full regression suite is green.

## Operator security claims

The [OWASP Top 10:2025 assessment](./capsule-request-admission-waf.md#owasp-top-102025-and-defensible-default-coverage)
documents contributions to exposure configuration, bounded logging and secure
admission failure, plus limited route restriction and abuse throttling. This
feature does not provide comprehensive Top 10 protection or generic signature
WAF inspection. Admission never replaces current actor/resource authorization,
and a policy digest protects this policy boundary rather than proving software
supply-chain integrity. Preserve these limits in operator acceptance reports.
