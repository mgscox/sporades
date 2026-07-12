# Sporades

<p align="center">
  <a href="https://www.npmjs.com/package/sporades"><img alt="npm version" src="https://img.shields.io/npm/v/sporades.svg"></a>
  <a href="https://www.npmjs.com/package/sporades"><img alt="npm downloads" src="https://img.shields.io/npm/dm/sporades.svg"></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=22" src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white"></a>
  <a href="https://github.com/mgscox/sporades/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/sporades.svg"></a>
  <a href="https://github.com/mgscox/sporades"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-mgscox%2Fsporades-181717?logo=github"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sporades">[npm package]</a>
</p>

Designed as Agents-first, Sporades is a CLI-first platform for building, running, inspecting, and hosting
small full-stack web Capsules.

It is intended for developers and coding Agents who want deterministic commands
instead of dashboards: scaffold a Capsule, run it locally, test the bundled
runtime in Docker, then publish it to a private or cloud Host server.

```sh
# install sporades globally
npm install -g sporades
sporades -h
```

Create a 'todo' app and spin-up a live-refresh dev server, a staging server on local docker service, and deploy to a remote production server:

```sh
sporades create notes --template todo
cd notes
sporades dev
sporades deploy
sporades host push --restart
```

## Why Sporades?

- **One command loop for humans and agents**: create, run, inspect, deploy, and
  repair Capsules from the terminal.
- **Full-stack without the usual wiring**: server schema, queries, mutations,
  auth, file uploads, custom endpoints, app messages, and browser hooks live
  behind a small authoring API.
- **Same bundle everywhere**: Dev sessions, local Docker Container sessions, and
  Hosted Capsules all run the same bundled server and client output.
- **Private-host friendly**: Host servers use boring, inspectable pieces:
  Docker, Caddy, Node, SQLite, filesystem storage, and SSH.
- **Agent-operable by default**: structured JSON output, actionable error hints,
  logs, database inspection, and non-interactive commands are first-class.
- **Comprehensive SDK**: built-in authentication, database, user preferences,
  and storage.
- **Realtime everything**: configuration free - automatic notifications, even for Postgress and AWS-S3

## Documentation

- [User guide](docs/user-guide.md): build, run, inspect, deploy, auth,
  preferences, files, endpoints, messages, and common workflows.
- [Architecture](docs/architecture.md): platform model, runtime modes, Host
  server design, and ownership boundaries.
- [Runtime layout](docs/runtime-layout.md): generated files, mounts, Host
  directories, and persistent data locations.
- [Host server installation](docs/server-installation.md): prepare a Linux Host
  server for Hosted Capsules.
- [Product requirements](docs/PRD.md): implemented scope, deferred scope, and
  core product principles.
- [Roadmap](docs/ROADMAP.md): candidate features and promotion status.

## A Tiny Capsule - the entire server code for a real-time 'to-do' app

```ts
// Everything we need comes from Sporades server SDK
import {
  Boolean,
  String,
  capsule,
  mutation,
  query,
  table,
} from "sporades/server";

export default capsule({
  name: "notes",

  // tables automatically get createdAt, createdBy, and a unique Id
  schema: {
    // tables can have optional ACL - default is "open to all"
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  // queries are automatically write-through cached on the server
  queries: {
    // all todo entries for current user (anonymous by default)
    todos: query((ctx) =>
      // context 'ctx' contains user, db, storage, auth, etc.
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) =>
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId }),
    ),
  },
});
```

Client scaffolds wire `sporades/client` into React or Preact hooks, Vue
composables, Svelte stores, SolidJS signals, Lit reactive controllers, or framework-neutral subscriptions
so the UI can consume queries, mutations, and auth without hand-rolled fetch plumbing.

## What You Get

Sporades currently includes:

- React, Preact, and Vue project scaffolds with `blank`, `todo`, `guestbook`,
  `photo-library`, and `campfire` templates. Vue uses native Single-File
  Components; Campfire is the complete consented User journey tracker exemplar.
- Svelte/Vite project scaffolds across the complete template set, with native
  components and lazily observed stores. Campfire preserves identity-safe
  consent, caller-renewed Journey TTL state, and deterministic cleanup.
- SolidJS/Vite scaffolds across the complete template set, with native JSX,
  signals, identity-safe Campfire consent, and reactive-root cleanup.
- Lit/Vite Web Component scaffolds across the complete template set, with
  component styles and host-lifecycle reactive controllers. Campfire preserves
  serialized identity-safe consent, explicit Journey TTLs, and cleanup.
- Local Dev sessions with rebuilds, WebSocket reconnects, SQLite persistence,
  logs, database inspection, auth helpers, and file storage.
- Local Docker Container sessions for production-like staging tests.
- Hosted Capsules on SSH-reachable Host servers, routed through Caddy and run in
  hardened Docker containers.
- Runtime-owned auth with anonymous sessions, email auth, Google OAuth, and
  local identity simulation for tests and agents.
- Runtime-owned current-user preferences exposed through `sporades/client`
  without app preference tables. Preferences follow the Sporades user identity,
  survive Anonymous account linking, and notify same-user connected clients when
  they change.
- File uploads with private reads, explicit public URLs, replacement versions,
  and local MinIO-backed storage support.
- Custom HTTP endpoints and app messages over the Sporades client transport.
- Sealed Server env for public/private key encrypted server-only environemt variables, keeping them out of browser bundles and
  release archives.

File reads stay behind Sporades HTTP routes. They are not filesystem paths or presigned MinIO/S3 URLs.
Capsules can opt into local MinIO storage with
`services.storage.engine: "minio"`; omitted upload paths use the file name in
the Default File bucket, falling back to the logical `/default/upload` File path when no file name exists.
The Default File bucket is only a namespace fallback, not a user bucket or policy boundary.

## Install

Sporades requires Node.js 22 or newer. Install the CLI from npm:

```sh
npm install --global sporades
sporades --help
```

Sporades depends on `esbuild` for the Server Bundle and default client builds;
React and Preact clients can explicitly use the runtime-owned Vite adapter;
Vue, Svelte, SolidJS, and Lit select Vite. On newer npm versions, you
may see an `allow-scripts` warning during global install because `esbuild` uses
a postinstall script to select the native binary for your platform.

If npm blocks that script and bundling later fails, reinstall while explicitly
allowing the `esbuild` install script:

```sh
npm install --global sporades --allow-scripts=esbuild
```

To approve `esbuild` persistently for your user npm config:

```sh
npm config set allow-scripts=esbuild --location=user
```

When working in this repository, plain `npm install` uses the project
`allowScripts` entry in `package.json` to approve the reviewed `esbuild`
install script. If `esbuild` is upgraded, review and refresh that approval with:

```sh
npm approve-scripts esbuild
```

Generated Capsules use the same `sporades` command for local Dev sessions,
Container sessions, inspection, and Host operations.


## Quick Start

Create a Capsule:

```sh
sporades create notes --template todo
cd notes
```

Run a local Dev session:

```sh
sporades dev
```

Inspect it from another terminal:

```sh
sporades logs
sporades db list
sporades db dump --json
```

Test the bundled Capsule in Docker:

```sh
sporades deploy
```

Add a Host profile and publish when you have a Host server ready:

```sh
sporades host add personal \
  --server user@example.com \
  --domain apps.example.com

sporades host bootstrap --host personal --json
sporades host register notes --host personal --json
sporades host push --host personal --subname notes --verify --json
```

## Project Status

Sporades is early, active platform work. It is useful for fast prototypes,
agent-driven app loops, local production-like testing, and private hosted
Capsules, but it is not trying to be a full production platform (yet). Check the 
[Roadmap](docs/ROADMAP.md) for in-flight and planned features.

The current focus is keeping the authoring surface small, the runtime
inspectable, and the operational path friendly to both developers and agents.
Container SSH access is opt-in for local Container sessions and Hosted
Capsules through authorized public keys in `sporades.json`. Normal management
remains the CLI and Host helper surfaces; SSH is a compatibility and emergency
access path.

## License

MIT
