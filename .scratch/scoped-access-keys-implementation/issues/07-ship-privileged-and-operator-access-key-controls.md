# 07 — Ship Privileged and operator Access-key controls

**What to build:** Give authorized operators a narrow, audited way to inspect and retire Access keys for an exact user or key through a running Capsule in Dev, Container, or Hosted operation, without granting operator issuance, rotation, plaintext access, or direct database authority.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** ready-for-agent

- [ ] Explicit Privileged execution exposes a separate Access-key projection that can list or inspect metadata, revoke an exact key, bulk-revoke one exact owner's current keys, and delete revoked history, but cannot issue, rotate, or receive tokens.
- [ ] Privileged summaries add only the owner user ID to owner-visible metadata and omit email, display name, linked identities, selector, digest, token fragments, and unrelated owners.
- [ ] `sporades access-keys` ships only the agreed list, inspect, revoke, revoke-all, and delete commands, using immutable user/key IDs rather than email or display-name authority selectors.
- [ ] Dev, Container, and Hosted routing all invoke the shared generated-Bundle action envelopes through the existing runtime-action and Host-helper/container-exec seams; no path opens auth tables or duplicates lifecycle SQL.
- [ ] Operator actions require a running Capsule, and stopped-Capsule support is rejected with useful guidance rather than inventing a partial-runtime database mode.
- [ ] Read-only commands need no confirmation; destructive commands require the agreed prompt or explicit `--yes`; bulk revocation requires the exact owner ID and typed confirmation or `--yes`; `--json` never implies consent.
- [ ] Human and JSON output validate hostile/malformed envelopes, remain bounded and redacted, and provide upgrade guidance when CLI, Host helper, and generated Bundle action versions disagree.
- [ ] Every Privileged inspection and mutation emits the existing structured security audit with exact execution source, target IDs, outcome, safe code, and no bearer material.
- [ ] Focused CLI and Host-helper tests cover Dev, Container, Hosted routing, confirmations, non-interactive behavior, running-Capsule failures, action compatibility, generated binaries, and absence of issue/rotate commands.
