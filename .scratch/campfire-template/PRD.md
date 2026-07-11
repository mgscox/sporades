# Campfire Template Capsule

Status: ready-for-agent

## Source Planning

- Conversation following completion of the User journey tracker exemplar work.
- `.scratch/user-journey-tracker/PRD.md`
- ADR 0031, which defines Journeys as consented, session-scoped current state.

## Problem Statement

Sporades now provides realtime queries, mutations, email identity, and a User
journey tracker, but its scaffold templates do not show how those capabilities
combine in a believable multi-user Capsule. A Journey demonstration based only
on one person's isolated activity is technically correct but visually empty,
while an incident dashboard would need simulated traffic or an external
high-activity integration before it felt useful.

Developers need a small exemplar that becomes meaningful with only a few local
browser windows, distinguishes durable collaborative data from ephemeral
Journey state, and makes the Journey privacy and consent boundary visible. The
exemplar must be enjoyable enough to invite exploration without depending on
real email addresses, real external users, third-party APIs, bots, or fabricated
background activity.

## Solution

Add `campfire` as a scaffold template for a miniature community chat Capsule.
Campfire provides four fixed channels, realtime messages, thumbs-up and
thumbs-down message reactions, typing indicators, and a global status panel
showing the privacy-safe current activity shared by connected participants.

The generated Capsule includes four deterministic exemplar identities based on
the four Musketeers: Athos, Porthos, Aramis, and d'Artagnan. Their reserved
`.example` email addresses and clearly marked demo credentials can be created by
an explicit development-data seed flow. A visible Musketeer switcher lets a
developer operate separate browser sessions as different users without real
email delivery. The seed flow is never silently run for a Container session or
Hosted Capsule.

Durable Capsule data and ephemeral Journey state remain deliberately separate.
Channels, messages, and reactions live in Capsule schema and update through
normal queries and mutations. Typing, reading a channel, composing, reacting,
and other current activity use the runtime-owned Journey tracker and expire
under its existing latest-state TTL contract. Campfire asks for explicit
page-runtime consent before publishing activity and states plainly that it
never publishes draft text, message contents, raw URLs, email addresses, or
keystrokes.

## User Stories

1. As a developer, I want to create Campfire with the Sporades template selector, so that I can explore a complete multi-user Capsule without assembling one from scratch.
2. As a developer, I want the generated Campfire project to run as a normal Capsule, so that the exemplar follows the same Bundle pipeline as user-authored projects.
3. As a developer, I want Campfire to work with the template's selected supported client framework, so that the exemplar follows scaffold conventions rather than becoming a special runtime.
4. As a developer, I want Campfire to require no third-party API, webhook, bot, or active repository, so that its collaboration behavior is locally reproducible.
5. As a developer, I want Campfire to become meaningful with two browser sessions, so that I do not need a large traffic simulation.
6. As a developer, I want an explicit seed flow for exemplar data, so that I can prepare a repeatable demonstration without manual account creation.
7. As an operator, I want demo data creation to be opt-in, so that fixture users and credentials are not silently installed in a Container session or Hosted Capsule.
8. As an operator, I want repeated seeding to be idempotent, so that rerunning setup does not duplicate users, channels, messages, or reactions.
9. As a security-conscious developer, I want all fixture email addresses to use a reserved `.example` domain, so that Campfire cannot accidentally contact a real recipient.
10. As a security-conscious developer, I want the generated project to identify fixture credentials as development-only, so that they are not mistaken for production accounts.
11. As a visitor, I want to enter Campfire as Athos, Porthos, Aramis, or d'Artagnan, so that I can exercise distinct Sporades identities without recruiting three colleagues.
12. As a visitor, I want each Musketeer to have a stable display name, colour, and monogram avatar, so that simultaneous sessions are immediately distinguishable.
13. As a visitor, I want a visible Musketeer switcher, so that changing the current exemplar identity is easy to discover.
14. As a visitor, I want identity switching to use ordinary Sporades email auth boundaries, so that the exemplar demonstrates real sign-out and sign-in behavior.
15. As a visitor, I want switching identity to retire the prior user's Journey state, so that the global panel never attributes new activity to the old identity.
16. As a visitor, I want Campfire to contain `#general`, `#ideas`, `#random`, and `#protect-the-crown`, so that navigation produces understandable collaborative activity.
17. As a visitor, I want channel selection to survive new realtime messages, so that activity elsewhere does not disrupt what I am reading.
18. As a visitor, I want to read a channel's existing messages in chronological order, so that conversations have understandable context.
19. As a visitor, I want newly sent messages to appear for every connected reader of that channel, so that chat feels realtime.
20. As a visitor, I want messages to show their author and creation time, so that I can follow the conversation.
21. As a visitor, I want empty or whitespace-only messages rejected, so that the room cannot be filled with meaningless records.
22. As a visitor, I want message length bounded, so that one message cannot overwhelm the exemplar UI or transport.
23. As a visitor, I want to react to a message with thumbs up, so that I can express agreement without sending another message.
24. As a visitor, I want to react to a message with thumbs down, so that I can express disagreement without sending another message.
25. As a visitor, I want at most one thumbs-up and one thumbs-down reaction per identity per message, so that repeated clicking does not inflate totals.
26. As a visitor, I want clicking my active reaction again to remove it, so that reactions are reversible.
27. As a visitor, I want reaction totals to update for every connected reader, so that community response is visible in realtime.
28. As a visitor, I want reactions described as reactions rather than anonymous votes, so that the exemplar does not imply poll secrecy or election semantics.
29. As a visitor, I want a pinned crown-protection prompt in `#protect-the-crown`, so that the reaction feature has an immediate playful use.
30. As a visitor, I want the initial seeded conversation to establish the Musketeer theme, so that a new Campfire is not an empty dashboard.
31. As a visitor, I want a clear “Share my activity” control, so that Journey publication requires an affirmative choice.
32. As a visitor, I want Campfire to remain fully usable when activity sharing is off, so that consent is not coerced through feature loss.
33. As a visitor, I want the consent control to explain what Campfire shares, so that I can make an informed choice.
34. As a visitor, I want the consent control to explain what Campfire never shares, so that typing indicators are not confused with draft surveillance.
35. As a visitor, I want turning activity sharing off to remove my current Journey state immediately, so that revoking consent has visible effect.
36. As a visitor, I want entering a channel to publish that I am reading that channel when sharing is enabled, so that others can understand where activity is happening.
37. As a visitor, I want beginning to type to publish a typing indicator for the selected channel, so that other participants can avoid talking over me.
38. As a visitor, I want typing state renewed while I continue composing, so that the indicator remains current without becoming durable presence.
39. As a visitor, I want typing state to expire shortly after I stop typing, so that stale indicators disappear without a synthetic stop event being required.
40. As a visitor, I want sending or clearing my draft to replace typing state with a safe channel activity, so that the panel reflects what I am now doing.
41. As a visitor, I want reacting to a message to publish only a bounded semantic activity and channel name, so that Journey does not disclose the message or its identifier.
42. As a visitor, I want Campfire never to publish draft text, message text, email addresses, passwords, raw URLs, query strings, or keystrokes through Journey, so that activity sharing remains privacy-safe.
43. As a visitor, I want ordinary browser focus and visibility activity to follow the existing Journey capture policy, so that Campfire does not invent competing presence semantics.
44. As a visitor, I want a global status panel to show who is reading, typing, reacting, or away, so that the Capsule demonstrates current multi-user activity.
45. As a visitor, I want the status panel to use the Musketeer's display name and visual identity, so that runtime user IDs are not exposed as the primary UI.
46. As a visitor, I want the panel to distinguish multiple live sessions for one user, so that two tabs do not overwrite one another or masquerade as one browser.
47. As a visitor, I want the panel to derive inactivity from missing live Journey state, so that Campfire does not store fake offline records.
48. As a late joiner, I want an initial snapshot of unexpired activity, so that the status panel is useful immediately.
49. As a connected visitor, I want Journey additions, replacements, and removals reflected without polling, so that the status panel converges in realtime.
50. As a visitor, I want disconnected or abandoned typing activity to disappear under the existing TTL, so that stale state does not linger.
51. As a visitor, I want reconnecting to preserve only current page-runtime consent and create fresh session identity on publication, so that Campfire demonstrates the Journey reconnection contract accurately.
52. As a visitor, I want a page reload or identity transition to require consent again, so that Campfire does not persist Journey consent behind my back.
53. As a developer, I want durable messages and reactions to remain after Journey state expires, so that the distinction between app data and current state is unmistakable.
54. As a developer, I want Journey metadata to use semantic channel slugs rather than raw browser locations, so that the exemplar models safe application vocabulary.
55. As a developer, I want the generated README to explain the durable-data and Journey-state split, so that the exemplar teaches architecture rather than only presenting a UI.
56. As a developer, I want the generated README to document fixture identities and seeding, so that the demonstration is repeatable.
57. As a developer, I want the generated README to explain how to open multiple isolated browser sessions, so that distinct identities do not share one Session token accidentally.
58. As a developer, I want the generated README to warn against enabling demo fixtures for a public Capsule, so that exemplar convenience does not become a deployment vulnerability.
59. As an AFK agent, I want scaffold and runtime behavior verified through public commands and browser-visible results, so that completion does not depend on private implementation inspection.
60. As a maintainer, I want Campfire represented in template selection, help, and scaffold validation, so that the new option behaves like existing templates.
61. As a maintainer, I want generated output deterministic, so that scaffold snapshots and package behavior remain reviewable.
62. As a maintainer, I want Campfire to reuse the public auth, query, mutation, and Journey APIs, so that the template does not create a new privileged or template-only runtime surface.
63. As a maintainer, I want the full repository suite to remain green, so that the exemplar does not regress existing templates or generated runtime parity.
64. As a documentation reader, I want Campfire named as the exemplar for User journey tracking, so that I can find a complete working example from the Journey documentation.
65. As a visitor, I want Campfire presented with Tailwind CSS and Shadcn/UI components, so that the exemplar feels like a polished contemporary product rather than a runtime test fixture.
66. As a developer, I want the generated UI source to remain editable inside the Capsule, so that adopting the exemplar does not depend on a hidden component service.
67. As a developer, I want any required component runtime packages declared by the generated Capsule, so that a fresh install and build is deterministic.

## Implementation Decisions

- Add `campfire` to the existing scaffold template selection path. It is an
  exemplar Capsule, not a new runtime mode or package.
- Campfire uses the existing scaffold framework choice and the same Bundle
  pipeline as other generated Capsules. Its authoring surface must not depend on
  private runtime imports.
- The highest verification seam is a generated Campfire Capsule exercised
  through public CLI, browser, client SDK, and server Capsule APIs. Lower-level
  tests are added only where scaffold rendering cannot be observed reliably at
  that seam.
- Campfire declares email authentication and the User journey tracker. It uses
  existing public email sign-up/sign-in behavior and Journey operations; this
  feature adds no template-only auth bypass, identity impersonation API, or
  server-side Journey mutation surface.
- The four exemplar identities are Athos (`athos@campfire.example`), Porthos
  (`porthos@campfire.example`), Aramis (`aramis@campfire.example`), and
  d'Artagnan (`dartagnan@campfire.example`). Each has a stable colour and
  monogram avatar defined by generated app code rather than provider profile
  data.
- Fixture credentials are conspicuously development-only. They may be supplied
  by generated local development configuration or an explicit generated seed
  command, but they must not be committed as a production secret or activated
  implicitly by starting, deploying, or hosting the Capsule.
- Seeding is explicit and idempotent. It creates or verifies the four fixture
  identities through supported auth behavior and inserts the fixed channels and
  starter content exactly once. A clear result distinguishes created, already
  present, and failed seed records.
- The generated UI provides a Musketeer switcher. Switching signs out the
  current identity and signs into the selected fixture identity through public
  auth behavior. Separate concurrent identities are demonstrated with isolated
  browser contexts because one browser storage context owns one Session token.
- Campfire has exactly four fixed channels in V1: `general`, `ideas`, `random`,
  and `protect-the-crown`. Channel management is not part of the exemplar.
- Capsule schema persists channels, messages, and message reactions. Authorship
  is derived on the server from `ctx.auth`; the client cannot submit or override
  another user's author identity.
- A message belongs to one channel and stores its bounded text plus server-owned
  author identity and ordinary managed timestamps. The UI resolves seeded
  Musketeer presentation from the known exemplar identities while remaining
  robust to an authenticated identity outside that set.
- Message reads use a realtime query filtered to the selected channel and
  ordered chronologically. Sending uses a mutation with server-side validation
  of non-empty bounded text.
- Reactions are durable app records keyed by message, current user, and reaction
  kind. Supported kinds are `like` and `dislike`, rendered as thumbs up and
  thumbs down. They are reactions, not polls: no anonymity, close state, secret
  ballot, or winner semantics are implied.
- Reaction mutations are idempotent toggles for the current authenticated user.
  Server-side logic prevents duplicate reaction rows for the same user, message,
  and kind. Removing one kind does not silently remove the other.
- The seeded `protect-the-crown` conversation includes a pinned-style opening
  prompt asking whether the crown is adequately protected, with “All for one”
  and “One more guard, perhaps” presented as playful like/dislike meanings.
- The seed conversation may include the agreed character exchange about the
  Queen requiring discretion, Porthos requesting refreshments, Aramis preferring
  discretion, and d'Artagnan liking refreshments. Seed content is bounded and
  deterministic.
- Campfire exposes a global “What's happening” panel backed by
  `journey.subscribe(...)`, including its initial snapshot. It groups safe live
  records by user for presentation but preserves and displays multiple sessions
  rather than flattening them into one stored user status.
- Campfire never stores Journey records in Capsule schema. `inactive` is derived
  from absence of an unexpired record and is not published or persisted.
- Activity publication is off by default. A visible “Share my activity” control
  calls `journey.enable()` only after affirmative user action and calls
  `journey.disable()` when revoked.
- Consent is page-runtime scoped. Campfire does not persist the user's Journey
  choice in local storage, current-user preferences, app tables, or fixture
  records. Reload and identity transition therefore require a new affirmative
  enable action, while ordinary transport reconnect follows the existing
  Journey contract.
- Campfire uses manual Journey state for application-specific activity.
  Semantic statuses include `reading`, `typing`, `reacting`, and `composing` as
  needed; metadata is restricted to a safe channel slug and optional bounded
  activity label.
- Channel selection publishes `reading` only when consent is enabled. Typing
  publishes `typing` with the selected channel, is renewed at a bounded cadence
  while input changes continue, and uses a short TTL so stopping, disconnecting,
  or abandoning the page removes the indicator naturally.
- Sending or clearing a draft replaces live `typing` state with `reading` for
  the current channel. Campfire does not depend on receiving every intermediate
  keystroke or Journey event because Journey is latest-state, coalescible current
  state rather than a durable event stream.
- Reaction activity may publish `reacting` with the channel slug, but never the
  message ID, message text, reaction target, email address, or raw browser route.
- The consent UI lists the shared semantic fields and explicitly states that
  draft text, message text, raw URLs, query strings, email addresses, passwords,
  and keystrokes are not published.
- The status panel maps Journey `userId` values to safe app-visible presentation
  data. Journey records themselves remain within the existing contract and do
  not gain display names, email addresses, or provider profiles.
- The generated interface should feel like a compact community room rather
  than reproduce Discord branding. “Campfire” is the product name; no Discord
  trademarks, copied assets, or visual clone are required.
- Campfire uses Tailwind CSS for layout and styling and Shadcn/UI conventions
  for accessible source-owned interface components such as buttons, cards,
  avatars, badges, tooltips, separators, scroll areas, dialogs, switches, and
  text inputs.
- Shadcn/UI is treated according to its source-ownership model: the scaffold
  writes the selected component source into the generated Capsule rather than
  depending on a fictional Shadcn runtime CDN. The generated components remain
  ordinary editable Capsule code.
- Under the current fixed client-Bundle scaffold contract, Tailwind may be
  loaded from its documented browser CDN in generated `index.html`. Any React
  primitives, icon packages, class utilities, or other JavaScript dependencies
  required by the selected Shadcn/UI components are declared in the generated
  Capsule package and installed through the normal scaffold dependency flow.
- The Tailwind CDN choice must be explicit in the generated README, including
  that the browser needs network access and that a production Capsule may choose
  to move Tailwind into its build pipeline. Campfire must not silently fetch
  JavaScript component logic from an unpinned third-party CDN.
- If the Bundle pipeline gains first-class generated CSS asset support before
  Campfire is implemented, the implementation should install and compile
  Tailwind inside the generated Capsule instead of using the browser CDN. This
  changes asset delivery, not the Campfire interaction or Journey contract.
- The visual direction is warm, dark, and firelit, with clear channel, message,
  reaction, consent, and activity-panel hierarchy. Musketeer colours and
  monogram avatars must remain legible and accessible rather than relying on
  colour alone.
- The generated README documents setup, explicit fixture seeding, fixture-only
  security constraints, multi-context browser demonstration, the split between
  durable Capsule data and ephemeral Journey state, and the expected TTL and
  identity-transition behavior.
- Template selection help and relevant Journey documentation point to Campfire
  as the complete exemplar.

## Testing Decisions

- Good tests assert externally observable scaffold and Capsule behavior rather
  than helper names, generated string fragments in isolation, internal Journey
  maps, private auth tables, or component implementation details.
- The primary test generates a Campfire project through the same scaffold entry
  used by `sporades create`, installs or resolves its normal dependencies,
  builds it, and starts a Dev session. This is the highest existing seam across
  template selection, generated files, Bundle pipeline, server registration,
  client transport, and app behavior.
- Scaffold coverage verifies that `campfire` is accepted wherever existing
  template names are validated or displayed, that output is deterministic, and
  that both supported scaffold framework choices remain syntactically valid.
- Scaffold coverage verifies that the generated Tailwind setup, source-owned
  Shadcn/UI components, and declared component dependencies survive a fresh
  install and production build without relying on packages from the Sporades
  repository checkout.
- Seed-flow coverage verifies explicit invocation, four deterministic fixture
  identities, four fixed channels, deterministic starter content, idempotent
  repeat execution, and safe refusal or non-execution outside its documented
  development boundary.
- Runtime behavior coverage uses at least two isolated client sessions signed in
  as different Musketeers. It verifies channel message convergence, trusted
  server-derived authorship, input validation, and reaction toggle convergence.
- Journey behavior coverage uses the public client transport seam already used
  by User journey tracker integration tests. It verifies consent gating, initial
  snapshot, safe `reading` and `typing` metadata, typing renewal and expiry,
  immediate disable removal, multiple sessions, and auth-transition retirement.
- A privacy assertion inspects every Campfire-published Journey record and proves
  that draft/message text, message IDs, fixture emails, credentials, query
  strings, and raw URLs are absent.
- Browser smoke verification opens at least two isolated browser contexts,
  selects distinct Musketeers, enables sharing independently, exchanges a
  message, toggles reactions, observes typing expiry, and confirms the global
  status panel converges for a late joiner.
- The generated Capsule is additionally built and started through a local
  Container session if existing template acceptance coverage uses that seam.
  Hosted deployment is optional exemplar validation, not a requirement for
  every repository test run.
- Prior art includes existing scaffold-template tests, the Photo Library
  template's generated-Capsule verification, auth sign-up/sign-in integration
  tests, query/mutation subscription tests, and User journey tracker transport
  and browser-runtime tests.
- The repository's broad test command must pass after generated output is
  refreshed, preserving source/generated Bundle parity and all existing
  template behavior.

## Out of Scope

- Connecting Campfire to Discord, GitHub, Slack, email delivery, or any other
  third-party service.
- Simulated background users, bots, artificial message traffic, or load testing.
- Production account provisioning, invitations, password reset, email
  verification, OAuth setup, or a general-purpose demo-user platform API.
- Automatically installing fixture users or known credentials in a Container
  session or Hosted Capsule.
- User-created channels, private channels, direct messages, threads, message
  editing, message deletion, moderation, file uploads, voice, video, screen
  sharing, rich embeds, or notifications.
- Anonymous or secret voting, polls, vote closing, winners, ranked choice, or
  other election semantics. Thumbs up and thumbs down are visible reactions.
- Durable presence, last-seen history, analytics, productivity scoring, raw
  navigation capture, draft capture, or keystroke logging.
- Changing the User journey tracker lifecycle, limits, consent, visibility,
  reconnect, identity, capture, or TTL contracts.
- Adding display names, emails, avatars, or provider data to Journey records.
- Persisting Journey consent across reloads.
- Reproducing Discord's branding, assets, layout, or complete feature set.
- Adding a new general-purpose CSS pipeline to Sporades solely for Campfire. If
  first-class CSS assets arrive independently, Campfire may consume them.
- Requiring the Shadcn CLI after scaffold generation or downloading component
  implementation code at page runtime.
- Making Campfire the default template.

## Further Notes

- The four fixture identities are intentionally theatrical and immediately
  legible. This is a teaching Capsule, and a little personality is cheaper than
  a synthetic traffic generator.
- Suggested starter exchange:
  - Athos: “The Queen requires discretion.”
  - Porthos: “And refreshments.”
  - Aramis: “Mostly discretion.”
  - d'Artagnan: “I have reacted to refreshments.”
- The central architectural lesson is that messages and reactions remain after
  every participant disconnects, while typing and current activity disappear.
  The UI and README should make that contrast obvious.
- Campfire should remain small enough to read as exemplar source. Visual polish
  matters, but abstraction layers that obscure the public Sporades APIs work
  against the template's purpose.
