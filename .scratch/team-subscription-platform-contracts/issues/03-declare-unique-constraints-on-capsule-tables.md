# 03 — Declare unique constraints on Capsule tables

**What to build:** Let Capsule authors declare single-field and composite uniqueness as part of a table definition, with deterministic schema identity and identical enforcement on every supported Database adapter.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] A table accepts one or more chainable unique declarations, each containing at least one declared Capsule field.
- [ ] Compile-time key checking and runtime validation reject empty, unknown, malformed, or repeated field declarations before schema migration begins.
- [ ] Constraints containing the same field set are duplicate-equivalent even when declared in another order; the first declaration's composite order is preserved and later permutations are rejected.
- [ ] Unique declarations and ACL declarations preserve each other regardless of chaining order, and multiple distinct constraints survive subsequent chaining.
- [ ] Normalized schema metadata includes a deterministically ordered constraint collection without reordering fields inside a composite constraint or causing irrelevant hash churn.
- [ ] Newly created Capsule tables enforce declared uniqueness on SQLite, libSQL, and PostgreSQL through the shared Database adapter behavior and the active dialect.
- [ ] Every emitted table, field, and constraint identifier is quoted through the Database dialect, including hostile but valid names.
- [ ] Ordinary SQL null semantics are documented and preserved; uniqueness does not silently make nullable fields required.
- [ ] A duplicate ordinary insert continues to fail, and cross-engine conformance plus public declaration tests prove the new authoring contract.
