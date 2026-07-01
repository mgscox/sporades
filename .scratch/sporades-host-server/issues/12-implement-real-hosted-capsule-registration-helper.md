# Implement real Hosted Capsule registration and unavailable routes

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the real `capsule.register` action in the Host server helper so registration creates authoritative server-side Hosted Capsule state instead of depending on a mocked helper. Registration should reserve a Capsule subname within one Hosted domain, write a registry record, prepare release/data directories, regenerate the per-Capsule unavailable route, reload Caddy, and let the existing local CLI write project remote binding as a convenience pointer.

Real-server verification should scaffold either a `todo` or `guestbook` Capsule using `sporades create --template <todo|guestbook>`, configure a Host profile from environment variables, register a test subname, and confirm the generated hosted URL reaches the Host-server-owned `503 Service Unavailable` response before any release is pushed.

## Acceptance criteria

- [ ] `sporades host register <subname> --host <alias> --json` succeeds against a bootstrapped real Host server and returns the registered Hosted Capsule identity and hosted URL.
- [ ] Registration creates a domain-scoped registry record with subname, Hosted domain, Hosted Capsule identity, hosted URL, status, timestamps, and no current release.
- [ ] Registration rejects duplicate subnames within the same Hosted domain while preserving domain-scoped independence for other Host profiles/domains.
- [ ] Registration prepares persistent release and data directories without requiring a pushed release.
- [ ] Registration writes or regenerates a Caddy Capsule route that returns `503 Service Unavailable` for the registered subdomain until a container is running.
- [ ] Real-server tests create a disposable `todo` or `guestbook` Capsule from template mode and use environment-provided server/domain/subname values rather than hard-coded addresses.

## Blocked by

- .scratch/sporades-host-server/issues/11-implement-real-hosted-domain-bootstrap-helper.md
