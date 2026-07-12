# Sporades v2 Additions

## Overview

Sporades v2 expands the local-first app platform beyond simple data-backed capsules. The release should add durable user-uploaded files, more intentional scaffold selection, a guestbook template, and provider-backed authentication beyond anonymous sessions.

These additions keep the core Sporades principles intact: the CLI remains the primary interface, the server owns trusted behavior, clients talk through stable platform APIs, and extension points should avoid locking current apps into one storage or auth implementation.

## Goals

- Add persistent file upload storage with WebSocket notifications.
- Make `sporades create` support optional template selection while keeping the default scaffold blank.
- Add a `guestbook` template.
- Extend auth beyond anonymous sessions, using Google as the first provider target unless already fully implemented.
- Add SDK-level app messages over the existing client transport.

## Non-Goals

- Do not require S3 or other remote object storage in v2; design for it without making it mandatory.
- Do not add a dashboard or browser-based project setup flow.
- Do not introduce remote hosting as part of this release.
- Do not bundle broad production hardening, observability, vector storage, or background jobs into v2.

## File Upload Storage

Apps need a durable way to accept user uploads. App code should call a high-level Sporades client SDK upload function. Inside that function, the client SDK must always ask the Sporades server for an upload URL before transferring bytes. The returned URL may point to the local Sporades server in v2, but this must remain an SDK-internal storage detail so future backends such as S3 do not change app code.

The upload flow should be:

1. App code calls the Sporades client SDK upload function.
2. The client SDK requests an upload URL from the server.
3. Server returns upload metadata and an upload URL.
4. The client SDK uploads bytes to that URL.
5. Server persists file metadata.
6. Server sends WebSocket notifications when upload state changes.
7. The client SDK resolves with Sporades-owned file metadata.

Uploads are app-scoped in v2, not tied directly to schema fields or tables. The upload call should return reasonable file metadata such as ID, file size, MIME type, original filename, and storage URL/path where appropriate. App code is responsible for using normal mutations to store any file references on domain tables.

Uploaded files are private by default and scoped to the current user ID. v2 storage should use buckets from the outset to preserve a clean path to future storage backends, but only expose one bucket per user named `default`.

Apps may generate a public file URL for a private file. Public file URLs must be created explicitly and must specify expiry using exactly one of `ttlSeconds: <number>`, `expires: <valid ISO string>`, or `noExpiry: true`. The public URL API must not choose a silent default expiry. The server owns public file URL records, TTL enforcement, and revocation. Creating a public file URL does not change the underlying file ownership or bucket scope.

The file SDK should support private reads and lifecycle operations:

- `files.url(fileId)` returns an authenticated private read URL or SDK-managed URL suitable for browser use.
- `files.download(fileId)` downloads the private file through the SDK.
- `files.delete(fileId)` deletes a private file the current user owns.
- `files.upload(file, { replace: true, fileId })` replaces an existing private file while preserving the explicit file identity.

Replacing a file must bust caches. The file ID remains stable, but the stored bytes receive a new file version. Previously generated private read URLs and public file URLs must not continue serving stale content after replacement; callers should request fresh URLs after replacing a file.

Direct URL access for missing, deleted, expired, revoked, or unauthorized files should return `404 Not Found`. SDK file operations should return normal Sporades structured JSON errors with actionable hints.

Upload progress and completion should be app-facing through SDK callbacks or SDK events. The server may send underlying WebSocket messages, but those messages are transport plumbing and should not be exposed as the normal app API.

`files.upload()` may accept an array of files as a convenience, but the SDK should execute those uploads sequentially through the same single-file upload path.

File deletion should immediately soft-delete metadata, revoke public file URLs, and remove stored bytes on a best-effort basis. Replacement should update size, MIME type, and original filename from the new file while preserving file ID, owner, and bucket. v2 should include a conservative configurable maximum file size, but should not include virus scanning or content moderation hooks.

## App Messages

Sporades should allow app-defined messages over the existing WebSocket transport without exposing raw WebSocket objects. App and server code should provide unprefixed app message type names, and Sporades should own adding and reserving the internal `app.` prefix. The client SDK should expose send and subscribe/filter primitives, for example `onMessage().filter((message) => message.type === "whatever")`.

App messages are scoped to the current user's connected clients by default. App-wide broadcast with `{ scope: "all" }` is allowed from server code only. Targeted delivery must be explicit, using shapes such as `{ scope: "users", userIds: [...] }`, and must be authorized server-side when it originates from a client action.

Server code should send app messages through context, for example `ctx.messages.send({ type: "whatever", data, scope })`, so messaging inherits the current runtime/auth context rather than relying on global imports.

Client-origin app messages must always be mediated by server code. The platform should not directly relay arbitrary client messages to other clients without a server handler authorizing and shaping the outgoing message.

Client-origin app messages should enter server code through declared capsule handlers, parallel to queries and mutations, for example `capsule({ messages: { typing: message((ctx, data) => ...) } })`. This keeps app messages typed, discoverable, and testable.

Message handlers may return a response to the originating SDK call. Fan-out remains explicit through `ctx.messages.send()`. v2 app messages are ephemeral and JSON-serializable only; durable events should go through tables and mutations, while binary payloads should use `files.*`.

App messages are not a replacement for queries, mutations, auth, or file APIs. They are an escape hatch for app-level real-time events that do not fit the core data APIs.

Local dev and container sessions should both persist uploaded files across restarts. Storage location and metadata ownership should be clearly documented so app authors know what is platform-managed.

## Scaffold Templates

`sporades create` should accept `--template <name>`.

Without `--template`, Sporades should create a simple blank app. The blank app should be runnable and idiomatic, but should avoid implying a specific product shape such as todos.

Initial v2 templates:

- `blank` as the implicit default.
- `todo` for the existing full-stack todo example.
- `guestbook` for a shared authenticated feed.

Template validation should use structured errors and hints consistent with the rest of the CLI.

## Guestbook Template

Add a guestbook scaffold:

- An `entries` table with body and server-owned author metadata.
- A shared entries query ordered newest first.
- A sign mutation that trims and bounds user input.
- Server-side authorship from `ctx.auth`, not client-submitted fields.
- A client UI that shows auth state, recent entries, and a sign form.
- A visible Google sign-in path that exercises the real redirect-based provider auth flow in a live scaffolded site.

The template should demonstrate why provider auth matters while still working acceptably for anonymous sessions. Guestbook is the v2 live-site acceptance test for Google authentication: anonymous users can sign, Google-linked users show richer author metadata, and the redirect flow should work without app code knowing OAuth details. Use `ctx.auth.picture` when available; do not add avatar uploads to the guestbook template.

## Provider Auth

Sporades should support auth beyond anonymous sessions. Treat existing Google-auth claims as untrusted until verified against the actual runtime and scaffolded client code.

Current investigation notes:

- The scaffolded client has no visible login/sign-in option.
- The generated client runtime exposes auth state, but no public provider sign-in command.
- The server has a WebSocket `auth.signInWithGoogle` redirect message, but no real callback or code exchange.
- The server also accepts `auth.completeGoogleSignIn` with a client-supplied profile, which is not a valid trust boundary for Google OAuth.
- The package currently has no `better-auth` dependency installed, despite docs referring to Better Auth.

v2 should implement real provider auth, not merely mark the auth state as linked. Google is the first concrete target. Provider auth must preserve the current anonymous account's data by linking the provider identity to the existing account.

The server owns the entire auth lifecycle: provider configuration, redirect URL generation, callback handling, authorization-code exchange, identity verification, account linking, session persistence, and `ctx.auth` population. The browser client should only call the Sporades client SDK to express user intent, such as "sign in with Google". Login must use full-page redirects, not popup windows. The redirect flow must be hidden behind the Sporades client SDK so app developers do not know or care about OAuth routes, callback details, provider SDKs, Better Auth internals, or token handling.

Provider secrets should live in Server env. `sporades.json` should store env var names, not secret values. The preferred client API is provider-generic, such as `auth.signIn("google")`, so future providers do not require a new top-level client method. The SDK should preserve the current browser URL before redirect and restore it after auth completes.

## Future Markers

The following items are intentionally recorded for later versions, not v2. Planning artifacts live under `.scratch/post-v2-platform-hardening-and-ops/`.

- Move from `.env` files to hardened secrets.
- Harden the Docker build, including read-only folders where appropriate.
- Harden the server, including CORS and helmet-style defaults.
- Add automatic OpenTelemetry so agents can monitor running apps.
- Add JSON server logging to a centralized logger so agents can watch.
- Gracefully restart the server on unhandled rejection and similar fatal paths.
- Add SQLite vector extension support for AI tasks.
- Add a job queue using something like Bull.
- Add job scheduling with a cron-like system.
