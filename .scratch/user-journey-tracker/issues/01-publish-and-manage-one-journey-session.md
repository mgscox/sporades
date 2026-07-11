# 01 — Publish And Manage One Journey Session

**What to build:** Let a Capsule explicitly declare the User journey tracker and then let one client explicitly enable a Journey session attached to its authenticated Sporades user ID, publish and replace bounded status and metadata, read active state, and disable tracking through the public client SDK.

**Blocked by:** None — can start immediately.

**Status:** done

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] The User journey tracker is unavailable unless Capsule server code declares `journey: { enabled: true }` on `capsule()`; optional `ttlSeconds` accepts integers from 1 through 300 and defaults to 30.
- [ ] The Journey declaration is one expandable Capsule-wide policy object with optional `capture.navigation`, `capture.focus`, and `capture.interactions` booleans that default to `true`, rather than a boolean, named handler map, or standalone server declaration.
- [ ] Without the Capsule declaration, reads, subscriptions, publication, and disablement return a bounded structured not-enabled error and create no Journey state.
- [ ] Within an enabled Capsule, publication remains disabled until client code explicitly enables it; reading active state does not implicitly publish the caller.
- [ ] `journey.enable()` establishes page-runtime consent and returns enabled state plus the runtime-attached Sporades user ID without creating or returning a Journey session ID.
- [ ] `journey.enable({ capture })` may narrow automatic sources for that connection but cannot enable a source disabled by Capsule policy; omitted options use Capsule defaults.
- [ ] `journey.set({ status, metadata, ttlSeconds })` is rejected until the client enables a Journey session, then publishes or atomically replaces that session's buffered state.
- [ ] `journey.disable()` removes buffered state immediately, ends the Journey session, is idempotent, and causes a later enable to create a new session ID.
- [ ] `journey.list()` reads the current buffered snapshot without enabling the caller.
- [ ] The first accepted publication lazily creates a cryptographically opaque Journey session ID distinct from the WebSocket client ID, Session token, and Sporades user ID.
- [ ] The SDK retains page-runtime consent and capture policy, not a private resume credential; public session ID alone cannot claim or mutate a session.
- [ ] Repeated updates during one enabled browser session preserve its Journey session ID and atomically replace, rather than shallow-merge, status and metadata.
- [ ] Published status and semantic annotations are trimmed strings from 1 through 256 UTF-8 characters.
- [ ] Metadata is an optional plain JSON object capped at 8 KiB serialized, depth 8, 64 keys per object, and 64 items per array.
- [ ] Cycles, non-finite numbers, functions, symbols, `undefined`, binary values, and non-plain object prototypes are rejected with a bounded structured error.
- [ ] `inactive` is rejected as a published status because it is derived only when a user has no live Journey state.
- [ ] Invalid, non-JSON-safe, or oversized input is rejected with a bounded structured error and does not persist or expose a partial state.
- [ ] App-visible records contain the Journey session ID, authenticated Sporades user ID, accepted status and metadata, and bounded server-owned lifecycle timestamps.
- [ ] Complete record-shape tests prove that Session tokens, provider identities, email, display name, picture, raw auth fields, and private connection state are absent.
- [ ] The runtime derives the record's user ID from the authenticated Session; clients cannot select or spoof it.
- [ ] Only an explicitly enabled authenticated client connection can publish; Capsule server handlers and the Privileged server role cannot create Journey sessions or publish for a selected user.
- [ ] Anonymous and linked users can publish under the same contract, with the runtime attaching the current Anonymous or linked Sporades user ID.
- [ ] The runtime privately binds the Journey session to the originating authenticated connection so another client cannot update or delete it by presenting its opaque ID.
- [ ] Active-state reads return only non-expired Journey records for the current Capsule in deterministic order.
- [ ] Explicit disablement deletes the caller's active Journey record, is idempotent, and leaves tracking disabled.
- [ ] Journey state is runtime-owned transient state and does not appear in Capsule app schema, `ctx.db`, the Database adapter, current-user preferences, or app migrations.
- [ ] State changes and deletion are atomic within the runtime, and failed transitions are never reported or broadcast as accepted state.
- [ ] The public client API and TypeScript declarations cover `journey.enable()`, `journey.set(...)`, `journey.disable()`, `journey.list()`, JSON-safe metadata, Journey records, result envelopes, and invalid top-level shapes.
- [ ] Focused tests exercise the public client SDK over the existing client transport rather than relying on private storage details.
- [ ] Source and generated runtime artifacts expose the same opt-in publication lifecycle in Dev, Container, and Hosted execution.
