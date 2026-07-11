# 03 — Buffer And Expire Journey State

**What to build:** Buffer each Journey session's latest accepted state until its caller-selected bounded TTL expires, let the still-enabled session publish again before or after expiry under the same session ID, include still-live earlier state for clients that join later, and remove expired state from snapshots and subscribers using deterministic server-owned time.

**Blocked by:** 02 — Observe Capsule-Wide Journey Changes.

**Status:** done

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] Automatic signals use the Capsule-wide `ttlSeconds`, which defaults to 30 and accepts only integers from 1 through 300.
- [ ] Manual `journey.set(...)` accepts an optional per-update integer `ttlSeconds` from 1 through 300 and otherwise uses the Capsule default.
- [ ] The runtime calculates `expiresAt` from authoritative server time and never trusts a client-supplied absolute timestamp.
- [ ] The SDK performs no automatic heartbeat or background renewal.
- [ ] No Journey state is permanent; keeping state live requires an explicit accepted update before expiry.
- [ ] The runtime buffers at most 32 live Journey states per user and 1,000 per Capsule, pruning expired state before enforcing either cap.
- [ ] A session with live state may replace it at capacity; a session without live state receives a structured capacity error and never evicts another user's unexpired state.
- [ ] Repeating an update before or after prior-state expiry atomically replaces status and metadata, preserves the enabled Journey session ID, and calculates a fresh expiry from the accepted TTL.
- [ ] A client cannot renew or replace another connection's Journey session by learning its session ID.
- [ ] Buffered Journey state remains in active reads and initial subscription snapshots for clients that join after publication but before expiry.
- [ ] Journey state expires at the deterministic TTL boundary without ending or changing the identity of its enabled Journey session.
- [ ] A user is derived as inactive only when none of their Journey sessions has unexpired state; inactivity is not stored as a synthetic record or status event.
- [ ] Expired Journey records are excluded from all active-state reads and new subscription snapshots even if physical cleanup has not yet run.
- [ ] Expiry emits one removed change so existing subscribers converge on the same active set.
- [ ] An update after prior-state expiry reuses the still-enabled Journey session ID and publishes fresh state; an update after disablement is rejected until the client enables a new session.
- [ ] Explicit disablement removes buffered state immediately and no background work can recreate it.
- [ ] Subscription teardown does not alter independently buffered Journey state.
- [ ] Cleanup work is bounded and deterministic across reads, writes, explicit updates, and runtime timers.
- [ ] Full-runtime buffering, renewal, and expiry tests reuse the existing controllable runtime clock and due-timer seam without sleeping or replacing global time functions.
- [ ] Tests cover default/minimum/maximum TTL validation, per-user and Capsule capacity, replacement at capacity, pre-expiry late joiners, replacement renewal, boundary timing, late updates, repeated cleanup, single removal delivery, and generated-runtime parity.
