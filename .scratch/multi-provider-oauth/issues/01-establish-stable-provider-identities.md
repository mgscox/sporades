# 01 — Establish stable Provider identities and Session provenance

**What to build:** Make provider-backed identity stable independently of email while preserving the existing Google sign-in experience. A verified provider subject identifies a Linked account, the Session records which provider authenticated it, and Anonymous-session linking continues to preserve the current Sporades user identity and data.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Runtime-owned auth storage can associate multiple Provider identities with one Sporades user and enforces uniqueness for each provider-and-subject pair.
- [ ] Provider email, display name, and picture are profile attributes rather than identity keys; email may be absent or change without creating a different Linked account.
- [ ] An authenticated Session reports the provider that authenticated that Session instead of inheriting a mutable provider value shared by every Session for the user.
- [ ] Existing auth storage migrates compatibly without invalidating current Session tokens or changing existing Sporades user IDs.
- [ ] Existing Google sign-in resolves and links accounts by Google's verified stable subject.
- [ ] A new Provider identity links to the current Anonymous session without replacing its Sporades user ID.
- [ ] An existing Provider identity signs into its existing Sporades user, with current Anonymous preference behavior preserved.
- [ ] Attempting to link a Provider identity already attached to a different authenticated Sporades user returns a structured conflict and changes neither account.
- [ ] Provider linking and Session updates remain one Auth transaction, while reserved runtime identities remain impossible to create or resolve.
- [ ] Database-adapter, runtime, client-auth, generated-output, type, and documentation tests cover migration, stable-subject lookup, changing or absent email, Session provenance, linking, conflict, and rollback behavior.
- [ ] The domain documentation and runtime-owned provider-auth ADR define Provider identity, its stable subject, and its relationship to a Linked account and Session.
