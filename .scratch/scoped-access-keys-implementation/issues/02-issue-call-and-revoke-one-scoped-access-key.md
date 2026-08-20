# 02 — Issue, call, and revoke one scoped Access key

**What to build:** Let a linked user approve one named Access key through a live Session, disclose its secret once, use it to call an explicitly guarded scoped Custom endpoint as that same user, inspect its safe metadata, and revoke it so every later admission fails.

**Blocked by:** 01 — Expand Auth admission without changing Session behavior

**Status:** complete

- [x] A linked, non-guest Session can issue, list, and revoke only its own Access keys through the trusted current-user interface; an Access key, Anonymous Session, Job, lifecycle hook, Schedule, or Privileged projection cannot use those owner operations.
- [x] Issuance enforces the agreed immutable owner, unique current name, grant validation/default `*`, optional future expiry, owner counters, record limits, and one-time complete-token disclosure without persisting plaintext credential material.
- [x] The versioned selector/verifier credential uses the agreed entropy, strict bounded parser, indexed selector lookup, domain-separated verifier digest, dummy unknown-selector comparison, and equal-length constant-time verification.
- [x] The Auth-storage migration, owner ledger, unique indexes, lifecycle-specific adapter methods, transactions, and stored-row normalization work through the shared conformance surface against SQLite, service-backed libSQL, and PostgreSQL.
- [x] Only a declaratively guarded Custom endpoint interprets `Authorization: Bearer`; admitted work receives the current owning AuthContext with provider `access-key` plus frozen `{ kind: "access-key", id, name }` provenance before middleware runs.
- [x] Required concrete scopes are checked against live wildcard grants, scopes only narrow owner authority, and table ACL, Team, and Capsule policy continue to authorize the owning user rather than a synthetic actor.
- [x] Missing, malformed, unknown, dual, disallowed-kind, missing-scope, expired, revoked, and owner-ineligible attempts produce the agreed opaque 401 or 403 behavior with no Session or Anonymous fallback and no scope or lifecycle disclosure.
- [x] Bearer challenges, safe cache headers, successful-admission telemetry, bounded two-level failure throttling, `429` behavior, and earliest-boundary Authorization redaction are enforced without adding successful-work quotas.
- [x] Owner issuance and revocation audits plus runtime/Capsule log attribution contain stable user/key IDs and the admitted name but never the token, selector, digest, grants in failure output, or token fragments.
- [x] Focused source and generated-runtime tests perform a real loopback HTTP flow that issues, calls, attributes, denies, revokes, and then rejects the same key; generated artifacts and declarations remain fresh.

## Implementation evidence

- Implementation and repair commits: `2ede8b3`, `48fe0a5`, `4f87ed6`, `e6b0a6d`, `ebc095a`, `8d27903`, `f091dd8`.
- Focused source/type proof: `node --test test/access-keys.test.js test/types.test.js`.
- Shared adapter proof: `node --test test/database-adapter-conformance-auth-storage.test.js test/database-adapter-conformance-coverage.test.js test/database-adapter-engine-seam.test.js test/postgres-emitted-sql-quoting.test.js` (SQLite and service-backed libSQL executed; PostgreSQL cases are registered on the same surface and require `SPORADES_POSTGRES_TEST_URL`).
- Generated-runtime proof: `node --test test/server-bundle-module-graph.test.js` and the real Dev HTTP/WebSocket `requireAuth` flow in `test/require-auth.test.js`.
- Public/generated parity: `npm run build`, `npm run docs:api`, generated source manifest, declarations, bundled CLI/runtime, and API reference refreshed.
- Independent commit-pinned Standards and Spec reviews are clean at `f091dd8`.
