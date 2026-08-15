# 05 — Propagate query arguments through Svelte stores

**What to build:** Let a Svelte query store retain a normalized positional argument tuple across its lazy start, shared listeners, stop, and restart lifecycle so parameterized query state behaves like every existing Svelte-readable store.

**Blocked by:** 02 — Carry Custom query arguments through the client transport.

**Status:** ready-for-agent

- [ ] Svelte query stores accept JSON-constrained positional arguments after the query name while preserving name-only calls.
- [ ] Creating a query store remains lazy and sends no query frame until the first store subscriber starts observation.
- [ ] The first subscriber starts one wire subscription carrying the store's immutable normalized tuple.
- [ ] Additional listeners on the same store share its active observation and latest complete state.
- [ ] The last listener stops only that exact argument channel, and repeated stop calls remain harmless.
- [ ] Subscribing again after a complete stop creates a fresh wire subscription with the original immutable tuple and reset loading state.
- [ ] Separate stores for the same query and canonically equal tuples share the page-level query channel where existing behavior permits sharing.
- [ ] Separate stores for different tuples remain isolated through initial results, mutation refresh, reconnect, and teardown.
- [ ] Caller mutation after store creation cannot change the tuple used when lazy observation later starts or restarts.
- [ ] Invalid and oversized values are rejected through the shared client normalization contract.
- [ ] Existing Svelte mutation-store, auth-store, state, and lazy lifecycle behavior remains unchanged.
- [ ] Public declarations, focused Svelte documentation, and the existing store harness agree with the delivered behavior.
