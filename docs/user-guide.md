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

In another terminal, from the Capsule directory:

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

Use a different port when needed:

```sh
sporades deploy --port 5000
```

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

`.env.sporades.server` stores server-only values. It is available as `ctx.env`
inside server handlers and is mounted read-only in Container sessions.

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

### Use Server Env

Put server-only values in `.env.sporades.server`:

```text
OPENAI_API_KEY=sk-...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Read them from `ctx.env`:

```ts
endpoint({ method: "POST", path: "/billing/webhook" }, (ctx) => {
  const secret = ctx.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw Object.assign(new Error("Billing is not configured."), {
      hint: "Set STRIPE_WEBHOOK_SECRET in .env.sporades.server.",
    });
  }
});
```

Restart a running Dev session after changing `.env.sporades.server`.

### Add Middleware

Use middleware when multiple handlers need the same derived context or guard:

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

  if (projects.loading) return <p>Loading...</p>;
  if (projects.error) return <p>{projects.error.message}</p>;

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

### Configure Google

Use explicit values:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

Or use a downloaded Google OAuth web client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

Sporades writes the secret values to `.env.sporades.server` and keeps env var
names in `sporades.json`. Restart any running Dev session after changing auth
configuration.

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

The returned file metadata includes fields such as `id`, `name`, `type`, `size`,
`path`, and `version`. Store that metadata through a normal mutation:

```tsx
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

Replace file bytes while preserving the file ID:

```tsx
await files.upload(nextFile, { replace: true, fileId: file.id });
```

Uploaded bytes are private by default and scoped to the current user.

## Custom HTTP Endpoints

Most app behavior should use queries and mutations. Use endpoints for HTTP
integrations such as webhooks:

```ts
import { capsule, endpoint } from "sporades/server";

export default capsule({
  endpoints: {
    webhook: endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => ({
      status: 202,
      headers: { "x-sporades-endpoint": "accepted" },
      body: {
        received: true,
        path: ctx.request.path,
        userId: ctx.auth.userId,
      },
    })),
  },
});
```

Endpoint context includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.log`,
`ctx.messages`, and `ctx.request`. `ctx.request` contains method, path, headers,
query parameters, and parsed body data.

## App Messages

Use app messages for ephemeral real-time events, such as typing indicators or
presence pings. Use queries and mutations for durable state.

Declare a server handler:

```ts
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

Send and subscribe on the client:

```tsx
import { onMessage, sendMessage } from "sporades/client";

await sendMessage("typing", { roomId: "general", active: true });

const subscription = onMessage()
  .filter((message) => message.type === "typing")
  .subscribe((message) => {
    console.log(message.data);
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
sporades logs --port 3000 --json
```

### Database

List tables:

```sh
sporades db list
```

Dump everything:

```sh
sporades db dump --json
```

Run a read-only SQL query:

```sh
sporades db query "select id, createdAt from todos order by createdAt desc" --json
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
3. Runs the Capsule in Docker using the Node base image.
4. Mounts the Server env read-only.
5. Persists SQLite data through the Runtime directory.
6. Writes the container binding to `.sporades/binding.json`.

Use `--force` if the previous Docker container was deleted manually and the
local binding is stale.

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

For normal release updates:

```sh
sporades host push --host personal --subname team-notes --restart --json
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

On macOS, if tar includes AppleDouble metadata during push, use:

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

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

1. Add the value to `.env.sporades.server`.
2. Read it with `ctx.env`.
3. Restart `sporades dev`.
4. For Hosted Capsules, push and restart the Capsule.

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
