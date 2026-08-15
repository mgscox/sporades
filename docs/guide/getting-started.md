# Build Your First Capsule

This walkthrough builds a small Todo Capsule from scaffold to local Container.
It assumes Sporades is already installed.

## 1. Create and run it

```sh
sporades create notes --template todo
cd notes
sporades dev
```

Open the URL printed by the Dev session. Sporades watches server, client,
shared, configuration, and HTML source while preserving the last successful
Bundle when a rebuild fails.

## 2. Add server behaviour

Open `server/index.ts` and define the data the UI will read and change:

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
      ctx.db.todos.where("ownerId", ctx.auth.userId).all(),
    ),
  },
  mutations: {
    addTodo: mutation((ctx, text: string) =>
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId }),
    ),
  },
});
```

Keep ownership and validation on the server. The browser must not choose trusted
fields such as `ownerId`.

## 3. Connect the client

The generated client uses the native Sporades adapter for the framework selected
at creation time: subscriptions for Vanilla TypeScript, hooks for React and
Preact, lifecycle adapters for Inferno, reactive controllers for Lit, signals
for SolidJS, composables for Vue, or stores for Svelte.

For example, a React or Preact scaffold uses hooks:

```tsx
const todos = useQuery("todos");
const addTodo = useMutation("addTodo");

await addTodo.run("Buy coffee");
```

Queries remain subscribed through the Sporades transport, so successful
mutations refresh connected clients without a separate fetch layer. Other
framework adapters expose the same client contract through their native
reactivity and cleanup model. See
[Projects and Client Frameworks](./projects.md#choose-a-client-framework) to
compare all supported choices.

When you declare a Custom query that needs a client-selected value, pass its
JSON-compatible positional arguments after the query name, such as
`useQuery("todosForProject", projectId)`. Sporades snapshots those values and
uses their canonical JSON form to share equal subscriptions; see the
[client reference](../reference/client-auth-and-preferences.md#use-queries)
for the 65,536-byte limit and supported values.

## 4. Inspect it

From another terminal:

```sh
sporades logs
sporades db list
sporades db dump --json
```

## 5. Try the Container runtime

```sh
sporades deploy --port 5000
```

The local Container session runs the same Bundles with persistent local data.
Continue with [server concepts](./server.md), [client concepts](./client.md), or
[local operations](./local-operations.md) when you need more than this first slice.
