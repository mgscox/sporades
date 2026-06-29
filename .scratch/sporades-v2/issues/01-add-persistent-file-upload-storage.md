# Add persistent file upload storage

Status: done

## What to build

Add a Sporades-owned file upload flow that persists uploaded files and notifies connected clients over WebSocket as upload state changes. App code should call a high-level Sporades client SDK upload function. The SDK should never assume where bytes are stored; internally, it must ask the server for an upload URL, then upload to that URL.

Uploads are app-scoped in v2. The upload call returns file metadata; app code uses normal mutations to attach that metadata or file ID to its own domain rows.

Uploaded files are private by default, scoped to the current user ID, and stored in that user's `default` bucket. Public access is opt-in through server-managed public file URL records with an explicit expiry choice. The server owns TTL enforcement and revocation.

## Acceptance criteria

- [x] The client SDK exposes a high-level upload call that accepts a browser file/blob and returns Sporades-owned file metadata.
- [x] `files.upload()` accepts an array of files as a convenience.
- [x] Array uploads execute sequentially through the single-file upload path.
- [x] Returned file metadata includes a stable file ID, file size, MIME type, original filename, and a storage URL/path when appropriate.
- [x] Uploads are app-scoped rather than table-scoped or field-scoped.
- [x] Uploaded files are private by default.
- [x] Uploaded files are scoped to the current user ID.
- [x] Storage is structured around buckets from the outset.
- [x] v2 creates or uses one user-scoped bucket named `default`.
- [x] The client SDK exposes a way to generate a public file URL for a private file.
- [x] Public file URL creation requires either a TTL or an explicit no-expiry setting.
- [x] Public file URL creation accepts `ttlSeconds: <number>`.
- [x] Public file URL creation accepts `expires: <valid ISO string>`.
- [x] Public file URL creation accepts `noExpiry: true`.
- [x] Public file URL creation fails with a structured error unless exactly one of `ttlSeconds`, `expires`, or `noExpiry` is provided.
- [x] Public file URL creation does not use a silent default expiry.
- [x] Public file URLs are stored as server-managed records.
- [x] The server enforces public file URL TTLs.
- [x] Public file URLs can be revoked before expiry.
- [x] Public file URLs do not change the underlying private file ownership or bucket scope.
- [x] The client SDK exposes `files.url(fileId)` for private file reads.
- [x] The client SDK exposes `files.download(fileId)` for private file downloads.
- [x] The client SDK exposes `files.delete(fileId)` for deleting a private file owned by the current user.
- [x] The client SDK supports `files.upload(file, { replace: true, fileId })` to replace an existing private file.
- [x] Replacing a file preserves the file ID.
- [x] Replacing a file updates size, MIME type, and original filename from the new file.
- [x] Replacing a file preserves owner and bucket.
- [x] Replacing a file creates a new file version or equivalent cache-busting identity.
- [x] Previously generated private read URLs do not continue serving stale content after replacement.
- [x] Previously generated public file URLs do not continue serving stale content after replacement.
- [x] Callers can request fresh URLs after replacement.
- [x] Private read, download, delete, and replace operations enforce current-user ownership on the server.
- [x] Deleting a file immediately soft-deletes metadata.
- [x] Deleting a file revokes all public file URLs for that file.
- [x] Deleting a file removes stored bytes on a best-effort basis.
- [x] Direct URL access for missing, deleted, expired, revoked, or unauthorized files returns `404 Not Found`.
- [x] SDK file operations return structured JSON errors with actionable hints.
- [x] v2 includes a conservative configurable maximum file size.
- [x] v2 does not include virus scanning or content moderation hooks.
- [x] The client is responsible for calling mutations to store file IDs or metadata on app tables.
- [x] App code does not need to request, inspect, or store upload URLs.
- [x] Internally, the client SDK requests an upload URL from the Sporades server.
- [x] The upload URL response includes enough metadata for the SDK to perform the upload and correlate later status notifications.
- [x] The v2 local storage backend persists uploaded bytes across dev session and container session restarts.
- [x] File metadata is persisted server-side and associated with the current authenticated user where relevant.
- [x] Server-side upload state changes produce internal notifications, including progress where available, success, and failure.
- [x] The client SDK exposes app-facing upload callbacks or events for progress, completion, and failure.
- [x] App code does not need to subscribe to raw upload WebSocket messages.
- [x] Raw upload WebSocket messages are treated as transport plumbing rather than the public app API.
- [x] The SDK API shape can support a future S3-style backend without changing app upload call sites.
- [x] Upload failures return structured errors with actionable hints.
- [x] Documentation explains which upload files and metadata are platform-managed.

## Blocked by

None - can start once v2 storage API shape is agreed.
