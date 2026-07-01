# Unregister Hosted Capsules with a cleanup TTL

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add a reversible unregister command for Hosted Capsules. Unregistering should remove the Capsule from active routing and lifecycle management without deleting its release or data directories. The Host server should keep a tombstone-style registry record with a cleanup deadline 90 days in the future so a later maintenance job can remove forgotten Capsule storage.

## Acceptance criteria

- [ ] `sporades host unregister <subname> --host <alias> --json` unregisters an existing Hosted Capsule through the remote Host helper.
- [ ] Unregister stops and removes any running Hosted Capsule container before removing or disabling the Capsule route.
- [ ] Unregister preserves release directories, persistent data, and enough registry metadata to identify the unregistered Hosted Capsule.
- [ ] The registry record is marked as unregistered and includes a cleanup deadline 90 days in the future, for example `deleteAfter`.
- [ ] Unregistered Capsules no longer appear as active registered Capsules in normal `host list` output, or are clearly marked as unregistered if list output includes them.
- [ ] Re-running unregister for an already unregistered Capsule is idempotent and returns structured JSON.
- [ ] Tests cover successful unregister, unregister with a running container, duplicate unregister, missing Capsule failure, route removal/disablement, registry TTL metadata, and JSON/plain output.

## Blocked by

None - can start immediately
