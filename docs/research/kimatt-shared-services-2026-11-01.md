# Kimatt shared services cutover — 2026-11-01

Operator acceptance for the [SaaS provisioning policy](../agents/saas-provisioning.md).

## Live result

- Tickets was already canonical at `https://tickets.kimatt.com`; its existing
  Cloudflare A record and public app were verified.
- Created the DNS-only Cloudflare A record `analytics.kimatt.com` to
  `168.119.161.21`. Cloudflare public DNS-over-HTTPS returned that address.
- The initial operator alias was subsequently replaced by protected per-Host
  `public.json` routing intent selecting `analytics.kimatt.com`. The managed
  observability route now proxies that public hostname directly to Umami
  without rewriting Host or forwarding through the old analytics domain.
  Managed regeneration owns the current Docker port. See the authenticated
  dashboard follow-up in [public-domain verification](./umami-public-domain-2026-11-01.md).
- Validated and reloaded the effective `/srv/sporades/caddy/Caddyfile` through
  the root-operated Caddy path. Ordinary remote DNS resolution and verified
  public HTTPS `/api/heartbeat` returned `{"ok":true}`. Direct Mac HTTPS with
  the verified DNS result also passed; no TLS verification was disabled.
- TallyTray and Tickets now use `https://analytics.kimatt.com/api/send` in both
  their deployed and local Sealed Server env. Their website IDs remain separate.
  Umami website metadata now identifies `TallyTray` / `tallytray.com` and
  `SaaS Tickets` / `tickets.kimatt.com`.

| Capsule | Previous release | Verified analytics-only release |
| --- | --- | --- |
| TallyTray | `20261029T170037Z-e82fe036` | `20261101T133227Z-e3f4fd15` |
| Tickets | `20261028T072713Z-62cd6c69` | `20261101T133228Z-0340c037` |

Both releases used the normal Host helper install, restart, health verification
and previous-release fallback. All recorded server, public asset, configuration
and SSH file hashes matched the previous release; only the sealed env file
changed. No app source was rebuilt from the independently modified local
checkouts. Host/Compose/data identities remain stable. No analytics history
migration was needed or made a condition of cutover.

## Collection acceptance

Real browser navigation emitted the runtime's same-origin
`/__sporades/collect` request. Subsequent read-only Umami database queries
confirmed the following new events against the intended separate websites:

| Browser origin | Stored hostname | Stored path | Stored time (UTC) |
| --- | --- | --- | --- |
| `https://tallytray.com` | `tallytray.com` | `/` | 2026-11-01 13:34:00.379 |
| `https://tickets.kimatt.com` | `tickets.kimatt.com` | `/` | 2026-11-01 13:35:10.448 |

This verifies actual browser-to-Capsule-to-Umami collection, beyond an HTTP 204
from the best-effort tunnel or the existence of configuration keys.

## Local checks and limits

- `npm run build`: passed.
- `node --test --test-concurrency=1 test/host-observability.test.js test/collection-tunnel.test.js`:
  2,953 passed, three skipped, zero failed. These use local receivers/fixtures;
  skipped real Docker/provider acceptance is not claimed as a pass.
- Stateful rehearsal of the metadata API client passed before live updates:
  authentication, persisted update/readback, repeat identity preservation,
  missing website and invalid-auth failure without unrelated writes. The
  wire shape was checked against Umami's pinned `v2.20.2` website route source.
- `npm run test:docs`: 56 passed, zero failed.
- The Mac/LAN resolver retained an earlier NXDOMAIN during verification;
  normal local dashboard navigation was still awaiting negative-cache expiry.
  Public DNS-over-HTTPS, remote DNS/HTTPS and direct Mac HTTPS with the DNS
  result independently passed.
- A pre-existing unprivileged systemd Caddy reload could not read root-only
  generated Capsule route files. Root-operated reload succeeded. Full service
  restart/reboot was not tested. The subsequent
  [durable route access fix](./caddy-route-service-access-2026-11-01.md) repaired
  the publisher/bootstrap contract and verified service-user validation and a
  normal systemd reload. The unused `/etc/caddy/Caddyfile` also fails parsing
  when it imports a managed file containing global options after a site block;
  the effective systemd override uses `/srv/sporades/caddy/Caddyfile` directly.
- Both helper installs reported inventory reconciliation pending; runtime and
  public health verification passed independently of that inventory warning.

Private staging, request metadata and route recovery copy are retained under
root-only `/root/kimatt-services-20261101`. Prior immutable releases remain
available for rollback. The analytics route no longer uses the legacy domain; production Capsule
collection and authenticated dashboard requests use the canonical public name.
