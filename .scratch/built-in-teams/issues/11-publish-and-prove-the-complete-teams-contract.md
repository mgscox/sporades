# 11 — Publish and prove the complete Teams contract

**What to build:** Finish the built-in Teams feature as one coherent public contract by closing parity gaps, proving all supported runtime modes and Database adapters, publishing canonical documentation and domain language, and reconciling the roadmap's formerly separate Teams and Capsule-role candidates.

**Blocked by:** 08 — Manage the Team-admin lifecycle; 10 — Authorize Capsule resources through Team ACL.

**Status:** ready-for-agent

- [ ] The public browser Team interface, trusted server Team interface, Capsule application-role declaration, and Team ACL helpers have complete documented TypeScript shapes.
- [ ] Source runtime, generated runtime artifacts, Dev sessions, local Container sessions, and Hosted Capsules expose the same Team behavior.
- [ ] Runtime-owned Team, membership, application-role, Join-grant, bootstrap-history, and signing-secret persistence conforms across every supported Database adapter.
- [ ] Cross-adapter tests cover transaction rollback, membership uniqueness, last-admin concurrency, role activation, Join consumption, and restart persistence.
- [ ] A complete public-seam scenario creates or bootstraps a Team, creates a Join link, authenticates and validates a recipient, joins, assigns an application role, authorizes Team data, changes administration, leaves or removes membership, and handles eligible deletion.
- [ ] Compatibility coverage proves that representative Capsules which never use Teams retain existing auth shapes, queries, mutations, App messages, files, ACL behavior, startup, and generated output.
- [ ] Security-event coverage proves Team administrative actions are logged as ordinary redacted runtime security events rather than Privileged audit events.
- [ ] Security inspection proves Join codes, complete Join URLs, target emails, Session tokens, Provider subjects, credentials, and raw payloads do not appear in logs, errors, inspection output, or persisted recoverable state.
- [ ] Documentation defines Team, Team membership, Team admin, application role, Join link, and initial singleton Team using canonical repository language.
- [ ] Documentation explains that Teams are always available but never automatically partition app data or select a current Team.
- [ ] Documentation demonstrates explicit Team-aware DB and file/storage ACL patterns without suggesting direct runtime-table access.
- [ ] Documentation states that only admins enumerate their Team's memberships and safe results omit member emails.
- [ ] Documentation states that Join links require a target email, are returned but never sent, and use non-consuming validation followed by authoritative join.
- [ ] Documentation states explicitly that Sporades checks normalized email equality but does not require verified email; verification policy belongs to the Capsule.
- [ ] Documentation distinguishes Team admin, membership application roles, Capsule ACL authority, and Privileged server role.
- [ ] The roadmap records the delivered built-in Teams feature and reconciles the previously separate Team-scoped Capsule-role and Teams-for-ACL candidates without claiming unrelated global roles.
- [ ] Public API, documentation, generated-output, and compatibility tests prevent future drift across these distinctions.
- [ ] The full relevant test, typecheck, build, generated-parity, documentation, and adapter-conformance suites pass without unrelated worktree changes.
