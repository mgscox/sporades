Status: ready-for-agent

# Extract LocalFileStorageAdapter

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Introduce an internal Storage adapter boundary for uploaded file bytes and move the current local filesystem byte behavior behind a `LocalFileStorageAdapter` without changing app-facing file behavior.

The completed slice should make local filesystem storage a concrete implementation of the same runtime contract that future object storage backends will use. File metadata remains stored through the Database adapter; the Storage adapter owns only byte storage lifecycle.

## Acceptance criteria

- [ ] Runtime upload, private read, public read, delete, replacement, and storage health paths use a Storage adapter rather than direct filesystem byte helpers.
- [ ] Local filesystem storage remains the default when no storage Capsule service is configured.
- [ ] `LocalFileStorageAdapter` preserves the existing Runtime directory byte layout.
- [ ] `files.storagePath` configures only `LocalFileStorageAdapter` and is not part of File metadata, File path semantics, or the generic Storage adapter contract.
- [ ] File metadata continues to be created, updated, read, and soft-deleted through the Database adapter.
- [ ] File metadata does not expose `LocalFileStorageAdapter` filesystem locations.
- [ ] No public app, client, or plugin API is introduced by the adapter extraction.
- [ ] Existing file lifecycle tests pass without changing expected app-facing responses.
- [ ] Focused tests prove the local Storage adapter can write, read, delete, health-check, and close through the new contract.

## Blocked by

None - can start immediately
