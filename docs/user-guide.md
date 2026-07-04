# Sporades User Guide

This guide is for building, running, inspecting, and publishing Sporades
Capsules. It assumes Sporades is already installed locally. If you are preparing
a Linux Host server for remote Hosted Capsules, read
[server-installation.md](./server-installation.md) first.

Sporades is CLI-first. The normal loop is:

```sh
sporades create my-capsule --template todo
cd my-capsule
sporades dev
```

Then edit `server/`, `client/`, and `shared/`. Sporades bundles the Capsule on
every start and rebuild, so Dev sessions and Container sessions run the same
bundled code.

## Quick Start

### 1. Create a Capsule

```sh
# Create a sporades capsule called 'notes' from the 'todo' template
sporades create notes --template todo
cd notes
```

`sporades create` writes a complete scaffold and, by default, runs `npm install`
and `git init`. The scaffold includes:

```text
sporades.json
index.html
.env.sporades.server
server/index.ts
client/index.tsx
shared/types.ts
AGENTS.md
README.md
package.json
```

Useful create options:

```sh
sporades create notes --template blank
sporades create guestbook --template guestbook
sporades create gallery --template photo-library
sporades create tiny --framework preact
sporades create no-install-yet --no-install --no-git
```

Available templates are `blank`, `todo`, `guestbook`, and `photo-library`.
Available client frameworks are `react` and `preact`.

### 2. Start a Dev Session

```sh
sporades dev
```

The command prints a local URL, usually `http://localhost:4000`. Open that URL
in a browser.

During a Dev session, Sporades watches `server/`, `client/`, `shared/`,
`index.html`, and `sporades.json`. Client-only changes rebuild the client
Bundle. Server or shared changes restart the server runtime and reconnect the
browser transport. If a rebuild fails, Sporades keeps serving the last
successful Bundle while showing the error.

To choose a port:

```sh
sporades dev --port 3000
```

For automation, use JSONL streaming:

```sh
sporades dev --json
```

### 3. Make Your First Server Change

Open `server/index.ts`. A typical Capsule defines a schema, queries, and
mutations:

```ts
import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "notes",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },
});
```

Use queries for data the UI reads. Use mutations for changes. Keep ownership and
validation on the server; the client should not be trusted to send fields such
as `ownerId`.

### 4. Make Your First Client Change

Open `client/index.tsx`. The scaffold wires the framework primitives into
Sporades hooks:

```tsx
import { useEffect, useState } from "react";
import { createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
```

Read data with `useQuery("queryName")`:

```tsx
const todos = useQuery("todos");
```

Run changes with `useMutation("mutationName")`:

```tsx
const addTodo = useMutation("addTodo");
await addTodo.run("Buy coffee");
```

Queries stay subscribed over the Sporades client transport, so successful
mutations refresh connected clients without you writing manual fetch code.

### 5. Inspect Logs and Data

In **another** terminal, from the Capsule directory:

```sh
sporades logs
sporades db list
sporades db dump --json
sporades db query "select * from todos" --json
```

`sporades db query` is read-only. Use it to inspect state, not to patch around
application logic.

### 6. Try a Container Session

When the Capsule works locally, test it in Docker:

```sh
sporades deploy
```

This starts a local Container session by bundling the Capsule, mounting the
Bundle files and Server env into a Node container, and persisting SQLite data in
the Runtime directory. Re-running `sporades deploy` replaces the previous local
container for this project.

Use a different port when needed, e.g. if 'dev' is running at same time:

```sh
sporades deploy --port 5000
```

Inspect a running local Container session by passing its port to the same log
and database commands:

```sh
sporades logs --port 4000
sporades logs tail --port 4000 --json
sporades db list --port 4000
sporades db dump --port 4000 --json
sporades db query "select * from todos" --port 4000 --json
```

Use the port from `sporades deploy --json` if you do not know which port the
Container session is using.

## How Sporades Projects Fit Together

### Project Files

`server/index.ts` defines the Capsule: schema, queries, mutations, endpoints,
messages, middleware, and server-side behavior.

`client/index.tsx` is the browser entry. It imports the configured framework and
`sporades/client`.

`shared/` is for types and pure shared helpers. Keep it free of DOM APIs, Node
APIs, Server env, and Sporades runtime imports.

`index.html` is user-owned and served at `/`. It normally loads `/client.js`.

`sporades.json` configures the Capsule name, template, client framework, auth,
and default ports.

Sealed Server env stores server-only values in `.sporades/sealed-server-env/`
and exposes them as `ctx.env` inside server handlers. `.env.sporades.server`
remains supported as a legacy/import-friendly source.

`.sporades/` is the Runtime directory. Sporades owns it. It contains Bundles,
SQLite data, uploaded files, and local binding metadata. Do not edit it by hand.
For exact paths and mount layouts, see
[runtime-layout.md](./runtime-layout.md#project-runtime-directory).

### Configuration

A typical `sporades.json` looks like this:

```json
{
  "name": "notes",
  "template": "todo",
  "client": {
    "framework": "react"
  },
  "auth": {
    "mode": "anonymous"
  },
  "security": {
    "cors": {
      "allowedOrigins": []
    },
    "csp": {
      "mode": "report-only"
    }
  },
  "deploy": {
    "port": 4000
  },
  "dev": {
    "port": null
  }
}
```

Ports follow this cascade: CLI flag, then `sporades.json`, then default.

Use `dev.port` when you always want a different Dev session port. Use
`deploy.port` for local Container sessions.

### Security Policy

`security` controls the Capsule HTTP security posture for Sporades-owned
surfaces and Custom endpoints. The default CORS posture is same-origin. Dev
sessions additionally allow browser origins on `localhost` and `127.0.0.1` so
local tools can talk to the Capsule without extra configuration.

For temporary demos, device testing, or tunnels, start an explicit Public Dev
session:

```sh
sporades dev --public --json
```

The JSON started event includes the effective security policy, including
`security.cors.publicDev: true` and the relaxed allowed origin. Public Dev mode
does not apply to local Container sessions or Hosted Capsules.

Local Container sessions and Hosted Capsules require explicit CORS origins for
cross-origin Custom endpoint access:

```json
{
  "security": {
    "cors": {
      "allowedOrigins": ["https://dashboard.example.com"]
    },
    "csp": {
      "mode": "report-only"
    }
  }
}
```

CSP defaults to report-only mode with React/Preact-friendly scaffold defaults.
Switch to active enforcement when the Capsule is ready:

```json
{
  "security": {
    "csp": {
      "mode": "enforce"
    }
  }
}
```

Override individual CSP directives with `security.csp.directives`. Sporades
merges these values over its defaults, so the JSON only needs to contain the
directives that differ for the Capsule:

```json
{
  "security": {
    "csp": {
      "mode": "report-only",
      "directives": {
        "connect-src": ["'self'", "https://api.example.com", "ws:", "wss:"],
        "img-src": ["'self'", "data:", "blob:", "https://images.example.com"]
      }
    }
  }
}
```

Inspect the effective policy without starting the server Bundle:

```sh
sporades security --session dev --json
sporades security --session public-dev --json
sporades security --session container --json
sporades security --session hosted --json
```

Host commands may report the effective Hosted policy, for example through
`sporades host current --json`, but Host profiles do not override
`sporades.json`.

Migration note: existing Capsules without a `security` object continue to use
the same defaults as new scaffolds. Add `security.cors.allowedOrigins` only for
known cross-origin callers, and prefer testing active CSP with `report-only`
before switching to `enforce`.

## Building the Server Side

### Define Tables

Tables are declared inside `schema`:

```ts
import { Date, Json, Number, Reference, String, table } from "sporades/server";

schema: {
  projects: table({
    name: String(),
    budget: Number().default(0),
    settings: Json().default({}),
    ownerId: String(),
  }),
  tasks: table({
    projectId: Reference("projects"),
    title: String(),
    dueAt: Date(),
  }),
}
```

Every row automatically gets `id`, `createdAt`, and `updatedAt`. App code does
not set or update those fields.

Use capitalized field builders: `String()`, `Boolean()`, `Number()`, `Date()`,
`Json()`, and `Reference("tableName")`.

Fields with `.default(value)` get that value when a write omits the field. A
non-null default is also stored as a SQLite `NOT NULL DEFAULT` constraint, so
fresh tables and migrated tables enforce it the same way.

Fields without defaults are nullable at the storage and table API boundary. If
you add one to a table that already has rows, existing rows read the new field
as `null`; fresh tables use the same nullable column definition. Validate
required business fields in your mutations before calling `ctx.db`.

Tables can also declare ACL rules next to their fields. Rules may be sync or
async functions. `read` applies to row reads, and `write` is the fallback for
`insert`, `update`, and `delete` unless that operation has its own rule. Missing
rules allow the operation by default.

```ts
schema: {
  notes: table({
    body: String(),
    ownerId: String(),
  }).acl({
    read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
    write: async ({ previous, next, ctx }) => {
      const ownerId = next?.ownerId ?? previous?.ownerId;
      return ownerId === ctx.auth.userId;
    },
  }),
}
```

### Read With Queries

Queries receive `ctx` and return serializable data:

```ts
queries: {
  myProjects: query((ctx) =>
    ctx.db.projects
      .where("ownerId", ctx.auth.userId)
      .orderBy("createdAt", "desc")
      .all(),
  ),
}
```

Common table operations are:

```ts
ctx.db.projects.where("ownerId", ctx.auth.userId)
ctx.db.projects.orderBy("createdAt", "desc")
ctx.db.projects.limit(20)
ctx.db.projects.get()
ctx.db.projects.all()
```

Prefer filtering by `ctx.auth.userId` for per-user data. That keeps privacy in
the server code where it belongs.

### Change Data With Mutations

Mutations receive `ctx` plus the arguments passed from the client:

```ts
mutations: {
  createProject: mutation((ctx, input) => {
    const name = String(input?.name ?? "").trim();
    if (!name) {
      throw new Error("Project name is required.");
    }

    return ctx.db.projects.insert({
      name,
      ownerId: ctx.auth.userId,
      budget: 0,
      settings: {},
    });
  }),

  renameProject: mutation((ctx, id: string, nextName: string) => {
    const project = ctx.db.projects.where("ownerId", ctx.auth.userId).where("id", id).get();
    if (!project) {
      throw new Error("Project not found.");
    }

    return ctx.db.projects.update(id, { name: nextName.trim() });
  }),
}
```

Throw normal errors for user-facing failures. When an error has a `hint`
property, Sporades includes it in structured error output.

### Use Sealed Server Env

A Sealed Server Environment uses public/private keys to encrypt environment
variables, reducing exposure risk when copying data to and from a Host server.
It does not require any local keychain or secure storage, and is almost
transparent to development operations once enabled.

#### Create and Import Values

Use Sealed Server env for server-only values:

```sh
sporades env init
```

To migrate existing plaintext values, put them in `.env.sporades.server` and
import them:

```text
OPENAI_API_KEY=sk-...
STRIPE_WEBHOOK_SECRET=whsec_...
```

```sh
sporades env import --file .env.sporades.server
sporades env status --json
```

#### Read Values in Server Code

Read them from `ctx.env`:

```ts
endpoint({ method: "POST", path: "/billing/webhook" }, (ctx) => {
  const secret = ctx.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw Object.assign(new Error("Billing is not configured."), {
      hint: "Import STRIPE_WEBHOOK_SECRET with `sporades env import`.",
    });
  }
});
```

Restart a running Dev session after changing Sealed Server env.

#### Export or Import an Envelope

For portability, export the sealed envelope without private keys or plaintext
values:

```sh
sporades env export --output sealed-server-env.json --json
```

Import an exported sealed envelope explicitly with:

```sh
sporades env import --sealed --file sealed-server-env.json --json
```

#### Push to a Hosted Capsule

For Hosted Capsules, re-encrypt local values for a Host profile before pushing:

```sh
sporades env reencrypt --host personal --json
sporades host push --host personal --subname team-notes --json
```

`sporades env reencrypt --host personal` decrypts your local Sealed Server env
with the local private key, then writes a Host-profile envelope encrypted to the
Host profile key at
`.sporades/sealed-server-env/hosts/personal.server-env.sealed.json`. The command
does not print plaintext values or private keys.

`sporades host push` includes that Host-profile envelope in the release archive
as `.sporades/sealed-server-env/server-env.sealed.json`. The release archive is
copied to the Host server over SSH/SCP and installed under the Hosted Capsule's
immutable `releases/<release-id>/` directory. The matching Host-profile private
key is delivered to the Hosted Capsule's persistent Host state at
`data/sealed-server-env/server-env.private.pem`, not into the release archive.
When the Hosted Capsule starts, both files are mounted read-only at
`/app/.sporades/sealed-server-env/`; the runtime decrypts the values and exposes
them through `ctx.env`.

Sporades stores local sealed material under `.sporades/sealed-server-env/`,
which is ignored Runtime state. Host-profile private keys are stored in local
Host profile configuration and delivered to Host state during push; exported
sealed envelopes never include private keys.

#### Recover from Lost Keys

Because those files do not live in the repository, a different developer machine
or Host profile may not have access to them (or they may be lost if local
checkout is deleted). Sporades creates keypairs automatically, but a new keypair
cannot decrypt envelopes written for an old one.

Recovery is achieved by re-sealing known values:

- If local sealed key material is lost but you still have `.env.sporades.server`
  or another source of truth for the values, run `sporades env import` again.
- If Host-profile key material is lost but the local Sealed Server env still
  works, run `sporades env reencrypt --host <alias>` again, then push the
  Hosted Capsule.
- If all private keys and all plaintext/source-of-truth values are gone, the
  sealed values cannot be recovered. Regenerate the real provider secrets, add
  them back to Server env, import, re-encrypt for the Host profile, and push.

### Add Middleware

Use middleware when multiple handlers need the same derived context or guard:

```ts
export default capsule({
  middleware: [
    (ctx) => ({ ...ctx, tenant: ctx.env.TENANT }),
    (ctx) => {
      if (!ctx.tenant) {
        throw Object.assign(new Error("Missing tenant."), {
          hint: "Import TENANT with `sporades env import`.",
        });
      }
      return ctx;
    },
  ],
});
```

Middleware runs for queries, mutations, endpoints, and app messages.

Query, mutation, endpoint, message, middleware, and mutation hook handlers may
return Promises. Sporades awaits them before sending WebSocket results, writing
HTTP endpoint responses, committing mutation transactions, or refreshing query
subscriptions.

## Building the Client Side

### Use Queries

`useQuery(name)` returns `{ data, error, loading }`:

```tsx
function ProjectList() {
  const projects = useQuery("myProjects");

  if (projects.loading) {
    return <p>Loading...</p>;
  }

  if (projects.error) {
    return <p>{projects.error.message}</p>;
  }

  return (
    <ul>
      {(projects.data ?? []).map((project) => (
        <li key={project.id}>{project.name}</li>
      ))}
    </ul>
  );
}
```

The query name must match a server query key.

### Use Mutations

`useMutation(name)` returns `{ run, error, loading }`:

```tsx
function NewProjectForm() {
  const createProject = useMutation("createProject");
  const [name, setName] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await createProject.run({ name });
    if (!result.error) {
      setName("");
    }
  }

  return (
    <form onSubmit={submit}>
      <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <button disabled={createProject.loading}>Create</button>
      {createProject.error ? <p>{createProject.error.message}</p> : null}
    </form>
  );
}
```

The mutation arguments are sent as-is to the server mutation after `ctx`.

### Use Auth State

The scaffold exposes auth through `useAuth()`:

```tsx
const session = useAuth();

if (session.loading) return null;

return (
  <div>
    <span>{session.auth?.displayName ?? "Anonymous"}</span>
    {session.isAuthenticated() ? (
      <button onClick={() => session.signOut()}>Sign out</button>
    ) : null}
  </div>
);
```

Anonymous auth is available by default. It creates a real persistent session, so
data can follow the user if they later link a provider.

## Auth Workflows

### Check Auth Configuration

```sh
sporades auth status
sporades auth status --json
```

The status command reports which providers are enabled and whether configured
providers have the required Server env values.

### Configure Google OAuth

Create a Google OAuth **Web application** client. In Google Console, set:

- **Authorized JavaScript origins**: the Capsule origin, with no path, for
  example `http://localhost:4000` for a local Dev session or
  `https://team-notes.example.com` for a Hosted Capsule.
- **Authorized redirect URIs**: the same origin plus Sporades' Google callback
  path: `/__sporades/auth/google/callback`.

> ---
> **Configuring Google OAuth Web application client in Google Console**
>
> For the usual local Dev session URL, the redirect URI is:
>
> ```text
> http://localhost:4000/__sporades/auth/google/callback
>```
>
> If you run Dev on another port, use the URL printed by `sporades dev`. For a
> Hosted Capsule, use its Hosted Capsule URL, for example:
>
> ```text
> https://team-notes.example.com/__sporades/auth/google/callback
> ```
> ---

#### Importing the OAuth client into Sporades

Once the client is setup in the Google console, you can use the client Id and secret directly, or download and use the JSON representation.

Using explicit values:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

Or, using the downloaded Google OAuth web client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

Sporades writes Google auth values to `.env.sporades.server` and stores the environment variable names in `sporades.json`. 
Restart any running Dev session after changing auth configuration.

> Run `sporades env import` after setting auth values if you want them in Sealed Server env. 


#### Using OAuth sign-in in the client

Client sign-in uses the provider name:

```tsx
import { auth } from "sporades/client";

await auth.signIn("google");
```

### Use Email Auth

Enable email in `sporades.json`:

```json
{
  "auth": {
    "providers": {
      "anonymous": true,
      "email": true
    }
  }
}
```

Then call the provider-neutral auth methods:

```tsx
const signUp = await auth.signUp("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
  name: "Mira",
});

const signIn = await auth.signIn("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
});
```

Check `result.data` and `result.error`; do not assume sign-in succeeded.

### Simulate Local Identities

For local browser testing, start a Dev session, then run:

```sh
sporades auth as email --email mira@example.com --display-name "Mira Vale" --json
```

To push the simulated session into a connected browser:

```sh
sporades auth clients --json
sporades auth as email --email mira@example.com --client current --json
sporades auth as email --email mira@example.com --client all --json
sporades auth as email --email mira@example.com --client client-abc123 --json
```

This is local identity simulation. It is useful for tests and development, but
it is not OAuth and does not validate third-party tokens.

## File Uploads

Use the `files` API from `sporades/client` for browser `File` or `Blob` values:

```tsx
import { files } from "sporades/client";

const file = await files.upload(selectedFile, {
  onProgress(event) {
    console.log(event.loaded, event.total);
  },
});
```

File upload is automatically handled as multi-part.
The returned file metadata includes fields such as `id`, `name`, `type`, `size`,
`path`, and `version`. Uploaded bytes are private by default and scoped to the current user.

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
const blob = await files.download(file.id);
```

Create public URLs explicitly:

```tsx
const publicUrl = await files.publicUrl(file.id, { ttlSeconds: 3600 });
const foreverUrl = await files.publicUrl(file.id, { noExpiry: true });
```

Revoke public URLs when they should no longer work:

```tsx
await files.revokePublicUrl(publicUrl.id);
```

Delete uploaded files when the current user owns them:

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

## Custom HTTP Endpoints

Most app behavior should use queries and mutations. Use endpoints for HTTP
integrations such as webhooks:

```ts
import { capsule, endpoint } from "sporades/server";

export default capsule({
  endpoints: {
    webhook: endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => {
      ctx.log.info("Webhook received", {
        path: ctx.request.path,
        body: ctx.request.body,
      });

      return {
        status: 202,
        headers: { "x-sporades-endpoint": "accepted" },
        body: {
          received: true,
          userId: ctx.auth.userId,
        },
      };
    }),
  },
});
```

Endpoint context includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.log`,
`ctx.messages`, and `ctx.request`. `ctx.request` contains method, path, headers,
query parameters, and parsed body data.

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

## Inspecting and Debugging

### Logs

Use `ctx.log` in server handlers:

```ts
ctx.log.info("Project created", { id: project.id });
ctx.log.warn("Near quota", { userId: ctx.auth.userId });
ctx.log.error("Webhook failed", { reason });
```

Read logs from a running Dev session:

```sh
sporades logs
sporades logs --json
sporades logs tail --json
```

Pass `--port` to inspect a local Container session instead:

```sh
sporades logs --port 4000 --json
sporades logs tail --port 4000 --json
```

`ctx.log` entries and Sporades platform runtime events share the
`sporades.log.v1` envelope: `timestamp`, `category`, `event`, `level`,
`message`, `capsule`, optional `release`, optional `request`, optional
`correlation`, and structured `data`. App logs use `category: "app"` and
`event: "ctx.log"`; runtime events use `category: "platform"`. This JSONL log
stream is separate from `sporades dev --json`, which only streams Dev-session
lifecycle events such as start and rebuild status.

Structured log data is redacted before it is written. Keys such as passwords,
tokens, secrets, authorization headers, cookies, API tokens, and client secrets
are replaced with `[REDACTED]`; exact Server env values are also redacted if
they appear in structured log data. Request method and path may be recorded, but
raw request bodies are not logged by default. Each log event is capped to a
bounded payload size, with oversized structured data marked as truncated.

The JSONL log stream lives under the Runtime directory by default and is the
primary durable stream for CLI tailing, Host collection, Docker stdout, and
crash-adjacent debugging. SQLite stores only a bounded recent log index for
inspection queries; `sporades logs --json` reads that index, while
`sporades logs tail --json` prints JSONL events from the durable stream. Local
Container sessions and Hosted Capsules also emit JSON log events to Docker
stdout.

### Fatal Runtime Restart Policy

Fatal runtime paths are handled by mode, and the policy is reported in JSON
status output:

- **Dev** sessions restart automatically after unhandled rejections, uncaught
  exceptions, and failed `init()` or `shutdown()` lifecycle boundaries. The
  terminal, `sporades dev --json`, and the structured log stream report the
  fatal event, restart attempt, and exhaustion state. `SIGTERM` and `SIGINT`
  still exit the Dev session.
- **Local Container** sessions run with Docker `--restart on-failure:3`. Fatal
  runtime exits such as unhandled rejections, uncaught exceptions, and failed
  startup hooks get bounded restarts instead of infinite loops. `sporades
  deploy --json` includes the restart policy.
- **Hosted Capsules** also run with Docker `--restart on-failure:3`. Start,
  restart, stats, health, release verification, and release history surfaces
  expose lifecycle and restart-policy details. When a Hosted Capsule cannot be
  kept running, its route returns the Hosted Capsule unavailable response.

During `sporades host push --verify`, fallback to the previous release is only
available when explicitly requested with
`--fallback-to-previous-release`. This opt-in fallback applies to release
verification only. Later runtime crashes after a release has already been
verified or accepted do not automatically fall back; they use restart/backoff,
structured failure output, Docker logs, and the unavailable response when
retries are exhausted.

### Database

List tables:

```sh
sporades db list
sporades db list --port 4000
```

Dump everything:

```sh
sporades db dump --json
sporades db dump --port 4000 --json
```

Run a read-only SQL query:

```sh
sporades db query "select id, createdAt from todos order by createdAt desc" --json
sporades db query "select id, createdAt from todos order by createdAt desc" --port 4000 --json
```

If a query cannot connect, confirm `sporades dev` is running or pass the right
`--port`.

### JSON Output

Commands that support `--json` return:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Errors use the same envelope and exit with code `1`:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "message": "Missing SQL query.",
    "hint": "Use `sporades db query <sql>`."
  }
}
```

Use `--json` for scripts and agents. Use plain output when you are working by
hand.

## Local Container Sessions

`sporades deploy` is for production-like local testing:

```sh
sporades deploy
sporades deploy --port 5000
sporades deploy --force
sporades deploy --json
```

The command:

1. Bundles the server and client.
2. Stops and removes the previously bound local container, if one exists.
3. Prepares the Sporades Base image automatically.
4. Runs the Capsule in Docker using the Sporades Base image as the invoking
   host UID/GID when available.
5. Mounts Sealed Server env or legacy Server env read-only.
6. Persists SQLite data through the Runtime directory.
7. Writes the container binding to `.sporades/binding.json`.

Use `--force` if the previous Docker container was deleted manually and the
local binding is stale.

When running through the scaffolded npm script, pass flags after `--`:

```sh
npm run deploy -- --force
```

## Hosted Capsules

Hosted Capsules run on a configured Host server. The server installation guide
covers machine setup. Once a Host server exists, the user workflow is:

```sh
sporades host add personal \
  --server root@example.com \
  --domain example.com \
  --remote-root /srv/sporades \
  --json

sporades host use personal
sporades host bootstrap --host personal --json
```

From a Capsule project directory:

```sh
sporades host register team-notes --host personal --json
sporades host push --host personal --subname team-notes --json
sporades host start team-notes --host personal --json
```

If the Capsule uses Sealed Server env, run this before the first push and
whenever the sealed values change:

```sh
sporades env reencrypt --host personal --json
```

The push packages the Host-profile sealed envelope with the release and sends
the matching private key to the Hosted Capsule's persistent Host state. Releases
therefore contain encrypted env values, while the key needed to decrypt them is
kept outside the immutable release directory.

For normal release updates:

```sh
sporades host push --host personal --subname team-notes --restart --json
sporades host push --host personal --subname team-notes --verify --fallback-to-previous-release --json
```

Useful Hosted Capsule operations:

```sh
sporades host list --host personal --json
sporades host stats --host personal --json
sporades host stats team-notes --host personal --json
sporades host logs http --host personal --subname team-notes -n 200 --json
sporades host logs stdout --host personal --subname team-notes -n 200 --json
sporades host restart team-notes --host personal --json
sporades host stop team-notes --host personal --json
```

**Push validation**

Sporades will review the uploaded bundle for unexpected files. On macOS, if tar includes AppleDouble metadata during push, it can cause rejection. Use:

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

> Sporades will attempt to auto-ignore additional MacOS metadata, but it still may cause a false-postivie and reject the bundle - setting `COPYFILE_DISABLE` is guaranteed.

## Common Workflows

### Add a New Feature

1. Add fields or tables in `server/index.ts`.
2. Add a query for the screen's read model.
3. Add mutations for user actions.
4. Render the query with `useQuery()`.
5. Call mutations with `useMutation()`.
6. Watch the Dev session rebuild.
7. Inspect logs and data if anything looks wrong.

Schema changes may alter local data. Treat `.sporades/data.db` as runtime state,
not source code.

### Add Per-User Data

Store `ctx.auth.userId` in rows that belong to a user:

```ts
ctx.db.notes.insert({
  body,
  ownerId: ctx.auth.userId,
});
```

Filter reads with the same user ID:

```ts
ctx.db.notes.where("ownerId", ctx.auth.userId).all();
```

Do not accept `ownerId` from the client.

### Add a Server Secret

1. Add the value to `.env.sporades.server` and run `sporades env import`.
2. Read it with `ctx.env`.
3. Restart `sporades dev`.
4. For Hosted Capsules, run `sporades env reencrypt --host <alias>`, then push
   and restart the Capsule.

Do not put secrets in `client/`, `shared/`, `index.html`, or `sporades.json`.

### Reset Local Runtime State

Stop any running Dev or Container session, then remove `.sporades/`:

```sh
rm -rf .sporades
```

Start `sporades dev` again to recreate runtime state from the current Capsule
definition.

## Troubleshooting

- `Unknown command`: run `sporades --help`.
- Dev session cannot start on a port: pass `--port <number>` or update
  `sporades.json`.
- Browser does not update after auth config changes: restart `sporades dev`.
- `sporades logs` or `sporades db` cannot connect: start a Dev session or pass
  `--port`.
- Google sign-in is unavailable: run `sporades auth status` and confirm Google
  is enabled and configured.
- Container session fails immediately: run `sporades deploy --json` and inspect
  the structured error hint.
- Hosted Capsule route returns `503`: the Capsule is registered, but has no
  running container or the current release failed to start. Check
  `sporades host stats <subname>` and `sporades host logs stdout`.
- Hosted Capsule keeps crashing: inspect `sporades host logs stdout --subname
  <subname> --json`, then restart or push a fixed release. Automatic fallback
  only applies to `host push --verify --fallback-to-previous-release`, not to
  later runtime crashes.
