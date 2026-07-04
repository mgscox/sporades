Status: ready-for-agent

# Extract Local File Bytes Behind Storage Adapter

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Introduce an internal Storage adapter boundary for uploaded file bytes and route the existing local filesystem behavior through it while preserving existing `files` SDK behavior and adding explicit File bucket selection.

The completed slice should make local filesystem storage a concrete implementation of the same runtime contract that future object storage backends will use. File metadata remains stored through the Database adapter; the new Storage adapter owns only byte storage lifecycle.

## Acceptance criteria

- [ ] Runtime upload, private read, public read, delete, replacement, and storage health paths use a Storage adapter rather than direct filesystem byte helpers.
- [ ] Local filesystem storage remains the default when no storage Capsule service is configured.
- [ ] The LocalFileStorageAdapter preserves the existing Runtime directory byte layout and owns `files.storagePath` behavior.
- [ ] Upload calls can specify an absolute File path; writes create missing namespace pieces by default and use Default File bucket fallback where applicable.
- [ ] File operations that address an existing file accept File references: either File ID or absolute File path.
- [ ] File paths may contain `/` separators and are stored as unique logical names rather than filesystem/provider path instructions.
- [ ] File metadata exposes its absolute File path.
- [ ] File metadata does not expose LocalFileStorageAdapter filesystem locations.
- [ ] `ctx.acl.storage.get()` and `ctx.acl.storage.exists()` can address files by File reference.
- [ ] Writes create any missing namespace pieces needed for a File path without introducing a public folder API.
- [ ] Writing to an existing File path overwrites the existing file and creates a new File version.
- [ ] Deleting a file frees its File path for a future write, which creates a new File ID.
- [ ] Uploads without an explicit File path use the uploaded file name in the Default File bucket, with an `upload`-style fallback when no name exists.
- [ ] Path resolution treats an existing first segment as the File bucket; otherwise it resolves under the Default File bucket.
- [ ] File metadata continues to be created, updated, read, and soft-deleted through the Database adapter.
- [ ] No public app, client, or plugin API is introduced.
- [ ] Existing file lifecycle tests pass without changing expected app-facing responses.
- [ ] Focused tests prove the local Storage adapter can write, read, delete, health-check, and close through the new contract.

## Blocked by

None - can start immediately
