# 02 — Observe Capsule-Wide Journey Changes

**What to build:** Let clients subscribe to a deterministic Capsule-wide snapshot of active Journey sessions and receive added, updated, and removed changes keyed by both Journey session and Sporades user as browser sessions publish or delete their state.

**Blocked by:** 01 — Publish And Manage One Journey Session.

**Status:** done

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] A new subscription receives one deterministic initial snapshot of all currently unexpired Journey records, including state published before that client joined, before subsequent changes.
- [ ] `journey.subscribe(listener)` emits exactly one `{ type: "snapshot", states }` event first, then `{ type: "added" | "updated" | "removed", state }` events.
- [ ] Every public record has the flat shape `{ sessionId, userId, status, metadata, updatedAt, expiresAt }` with no server-produced per-user aggregate.
- [ ] List results and snapshot arrays sort lexicographically by `userId`, then `sessionId`.
- [ ] The first accepted publication for an enabled Journey session emits an added change containing its complete app-visible record.
- [ ] Replacing status or metadata emits an updated change for the same Journey session ID.
- [ ] Disabling a Journey session emits a removed change identifying the record that left the active set.
- [ ] Separate tabs, windows, devices, and browser sessions produce distinct Journey session IDs even when they authenticate as the same Sporades user.
- [ ] Multiple users and multiple clients for one user observe the same Capsule-wide active Journey set with each session attached to the correct Sporades user ID.
- [ ] Every connected Capsule client, including an Anonymous session, receives the same V1 snapshot and realtime Journey changes.
- [ ] Publishing clients cannot attach permissions, select recipients, or broaden/narrow delivery; visibility is owned by the runtime's receiver-side delivery boundary.
- [ ] Complete event-shape tests prove that Session tokens, auth profile fields, private connection data, and raw runtime rows never reach subscribers.
- [ ] Consumers can group multiple simultaneous Journey sessions by user ID without one session overwriting another.
- [ ] When a user's final unexpired Journey state is removed, consumers can derive that user as inactive; no synthetic inactive record or event is stored.
- [ ] Journey events use Sporades-reserved platform transport messages and cannot be forged through App-message send APIs or Capsule message handlers.
- [ ] Added, updated, and removed events carry the complete safe Journey state, including the last visible state on removal, so consumers can converge and update user grouping without private reads.
- [ ] The runtime may coalesce accepted updates from one Journey session within 100 milliseconds and broadcast only the latest state while preserving coherent added, updated, and removed ordering.
- [ ] Coalescing never violates snapshot-first ordering or suppresses a final removal event.
- [ ] `journey.set()` returns accepted state immediately and `journey.list()` exposes the latest accepted buffer even before coalesced fan-out flushes.
- [ ] Tests prove subscribers converge after rapid updates without requiring delivery of every intermediate Journey signal.
- [ ] Unsubscribing stops callbacks and releases the client's Journey listener without disabling the caller's published Journey session.
- [ ] Reading or subscribing remains passive and never enables tracking or creates a Journey record for the observer.
- [ ] Journey list and subscription APIs are client-only; Capsule queries, mutations, endpoints, message handlers, Jobs, and privileged code cannot read transient Journey state.
- [ ] `journey.subscribe(listener)` delivers the initial snapshot and subsequent changes without enabling a Journey session for the observer.
- [ ] Transport failures use existing bounded structured errors and do not crash the runtime or leak malformed payload details.
- [ ] Public TypeScript declarations cover snapshots, change variants, subscription callbacks, and unsubscribe behavior.
- [ ] Multi-client tests use the real WebSocket transport seam and prove snapshot-before-change ordering, convergence, privacy, and unsubscribe behavior.
- [ ] Source and generated client/runtime artifacts retain identical subscription behavior.
