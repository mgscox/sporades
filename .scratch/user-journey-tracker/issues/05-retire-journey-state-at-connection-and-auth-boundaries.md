# 05 — Retire Journey State At Connection And Auth Boundaries

**What to build:** Make Journey sessions server-owned activity segments: create them lazily on accepted publication, rotate them for every new transport connection or configured inactivity gap, retain disconnected state only until its original TTL, preserve page consent across ordinary reconnect, and clear consent/state immediately at explicit disable, page replacement, and auth transitions.

**Blocked by:** 04 — Capture Safe Browser Journey Signals.

**Status:** done

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] `journey.enable()` establishes page-runtime consent and capture policy, returns enabled state and the attached user ID, and neither creates nor returns a Journey session ID.
- [ ] The first accepted manual or automatic publication on a consented connection lazily creates a server-owned Journey session and returns/publishes its opaque session ID.
- [ ] Only accepted manual or automatic publications count as Journey session activity; enablement, reads, subscriptions, and reconnects do not.
- [ ] Every new transport connection creates a new Journey session on first publication, including an ordinary same-user reconnect during the same consenting page lifetime.
- [ ] `sporades.json` accepts `journey.sessionInactivityMinutes`, defaulting to 30.
- [ ] Finite numeric inactivity values round to the nearest whole minute and clamp to 1 through 1,440; missing or malformed values fall back to 30, and structured diagnostics expose the effective value.
- [ ] On one connection, the first accepted publication at or beyond the configured inactivity interval after the prior accepted publication creates a new session ID; publications before the boundary reuse it.
- [ ] Clean, abrupt, and half-open disconnects all end the old Journey session's ability to publish without deleting its last buffered state before TTL expiry.
- [ ] A disconnected session's still-live state remains visible to existing subscribers and late-joining clients until the original server-calculated expiry.
- [ ] TTL expiry after disconnect emits one removed change to subscribers.
- [ ] Ordinary reconnect preserves only page-runtime consent and narrowed capture policy; the SDK restores enablement automatically on the new connection without exposing or managing server session lifecycle.
- [ ] A new connection's record may coexist with the disconnected record until its TTL expires; the runtime does not deduplicate same-user records because another tab/device is equivalent.
- [ ] No private resume credential, durable capability registry, or retirement tombstone exists; public session IDs authorize no update, deletion, or claim operation.
- [ ] Reconnect after explicit disablement or page/client-runtime replacement remains disabled until `journey.enable()` is called again.
- [ ] Signing in retires the current Journey session before the new auth Session becomes eligible to publish state.
- [ ] Signing out retires the current Journey session before the fresh Anonymous session becomes eligible to publish state.
- [ ] Runtime-delivered Session replacement retires the current Journey session before applying the replacement auth association.
- [ ] Auth transitions leave tracking disabled until client code explicitly enables it again.
- [ ] An old Journey session ID cannot update, delete, or renew state after its connection, inactivity, or auth boundary has ended it.
- [ ] Other browser sessions for the same Sporades user remain independent and active when one session closes or changes auth state.
- [ ] Explicit disable, sign-out, sign-in, and Session replacement remove the old Journey state immediately and emit one removal carrying the session ID and attached Sporades user ID without credentials or profile data.
- [ ] Repeated disconnect, disable, and auth-cleanup paths are idempotent and do not emit duplicate removals.
- [ ] Server runtime shutdown clears every buffered Journey state and Journey session identity; a still-consenting page preserves consent/capture policy and publishes only fresh state under a new session ID after reconnect.
- [ ] Cleanup failures return or log bounded safe diagnostics under existing conventions without exposing Session tokens or private ownership data.
- [ ] Multi-client transport tests cover lazy creation, before/at/after inactivity boundaries, normalized JSON configuration, clean and abrupt disconnect buffering, overlapping old/new records, ordinary automatic reconnect, reconnect after disable/page replacement, server restart, sign-in, sign-out, Session replacement, same-user independent clients, and stale-ID rejection.
- [ ] Source and generated runtime behavior remains aligned for every connection and auth transition.

## Comments

### 2026-07-11 — Swarm blocker resolved by grilling

The rejected resume-capability design was removed. Journey sessions are now
server-owned activity segments rather than page identities: a new connection or
configured inactivity gap creates a new session, while page-runtime consent and
capture policy alone survive ordinary reconnect. The agreed default inactivity
gap is 30 minutes from `sporades.json`, normalized into 1 through 1,440 minutes.
This removes durable capability issuance, revocation, and reclamation entirely.

The replacement worker branch `codex/user-journey-05-replacement` remains
preserved with obsolete, unintegrated evidence commits through `7e416fa`; none
has an `ACCEPT` verdict and none should be merged as-is.
