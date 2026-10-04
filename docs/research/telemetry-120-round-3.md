# Availability round-3 fixes and local verification

Date: 2026-10-03. Starting revision: `c7d7a0513be642a1a31c23ef82652b0ce585fc81`.
PR #204, issue #120. Native blockers #118 and #112 were closed before work.

## Changes

Runtime metrics and traces export the configured `service.name` verbatim, matching
the inventory and Host readiness identity. A valid maximum-length Hosted ID has a
253-character domain, slash and 63-character subname (317 characters). The real
OTLP exporter regression checks metrics, uptime and spans for two such IDs sharing
their first 80 characters. Prometheus fixtures cover both healthy identities and
genuine absence of only one sibling. The generated-Capsule Docker drill covers the
same distinction through the collector and Prometheus after the absence grace window.

The Host absence alert now references dashboard UID `sporades-hosts`. A committed
regression validates every alert dashboard reference against the shipped dashboard
JSON files. All three referenced dashboards also returned HTTP 200 from the generated
Docker stack: `sporades-api`, `sporades-resources`, `sporades-hosts`.

Committed Host-worker regressions deny missing/invalid relay labels, missing network
addresses, hostnames, malformed IPv4 addresses and unsupported IPv6 before exec or
delivery. Failed and timed-out execs report readiness zero and recover on the next
run. A failed relay delivery returns false without unbounded retries; the next
successful delivery returns true. All operations use a fake Docker executable and
an isolated local HTTP receiver.

The Tailwind test fixture discovers installed Lightning CSS native bindings instead
of assuming Darwin ARM64, allowing the fixture to run in local Linux Docker too.
Product Tailwind behavior is unchanged. Runtime/CLI artifacts, public contract notes
and operator docs were regenerated or updated. Anonymous sign-in issue #194 remains
separate; scaffold/auth sources were not changed.

## Checks

- `npm run build`, `npm run typecheck`, generated-bin/source-manifest checks: passed.
- Seven focused inventory, exporter, availability, stack, CLI and relay test files:
  **41 passed, 0 failed, 0 skipped**.
- Prometheus v3.13.3 `promtool test rules`: all **eight** scenarios passed.
- `node scripts/verify-availability.mjs`: passed. Real generated Capsules retained
  both 317-character identities, remained healthy past the grace window, and
  stopping one raised absence without masking it with the still-exporting sibling.
  The blocked-loop drill delivered firing in **96,109 ms**, followed by resolved
  recovery. Acknowledged stops removed expectations. See
  [Docker evidence](telemetry-120/round-3-docker-acceptance.json).
- Locally generated monitoring release archive: rules, Host dashboard and README
  matched the source files byte for byte.
- `npm run docs:check`: **53 passed**, VitePress build passed. Documentation checked
  at desktop 1440 px and phone 390 px, including navigation, keyboard focus and
  overflow. Only the local preview's favicon returned 404.
- Tailwind fixture: passed on native macOS and in Linux Docker. The final Linux
  environment preflight also passed packed-CLI, activated-project and redaction
  checks (**5 passed**). Interrupted Docker full-suite attempts are not full-suite
  results.

## Complete suite and separate retries

The final complete native `npm test` ran with Node 24.19.0, concurrency 1, and a
short private root `/tmp/ken204-x9Wbt2`, mode 0700, owned by the current user and
group (501:20). Both deploy ownership assertions and the previously problematic
Unix-socket and prerender fixtures passed in this complete run.

**2,952 tests: 2,743 passed, 2 failed, 207 skipped, 0 cancelled**; exit 1,
duration 1,911,103 ms. The full-suite verdict is **failed**.

Failures:

1. `test/dev.test.js:5137`, `sporades dev keeps the old Runtime active when
   service-env state cannot be prepared`: JSON event timeout at 10,566 ms.
2. `test/job-retry-cancel.test.js:20`, `delayed Jobs wake automatically and retry
   exhaustion retains one Job history`: state was `delayed` instead of `succeeded`
   at 243 ms.

Each passed separately with the **same** private temp root: Dev 1/1 (3,055 ms),
Job 1/1 (344 ms). Those retries do not make the full run green. These test files,
Dev lifecycle source and Job runtime source are unchanged from the starting revision.
Worktree-local logs are `.sporades/issue-120/ken-final-complete-suite.log`,
`ken-dev-timeout-retry.log` and `ken-job-retry.log`.

An earlier completed run using a long worktree-local temp path also failed:
2,952 tests, 2,735 passed, 10 failed, 207 skipped. Its environment-specific failures
were five overlong ClamAV socket paths, four prerender compiler/package-boundary
failures and a standalone-entrypoint package warning. This is separate from the
final private-root result above. Other interrupted environment trials are not
complete results and are not counted as passes.

To reproduce the final environment, create a short owner-only root and explicitly
set its group before launching the suite; guard setup failures so an empty `TMPDIR`
cannot silently fall back to `/tmp`:

```sh
ken_test_tmp="$(node --input-type=module -e "import {mkdtempSync,chownSync,chmodSync} from 'node:fs'; const p=mkdtempSync('/tmp/ken204-'); chownSync(p,process.getuid(),process.getgid()); chmodSync(p,0o700); console.log(p)")" &&
test -n "$ken_test_tmp" &&
SPORADES_CONFIG_DIR="$PWD/.ken-config" TMPDIR="$ken_test_tmp" COPYFILE_DISABLE=1 npm test
```

## Operator follow-up and scope

Rebuild and restart long-ID Capsules using an older runtime that truncated identity
to 80 characters; old immutable bundles do not acquire the fix merely by replacing
the Monitoring stack. Apply the corrected generated monitoring assets and reload
the stack. Operators must verify their actual notification channel.

This round used local fakes and a single Docker Desktop VM only. It did not use
real Host profiles, SSH, cloud provisioning or a production canary, and does not
revalidate the earlier author's separate-VM evidence. The parent release's real
separate-VM and production acceptance remain manager-owned. Task-owned Compose
resources and the port-5218 documentation preview were stopped after validation.
