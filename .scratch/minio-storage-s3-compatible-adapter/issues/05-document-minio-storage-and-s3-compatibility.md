Status: ready-for-agent

# Document MinIO Storage And S3 Compatibility

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Document MinIO-backed storage as a local Capsule service and explain the S3-compatible adapter intent for future AWS S3 support. The docs should make clear that app/client APIs remain unchanged and that public/private reads still go through Sporades-owned routes.

## Acceptance criteria

- [ ] Product docs describe `services.storage` with MinIO configuration.
- [ ] Product docs explain absolute File paths, File references, Default File bucket fallback, and overwrite/delete identity behavior.
- [ ] Runtime layout docs describe generated MinIO Compose state and persistent storage location under `.sporades/`.
- [ ] User-facing docs explain that local filesystem storage remains the default.
- [ ] Docs explain that `files.storagePath` configures only the local filesystem storage adapter, not File path semantics or generic storage behavior.
- [ ] Docs state that MinIO service connection details are server-only runtime plumbing and must not appear in client bundles or app authoring APIs.
- [ ] Docs state that public and private file URLs remain Sporades HTTP routes, not presigned MinIO or S3 URLs.
- [ ] Docs capture the future AWS S3 expectation: adapter/config wiring only, without changing file runtime call sites or app/client APIs.
- [ ] Documentation tests are updated to cover the new storage service language.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/04-verify-minio-file-lifecycle-parity.md
