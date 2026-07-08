# Audit SSH lifecycle and inspection events

Status: done

## Parent

`.scratch/privileged-audit-event-contract/PRD.md`

## What to build

Emit normalized Privileged audit events for the SSH actions Sporades already
controls. This slice covers SSH configuration validation, effective enabled or
disabled state, local Container session start/redeploy when SSH is enabled,
Hosted Capsule start/restart when SSH is enabled, and explicit inspection
through `sporades deploy ssh` and `sporades host ssh`.

The audit events should use the common envelope from issue 01 and preserve the
existing Container SSH contract: no full authorized-key material, no private
key material, no source key file paths in Hosted release data, no generated
authorized-key contents, no public SSH exposure, and no SSH state leaking into
normal deploy/push output.

User stories covered: 18-21, 23-28.

## Acceptance criteria

- [ ] Local `sporades deploy` emits audit events for SSH config validation success/failure and SSH-enabled local Container session start/redeploy where Sporades controls the behavior.
- [ ] `sporades host push` and Hosted Capsule lifecycle paths emit audit events for SSH config validation success/failure and SSH-enabled Hosted Capsule start/restart where Sporades controls the behavior.
- [ ] `sporades deploy ssh` emits an audit event when local Container SSH state is inspected.
- [ ] `sporades host ssh` emits an audit event when Hosted Capsule SSH state is inspected through the Host helper path.
- [ ] Empty effective-key states from an explicit SSH block can be audited without treating the state as an enabled SSH server.
- [ ] SSH audit metadata may include enabled state, running state, target port, loopback-only exposure, key count, and fingerprints, but never full public keys, private keys, source key file paths for Hosted releases, generated authorized-key file contents, or raw daemon logs.
- [ ] Normal `sporades deploy` and `sporades host push` output still do not expose effective SSH state except for validation errors.
- [ ] Tests cover local Container and Hosted Capsule SSH audit events through command/log surfaces and Host helper JSON behavior without requiring manual interactive SSH sessions.

## Blocked by

- `.scratch/privileged-audit-event-contract/issues/01-define-and-emit-privileged-audit-event-envelope.md`
