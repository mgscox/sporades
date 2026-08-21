# Sporades User Guide

Build, run, inspect, and publish a Sporades Capsule. This guide starts with the
shortest useful path, then branches by what you want to accomplish.

If Sporades is not installed yet, install the package globally:

```sh
npm install --global sporades
```

## Get a Capsule running

```sh
sporades create notes --template todo
cd notes
sporades dev
```

Open the URL printed by `sporades dev`. Edit `server/`, `client/`, or `shared/`;
the Dev session rebuilds the Capsule and refreshes the browser.

Follow [Build your first Capsule](./guide/getting-started.md) for the complete
Todo walkthrough from server schema to client mutation and local Container.

When it works in development, try the same Bundle in a local Container session:

```sh
sporades deploy --port 5000
```

That is the complete starting loop. Everything below extends it.

## Walkthrough

### Build the Capsule

- [Understand the project and choose a framework](./guide/projects.md)
- [Build server behaviour](./guide/server.md)
- [Build the browser client](./guide/client.md)
- [Add authentication](./guide/auth.md)
- [Give automation scoped Access keys](./guide/auth.md#access-keys-for-named-api-access)
- [Upload and publish files](./guide/files.md)
- [Use Built-in Teams for explicit collaboration](./reference/teams.md)
- [Add realtime activity or App messages](./guide/realtime.md)
- [Run Jobs and Schedules](./guide/background-work.md)
- [Configure security, Server env, preferences, and services](./guide/configuration.md)

### Run and publish it

- [Inspect and operate local sessions](./guide/local-operations.md)
- [Publish and operate Hosted Capsules](./guide/hosting.md)
- [Troubleshoot a Capsule](./guide/troubleshooting.md)

### Look something up

- [Detailed feature and command reference](./guide/reference.md)
- [SDK documentation](./sdk-documentation.md)
- [Generated API reference](https://mgscox.github.io/sporades/api/)
- [Architecture](./architecture.md)
- [Runtime layout](./runtime-layout.md)

## How the pieces fit together

`server/index.ts` defines schema and server behaviour. The configured client
entry builds the browser UI. `shared/` holds portable types and helpers.
`sporades.json` declares Capsule configuration. Sporades owns `.sporades/`,
which contains replaceable Bundles and persistent local runtime state.

Dev sessions favour iteration speed. Local Container sessions run the same
Bundle in Docker. Hosted Capsules run a pushed release on a configured Host
server. Move through those environments in that order unless you have a good
reason not to—production is a rather expensive syntax checker. 🙂
