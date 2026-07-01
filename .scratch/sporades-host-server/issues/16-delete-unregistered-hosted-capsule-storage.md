# Delete unregistered Hosted Capsule storage

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add irreversible deletion for Hosted Capsules, but only after they have already been unregistered. Deletion is the second step in a deliberate two-step process: users must unregister first, then delete the unregistered Capsule storage. This should prevent accidental destruction of a live or merely stopped Hosted Capsule.

## Acceptance criteria

- [x] `sporades host delete <subname> --host <alias> --json` deletes only Hosted Capsules whose registry state is already unregistered.
- [x] Delete refuses registered, running, stopped, or released Hosted Capsules that have not first gone through `host unregister`.
- [x] Delete removes the unregistered Capsule registry/tombstone record, release directories, persistent data directory, and any remaining route file.
- [x] Delete is safe to retry after partial cleanup and returns structured JSON describing what was removed or already absent.
- [x] Delete never removes unrelated Hosted domain directories or other Capsule state.
- [x] Tests cover refusal for registered Capsules, successful deletion after unregister, idempotent retry, partial cleanup recovery, and JSON/plain output.

## Blocked by

- .scratch/sporades-host-server/issues/15-unregister-hosted-capsules-with-cleanup-ttl.md
