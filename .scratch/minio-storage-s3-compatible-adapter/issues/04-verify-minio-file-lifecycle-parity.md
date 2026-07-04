Status: ready-for-agent

# Verify MinIO File Lifecycle Parity

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Prove that MinIO-backed storage preserves the existing Sporades file lifecycle through current client/server routes and SDK behavior. App and client code should not know or care whether uploaded bytes live in local filesystem storage or MinIO.

This slice is complete when MinIO can be used as a drop-in storage backend for the implemented file features in Dev sessions and local Container sessions.

## Acceptance criteria

- [ ] With MinIO configured, `files.upload()` stores bytes in MinIO and returns the same File metadata shape as local storage.
- [ ] Uploads preserve explicitly specified absolute File paths, including arbitrary-depth names with `/` separators.
- [ ] `files.url`, `files.download`, `files.delete`, and `files.publicUrl` work with File references, including File IDs and absolute File paths.
- [ ] Absolute File path lookups resolve through ACL storage helpers regardless of whether bytes live in local filesystem storage or MinIO.
- [ ] Upload tests cover Default File bucket fallback and default namespace creation for File paths.
- [ ] Writing new bytes to an existing File path overwrites the existing file, keeps a stable logical File path, creates a new File version, and preserves cache-busting behavior.
- [ ] Deleting a file frees its File path; a later write to the same path creates a new File ID.
- [ ] Private file URL creation and authenticated download work through Sporades routes.
- [ ] Public file URL creation, public read, revocation, and expiry validation preserve existing behavior.
- [ ] File replacement preserves the file ID, creates a new version, revokes old public URLs, and makes stale URLs return `404`.
- [ ] File delete soft-deletes metadata, revokes public URLs, best-effort removes bytes, and preserves existing structured errors.
- [ ] Missing, deleted, revoked, expired, stale, or unauthorized direct reads return `404` without leaking existence.
- [ ] Integration coverage exercises MinIO-backed file lifecycle in a Dev session.
- [ ] Local Container coverage proves MinIO service env and network wiring are usable by the bundled runtime.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/03-implement-s3-compatible-storage-adapter-for-minio.md
