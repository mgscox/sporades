# 04 — Propagate query arguments through Vue and Solid

**What to build:** Let Vue composables and Solid primitives subscribe to declared Custom queries with JSON-compatible positional arguments through their existing native ownership and cleanup lifecycles, without creating framework-specific transports or changing their state semantics.

**Blocked by:** 02 — Carry Custom query arguments through the client transport.

**Status:** ready-for-agent

- [ ] Vue query composables accept JSON-constrained positional arguments after the query name while preserving name-only calls.
- [ ] A Vue query sends the normalized tuple on its initial wire subscription and exposes the corresponding complete query state reactively.
- [ ] Vue scope disposal unsubscribes only the exact argument channel and remains idempotent.
- [ ] Solid query primitives accept JSON-constrained positional arguments after the query name while preserving name-only calls.
- [ ] A Solid query sends the normalized tuple on its initial wire subscription and publishes the corresponding complete query state through its accessor.
- [ ] Solid root cleanup unsubscribes only the exact argument channel and remains idempotent.
- [ ] Canonically equal Vue or Solid subscriptions share the existing page-level channel, while different tuples remain distinct.
- [ ] Caller mutation after creation does not alter reconnect or refresh arguments for either framework.
- [ ] Invalid and oversized values are rejected through the shared client normalization contract before transmission.
- [ ] Vue and Solid continue to share the framework-neutral singleton page connection rather than opening adapter-owned sockets.
- [ ] Existing Vue and Solid mutation, auth, loading, error, and cleanup semantics remain unchanged.
- [ ] Public declarations, focused framework documentation, and the existing Vue and Solid adapter harnesses agree with the delivered behavior.
