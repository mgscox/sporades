# Handle fatal runtime paths with restart policy

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define how dev sessions and container sessions respond to fatal runtime paths such as unhandled rejections, uncaught exceptions, and failed lifecycle hooks.

Restart policy should apply across Dev sessions, local Container sessions, and
Hosted Capsules, with mode-specific behavior. Dev sessions should favor fast
feedback and automatic restart. Container sessions should use bounded backoff
and structured status. Hosted Capsules should use bounded backoff and, after
the retry limit is reached, either route to the Hosted Capsule unavailable
response or follow an explicit per-Capsule fallback policy.

Hosted Capsules may support a configured fallback to the prior release when a
new current release exhausts its restart limit during release verification.
This must be explicit Capsule configuration, not the default silent behavior.
Automatic fallback should not apply to arbitrary later runtime crashes after a
release has already been verified or accepted.

## Acceptance criteria

- [ ] A future PRD defines which fatal paths trigger restart versus process exit.
- [ ] Restart policy covers Dev sessions, local Container sessions, and Hosted Capsules with mode-specific behavior.
- [ ] The design describes how restarts interact with lifecycle hooks.
- [ ] The design records CLI and JSON output for fatal events and restart attempts.
- [ ] The design covers retry limits or backoff to avoid restart loops.
- [ ] Hosted Capsules define what happens after retry exhaustion: unavailable response by default, with optional configured fallback to the prior release only during release verification.
- [ ] Any fallback to a prior release is recorded in release history and surfaced in structured logs and CLI output.
- [ ] Runtime crashes after a release has been verified or accepted do not trigger automatic fallback; they use restart/backoff, structured failure output, and the Hosted Capsule unavailable response when exhausted.
- [ ] v2 does not change fatal-path restart behavior unless maintainers explicitly promote this marker.

## Notes

This marker should respect ADR-0009's process restart and lifecycle-hook vocabulary.
