# Sporades Host Server Installation

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
- SSH key access to the Host server, for example `ssh root@168.119.161.21`.

Host server:

- Linux server reachable over SSH.
- Node.js 22+ to run the Sporades Host helper.
- Docker available to run Hosted Capsule containers.
- Caddy available to serve and reload generated routes.
- `tar` available to extract pushed Capsule releases.
- Ports 80 and 443 reachable from the public internet or from Cloudflare.
- A DNS Hosted domain that resolves to the Host server. Wildcard DNS is expected
  for Capsule subdomains, for example `*.example.com`.
- Caddy-managed automatic HTTPS by default, or Cloudflare wildcard Edge TLS in
  front of the Host server when using `--tls cloudflare-origin`.

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

If the domain is proxied through Cloudflare, either:

- Keep the default `--tls automatic` mode and allow Caddy to obtain certificates
  through the proxied domain.
- Use `--tls cloudflare-origin` and install a Cloudflare origin certificate and
  key on the Host server before running `sporades host bootstrap`.

## 2. Install Host Packages

The exact package commands depend on the server distribution. On Debian or
Ubuntu-style hosts, the shape is:

```sh
ssh root@<server-ip>

apt-get update
apt-get install -y nodejs npm docker.io caddy tar
systemctl enable --now docker
systemctl enable --now caddy
```

Confirm the tools are available:

```sh
node --version
docker --version
caddy version
tar --version
```

Node 22+ is recommended because the Host helper is an ESM Node script.

## 3. Install the Server Helper Script

From the local Sporades repo, choose the remote root and create the expected
helper location:

```sh
REMOTE=root@<server-ip>
REMOTE_ROOT=/srv/sporades

ssh "$REMOTE" "mkdir -p $REMOTE_ROOT/bin $REMOTE_ROOT/incoming"
scp ./bin/sporades-host-helper.js "$REMOTE:$REMOTE_ROOT/bin/sporades-host-helper"
ssh "$REMOTE" "chmod 0755 $REMOTE_ROOT/bin/sporades-host-helper"
```

The helper path must match the Host profile `remoteRoot`. If you later create a
profile with `--remote-root /opt/sporades`, the helper must live at
`/opt/sporades/bin/sporades-host-helper`.

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
  --server root@<server-ip> \
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
  --server root@168.119.161.21 \
  --domain mattgscox.co.uk \
  --remote-root /srv/sporades \
  --json
```

The default TLS mode is `automatic`, which lets Caddy manage certificates. To
force Cloudflare origin certificates instead:

```sh
sporades host add personal \
  --server root@168.119.161.21 \
  --domain mattgscox.co.uk \
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

## 7. Register and Push a Capsule

From a Sporades Capsule project directory:

```sh
sporades host register team-notes --host personal --json
sporades host push --host personal --subname team-notes --json
sporades host start team-notes --host personal --json
```

Registration reserves the Capsule subname on the Host server and writes a local
remote binding for the current project. A registered Capsule with no running
container is routed to a Host-server-owned `503 Service Unavailable` response.

Push installs a new immutable release and updates the current release pointer.
It does not restart the Capsule by default. To push and restart the running
Capsule in one command:

```sh
sporades host push --host personal --subname team-notes --restart --json
```

On macOS, set `COPYFILE_DISABLE=1` when pushing if tar includes AppleDouble
`._*` metadata files; those files are not valid Hosted Capsule runtime files.

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

Rollback is explicit: repush the release you want to become current.

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
sporades host stats team-notes --host personal --json
sporades host logs --host personal -n 200 --json
sporades host logs http --host personal --subname team-notes -n 200 --json
sporades host logs stdout --host personal --subname team-notes -n 200 --json
sporades host logs stderr --host personal --subname team-notes -n 200 --json
```

`host stats` returns normalized Docker stats for one Hosted Capsule. `host logs`
defaults to `http`, returning recent Caddy access log entries for the Host
server. Add a Hosted Capsule subname to `http` to read that Capsule's separate
Caddy access log. Use `stdout` or `stderr` with a Hosted Capsule subname to read
recent Docker `json-file` container logs, including logs for stopped containers
that still exist. `-n`/`--lines` caps returned lines and defaults to 200.

Plain output is available by omitting `--json`, but automation should prefer
structured JSON.

## Directory Layout

With `remoteRoot=/srv/sporades` and `domain=example.com`, the Host server uses:

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
          current -> releases/<release-id>
          data/
```

Hosted Capsule containers use deterministic names based on the domain and
subname, for example `sporades-example-com-team-notes`, and include Docker
labels for Sporades ownership, Hosted domain, Capsule subname, and Capsule ID.

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
