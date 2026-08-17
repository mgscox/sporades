# 06 — Prove and pack the combined platform contracts

**What to build:** Produce one immutable, reviewable Sporades candidate that demonstrably contains the exact Team-inspection and Capsule-table uniqueness contracts across source, generated artifacts, documentation, supported Database adapters, and the npm tarball.

**Blocked by:** 02 — Expose the complete Privileged Team inspection surface; 04 — Insert rows idempotently against declared uniqueness; 05 — Add uniqueness through atomic Capsule schema migration

**Status:** done

- [ ] The candidate starts from the reconciled main history containing the published `v0.8.5` ancestry and contains only focused implementation, documentation, generated-artifact, and test changes.
- [ ] Focused Team, privilege-lifecycle, schema, ACL, migration, and cross-engine conformance tests pass.
- [ ] The full Sporades test suite, typecheck, build, generated-artifact parity checks, and documentation build pass, with any environmental limitation reported precisely rather than called green.
- [ ] Real PostgreSQL evidence proves concurrent singleton bootstrap, losing-transaction re-read, adapter parity, migration rollback, and opaque duplicate diagnostics.
- [ ] Canonical documentation and generated server declarations/runtime artifacts expose exactly the implemented contracts and preserve all related authority and null-semantics rules.
- [ ] A raw npm pack operation, not the repository's publishing package workflow, produces a tarball whose implementation, declarations, documentation, and generated artifacts are inspected directly.
- [ ] An independent review of the immutable candidate checks authorization, privilege invalidation, transaction behavior, adapter parity, identifier quoting, migration atomicity, and package contents.
- [ ] No npm publication, downstream dependency upgrade, Client Input Chaser change, database reset, or downstream browser acceptance occurs without separate explicit authorization.
