# Automatic monitoring completion gate — #107

Status checked on 2026-10-08 against GitHub and the checkout at `ffa5eb6d`.
This record explains why the parent monitoring PRD cannot yet be marked complete.
It adds no runtime behavior and provides no new deployment acceptance evidence.

## Current roadmap status

[#107](https://github.com/mgscox/sporades/issues/107) is the parent specification
for automatic monitoring. Its native blocking-dependency list is empty. Its
textual prerequisite [#49](https://github.com/mgscox/sporades/issues/49) is closed.
An empty blocker list does not establish completion of the PRD's acceptance work.

The implementation roadmap issues #108–#127 and #129–#130 are closed.
[#128 — diagnostics and migration](https://github.com/mgscox/sporades/issues/128)
remains open. The original parent comment describes an earlier milestone ending
at #115; it should not be used as the current status of the later increments.

Diagnostics and migration shipped through
[PR #212](https://github.com/mgscox/sporades/pull/212). The subsequent recovery
repair [#223](https://github.com/mgscox/sporades/issues/223) is closed, and
[PR #224](https://github.com/mgscox/sporades/pull/224) is merged. This record does
not duplicate those implementations or reopen their completed work.

## Remaining acceptance

The [latest #128 handoff](https://github.com/mgscox/sporades/issues/128#issuecomment-6047121207)
identifies one remaining manager-only gate: rerun the separate-VM interrupted
activation scenario after the recovery repair. Follow the existing
[scenario 3 checklist](./telemetry-223-scenario3.md), including:

- Pin the tested commit and verify the actual installed artifact hashes.
- Interrupt the actual activation child and prove autonomous recovery with
  systemd `UMask=0077` while the configuring workstation is powered off.
- Verify restored configuration bytes and public/private file permissions.
- Independently query fresh stored Capsule traces and Capsule, Host and Caddy
  metrics, and confirm inventory acknowledgement.
- Preserve historical queries and verify rollback plus restored and retired
  expectations at the appropriate Monitoring servers.

Local fixtures, Docker backend checks, inventory acknowledgements and successful
HTTP ingestion cannot replace these stored-data and separate-VM observations.
The desk's safety contract prohibits real Host commands, cloud server creation
and using the operator's real monitoring endpoints. The requested draft PR does
not authorize those operations, so this acceptance cannot be completed here.

After the manager records the result and resolves #128, audit the parent PRD's
remaining acceptance evidence, including the rollout/canary, notification and
capacity requirements, before closing #107. Closed implementation issues alone
do not certify all of those observations. This record makes no new claim about
their current outcome.

## Draft disposition

The PR carrying this record remains draft while #107 is incomplete. Its requested
`Closes #107` footer is conditional on completing the parent acceptance; it is
not evidence of completion. Keep the PR draft until the manager's acceptance and
the final parent audit are recorded. The change contains only this research
record, with no changes to APIs, types, monitoring assets or generated runtime
artifacts. Fresh local validation is reported in the PR description separately
from the linked historical evidence.
