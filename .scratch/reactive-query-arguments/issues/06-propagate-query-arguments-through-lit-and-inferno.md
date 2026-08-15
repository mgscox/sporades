# 06 — Propagate query arguments through Lit and Inferno

**What to build:** Let Lit reactive controllers and Inferno lifecycle adapters retain and transmit positional query arguments through their host-owned connection and disconnection lifecycles, with exact-channel cleanup and no change to existing host state behavior.

**Blocked by:** 02 — Carry Custom query arguments through the client transport.

**Status:** ready-for-agent

- [ ] Lit query controllers accept JSON-constrained positional arguments after the host and query name while preserving name-only calls.
- [ ] A connected Lit controller subscribes with its immutable normalized tuple and requests host updates for the corresponding complete query state.
- [ ] Lit disconnection releases only the exact argument channel, and reconnect behavior retains the original tuple without duplicate subscriptions.
- [ ] Inferno query adapters accept JSON-constrained positional arguments after the host and query name while preserving name-only calls.
- [ ] A mounted Inferno adapter subscribes with its immutable normalized tuple and updates its host for the corresponding complete query state.
- [ ] Inferno unmount releases only the exact argument channel, and repeated mount or unmount callbacks remain safe under existing lifecycle rules.
- [ ] Canonically equal Lit or Inferno observations share the page-level channel, while different tuples remain isolated.
- [ ] Caller mutation after controller or adapter creation cannot alter later mount, reconnect, or refresh arguments.
- [ ] Invalid and oversized values are rejected through the shared client normalization contract before transmission.
- [ ] Lit and Inferno continue to share the framework-neutral singleton page connection rather than creating host-owned sockets.
- [ ] Existing Lit and Inferno mutation, auth, loading, error, and host-update behavior remains unchanged.
- [ ] Public declarations, focused framework documentation, and the existing Lit and Inferno lifecycle harnesses agree with the delivered behavior.
