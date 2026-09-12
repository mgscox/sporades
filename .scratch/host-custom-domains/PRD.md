# Hosted Capsule custom domains

Source: https://github.com/mgscox/sporades/issues/40
Status: implementation

Implement the issue's minimal registration variant: repeatable --alias-domain
flags reserve exact apex/custom hostnames alongside the existing subdomain.
Keep remoteCapsuleId, canonical hostedUrl, storage and local binding unchanged.
Persist aliasDomains in the authoritative registry. Use Caddy automatic TLS
for aliases independently of canonical domain TLS. Preserve route aliases in
start, stop, restart, push, rollback, health repair and failure paths; remove
all sites on unregister. Check collisions against other canonical names,
aliases and Host health endpoints across all Hosted domains under the existing
global route lock. Re-registration retains aliases unless explicitly replaced,
and checks claims again. Roll back route publication on registry-write failure.
Carry registered aliases into runtime browser and OAuth origin checks, without
trusting arbitrary caller lifecycle metadata or forwarded hostnames. Update
source, generated bundles/types, canonical docs and focused integration tests.
