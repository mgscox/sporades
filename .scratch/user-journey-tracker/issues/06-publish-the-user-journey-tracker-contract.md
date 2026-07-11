# 06 — Publish The User Journey Tracker Contract

**What to build:** Publish one consistent Capsule-author and maintainer contract for opt-in Journey state, safe automatic capture, realtime observation, page-runtime consent, reconnect behavior, and transient server buffering, then mark the roadmap feature implemented.

**Blocked by:** 05 — Retire Journey State At Connection And Auth Boundaries.

**Status:** ready-for-agent

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] Public client API documentation describes `journey.enable()`, `journey.set(...)`, `journey.disable()`, `journey.list()`, subscription and unsubscribe behavior.
- [ ] Consent guidance explains page-runtime scope, same-user automatic transport reconnect, disable/auth/page-reload clearing, immediate current-page publication when navigation capture is active, and optional separate preference storage.
- [ ] User guidance documents automatic navigation/focus/visibility capture, semantic interaction annotations, manual Journey updates, and the excluded raw click/DOM/form/session-replay data.
- [ ] Annotation guidance states that `data-sporades-journey` carries one semantic status only and directs richer metadata to typed manual updates.
- [ ] Navigation guidance documents normalized-pathname capture, excluded origin/query/raw hash data, and the semantic page-name override for sensitive or identifier-rich routes.
- [ ] Multi-framework guidance documents browser-level History/meta observation, render-frame sampling, idempotent HMR/runtime setup, adapter-independent consumption, and manual fallback for locationless view changes.
- [ ] Interaction guidance documents delegated annotated click/submit capture, keyboard behavior, default prevention, Shadow DOM boundaries, nearest-match deduplication, and manual fallback for all other event types.
- [ ] Status guidance documents automatic `viewing`, `focused`, and `away`, annotated semantic statuses, and derived-only `inactive`.
- [ ] Validation guidance documents the 256-character status/annotation limit and metadata's 8 KiB, depth-8, 64-key, and 64-array-item bounds plus rejected value classes.
- [ ] Documentation states that the Capsule must explicitly declare the tracker and that client publication remains disabled until explicitly enabled; reading or subscribing never publishes the caller.
- [ ] Server API documentation presents `journey: { enabled: true }` as the expandable Capsule-wide declaration and does not imply named Journey handlers.
- [ ] Capture-policy guidance documents the three default-on Capsule sources, per-connection narrowing, prohibition on broadening policy, and manual-only operation.
- [ ] TTL guidance documents the Capsule-wide 30-second default, the 1–300 second bounds, automatic-signal behavior, manual per-update override, and the absence of permanent state.
- [ ] User guidance distinguishes the enabled Journey session from its TTL-buffered Journey state, explains one session per client connection and multiple simultaneous sessions per user, and derives inactivity when none of a user's sessions has live state.
- [ ] API guidance documents flat `{ sessionId, userId, status, metadata, updatedAt, expiresAt }` records and client-side grouping rather than a server-produced user aggregate.
- [ ] API guidance documents deterministic `(userId, sessionId)` ordering for list and snapshot arrays.
- [ ] Realtime guidance documents 100-millisecond per-session latest-state coalescing, immediate caller/list visibility, coherent change ordering, and non-guaranteed intermediate delivery.
- [ ] Subscription guidance documents the snapshot-first discriminated event union and complete last-state removal payload.
- [ ] Capacity guidance documents the 32-live-state per-user and 1,000-live-state per-Capsule caps, expiry pruning, replacement-at-capacity behavior, and structured rejection without eviction.
- [ ] Documentation states that every connected Capsule client receives Journey updates in V1 and identifies future shared-Team delivery filtering as deferred receiver-side authorization rather than publisher-selected record permissions.
- [ ] User guidance documents bounded status and metadata, privacy-safe metadata practices, structured validation errors, and replacement rather than merge semantics.
- [ ] Caller-controlled renewal, bounded TTL, buffered late-join snapshots, disconnect buffering until expiry, immediate explicit/auth cleanup, reconnect behavior, and explicit re-enablement are documented as one lifecycle contract.
- [ ] Restart guidance explains that server replacement clears buffered state while a still-consenting same-user page resumes its session identity and publishes only fresh state after reconnect.
- [ ] Security guidance explains that public session ID is not a bearer credential and that the private page-runtime resume capability is never exposed in Journey records or SDK results.
- [ ] Documentation clearly distinguishes transient Journey state from durable current-user preferences, arbitrary App messages, analytics, audit logs, and Capsule app tables.
- [ ] Authority guidance states that V1 publication is client-only and that Capsule server handlers and the Privileged server role cannot impersonate user activity.
- [ ] Authority guidance states that reads/subscriptions are client-only and must not become authoritative server business-logic inputs.
- [ ] The domain glossary defines User journey tracker and Journey session using accepted Sporades vocabulary without exposing implementation details.
- [ ] Public types and generated API references expose the complete supported Journey SDK, record, event, result, and subscription shapes.
- [ ] The PRD and source-planning link remain available for traceability.
- [ ] Documentation and implementation remain consistent with ADR 0031's consented, session-scoped, latest-state boundary.
- [ ] The roadmap moves User journey tracker from Recommended Next Features to Recently Implemented only after every prior ticket is complete.
- [ ] Focused documentation tests fail on stale design/ready wording and protect the implemented opt-in, privacy, expiry, disable/delete, and auth-transition contract.
- [ ] Type, docs, and generated-runtime parity tests keep the published contract synchronized across Dev, Container, and Hosted execution.
