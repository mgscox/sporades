# 02 — Issue, call, and revoke one scoped Access key

**What to build:** Let a linked user approve one named Access key through a live Session, disclose its secret once, use it to call an explicitly guarded scoped Custom endpoint as that same user, inspect its safe metadata, and revoke it so every later admission fails.

**Blocked by:** 01 — Expand Auth admission without changing Session behavior

**Status:** ready-for-agent

- [ ] A linked, non-guest Session can issue, list, and revoke only its own Access keys through the trusted current-user interface; an Access key, Anonymous Session, Job, lifecycle hook, Schedule, or Privileged projection cannot use those owner operations.
- [ ] Issuance enforces the agreed immutable owner, unique current name, grant validation/default `*`, optional future expiry, owner counters, record limits, and one-time complete-token disclosure without persisting plaintext credential material.
- [ ] The versioned selector/verifier credential uses the agreed entropy, strict bounded parser, indexed selector lookup, domain-separated verifier digest, dummy unknown-selector comparison, and equal-length constant-time verification.
- [ ] The Auth-storage migration, owner ledger, unique indexes, lifecycle-specific adapter methods, transactions, and stored-row normalization work through the shared conformance surface against SQLite, service-backed libSQL, and PostgreSQL.
- [ ] Only a declaratively guarded Custom endpoint interprets `Authorization: Bearer`; admitted work receives the current owning AuthContext with provider `access-key` plus frozen `{ kind: "access-key", id, name }` provenance before middleware runs.
- [ ] Required concrete scopes are checked against live wildcard grants, scopes only narrow owner authority, and table ACL, Team, and Capsule policy continue to authorize the owning user rather than a synthetic actor.
- [ ] Missing, malformed, unknown, dual, disallowed-kind, missing-scope, expired, revoked, and owner-ineligible attempts produce the agreed opaque 401 or 403 behavior with no Session or Anonymous fallback and no scope or lifecycle disclosure.
- [ ] Bearer challenges, safe cache headers, successful-admission telemetry, bounded two-level failure throttling, `429` behavior, and earliest-boundary Authorization redaction are enforced without adding successful-work quotas.
- [ ] Owner issuance and revocation audits plus runtime/Capsule log attribution contain stable user/key IDs and the admitted name but never the token, selector, digest, grants in failure output, or token fragments.
- [ ] Focused source and generated-runtime tests perform a real loopback HTTP flow that issues, calls, attributes, denies, revokes, and then rejects the same key; generated artifacts and declarations remain fresh.
