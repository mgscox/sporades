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
