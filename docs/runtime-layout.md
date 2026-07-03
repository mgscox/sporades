# Sporades Runtime Layout

This document is the canonical reference for Sporades filesystem layouts,
runtime mounts, and Host server paths. Other docs should link here instead of
copying these structures.

## Project Runtime Directory

The project-local Runtime directory is `.sporades/`. It is gitignored and owned
by Sporades.

```text
.sporades/
  build/
    server.mjs
    client.js
  data.db
  files/
  binding.json
  remote-binding.json
  host-push/
```

Common entries:

- `build/server.mjs`: bundled server runtime and Capsule definition.
- `build/client.js`: bundled browser client.
- `data.db`: SQLite database for Dev sessions.
- `files/`: uploaded file bytes for Dev sessions.
- `binding.json`: local Container session binding.
- `remote-binding.json`: local convenience binding for a Hosted Capsule.
- `host-push/`: locally saved Hosted Capsule release archives.

Not every entry exists in every project. Sporades creates entries as commands
need them.

## Capsule Runtime Files

A runnable Capsule release contains:

```text
server.mjs
client.js
index.html
sporades.json
.env.sporades.server
```

`.env.sporades.server` is optional. When present, it is server-only runtime
input and must not be bundled into `client.js`.

## Local Container Mounts

`sporades deploy` runs a local Container session with release files mounted
read-only and persistent data mounted read-write.

```text
Container
  Base image: node:22-alpine
  /app/server.mjs              read-only
  /app/client.js               read-only
  /app/index.html              read-only
  /app/sporades.json           read-only
  /app/.env.sporades.server    read-only, optional
  /app/data/                   read-write
```

Inside the container, the default SQLite path is:

```text
/app/data/data.db
```

File bytes also live under the mounted persistent data area.

Local Container sessions also run with Docker hardening defaults that are
compatible with the stock `node:22-alpine` Base image:

- read-only container root filesystem,
- writable `/tmp` tmpfs with `nosuid`, `nodev`, and `noexec`,
- all Linux capabilities dropped,
- `no-new-privileges` security option.

Sporades intentionally does not force a non-root user while using the stock
Base image because host bind-mounted data directories need predictable write
access. A future hardened Base image can own that user and directory contract.

## Host Server Layout

With `remoteRoot=/srv/sporades` and `domain=example.com`, a Host server uses:

```text
/srv/sporades/
  bin/
    sporades-host-helper
  incoming/
  caddy/
    Caddyfile
    sporades-hosted-domains.caddy
    hosts/
      example.com.caddy
      example.com/
        <subname>.caddy
  hosts/
    example.com/
      tls/
        origin.crt
        origin.key
      registry/
      capsules/
        <subname>/
          releases/
            <release-id>/
              server.mjs
              client.js
              index.html
              sporades.json
              .env.sporades.server
          current -> releases/<release-id>
          data/
```

`tls/` is only required for Host profiles that use
`--tls cloudflare-origin`. Caddy automatic HTTPS does not require preinstalled
origin certificate files.

## Hosted Capsule Data

Each Hosted Capsule has a persistent `data/` directory under its domain-scoped
Capsule directory:

```text
/srv/sporades/hosts/example.com/capsules/<subname>/data/
```

That directory is mounted read-write into the Hosted Capsule container and
contains the Capsule's SQLite database and uploaded file bytes. It is not part
of any immutable release.

Hosted Capsules use the same Docker hardening posture as local Container
sessions: read-only root filesystem, writable hardened `/tmp` tmpfs, dropped
Linux capabilities, and `no-new-privileges`. Release files and optional Server
env remain read-only mounts; only the Hosted Capsule `data/` directory is
mounted read-write.

## Host Caddy Files

Sporades-managed Caddy files live under:

```text
/srv/sporades/caddy/
```

The top-level managed include points Caddy at domain files, and each domain file
points at per-Capsule route files. A registered Hosted Capsule gets a route file
even before it has a running container, so Caddy can return the Hosted Capsule
unavailable response instead of treating the hostname as unknown.

## Container Naming

Hosted Capsule containers use deterministic names based on Hosted domain and
Capsule subname, for example:

```text
sporades-example-com-team-notes
```

Containers also carry Docker labels for Sporades ownership, Hosted domain,
Capsule subname, and Capsule ID.
