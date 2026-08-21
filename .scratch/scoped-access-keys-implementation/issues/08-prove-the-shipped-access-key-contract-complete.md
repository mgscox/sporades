# 08 — Prove the shipped Access-key contract complete

**What to build:** Reconcile the completed slices into one release-ready Sporades contract and prove that source, generated Bundles, public packages, documentation, all Database adapters, security evidence, and real Dev and Container network behavior agree at one immutable commit.

**Blocked by:** 04 — Ship browser Access-key management; 05 — Read private Files with an Access key; 06 — Carry Credential provenance through durable Jobs; 07 — Ship Privileged and operator Access-key controls

**Status:** complete

- [x] Canonical glossary, Product Requirements, one Access-key authority ADR, Auth/server/client/Files/Jobs/operations references, SDK map, README, change notes, CLI help, navigation, and generated API documentation describe the same user-owned Credential provenance and compatibility contract.
- [x] Public server/client declarations, source exports, client runtime, generated Bundle module graph, CLI, Host helper, declaration maps, binaries, and retained generated-source manifest are regenerated from source and pass focused parity/freshness tests.
- [x] A packed-tarball smoke imports both shipped package exports and proves the Access-key values, overloads, lifecycle types, deprecated inline alias, client singleton, and generated declarations are actually present.
- [x] The complete focused and integrated suite passes with the Access-key conformance surface running against SQLite, service-backed libSQL, and the dedicated PostgreSQL database; PostgreSQL and emitted-SQL quoting coverage may not be reported as optional skips.
- [x] A purpose-built acceptance Capsule uses a real linked Session to issue a key and proves actual HTTP behavior through both a Dev runtime and a freshly generated Container Bundle, including Session and Bearer success, Credential provenance, scopes, middleware, ACLs, Teams, Files, Jobs, rotation, revocation, recovery, and opaque denials.
- [x] Acceptance verifies challenge, status, and cache headers for missing, malformed, unknown, dual, wrong-kind, missing-scope, rotated-away, expired, revoked, owner-ineligible, and throttled credentials without disclosing scope or lifecycle details.
- [x] A unique canary credential appears only in its intentional one-time disclosure and is absent from logs, audits, errors, response capture, snapshots, metrics labels, generated artifacts, CLI output, retained files, and test diagnostics.
- [x] Hosted action routing is proved end to end through the CLI/Host-helper/container-exec contract; a live Hosted deployment is recorded only as optional release smoke, not a correctness prerequisite.
- [x] The completion report records the immutable commit, Node version, exact commands, non-secret adapter identities, Dev and Container ports, test totals and skips, generated-manifest and packed-package results, and redacted HTTP/security evidence; unexplained skips or mocked-only proof leave the ticket incomplete.

## Completion evidence

See [`../completion-report.md`](../completion-report.md), recording the mandatory fail-closed release gate at immutable commit `82ac350`.
