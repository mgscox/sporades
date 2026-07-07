Status: done

# Harden File Metadata And Upload Writes

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Verify and fix transaction coverage for file metadata workflows, including
pending upload creation, upload completion, replacement, public URL creation and
revocation, file deletion, upload supersession, and metadata updates that are
paired with file-byte side effects. File deletion should make File metadata and
Public file URL reachability change as one database outcome; physical byte
removal may remain later or best-effort cleanup. When file bytes are written
successfully but database metadata completion fails, Sporades should remove the
newly written File version bytes where possible and leave the previous File
metadata/version as the live state.

## Acceptance criteria

- [x] Pending upload creation remains atomic for path lock, stale pending upload cleanup, and pending upload insertion.
- [x] Upload completion does not leave inconsistent file metadata when completion, public URL revocation, or supersession handling fails.
- [x] Failed upload completion after byte write removes the newly written File version bytes where possible and leaves the previous File metadata/version unchanged.
- [x] Public URL creation, public URL revocation, and file deletion have explicit transaction or intentional single-statement classification.
- [x] Public file URL creation is atomic across file ownership/live-version validation and URL record creation, either through one transaction or one conditional database statement.
- [x] File deletion marks File metadata deleted and revokes Public file URLs as one database outcome; physical byte removal is not required for deletion to be visible.
- [x] File-byte side effects that cannot share a database transaction have tested compensating cleanup behavior.
- [x] Tests cover at least one failure path where database metadata and file-storage side effects could otherwise diverge.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md
