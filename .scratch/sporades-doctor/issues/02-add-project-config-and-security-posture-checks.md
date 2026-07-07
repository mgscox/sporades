# Add project configuration and security posture checks

Status: ready-for-agent

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Add project-level doctor checks that validate Capsule configuration and report
the effective security posture for Dev sessions, Public Dev sessions, local
Container sessions, and Hosted Capsules. These checks should reuse existing
configuration parsing and security-policy resolution rather than creating a
parallel interpretation of `sporades.json`.

## Acceptance criteria

- [ ] Doctor validates `sporades.json` structure and supported project-level keys.
- [ ] Doctor reports effective Capsule security policy for the requested session.
- [ ] Doctor warns on Public Dev posture when the target session is public or a running Dev session is public.
- [ ] Doctor warns on permissive CORS/CSP choices for Container sessions and Hosted Capsules with clear hints.
- [ ] Doctor validates `ssh.authorizedKeys` shape and public-key material without printing full keys.
- [ ] Doctor warns when an `ssh` block resolves to no effective authorized keys.
- [ ] Doctor points SSH follow-up work to `sporades deploy ssh` or `sporades host ssh` where appropriate.
- [ ] Tests cover passing config, malformed config, Public Dev warnings, permissive security policy warnings, valid SSH config, malformed SSH config, and empty SSH config.

## Blocked by

- .scratch/sporades-doctor/issues/01-define-doctor-command-and-check-envelope.md

