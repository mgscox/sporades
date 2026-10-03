# Telemetry diagnostics and migration verification — #128

The feature implementation is pinned to `3ccb3f99` (Sporades 0.9.31). Integration
revision `262c98da` also includes main's admission-rate-limit change `b7bbd3f1`;
the only merge conflict was the regenerated source manifest. The combined build
and typecheck passed, and all **45 focused telemetry and admission tests passed**
without failures or skips. The completed combined full suite passed **3,011 tests:
2,797 passed, 214 skipped, zero failed or cancelled**, exit status 0, in 1,271.678
seconds. Its local log SHA-256 is
`9e42f7e0b225cf1f87259c11ce36477a979f4ea39639ecfe4f451645f853956f`.
Verification used isolated
configuration and temporary directories inside the Dennis worktree, with
`COPYFILE_DISABLE=1` for macOS archive fixtures. No real Host, SSH target, cloud
account, production provider call, package publication, tag or release was used.

## Automated evidence

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/issue-128-config"
export TMPDIR="$PWD/.sporades/issue-128-tmp"
export COPYFILE_DISABLE=1
mkdir -p "$SPORADES_CONFIG_DIR" "$TMPDIR" .sporades/issue-128-evidence .sporades/issue-128-esm-tmp
cp docs/research/telemetry-128-fixture-env.mjs .sporades/issue-128-evidence/fixture-env.mjs
printf '%s\n' '{"type":"commonjs"}' > "$TMPDIR/package.json"
printf '%s\n' '{"compilerOptions":{"strict":false,"alwaysStrict":false}}' > "$TMPDIR/tsconfig.json"
printf '%s\n' '{"type":"module"}' > .sporades/issue-128-esm-tmp/package.json
npm run build
npm run typecheck
node --test --test-concurrency=1 test/telemetry-diagnostics.test.js \
  test/host-telemetry-relay.test.js test/host-inventory-reconnect.test.js
npm run docs:check
export NODE_OPTIONS="--import $PWD/.sporades/issue-128-evidence/fixture-env.mjs"
npm test
```

Build and typecheck passed. `npm run docs:check` passed all **53 documentation
tests** and built the VitePress site. The focused run passed **20 tests**, with no skips or
failures. It covers installed CLI request/help parity, separate query authority,
opaque backend errors, exact relay-vs-direct probe identity, unavailable evidence,
TLS denial, partial rejection, configuration drift, failed preflight, successful
migration and fresh inventory acknowledgement, activation rollback, killed-process
recovery, stale-preflight rejection, malformed saved endpoint redaction and
repeated TLS diagnostics. The migration
fixtures use real verified HTTPS, an in-memory backend and fake Docker execution;
they do not establish a real Host relay or separate-VM deployment.

Before integration, the completed full suite with isolated fixtures passed:
**3,001 tests, 2,787
passed, 214 skipped, zero failed or cancelled**, exit status 0, in 1,273.832
seconds. Skips include PostgreSQL, root-only ownership fixtures and optional real
Docker drills. The local final log SHA-256 is
`7d54d036545563e4d3fea9308100e161a35e8e6d2ddd4c60be8a6836674c1d23`.
Earlier attempts were deliberately interrupted to fix review findings and the
real-backend TLS regression. One pretest build rejected an incomplete TypeScript
narrowing in the saved binding validation; it was corrected before this run.
None of those attempts is counted as a passing full run.

The first completed suite had **3,001 tests: 2,764 passed, 23 failed, 214 skipped**.
All 23 failures reproduced in the same four test files on unchanged main
`fc04b41b` (220 tests: 197 passed, 23 failed). Eighteen ClamAV socket fixtures
exceeded macOS's Unix socket pathname limit under the deep worktree path. One
copied ESM entrypoint inherited the temporary CommonJS package scope. Four
prerender fixtures inherited the repository's strict compiler settings.

The worktree-only [fixture environment normalizer](./telemetry-128-fixture-env.mjs)
uses equivalent relative paths at Unix socket calls only in the ingress test
worker, gives the copied ESM fixture its own package scope and keeps temporary
compiler settings neutral. It changes no product source or test assertions and
suppresses no failures or warnings. Files stay inside the worktree. With this
setup, all **220 affected tests passed**, with no failures or skips. The final full
suite used the same setup, which is explicit in the commands above.

Two-axis read-only Standards and Spec reviews covered `0e3277a7` and fixes through
`697f74e8`. Spec findings about nonempty-but-invalid Collector configuration and
unavailable Docker tooling were corrected with regression coverage. A Standards
validation-duplication observation was resolved with one portable OTLP acceptance
validator. The final TLS delta `697f74e8..069cb3f7` received a clean Standards
review. Both reviewers found no blockers in the final saved binding validation
delta `069cb3f7..3ccb3f99`. This internal review does not replace office QA or
GitHub checks.

## Real local Docker backend

The backend check ran at `069cb3f7`; the later `3ccb3f99` fix only validates saved
Host bindings and leaves the Monitoring assets and diagnostic exchange unchanged.
The task-owned project `sporades-dennis-128-5cfb` ran generated gateway assets,
pinned Collector 0.138.0 and Jaeger 2.21.0 with persistent Badger storage on Docker
Desktop. The HTTPS gateway published only loopback port **5287**, using an ephemeral
private certificate. The stack was generated by the installed CLI from this
branch. Only gateway, Collector, Jaeger and their storage initialization services
were started; this was a trace-path check, not whole-stack health acceptance.

A sender-side direct OTLP diagnostic was accepted and its exact trace became
readable through the new fixed operator lookup. Ingestion bearer query access
returned 401; an incorrect operator password failed. The same trace remained
readable after Jaeger and gateway restart. The operator `.env` stayed byte-for-byte
unchanged. The saved redacted
[backend evidence](./telemetry-128-local-backend.json) explicitly records
`relayVerified: false` and `separateVmVerified: false`.

The first backend check exposed retained listeners and unavailable TLS evidence
when Node reused pooled sockets during polling. A repeated-probe regression failed
before the fix. Each bounded exchange now creates a fresh TLS session; the final
backend check passed with an empty stderr file. The backend evidence SHA-256 is
`37f26b81622381eb4aee587f826b6ea79e07363bfb7ef715dee0bb3bc2aa36ae`.

Only this project was stopped and its containers, network, disposable volumes and
owned gateway image removed. No task-owned stack containers remain. Local evidence
and the temporary verifier are retained under `.sporades/issue-128-evidence/`.

## Documentation browser check

The VitePress guide ran on reserved port **5203**. Playwright checked the new
operator reference at 1440px and 390px, section navigation and keyboard focus.
Neither width had horizontal overflow. The only console error was the existing
favicon 404. Screenshots are local `docs-desktop.png` and `docs-mobile.png` in the
evidence directory. The owned browser and docs listener were stopped.

## Pending real separate-VM acceptance

This PR remains **draft** because the desk's safety contract prohibits commands
against a real Host. An authorized operator must verify a real Host VM moving to
a distinct Monitoring VM, failed destination TLS/auth/storage, recovery/rollback,
fresh inventory registration, stale expectation retirement, preserved historical
storage, production metric/trace visibility and continued saved configuration
after workstation disconnection and Host restart. Use the
[operator drill](../reference/telemetry-diagnostics.md#rollback-and-acceptance).
Local HTTPS, Docker backend storage and fake relay tests do not satisfy that gate.
