# Bootstrap a Host server and Hosted domain

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the idempotent Host server bootstrap path for one Host profile's Hosted domain. Bootstrap should prepare the Host server substrate and enable the Hosted domain without creating Hosted Capsules, managing Cloudflare, uploading certificates, or starting containers.

## Acceptance criteria

- [ ] `sporades host bootstrap --host <alias>` ensures the remote helper can bootstrap Docker, Caddy, the shared Hosted Capsule Docker network, the remote root, and domain-scoped directories.
- [ ] Bootstrap configures the Hosted domain to use existing Cloudflare origin certificate paths under the domain-scoped TLS directory.
- [ ] Bootstrap fails with an actionable hint when the expected origin certificate or key is missing or unusable.
- [ ] Bootstrap writes or updates Sporades-managed Caddy includes without replacing unrelated global Caddy configuration.
- [ ] Bootstrap is idempotent and can be rerun without destroying Hosted Capsule state.
- [ ] Bootstrap does not configure Cloudflare, create DNS records, create origin certificates, create Unix users, install app dependencies, create registry entries, or start Hosted Capsules.
- [ ] Tests use fake remote helper/package/Caddy behavior to verify command contracts and failure output without installing real packages.

## Blocked by

- .scratch/sporades-host-server/issues/02-install-remote-host-helper-contract.md
