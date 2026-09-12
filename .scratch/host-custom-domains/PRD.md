# Hosted Capsule custom domains

Source: https://github.com/mgscox/sporades/issues/40
Status: complete

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

## Verification

- Typecheck, generated build/parity check, and documentation build pass.
- Independent Standards and Spec reviews have no outstanding findings.
- Final focused run: 14 passed, 0 failed. Includes aliases through registration,
  start/restart/stop/rollback, release install, verified-push route failure,
  concurrent health repair, competing domain claims, registration rollback,
  alias removal, forged lifecycle authority, HTTP/WebSocket/OAuth checks, and
  the packed/generated Capsule acceptance checks.
- Full npm test run completed: 2,182 passed, 127 skipped, 5 failed. Three failures
  were old expected-output shapes, now updated and passing. Two packed-Capsule
  acceptance checks hit npm EALLOWSCRIPTS because npm exports this repository's
  allowScripts as npm_config_allow_scripts to nested installs. They both pass
  in the final direct Node test run, without that inherited wrapper setting.
  The complete npm-wrapped suite was not rerun after the expectation updates.
- Live DNS and certificate issuance were not exercised; no production Host was
  changed. Deployment requires Host helper upgrade and a rebuilt Capsule.
- Pull request: https://github.com/mgscox/sporades/pull/44
