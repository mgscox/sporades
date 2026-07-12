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

Choose a template for the behaviour you want to explore and a framework your
team can maintain. Toolchain choice changes client compilation, not Sporades'
Dev transport or server contract. Keep application source out of `.sporades/`;
that directory is replaceable runtime state.

See the detailed reference for [project files and configuration](./reference.md#how-sporades-projects-fit-together) and the [authoritative framework/toolchain matrix](./reference.md#create-a-capsule).

Next: [build the server](./server.md) or [build the client](./client.md).
