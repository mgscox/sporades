# Record Hosted Capsule release history

Status: done

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Record durable release history for each Hosted Capsule so developers and agents
can inspect which releases were pushed, which release is current, when each
release started, and whether a release succeeded or failed. This is the minimum
release model needed for rollback and verified autodeploy.

Use a small explicit state vocabulary so later rollback, verification, and
GitHub reporting work from the same model:

- `uploaded` - release files reached the Host server but have not been started.
- `started` - the release was started or restarted at least once.
- `verified` - the release passed `host push --verify` health checks.
- `failed` - start or verification failed for this release.

The current release pointer should remain a distinct field on the Hosted
Capsule record or equivalent Host-server-owned state. A release can be
non-current and still keep its historical state.

## Acceptance criteria

- [ ] Each successful Host push records a release entry for the target Hosted Capsule.
- [ ] Release history includes a stable release ID, creation time, current/non-current marker, source metadata when available, and one of `uploaded`, `started`, `verified`, or `failed`.
- [ ] Release history records timestamps for upload, start attempts, verification attempts, and failure details when those events occur.
- [ ] `sporades host releases <subname> --json` lists releases in a deterministic order and marks the current release.
- [ ] Existing Hosted Capsules without release-history metadata remain inspectable and receive release history on the next push.
- [ ] Release history is stored in Host-server-owned state and survives helper restarts.
- [ ] Tests cover release recording, current release marking, listing output, compatibility with existing state, and malformed registry recovery behavior.

## Blocked by

None - can start immediately
