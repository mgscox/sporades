# 03 — Make React and Preact query arguments lifecycle-reactive

**What to build:** Let React and Preact components pass positional arguments to query hooks, replacing the subscribed tuple when its canonical value changes while avoiding subscription churn for deep-equal inline values and preserving normal hook cleanup.

**Blocked by:** 02 — Carry Custom query arguments through the client transport.

**Status:** ready-for-agent

- [ ] React and Preact query hooks accept JSON-constrained positional arguments after the query name while preserving name-only calls.
- [ ] The hook normalizes arguments during render and derives its effect dependency from the query name and canonical argument identity.
- [ ] The effect passes the already normalized result to the shared normalized-subscription seam instead of normalizing again.
- [ ] Changing a primitive or structured argument unsubscribes the old exact channel and subscribes the new exact channel.
- [ ] Re-rendering with a newly allocated but deep-equal inline array or object does not resubscribe.
- [ ] Object key insertion order does not cause hook churn, while a meaningful nested value or array-order change does.
- [ ] The new subscription receives its own loading and result state without updates from the retired tuple.
- [ ] Component cleanup remains idempotent and releases only the active exact channel.
- [ ] Invalid or oversized client arguments fail before a WebSocket subscribe frame is sent.
- [ ] React and Preact harnesses observe the expected initial, changed, stable-equal, and cleanup behavior over the shared page connection.
- [ ] Public declarations and focused React/Preact documentation describe the same trailing-argument convention.
- [ ] Existing argument-free hook behavior and mutation/auth hooks remain unchanged.
