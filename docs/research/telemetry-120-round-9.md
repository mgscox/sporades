# PR #204: Barbara round-nine correction

Dev now calls `routeRuntimeHealth` using the same dispatch pattern as the generated Bundle. This exposes the already documented public `GET /__sporades/probe` contract in Dev while retaining the shared nonce validation, uncached marker response and opaque protected readiness denial. No public types or nonce/authorization rules changed. Shipped CLI artifacts were regenerated.

The installed-CLI/generated-Bundle regression first reproduced Dev’s 404 for a valid header nonce. It now checks header/query nonces, length boundaries, uppercase/missing/invalid nonces, header precedence, no-store/no-cache/Vary headers, exact marker bytes and protected readiness denial in both runtimes. Captured OTLP exports prove ordinary application requests still export while valid and invalid probe GETs are excluded from request metrics and traces. Five consecutive parity/preflight invocations passed (20 tests total at that point). The additional exact QA missing-rule warning regression subsequently passed with all four preflight tests.

## Rule preflight and retained failure evidence

The [QA report](https://github.com/mgscox/sporades/pull/204#issuecomment-5980802931) and original logs confirm the first run failed before stack launch. Promtool reported `no file match pattern ../../monitoring/trace/availability-rules.yaml`; a separate path check returned `Permission denied`. The mode-0700 QA source root blocked the image’s non-root user. Changing QA copy permissions allowed the unchanged retry to pass. That first attempt remains failed environment evidence, not a notification-delivery failure or PR defect.

[Retained QA preflight summary](telemetry-120/round-9-retained-qa-preflight.json) records both attempts. The original logs were copied into ignored task logs without modifying QA evidence. The retry fired at **92,291.329137 ms**, recovered and passed absence/stop checks. It ran on one Linux Docker host on Tower; the original JSON’s Docker Desktop label was inaccurate. The drill now reports the neutral, accurate single-Linux-Docker-host topology.

Pinned promtool still runs as non-root with a read-only mount. Source permission denials and missing-rule visibility warnings produce clear stage codes and guidance before stack launch; Docker-daemon permission failures and other validation errors remain separately classified. Failed preflight events are retained in the timeline. The helper does not expose raw command errors, change directory permissions or elevate the container user. Canonical documentation explains using a separate disposable readable checkout without credentials/operator data.

## Validation and limits

Fetched and merged `origin/main`: already up to date at `e9c635e6`. Node 24.19.0, worktree-local CLI configuration, `COPYFILE_DISABLE=1`, short private mode-0700 uid-501/gid-20 temporary root. No real Host, live provider or production operations.

- Build, typecheck and generated CLI checks passed.
- New installed Dev/Bundle parity and diagnostic checks passed; the additional captured-warning case is included in the restarted complete run.
- A real Dev session on reserved port 5203 showed the marker in desktop and phone browsers; header nonce returned 200/no-store and protected readiness returned opaque 404. Browser/session and temporary Capsule were removed.
- Documentation checks: 53 passed plus VitePress build.
- First new full-suite invocation was deliberately interrupted (exit 130, not a pass) to include the newly inspected QA warning regression. Its partial log is retained separately.
- Final full `npm test`, including pretest build/generated checks: **3,166 tests; 2,942 passed, zero failed, 224 skipped, zero cancelled; exit 0**, 1,588,483.951 ms. The installed Dev/Bundle parity, all four final preflight cases and ClamAV fixture passed in this complete run. No failures required reproduction on main. [Machine-readable results](telemetry-120/round-9-validation.json).
- Focused deadline/preflight/availability batch: 15/15 passed. Whitespace and generated freshness checks passed. Task-owned temporary root removed after final validation; logs retained under ignored `logs/pr-204-round-9/`.
- No fresh Docker outage, separate-VM drill or production canary was run by the author in this correction. Round-nine QA’s complete Docker and silence results are recorded QA evidence, not newly rerun author checks. Earlier failed round-four timelines remain retained and unresolved in the round-eight report.
