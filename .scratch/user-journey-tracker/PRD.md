# User Journey Tracker

Status: implemented

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features and Data And Auth Helpers: "User journey tracker")
- `docs/adr/0031-user-journeys-are-consented-session-scoped-current-state.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to move the item to Recently Implemented, per the roadmap Promotion
Rule.

## Problem Statement

Capsule authors who want online, viewing, typing, focus, support, or workflow
progress indicators must currently invent their own presence records, renewal
cadence, expiry rules, transport messages, user/session correlation, and
cleanup. That duplicates subtle realtime infrastructure across Capsules and
makes it easy to collapse simultaneous tabs or leave stale browser state
looking live.

Sporades already owns the client transport, runtime auth, connected-client
lifecycle, runtime storage, and fan-out. Capsule authors need an opt-in,
way to publish and observe short-lived user journey state without turning
presence into an app table or wiring browser navigation and interaction capture
by hand.

## Solution

Sporades provides a runtime-owned User journey tracker that Capsule server code
must explicitly declare before its operations are available through
`sporades/client`. Within an enabled Capsule, a client explicitly enables
page-runtime Journey consent before publishing a status and optional bounded
JSON metadata. The server lazily assigns a Journey session ID on the first
accepted publication for that transport connection and maps it to the
authenticated Sporades user. Each caller update
sets a bounded TTL; the runtime buffers that session's latest Journey state
until expiry so clients that join later receive it while live.

After explicit client enablement, the framework-neutral client runtime also
turns safe browser navigation, focus, and visibility signals into Journey state.
Interactions are captured only when Capsule markup explicitly declares a
semantic Journey event. Automatic capture never records arbitrary clicks, form
values, raw DOM text, CSS selectors, pointer coordinates, or unbounded browser
payloads. Capsule code may still call `journey.set(...)` for typing, workflow
progress, or non-DOM activity.

Each app-visible Journey state identifies both the originating Sporades user and
one server-owned Journey session. Multiple Journey sessions may therefore describe
simultaneous activity for one user without overwriting each other. Disabling
tracking ends the session and removes its current state. Ordinary connection
loss ends the session's ability to publish but leaves its last state buffered
until TTL expiry. If a connected caller does not renew or replace its state
before expiry, only that state expires. The next accepted publication reuses the
session ID only while it is on the same connection and less than the configured
inactivity interval follows the prior publication; a new connection or longer
gap creates a new session ID. A user is derived as inactive when none
of their sessions has unexpired state.

The public API supports publishing the current client's journey state,
subscribing to the Capsule's active journey records, and explicitly disabling
and deleting the current client's record. The feature behaves consistently in
Dev sessions, local Container sessions, and Hosted Capsules because all three
run the same bundled runtime and client transport.

In V1 every connected client in the Capsule receives the same live Journey
updates. Visibility is a receiver-side delivery concern rather than a property
chosen by the publishing client. A future Teams integration may filter delivery
to recipients who share at least one Team with the subject where Journey
visibility is enabled for that Team.

## User Stories

1. As a Capsule author, I want a built-in User journey tracker, so that I do not need to build presence infrastructure for common collaborative cues.
2. As a Capsule author, I want journey tracking disabled by default, so that merely using a Capsule does not publish behavioral state.
3. As a Capsule author, I want to declare journey tracking before its client operations become available, so that my Capsule does not silently expose an activity surface.
4. As a Capsule visitor, I want tracking to begin only after client code explicitly enables page-runtime consent, so that publication is deliberate and inspectable.
5. As a Capsule author, I want each Journey session to include its authenticated Sporades user ID, so that I can tell what a known user is doing.
6. As a Capsule visitor, I want each browser session to receive a distinct Journey session ID, so that my simultaneous activity in separate tabs or devices is not overwritten.
7. As a Capsule author, I want to publish a short status such as `online`, `viewing`, or `typing`, so that other clients can show useful current activity.
8. As a Capsule author, I want to attach optional JSON metadata such as route, view, focus state, or workflow step, so that journey state can fit my Capsule without new platform fields.
9. As a Capsule author, I want status and metadata to be bounded and JSON-safe, so that one client cannot create an unbounded realtime payload.
10. As a Capsule visitor, I want only my Sporades user ID, status, metadata, and Journey lifecycle fields exposed, so that provider profile data and credentials are not disclosed.
11. As a Capsule author, I want publishing invalid or oversized state to return a structured error, so that client failures are deterministic and actionable.
12. As a Capsule author, I want enabling the tracker to return enabled state and the attached user ID without exposing a misleading pre-publication session ID.
13. As a Capsule author, I want updating a journey to replace the current session's status and metadata atomically, so that observers never receive a half-updated record.
14. As a Capsule author, I want accepted publications on one connection within the configured inactivity interval to preserve their Journey session ID, while a new connection or longer gap starts a new session.
15. As a Capsule author, I want active journey records to include bounded timestamps and expiry information, so that clients can display freshness without guessing.
16. As a Capsule author, I want to subscribe to an initial snapshot of active journey records, so that a newly connected UI starts from current state.
17. As a Capsule author, I want journey additions, updates, removals, and expirations delivered over the existing client transport, so that the UI can remain current without polling.
18. As a Capsule author, I want events to carry complete safe journey records, so that consumers can converge without reading runtime internals.
19. As a Capsule author, I want each Journey update to have a bounded TTL, so that transient states naturally disappear unless my app renews them.
20. As a Capsule author, I want repeating an update to renew or replace the current Journey session state, so that I control how long `online`, `typing`, or other statuses remain live.
21. As a Capsule visitor, I want my Journey state to expire when the caller stops renewing it, independently of the longer inactivity interval that segments later activity into a new session.
22. As a Capsule author, I want expired records removed from active snapshots and announced to subscribers, so that all connected clients converge on the same active set.
23. As a Capsule author, I want a user with no unexpired Journey state to be derived as inactive, so that inactivity does not require a synthetic durable record.
24. As a Capsule visitor, I want connection loss to leave my last state buffered only until its existing TTL, so that brief disconnects do not create inconsistent lifecycle rules.
25. As a Capsule visitor, I want an explicit disable operation to delete my current Journey session immediately, so that I can leave the tracker cleanly before TTL expiry.
26. As a Capsule visitor, I want disabling an already-disabled tracker to be safe and idempotent, so that UI cleanup does not need fragile local bookkeeping.
27. As a Capsule visitor, I want ordinary transport reconnects to retain page-runtime consent and capture policy while the new connection starts a new Journey session on its first publication.
28. As a Capsule visitor, I want authentication changes to retire the old client journey before any new identity association is used, so that one browser session does not bridge user boundaries invisibly.
29. As a Capsule visitor, I want another user to be unable to update or delete my Journey session, so that public identifiers are not bearer credentials.
30. As a Capsule author, I want all active clients in the same Capsule to observe the same app-visible journey set, so that collaborative state is Capsule-scoped rather than publisher-selected.
31. As a Capsule visitor, I want Journey visibility decided by the runtime at delivery time, so that publishing clients cannot choose or widen their audience.
32. As a Capsule author, I want journey tracking separate from App messages, so that I get a consistent lifecycle and expiry contract instead of rebuilding it from ephemeral messages.
33. As a Capsule author, I want journey tracking separate from current-user preferences, so that transient browser state is not persisted as durable user settings.
34. As a Capsule author, I want journey records kept outside Capsule app schema and `ctx.db`, so that app migrations cannot corrupt runtime-owned lifecycle state.
35. As a Capsule visitor, I want a server runtime restart to clear old Journey state while my still-live consenting page reconnects under its existing consent and publishes fresh state in a new Journey session.
36. As a runtime maintainer, I want journey expiry to use one deterministic runtime clock boundary, so that cleanup, snapshots, and notifications agree.
37. As an AFK agent, I want journey behavior exposed through the public client SDK and structured transport messages, so that I can verify it without scraping logs or private tables.
38. As a Capsule author, I want TypeScript types for journey status, metadata, records, events, and subscriptions, so that misuse is caught during development.
39. As a Capsule author, I want subscription teardown to stop callbacks and release client resources, so that component unmounts do not leak listeners.
40. As a Capsule author, I want the same Journey tracker contract in Dev sessions, Container sessions, and Hosted Capsules, so that production-like behavior does not change by execution environment.
41. As an operator, I want malformed journey traffic to use existing bounded structured errors and server diagnostics, so that abuse does not crash the runtime or leak sensitive details.
42. As a documentation reader, I want privacy, lifecycle, and expiry behavior documented alongside the SDK, so that I can adopt the tracker without reverse-engineering its safety model.
43. As a Capsule author, I want navigation, focus, and visibility changes captured automatically after enablement, so that common Journey state needs no framework-specific wiring.
44. As a Capsule author, I want to annotate meaningful interactions with a semantic Journey name, so that button presses can become useful state without recording arbitrary clicks.
45. As a Capsule visitor, I want automatic capture to exclude form values, raw DOM text, selectors, and pointer data, so that consent does not become indiscriminate session recording.
46. As a Capsule author, I want manual Journey updates alongside automatic capture, so that typing and application-specific workflow progress remain expressible.

## Implementation Decisions

- The User journey tracker is runtime-owned. Capsule server code must explicitly
  declare `journey: { enabled: true }` on `capsule()` before Journey operations
  are available through `sporades/client`; it does not appear in Capsule app
  schema, `ctx.db`, current-user preferences, or raw WebSocket APIs.
- The Capsule declaration is an expandable object with `enabled`, `ttlSeconds`,
  and optional `capture.navigation`, `capture.focus`, and
  `capture.interactions` booleans. The three capture sources default to `true`
  when omitted.
- Future Team-based delivery policy belongs at this Capsule-wide boundary. The
  declaration is not a named map like Jobs or Schedules and does not introduce
  a standalone server declaration.
- Without a Capsule declaration, Journey reads, subscriptions, publication, and
  disablement return a bounded structured not-enabled error and create no state.
- Within an enabled Capsule, client publication remains disabled by default.
  Reading or subscribing to active journey state does not implicitly publish
  the current client.
- `journey.enable()` is the explicit client consent boundary. It records enabled
  state and the narrowed capture policy for the page runtime and returns the
  runtime-attached Sporades user ID. It does not create or return a Journey
  session before publication.
- `journey.enable({ capture })` may disable automatic capture sources for that
  connection but cannot enable a source disabled by Capsule policy. Omitted
  connection options use the Capsule capture policy.
- `journey.set({ status, metadata, ttlSeconds })` publishes or replaces the
  consented connection's TTL-buffered Journey state and is rejected until the
  client explicitly establishes page-runtime consent with `journey.enable()`.
- `journey.disable()` removes any buffered state immediately, clears page
  consent, and is idempotent. A later accepted publication after re-enablement
  creates a new Journey session ID.
- `journey.list()` returns the current buffered snapshot, while
  `journey.subscribe(listener)` delivers an initial snapshot followed by
  Journey changes without enabling the observing client.
- Journey consent is scoped to the current browser client-runtime lifetime and
  is never written to storage by the tracker. A Capsule that remembers a user's
  choice across page reloads may store that separately through current-user
  preferences and explicitly call `journey.enable()` in the new page runtime.
- An ordinary transport reconnect during the current page lifetime preserves
  only in-memory consent and the previously narrowed capture policy. The SDK
  automatically restores enablement on the new connection; its first accepted
  publication creates a new Journey session ID. No private resume credential,
  durable capability registry, or retirement tombstone exists.
- Disablement, page reload/client-runtime replacement, or an auth identity
  transition clears in-memory consent and requires explicit enablement again.
- Automatic capture starts only after `journey.enable()` succeeds. It pauses
  during disconnect, resumes for an ordinary reconnect under the same
  page-runtime consent, and stops on `journey.disable()`, auth transition, or
  page/client-runtime replacement.
- When navigation capture is enabled, the client publishes the current page as
  the first `viewing` state immediately after successful enablement. A
  connection that narrows every automatic source off remains invisible until an
  explicit `journey.set(...)` call.
- Manual `journey.set(...)` remains available whenever the Capsule tracker is
  enabled, including when every automatic capture source is disabled.
- The framework-neutral client runtime captures initial navigation, History API
  navigation, `popstate`, hash navigation, document visibility, and window
  focus/blur without requiring React- or Preact-specific hooks.
- Navigation observation is installed once and idempotently in the browser
  client runtime. It preserves native `history.pushState()` and
  `history.replaceState()` arguments, return values, and exceptions while
  observing their successful calls.
- Route signals are coalesced and sampled after a browser rendering opportunity
  so an SPA can update its semantic Journey page metadata before publication.
- A narrowly targeted observer watches creation, replacement, removal, or
  content changes of `<meta name="sporades-journey">`. The tracker does not
  observe the general DOM for navigation inference.
- Client-runtime replacement and HMR do not multiply History wrappers, browser
  listeners, metadata observers, or Journey publications. Setup and teardown are
  idempotent.
- React, Preact, Vue, Svelte, SolidJS, Lit, and Inferno adapters consume the same
  framework-neutral Journey stream and never own navigation detection. A router
  that changes meaningful view state without changing browser location or the
  semantic page `<meta>` must call `journey.set(...)` explicitly.
- Automatic navigation publishes `status: "viewing"` with only the normalized
  pathname by default. It never captures URL origin, query parameters, or raw
  fragment content.
- Window focus publishes `status: "focused"`; window blur or a hidden document
  publishes `status: "away"`. Each includes the current safe `{ page }`
  metadata.
- A page may declare a semantic Journey page name, for example through
  `<meta name="sporades-journey" content="orders.detail">`; when present, that
  value replaces the pathname in published navigation metadata.
- Hash changes trigger navigation reevaluation but raw hash content is never
  published unless Capsule code explicitly maps it to a bounded semantic value
  through a manual Journey update.
- Arbitrary clicks are not tracked. A click becomes a Journey signal only when
  the activated element or its intended interactive ancestor carries an
  explicit semantic Journey annotation such as
  `data-sporades-journey="checkout.started"`.
- One idempotent document-level capture-phase observer handles annotated `click`
  and `submit` events. It uses `event.composedPath()` to find the nearest
  annotation through ordinary component nesting and open Shadow DOM.
- Publication waits until propagation finishes and is skipped when the event is
  `defaultPrevented`. Capture-phase observation remains visible when framework
  handlers call `stopPropagation()`.
- When an annotated submit control and an annotated form both match one
  submission, the nearest semantic annotation wins and exactly one Journey
  state is published.
- Native button/link keyboard activation is observed through its resulting
  `click`; Enter-key form submission is observed through `submit`. Closed Shadow
  DOM requires the component host to carry the annotation.
- V1 does not automatically capture `change`, typing, drag/drop, gestures, or
  pointer-specific events. Capsule code uses `journey.set(...)` for those
  application-specific signals.
- Automatic interaction capture records the declared semantic event name and
  current safe `{ page }` metadata. It never records form values, raw DOM text,
  CSS selectors, DOM paths, pointer coordinates, or raw browser event objects.
- `data-sporades-journey` carries only one bounded semantic status string. V1
  does not parse JSON or arbitrary metadata from HTML attributes; richer
  metadata requires an explicit typed `journey.set(...)` call.
- `inactive` is reserved as a derived-only state and is rejected as a published
  status. Automatic capture owns `viewing`, `focused`, and `away`; manual updates
  may publish any other valid bounded status string.
- Automatic and manual Journey signals share the same session identity,
  replacement, TTL buffering, expiry, snapshot, and realtime delivery contract.
- Journey is a latest-state surface rather than a durable or lossless event
  stream. The runtime may coalesce multiple accepted updates from one Journey
  session within 100 milliseconds and broadcast only the latest state.
- `journey.set()` returns its accepted state immediately and `journey.list()`
  exposes the latest accepted buffer even before a coalesced fan-out flush.
  Added, updated, and removed ordering remains coherent, but delivery of every
  intermediate Journey signal is not guaranteed.
- The runtime buffers at most 32 live Journey states per Sporades user and 1,000
  live Journey states per Capsule. It prunes expired state before enforcing
  either cap.
- A session with existing live state may replace it while at capacity. A session
  without live state receives a structured capacity error rather than evicting
  another user's unexpired state.
- `journey.set(...)` remains available for typing, workflow progress,
  non-DOM activity, and explicit overrides of automatically captured state.
- The first accepted publication on a consented connection lazily creates one
  cryptographically opaque Journey session ID. The identifier is distinct from
  the WebSocket client ID, auth Session token, and Sporades user ID.
- App-visible records contain the Journey session ID, authenticated Sporades
  user ID, status, optional metadata, and bounded lifecycle timestamps. They
  never contain a Session token, provider identity, email, display name, picture,
  or raw auth record.
- The runtime binds each Journey session to its authenticated connection for
  authorization, cleanup, and auth-transition handling; clients cannot select
  or spoof the record's Sporades user ID.
- V1 Journey publication is client-only and originates from an explicitly
  enabled authenticated client connection. Capsule server handlers and the
  Privileged server role cannot create Journey sessions, select a user ID, or
  publish state on a user's behalf.
- V1 Journey reads and subscriptions are also client-only. Capsule queries,
  mutations, endpoints, message handlers, Jobs, and privileged code cannot read
  transient Journey state as business input.
- Separate tabs, windows, devices, and browser sessions publish separate Journey
  sessions even when they belong to the same Sporades user.
- Anonymous and linked users participate under the same contract. An Anonymous
  Journey state carries its runtime-owned Anonymous user ID; linking, sign-in,
  sign-out, or Session replacement removes old state before a fresh Journey
  session may be enabled under the next identity.
- A user's current Journey is the set of unexpired Journey state across that
  user's Journey sessions. `inactive` is derived when that set is empty and is
  never stored as a synthetic Journey state or status event.
- The public SDK exposes `journey.enable()`, `journey.set(...)`,
  `journey.disable()`, `journey.list()`, and `journey.subscribe(listener)` under
  `sporades/client`.
- Status is a required non-empty bounded string when state is published.
  Status and semantic annotations are trimmed and accept 1 through 256 UTF-8
  characters.
- Metadata is an optional plain JSON object capped at 8 KiB serialized, nesting
  depth 8, 64 keys per object, and 64 items per array. Cycles, non-finite
  numbers, functions, symbols, `undefined`, binary values, and non-plain object
  prototypes are rejected with existing structured client errors.
- Automatically produced `{ page }` metadata uses the same validation and size
  limits as manual metadata.
- Updating a Journey session replaces its published status and metadata as one
  accepted state transition; metadata does not shallow-merge implicitly.
- Only accepted manual or automatic Journey publications count as Journey
  session activity. Enablement, reads, subscriptions, and reconnects neither
  create nor extend a Journey session.
- `sporades.json` may set `journey.sessionInactivityMinutes`. It defaults to 30.
  Finite numeric input is rounded to the nearest whole minute and clamped to 1
  through 1,440; missing or malformed input falls back to 30. Structured
  diagnostics expose the effective normalized value.
- An accepted publication on a new transport connection always creates a new
  Journey session ID. On one connection, an accepted publication at or beyond
  the configured inactivity interval after the previous accepted publication
  also creates a new Journey session ID. The source client does not manage or
  receive Journey-session lifecycle notifications.
- Capsule `journey.ttlSeconds` is an optional integer from 1 through 300 and
  defaults to 30. Automatic signals use this Capsule default.
- `journey.set(...)` accepts an optional per-update integer `ttlSeconds` from 1
  through 300; when omitted it uses the Capsule default.
- The runtime calculates `expiresAt` from server time; clients cannot submit an
  absolute timestamp. Repeating an update replaces state and calculates a new
  expiry.
- The SDK performs no automatic heartbeat or renewal. Capsule client code
  repeats updates when it wants a status to remain live.
- No status is permanent. Any state that should remain current must be renewed
  deliberately before its accepted TTL expires.
- Explicit disablement clears page-runtime consent and deletes current buffered
  state immediately and idempotently.
- Clean and abrupt WebSocket disconnects end the Journey session's ability to
  publish but do not remove its buffered Journey state early. The state remains
  visible until its existing TTL expires, giving all connection-loss paths the
  same externally observable behavior.
- A reconnect creates a distinct connection and therefore a distinct Journey
  session on first publication. The disconnected record may coexist until its
  original TTL expires, exactly like records from another tab or device; the
  runtime does not deduplicate one user's records.
- An auth Session replacement, sign-in, sign-out, or equivalent user transition
  retires the existing Journey session and removes its buffered state
  immediately. Tracking remains disabled until client code explicitly enables
  it again.
- Active-state reads and subscriptions are Capsule-wide. They expose all
  non-expired app-visible Journey records for the current Capsule, including the
  authenticated Sporades user ID attached by the runtime.
- The public Journey-state shape is flat:
  `{ sessionId, userId, status, metadata, updatedAt, expiresAt }`. List results
  and realtime changes do not include a second server-produced per-user
  aggregate.
- `journey.list()` and subscription snapshot arrays sort lexicographically by
  `userId`, then `sessionId`, grouping one user's simultaneous sessions without
  timestamp-driven reorder churn.
- Consumers group flat records by `userId` to answer what one user is doing.
  Multiple sessions remain visible without arbitrary server-side precedence,
  and removal of the final live record lets the consumer derive `inactive`.
- V1 delivers every live Journey snapshot and change to every connected client
  in the Capsule, including Anonymous sessions. Publishers do not attach
  permissions or select a visibility audience.
- Future Team-based delivery filtering may require the subject and recipient to
  share at least one Team for which Journey visibility is enabled. That future
  receiver-side check must filter both initial snapshots and realtime changes;
  it is not part of V1.
- Subscription startup returns or emits a deterministic initial snapshot before
  subsequent changes. The snapshot includes state published before the client
  joined when it has not yet expired. Realtime changes distinguish added,
  updated, and removed flat Journey-state records, with expiry represented as
  removal.
- `journey.subscribe(listener)` emits exactly one discriminated
  `{ type: "snapshot", states }` event first, followed by
  `{ type: "added" | "updated" | "removed", state }` events.
- A removed event carries the complete last visible Journey state so consumers
  can update user grouping without a hidden lookup. Expiry, explicit disable,
  auth transition, and runtime cleanup use the same removed shape.
- Latest-state coalescing may omit intermediate updated events but never violates
  snapshot-first ordering or suppresses the final removal.
- Journey events use Sporades-reserved platform message types over the existing
  client transport. They are not app-defined messages under ADR 0014 and cannot
  be forged through `sendMessage()` or Capsule message handlers.
- Journey state and Journey session identity are runtime-owned transient state
  scoped to the live server runtime. Neither is stored through the Database
  adapter; the browser page runtime retains only consent and capture policy.
- Server runtime restart clears every buffered Journey state and every Journey
  session identity. A still-consenting page reconnects and publishes only fresh
  automatic or manual state under a new server-assigned session ID.
- A published state transition is atomic within the runtime; failed transitions
  are not broadcast as accepted state.
- Cleanup is bounded and deterministic. Expired state may be removed lazily at
  reads, writes, updates, and a runtime timer, but external behavior
  must not expose an expired record as active.
- The implementation reuses the existing client transport connection,
  request/response conventions, structured errors, fan-out machinery, and
  subscription teardown patterns rather than introducing a new HTTP endpoint,
  socket, or public transport abstraction.
- Public TypeScript declarations cover the SDK operations, Journey record,
  JSON metadata, change events, result envelopes, and unsubscribe behavior.
- Dev sessions, local Container sessions, and Hosted Capsules share the same
  generated runtime implementation and transient lifecycle contract; generated
  Bundle parity is part of delivery.
- Documentation must explain opt-in behavior, Journey session identity, safe
  metadata guidance, Capsule and client enablement, caller-controlled renewal,
  TTL and expiry semantics, auth transitions, explicit disablement, and the
  distinction from preferences and App messages.

## Testing Decisions

- Good tests exercise external behavior through the highest existing seam: run
  a real Dev-session runtime, connect clients through the WebSocket transport,
  call the public `sporades/client` Journey API, and observe result envelopes,
  active snapshots, and realtime changes.
- The primary integration suite covers explicit enablement, initial state,
  replacement updates, multiple clients, Capsule-wide visibility, opaque
  identities, subscriptions, unsubscribe behavior, disablement, clean close,
  auth transitions, authorization failures, validation errors, and structured
  error responses.
- Record-shape tests prove that the correct authenticated Sporades user ID is
  present while Session tokens, provider identity, email, display name, picture,
  and raw auth fields remain absent.
- Multi-client tests use distinct users and multiple clients for one user to
  prove both Capsule-wide visibility and one-Journey-session-per-browser
  behavior.
- TTL, renewal, buffering, and expiry tests use the controllable runtime clock at
  the runtime boundary. Tests must not wait for wall-clock timeout intervals.
- Restart tests prove that no buffered Journey state or Journey session identity
  survives server runtime replacement, while a still-consenting page retains
  consent/capture policy and publishes fresh state under a new session ID.
- Lower-level tests are limited to atomic state replacement, private ownership
  checks, and timer behavior that cannot be demonstrated clearly through the
  client transport seam.
- Tests avoid asserting private table names, timer implementation, SQL text, or
  internal WebSocket client identifiers except in focused migration tests where
  the storage boundary itself is the contract under test.
- Type tests prove the public SDK accepts JSON-safe metadata, exposes typed
  Journey records and events, returns an unsubscribe capability, and rejects
  invalid top-level API shapes.
- Generated-runtime tests verify source and generated Bundle parity so Dev,
  Container, and Hosted execution cannot silently diverge.
- Documentation tests verify that the roadmap and user guide describe the
  implemented opt-in, privacy, expiry, and disable/delete contract when the
  feature lands.
- Prior art includes the client preferences SDK transport tests, filterable App
  message subscription tests, WebSocket query/mutation integration harnesses,
  runtime auth transition tests, runtime-owned migration tests, and generated
  runtime parity checks.

## Out of Scope

- Exposing auth profiles, provider identities, Session tokens, email, display
  name, picture, or raw auth records in Journey records.
- Letting a client select, override, or spoof the Sporades user ID attached from
  its authenticated session.
- Durable analytics, event history, funnels, session replay, audit logging, or
  long-term journey retention.
- Geolocation, device fingerprinting, IP addresses, user-agent collection, or
  automatic PII enrichment.
- Tracking without initial explicit client enablement or restoring consent after
  auth transition, disablement, page reload, or client-runtime replacement.
- Persisting Journey sessions, resume credentials, or retirement tombstones
  across runtime restart, or treating transient Journey state as recoverable
  durable data.
- Capsule-defined schemas, arbitrary indexes, query languages, aggregation, or
  ACL rules over Journey records.
- Cross-Capsule, Host-wide, or organization-wide journey visibility.
- Teams, Capsule roles, invitations, or collaborative authorization policy.
- Per-record visibility, publisher-selected audiences, and Team-based Journey
  delivery filtering; V1 broadcasts to every connected Capsule client.
- Automatic SDK heartbeats or background renewal of a status the caller has not
  explicitly republished.
- Offline history synchronization or guaranteed delivery of every intermediate
  status update.
- Arbitrary clickstream capture, form-value collection, raw DOM snapshots,
  session replay, cursor trails, pointer coordinates, or automatic extraction of
  labels and text from page content.
- Automatic `change`, typing, drag/drop, gesture, or pointer-event capture.
- URL origins, query strings, raw fragments, and automatic route-template or
  identifier inference from potentially sensitive paths.
- A dashboard, operator CLI inspection command, or visual presence component.
- Capsule server or Privileged server role publication of Journey state for a
  selected user.
- Capsule server-context reads, queries, subscriptions, or business rules based
  on transient Journey state.
- Replacing App messages for arbitrary ephemeral application events.
- Replacing current-user preferences for durable per-user settings.

## Further Notes

- This feature is presence-like, but the accepted Sporades domain term is User
  journey tracker because it covers route, focus, typing, and workflow progress
  without claiming to identify a person.
- The Journey session ID distinguishes simultaneous client activity; the
  attached Sporades user ID identifies whose activity it is. Neither identifier
  is an auth credential.
- Metadata should remain deliberately small and privacy-conscious. A convenient
  JSON pocket is not an invitation to stuff an entire customer dossier into the
  WebSocket. Charming idea; terrible product decision.
- The feature must respect ADR 0014's transport ownership: platform Journey
  events use reserved runtime message types, while app-defined messages remain
  mediated through Capsule server handlers.
- ADR 0031 records the consent, identity, automatic-capture, transient-state,
  reconnect, and future Team-delivery boundaries resolved during design.
