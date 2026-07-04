Status: ready-for-agent

# Implement S3-Compatible Storage Adapter For MinIO

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Implement the S3-compatible Storage adapter used when `services.storage.engine: "minio"` is configured. The adapter should use MinIO-provided service env but expose only the generic Storage adapter contract to the file runtime.

The completed slice should make uploaded bytes live in MinIO objects while preserving Sporades-owned metadata, URLs, authorization, and file lifecycle behavior above the adapter.

## Acceptance criteria

- [ ] Runtime selects the S3-compatible Storage adapter when server-only service env identifies MinIO storage.
- [ ] The adapter uses S3-compatible HTTP requests with SigV4 signing and Node built-ins.
- [ ] The adapter supports Object bucket setup, write file version, read file version, best-effort delete file version, health check, and close/no-op lifecycle.
- [ ] MinIO uses path-style URLs and service-provided endpoint, bucket, region, access key, and secret key values.
- [ ] Stored object keys use a stable file-version layout such as `files/<fileId>/<version>`.
- [ ] Capsule storage isolation is enforced by the provider adapter without requiring app code to add Capsule-specific prefixes.
- [ ] Missing objects are translated into the same direct-read `404` behavior as local filesystem storage.
- [ ] MinIO-specific behavior is limited to service provisioning/env defaults, not spread through upload, download, public URL, delete, File path, or ACL helper call sites.
- [ ] Fake S3-compatible service tests cover signing, path-style URLs, Object bucket creation, object read/write/delete, health checks, isolation mapping, and object key layout.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/01-extract-local-file-storage-adapter.md
- .scratch/minio-storage-s3-compatible-adapter/issues/04-add-minio-local-capsule-storage-service.md
