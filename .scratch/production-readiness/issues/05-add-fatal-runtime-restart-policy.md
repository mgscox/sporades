# Add fatal runtime restart policy

Status: done

## Parent

.scratch/production-readiness/PRD.md

## What to build

Add fatal runtime restart policy across Dev sessions, local Container sessions,
and Hosted Capsules. Fatal paths such as unhandled rejections, uncaught
exceptions, and failed lifecycle hooks should produce predictable restart,
backoff, status, log, and failure behavior appropriate to each mode.

This slice should deliver an end-to-end path: fatal-path detection, lifecycle
hook interaction, restart/backoff behavior, structured log events, CLI/JSON
status, Hosted Capsule unavailable routing, optional release-verification
fallback, docs, and tests.

## Acceptance criteria

- [x] The implementation defines which fatal paths trigger restart versus process exit.
- [x] Dev sessions restart automatically and emit visible terminal, JSONL, and structured log events.
- [x] Local Container sessions use bounded restart/backoff behavior and expose structured status.
- [x] Hosted Capsules use bounded restart/backoff behavior and expose structured status.
- [x] Restart behavior respects `init()` and `shutdown()` lifecycle hooks.
- [x] Retry limits and backoff avoid infinite restart loops.
- [x] Hosted Capsules route to the Hosted Capsule unavailable response after retry exhaustion by default.
- [x] Hosted Capsules may be configured to fall back to the prior release only during release verification.
- [x] Automatic fallback does not apply to arbitrary later runtime crashes after a release has already been verified or accepted.
- [x] Any fallback to a prior release is recorded in release history and surfaced in structured logs and CLI output.
- [x] Runtime crashes after a release has been verified or accepted use restart/backoff, structured failure output, and unavailable response when exhausted.
- [x] CLI and JSON output report fatal events, restart attempts, retry exhaustion, and fallback decisions.
- [x] Docs cover mode-specific restart behavior, release verification fallback, and operator guidance.
- [x] `docs/ROADMAP.md` is updated to reflect implementation status.

## Blocked by

- .scratch/production-readiness/issues/02-add-centralized-json-logging.md
