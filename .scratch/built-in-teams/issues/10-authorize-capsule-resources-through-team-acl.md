# 10 — Authorize Capsule resources through Team ACL

**What to build:** Let Capsule ACL rules authorize DB rows, files, and storage metadata using the current actor's Team membership, Team-admin status, or declared application roles while leaving non-Team ACL behavior and runtime storage encapsulation unchanged.

**Blocked by:** 09 — Declare and assign membership application roles.

**Status:** ready-for-agent

- [ ] The constrained ACL context exposes read-only Team decisions for membership, Team-admin status, one declared role, and any of a bounded declared-role set.
- [ ] Every Team ACL decision accepts an explicit Team ID and never reads an implicit current Team.
- [ ] Team helpers operate through runtime-owned membership state without exposing internal tables, credentials, Sessions, Provider identities, or normal Team management operations.
- [ ] Team ACL helpers cannot write, change roles, enumerate memberships, call trusted server Team operations, or enter Privileged server role.
- [ ] Team admin and application roles remain separate checks; an admin receives no app-data authority unless the Capsule ACL deliberately checks admin status.
- [ ] Undeclared or inactive application roles always return a non-authorizing result.
- [ ] A membership removed or changed in a committed transaction affects subsequent DB and file/storage authorization immediately.
- [ ] Team-aware app tables and file policies use Capsule-stored Team IDs; Sporades does not automatically add Team fields or rewrite existing domain rows.
- [ ] Read and write ACL evaluation preserves the existing async-helper discipline, Transaction behavior, opaque public denial, and detailed redacted diagnostic logging.
- [ ] ACL evaluation remains allow-by-default where no matching rule is declared, exactly as before Teams.
- [ ] Existing non-Team Capsules and existing ACL declarations continue to pass unchanged.
- [ ] DB ACL tests exercise member, non-member, admin, one-role, any-role, inactive-role, removed-member, and cross-Team decisions through normal queries and mutations.
- [ ] File/storage ACL tests exercise the same Team decisions through normal file and stable storage-metadata operations rather than private storage calls.
- [ ] Tests prove helper bounds, recursion/write refusal, no runtime-table access, structured denials, public server types, generated-runtime parity, and representative Database adapter parity.
