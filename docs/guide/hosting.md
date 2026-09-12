# Hosting Capsules

Hosting has two separate jobs: provision a Host server once, then publish and
operate Capsules on it repeatedly.

For provisioning, follow [Host server installation](../server-installation.md).
For normal Capsule lifecycle commands, use the
[Hosted Capsules reference](../reference/operations-and-hosting.md#hosted-capsules).

The normal publishing sequence is register once, import or seal Server env,
push a release, then verify health and logs. Use structured Host commands so the
same workflow remains operable by people and agents; SSH is an opt-in emergency
compatibility path rather than the management interface.

Validate locally before pushing a release. A Host server is an execution target,
not a substitute for the Dev feedback loop.

For a product's own domain, register one or more exact HTTPS aliases:

```sh
sporades host register fourteen --host personal \
  --alias-domain fourteen.example \
  --alias-domain app.fourteen.example --json
```

Point each domain's DNS at the Host server and allow inbound ports 80 and 443.
For an apex, use A/AAAA records; for a subdomain, use A/AAAA or a CNAME that
resolves to the server. Only attach domains you control. Registration reserves
names on this Host server; it does not change DNS or prove public reachability.
Caddy obtains and renews certificates automatically for each alias. Aliases
use automatic TLS even when the original Hosted domain uses Cloudflare origin
certificates; that domain's wildcard certificate is not reused for aliases.

The original subdomain keeps working and remains the canonical `hostedUrl`.
Aliases share the Capsule's container, data, logs, and unavailable response.
They survive push, restart, rollback, and stop; unregister removes all routes.
`host list --json` exposes the authoritative `aliasDomains` list. The local
binding and `remoteCapsuleId` remain unchanged.

Aliases are selected at registration (up to 20, lowercase ASCII/punycode DNS
names). To change an existing Capsule's aliases, unregister it, then register
it with the complete replacement list and start it again. This causes downtime
but retains its data and releases. Re-registering without alias flags retains
the previous list, subject to fresh ownership checks. An unregistered Capsule
no longer reserves its aliases, so another Capsule can claim them. The helper's
low-level registration request accepts `aliasDomains: []` to clear the list.

Upgrade the Host helper and rebuild/push the Capsule with this version before
using custom-domain browser requests. The CLI requires the helper to confirm
all explicitly requested aliases before writing a local binding. If an older
helper ignores them, registration reports an error: upgrade the helper and
inspect the remote registration before retrying, since the canonical Capsule
may already exist even though alias ownership is unconfirmed.
The runtime admits only registered
HTTPS aliases, and OAuth requires matching host, origin, and forwarded headers.
Configure each alias callback URL with your OAuth provider and update any
explicit payment/public-origin settings in the Capsule. Canonical links built
from the Hosted `publicOrigin` still use the original subdomain. Cookies remain
scoped to each hostname; sessions are not shared between domains.

If registration and its rollback both fail, the helper keeps a durable hostname
reservation under `registry/registration-claims/` and reports both the original
failure and any route/runtime recovery failures. Repair Caddy or the Host
storage problem, then retry the original registration. Omitted alias flags
reuse the pending registration's alias list; changing that list is rejected
until recovery completes. Successful retry commits the registry and removes
the pending reservation. Other Capsules cannot claim those names meanwhile.
