# 05 — Read private Files with an Access key

**What to build:** Let a Capsule explicitly permit a scoped Access key to read an owner-authorized private File over HTTP, while preserving the existing Session-only default and the same File ownership and File ACL policy for both credential kinds.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** ready-for-agent

- [ ] `files.accessKeys.read` is the sole private-File Bearer opt-in; omitted scopes add no scope requirement, while explicit empty, wildcard, duplicate, undeclared, malformed, or unknown policy fields fail Capsule registration.
- [ ] Without the opt-in, an Access-key-looking Authorization header cannot authenticate a private File read and all existing Session File behavior remains unchanged.
- [ ] With the opt-in, a request may present exactly one Session header or one Bearer Access key; dual credentials and malformed or invalid Bearer material fail opaquely with no Session or Anonymous fallback.
- [ ] Successful Bearer admission resolves and snapshots the owning user before the existing File lookup and owner/File ACL checks; File ACL code receives the same frozen AuthContext and Credential provenance and scopes never grant File authority by themselves.
- [ ] Required File scopes use the central declaration and ordinary wildcard matching, while omission deliberately leaves policy to existing owner/File ACL rules.
- [ ] Successful Access-key File bytes and every related 401, 403, or 429 carry the agreed non-cacheable headers and challenge behavior without exposing File existence, key lifecycle, required scopes, or credential metadata.
- [ ] Revocation, rotation, expiry, owner ineligibility, and password-reset retirement affect subsequent File admissions but do not interrupt bytes already admitted for transfer.
- [ ] Real HTTP tests cover configured and unconfigured Capsules, Session and Access-key success, owner and ACL denial, scope denial, dual/invalid credentials, safe headers, redacted logs, and generated Bundle parity.
