# 05 — Retire Journey State At Connection And Auth Boundaries

**What to build:** Stop publication when a Journey session disconnects while retaining its last state until TTL expiry, resume the same session identity on same-user reconnect during the consenting page lifetime, and clear consent/state immediately at explicit disable, page replacement, and auth transitions.

**Blocked by:** 04 — Capture Safe Browser Journey Signals.

**Status:** ready-for-human

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] Clean, abrupt, and half-open disconnects all end the Journey session's ability to publish without deleting its last buffered state before TTL expiry.
- [ ] A disconnected session's still-live state remains visible to existing subscribers and late-joining clients until the original server-calculated expiry.
- [ ] TTL expiry after disconnect emits one removed change to subscribers.
- [ ] Same-user reconnect during the current consenting page lifetime preserves the Journey session ID, resumes the narrowed capture policy, and never duplicates the prior buffered record.
- [ ] Reconnect ownership requires the SDK's private resume credential; visible session ID alone cannot claim, update, delete, or resume the Journey session.
- [ ] Reconnect after explicit disablement or page/client-runtime replacement remains disabled until `journey.enable()` is called again.
- [ ] Signing in retires the current Journey session before the new auth Session becomes eligible to publish state.
- [ ] Signing out retires the current Journey session before the fresh Anonymous session becomes eligible to publish state.
- [ ] Runtime-delivered Session replacement retires the current Journey session before applying the replacement auth association.
- [ ] Auth transitions leave tracking disabled until client code explicitly enables it again.
- [ ] An old Journey session ID cannot update, delete, or renew state after its connection or auth boundary has retired it.
- [ ] Other browser sessions for the same Sporades user remain independent and active when one session closes or changes auth state.
- [ ] Explicit disable, sign-out, sign-in, and Session replacement remove the old Journey state immediately and emit one removal carrying the session ID and attached Sporades user ID without credentials or profile data.
- [ ] Repeated disconnect, disable, and auth-cleanup paths are idempotent and do not emit duplicate removals.
- [ ] Server runtime shutdown clears every buffered Journey state; a still-consenting same-user page may resume the same Journey session identity after reconnect and publish only fresh state.
- [ ] Cleanup failures return or log bounded safe diagnostics under existing conventions without exposing Session tokens or private ownership data.
- [ ] Multi-client transport tests cover clean and abrupt disconnect buffering, late join before expiry, same-user automatic reconnect, reconnect after disable/page replacement, server restart, sign-in, sign-out, Session replacement, same-user independent clients, and stale-ID rejection.
- [ ] Source and generated runtime behavior remains aligned for every connection and auth transition.

## Comments

### 2026-07-11 — Swarm blocker

Commit-pinned review exposed an unresolved capability-lifetime tradeoff. The
current contract simultaneously requires still-consenting pages to resume
indefinitely across full runtime/database replacement, retired credentials to
remain invalid forever, and durable capability metadata to remain permanently
bounded. Without a maximum resume lifetime or a generation/secret-rotation
boundary, finite reclamation either invalidates a still-consenting page or
revives a retired credential; retaining every issued and retired capability
eventually exhausts any fixed bound.

A human decision is required before implementation can continue:

- define a maximum private resume-capability lifetime, after which explicit
  `journey.enable()` is required again; or
- define a generation/secret-rotation boundary that may invalidate existing
  consenting resumes; or
- explicitly permit lifetime-growing durable capability metadata.

The replacement worker branch `codex/user-journey-05-replacement` is preserved
with unintegrated evidence commits through `7e416fa`; none has an `ACCEPT`
verdict and none should be merged as-is.
