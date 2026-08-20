# Projects and Configuration Reference

Capsule creation, project layout, configuration, security policy, database services, and Dev sessions.

[Back to the feature reference index](../guide/reference.md).

## Create a Capsule

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
client/index.tsx (or client/index.ts for Vanilla TypeScript)
shared/types.ts
AGENTS.md
README.md
package.json
```

Blank Capsules additionally contain `server/payments.ts` and
`shared/payments.ts`. They are ordinary blank-template source: there is no
separate payment template or post-generation codemod.

Useful create options:

```sh
sporades create notes --template blank
sporades create guestbook --template guestbook
sporades create gallery --template photo-library
sporades create campfire --template campfire
sporades create tiny --framework preact
sporades create framework-free --framework vanilla
sporades create vite-react --framework react --toolchain vite
sporades create vite-preact --framework preact --toolchain vite
sporades create vue-todo --template todo --framework vue
sporades create vue-guestbook --template guestbook --framework vue
sporades create vue-gallery --template photo-library --framework vue
sporades create vue-campfire --template campfire --framework vue
sporades create svelte-todo --template todo --framework svelte
sporades create svelte-guestbook --template guestbook --framework svelte
sporades create svelte-gallery --template photo-library --framework svelte
sporades create svelte-campfire --template campfire --framework svelte
sporades create no-install-yet --no-install --no-git
```

Available templates are `blank`, `todo`, `guestbook`, `photo-library`, and
`campfire`. See [Projects and Client Frameworks](../guide/projects.md#choose-a-template)
for a short description of the features each template demonstrates.
Available client frameworks are `react`, `preact`, `inferno`, `lit`, `solid`, `vue`, `svelte`,
and framework-neutral Vanilla TypeScript. esbuild remains the React, Preact, and Inferno default client
toolchain, and they can explicitly select Vite with `--toolchain vite`. Vue
selects Vite and supports the complete template set. Svelte and SolidJS also
select Vite and support the complete template set. Lit also selects Vite and
supports the complete template set with native Web Components; Vanilla
TypeScript remains on esbuild. Inferno supports the complete template set, defaults
to esbuild, and accepts explicit `--toolchain vite`; both paths use native class
components and lifecycle adapters without React compatibility packages. Inferno/Vite
emits normalized hashed assets and uses Sporades full-page Dev refresh rather than HMR.
See [Choose a client framework](../guide/projects.md#choose-a-client-framework) for the
authoring style and adapter exposed by each framework.

The authoritative client capability matrix is:

| Framework | Default | Also admitted | Templates |
| --- | --- | --- | --- |
| Vanilla TypeScript | esbuild | — | blank, todo, guestbook, photo-library, campfire |
| React | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |
| Preact | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |
| Vue | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Svelte | Vite | — | blank, todo, guestbook, photo-library, campfire |
| SolidJS | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Lit | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Inferno | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |

Angular and server-owning meta-frameworks remain outside the Capsule runtime
contract: they fail before scaffold output rather than entering a partial path.

React/Vite, Preact/Vite, and SolidJS/Vite scaffolds reference `/client/index.tsx`; Lit/Vite,
Vue/Vite, and Svelte/Vite reference `/client/index.ts`. Lit defines the
`<sporades-app>` Web Component directly, while Vue and Svelte compile native `client/App.vue`
or `client/App.svelte` components respectively. SolidJS authors native JSX in
`client/App.tsx` with `jsxImportSource: "solid-js"`. All
keep `index.html` author-owned. Sporades runs Vite as an isolated one-shot build,
loads a regular project-owned `vite.config.*` so trusted project plugins can
extend transforms and resolution, and serves transformed HTML with its hashed
JS, CSS, source-map, and imported-asset tree. Project config is executable build
code and should only import trusted dependencies. Sporades always overrides
root, base, entry, output capture and names, public-directory handling, `.env*`
loading and `import.meta.env`, source maps, watch/library/SSR modes, PostCSS config
discovery, and the required framework/runtime plugins. Sporades remains the only
Dev watcher/server and requests a full-page refresh after successful rebuilds;
none uses a Vite dev server, HMR, framework refresh plugin, or another socket.
The same acknowledged Sporades full-page refresh protocol covers admitted
esbuild pairs, so toolchain selection never changes the Dev transport contract.
Migrating an existing React or Preact esbuild Capsule requires replacing the
`/client.js` script in author-owned `index.html` with `/client/index.tsx`. A
Vue source shell uses `/client/index.ts`. Sporades reports a mismatched source
entry as a write-free preflight error and never rewrites the source shell.

## How Sporades Projects Fit Together

### Project Files

`server/index.ts` defines the Capsule: schema, queries, mutations, endpoints,
messages, Jobs, middleware, and server-side behavior. A blank Capsule imports
its built-in payment mutations, Jobs, policy seam, and known-Job query from
`server/payments.ts`.

`client/index.tsx` is the browser entry. It imports the configured framework and
`sporades/client`.

`shared/` is for types and pure shared helpers. Keep it free of DOM APIs, Node
APIs, Server env, and Sporades runtime imports.

`index.html` is user-owned and served at `/`. esbuild clients load `/client.js`.
React/Vite and Preact/Vite source HTML instead load `/client/index.tsx`;
Vue/Vite loads `/client/index.ts`. Released HTML references only transformed
hashed assets.

`sporades.json` configures the Capsule name, template, client framework and
toolchain, auth, optional payments, and default ports. Omitting `client.toolchain` preserves the
esbuild default for existing React and Preact Capsules. Vue defaults to Vite.

Sealed Server env stores server-only values in `.sporades/sealed-server-env/`
and exposes them as `ctx.env` inside server handlers. `.env.sporades.server`
remains supported as a legacy/import-friendly source.

`.sporades/` is the Runtime directory. Sporades owns it. It contains Bundles,
SQLite data, uploaded files, and local binding metadata. Do not edit it by hand.
For exact paths and mount layouts, see
[runtime layout](../runtime-layout.md#project-runtime-directory).

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
  },
  "services": {
    "database": {
      "kind": "database",
      "engine": "libsql"
    },
    "storage": {
      "kind": "storage",
      "engine": "minio"
    }
  }
}
```

Ports follow this cascade: CLI flag, then `sporades.json`, then default.

### Built-in Stripe payments in blank Capsules

Every newly generated blank Capsule includes this credential-free project
configuration:

```json
{
  "payments": {
    "stripe": {
      "enabled": false
    }
  }
}
```

`payments` remains optional so existing Capsules and non-blank demonstration
templates retain their current behavior. The dormant shape is exact and grants
no provider authority. Activation is all-or-nothing:

```json
{
  "payments": {
    "stripe": {
      "enabled": true,
      "secretKeyEnv": "STRIPE_SECRET_KEY",
      "webhookSecretEnv": "STRIPE_WEBHOOK_SECRET",
      "publicOrigin": "https://capsule.example",
      "callbackPath": "/__sporades/stripe/webhook",
      "apiVersion": "2026-07-29.dahlia",
      "livemode": false,
      "requestTimeoutMs": 10000
    }
  }
}
```

The two env fields name values stored with `sporades env set`; secret values do
not belong in `sporades.json`. The runtime validates the complete shape and the
matching `sk_test_` or `sk_live_` and `whsec_` Sealed Server credentials before
publishing an activated Capsule. A hosted `publicOrigin` must be an exact HTTPS
origin. Explicit loopback HTTP origins are admitted for Dev sessions. Return
paths are resolved only against that trusted origin, never an incoming Host
header. Unknown providers, undeclared options, partial activation, mode-mismatched
credentials, malformed origins, and unsupported compatibility versions fail as
`INVALID_STRIPE_PAYMENTS_CONFIG`.

The generated `server/payments.ts` contains an empty server-owned Price
catalogue, a deny-by-default `authorizeStripeCheckout` policy seam, named
Checkout and Customer Portal Jobs, and a query that exposes only bounded state
for a known payment Job owned by the current actor. `shared/payments.ts`
contains the serializable Job-state shape. `client/payments.ts` starts Checkout,
reports pending, succeeded, or safely failed progress, validates the returned
Stripe-hosted URL, and redirects only after success. It is not imported into the
blank UI automatically.

To activate one-time Checkout, define Capsule product keys in the server-owned
Price catalogue, make an explicit billing decision in
`authorizeStripeCheckout`, enable the complete configuration, and seal both
named credentials. Browser input contains only an opaque intent ID, Capsule
product key, and bounded quantity. The linked-user mutation atomically persists
the intent and enqueues a durable Job. Network I/O starts after commit. Capsule,
operation, actor, and intent identity form the stable Stripe and Job idempotency
key, so retries and repeated mutation calls converge on the same work. Transient
provider failures retry within the declared Job policy; permanent rejection is
retained as bounded redacted failure metadata.

Anonymous Checkout remains off by default. A Capsule may opt in only by
deliberately relaxing the linked-user guard, authorizing the guest in the policy
seam, and deriving the business reference in server code. That opt-in grants no
Customer Portal or Team billing authority. The callback path is configuration
only until webhook admission is implemented; it is not registered by this
Checkout slice.

Sporades owns Stripe transport, retries, compatibility, redirect validation,
and safe provider-error translation behind `sporades/server/stripe`. The Capsule owns
Prices, Customers, Teams, billing authority, subscriptions, entitlements,
notifications, retention, export, and erasure. Do not place secrets or provider
identities in `sporades.json`, shared code, or browser code.

Use `dev.port` when you always want a different Dev session port. Use
`deploy.port` for local Container sessions.

`services.database` declares database Capsule service intent. Supported engines
are `libsql` and `postgres`. `services.storage` declares storage Capsule
service intent; the first supported engine is `minio`. Sporades turns that
intent into a deterministic Docker Compose file under
`.sporades/compose/capsule-services.compose.yml`; the generated file, service
names, network, volume, and labels are Sporades-owned runtime state. Do not
hand-edit the Compose YAML for the supported path; edit `sporades.json` and let
Sporades regenerate it.

For Dev sessions and local Container sessions, declaring that libSQL database
service also selects Sporades' internal libSQL service-backed Database adapter.
The adapter connects with the server-only URL generated by the local service
startup path: Dev sessions use the published loopback service port, and local
Container sessions use the generated Compose service DNS name on the services
network. Capsule code still uses the normal `ctx.db` API; app code does not
need to read the service URL or choose a database client.

#### Use Postgres locally

To run a Capsule against Postgres instead of the default embedded SQLite
database, declare a Postgres database Capsule service in `sporades.json`:

```json
{
  "name": "notes",
  "services": {
    "database": {
      "kind": "database",
      "engine": "postgres"
    }
  }
}
```

Then start the Capsule normally:

```sh
# Starts a Dev session and its Postgres service.
sporades dev

# Or builds and starts a local Container session on the same services network.
sporades deploy
```

Sporades generates `.sporades/compose/capsule-services.compose.yml`, starts a
`postgres:16-alpine` service, waits for it to become healthy, and selects the
internal Postgres Database adapter. Dev sessions connect through a generated
loopback port; local Container sessions use the generated Compose service name.
Sporades owns the database name, user, password, connection URL, network, and
Compose configuration. Do not copy those generated credentials into app code
or add a Postgres client dependency.

Capsule server code does not change when the database engine changes. Define
tables with `table()`, read and write through `ctx.db`, and use the normal query
and mutation APIs. Sporades applies the supported app-schema setup and
migrations through the selected adapter:

```ts
export default capsule({
  name: "notes",
  mutations: {
    createNote: mutation(async (ctx, input: { body: string }) => {
      return await ctx.db.notes.insert({ body: input.body });
    }),
  },
});
```

Inspect the running local session and its service state with the existing
structured commands:

```sh
sporades dev status --json
sporades deploy status --json
sporades doctor --session dev --json
```

Postgres data persists under `.sporades/services/database/` across ordinary
stops and restarts. `sporades dev reset` or `sporades deploy reset` deliberately
deletes generated Capsule service state, including the Postgres data. Changing
an existing Capsule from SQLite to Postgres selects a separate database; it
does not copy the existing SQLite rows automatically.

Postgres Capsule service orchestration is currently local-only. Hosted Capsules
do not provision or attach the declared service yet, so a Capsule that must run
on a Host server today should continue using the default embedded SQLite path.

Declaring `services.storage` with `engine: "minio"` starts a local MinIO
service for Dev sessions and local Container sessions, selects the internal
S3-compatible Storage adapter, and injects server-only connection env. Capsule
code still uses the normal `files` SDK; app code does not read MinIO endpoints,
access keys, Object bucket names, object keys, or storage-client libraries.
Those details are runtime plumbing and must not appear in client bundles or app
authoring APIs. Local filesystem storage remains the default when
`services.storage` is omitted.

`files.storagePath` configures only the default local filesystem storage
adapter's byte directory. It is not a File path prefix, not a generic storage
setting, and not used by MinIO-backed storage. File paths are logical,
Capsule-scoped Sporades paths regardless of which Storage adapter stores the
bytes.

The first Docker Compose Capsule service implementation is local-only. Dev
sessions and local Container sessions can start, inspect, stop, and reset
declared local service state. Hosted Capsule service orchestration is deferred:
future Host servers should interpret the same `sporades.json` service intent
through `sporades host ...` commands rather than requiring app code, hand-edited
Compose files, or a separate top-level service namespace.

Hosted Capsules do not yet provision or attach declared database or storage
services. Until Host service orchestration exists, do not rely on `services` for
Hosted Capsules; keep using the default embedded SQLite and local file-storage
paths for hosted releases that need to run today.

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

## Start a Dev Session

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
