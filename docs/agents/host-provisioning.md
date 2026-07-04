# Host provisioning skill contract

Use this file when an agent needs to create a fresh cloud server and turn it
into a Sporades Host server. Provider scripts are intentionally thin wrappers
around one common contract: create an SSH-reachable Linux server, install the
Host server packages, copy the Sporades Host helper runtime, then run the normal
`sporades host ...` commands from the local machine.

This is a skill-type document, not a product feature. Prefer exact commands,
structured JSON output, and idempotent checks over provider dashboards. Provider
sections must explain how to use that provider's local CLI and how to adapt an
available MCP, SDK, Terraform provider, or other automation surface to the same
output contract.

## Host environment

These instructions depend upon a Linux-like (Linux, MacOS, WSL) host environment.

## Common contract

An implementation must accept these inputs, either as environment variables or
as explicitly named script parameters:

```sh
SPORADES_PROVIDER=digitalocean # digitalocean or hetzner
SPORADES_SERVER_NAME=sporades-host-01
SPORADES_REGION=nyc3 # DigitalOcean region or Hetzner location
SPORADES_SERVER_SIZE=s-1vcpu-1gb # DigitalOcean size or Hetzner server type
SPORADES_SSH_KEY_NAME=workstation
SPORADES_SSH_PUBLIC_KEY="$HOME/.ssh/id_ed25519.pub"
SPORADES_SSH_USER=root
SPORADES_HOST_ALIAS=personal
SPORADES_HOSTED_DOMAIN=example.com
SPORADES_REMOTE_ROOT=/srv/sporades
SPORADES_TLS_MODE=automatic # automatic or cloudflare-origin
SPORADES_CAPSULE_SUBNAME=team-notes # optional deployment target
```

Provider credentials are intentionally provider-specific:

- DigitalOcean: `DIGITALOCEAN_ACCESS_TOKEN`.
- Hetzner Cloud: `HCLOUD_TOKEN`.

Agents may also accept neutral provider token aliases rather than requiring the
`.env` file to name the provider. `SPORADES_API` is accepted for either
provider, and `OCEAN_API` is accepted for DigitalOcean:

```sh
export DIGITALOCEAN_ACCESS_TOKEN="${DIGITALOCEAN_ACCESS_TOKEN:-${OCEAN_API:-${SPORADES_API:-}}}"
export HCLOUD_TOKEN="${HCLOUD_TOKEN:-${SPORADES_API:-}}"
```

The implementation must produce a shell-consumable output file named
`sporades-host.env` in the current working directory:

```sh
SPORADES_PROVIDER=digitalocean
SPORADES_SERVER_ID=123456789
SPORADES_SERVER_IPV4=203.0.113.10
SPORADES_SSH_TARGET=root@203.0.113.10
SPORADES_HOST_ALIAS=personal
SPORADES_HOSTED_DOMAIN=example.com
SPORADES_REMOTE_ROOT=/srv/sporades
SPORADES_TLS_MODE=automatic
```

The implementation must be safe to retry. If the provider already has a server
with `SPORADES_SERVER_NAME`, reuse it and refresh `sporades-host.env` instead
of creating a second machine.

## Provider automation selection

Use the most capable automation surface available in this order:

1. A provider-specific MCP tool, if the current agent environment exposes one
   and it can create or find SSH keys, create or find servers, read the public
   IPv4 address, and return structured data.
2. The provider CLI, which is the canonical fallback for this document.
3. A provider SDK, Terraform/OpenTofu, or Ansible module, only when it can be
   run non-interactively and emit the same `sporades-host.env` file.
4. Manual console steps only when automation is blocked. Record the final
   server ID and IPv4 address in `sporades-host.env` before continuing.

MCP adapters must still honor the common contract. They may replace only the
provider creation script. They must not replace the shared Sporades Host server
installation script unless they also execute the same SSH, package, helper
runtime copy, `sporades host add`, `bootstrap`, `health`, and `stats`
operations.

When using an MCP, write a short local transcript in the agent response or
scratch notes that includes:

- provider name,
- tool names invoked,
- reused or created SSH key name,
- reused or created server name and server ID,
- public IPv4 address,
- generated `SPORADES_SSH_TARGET`.

## Agent workflow

1. Read `CONTEXT.md`, `docs/PRD.md`, and `docs/server-installation.md`.
2. Check the current tool environment for a provider MCP. If present, use it
   only when it can satisfy the provider adapter contract above.
3. Confirm the local machine has the selected provider CLI when no MCP is used,
   plus `ssh`, `scp`, `tar`, Node.js 22+, npm, and a checked-out Sporades repo.
4. Run exactly one provider creation script or MCP adapter below.
5. Create or update DNS:
   - `example.com A <server-ip>`
   - `*.example.com A <server-ip>`

   For disposable smoke tests, an agent may set
   `SPORADES_HOSTED_DOMAIN=<server-ip>.sslip.io` after server creation. That
   gives wildcard DNS such as `host.<server-ip>.sslip.io` without editing a DNS
   provider. Use this only for disposable verification, not a durable Hosted
   domain.
6. Wait for SSH to accept key auth on `SPORADES_SSH_TARGET`.
   If this is a disposable recreated server and the cloud provider reused an IP,
   remove the stale local host key first:

   ```sh
   ssh-keygen -R "$SPORADES_SERVER_IPV4"
   ```

   Only do this when the server was just created by the provider step and the
   IP reuse is expected.
7. Run the shared Host server installation script.
8. If `SPORADES_TLS_MODE=cloudflare-origin`, install Cloudflare origin
   certificate files before bootstrap.
9. Add the local Host profile and run `sporades host bootstrap --json`.
10. Optionally register, push, and start `SPORADES_CAPSULE_SUBNAME`.
11. Verify with `sporades host health --json`, `sporades host stats --json`,
    and a public HTTP request to the Capsule URL when a Capsule was deployed.

Do not store provider tokens, private SSH keys, OAuth credentials, Cloudflare
origin keys, or `.env.sporades.server` contents in this repository.

## Provider script: DigitalOcean

### DigitalOcean automation surface

Use a DigitalOcean MCP when one is available and exposes equivalent Droplet and
SSH-key operations. The MCP adapter must:

1. Find or create an account SSH key named `SPORADES_SSH_KEY_NAME` from
   `SPORADES_SSH_PUBLIC_KEY`.
2. Find or create a Droplet named `SPORADES_SERVER_NAME`.
3. Use image `ubuntu-24-04-x64` unless the caller explicitly sets a supported
   replacement.
4. Use `SPORADES_REGION` and `SPORADES_SERVER_SIZE`.
5. Read the Droplet public IPv4 address.
6. Write `sporades-host.env` with the common contract fields.

If there is no DigitalOcean MCP, use `doctl`. Authenticate with either:

```sh
export DIGITALOCEAN_ACCESS_TOKEN=<token>
doctl auth init --access-token "$DIGITALOCEAN_ACCESS_TOKEN"
```

or by relying on `DIGITALOCEAN_ACCESS_TOKEN` in the environment for each
command.

Helpful CLI discovery commands:

```sh
doctl compute region list
doctl compute size list
doctl compute image list --public
doctl compute ssh-key list
doctl compute droplet list
```

The DigitalOcean CLI uses `doctl compute ssh-key import` to add a local public
key file to the account, and `doctl compute droplet create` to create Droplets.
Droplet creation requires `--size` and `--image`; pass `--ssh-keys` so the new
Host server accepts key-based SSH from first boot.

Default image: `ubuntu-24-04-x64`.

```sh
#!/usr/bin/env bash
set -euo pipefail

export DIGITALOCEAN_ACCESS_TOKEN="${DIGITALOCEAN_ACCESS_TOKEN:-${OCEAN_API:-${SPORADES_API:-}}}"
: "${DIGITALOCEAN_ACCESS_TOKEN:?Set DIGITALOCEAN_ACCESS_TOKEN, OCEAN_API, or SPORADES_API}"
: "${SPORADES_SERVER_NAME:?Set SPORADES_SERVER_NAME}"
: "${SPORADES_REGION:=nyc3}"
: "${SPORADES_SERVER_SIZE:=s-1vcpu-1gb}"
: "${SPORADES_SSH_KEY_NAME:=workstation}"
: "${SPORADES_SSH_PUBLIC_KEY:=$HOME/.ssh/id_ed25519.pub}"
: "${SPORADES_SSH_USER:=root}"
: "${SPORADES_HOST_ALIAS:=personal}"
: "${SPORADES_HOSTED_DOMAIN:?Set SPORADES_HOSTED_DOMAIN}"
: "${SPORADES_REMOTE_ROOT:=/srv/sporades}"
: "${SPORADES_TLS_MODE:=automatic}"

export DIGITALOCEAN_ACCESS_TOKEN
if [ -z "$SPORADES_SSH_PUBLIC_KEY" ] || [ ! -f "$SPORADES_SSH_PUBLIC_KEY" ]; then
  if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
    SPORADES_SSH_PUBLIC_KEY="$HOME/.ssh/id_ed25519.pub"
  elif [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    SPORADES_SSH_PUBLIC_KEY="$HOME/.ssh/id_rsa.pub"
  else
    echo "No SSH public key found. Set SPORADES_SSH_PUBLIC_KEY." >&2
    exit 1
  fi
fi

if ! command -v doctl >/dev/null 2>&1; then
  echo "doctl is required. Install it, authenticate, and retry." >&2
  echo "On macOS with Homebrew: brew install doctl" >&2
  exit 1
fi

key_id="$(
  doctl compute ssh-key list --format ID,Name --no-header |
    awk -v name="$SPORADES_SSH_KEY_NAME" '$2 == name { print $1; exit }'
)"

if [ -z "$key_id" ]; then
  key_fingerprint="$(
    ssh-keygen -l -E md5 -f "$SPORADES_SSH_PUBLIC_KEY" |
      awk '{ print $2 }' |
      sed 's/^MD5://'
  )"
  key_id="$(
    doctl compute ssh-key list --format ID,FingerPrint --no-header |
      awk -v fingerprint="$key_fingerprint" '$2 == fingerprint { print $1; exit }'
  )"
fi

if [ -z "$key_id" ]; then
  key_id="$(doctl compute ssh-key import "$SPORADES_SSH_KEY_NAME" \
    --public-key-file "$SPORADES_SSH_PUBLIC_KEY" \
    --format ID --no-header)"
fi

server_id="$(
  doctl compute droplet list --format ID,Name --no-header |
    awk -v name="$SPORADES_SERVER_NAME" '$2 == name { print $1; exit }'
)"

if [ -z "$server_id" ]; then
  server_id="$(doctl compute droplet create "$SPORADES_SERVER_NAME" \
    --region "$SPORADES_REGION" \
    --size "$SPORADES_SERVER_SIZE" \
    --image ubuntu-24-04-x64 \
    --ssh-keys "$key_id" \
    --wait \
    --format ID --no-header)"
fi

server_ipv4="$(
  doctl compute droplet get "$server_id" \
    --format PublicIPv4 --no-header
)"

cat > sporades-host.env <<EOF
SPORADES_PROVIDER=digitalocean
SPORADES_SERVER_ID=$server_id
SPORADES_SERVER_IPV4=$server_ipv4
SPORADES_SSH_TARGET=$SPORADES_SSH_USER@$server_ipv4
SPORADES_HOST_ALIAS=$SPORADES_HOST_ALIAS
SPORADES_HOSTED_DOMAIN=$SPORADES_HOSTED_DOMAIN
SPORADES_REMOTE_ROOT=$SPORADES_REMOTE_ROOT
SPORADES_TLS_MODE=$SPORADES_TLS_MODE
EOF

cat sporades-host.env
```

## Provider script: Hetzner Cloud

### Hetzner Cloud automation surface

Use a Hetzner Cloud MCP when one is available and exposes equivalent server and
SSH-key operations. The MCP adapter must:

1. Find or create a project SSH key named `SPORADES_SSH_KEY_NAME` from
   `SPORADES_SSH_PUBLIC_KEY`.
2. Find or create a server named `SPORADES_SERVER_NAME`.
3. Use image `ubuntu-24.04` unless the caller explicitly sets a supported
   replacement.
4. Use `SPORADES_REGION` as the Hetzner location and `SPORADES_SERVER_SIZE` as
   the server type.
5. Read the server public IPv4 address.
6. Write `sporades-host.env` with the common contract fields.

If there is no Hetzner Cloud MCP, use `hcloud`. Authenticate with either:

```sh
export HCLOUD_TOKEN=<token>
hcloud context create sporades
```

or by relying on `HCLOUD_TOKEN` in the environment for each command.

Helpful CLI discovery commands:

```sh
hcloud location list
hcloud server-type list
hcloud image list --type system
hcloud ssh-key list
hcloud server list
```

The Hetzner Cloud CLI uses `hcloud ssh-key create --public-key-from-file` to add
a local public key file to the project, and `hcloud server create` to create a
server. Use `--location`; do not use the older datacenter flag for new
automation. Hetzner capacity and type availability varies by account, location,
and date. If server creation returns `resource_unavailable` or
`unsupported location for server type`, try another small type/location pair
before giving up.

Default image: `ubuntu-24.04`.
Default smoke-test fallbacks:

```text
ash cpx11
hil cpx11
fsn1 cax11
hel1 cax11
fsn1 ccx13
nbg1 ccx13
```

```sh
#!/usr/bin/env bash
set -euo pipefail

export HCLOUD_TOKEN="${HCLOUD_TOKEN:-${SPORADES_API:-}}"
: "${HCLOUD_TOKEN:?Set HCLOUD_TOKEN or SPORADES_API}"
: "${SPORADES_SERVER_NAME:=sporades-host-01}"
: "${SPORADES_REGION:=ash}"
: "${SPORADES_SERVER_SIZE:=cpx11}"
: "${SPORADES_SSH_KEY_NAME:=workstation}"
: "${SPORADES_SSH_PUBLIC_KEY:=}"
: "${SPORADES_SSH_USER:=root}"
: "${SPORADES_HOST_ALIAS:=personal}"
: "${SPORADES_REMOTE_ROOT:=/srv/sporades}"
: "${SPORADES_TLS_MODE:=automatic}"

if [ -z "$SPORADES_SSH_PUBLIC_KEY" ] || [ ! -f "$SPORADES_SSH_PUBLIC_KEY" ]; then
  if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
    SPORADES_SSH_PUBLIC_KEY="$HOME/.ssh/id_ed25519.pub"
  elif [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    SPORADES_SSH_PUBLIC_KEY="$HOME/.ssh/id_rsa.pub"
  else
    echo "No SSH public key found. Set SPORADES_SSH_PUBLIC_KEY." >&2
    exit 1
  fi
fi

if ! command -v hcloud >/dev/null 2>&1; then
  echo "hcloud is required. Install it, authenticate, and retry." >&2
  echo "On macOS with Homebrew: brew install hcloud" >&2
  exit 1
fi

if ! hcloud ssh-key describe "$SPORADES_SSH_KEY_NAME" >/dev/null 2>&1; then
  hcloud ssh-key create \
    --name "$SPORADES_SSH_KEY_NAME" \
    --public-key-from-file "$SPORADES_SSH_PUBLIC_KEY" >/dev/null
fi

server_id="$(
  hcloud server list -o columns=id,name -o noheader |
    awk -v name="$SPORADES_SERVER_NAME" '$2 == name { print $1; exit }'
)"

if [ -z "$server_id" ]; then
  created=""
  for pair in "$SPORADES_REGION $SPORADES_SERVER_SIZE" "ash cpx11" "hil cpx11" "fsn1 cax11" "hel1 cax11" "fsn1 ccx13" "nbg1 ccx13"; do
    set -- $pair
    location="$1"
    server_type="$2"

    if hcloud server create \
      --name "$SPORADES_SERVER_NAME" \
      --type "$server_type" \
      --image ubuntu-24.04 \
      --location "$location" \
      --ssh-key "$SPORADES_SSH_KEY_NAME" \
      --start-after-create >/dev/null; then
      created="yes"
      break
    fi
  done

  if [ -z "$created" ]; then
    echo "No Hetzner server type/location fallback succeeded." >&2
    exit 1
  fi

  server_id="$(
    hcloud server list -o columns=id,name -o noheader |
      awk -v name="$SPORADES_SERVER_NAME" '$2 == name { print $1; exit }'
  )"
fi

server_ipv4="$(hcloud server describe "$server_id" -o json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  console.log(data.public_net.ipv4.ip);
});
')"

: "${SPORADES_HOSTED_DOMAIN:=$server_ipv4.sslip.io}"

cat > sporades-host.env <<EOF
SPORADES_PROVIDER=hetzner
SPORADES_SERVER_ID=$server_id
SPORADES_SERVER_IPV4=$server_ipv4
SPORADES_SSH_TARGET=$SPORADES_SSH_USER@$server_ipv4
SPORADES_HOST_ALIAS=$SPORADES_HOST_ALIAS
SPORADES_HOSTED_DOMAIN=$SPORADES_HOSTED_DOMAIN
SPORADES_REMOTE_ROOT=$SPORADES_REMOTE_ROOT
SPORADES_TLS_MODE=$SPORADES_TLS_MODE
EOF

cat sporades-host.env
```

## Shared script: install Sporades Host server

Run this from the local Sporades repository after `sporades-host.env` exists.
It follows `docs/server-installation.md` and assumes a Debian or Ubuntu-style
host. It does not create DNS records.

```sh
#!/usr/bin/env bash
set -euo pipefail

if [ ! -f sporades-host.env ]; then
  echo "sporades-host.env is missing. Run a provider script first." >&2
  exit 1
fi

# shellcheck disable=SC1091
. ./sporades-host.env

: "${SPORADES_SSH_TARGET:?Missing SPORADES_SSH_TARGET}"
: "${SPORADES_HOST_ALIAS:?Missing SPORADES_HOST_ALIAS}"
: "${SPORADES_HOSTED_DOMAIN:?Missing SPORADES_HOSTED_DOMAIN}"
: "${SPORADES_REMOTE_ROOT:?Missing SPORADES_REMOTE_ROOT}"
: "${SPORADES_TLS_MODE:=automatic}"

if [ ! -f ./bin/sporades-host-helper.js ] || \
   [ ! -f ./src/base-image.js ] || \
   [ ! -f ./src/runtime-restart-policy.js ] || \
   [ ! -f ./Dockerfile.base ]; then
  echo "Run this from the Sporades repository root." >&2
  exit 1
fi

if command -v sporades >/dev/null 2>&1; then
  SPORADES_CLI="${SPORADES_CLI:-sporades}"
else
  SPORADES_CLI="${SPORADES_CLI:-node ./bin/sporades.js}"
fi

if [ "${SPORADES_RECREATED_SERVER:-}" = "1" ]; then
  ssh-keygen -R "$SPORADES_SERVER_IPV4" >/dev/null 2>&1 || true
fi

until ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "$SPORADES_SSH_TARGET" "true" >/dev/null 2>&1; do
  echo "Waiting for SSH on $SPORADES_SSH_TARGET..."
  sleep 5
done

ssh -n "$SPORADES_SSH_TARGET" "set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  if command -v cloud-init >/dev/null 2>&1; then
    cloud-init status --wait
  fi
  apt_locks_clear=0
  for attempt in \$(seq 1 60); do
    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then
      apt_locks_clear=1
      break
    fi
    echo \"Waiting for apt/dpkg locks... (\$attempt/60)\"
    sleep 5
  done
  if [ \"\$apt_locks_clear\" -ne 1 ]; then
    echo \"Timed out waiting for apt/dpkg locks.\" >&2
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl gnupg tar
  if ! command -v node >/dev/null 2>&1 || ! node --version | grep -Eq '^v2[2-9]\\.'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  fi
  apt-get install -y nodejs docker.io caddy
  systemctl enable --now docker
  systemctl enable --now caddy
  mkdir -p '$SPORADES_REMOTE_ROOT/bin' '$SPORADES_REMOTE_ROOT/src' '$SPORADES_REMOTE_ROOT/incoming'
"

scp ./bin/sporades-host-helper.js \
  "$SPORADES_SSH_TARGET:$SPORADES_REMOTE_ROOT/bin/sporades-host-helper"
scp ./src/base-image.js \
  "$SPORADES_SSH_TARGET:$SPORADES_REMOTE_ROOT/src/base-image.js"
scp ./src/runtime-restart-policy.js \
  "$SPORADES_SSH_TARGET:$SPORADES_REMOTE_ROOT/src/runtime-restart-policy.js"
scp ./Dockerfile.base \
  "$SPORADES_SSH_TARGET:$SPORADES_REMOTE_ROOT/Dockerfile.base"

ssh -n "$SPORADES_SSH_TARGET" "set -euo pipefail
  chmod 0755 '$SPORADES_REMOTE_ROOT/bin/sporades-host-helper'
  node --version
  docker --version
  caddy version
  tar --version
"

$SPORADES_CLI host add "$SPORADES_HOST_ALIAS" \
  --server "$SPORADES_SSH_TARGET" \
  --domain "$SPORADES_HOSTED_DOMAIN" \
  --remote-root "$SPORADES_REMOTE_ROOT" \
  --tls "$SPORADES_TLS_MODE" \
  --json

$SPORADES_CLI host use "$SPORADES_HOST_ALIAS"
$SPORADES_CLI host bootstrap --host "$SPORADES_HOST_ALIAS" --json

for attempt in 1 2 3 4 5; do
  if $SPORADES_CLI host health --host "$SPORADES_HOST_ALIAS" --json; then
    break
  fi
  echo "Waiting for Host server health route and TLS certificate..."
  sleep 5
done

$SPORADES_CLI host health --host "$SPORADES_HOST_ALIAS" --json

$SPORADES_CLI host stats --host "$SPORADES_HOST_ALIAS" --json
```

When this script is fed to `bash` over stdin, keep `ssh -n`; otherwise `ssh`
may consume the rest of the script before later install steps run.

## Optional script: install Cloudflare origin certificates

Only use this when `SPORADES_TLS_MODE=cloudflare-origin`.

```sh
#!/usr/bin/env bash
set -euo pipefail

: "${SPORADES_ORIGIN_CERT:?Set SPORADES_ORIGIN_CERT to a local origin.crt path}"
: "${SPORADES_ORIGIN_KEY:?Set SPORADES_ORIGIN_KEY to a local origin.key path}"

. ./sporades-host.env

tls_dir="$SPORADES_REMOTE_ROOT/hosts/$SPORADES_HOSTED_DOMAIN/tls"

ssh "$SPORADES_SSH_TARGET" "mkdir -p '$tls_dir'"
scp "$SPORADES_ORIGIN_CERT" "$SPORADES_SSH_TARGET:$tls_dir/origin.crt"
scp "$SPORADES_ORIGIN_KEY" "$SPORADES_SSH_TARGET:$tls_dir/origin.key"
ssh "$SPORADES_SSH_TARGET" "chmod 0644 '$tls_dir/origin.crt' && chmod 0600 '$tls_dir/origin.key'"
```

## Optional script: deploy a Capsule

Run this from a Sporades Capsule project directory after the Host profile has
been bootstrapped.

```sh
#!/usr/bin/env bash
set -euo pipefail

. ./sporades-host.env 2>/dev/null || true

: "${SPORADES_HOST_ALIAS:?Set SPORADES_HOST_ALIAS}"
: "${SPORADES_CAPSULE_SUBNAME:?Set SPORADES_CAPSULE_SUBNAME}"

sporades host register "$SPORADES_CAPSULE_SUBNAME" \
  --host "$SPORADES_HOST_ALIAS" \
  --json

COPYFILE_DISABLE=1 sporades host push \
  --host "$SPORADES_HOST_ALIAS" \
  --subname "$SPORADES_CAPSULE_SUBNAME" \
  --restart \
  --verify \
  --json

sporades host stats "$SPORADES_CAPSULE_SUBNAME" \
  --host "$SPORADES_HOST_ALIAS" \
  --json
```

## Verification checklist

- `ssh "$SPORADES_SSH_TARGET" "node --version"` returns Node.js 22+.
- `ssh "$SPORADES_SSH_TARGET" "docker --version && caddy version"` succeeds.
- `<remote-root>/bin/sporades-host-helper` exists and is executable.
- `<remote-root>/src/base-image.js`,
  `<remote-root>/src/runtime-restart-policy.js`, and
  `<remote-root>/Dockerfile.base` exist.
- `sporades host current --json` points at the expected SSH target, Hosted
  domain, remote root, and TLS mode.
- `sporades host health --host <alias> --json` succeeds after DNS is in place.
- `sporades host stats --host <alias> --json` reports Docker and Caddy as
  available.
- If a Capsule was deployed, `https://<subname>.<hosted-domain>/` resolves and
  serves the Hosted Capsule or a structured Sporades error.

## Failure handling

- Server exists but SSH fails: check that the expected public key is attached,
  wait for cloud-init, and verify security group/firewall rules allow TCP 22.
- `sporades host health` fails before DNS is configured: finish DNS first. Host
  bootstrap can prepare files, but health checks need the public domain.
- Caddy automatic HTTPS fails: confirm ports 80 and 443 reach the Host server
  and the Hosted domain plus wildcard resolve to the server IP (double-check firewall rules).
- `cloudflare-origin` bootstrap fails: install readable `origin.crt` and
  `origin.key` under `<remote-root>/hosts/<domain>/tls/`.
- Release push fails: confirm `<remote-root>/incoming` exists and the SSH user
  can write there.
- Capsule starts but remains unavailable: run `sporades host logs stdout` and
  `sporades host logs stderr` for the Capsule subname.
