# Projects and Client Frameworks

Use this page when creating a Capsule, choosing a template, or changing its
client framework and toolchain.

Start with `sporades create <name> --template <template>`. Sporades creates the
server, client, shared code, author-owned `index.html`, and `sporades.json`.

```sh
sporades create notes --template todo
cd notes
sporades dev
```

## Choose a template

Every built-in template is available with every supported client framework.
Choose the smallest example that demonstrates the Sporades features you want to
learn or adapt:

| Template | What it demonstrates |
| --- | --- |
| `blank` | The minimal Capsule layout, an empty server definition, and the selected framework's connection to `sporades/client`. Start here when you do not want example domain code. |
| `todo` | Anonymous per-user data, a table, subscribed query, mutation, and automatic realtime refresh after writes. |
| `guestbook` | Server-trusted identity from `ctx.auth`, input validation, anonymous and linked-user attribution, and a realtime ordered feed. |
| `photo-library` | File uploads, private and public file URLs, persisted file metadata, authentication-aware views, and a durable scheduled Job. |
| `campfire` | Multi-user realtime chat, email-authenticated demo identities, durable reactions, current-user preferences, and explicitly consented ephemeral Journey activity. The fixture credentials are development-only. |

For example:

```sh
sporades create notes --template todo --framework vue
sporades create gallery --template photo-library --framework lit
sporades create chat --template campfire --framework svelte
```

## Choose a client framework

Sporades supports eight client choices. They all consume the same subscribed
queries, mutations, authentication, Files, preferences, App messages, and
Journey transport; the framework adapter changes how that state participates in
the framework's own lifecycle and reactivity model.

| Framework | Scaffolded client style | Toolchain |
| --- | --- | --- |
| Vanilla TypeScript | Framework-neutral subscriptions with explicit cleanup | esbuild |
| React | Hooks | esbuild by default; Vite optional |
| Preact | Hooks | esbuild by default; Vite optional |
| Inferno | Native class components and lifecycle adapters, without React compatibility packages | esbuild by default; Vite optional |
| Lit | Web Components and reactive controllers | Vite |
| SolidJS | Native JSX, signals, and reactive primitives | Vite |
| Vue | Single-File Components and composables | Vite |
| Svelte | Native components and stores | Vite |

All eight choices support `blank`, `todo`, `guestbook`, `photo-library`, and
`campfire`. Toolchain choice changes client compilation, not Sporades' server
contract or acknowledged full-page Dev refresh protocol; Sporades does not run a
second framework dev server or promise HMR.

Keep application source out of `.sporades/`; that directory is replaceable
runtime state.

See the detailed reference for
[project files and configuration](./reference.md#how-sporades-projects-fit-together)
and the
[authoritative framework/toolchain matrix](./reference.md#create-a-capsule).

Next: [build the server](./server.md) or [build the client](./client.md).
