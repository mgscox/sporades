# Spike SSH daemon session-log scanner

Status: done

## Parent

`.scratch/privileged-audit-event-contract/PRD.md`

## What to build

Run a design spike for real SSH login/session audit capture. The preferred
candidate is to configure `sshd` to write auth/session logs to a dedicated file
under the writable data mount, then have Sporades scan from a remembered cursor
and translate only known-safe daemon log lines into normalized Privileged audit
events.

The spike should decide whether this approach can be implemented without a
second audit daemon, without weakening the Base image/container hardening model,
and without turning raw `sshd` log text into the user-facing audit contract.

User stories covered: 22, 27-28.

## Acceptance criteria

- [ ] The spike proves whether `sshd` can emit suitable auth/session facts to a dedicated writable log file in local Container sessions and Hosted Capsules.
- [ ] The proposed scanner design is cursor-based and idempotent across runtime restart, file truncation, and log rotation.
- [ ] The parser is limited to a whitelist of safe events such as authentication success, safe authentication failure, session open, session close, and disconnect.
- [ ] Unknown daemon log lines remain raw diagnostics and do not become Privileged audit events.
- [ ] Translated events use the common audit envelope and event names such as `ssh.session.opened`, `ssh.session.closed`, `ssh.auth.succeeded`, and `ssh.auth.failed`.
- [ ] The design states which metadata is safe, such as username, remote address where acceptable, key fingerprint where available, source `sshd`, and session outcome.
- [ ] The design states which metadata is forbidden, including full public keys, commands, environment values, raw daemon log lines, private key material, and secrets.
- [ ] The spike documents whether implementation should proceed, defer to Base image logging work, or use an alternative OpenSSH hook/stdout design.

## Blocked by

- `.scratch/privileged-audit-event-contract/issues/01-define-and-emit-privileged-audit-event-envelope.md`
