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
  sealed-server-env/
    server-env.sealed.json
    server-env.private.pem
    server-env.public.pem
  binding.json
  remote-binding.json
  host-push/
```

Common entries:

- `build/server.mjs`: bundled server runtime and Capsule definition.
- `build/client.js`: bundled browser client.
- `data.db`: SQLite database for Dev sessions.
- `files/`: uploaded file bytes for Dev sessions.
- `sealed-server-env/`: Sealed Server env envelopes and local key material.
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
.sporades/sealed-server-env/server-env.sealed.json
.env.sporades.server
```

Sealed Server env is optional but is the long-term default for server-only
values. `.env.sporades.server` is still supported as a legacy/import-friendly
source when no sealed envelope exists. Server-only values must not be bundled
into `client.js`.

## Local Container Mounts

`sporades deploy` runs a local Container session with release files mounted
read-only and persistent data mounted read-write.

```text
Container
  Base image: ghcr.io/sporades/sporades-base:0.1.0-node22-alpine
  Runtime user: sporades (10001:10001)
  /app/server.mjs              read-only
  /app/client.js               read-only
  /app/index.html              read-only
  /app/sporades.json           read-only
  /app/.sporades/sealed-server-env/server-env.sealed.json  read-only, optional
  /app/.sporades/sealed-server-env/server-env.private.pem   read-only, optional
  /app/.env.sporades.server    read-only, optional
  /app/data/                   read-write
```

Inside the container, the default SQLite path is:

```text
/app/data/data.db
```

File bytes also live under the mounted persistent data area.

Local Container sessions also run with Docker hardening defaults that are
compatible with the Sporades Base image:

- read-only container root filesystem,
- writable `/tmp` tmpfs with `nosuid`, `nodev`, and `noexec`,
- all Linux capabilities dropped,
- `no-new-privileges` security option.
- non-root runtime user `10001:10001`.

The Base image is a thin Sporades-owned Node 22 image. It does not bake in
Capsule app dependencies. Release files are mounted into known read-only paths,
and only `/app/data` plus `/tmp` are writable at runtime. Sporades labels
containers with the Base image name, version, and update policy so Host
inspection can report the runtime substrate.

## Base Image Updates

Capsules use a Base image update policy. Supported policy values are:

- `host-managed`: default. The Host server/operator replaces containers with a
  newer Base image as part of normal lifecycle management.
- `manual`: inspection reports the Base image state, but Sporades does not
  mutate or replace the running container automatically.
- `auto-patch`: accepted as a policy value for forward compatibility, but the
  current Base image reports in-container patching as unsupported. Sporades
  applies security updates by replacing containers rather than running package
  updates inside a live Capsule.

Project config may set either `baseImage.updatePolicy: "manual"` or the shared
metadata shape `baseImage.updatePolicy.mode: "manual"`.

Persistent Capsule data is outside the image and outside immutable release
directories, so Base image replacement preserves SQLite data, uploaded file
bytes, and runtime metadata under the explicit data mount.

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
              .sporades/sealed-server-env/server-env.sealed.json
              .env.sporades.server
          current -> releases/<release-id>
          data/
            sealed-server-env/
              server-env.private.pem
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
env inputs remain read-only mounts; only the Hosted Capsule `data/` directory is
mounted read-write. Hosted Capsule containers run as `10001:10001` from the
Sporades Base image. Host-profile Sealed Server env private keys live in Hosted
Capsule data state, not in exported sealed envelopes.

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
Capsule subname, Capsule ID, release ID, Base image name, Base image version,
and Base image update policy.
