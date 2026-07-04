# MinIO Storage Via S3-Compatible Adapter

Status: ready-for-agent

## Overview

Add an internal Storage adapter boundary for uploaded file bytes. Local filesystem storage remains the default. A Capsule can declare `services.storage.engine: "minio"` to provision MinIO for local Dev sessions and local Container sessions, while the runtime talks to a generic S3-compatible adapter shape so future AWS S3 support should require adapter/config wiring only.

## Source Planning

- Conversation plan: MinIO Storage Via S3-Compatible Adapter
- `CONTEXT.md`
- `docs/PRD.md`
- `docs/adr/0013-high-level-upload-call.md`
- `docs/adr/0020-capsule-services-declared-in-sporades-config.md`
- `docs/adr/0021-database-adapter-is-internal-runtime-boundary.md`
- `docs/adr/0024-file-operations-accept-file-references.md`

## Scope

- Extract current uploaded byte storage behind a runtime-owned Storage adapter.
- Keep existing `sporades/client` `files` SDK behavior unchanged.
- Keep file metadata persistence in the Database adapter.
- Keep local filesystem byte storage as the default when no storage service is declared.
- Allow Upload calls to specify an absolute File path, with optional namespace creation and Default File bucket fallback where applicable.
- Expose File path metadata so ACL helpers can inspect files by unique logical address without exposing backend storage paths.
- Allow file operations to accept File references when addressing an existing file. A File reference may be a File ID or absolute File path as long as it resolves to one live file.
- Add `services.storage.kind: "storage"` with `engine: "minio"` to `sporades.json`.
- Generate and manage local MinIO Docker Compose state under `.sporades/`.
- Inject MinIO/S3-compatible connection details as server-only runtime service env.
- Use an S3-compatible adapter implementation for MinIO, including SigV4 HTTP calls, Object bucket setup, object read/write/delete, and health checks.
- Preserve Sporades-owned HTTP routes for private and public file reads.

## Non-Goals

- Do not implement Hosted Capsule MinIO or S3 orchestration in this feature.
- Do not expose presigned MinIO or S3 URLs to app or client code.
- Do not add a public Storage adapter plugin API.
- Do not move file metadata out of the Database adapter.
- Do not implement AWS S3 as a separately supported service in this feature.

## Product Decisions

- Storage backend selection is runtime plumbing, not an app-facing API.
- MinIO is the first service-backed object storage target, but the runtime adapter shape is S3-compatible rather than MinIO-specific.
- Capsule storage must be isolated; the provider adapter owns how that isolation maps onto Object buckets, prefixes, or other backend-specific mechanisms.
- File paths are unique, absolute, Capsule-scoped logical names. They may contain `/` separators for policy and organization, but provider adapters must not require app code to add Capsule-specific prefixes.
- File references must resolve to exactly one live file metadata record before reads, deletes, public URL creation, or overwrites proceed.
- File paths behave like file-system paths at the Sporades API and ACL boundary, but they are not filesystem paths or object keys. Provider adapters own how File paths map to stored bytes.
- Writes create any missing namespace pieces needed for a File path by default. The feature should not introduce a standalone folder model unless implementation requires it.
- Writing new content to an existing File path overwrites that file's bytes and creates a new File version, matching normal filesystem expectations.
- Deleting a file frees its File path for future writes. A later write to that path creates a new File ID; overwriting a live path preserves the existing File ID.
- Uploads without an explicit File path use the uploaded file name in the Default File bucket, falling back to an `upload`-style name when no file name is available.
- When resolving an absolute File path, an existing first segment is treated as the File bucket. If the first segment is not an existing or newly created File bucket, the path resolves under the Default File bucket.
- Stored object keys should be stable file-version paths such as `files/<fileId>/<version>`.
- `files.storagePath` remains supported as LocalFileStorageAdapter configuration only; it is not part of File metadata, File path semantics, or the generic Storage adapter contract.
- Public and private file URLs remain Sporades HTTP routes so authorization, 404 behavior, and cache-busting stay runtime-owned.
- MinIO-specific defaults belong in service provisioning and env construction; file lifecycle code should depend only on the Storage adapter contract.

## User Stories

- As a developer, I can add a MinIO storage service to `sporades.json` and keep using the same `files` SDK calls.
- As an app author, I can choose an absolute File path such as `/images/avatars/profile.png` when uploading, while omitted paths use the uploaded file name in the Default File bucket.
- As an app author, I do not need to know whether uploaded bytes live on local filesystem storage or MinIO.
- As an agent, I can verify MinIO-backed upload, download, replacement, delete, and public URL behavior through existing Sporades commands and routes.
- As a future implementer, I can add AWS S3 support by reusing the S3-compatible adapter shape without changing client/server file APIs.

## Implementation Issues

- `issues/01-extract-local-file-storage-adapter.md`
- `issues/02-add-absolute-file-paths-and-file-references.md`
- `issues/03-expose-file-references-in-acl-storage-helpers.md`
- `issues/04-add-minio-local-capsule-storage-service.md`
- `issues/05-implement-s3-compatible-storage-adapter-for-minio.md`
- `issues/06-verify-minio-file-lifecycle-parity.md`
- `issues/07-document-minio-storage-and-file-references.md`
