# Implement real Hosted domain bootstrap in the Host helper

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the real `host.bootstrap` action in the Host server helper so a configured Host profile can prepare a Hosted domain without relying on mocked remote behavior. Bootstrap should create the Host server directory layout, ensure the shared Hosted Capsule Docker network exists, install or repair Sporades-managed Caddy includes, respect the Host profile TLS mode, and remain safe to rerun on an already-prepared server.

Real-server testing must be opt-in and must not hard-code server addresses or domains. Use environment variables, optionally loaded from `.env`, for the SSH target, Hosted domain, remote root, and any test subname prefix.

## Acceptance criteria

- [ ] `sporades host bootstrap --host <alias> --json` succeeds against a real SSH-reachable Host server when the Host profile is configured from environment-provided values.
- [ ] Bootstrap creates or repairs the remote root, `bin`, `incoming`, domain-scoped registry, Capsule, TLS, and Caddy managed include directories without deleting existing Hosted Capsule state.
- [ ] Bootstrap creates the shared Docker network idempotently and reports Docker/Caddy substrate failures with standard Sporades JSON errors and actionable hints.
- [ ] Caddy managed includes are written so generated Capsule route files can be included without replacing unrelated global Caddy configuration.
- [ ] Default `automatic` TLS mode does not require Cloudflare origin certificate files; `cloudflare-origin` mode validates readable certificate and key files and reports their expected paths when missing.
- [ ] Real-server smoke tests are skipped unless required environment variables are present, and those tests may load `.env` but must not commit secrets or concrete IP addresses.

## Blocked by

None - can start immediately
