# 07 — Ship Privileged and operator Access-key controls

**What to build:** Give authorized operators a narrow, audited way to inspect and retire Access keys for an exact user or key through a running Capsule in Dev, Container, or Hosted operation, without granting operator issuance, rotation, plaintext access, or direct database authority.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** complete

- [x] Explicit Privileged execution exposes a separate Access-key projection that can list or inspect metadata, revoke an exact key, bulk-revoke one exact owner's current keys, and delete revoked history, but cannot issue, rotate, or receive tokens.
- [x] Privileged summaries add only the owner user ID to owner-visible metadata and omit email, display name, linked identities, selector, digest, token fragments, and unrelated owners.
- [x] `sporades access-keys` ships only the agreed list, inspect, revoke, revoke-all, and delete commands, using immutable user/key IDs rather than email or display-name authority selectors.
- [x] Dev, Container, and Hosted routing all invoke the shared generated-Bundle action envelopes through the existing runtime-action and Host-helper/container-exec seams; no path opens auth tables or duplicates lifecycle SQL.
- [x] Operator actions require a running Capsule, and stopped-Capsule support is rejected with useful guidance rather than inventing a partial-runtime database mode.
- [x] Read-only commands need no confirmation; destructive commands require the agreed prompt or explicit `--yes`; bulk revocation requires the exact owner ID and typed confirmation or `--yes`; `--json` never implies consent.
- [x] Human and JSON output validate hostile/malformed envelopes, remain bounded and redacted, and provide upgrade guidance when CLI, Host helper, and generated Bundle action versions disagree.
- [x] Every Privileged inspection and mutation emits the existing structured security audit with exact execution source, target IDs, outcome, safe code, and no bearer material.
- [x] Focused CLI and Host-helper tests cover Dev, Container, Hosted routing, confirmations, non-interactive behavior, running-Capsule failures, action compatibility, generated binaries, and absence of issue/rotate commands.

## Completion evidence

- Implementation and review repairs: `08161a6`, `a8a6e99`, `16669ee`, `1c201e4`.
- Focused Privileged lifetime, rollback-preserved audit, hostile-envelope redaction, exact target/source attribution, Dev/Container/Hosted routing, confirmation, generated-binary, and stopped-Capsule tests passed.
- Independent Standards and Spec reviews were clean at `1c201e4`.
- The mandatory release gate at implementation commit `82ac350` subsequently passed the generated-Bundle operator action, packed-package, and real CLI → Host helper → container-exec acceptance proofs.
