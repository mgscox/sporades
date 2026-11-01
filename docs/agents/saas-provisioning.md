# SaaS provisioning policy

This is Matt's deployment policy for SaaS Capsules. It applies to existing
Capsules, new Capsules and host migrations, including TallyTray at
`https://tallytray.com`, on any hosting provider. It does not change Sporades'
public opt-in runtime defaults for other users or enable production tracking in
local development and synthetic tests.

## Shared services

- Tickets: `https://tickets.kimatt.com`.
- Umami dashboard: `https://analytics.kimatt.com`.
- Umami collection endpoint: `https://analytics.kimatt.com/api/send`.

These organization-owned service addresses are independent of the machine,
cloud provider and Hosted domain running a Capsule. Keep service provisioning
credentials on the services Host or in the operator's credential store. Capsules
receive only their own collection endpoint and website ID in Sealed Server env.

Every production SaaS Capsule must declare runtime-owned Umami analytics in
`sporades.json`:

```json
{
  "analytics": {
    "provider": "umami",
    "endpointEnv": "ANALYTICS_ENDPOINT",
    "websiteIdEnv": "ANALYTICS_WEBSITE_ID",
    "redactQuery": true
  }
}
```

Provision a distinct Umami website for each production Capsule, with its public
domain as the display name/domain, and seal its website ID alongside the shared
collection endpoint. Keep staging sites separate. Retain a website ID across
Capsule host changes; a hostname or provider change alone does not require a new
website. Historical analytics need not be migrated for the kimatt.com cutover.

## Provisioning sequence

1. Establish the Capsule's canonical public domain and TLS route independently
   of its cloud provider.
2. Reuse the shared Umami service. Do not install a second analytics stack on
   every Capsule Host. A separate services Host can serve Hetzner, DigitalOcean
   and other reachable hosting environments.
3. Use the supported [Host-managed provisioning](../reference/host-observability.md#connect-capsules)
   when appropriate, selecting the services Host explicitly with `--on`. Its
   protected services `public.json` must select `analytics.kimatt.com` as
   `analyticsDomain`, so managed routes, status and newly provisioned collection
   endpoints all use the canonical hostname. Verify this with service status.
   Preserve populated provider settings: inspect them rather than assuming a
   skipped automatic connection means analytics is ready.
4. For a Capsule outside Host-managed provisioning, create the website through
   the same Umami service and configure the same runtime analytics declaration
   and Sealed Server env. The runtime requires an HTTPS collection endpoint,
   not a Hetzner API, co-located stack, or Host registration.
5. Rehearse changed integration wiring with the service-emulation skill before
   testing the real endpoint. Then publish the sealed settings through the
   Capsule's normal deployment flow.
6. Verify a real browser pageview through the Capsule's same-origin
   `/__sporades/collect` tunnel and confirm that Umami stored the event against
   the correct website. A declared config block, defined env key or HTTP 204
   from the best-effort tunnel alone is insufficient.

Missing analytics is an incomplete SaaS provisioning step. Report and resolve it;
do not silently mark the Capsule provisioned with analytics disabled. Keep query
strings, fragments and provider administration credentials out of collection.

## Existing Host identities

Public service names do not require renaming a Host registry, Capsule ID,
Compose project or data volume. Keep these identities stable unless a separate
migration is needed. Ensure custom service routes survive managed route
regeneration, container port changes and Caddy service restarts; validate the
effective Caddy configuration and retain a rollback route before cutover.
