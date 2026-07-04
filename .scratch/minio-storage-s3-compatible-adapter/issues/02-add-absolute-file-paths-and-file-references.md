Status: ready-for-agent

# Add Absolute File Paths And File References

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Add absolute File path support to the `files` API while preserving File ID compatibility through File references. Uploads should be addressed by absolute Capsule-scoped File paths, and existing-file operations should accept either a File ID or an absolute File path when the reference resolves to one live file.

This slice should make path behavior feel like ordinary file writes without exposing filesystem paths, object keys, Object buckets, or runtime read URLs as File metadata.

## Acceptance criteria

- [ ] Upload calls can specify an absolute File path.
- [ ] Uploads without an explicit File path use the uploaded file name in the Default File bucket, with an `upload`-style fallback when no name exists.
- [ ] Writes create missing namespace pieces needed for a File path by default without introducing a public folder API.
- [ ] File paths are unique, absolute, Capsule-scoped logical names and may contain arbitrary-depth `/` separators.
- [ ] Path resolution treats an existing first segment as the File bucket; otherwise it resolves under the Default File bucket.
- [ ] Writing to an existing live File path overwrites the existing file, preserves the File ID, creates a new File version, and preserves cache-busting behavior.
- [ ] Deleting a file frees its File path; a later write to the same path creates a new File ID.
- [ ] Existing-file operations such as private URL creation, download, delete, and public URL creation accept File references: either File ID or absolute File path.
- [ ] A File reference must resolve to exactly one live file before the operation proceeds.
- [ ] File metadata exposes its absolute File path and stable File ID.
- [ ] Tests cover explicit paths, omitted paths, Default File bucket fallback, overwrite, delete-then-recreate, File ID references, File path references, and unresolved references.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/01-extract-local-file-storage-adapter.md
