# Files and Realtime Reference

File uploads and publication, App messages, and consented transient User Journey state.

[Back to the feature reference index](../guide/reference.md).

## File Uploads

Use the `files` API from `sporades/client` for browser `File` or `Blob` values:

```tsx
import { files } from "sporades/client";

const explicitPathFile = await files.upload(selectedFile, {
  path: "/photos/profile.jpg",
  onProgress(event) {
    console.log(event.loaded, event.total);
  },
});

const defaultBucketFile = await files.upload(selectedFile);
```

Sporades negotiates and transfers the upload bytes internally.
The returned file metadata includes fields such as `id`, `name`, `type`, `size`,
`path`, and `version`. `path` is the absolute Capsule-scoped File path, not a
runtime URL, filesystem path, object key, or Object bucket location. Passing
`path: "/photos/profile.jpg"` chooses that absolute File path. Omitting `path`
uses the uploaded file name in the Default File bucket, falling back to the
logical `/default/upload` File path when no file name exists.
Uploaded bytes are private by default. Ownership and privacy come from runtime
File metadata and ACL behavior, not from the Default File bucket itself.

If you want to store the file information in a database table,
you must explicitly do so using a normal mutation:

```tsx
// Using existing 'recordPhoto' table
await recordPhoto.run({
  title,
  file,
});
```

Private reads use:

```tsx
const url = await files.url(file.id);
const blob = await files.download(file.path);
```

Private File Bearer authentication is disabled unless the Capsule explicitly
opts in with `files.accessKeys.read`:

```ts
export default capsule({
  name: "reports",
  accessKeys: { scopes: ["reports:read"] },
  files: {
    accessKeys: { read: { scopes: ["reports:read"] } },
  },
});
```

Omit `scopes` from `read: {}` when existing File ownership and File ACL rules
are the complete policy. If scopes are supplied, they must be non-empty,
unique, concrete entries from the Capsule's central `accessKeys.scopes`
vocabulary. Scope grants only narrow admission; they never replace ownership
or File ACL checks.

The private File route accepts either one `x-sporades-session-token` or one
`Authorization: Bearer ...` credential. Dual, malformed, expired, rotated, or
revoked credentials fail without falling back to the Session or Anonymous
actor. File ACL rules receive the same frozen `ctx.auth` and `ctx.credential`
provenance for either kind. Access-key downloads are `private, no-store`, and a
revocation affects the next admission without interrupting bytes whose
admission already completed.

File operations that identify an existing file accept a File reference: either
the stable File ID or the absolute File path. By default, the reference must
resolve to one live file owned by the current user. A Capsule may deliberately
extend normal File access with `files.acl` rules for `read`, `publicUrl`, and
`delete`; the File owner keeps its existing access in all cases.

File ACL rules receive stable File metadata plus the restricted ACL context.
They can use `ctx.acl.teams` with an explicit Team ID carried in the Capsule's
own File-policy model; they cannot access bytes, storage implementation,
mutable Team management, the normal database API, request data, or Privileged
server authority. A membership or active application-role change is evaluated
again for subsequent private URL requests, including a previously returned
private URL.

For example, a Capsule can share files whose paths carry an explicit Team ID:

```ts
export default capsule({
  name: "Team files",
  teams: { appRoles: ["editor", "reviewer"] },
  files: {
    acl: {
      read: ({ file, ctx }) => ctx.acl.teams.isMember(file.path.split("/")[2]),
      publicUrl: ({ file, ctx }) => ctx.acl.teams.isAdmin(file.path.split("/")[2]),
      delete: ({ file, ctx }) => ctx.acl.teams.hasAnyRole(file.path.split("/")[2], ["editor", "reviewer"]),
    },
  },
});
```

This is Capsule policy rather than automatic Team data partitioning: Files do
not gain Team IDs and Team membership alone grants no File access. Rules that
deny access receive the normal opaque File-not-found result.

Create public URLs explicitly:

```tsx
const publicUrl = await files.publicUrl(file.id, { ttlSeconds: 3600 });
const foreverUrl = await files.publicUrl(file.id, { noExpiry: true });
```

Revoke public URLs when they should no longer work:

```tsx
await files.revokePublicUrl(publicUrl.id);
```

Creating a public URL through a File ACL authorizes the creation only; it does
not transfer the File or its capability. The public URL is stored for the File
owner, so the owner can revoke it even when an ACL-approved Team collaborator
created it.

Delete uploaded files when the current user owns them, or when a declared File
ACL explicitly permits the deletion:

```tsx
await files.delete(file.id);
```

Deleting a file marks it deleted, removes the current stored bytes on a
best-effort basis, and revokes any active public URLs for that file. If you
stored the returned file metadata in one of your own tables, delete or update
that row separately with a normal mutation.

Replace file bytes while preserving the file ID:

```tsx
await files.upload(replacementFile, { replace: true, fileId: file.id });
```

Uploading new bytes to an existing live File path also replaces that file,
preserves its File ID, and creates a new File version. Deleting the file frees
the path; a later upload to the same path creates a new File ID.

Private and public file URLs are always Sporades HTTP routes such as
`/__sporades/files/private/<id>?v=<version>` and
`/__sporades/files/public/<id>?v=<version>`. They are not presigned MinIO, S3, or
filesystem URLs. The `v` parameter carries the File version for cache busting
after replacement. File metadata exposes the logical File path and File ID so
app tables and ACLs can store stable references; it must not expose filesystem
locations, object keys, Object buckets, MinIO connection details, or generated
runtime read URLs as storage locations.

## App Messages

Use app messages for ephemeral real-time events, such as typing indicators or
presence pings. Messages are sent to the client (or clients) over WebSocket.
Use queries and mutations for durable state.

There is no need to predefine or register message categories.

Declare a handler on the server:

```ts
import { capsule, message } from "sporades/server";

export default capsule({
  messages: {
    // hook the 'typing' category of messages from clients
    typing: message((ctx, data) => {
      const numClientsSentTo = ctx.messages.send({ type: "typing", data });
      return { ok: true, numClientsSentTo };
    }),
  },
});
```

`ctx.messages.send(...)` returns the number of connected clients the message was
sent to. Multiple browser tabs or devices for the same user are counted
separately.

Send and subscribe on the client:

```tsx
import { onMessage, sendMessage } from "sporades/client";

// send a message with 'typing' category to server
await sendMessage("typing", { roomId: "general", active: true });

// hook all incoming messgaes from server
const subscription = onMessage()
  .filter((message) => message.type === "typing") // filter on 'typing' category
  .subscribe((message) => {
    console.log(message.data);  // {ok: true, numClientSentTo: <numeric count>}
  });

subscription.unsubscribe();
```

Client-origin messages always run through declared server handlers.

## User Journey Tracker

The User journey tracker is opt-in, transient current state for answering “what
are consenting users doing now?” It is not analytics, an audit log, an App
message stream, a Capsule app table, or durable current-user preferences.

First declare the expandable Capsule-wide feature and its safe automatic
capture ceiling:

```ts
export default capsule({
  name: "support",
  journey: {
    enabled: true,
    ttlSeconds: 30,
    capture: { navigation: true, focus: true, interactions: true },
  },
});
```

All three capture sources default on when omitted. A page may narrow them in
`journey.enable({ capture: ... })`, including turning all three off for
manual-only use, but may not broaden the Capsule policy. Declaration permits
the feature; it does not publish anything. Reading or subscribing never enables
the caller.

```ts
import { journey } from "sporades/client";

const enabled = await journey.enable({ capture: { interactions: false } });
const saved = await journey.set({
  status: "reviewing-order",
  metadata: { section: "delivery" },
  ttlSeconds: 60,
});
const current = await journey.list();
const subscription = journey.subscribe((event) => {
  if (event.type === "snapshot") console.log(event.states);
  else console.log(event.type, event.state);
});
subscription.unsubscribe();
await journey.disable();
```

`journey.enable()` establishes page-runtime consent and returns the enabled
user and effective capture policy; it does not return a `sessionId` or create a
server session. With navigation capture active it immediately samples and
publishes the current page. `journey.set(...)` publishes a bounded semantic
status and optional JSON metadata, replacing rather than merging the current
record. `journey.disable()` clears consent and immediately removes the current
connection's live state. `journey.list()` returns all live records. A
subscription receives a snapshot first, then `added`, `updated`, and `removed`
events; removal includes the complete last state. Unsubscribe stops delivery.

Consent belongs to the page runtime, not a Journey session. An ordinary
transport reconnect automatically re-enables with the retained narrowed policy,
but a new transport connection always gets a new server-owned Journey session
on its first accepted publication. Explicit disablement, an authentication
transition, or page reload/replacement clears consent. Apps that want a durable
user choice may store that choice separately in current-user preferences and
call `journey.enable()` in each new page runtime.

Sessions are created lazily and only accepted manual or automatic publications
count as activity. A publication after the configured inactivity boundary also
starts a new session. Configure segmentation in `sporades.json`:

```json
{ "journey": { "sessionInactivityMinutes": 30 } }
```

The default is 30 minutes. Numeric values are rounded and clamped to 1–1,440
minutes; missing or malformed values fall back to 30. This session boundary is
independent of Journey state TTL. The public `sessionId` groups records; it is
not a bearer credential. Journey has no private resume credential, durable
capability registry, or retirement tombstone.

Automatic capture publishes `viewing` for navigation, `focused` or `away` for
focus/visibility changes, and the semantic status on the nearest annotated
interaction:

```html
<meta name="sporades-journey" content="checkout">
<button data-sporades-journey="confirming-order">Confirm</button>
```

Navigation captures only a normalized pathname—never origin, query, or raw
hash. Use the single semantic page-name meta override for sensitive or
identifier-rich routes. React, Preact, Vue, Svelte, SolidJS, Lit, and Inferno
consume the same framework-neutral Journey stream; route detection does not
belong to a framework adapter. Sporades uses a browser-level History/meta
observer, samples after a render frame, and installs idempotently across HMR or
client-runtime setup. Publish manually for locationless view changes.

`data-sporades-journey` contains one semantic status, not JSON. Delegated
capture handles annotated click and submit, including keyboard-triggered native
events, without preventing defaults. It uses `composedPath()` to find the
nearest annotated match once through nesting and open Shadow DOM. For closed
Shadow DOM, capture works when the host is annotated; internal nodes are
not inspectable. Other event types require manual publication. Use typed manual
updates for richer metadata. Raw clicks,
DOM content, form values, query strings, session replay, and arbitrary browser
telemetry are deliberately excluded.

Statuses and annotation values are at most 256 characters. Metadata is JSON-safe
and bounded to 8 KiB, depth 8, 64 object keys, and 64 array items; unsupported,
cyclic, non-finite, prototype-sensitive, or otherwise invalid values receive a
structured validation error. Keep even accepted metadata privacy-safe.

Journey state defaults to a Capsule-wide 30-second TTL. The declaration accepts
1–300 seconds, and manual updates may choose an override in the same range;
automatic signals use the Capsule default. The caller renews state by publishing.
Disconnect leaves the last state buffered only until its existing expiry, so a
late subscriber can still receive it. Expiry means derived `inactive`; it is not
a publishable status. Disablement and authentication transitions remove current
state immediately. Server replacement clears every buffered record and session;
a still-consenting page reconnects and publishes only fresh state under a new ID.
There is no permanent Journey state.

Records have the flat shape
`{ sessionId, userId, status, metadata, updatedAt, expiresAt }`. Lists and
snapshots are deterministically ordered by `(userId, sessionId)`; group them on
the client when presenting users. One user may have multiple live sessions,
just like multiple tabs, browsers, or devices.

Immediate `set` results and `list()` reflect accepted state. Realtime delivery
coalesces each session to its latest state over 100 milliseconds while
preserving coherent change order; intermediate states are not guaranteed.
Capacity is 32 live states per user and 1,000 live states per Capsule. Expired
records are pruned before admission, replacement remains allowed at capacity,
and a new over-capacity record receives a structured rejection without evicting
live state.

Every connected Capsule client receives Journey snapshots and changes in V1.
Publisher-selected record permissions do not exist; future shared-Team
receiver-side filtering is deferred. Publication, reads, and subscriptions are
client-only. Capsule server handlers and the Privileged server role cannot
impersonate user activity, and transient client claims must not become
authoritative server business-logic inputs.
