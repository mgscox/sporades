# Add persistent file upload storage

Status: needs-triage

## What to build

Add a Sporades-owned file upload flow that persists uploaded files and notifies connected clients over WebSocket as upload state changes. App code should call a high-level Sporades client SDK upload function. The SDK should never assume where bytes are stored; internally, it must ask the server for an upload URL, then upload to that URL.

Uploads are app-scoped in v2. The upload call returns file metadata; app code uses normal mutations to attach that metadata or file ID to its own domain rows.

Uploaded files are private by default, scoped to the current user ID, and stored in that user's `default` bucket. Public access is opt-in through server-managed public file URL records with an explicit expiry choice. The server owns TTL enforcement and revocation.

## Acceptance criteria

- [ ] The client SDK exposes a high-level upload call that accepts a browser file/blob and returns Sporades-owned file metadata.
- [ ] `files.upload()` accepts an array of files as a convenience.
- [ ] Array uploads execute sequentially through the single-file upload path.
- [ ] Returned file metadata includes a stable file ID, file size, MIME type, original filename, and a storage URL/path when appropriate.
- [ ] Uploads are app-scoped rather than table-scoped or field-scoped.
- [ ] Uploaded files are private by default.
- [ ] Uploaded files are scoped to the current user ID.
- [ ] Storage is structured around buckets from the outset.
- [ ] v2 creates or uses one user-scoped bucket named `default`.
- [ ] The client SDK exposes a way to generate a public file URL for a private file.
- [ ] Public file URL creation requires either a TTL or an explicit no-expiry setting.
- [ ] Public file URL creation accepts `ttlSeconds: <number>`.
- [ ] Public file URL creation accepts `expires: <valid ISO string>`.
- [ ] Public file URL creation accepts `noExpiry: true`.
- [ ] Public file URL creation fails with a structured error unless exactly one of `ttlSeconds`, `expires`, or `noExpiry` is provided.
- [ ] Public file URL creation does not use a silent default expiry.
- [ ] Public file URLs are stored as server-managed records.
- [ ] The server enforces public file URL TTLs.
- [ ] Public file URLs can be revoked before expiry.
- [ ] Public file URLs do not change the underlying private file ownership or bucket scope.
- [ ] The client SDK exposes `files.url(fileId)` for private file reads.
- [ ] The client SDK exposes `files.download(fileId)` for private file downloads.
- [ ] The client SDK exposes `files.delete(fileId)` for deleting a private file owned by the current user.
- [ ] The client SDK supports `files.upload(file, { replace: true, fileId })` to replace an existing private file.
- [ ] Replacing a file preserves the file ID.
- [ ] Replacing a file updates size, MIME type, and original filename from the new file.
- [ ] Replacing a file preserves owner and bucket.
- [ ] Replacing a file creates a new file version or equivalent cache-busting identity.
- [ ] Previously generated private read URLs do not continue serving stale content after replacement.
- [ ] Previously generated public file URLs do not continue serving stale content after replacement.
- [ ] Callers can request fresh URLs after replacement.
- [ ] Private read, download, delete, and replace operations enforce current-user ownership on the server.
- [ ] Deleting a file immediately soft-deletes metadata.
- [ ] Deleting a file revokes all public file URLs for that file.
- [ ] Deleting a file removes stored bytes on a best-effort basis.
- [ ] Direct URL access for missing, deleted, expired, revoked, or unauthorized files returns `404 Not Found`.
- [ ] SDK file operations return structured JSON errors with actionable hints.
- [ ] v2 includes a conservative configurable maximum file size.
- [ ] v2 does not include virus scanning or content moderation hooks.
- [ ] The client is responsible for calling mutations to store file IDs or metadata on app tables.
- [ ] App code does not need to request, inspect, or store upload URLs.
- [ ] Internally, the client SDK requests an upload URL from the Sporades server.
- [ ] The upload URL response includes enough metadata for the SDK to perform the upload and correlate later status notifications.
- [ ] The v2 local storage backend persists uploaded bytes across dev session and container session restarts.
- [ ] File metadata is persisted server-side and associated with the current authenticated user where relevant.
- [ ] Server-side upload state changes produce internal notifications, including progress where available, success, and failure.
- [ ] The client SDK exposes app-facing upload callbacks or events for progress, completion, and failure.
- [ ] App code does not need to subscribe to raw upload WebSocket messages.
- [ ] Raw upload WebSocket messages are treated as transport plumbing rather than the public app API.
- [ ] The SDK API shape can support a future S3-style backend without changing app upload call sites.
- [ ] Upload failures return structured errors with actionable hints.
- [ ] Documentation explains which upload files and metadata are platform-managed.

## Blocked by

None - can start once v2 storage API shape is agreed.
