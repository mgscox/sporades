# Building the Client

The client SDK provides subscribed queries, mutations, authentication state,
files, preferences, App messages, and Journey state over the Sporades transport.

Build the first screen around one subscribed query and one mutation. Queries
remain subscribed across reconnects; mutations trigger the normal connected
refresh path. Own subscription cleanup through the adapter for your framework,
or call `unsubscribe()` when using the framework-neutral client directly.

Start with
[queries, mutations, and auth state](./reference.md#building-the-client-side).
Framework adapters bind that same transport to each admitted framework; they do
not change the server contract. See
[Choose a client framework](./projects.md#choose-a-client-framework) for all
eight supported choices and their scaffolded reactivity model.

Next: [authentication](./auth.md), [files](./files.md), or [realtime features](./realtime.md).
