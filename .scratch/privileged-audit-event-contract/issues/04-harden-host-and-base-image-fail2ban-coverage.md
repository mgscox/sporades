# Harden Host and Base image Fail2ban coverage

Status: done

## Parent

`.scratch/privileged-audit-event-contract/PRD.md`

## What to build

Lock in Fail2ban coverage for the Host server and Base image without confusing
hardening with the audit source of truth. Host server provisioning should
install and enable Fail2ban for the Host server's own `sshd` service with an
explicit `sshd` jail. The Sporades Base image should carry Fail2ban as dormant
SSH hardening material alongside OpenSSH.

Capsule-level Fail2ban enablement is intentionally constrained: it must not
grant broad extra network administration capabilities, weaken Docker hardening,
require public SSH exposure, make release mounts writable, introduce sudo, or
enable root login. If Capsule-level bans are later emitted as audit events, they
remain secondary telemetry rather than the source of truth for SSH session
facts.

User stories covered: 22, 27 plus SSH hardening decisions.

## Acceptance criteria

- [ ] Host server installation docs and agent provisioning automation install Fail2ban on Debian/Ubuntu-style Hosts.
- [ ] Host server installation writes an explicit `sshd` jail and enables `fail2ban`.
- [ ] Host provisioning verification includes `fail2ban-client status sshd`.
- [ ] The Base image build includes Fail2ban alongside dormant OpenSSH capability.
- [ ] Tests or docs tests prove the Host provisioning script and Base image contract include Fail2ban coverage.
- [ ] The implementation does not enable Capsule-level Fail2ban by adding broad capabilities or weakening existing Docker hardening.
- [ ] Documentation or planning text makes clear that Fail2ban activity is hardening-adjacent telemetry and not the audit source of truth.

## Blocked by

None - can start immediately.
