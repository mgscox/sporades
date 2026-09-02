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

### Endpoint attachment responses

An endpoint that has already authorized a download can return one exact File
version as an attachment without exposing a private File URL, File bytes,
storage path, object key, stream, or storage credentials to Capsule code:

```ts
endpoint({
  method: "GET",
  path: "/tickets/export",
  response: { fileAttachment: true },
}, async (ctx) => {
  const exportFile = await ctx.db.exports.where({ ticketId: ctx.request.query.ticket }).first();
  if (!exportFile) return { status: 404, body: "Not found" };
  return ctx.files.attachment(
    { id: exportFile.fileId, version: exportFile.fileVersion },
    { filename: "ticket-export.pdf" },
  );
});
```

The `response: { fileAttachment: true }` declaration is an explicit authority
boundary: it delegates attachment-response authorization to this trusted
endpoint's server code. Undeclared endpoints do not receive
`ctx.files.attachment`. This path deliberately does **not** apply ordinary File
ownership or `files.acl` rules, because external customer Grants and similar
application capabilities may not be Sporades Users. The handler must derive the
exact File from current domain authorization, retention, and safety state. Do
not accept an arbitrary request-supplied File ID and pass it through.

`ctx.files.attachment()` creates an opaque, runtime-only endpoint result. It
accepts only the exact File `id` and `version` plus a presentation filename;
plain objects that resemble it are ordinary endpoint values and cannot cause a
File read. Each descriptor belongs to the single declared endpoint invocation
that minted it and is consumed once. Replaying it from a later request, another
endpoint, a middleware context, or an abandoned transaction attempt cannot
reach File lookup or storage. Sporades resolves the descriptor only after the
endpoint transaction
commits, rereads the current File row, and denies a deleted, replaced, missing,
or unreadable version with the same opaque no-store response. The result always
uses `application/octet-stream`, `Content-Disposition: attachment` with an
ASCII fallback and UTF-8 filename parameter, `nosniff`, `sandbox`, same-origin
resource policy, and private no-store caching. Presentation names are bounded
basenames; control characters, paths, traversal, bidirectional controls,
reserved device names, and overlong values become `download`.

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

## Trusted endpoint multipart ingress

A Custom endpoint should use trusted multipart ingress when an HTTP integration
must send files directly to an endpoint. Browser and first-party app uploads
should continue to use the normal `files.upload` flow. The endpoint declares
hard request limits and stable retry keys:

```ts
const upload = endpoint({
  method: "POST",
  path: "/attachments",
  body: { multipart: {
    maxFiles: 4,
    maxFileBytes: 10_000_000,
    maxTotalFileBytes: 20_000_000,
    maxFieldCount: 8,
    maxFieldBytes: 8_192,
    maxTotalFieldBytes: 32_768,
    allowedMimeTypes: ["image/png", "application/pdf"],
    allowedPathPrefixes: ["/attachments"],
    requestKeyHeader: "idempotency-key",
    partKeyHeader: "content-id",
    requireStablePartKeys: true,
  } },
}, requireAuth(async (ctx) => {
  const [lease] = ctx.request.multipart.files;
  return await ctx.files.claim(lease, { path: `/attachments/${lease.partId}` });
}));
```

Sporades admits the endpoint credential before reading any body bytes. It then
parses the stream within the declared file, field, header, part, and aggregate
limits. Fragmented multipart boundaries are supported; malformed or truncated
streams fail without publishing a partial lease. Completed parts appear only
as private, expiring leases in `ctx.request.multipart.files`. A lease has no
File URL, File row, or ACL visibility.
Both token and commonly emitted quoted `boundary` parameters are accepted;
Sporades validates RFC 2046 `bchars`, applies HTTP-token restrictions to the
unquoted form, and enforces the 70-character cap before reading the body.
Malformed quoting, invalid punctuation, and extra parameters are rejected.

Every numeric limit is required and validated when the Capsule starts and again
before request buffering. File counts and byte limits are positive finite
integers; field counts and byte limits are non-negative finite integers. String,
fractional, missing, `NaN`, and infinite values fail the declaration. The same
pre-buffer validation requires normalized absolute path-prefix arrays,
valid optional MIME-type arrays, syntactically valid request/part header names,
an optional boolean stable-key switch (omission remains `false`), and exactly one supported claim authority when
declared; unknown policy fields are rejected. A payload sequence that merely
begins `CRLF--boundary` remains payload unless the prefix
is followed by the required `CRLF` or closing `--` delimiter suffix.
Sporades classifies each part from its bounded headers before accumulating its
body, so text uses `maxFieldBytes` while files use `maxFileBytes`; a large file
allowance never expands the memory bound for a field. File streaming uses the
smaller of endpoint `maxFileBytes` and the Capsule-wide File size limit, so the
global limit aborts during streaming rather than after buffering. Field names are stored in
an own-property-safe map, including `constructor`, `toString`, and `__proto__`.

`requestKeyHeader` identifies the whole retry and `partKeyHeader` identifies a
part independently of multipart ordering. Use sender-provided, stable,
non-secret values. With `requireStablePartKeys`, missing or repeated part keys
are rejected. Reusing a key with different bytes, name, media type, or size is
an idempotency conflict rather than a new upload.
The durable identity is a versioned, length-framed digest of method, path,
authority, request key, and part key, so delimiter-bearing values cannot alias.
Existing pre-0.9.6 delimiter-framed receipts remain replayable only when their
stored tuple exactly matches; every newly staged receipt uses the framed digest.

### Required inspection evidence

Use a required inspection policy for an integration that accepts material from
outside its trust boundary and must not create an ordinary File until that
material has passed a security control. The policy is intentionally opt-in, so
existing trusted-ingress handlers retain their established behaviour:

```ts
const inspection = {
  policyRevision: "support-attachments-v1",
  maxVerdictAgeMs: 60 * 60 * 1000,
  requiredInspectors: ["content-policy-v1"],
};

endpoint({ method: "POST", path: "/attachments", body: {
  multipart: { ...limits, inspection },
}}, async (ctx) => ctx.files.claim(ctx.request.multipart.files[0], {
  path: `/attachments/${ctx.request.multipart.files[0].partId}`,
}));
```

`content-policy-v1` is runtime-owned. It accepts only JPEG, PNG, unencrypted
PDF, and strict UTF-8 text when filename extension, declared MIME type,
detected signature, and bounded parser checks agree. It rejects archives,
encrypted containers, SVG/HTML/XML, Office formats, executables, scripts,
empty/polyglot/ambiguous content, and malformed or oversized input. Endpoint
handlers cannot supply verdict-producing objects or receive lease bytes.
JPEG validation walks bounded segment and entropy structure through the exact
EOI, then decodes under the pinned `jpeg-js@0.4.4` resolution and memory caps.
PNG validation pre-bounds dimensions, pixels, and expected decoded storage,
checks chunk bounds/order, PLTE and contiguous-IDAT rules, IHDR constraints,
every CRC and exact IEND, then uses pinned `pngjs@7.0.0` to inflate and decode
the exact scanline/filter stream. PDF validation uses the pinned maintained server-side
`pdfjs-dist@6.3.289` parser, forces bounded page/operator parsing, rejects
encrypted input, caps pages, and enforces a short inspection timeout; the
production dependency audit must remain clean when it is upgraded. Text is a
particularly conservative untrusted-evidence lane: strict UTF-8 is rejected
when it resembles markup, JavaScript, shell, or common script/source forms.
This includes generic XML and common JavaScript, Python, and shell source forms.
That deliberately creates false positives for support notes containing code;
such material should be pasted as quoted ticket text or explicitly handled by
a future reviewed evidence policy, never treated as an executable channel.
The `clamav` inspector is runtime-owned and communicates only with clamd's
fixed Unix-domain socket inside the Capsule container. There is no TCP,
hostname, IP, path-scan, or caller-configurable destination surface. Sporades
sends the exact lease bytes with bounded INSTREAM chunks and a zero terminator;
customer bytes never leave the deployment. A Capsule declaring `clamav`
starts the managed daemon during runtime initialization and is not healthy
until fresh signatures and a bounded `PING` over that socket succeed. Runtime
health repeats that socket probe and degrades immediately when clamd or the
signature updater exits. Capsules that omit it do not
start clamd and retain legacy startup behaviour.

The Base image includes ClamAV, which increases image size, while enabling it
also costs daemon startup time and RAM. `freshclam` is the only intended
network egress and downloads public signature updates, never customer data.
After the initial readiness update, Sporades keeps freshclam's bounded daemon
running for periodic updates and supervises both children. Shutdown awaits
both processes after `SIGTERM` and uses a bounded `SIGKILL` fallback, including
partial-startup failure paths.
Signatures older than 24 hours, missing databases, daemon/socket failure,
timeouts, malformed or oversized replies, scan limits, infection, and every
other inconclusive outcome fail closed. Operators should monitor runtime
health and signature-update logs, budget memory for clamd, and keep the data
volume writable for `/app/data/clamav`. The image configuration uses only a
private socket and caps stream/file/aggregate scan size, recursion, files,
queue depth, and scan time.
Freshness is derived from the database's embedded, validated build timestamp,
not its filesystem modification time: copying or touching an old database
cannot make it current. The runtime also enforces the exact 10 MB scanner cap
before opening the socket or writing any frame.
Production malware-scanner transport is deliberately a runtime-owned
integration rather than an endpoint-handler callback: no endpoint handler,
Capsule policy, caller, or lease API receives the staged bytes. This prevents a
convenient inspection hook from becoming a second File-download capability. An
isolated scanner adapter
must impose its own destination allow-list, byte cap, timeout, response cap,
and fail-closed handling before a Capsule may use it.
ClamAV's [INSTREAM protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)
sends the content over clamd's socket and is bounded by clamd's
`StreamMaxLength`; ClamAV documents that a TCP clamd socket is unauthenticated
and unencrypted, so it must remain on an isolated trusted network rather than
be exposed to callers. Operators must also keep signatures current with
[freshclam](https://docs.clamav.net/manual/Usage/SignatureManagement.html).

When inspection is required, Sporades seals bounded verdict metadata into the
private receipt: inspector name and outcome, lease identity, observed byte
size, SHA-256 digest, policy revision, and inspection time. `claim()` succeeds
only if every declared inspector has a current `clean` verdict matching that
exact receipt and policy revision. Missing, stale, malformed, mismatched,
infected, or inconclusive evidence returns `INGRESS_INSPECTION_REQUIRED` before
creating a File row. Changing the policy revision deliberately invalidates old
evidence. This reduces the risk of a stale or substituted scan result being
reused, but it is not a content-safety guarantee: operators still need a
maintained scanner, constrained storage, forced-download delivery, and no
automatic rendering or execution of uploaded material.

By default, the authenticated human or Access-key service User is the actor and
File owner. A scoped service User remains a normal non-session actor; do not
create login-capable bot accounts merely to receive a file. For integrations
whose external principal is admitted by Capsule code, declare the sole claim
authority and a bounded pre-body admission function:

```ts
const definition = capsule({
  files: {
    ingress: {
      principalNamespaces: ["application"],
      admit: async (ctx, request) => {
        const app = await ctx.db.integrations.where({ token: request.headers["x-app-token"] }).first();
        return app
          ? { allow: true, principal: { namespace: "application", key: app.id } }
          : { allow: false };
      },
    },
    acl: {
      read: ({ ctx, file }) => canReadAttachment(ctx, file),
      delete: ({ ctx, file }) => canDeleteAttachment(ctx, file),
    },
  },
  endpoints: {
    upload: endpoint({
      method: "POST",
      path: "/integration-upload",
      body: { multipart: { ...limits, claimAuthorities: ["capsule-principal"] } },
    }, async (ctx) => ctx.files.claim(ctx.request.multipart.files[0], {
      path: "/attachments/integration.pdf",
      authority: { kind: "capsule-principal", ...ctx.ingress.principal },
    })),
  },
});
```

The namespace must be declared, the principal key is bounded, and only its
digest is persisted. Capsule-principal ingress requires explicit
`files.acl.read` and `files.acl.delete` rules because its deterministic runtime
owner is reserved, cannot authenticate, cannot hold an Access key or Session,
and must never gain implicit human-owner access. Anonymous, cross-user,
cross-principal, and cross-Capsule claims all fail opaquely with
`INGRESS_AUTHORITY_DENIED`; callers cannot use the error to discover whether a
lease exists. Completed retries enforce the same authority.

Trusted server code claims a lease inside the endpoint transaction with an
application-chosen absolute path:

```ts
const file = await ctx.files.claim(lease, { path: `/attachments/${id}/source` });
```

The staged bytes must exist before the receipt is completed. The File row,
receipt completion, bucket, application writes, and one runtime-private audit
intent then commit together. The intent drains after commit, at startup, and
through a bounded single-flight clock retry to `file.ingress.completed`.
Delivery is **at least once**, not exactly once: JSONL append and private
acknowledgement cannot share an atomic commit, so a process stop after append
and before acknowledgement can repeat an event during recovery. Every event
contains only `{ schema: "v1", outcome: "claimed", deliveryId }`; `deliveryId`
is a stable opaque digest, never a request key, lease, File ID, principal,
filename, or credential. Consumers must deduplicate by `deliveryId`. Logger
failure leaves the intent pending without altering committed application state.
An acknowledgement failure after a successful append returns that exact
token-fenced intent to pending for the live retry; if that release also fails,
Sporades emits the safe `INGRESS_AUDIT_ACK_RELEASE_FAILED` platform warning and
startup recovery repairs the abandoned delivery lease. A transient startup
recovery failure emits `INGRESS_AUDIT_RECOVERY_FAILED` and remains a bounded
live-maintenance retry until recovery succeeds; once clear, ordinary timer
ticks do not rescan interrupted delivery rows.
Delivered intents remain inspectable for 24 hours and are then pruned
oldest-first in batches of 50; pending and in-progress intents are never
pruned, and completed File retries do not create a new intent. A
staging receipt becomes claimable only through a key, lease, state, and expiry
compare-and-set after its object write. If expiry cleanup wins that race,
Sporades compensates the exact newly written object and never revives the row;
a concurrently completed receipt is preserved.
lost response can replay the completed File even after the original lease
expiry; expired unclaimed leases cannot be claimed. Local filesystem and
MinIO-backed storage use identical policy, admission, lease, claim, ACL,
idempotency, expiry, and cleanup semantics. This server-only surface never
exposes filesystem paths, object keys, buckets, or storage credentials.
An identical concurrent retry waits for the durable staging winner until its
bounded lease deadline (at most ten minutes), rather than using a short fixed
poll count. Winner failure or lease expiry ends the wait. `status()`
returns `leased` only for a currently claimable lease; expired, staging, sweeping,
and failed/nonclaimable receipts return `failed` with an explicit `retryable` flag.

Operationally, Capsule startup automatically runs a bounded, deterministic
cleanup batch for expired unclaimed receipts. It deletes only staged bytes and
never deletes a committed File. Interrupted cleanup state remains durable and
is retried on a later startup; completed receipts remain replayable. There is no
public manual ingress-sweeper API. Monitor the stable platform cleanup warning,
but do not log authorization headers, principal keys, idempotency keys that
contain secrets, or storage connection details.
