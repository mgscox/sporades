# User journeys are consented session-scoped current state

Sporades models a User journey as explicitly consented current activity rather
than ordinary durable Presence, analytics, or an event history. A Capsule must
declare `journey: { enabled: true }`, and each browser page runtime must call
`journey.enable()` before the client runtime maps its Journey session ID to the
authenticated Sporades user ID and publishes manual or automatically captured
state.

Journey state is client-only, latest-only, TTL-buffered, and non-durable. Safe
navigation, focus/visibility, and explicitly annotated semantic interactions may
replace the current state, while arbitrary clicks, URL query/raw fragment data,
form values, raw DOM, and session replay are excluded. Same-user transport
reconnect preserves the page-runtime Journey session through a private resume
capability, but server restart clears buffered state and auth transition or
explicit disablement ends consent.

Navigation capture belongs to the framework-neutral browser client runtime, not
to React hooks or future Vue, Svelte, SolidJS, Lit, or Inferno adapters. It
observes initial location, History API changes, `popstate`, `hashchange`, and the
single semantic Journey page `<meta>` element after a rendering opportunity;
framework-specific adapters consume Journey state but do not detect routes.
Annotated interactions use one framework-neutral delegated DOM observer for
`click` and `submit`, with `composedPath()` lookup and post-propagation
`defaultPrevented` handling rather than framework event APIs.

V1 sends live Journey snapshots and changes to every connected Capsule client.
Future visibility filtering belongs at the receiver-side delivery boundary and
may require the subject and recipient to share a Team where Journey visibility
is enabled; publishing clients never choose or widen their audience. Capsule
server code and the Privileged server role neither publish nor consume Journey
state because transient client activity is not authoritative business input.

## Considered Options

- A conventional durable Presence resource was rejected because restart
  persistence and server-authored user activity would misrepresent live client
  truth and blur the boundary with analytics.
- Session-only anonymous records were rejected because the product objective is
  to answer what one Sporades user is doing across simultaneous tabs or devices.
- Automatic capture of every click was rejected because it would collect
  behavior without semantic author intent and drift toward session replay.
- Framework-router integrations were rejected as the primary navigation seam
  because they would duplicate lifecycle behavior across every client toolchain
  and make Journey correctness depend on adapter parity.

## Consequences

- Consumers group flat live records by `userId` and derive `inactive` when that
  user has no unexpired Journey state.
- The tracker provides current collaborative context but cannot reconstruct a
  user's historical journey or guarantee every intermediate signal.
- Broader delivery policy waits for Teams rather than embedding a temporary
  per-record permission model.
