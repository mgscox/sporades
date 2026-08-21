# Sporades Host Server Installation

> For agent-led provisioning that creates or reuses a cloud server, installs Host
> packages, copies the helper, and runs the Host bootstrap flow, 
> instruct your agent to follow the common
> contract in [host-provisioning.md](./agents/host-provisioning.md). This guide is
> the manual installation reference for an already SSH-reachable Host server.

This guide prepares a Linux Host server to run Sporades Hosted Capsules through
the `sporades host ...` CLI commands.

The local CLI talks to the Host server over SSH and executes the server helper
script at:

```sh
<remote-root>/bin/sporades-host-helper
```

The default `remote-root` is `/srv/sporades`. Use `--remote-root` when adding a
Host profile if you want a different path from the outset.

## Prerequisites

Local machine:

- A checked-out Sporades repo or installed `sporades` CLI.
- Node.js 22+ and npm.
- `tar`, `scp`, and `ssh` available on `PATH`.
- SSH key access (i.e. no SSH password) to the Host server, for example `ssh root@example.com`.
- Optional: Docker for deployment of packaged capsules on local host

Host server:

- Linux server reachable over SSH.
- Node.js 22+ to run the Sporades Host helper.
- Docker available to run Hosted Capsule containers.
- Caddy available to serve and reload generated routes.
- `tar` available to extract pushed Capsule releases.
- Ports 80 and 443 reachable from the public internet or via proxy (e.g. Cloudflare).
- A DNS Hosted domain that resolves to the Host server. Wildcard DNS is expected
  for Capsule subdomains, for example `*.example.com`.
- Caddy-managed automatic HTTPS by default, or Cloudflare wildcard Edge TLS in
  front of the Host server when using `--tls cloudflare-origin`.

> **Note:** Example bash commands to install server dependencies from a fresh Debian/ Ubuntu-type installation are detailed in section 2 below.

When a Host profile is added with `--tls cloudflare-origin`, each Hosted domain
must have readable Cloudflare origin certificate files at:

```sh
<remote-root>/hosts/<hosted-domain>/tls/origin.crt
<remote-root>/hosts/<hosted-domain>/tls/origin.key
```

For example, with `--remote-root /srv/sporades` and domain `example.com`:

```sh
/srv/sporades/hosts/example.com/tls/origin.crt
/srv/sporades/hosts/example.com/tls/origin.key
```

## 1. Prepare DNS and TLS

Point the Hosted domain and wildcard subdomains at the Host server. For a direct
A-record setup, that means:

```text
example.com   A   <server-ip>
*.example.com A   <server-ip>
```

Caddy automatic HTTPS is the default TLS mode. In that mode, Caddy obtains and
renews public certificates for generated Capsule routes, so ports 80 and 443
must be reachable for ACME HTTP/TLS challenges.

> If the domain is proxied through Cloudflare, either:
>
> - Keep the default `--tls automatic` mode and allow Caddy to obtain certificates
>   through the proxied domain.
> - Use `--tls cloudflare-origin` and install a Cloudflare origin certificate and
>   key on the Host server before running `sporades host bootstrap`.
>   Generated routes in this mode accept only Cloudflare's published origin
>   networks and forward Cloudflare's single-value `CF-Connecting-IP` as the
>   runtime's trusted client address. Direct requests to the origin are denied.
>
> Ensure your client certificate policy is configured in the Cloudflare dashboard to
> reflect the certificate provision method you are using to avoid connection errors.

## 2. Install Host Packages

The exact package commands depend on the server distribution. On Debian or
Ubuntu-style hosts, the shape is:

```sh
ssh root@<server-ip-or-hostname>

if command -v cloud-init >/dev/null 2>&1; then
  cloud-init status --wait
fi
apt_locks_clear=0
for attempt in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then
    apt_locks_clear=1
    break
  fi
  echo "Waiting for apt/dpkg locks... ($attempt/60)"
  sleep 5
done
if [ "$apt_locks_clear" -ne 1 ]; then
  echo "Timed out waiting for apt/dpkg locks." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl fail2ban gnupg tar

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs docker.io caddy

cat >/etc/fail2ban/jail.d/sporades-sshd.conf <<'EOF'
[sshd]
enabled = true
port = ssh
logpath = %(sshd_log)s
maxretry = 5
findtime = 10m
bantime = 1h
EOF

systemctl enable --now docker
systemctl enable --now caddy
systemctl enable --now fail2ban

ufw allow 80/tcp
ufw allow 443/tcp
```

Confirm the tools are available:

```sh
node --version
docker --version
caddy version
fail2ban-client status sshd
tar --version
```

Fail2ban protects the Host server's own `sshd` service. It is Host hardening,
not the audit source of truth for Capsule SSH sessions. Any later Capsule-level
Fail2ban activity should be treated as hardening-adjacent telemetry; normalized
Sporades audit events remain the user-facing record for SSH access facts.

Node 22+ is recommended because the Host helper is an ESM Node script.

## 3. Install the Server Helper Runtime

From the local Sporades repo, choose the remote root and create the expected
helper location:

```sh
REMOTE=root@<server-ip>
REMOTE_ROOT=/srv/sporades

ssh "$REMOTE" "mkdir -p $REMOTE_ROOT/bin $REMOTE_ROOT/incoming"
scp ./bin/sporades-host-helper.js "$REMOTE:$REMOTE_ROOT/bin/sporades-host-helper"
scp ./Dockerfile.base "$REMOTE:$REMOTE_ROOT/Dockerfile.base"
ssh "$REMOTE" "chmod 0755 $REMOTE_ROOT/bin/sporades-host-helper"
```

The helper path must match the Host profile `remoteRoot`. If you later create a
profile with `--remote-root /opt/sporades`, the helper must live at
`/opt/sporades/bin/sporades-host-helper`.

`Dockerfile.base` is installed beside the helper so a fresh Host server can
build the Sporades Base image locally if the configured registry image is not
already present and cannot be pulled.

Optional production defaults can be set in
`$REMOTE_ROOT/sporades-host-helper.json`. The file is JSON rather than TOML so
the dependency-free Node helper can parse it directly:

```json
{
  "hostedCapsule": {
    "dockerImage": "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
    "dockerNetwork": "sporades-hosted-capsules",
    "graceCheckMs": 500
  },
  "logs": {
    "defaultLines": 200,
    "maxLines": 10000
  }
}
```

All fields are optional.

The built-in `dockerImage` default is the thin Sporades Base image. It runs
Node 22 as non-root user `10001:10001`; release files mount read-only and
Capsule data mounts read-write at `/app/data`. Override `dockerImage` only for
Host-server experiments where you also own compatibility with that filesystem
contract.

**Precedence**: Explicit CLI/request values win over the JSON configuration file; the
JSON file wins over the helper's built-in defaults. For non-standard installs, set
`SPORADES_HOST_HELPER_CONFIG=/path/to/config.json` when running the helper.

## 4. Optionally Install Cloudflare Origin Certificate Files

Skip this step when using the default Caddy automatic HTTPS mode.

When using `sporades host add ... --tls cloudflare-origin`, create the domain
TLS directory and place the Cloudflare origin certificate material there:

```sh
REMOTE=root@<server-ip>
REMOTE_ROOT=/srv/sporades
DOMAIN=example.com

ssh "$REMOTE" "mkdir -p $REMOTE_ROOT/hosts/$DOMAIN/tls"
scp ./origin.crt "$REMOTE:$REMOTE_ROOT/hosts/$DOMAIN/tls/origin.crt"
scp ./origin.key "$REMOTE:$REMOTE_ROOT/hosts/$DOMAIN/tls/origin.key"
ssh "$REMOTE" "chmod 0644 $REMOTE_ROOT/hosts/$DOMAIN/tls/origin.crt && chmod 0600 $REMOTE_ROOT/hosts/$DOMAIN/tls/origin.key"
```

Do not commit origin certificates or keys to the Sporades repo. Keep them as
server secrets.

## 5. Add a Local Host Profile

Create a Host profile on the local machine. The alias is local configuration;
the domain, remote root, and TLS mode drive server-side paths and generated
routes.

```sh
sporades host add personal \
  --server root@<server-ip-or-hostname> \
  --domain example.com \
  --remote-root /srv/sporades \
  --json

sporades host use personal
sporades host current --json
```

For the current MVP server, replacing the example domain with
`mattgscox.co.uk` and the server with `root@168.119.161.21` is enough once DNS
has propagated:

```sh
sporades host add personal \
  --server root@example.com \
  --domain example.com \
  --remote-root /srv/sporades \
  --json
```

The default TLS mode is `automatic`, which lets Caddy manage certificates. To
force Cloudflare origin certificates instead:

```sh
sporades host add personal \
  --server root@example.com \
  --domain example.com \
  --remote-root /srv/sporades \
  --tls cloudflare-origin \
  --json
```

## 6. Bootstrap the Hosted Domain

Run bootstrap after the helper script exists. If the Host profile uses
`--tls cloudflare-origin`, run bootstrap after the Cloudflare origin certificate
files exist too:

```sh
sporades host bootstrap --host personal --json
```

Bootstrap prepares the Host server substrate for the selected Hosted domain:

- Confirms Docker and Caddy substrate expectations.
- Creates the domain-aware directory layout under `remoteRoot`.
- Uses Caddy automatic HTTPS by default, or the Cloudflare origin certificate
  files at `hosts/<domain>/tls/origin.crt` and
  `hosts/<domain>/tls/origin.key` when configured with
  `--tls cloudflare-origin`.
- Prepares Caddy managed includes under `<remote-root>/caddy`.
- Uses the shared Docker network `sporades-hosted-capsules`.

Bootstrap does not configure Cloudflare, create DNS records, create origin
certificates, register Capsules, push releases, or start containers.

## 7. Register and Push a Capsule - Smoke Test

From a Sporades Capsule project directory:

```sh
sporades host register team-notes --host personal --json

# For Google-backed templates, set OAuth credentials before importing Server env.
if [ -f ./client_secret_google.json ]; then
  sporades auth set google --client-json ./client_secret_google.json --json
fi

# If .env.sporades.server exists, import it into Sealed Server env before push.
if [ -f ./.env.sporades.server ]; then
  sporades env import --file .env.sporades.server --json
fi

sporades host push --host personal --subname team-notes --json
sporades host start team-notes --host personal --json
```

Registration reserves the Capsule subname on the Host server and writes a local
remote binding for the current project. A registered Capsule with no running
container is routed to a Host-server-owned `503 Service Unavailable` response.

Capsules with `.env.sporades.server` must import those legacy Server env values
into Sealed Server env before `sporades host push`. For templates that use
Google OAuth credentials, such as `photo-library`, run
`sporades auth set google --client-json ./client_secret_google.json --json`
first so the generated Google client ID and secret are included in the import.
Legacy Server env files are not pushed directly; `host push` re-encrypts local
Sealed Server env values to the Hosted Capsule's Host-owned public key and
packages the Host-encrypted envelope in the release.

Push installs a new immutable release and updates the current release pointer.
It does not restart the Capsule by default. To push and restart the running
Capsule in one command:

```sh
sporades host push --host personal --subname team-notes --restart --json
```

For release verification, add `--verify`. Verification starts or restarts the
new current release and checks the Hosted Capsule runtime health route:

```sh
sporades host push --host personal --subname team-notes --verify --json
```

By default, verification failure records the failed release and routes the
Capsule to the Hosted Capsule unavailable response. Automatic fallback to the
previous release is deliberately opt-in and only applies during release
verification:

```sh
sporades host push --host personal --subname team-notes --verify --fallback-to-previous-release --json
```

If fallback is applied, release history records the failed release, the fallback
decision, and the previous release selected as current. Arbitrary runtime
crashes after a release has already been verified or accepted do not
automatically roll back; Docker applies the bounded restart policy, and after
exhaustion operators should inspect `host logs stdout`, fix the release, and
push or explicitly roll back.

**Important:** On macOS, set `COPYFILE_DISABLE=1` when pushing if tar includes AppleDouble
`._*` metadata files; those files are not valid Hosted Capsule runtime files.
Whilst the server helper will silently discard known metadata files, it is preferable 
to avoid sending them.

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

Rollback is explicit: repush the release you want to become current. Previous releases are saved locally under `./.sporades/host-push`.

### Opt-in Real Host Smoke Tests

The Host tests include opt-in smoke coverage for disposable Host servers. These
tests run real SSH, mutate real Host server state, create or reuse a real Hosted
Capsule, push a real release, restart it, and fetch the public route. Use a
disposable Host server and Capsule subname.

The bootstrap smoke test runs when these variables are present:

```sh
SPORADES_HOST_SMOKE_SSH_TARGET=root@example.com
SPORADES_HOST_SMOKE_DOMAIN=example.com
SPORADES_HOST_SMOKE_REMOTE_ROOT=/srv/sporades
```

Registration, list, and push-routing smoke tests also require:

```sh
SPORADES_HOST_SMOKE_SUBNAME=my-disposable-capsule
```

The push-routing smoke test additionally requires a public HTTP(S) URL and the
expected response text. The URL can point at the page route, such as
`https://my-disposable-capsule.example.com/`, or at a client asset route, such as
`https://my-disposable-capsule.example.com/client.js`.

```sh
SPORADES_HOST_SMOKE_PUBLIC_URL=https://my-disposable-capsule.example.com/client.js
SPORADES_HOST_SMOKE_EXPECTED_TEXT="Sporades Todos"
```

Optional variables:

```sh
SPORADES_HOST_SMOKE_ALIAS=smoke
SPORADES_HOST_SMOKE_TEMPLATE=todo # todo or guestbook
SPORADES_HOST_SMOKE_TLS=automatic # automatic or cloudflare-origin
```

Run the smoke tests with:

```sh
npm test -- test/host.test.js
```

## 8. Operate Hosted Capsules

Lifecycle commands:

```sh
sporades host start team-notes --host personal --json
sporades host stop team-notes --host personal --json
sporades host restart team-notes --host personal --json
```

Inventory and diagnostics:

```sh
sporades host list --host personal --json
sporades host stats --host personal --json
sporades host stats team-notes --host personal --json
sporades host logs --host personal -n 200 --json
sporades host logs http --host personal --subname team-notes -n 200 --json
sporades host logs stdout --host personal --subname team-notes -n 200 --json
sporades host logs stderr --host personal --subname team-notes -n 200 --json
```

`host stats --json` returns Host server disk, memory, load, Docker/Caddy
availability, and Hosted Capsule counts for the selected Host profile. `host
stats <subname> --json` returns normalized Docker Container stats for one Hosted
Capsule under the `stats` key, plus lifecycle details from Host-server-owned
registry state and Docker inspect. `host logs` defaults to `http`, returning
recent Caddy access log entries for the Host server. Add a Hosted Capsule
subname to `http` to read that Capsule's separate Caddy access log. Use `stdout`
or `stderr` with a Hosted Capsule subname to read recent Docker `json-file`
container logs, including logs for stopped containers that still exist.
`-n`/`--lines` caps returned lines and defaults to 200.

`host list --json` includes each Hosted Capsule's Base image version and update
policy. Capsules created before Base image metadata existed report `unknown`
image/version values with the default `host-managed` policy until their next
release or container replacement records richer metadata. `manual` reports state
without automatic mutation; `auto-patch` currently reports that in-container
patching is unsupported because Base image updates happen by container
replacement.

Hosted Capsule containers run with Docker `--restart on-failure:3`. The Host
helper reports this restart policy in lifecycle JSON and records failed starts
or verification failures in release history. When retries are exhausted or a
start cannot produce a usable loopback route, keep the route on the Hosted
Capsule unavailable response and use `host logs stdout|stderr` plus release
history to diagnose the crash.

Plain output is available by omitting `--json`, but automation should prefer
structured JSON.

## Directory Layout

The canonical Host server directory structure, Hosted Capsule data location,
Caddy file layout, and container naming rules live in
[runtime-layout.md](./runtime-layout.md#host-server-layout). Keep that reference
updated instead of copying the tree into procedural install docs.

## Troubleshooting

- `No current Host profile selected`: run `sporades host use <alias>` or pass
  `--host <alias>`.
- `sporades-host-helper: command not found`: reinstall the helper at
  `<remote-root>/bin/sporades-host-helper` and confirm the Host profile uses the
  same `remoteRoot`.
- Missing origin certificate or key: this only applies to Host profiles created
  with `--tls cloudflare-origin`. Install readable files at
  `<remote-root>/hosts/<domain>/tls/origin.crt` and
  `<remote-root>/hosts/<domain>/tls/origin.key`, then rerun bootstrap.
- Release upload fails: ensure `<remote-root>/incoming` exists and the SSH user
  can write to it.
- Capsule starts then becomes unavailable: inspect Docker logs for the generated
  container name and check the Caddy route reload result.
- Caddy log retrieval fails: rerun `sporades host bootstrap --host <alias>` and
  check that Caddy is installed and running on the Host server.
- Node warning that SQLite integration is experimental - this is expected and can 
  be safely ignored. To avoid this use a plugin for an alternative database (roadmap feature)
