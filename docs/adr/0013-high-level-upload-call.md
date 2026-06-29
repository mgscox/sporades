# High-level upload call hides upload URL negotiation

v2 upload support exposes a high-level, app-scoped Sporades client SDK upload call to app code, while the SDK internally asks the server for an upload URL and transfers bytes to that URL. The call returns file metadata such as ID, size, MIME type, original filename, and storage URL/path where appropriate; app code then uses normal mutations to attach that metadata to domain rows.

Uploaded files are private by default, scoped to the current user ID, and stored under a user-scoped `default` bucket in v2. Apps can explicitly generate public file URLs, but each URL is a server-managed record that must specify exactly one expiry choice: `ttlSeconds`, `expires` as a valid ISO string, or `noExpiry: true`; URLs can be revoked before expiry. The SDK also owns private file access through `files.url(fileId)`, `files.download(fileId)`, `files.delete(fileId)`, and replacement via `files.upload(file, { replace: true, fileId })`. Replacement preserves the file ID but creates a new file version so stale private and public URLs cannot keep serving cached bytes. This keeps app code independent of local storage, S3-style presigned URLs, or future storage backends while avoiding table-scoped or field-scoped file semantics in v2.

Direct URL access returns `404 Not Found` for missing, deleted, expired, revoked, or unauthorized files to avoid leaking file existence or access state. SDK operations return Sporades structured JSON errors instead.

Upload progress and completion are app-facing through SDK callbacks or events. Raw WebSocket upload notifications are transport plumbing and are not the public API for app code.

`files.upload()` may accept an array of files as a convenience, but those uploads run sequentially through the same single-file path.

Deleting a file immediately soft-deletes metadata, revokes public file URLs, and removes stored bytes on a best-effort basis. Replacing a file updates size, MIME type, and original filename from the new bytes while preserving file ID, owner, and bucket. v2 includes a conservative configurable maximum file size, but leaves virus scanning and content moderation hooks to a future version.
