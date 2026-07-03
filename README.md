# Sporades

## Documentation

- [User guide](docs/user-guide.md) - quick start and day-to-day Capsule usage.
- [Architecture](docs/architecture.md) - platform ethos, runtime layout, Host
  routing, storage, and client transport.
- [Roadmap](docs/ROADMAP.md) - candidate features and their promotion status.
- [Runtime layout](docs/runtime-layout.md) - canonical filesystem paths,
  runtime mounts, and Host server directory structures.
- [Host server installation](docs/server-installation.md) - preparing a Linux
  Host server for Hosted Capsules.

## Auth

Sporades apps can enable multiple auth providers in `sporades.json`:

```json
{
  "auth": {
    "providers": {
      "anonymous": true,
      "google": {
        "clientIdEnv": "GOOGLE_CLIENT_ID",
        "clientSecretEnv": "GOOGLE_CLIENT_SECRET"
      },
      "email": true
    }
  }
}
```

`anonymous`, `google`, and `email` are valid provider names. Existing projects
using `auth.mode` continue to work; `auth.mode: "anonymous"` maps to anonymous
sessions, and `auth.mode: "google"` enables Google alongside anonymous sessions.

Configure Google OAuth from explicit credentials:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

Or pass a downloaded Google OAuth client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

The JSON form reads Google Web application credentials from `web.client_id` and
`web.client_secret`. Sporades stores the values in `.env.sporades.server` and
keeps only env var names in `sporades.json`.

`sporades auth status --json` reports enabled providers and configuration state
without printing OAuth client IDs or secrets.

List currently connected browser clients for a running dev session:

```sh
sporades auth clients --json
```

The JSON response includes safe metadata only: stable client IDs, current auth
summary, connection time, and last-seen time. It does not include session
tokens, OAuth credentials, passwords, or raw `localStorage` payloads.

For local browser tests and agents, a running dev session can create a simulated
linked identity and return the same session token shape the SDK stores in
`localStorage`:

```sh
sporades auth as email --email mira@example.com --display-name "Mira Vale" --json
```

Pass `--client current` to push the simulated session into the most recently
connected browser client, `--client all` to push it into every connected
browser client for the app, or `--client <id>` with an ID from
`sporades auth clients --json` to target one exact browser client:

```sh
sporades auth as email --email mira@example.com --client current --json
```

The JSON response includes `{ localStorage: { key, value }, auth, delivery }`,
where `key` is `sporades.sessionToken`. `delivery` reports the requested target,
whether any browser client received the session, and how many clients were
updated. The `localStorage` payload is always returned as a manual fallback even
when no browser client is connected. This is local identity simulation only: it
creates a Sporades-owned dev session for `ctx.auth` testing and does not
complete OAuth, trust arbitrary JWTs, or authenticate against a real provider.
`google` can be used as a simulated provider shape for browser tests that need
Google-like auth metadata. Simulated sessions use the same session lifetime as
normal Sporades sessions.

Sporades session records store creation and expiry metadata. Sessions expire 30
days after they are created or refreshed. Missing, invalid, or expired session
tokens resolve to a fresh anonymous session instead of authenticating the old
user forever. Email sign-up links the current anonymous account and rotates the
session token; email sign-in rotates the current anonymous token onto the email
account. Google sign-in links through the server-owned OAuth callback and
refreshes the current session token's expiry, because the redirect callback does
not expose a safe client token handoff point.

After running `sporades auth set <provider>`, restart any running dev session so
the server runtime reloads the updated Server env and auth configuration:

```sh
# stop the current dev session, then run:
sporades dev
```

Client code signs users up and in through the provider-neutral auth surface.
Email auth returns structured results and keeps auth details server-owned:

```tsx
import { auth } from "sporades/client";

const signUp = await auth.signUp("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
  name: "Mira",
});

const signIn = await auth.signIn("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
});

if (signIn.data?.ok) {
  console.log(signIn.data.auth.provider); // "email"
} else {
  console.error(signIn.error?.message, signIn.error?.hint);
}
```

Google continues to use the same sign-in surface and starts the server-owned
redirect flow:

```tsx
await auth.signIn("google");
```

Client code signs out through the same auth surface. A successful sign-out
clears the stored Sporades session token and refreshes auth state to a fresh
anonymous session, so apps can route immediately:

```tsx
import { auth } from "sporades/client";

async function signOutAndGoHome(navigate: (path: string) => void) {
  const result = await auth.signOut();
  if (result.data?.ok) {
    navigate("/");
  } else {
    console.error(result.error?.message);
  }
}
```

## File uploads

Client code uses `files.upload()` from `sporades/client` to upload browser
`File` or `Blob` values. The SDK first asks the Sporades server for an upload
URL, transfers the bytes internally, and resolves with Sporades-owned metadata:
file ID, original filename, MIME type, size, bucket, storage path, and version.
Arrays are accepted as a convenience and are uploaded sequentially.

Uploaded bytes are private by default and scoped to the current authenticated
user in that user's `default` bucket. During dev sessions, bytes live under
`.sporades/files/`; metadata, buckets, upload records, and public URL records
live in the `.sporades/data.db` SQLite database. Container sessions use the
mounted `/app/data` volume for the same platform-managed storage.

Private reads go through `files.url(fileId)` or `files.download(fileId)`.
Public reads must be created explicitly with exactly one expiry choice:
`ttlSeconds`, `expires`, or `noExpiry: true`. Replacing a file preserves the file
ID, creates a new version, and invalidates previously generated private and
public URLs.

## Endpoint handlers

Capsules can register custom HTTP endpoints with `endpoint({ method, path }, handler)`.
The handler receives the same server-owned context concepts as queries and
mutations:

```ts
endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => ({
  status: 202,
  headers: { "x-sporades-endpoint": "accepted" },
  body: {
    method: ctx.request.method,
    path: ctx.request.path,
    query: ctx.request.query,
    body: ctx.request.body,
    userId: ctx.auth.userId,
  },
}));
```

`ctx` includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.log`, and `ctx.request`.
`ctx.request` exposes `method`, `path`, lower-cased `headers`, query parameters,
and parsed request body data. Structured endpoint responses use
`{ status, headers, body }`; object bodies are returned as JSON, and string bodies
are returned as text.

## App messages

Capsules can declare ephemeral app-level messages with `message(handler)` and
clients can send them through `sporades/client` without touching raw WebSocket
objects:

```ts
// server/index.ts
import { capsule, message } from "sporades/server";

export default capsule({
  messages: {
    typing: message((ctx, data) => {
      ctx.messages.send({ type: "typing", data });
      return { ok: true };
    }),
  },
});
```

```ts
// client/index.tsx
import { onMessage, sendMessage } from "sporades/client";

await sendMessage("typing", { roomId: "general", active: true });

const subscription = onMessage()
  .filter((message) => message.type === "typing")
  .subscribe((message) => {
    console.log(message.data);
  });
```

App and server code use unprefixed type names. Sporades reserves platform
namespaces such as `app.`, `auth.`, `query.`, `mutation.`, `files.`, and
`runtime.` for internal transport messages. Client-origin app messages always
run through declared Capsule handlers; the platform does not directly relay
arbitrary client messages. `ctx.messages.send()` defaults to the current user's
connected clients, and handlers can explicitly target users with
`{ scope: "users", userIds: [...] }`. App-wide `{ scope: "all" }` broadcasts are
not available from client-origin handlers.

App messages are a real-time escape hatch for JSON-serializable, ephemeral
events. Use queries and mutations for durable state, auth APIs for identity, and
file APIs for binary payloads.

## Context middleware

Capsules can register synchronous context middleware with `middleware`. Each
function receives the current `ctx` and can return an enriched context for the
request handler, query, mutation, or mutation hook:

```ts
export default capsule({
  middleware: [
    (ctx) => ({ ...ctx, tenant: ctx.env.TENANT }),
    (ctx) => {
      if (!ctx.tenant) {
        throw Object.assign(new Error("Missing tenant."), {
          hint: "Set TENANT in .env.sporades.server.",
        });
      }
      return ctx;
    },
  ],
});
```

Middleware runs once per WebSocket query request, WebSocket mutation request, and
HTTP endpoint request. Functions run in the order they appear in the array, and
each function receives the context returned by the previous function. Middleware
receives `ctx.kind` as `"query"`, `"mutation"`, or `"endpoint"`. Throw an error
with a `hint` property to block the request with a structured Sporades error.
