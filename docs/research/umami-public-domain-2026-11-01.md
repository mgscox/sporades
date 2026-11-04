# Umami public hostname and dashboard verification — 2026-11-01

## Reproduction and cause

The authenticated `https://analytics.kimatt.com/dashboard` rendered an empty
body. A same-origin Server Action probe returned HTTP 500, and Umami logged
`x-forwarded-host` on the legacy analytics hostname differing from the browser's
Kimatt Origin. The initial operator alias forwarded through a second Caddy
route while rewriting Host to the old domain. Heartbeat, login and collection
API checks had passed without exercising the dashboard's Server Actions.

Next.js correctly rejected those mismatched requests; its Origin checks were
not relaxed. The fix belongs in service routing and its persisted public
hostname configuration.

## Durable routing contract

Protected per-services-Host `public.json` selects the exact `analyticsDomain`.
The generated Caddy route proxies that name directly to Umami's current
loopback port. Status, registration/connect collection endpoints and hostname
reservation read the same intent. Host/data/Compose identities remain stable.
Configuration must be a private, helper-owned regular file with one hard link,
version 1 and a valid exact DNS hostname; malformed or unsafe input fails closed.

Both the desired name and names in the currently published managed route stay
reserved during a hostname transition. Disabled services retain their operator
configuration, and database restoration does not replace destination routing
intent. The operator file is retained with the protected services directory for
full Host recovery.

## Verification

- The new regression failed against the old renderer, which ignored the public
  name and generated the legacy Host-domain route.
- Observability tests: 14 passed, four real-service/optional cases skipped.
  They cover safe/default config, invalid schema/hostname, unsafe modes, symbolic
  and hard links, direct enabled/disabled routes, public URLs and reservations
  across a partially applied hostname change.
- A separate opt-in test passed through real pinned Caddy using a stateful HTTP
  emulator on an isolated internal Docker network. Login, authenticated dashboard
  data, stored pageview readback, spoofed forwarded-host handling, invalid-session
  denial and cross-origin denial passed. The emulator models the proxy-facing
  HTTP subset; it does not claim to emulate Umami's full Next.js UI or database.
- Ten focused Host configuration/custom-domain tests, build/typecheck and 56
  documentation tests passed. Full real-provider container acceptance was not run.
- Applied via normal helper upgrade and service enable. A repeated enable kept
  `https://analytics.kimatt.com` as the reported analytics URL. The old alias
  file and old analytics hostname were removed from active routing.
- The real signed-in browser dashboard rendered TallyTray and SaaS Tickets.
  TallyTray website detail navigation and a full dashboard reload passed. The
  final dashboard check found no failed resource requests.
- A fresh real TallyTray browser visit after direct routing was confirmed stored
  by Umami with hostname `tallytray.com`, path `/`, at 18:12:39.041 UTC.
- Service-user Caddy validation and normal systemd reload passed. Umami and both
  Capsule container IDs/start times were unchanged. No Origin allowlist bypass,
  provider image update or production service restart was required.

Protected route rollback copies and verification metadata are retained on the
Host in `/root/umami-public-domain-20261101`. Final helper SHA-256:
`295fabf2a715a40b9504a026d4c3fe481fb658db34f579b49b8bd20bd5c5a2c4`.
