# Sender credential lifecycle verification — #127

Verification on 2026-10-03 used Sporades 0.9.31, Node 24.19.0 on macOS arm64,
Docker Engine 29.8.0 and Compose 5.5.1. All Sporades commands used a configuration
directory inside this worktree. No real Host, SSH target, cloud account,
production canary, npm publication, tag or release was used.

## Automated checks

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" npm run build
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" npm run typecheck
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" npm test
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" npm run docs:check
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" \
  node --test test/sender-credentials.test.js test/host-inventory-reconnect.test.js
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" \
  node --test test/monitoring-stack-cli.test.js
node scripts/monitoring-stack-release.mjs .sporades/issue-127-monitoring.tar.gz
```

Build and typecheck passed. Docs checks passed 53 tests and the VitePress build.
The nine sender/Host reconnect tests, nine inventory/smoke-origin integration
tests, and the packed CLI test passed. Release archive inspection confirmed the sender module and stack schema 3 manifest.
The final complete confirmation run passed: 2,927 tests, 2,720 passing,
207 skipped, zero failures and zero cancellations (1,221.8 seconds). It includes
the final publication-race regression and the previously intermittent Journey
reconnect test. The log is local `.sporades/issue-127-full-test-confirmation.log`.

The first full-suite attempt was interrupted after known macOS archive-fixture
failures. A single focused reproduction showed the Host installer correctly
rejecting AppleDouble metadata. That same test passed with `COPYFILE_DISABLE=1`;
only the final completed clean run above counts as full-suite evidence. The first
completed clean run caught five missing-module errors in isolated inventory/smoke
fixtures. Their copied dependency lists were updated; all nine affected focused
tests passed before the next full rerun. That rerun completed 2,926 tests with
2,718 passing, 207 skipped and one failure in the unchanged browser Journey
second-reconnect test. That test passed in the preceding full run and all eight
Journey expiry tests passed immediately in isolation; its failure appears to be
a race between WebSocket open and restored Journey consent. No Journey source or
test was changed. The final confirmation run is reported above.

Tests verify distinct ingestion and inventory tokens, exact Host scope, no bearer
dashboard/query administration, protected exports, repeated commands, monotonic
non-reused generations after cancellation, stale commit rejection, concurrent
writers, persistent revocation, invalid/unprotected registry denial, unrelated
sender continuity, and byte-for-byte operator/Sealed Server env preservation.
The Host reconnect fixture uses real verified private-CA HTTPS and the existing
local Docker/flock fakes. A saved pending generation preserves the old durable
connection; reconnect invalidates the old acknowledgement, commit preserves
successful reconciliation, and a lifecycle change after revocation stays pending
with an authentication failure. Repeated invocations reread protected Host state.

Internal Standards and Spec reviews of implementation commit `0ce6e47f` and
follow-up deltas through `6a1d77a7` returned no findings. The follow-up also
prevents a successful write exceeding the reader size limit, with an external
CLI regression proving the old bytes and credentials remain usable.

## Real local Docker acceptance

The generated stack used the unique project `sporades-ken-127-cfe2` and loopback
port 5280. Only that project's containers, network and volumes were removed.
Images were Node 24.13.0 Alpine 3.23, Collector 0.138.0, Jaeger 2.21.0,
Prometheus v3.13.3 and Grafana 13.2.2. Read-only credential directory mounting was
exercised with atomic registry replacement and gateway restart.

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" \
  SPORADES_ACCEPTANCE_CLI="$PWD/.sporades/issue-127-packed/package/bin/sporades.js" \
  node scripts/verify-sender-credentials.mjs .sporades/issue-127-docker \
  http://127.0.0.1:5280 sporades-ken-127-cfe2
```

This final completed run used the CLI extracted from `npm pack --ignore-scripts`.
Real runtime HTTP traffic produced traces queried from Jaeger and request metrics
queried from Prometheus before rotation, during a pending generation after
restart, after commit, and from an unrelated sender after revocation/restart.
Real inventory PUTs were acknowledged across those transitions; cross-Host,
query/admin, retired and revoked credentials were denied. The stack `.env` stayed
identical. Acceptance handoff files were deleted and its named senders revoked.
A separate root Linux setup on a task-owned Docker volume produced a registry
readable by UID/GID 1000 through the same read-only subdirectory mount; its volume
and both containers were removed.

An initial exploratory run returned fail-closed 503 immediately after commit
where the harness expected 401. A forced real CLI atomic replacement between the
gateway opening and statting the registry reproduced that response: the opened
old inode had zero links. A second forced replacement during the final inventory
authorization read exposed stale authorization after revocation. Both regressions
were fixed: the reader checks protection/link state before and after reading,
reopens the current path when its inode was replaced, and fails closed after
three competing replacements. HTTP tests prove immediate retired/revoked denial
and unrelated sender availability at these scheduling boundaries. The extracted
package acceptance above was rerun after this fix. A prior 30-rotation local
stress check also observed zero unavailable responses or accepted retired tokens;
that stress result alone was insufficient to rule out the forced read races.

Playwright navigated the new reference from Projects and configuration and checked
desktop and 390px phone rendering on the task's port 5218. Screenshots are local
`.sporades/issue-127-docs-desktop.png` and `issue-127-docs-mobile.png`. The only
console error was an existing missing `/favicon.ico`. The dev server was stopped.

## Deployment acceptance for the operator

On disposable separate VMs with verified HTTPS/private CA, securely transfer the
new handoff, reconnect one actual Host relay with its existing exact identity,
and prove current stored Host/Caddy/Capsule telemetry plus inventory acknowledgements
while another Host/workstation continues exporting. Disconnect the configuring
workstation, restart the sender and gateway, commit the verified generation,
and demonstrate that retired/revoked tokens remain denied. Confirm the Host's
systemd inventory timer catches up pending desired state and that `.env`, Capsule
Sealed Server env, inventory expectations and retained history remain intact.
Watch immediate reload behavior on the deployment filesystem during publication.
Migrate each legacy inventory mapping independently and disable shared legacy
ingestion only after all of its users have adopted named credentials. These real
Host/separate-VM steps were not run under this task's local-only safety boundary.

## Main integration follow-up

Merged `origin/main` at `4473caea` into the existing issue branch in `3655204d`.
The only conflicts were `dist/cli/sporades.js.map` and
`dist/generated-source-manifest.json`; `npm run build` regenerated them from the
merged source. No manual runtime or credential changes were needed. Main's
runtime telemetry, server runtime, Bundle entry and dashboard remain identical
to main; the sender registry, gateway, public contracts and focused credential
fixtures remain identical to the pre-merge branch. The CLI retains both sender
commands and main's WebSocket telemetry/reload integration.

Build, generated-artifact checks, typecheck and docs checks passed. The combined
sender/Host reconnect and WebSocket Bundle checks passed all 19 tests. The full
`COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/issue-127-config" npm test`
run passed 2,940 tests: 2,733 passed, 207 skipped, zero failures/cancellations
(1,287.7 seconds). Its local log is `.sporades/issue-127-merge-full-test.log`.

## Round 2 QA marker-wait correction

[QA round 2](https://github.com/mgscox/sporades/pull/203#issuecomment-5966690871)
at `df00bae7` completed 2,940 tests: 2,732 passed, one failed, and 207 skipped.
The sealed-key descriptor-fencing fixture exhausted its two-second marker wait
after 2,022.8ms. Its isolated retry passed in 1,932.3ms. QA verified that both
the Host test and generated Host helper were unchanged from main.

Assumption: helper startup, Docker quiescing and key generation can exceed the
old deadline under full-suite load. The original failure log did not capture
child completion/output, so it cannot prove the exact cause or rule out an
early helper failure. The fixture now allows a
bounded 15-second marker wait and races it against child completion, reporting
exit code, signal, stdout and stderr immediately on early exit. Polling stops
when the race settles, and the helper is killed/reaped before temporary-fixture
cleanup on failure. The existing 700ms mutation pause, Docker quiescing order,
symlink attacks, stopped-registry assertion, retained private-key assertion,
and outside-file hash/mode/ownership assertions remain unchanged. Runtime,
credential, public API and generated helper code did not change.

Test-first local logs are in `.sporades/pr203-evidence/`: delayed startup failed
before the new waiter existed, then passed; early child exit failed with the old
timeout-only behavior, then passed with captured output. The focused run passed
all four tests, including the live-child missing-marker deadline and the original
descriptor-fencing case (`marker-focused.log`). All commands used
`SPORADES_CONFIG_DIR="$PWD/.sporades/pr203-config"`; archive checks also used
`COPYFILE_DISABLE=1`.

Original QA evidence was preserved without modifying `/tmp` originals:

| Evidence | Original | Worktree copy | SHA-256 |
| --- | --- | --- | --- |
| Failed complete suite | `/tmp/poirot-203-test.log` | `.sporades/pr203-evidence/qa-round2-full-suite.log` | `583e9b0ff50dedcaca39bfb8c8fce85d0b1ca8c2f551b3bad23f04a1ec926bec` |
| Isolated passing retry | `/tmp/poirot-203-host-fence.log` | `.sporades/pr203-evidence/qa-round2-isolated-pass.log` | `55a961b04d1b00ea7324aec5e52968647cfd0464bdd6491a27c354be2cac3caf` |

Local validation also passed typecheck (`typecheck.log`) and packed-CLI private-CA
Docker acceptance (`docker-ca.log`: one passed, one legacy-CLI prerequisite skip).
Playwright checked the existing sender-credential reference and navigation at
desktop and 390px widths on port 5688, with no console errors or document overflow
after loading the correct `/sporades/` base path. Screenshots are preserved in
`.sporades/pr203-evidence/desktop.png` and `mobile.png`. The task-owned docs server
and browser were stopped, and the Docker acceptance fixture removed its containers.

The required complete `COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/pr203-config" npm test`
run exited zero: **2,943 tests, 2,736 passed, 207 skipped, zero failures or
cancellations**, in 1,493.5 seconds (`full-suite.log`). Its build and generated-bin
precheck also passed; tracked `bin/` and `dist/` remained unchanged. The original
fencing case passed in this full run in 1,794.8ms, and all three waiter regression
tests passed. A direct comparison with `df00bae7` confirmed all nine original
fencing assertions and the mutation pause were preserved.

The combined `node --test --test-concurrency=1 test/sender-credentials.test.js test/host-inventory-reconnect.test.js test/telemetry-websocket-bundle.test.js`
run passed all 19 tests (`credential-websocket.log`). `npm run docs:check` passed
53 tests and built VitePress (`docs-check.log`); `node scripts/check-generated-bin.mjs`
and `git diff --check` passed. These checks cover the test-only correction and
unchanged shipped behavior; the separate-VM operator drill remains as documented
above.


## Round 3 QA concurrency corrections

[QA round 3](https://github.com/mgscox/sporades/pull/203#issuecomment-5967299909)
at `c90d0e73` completed 2,943 tests: 2,733 passed, three failed, and 207 skipped.
The failing health/unregister fixture assumed the health process acquired its
lock within 25ms. It now waits for the helper's existing retained-OS-lock proof
marker before starting unregister. Both owned process groups are killed and their launchers reaped in cleanup.
Apply/rollback and the corresponding remove/restore route-trust cases now use
the bounded 15-second child-aware marker waiter and process-group kill/launcher-reap cleanup. Their
700ms mutation pauses, opaque trust errors, outside-file hashes, directory
contents, and retained original-route assertions are preserved.

Journey investigation reproduced a runtime ordering defect, rather than merely
a test timing assumption: opening a WebSocket precedes fresh authentication and
acknowledgement of restored consent. Manual publication could overtake either
step. A delayed-consent regression failed before the fix; real Playwright then
exposed publication from an earlier socket-open listener, and a second regression
reproduced that order before its fix. The client now installs a per-socket
publication barrier when creating the socket and releases it after authentication
and same-identity consent restoration, or socket close. Closed pending publications
settle with `TRANSPORT_CLOSED` and cannot replay on the replacement connection.
The existing identity/consent-owner checks remain in force, and server-side
Journey admission and revocation semantics are unchanged. Source, generated
client/CLI artifacts, public type commentary, canonical reference and generated
API docs ship together. The original real-transport second-reconnect success and
zero-unintended-disable assertions remain unchanged.

Assumptions: startup duration is not evidence of lock ownership; an open socket
is not evidence of restored consent. Readiness must come from the corresponding
confirmed runtime boundary. The marker budget remains bounded; the mutation
pause is not increased to hide a slow start.

Original QA files remain unchanged, with copies under
`.sporades/pr203-r4-evidence/`:

| Evidence | Original | Worktree copy | SHA-256 |
| --- | --- | --- | --- |
| Failed complete suite | `/tmp/pr203-dennis-r3/full-suite.log` | `qa-round3-full-suite.log` | `f937c92be59fe7f9fffb21e699a35c768627c0af26ede880233b08213a8a9ecc` |
| Isolated passing Host retries | `/tmp/pr203-dennis-r3/host-failure-isolated.log` | `qa-round3-host-isolated.log` | `ad5f1de7e019a7caf330419d7f4d255bb0906e51c056c84210f0e6cf323ad6e5` |
| Isolated passing Journey retries | `/tmp/pr203-dennis-r3/journey-isolated.log` | `qa-round3-journey-isolated.log` | `9b13ce5821b001e40f770fc5de238db301a6ebacbf98f66ee600ffaeea24f2cc` |

All correction commands use `SPORADES_CONFIG_DIR="$PWD/.sporades/pr203-r4-config"`;
archive fixtures also use `COPYFILE_DISABLE=1`. Evidence logs are in
`.sporades/pr203-r4-evidence/`:

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/pr203-r4-config"
export COPYFILE_DISABLE=1
npm run build
npm run typecheck
node --test --test-concurrency=1 test/client-runtime.test.js test/user-journey-expiry.test.js
node --test --test-name-pattern='Host helper (marker wait|cleanup releases)|serializes stale health repair against route removal|revalidates trust immediately before (apply and rollback|remove and restore)' test/host.test.js
node --test --test-concurrency=1 test/sender-credentials.test.js test/host-inventory-reconnect.test.js test/telemetry-websocket-bundle.test.js
node scripts/check-generated-bin.mjs
npm run docs:check
npm test
```

Build, typecheck and generated parity passed. All 92 client/Journey tests and all seven focused Host checks passed, including
retained-lock release on fixture cleanup. The combined sender/Host reconnect
and generated WebSocket Bundle checks passed all 19 tests. Docs checks passed 53 tests and the VitePress build.
Test-first failure logs are `journey-red.log`, `early-open-red.log`, and
`cleanup-red.log`. The cleanup regression showed that killing only the launcher
left the flock action alive: the next helper timed out acquiring the same lock.
Killing the fixture-owned detached process group releases that lock before
cleanup; the group is never selected by a shared name or global process scan.
Three early complete-suite attempts were deliberately interrupted to repair a
new fixture's remaining retry timer, the browser-discovered earlier-open race,
and complete subprocess cleanup. They remain as
`full-suite-interrupted-fixture-cleanup.log`,
`full-suite-interrupted-browser-race.log`, and
`full-suite-interrupted-child-cleanup.log` and do not count as completed gates.

Playwright checked the canonical reference and a disposable browser/runtime
fixture on port 5203 at desktop and 390px widths. With authentication responses
delayed 300ms, publication from an earlier open listener succeeded on two
reconnects with distinct server-owned sessions and zero disable requests.
Explicit disable succeeded and subsequent publication returned
`JOURNEY_NOT_ENABLED`. Saved results are `browser-reconnect-result.txt` and
`browser-disable-result.txt`; screenshots are `docs-desktop.png`,
`docs-mobile.png`, `journey-desktop.png` and `journey-mobile.png`. Neither page
overflowed. The final runtime page had no console errors or warnings. The docs
page had only the existing favicon 404 before server shutdown; navigating away
from its stopped Vite dev server also produced expected disconnected-HMR errors.
Both task-owned servers and the browser were stopped. No real Host or provider
operation was performed; prior credential/Docker evidence and the separate-VM
operator follow-up above remain distinct from this correction's browser proof.

The final complete `npm test` run exited zero on runtime/test commits `dd77b034`
and `bf951447`: **2,947 tests, 2,740 passed, 207 skipped, zero failures and zero
cancellations**, in 1,609.6 seconds. The log is `full-suite.log`. Its build and
generated-bin precheck passed. The original health/unregister case passed in
2,014.8ms, apply/rollback fencing in 12,313.7ms, and the original real-transport
Journey reconnect case in 1,950.4ms. The second-reconnect successful-publication
and zero-unintended-disable assertions are preserved. Only this completed run,
not isolated retries or interrupted attempts, establishes the required green gate.

## Round 4 follow-up: main integration and focused verification

Fetched current `main` and the PR branch on 2026-10-03. `origin/main` was
`4473caeac86d649231b614992b51e0a33ebbc161`, already an ancestor of candidate
`f79b8a3bd898645185f174ab6c8fb6d3b95e0a5d`; `git merge --no-edit origin/main`
returned `Already up to date.` No runtime or test changes were needed.

Following the CEO's round-four instruction, the two full-suite failures are
tracked separately in [#208](https://github.com/mgscox/sporades/issues/208):
the public-tree candidate wait in `test/deploy.test.js:1813` and frozen-clock
retry in `test/file-ingress.test.js:252`. Round-four QA's completed full suite
remains red (2,738 passed, 207 skipped, two failed, zero cancelled); its isolated
retries passed. This follow-up does not claim a new green full-suite run.

Fresh validation: `npm run build`, `npm run typecheck`,
`node scripts/check-generated-bin.mjs`, and unchanged `bin`/`dist` parity passed.
The combined sender credentials, Host inventory reconnect and WebSocket Bundle
files passed 19 tests; the seven focused Host fixture tests passed; the client
runtime and Journey expiry files passed 92 tests; lifecycle inventory, monitoring
smoke origin and monitoring stack CLI files passed 10 tests. All had zero
failures, cancellations or skips. The commands are the focused commands above,
plus `node --test --test-concurrency=1 test/lifecycle-inventory.test.js
test/monitoring-smoke-origin.test.js test/monitoring-stack-cli.test.js`.

Configuration and temporary files stayed inside the worktree through
`SPORADES_CONFIG_DIR="$PWD/.sporades/ken-pr203-config"` and
`TMPDIR="$PWD/.sporades/ken-pr203-tmp"`; archive checks used `COPYFILE_DISABLE=1`.
An initial Host fixture run failed because the repository's ESM package scope
reached its CommonJS fake Docker/Caddy scripts. Adding `{"type":"commonjs"}`
to the ignored temporary directory's `package.json` restored the normal fixture
environment, and all seven checks then passed. Logs, including that failed
setup attempt, are retained in `.sporades/ken-pr203-checks/`. No real Host,
cloud, publication or release operations were performed.


## Office-restart recovery and latest-main integration

The office restart resumed this task after its original fixes had been pushed.
The original desk was subsequently assigned to `swarm/issue-105-barbara`; its
checkout and untracked evidence were left untouched. Recovery used the isolated
checkout `.sporades/pr203-recovery` inside that same desk. The original
round-three logs and their SHA-256 hashes remain intact. GitHub confirms all
original fixes are ancestors of the current PR branch.

[Round-five QA](https://github.com/mgscox/sporades/pull/203#issuecomment-5969217991)
at `bb10d44b` identified conflicts with main `3e59f886`. Merge commit `20de7141`
includes that main revision. The sole source conflict was the health/unregister
fixture: both sides required confirmed lock ownership. Resolution retains the
PR's exact lock marker, bounded child-aware wait, detached-group cleanup and
700ms pause, incorporates main's explanatory comment, and preserves main's other
Host fixture changes and all assertions. The CLI source map and generated-source
manifest were regenerated with `npm run build`. Main's exact-path HTTP denial
and this PR's sender credential and Journey reconnect behavior are preserved.

All commands used configuration inside the recovery checkout:

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/recovery-config"
export COPYFILE_DISABLE=1
npm ci
npm run build
npm run typecheck
node scripts/check-generated-bin.mjs
node --test --test-concurrency=1 test/sender-credentials.test.js test/host-inventory-reconnect.test.js test/client-runtime.test.js test/user-journey-expiry.test.js test/telemetry-websocket-bundle.test.js test/lifecycle-inventory.test.js test/monitoring-smoke-origin.test.js test/monitoring-stack-cli.test.js
node --test --test-name-pattern='Host helper (marker wait|cleanup releases)|descriptor-fences sealed-env key creation|serializes stale health repair against route removal|revalidates trust immediately before (apply and rollback|remove and restore)' test/host.test.js
npm run docs:check
npm test
```

Dependency installation, build, typecheck and generated parity passed. All 121
combined credential/client/Journey/inventory/WebSocket tests and eight focused
Host tests passed. Documentation passed 53 tests and the VitePress build.
Playwright checked the integrated operator reference, including rotation-section
navigation, at desktop and 390px widths on port 5203: no horizontal overflow,
with only the existing favicon 404. Screenshots, console output and command logs
are in the recovery checkout's `.sporades/recovery-evidence/`. The browser and
task-owned docs server were stopped. No real Host or external provider operation
was performed; separate-VM acceptance remains the operator follow-up above.

The complete integrated `npm test` run exited zero on `20de7141`: **2,958 tests,
2,750 passed, 208 skipped, zero failures and zero cancellations**, in 1,730.5
seconds. Its build/generated precheck passed. `full-suite.log` has SHA-256
`ff9f5bbe2219f6a0545ff9c491c9ffc431c761f5ce02f67d872889f6ad7eb480`.
The health/unregister and apply/rollback fencing cases passed, as did the original
real-transport second-reconnect publication/zero-disable assertions. The known
independent cases tracked by #190 and #208 were unchanged and also passed in
this completed run; no test exclusions or isolated retries establish this gate.
Current GitHub main remained `3e59f886` at final verification.

Assumptions: retain both branches' confirmed lock-ownership intent, use the PR's
stronger bounded waiting and complete child cleanup, and regenerate conflicting
artifacts from the combined source. Isolate recovery work instead of changing a
desk that has been reassigned. Earlier QA full-run failures remain historical
failures; this new completed run provides the integrated green gate.

## Second restart recovery and fetch-telemetry main integration

After the office restarted again, the desk had been reassigned to another issue.
The isolated recovery checkout remained clean on `6ed2a621`; the saved fixes
and earlier completed green gate were intact. GitHub main advanced to
`d243884f` (outbound fetch telemetry), making PR #203 conflict again.
Merge commit `1b40a277` integrates that main. Only generated declarations,
source maps and the generated-source manifest conflicted; `npm run build`
regenerated them from the cleanly merged source. The Host fixture fixes,
Journey restoration barrier and reconnect regression tests are unchanged.

All validation used `SPORADES_CONFIG_DIR="$PWD/.sporades/recovery-config"`,
with `COPYFILE_DISABLE=1` for tests. Build, typecheck and generated parity
passed. Combined credential, client/Journey, inventory, WebSocket and outbound
fetch tests completed with **134 passed, three skipped and zero failures**.
All **eight** focused Host synchronization/fencing checks passed.
`npm run docs:check` passed **53 tests** and the VitePress build.

The complete `npm test` on `1b40a277` exited zero: **2,974 tests, 2,763 passed,
211 skipped, zero failures and zero cancellations**, in 1,297.8 seconds.
Its build/generated precheck passed. Confirmed health-lock synchronization,
apply/rollback and remove/restore fencing, and the real-transport Journey
reconnect publication/zero-disable assertions all passed under full-suite load.
No exclusions or isolated retries establish this gate. Logs are retained as
`.sporades/recovery-evidence/restart2-*.log`; `restart2-full-suite.log` has SHA-256
`e8300e39125495cda740212174a63a72f38a89ca562934bebcd3748a1098e092`.

The original round-three failed-full-run and isolated-pass evidence, and the
previous recovery's green full-run log, remain unchanged with their recorded
hashes. Assumptions: retain both branches' behavior, regenerate conflicting
artifacts from combined source, and keep recovery isolated from the reassigned
desk. Main remained `d243884f` at final verification.
