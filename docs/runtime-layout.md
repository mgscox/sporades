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
    .public-trees/
      active.json
      <immutable-tree>/
        index.html
        <toolchain assets...>
  data.db
  files/
  services/
    database/
    storage/
  sealed-server-env/
    server-env.sealed.json
    server-env.private.pem
    server-env.public.pem
  ssh/
    authorized_keys
  compose/
    capsule-services.compose.yml
  binding.json
  remote-binding.json
  host-push/
```

Common entries:

- `build/server.mjs`: bundled server runtime and Capsule definition.
- `build/.public-trees/`: bounded immutable client outputs. `active.json`
  selects the last successful normalized public tree.
- `data.db`: SQLite database for Dev sessions.
- `files/`: uploaded file bytes for the default local filesystem Storage
  adapter in Dev sessions.
- `services/database/`: persistent data for generated local database Capsule
  services.
- `services/storage/`: persistent data for generated local storage Capsule
  services such as MinIO.
- `services/credentials.json`: generated per-project Capsule service
  credentials (database password, storage secret key). Server-only; not
  app-facing.
- `sealed-server-env/`: Sealed Server env envelopes and local key material.
- `ssh/authorized_keys`: generated public authorized-key material for
  SSH-enabled local Container sessions. Source `file` paths from
  `sporades.json` are resolved before this file is written and are not copied
  here.
- `compose/capsule-services.compose.yml`: generated Docker Compose for
  declared Capsule services.
- `binding.json`: local Container session binding.
- `remote-binding.json`: local convenience binding for a Hosted Capsule.
- `host-push/`: locally saved Hosted Capsule release archives.

Not every entry exists in every project. Sporades creates entries as commands
need them.

`compose/capsule-services.compose.yml` is generated from `sporades.json`
`services` declarations. It is marked with Sporades ownership comments and
Docker labels; users should edit the declaration intent, not this runtime file.
When `services.storage` declares MinIO, this Compose file contains the MinIO
service, its private services network, labels, a service healthcheck, and a
bind mount from `.sporades/services/storage/` to MinIO's `/data`. A
loopback-only published port is included only when the file is generated for a
Dev session; Container sessions reach services by Compose DNS name on the
services network, and no service port is published to the host. The MinIO
Object bucket, object keys, endpoint, and credentials are generated runtime
state and are not app-facing File paths.

## Capsule Runtime Files

A runnable Capsule release contains:

```text
server.mjs
sporades.json
public/
  index.html
  <toolchain assets...>
.sporades/sealed-server-env/server-env.sealed.json
.env.sporades.server
.sporades/ssh/authorized_keys
```

Sealed Server env is optional but is the long-term default for server-only
values. `.env.sporades.server` is still supported as a legacy/import-friendly
source when no sealed envelope exists. Server-only values must not be bundled
into any public asset.

`.sporades/ssh/authorized_keys` is optional generated public authorized-key
material. It is present only when `ssh.authorizedKeys` resolves to at least one
effective OpenSSH `authorized_keys` line. For Hosted Capsule releases, this
file contains generated public key policy only; original source `file` paths
are not copied into release archives.

## Local Container Mounts

`sporades deploy` runs a local Container session with release files mounted
read-only and persistent data mounted read-write.

The local Container binding at `.sporades/binding.json` records the Docker
container ID and name for lifecycle commands. `sporades deploy stop` stops the
bound container and keeps the binding, `sporades deploy restart` starts that
same stopped container without rebuilding, and `sporades deploy remove`
force-removes the bound container and deletes the binding. Persistent Capsule
data under `.sporades/data/` remains intact until the user removes or resets it
explicitly.

Before starting the container, Sporades prepares the Base image automatically:
it uses the local image when present, otherwise pulls the canonical image, and
falls back to building the bundled Base image definition when pulling is
unavailable.

```text
Container
  Base image: ghcr.io/sporades/sporades-base:0.1.0-node22-alpine
  Runtime user: invoking host UID/GID when available, or 10001:10001 when SSH is enabled
  /app/server.mjs              read-only
  /app/public/                 read-only normalized public tree
  /app/sporades.json           read-only
  /app/.sporades/sealed-server-env/server-env.sealed.json  read-only, optional
  /app/.sporades/sealed-server-env/server-env.private.pem   read-only, optional
  /app/.sporades/ssh/authorized_keys  read-only, optional generated public key material
  /app/.env.sporades.server    read-only, optional
  /app/data/                   read-write
```

Inside the container, the default SQLite path is:

```text
/app/data/data.db
```

When SSH is enabled, the Base image startup path copies the generated
authorized-key input into writable Capsule data as:

```text
/app/data/ssh/authorized_keys
```

That file is generated runtime state owned by Sporades. Each SSH-enabled start
or redeploy regenerates it from validated config-derived public key material.
Removing all effective `ssh.authorizedKeys` and redeploying disables SSH and
clears or ignores stale generated key state.

With the default local filesystem Storage adapter, file bytes also live under
the mounted persistent data area, normally `/app/data/files`. `files.storagePath`
only changes that local adapter byte directory. With a declared MinIO storage
service, uploaded bytes live in the MinIO service state under
`.sporades/services/storage/`, while the Capsule container still uses
Sporades-owned HTTP routes and server-only service env to read and write them.

Local Container sessions also run with Docker hardening defaults that are
compatible with the Sporades Base image:

- read-only container root filesystem,
- writable `/tmp` tmpfs with `nosuid`, `nodev`, and `noexec`,
- all Linux capabilities dropped,
- `no-new-privileges` security option,
- invoking host UID/GID when available, falling back to the Base image runtime
  user `10001:10001`; SSH-enabled Container sessions run as `10001:10001` so
  the `sporades` SSH login user and process user stay aligned.

Local Container sessions start SSH only when `ssh.authorizedKeys` resolves to
at least one effective public authorized key. In that case, container port 22 is
published to a Docker-assigned loopback-only host port and inspected with
`sporades deploy ssh`. Without configured keys, SSH is disabled and port 22 is
not published.

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
              .sporades/ssh/authorized_keys
              .sporades/sealed-server-env/server-env.sealed.json
              .env.sporades.server
          current -> releases/<release-id>
          data/
            sealed-server-env/
              server-env.private.pem
            ssh/
              authorized_keys
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
Sporades Base image. Host-generated Sealed Server env private keys live in
Hosted Capsule data state under `sealed-server-env/keys/`, not in exported
sealed envelopes, release archives, local Host profiles, or CLI output. Host
inspection reports key fingerprints and availability status without exposing
private key material.

When a Hosted Capsule release includes generated public authorized-key material,
the Host helper starts the container with SSH enabled, publishes container port
22 to a Docker-assigned loopback-only port on the Host server, and preserves
Caddy HTTP routing separately. The generated input lives in the immutable
release as `.sporades/ssh/authorized_keys`; the runtime copy lives under Hosted
Capsule data as `ssh/authorized_keys` and is regenerated from release material
when the container starts. Source `file` paths from the CLI machine are not
copied to the Host server. Operators inspect effective Hosted Capsule SSH state
with `sporades host ssh`; routine Host list, stats, push, and lifecycle output
do not expose SSH state unless validation fails.

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

Hosted Capsule and local Container sessions use a bounded fatal runtime restart
policy: Docker runs them with `--restart on-failure:3`. Dev sessions handle the
same fatal paths in-process and restart automatically while emitting terminal,
JSONL, and structured log events. Hosted Capsule fallback to a previous release
is not a general crash response; it is only available during
`host push --verify --fallback-to-previous-release`.
