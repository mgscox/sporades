Status: ready-for-agent

# Document MinIO Storage And File References

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Document MinIO-backed storage as a local Capsule service and explain the File path, File reference, and S3-compatible adapter model. The docs should make clear that app/client APIs use Sporades file concepts while backend storage locations and public/private read routes remain runtime-owned implementation details.

## Acceptance criteria

- [ ] Product docs describe `services.storage` with MinIO configuration.
- [ ] Product docs explain absolute File paths, File references, Default File bucket fallback, overwrite/delete identity behavior, and File version cache busting.
- [ ] User-facing docs show uploads with explicit File paths and omitted-path Default File bucket behavior.
- [ ] Runtime layout docs describe generated MinIO Compose state and persistent storage location under `.sporades/`.
- [ ] User-facing docs explain that local filesystem storage remains the default.
- [ ] Docs explain that `files.storagePath` configures only the local filesystem storage adapter, not File path semantics or generic storage behavior.
- [ ] Docs state that File metadata exposes logical File paths and must not expose filesystem locations, object keys, Object buckets, or generated runtime read URLs as storage locations.
- [ ] Docs state that MinIO service connection details are server-only runtime plumbing and must not appear in client bundles or app authoring APIs.
- [ ] Docs state that public and private file URLs remain Sporades HTTP routes, not presigned MinIO or S3 URLs.
- [ ] Docs capture the future AWS S3 expectation: adapter/config wiring only, without changing file runtime call sites or app/client APIs.
- [ ] Documentation tests are updated to cover the new storage service and File reference language.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/06-verify-minio-file-lifecycle-parity.md
