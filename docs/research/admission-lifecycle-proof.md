# Container and Hosted admission lifecycle proof

Status: **Hosted acceptance ready for human verification; #73 incomplete**.
Issue #72 closed on 2026-10-04. The harness PR has a separate local Docker merge
gate: keep PR #221 in draft until the committed Docker runner exits 0 with
`runtime-boundary-passed`, both Container and Hosted fixture reports passing,
and confirmed cleanup of every owned resource. Then make the harness PR ready
for QA and merge; deferred actual Hosted checks below remain under open issue
#73. Native generated-runtime checks validate the driver; they do not satisfy
the local Docker gate or actual Host/Caddy acceptance.

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
The tools runner and Capsule fixtures join one uniquely named user-defined
bridge. Runner probes use each Capsule's Docker DNS name and internal port 5688,
not the runner's loopback. It publishes no fixed workstation port; application
host ports still bind only to `127.0.0.1`. Direct workstation fixture runs use
those loopback publications. Each run removes only its own named resources.

Each invocation keeps reports and logs in its own
`.sporades/issue-73/evidence/run-<id>/` directory, printed as `evidenceRoot` in
the final report. Native session reports are under `fixtures/evidence/` there;
Docker session reports are copied directly into the run directory. Reports include commit,
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

Docker proof could not start: `docker info` timed out at 12 seconds, and the
local socket's `_ping` also timed out. The isolated runner records
`docker-prerequisite-failed`, with no resources created. A separate native Host
helper attempt rejected the external volume's group-writable ancestor
(`/Volumes/M2_2TB`, mode 0775). Neither the shared daemon nor that ancestor's
permissions were changed. The isolated Linux runner gives helper-owned paths a
controlled trust chain, but that runner is still unexecuted.

## Acceptance matrix

| Boundary | Automated scenario | Remaining deployed evidence |
| --- | --- | --- |
| Add/change/removal without redeploy | Timed atomic publisher operations; original Bundle digest and PID/container ID retained | Docker run; Container CLI publication and actual Hosted deployment/route path |
| Concurrent atomic replacement | Opposite probe groups must admit/deny HTTP and upgrades according to each request's captured digest; union, empty and split generations fail; handler markers equal admitted HTTP totals | Docker and actual Caddy traffic; retain per-request digest/outcome witnesses |
| Last-known-good and recovery | Truncated and oversized hot files degrade health, retain digest/enforcement, recover, and reconcile failure/recovery event totals | Docker and existing doctor/Hosted stats inspection |
| Invalid configured cold start | Docker relaunch must exit 1 before listening or `runtime.started` | Unexecuted Docker test; direct HTTP/upgrade refusal and actual Host unavailable route |
| HTTP and WebSocket outcomes | Opaque 403/429, content length, no-store, Retry-After, shared HTTP/upgrade quota, expiry and successful query reply | Real Caddy upgrade and handler-entry observations |
| Trusted identity | Forged capabilities rejected; Container rejects even a valid Hosted capability; Hosted synthetic address/CIDR and quota seam | Actual Caddy socket derivation, header stripping, direct-loopback denial |
| Runtime policy ownership | Capsule endpoint attempts write, truncate, rename, unlink and replacement; Docker asserts failure and unchanged bytes | Unexecuted mounted-policy test |
| Hostile bounds | Invalid UTF-8/depth/size/rule/condition/text candidates cannot replace file; raw hostile HTTP, exact counters, sampling, bucket eviction, RSS/log guards | Sustained Docker run and operator resource observation |
| No-policy compatibility | Separate undeclared Bundle vs removed policy: exact bytes/status/content type, endpoint/static order, streamed POST, WebSocket query, no new counters/logs and gate budget | File response streaming, deployed baseline logs/route parity and cold restart |
| Provider independence | Local runner needs Docker, Node/npm and public package/image downloads only | Complete mandatory Caddy/Host path without provider credentials |
| Operator security scope | Shipped reference explains limited OWASP contributions and unsupported signature inspection | Human reconcile claims with final deployed observations |

## Human completion steps

1. Restore or provide a disposable local Linux Docker environment. Run the Docker
   runner from the committed PR and retain its exit code, `docker-report.json`,
   both session reports and log. Require `runtime-boundary-passed`, all scenario
   assertions and successful cleanup. A daemon timeout, skip or driver pass does
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
   cleanup under #73. Actual Hosted acceptance does not block the harness PR
   once its local Docker merge gate passes. Fix harness failures on its branch
   and rerun relevant checks before requesting QA; if the harness has merged,
   track later fixes separately under #73. Close #73 only when all acceptance
   rows have evidence, including the deferred actual Host/Caddy checks.

Optional Cloudflare-origin tests are separate from mandatory acceptance. Record
which account capabilities were actually used; do not assume paid managed or
OWASP rulesets. Provider coverage cannot replace local Host/Caddy trust proof.
