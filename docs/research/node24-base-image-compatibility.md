# Node 24 Capsule Base image compatibility

Verified locally on 2026-10-22. This is local Docker evidence, not a Hosted rollout
or registry publication.

## Image

- Sporades image: `ghcr.io/sporades/sporades-base:0.3.0-node24-alpine`.
- Upstream: `node:24.22.1-alpine3.23`, pinned to multi-platform index digest
  `sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2`.
- Local built image ID:
  `sha256:89f4ccfd4a7d4518d64bb98edf9f2057eb02f8a5532c50ae255fa73572faa843`.
- Tested platform: Linux ARM64 on macOS Docker Desktop. Runtime reports Node
  `v24.22.1`, Alpine `3.23.7`, and default user `10001:10001`.
- Installed supporting binaries: OpenSSH `10.2p1`, Fail2ban `1.1.0`, ClamAV
  `1.4.4`.

The upstream tag/index and Linux ARM64 manifest were inspected before building.
The built image was retained locally under its new tag. It was not pushed.

## Minimal template acceptance

Exactly one built-in template was deployed to real Docker: **Lit Guestbook**.
It covers both the browser output and a stateful server without requiring a
second application or any external account.

```sh
npm ci --no-audit --no-fund
npm run build
docker build --file Dockerfile.base --tag ghcr.io/sporades/sporades-base:0.3.0-node24-alpine .
SPORADES_REAL_VITE_CONTAINER=1 node --test --test-concurrency=1 --test-name-pattern='real Container serves a complete lit vite guestbook public tree' test/real-vite-container.test.js
SPORADES_REAL_BASE_IMAGE=1 node --test test/base-image.acceptance.test.js
SPORADES_FETCH_DOCKER=1 node --test --test-concurrency=1 test/telemetry-fetch-bundle.test.js
```

All three acceptance commands passed on Docker Desktop **4.96.3**:

| Check | Result |
| --- | --- |
| Built-in Guestbook | 1 passed, 0 failed, 0 skipped |
| Base supporting services | 1 passed, 0 failed, 0 skipped |
| Packaged fetch matrix | 5 passed, 0 failed, 0 skipped |

Guestbook assertions check the selected image, served HTML/JS/CSS/SVG/source map,
MIME types, omitted Server env values and Dev machinery, page connection token,
WebSocket mutation/query, and exactly one persisted guestbook entry after a real
container restart. The runtime reports `v24.22.1` and uses the invoking local
UID/GID (UID `501` in this run). Release/root writes are refused; `/app/data` is
writable and its marker survives restart. Docker inspection confirms read-only
root, dropped capabilities, no-new-privileges, hardened `/tmp`, read-only server
mount and writable data mount. The template container was removed afterward.

The supporting-service check uses the image's default UID/GID `10001:10001`, a
read-only root, temporary writable data, and networking disabled. It generates a
temporary SSH host key and validates `sshd` configuration, executes Fail2ban's
version command, and starts ClamAV with a deterministic local signature. Clean
input passes and matching input is detected through the Unix socket. It needs no
signature download, production credentials, or live provider. The container and
its temporary data are removed afterward.

The fetch matrix executes the packaged generated ESM Bundle on local Node
`v24.19.0`, `node:22.13.0-alpine`, `node:24-alpine`, and the exact newly built
Sporades Base image. It checks successful requests, cancellation, timeout,
network failure, trace propagation and redaction against local test servers.
It creates no additional built-in-template deployment.

## Repository checks

The build includes both TypeScript configurations and regenerates the shipped
CLI, Host helper, runtime artifacts and source manifest. Generated-bin parity
also passed in the full-suite pretest.

- Focused AI, generated Bundle, database lifecycle and Dev ClamAV checks:
  **96 passed, 0 failed, 1 skipped** (external PostgreSQL URL unset).
- Documentation tests and production documentation build: passed.
- Full repository suite: **6,539 tests, 6,282 passed, 3 failed, 254 skipped,
  0 cancelled**, exit 1. Its three failures were the package-based Dev checks
  captured before the npm JSON fix was applied. The final focused rerun of all
  three passed. The entire suite was not repeated after the fix; its original
  result is retained rather than reported as a clean full-suite pass.

The full-suite command was:

```sh
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR=/private/tmp/sporades-node24-full-suite-config npm test
```

It ran with local process inspection enabled. Docker/live-provider acceptance
flags remained unset; the specifically selected Docker checks above were run
separately. PostgreSQL, root-only ownership fixtures and other opt-in integrations
remain among the skipped checks.

## npm pack JSON compatibility

Local npm `11.17.0` emitted package metadata inside an array containing a
package-name-keyed object. Existing package test helpers expected a flat array;
the original two install failures reproduced against unchanged commit
`9a767d3fdbd21b7a4ac2f75ad595207fd836dc8f`. A third package-based Dev test used
the same helper. The user requested this compatibility fix during validation.

`scripts/npm-pack-json.mjs` now normalizes a flat array, direct metadata object,
package-keyed object, or array containing a package-keyed wrapper. It preserves
the complete metadata, including files, version, shasum and integrity, and
rejects missing filenames, malformed JSON and ambiguous/multiple results.
Release packaging, release verification, and package-based test helpers share
this parser. The isolated release-verifier fixture also carries its dependency.

Focused final checks:

- Package parser, packaged monitoring CLI and Access-key contract: **36 passed**.
- All three previously failing installed Dev/Bundle checks: **3 passed**.
- Isolated verifier symlink guards after including the parser: **2 passed**.

The earlier combined JSON/release-verifier batch recorded **44 passed, 2 failed**:
it had loaded the guard fixture before the helper-copy update. Both failures
were `ERR_MODULE_NOT_FOUND` for the omitted helper, and the final two-guard rerun
passed after that fixture update. The installed CLI success/failure trace,
delayed span, tampering, and private-evidence scenarios passed in that batch.

These are separate reruns after the fix, not a rewritten result for the earlier
full-suite attempt. The full-suite result is recorded independently above.

## Docker recovery and limits

Docker Desktop `4.96.1` initially remained in `stopping`. A forced stop/start
allowed the image build, template acceptance and fetch matrix to pass, but later
container creation stalled. VM logs reported RCU CPU/timer stalls. The extra
supporting-service check timed out twice before it could start its container;
those attempts were not counted as passes.

With the user's approval, the official Docker Desktop updater installed
`4.96.3` (build `244472`). Its signed staged installer was blocked waiting for
the old backend to quit; terminating those hung backend processes allowed the
installer to finish. The installed application version was verified, the image
was retained, and all three Docker acceptance commands then passed. This does
not establish long-term Docker VM stability or the cause of the earlier stalls.

An initial sandboxed deploy/doctor/Host run returned 528 passed, 5 failed and
10 skipped. Its five failures waited for process children while sandboxed `ps`
was denied. The full suite is run with local process inspection enabled and an
isolated configuration directory; that result is reported separately.

These checks do not establish AMD64 runtime acceptance, remote Hosted lifecycle,
live PostgreSQL, ClamAV CDN updates, or a production deployment. Upgrade the CLI
and Host helper and redeploy to select the new default. An existing release's
restart preserves its pinned image, and explicit image overrides remain in
effect.
