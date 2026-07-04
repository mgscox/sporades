Status: ready-for-agent

# Expose File References In ACL Storage Helpers

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Extend `ctx.acl.storage.get()` and `ctx.acl.storage.exists()` so ACL rules can inspect file metadata by File reference: either File ID or absolute File path. The helpers should expose stable file metadata resources without leaking runtime table names or provider storage details.

This slice should support ACL rules that check exact File paths or inspect path prefixes in normal policy functions, without adding a glob language, folder API, or provider-specific path semantics.

## Acceptance criteria

- [ ] `ctx.acl.storage.get("files", ref)` resolves a live file by File ID or absolute File path.
- [ ] `ctx.acl.storage.exists("files", ref)` returns whether a live file exists for a File ID or absolute File path.
- [ ] Helper-returned metadata includes absolute File path, File ID, owner, File bucket, status, timestamps, size, MIME type, original name, and version where available.
- [ ] Helpers expose logical File metadata only, not filesystem paths, object keys, Object buckets, runtime table names, or generated read URLs.
- [ ] Missing, deleted, or ambiguous File references resolve as not found.
- [ ] ACL helper read limits and recursion-avoidance behavior remain intact.
- [ ] Tests cover exact File path lookup, File ID lookup, deleted file behavior, missing path behavior, slash-containing paths, and use from a table ACL rule.

## Blocked by

- .scratch/minio-storage-s3-compatible-adapter/issues/02-add-absolute-file-paths-and-file-references.md
