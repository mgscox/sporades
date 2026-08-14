# Built-in Teams, Membership Roles, and Email-Bound Join Links

Status: ready-for-agent

## Problem Statement

Capsule authors who need collaborative or multi-tenant behavior currently have
to model Teams, membership, Team administration, invitation capabilities, and
Team-aware authorization in their own app tables and handlers. Every Capsule
must then rediscover the same security invariants: a Team must retain an admin,
membership enumeration must remain private, role changes must be atomic, and a
join capability must expire, resist forgery, support revocation, and bind to
the intended user without leaking its secret.

At the same time, Capsules that do not need collaboration should not have to
configure Teams, add Team fields to their schemas, alter `ctx.auth`, or change
existing queries, mutations, files, or ACL rules. Team support should be built
in without turning every Capsule into compulsory multi-tenant software.

The existing roadmap also separates future Capsule roles from Teams for ACL,
even though an application role such as `author` or `reviewer` is meaningful
only in the context of one user's membership of one Team. Leaving those tracks
separate would create overlapping authorization models and make it unclear
whether a role belongs to a Sporades user, a Capsule, or a Team membership.

## Solution

Sporades provides a runtime-owned, Capsule-scoped Team module that is available
by default with no enablement flag. A linked Sporades user receives an initial
singleton Team and is its first admin. Capsules that never call the Team
interfaces continue to behave exactly as they do today; Team membership never
changes `ctx.auth`, automatically filters app data, or selects an implicit
current Team.

Each Team membership has one Sporades-owned management role, `admin` or
`member`, plus zero or more application roles declared by the Capsule, such as
`author` or `reviewer`. Team admins manage membership, Join links, and
application-role assignments. Application roles and Team-admin status are
available through constrained Team helpers in normal ACL rules, while access
to Capsule DB rows, files, and storage remains explicitly declared by the
Capsule.

Team admins create short-lived, revocable, single-use Join links for one
normalized email address. Sporades returns the link but never sends it; the
Capsule owns its route, UI, message copy, and delivery mechanism. After email
registration, email sign-in, or an OAuth callback, the Capsule can ask Sporades
whether the current linked user's email matches the Join link. This
non-consuming check returns only a valid or invalid indicator. Sporades does
not require or enforce email-address verification: whether a matching address
is sufficiently verified is a per-Capsule policy decision. Joining repeats all
checks transactionally, creates an ordinary `member` membership with no
application roles, and consumes the Join link.

Sporades exposes no Team UI. It provides the browser interface, trusted server
context interface, runtime-owned persistence, security invariants, and ACL
helpers from which each Capsule builds its own experience.

## User Stories

1. As a Capsule author, I want Teams available without an enablement flag, so that collaboration is a built-in platform capability.
2. As a Capsule author who does not need Teams, I want my Capsule code to continue working unchanged, so that built-in functionality does not impose a tenancy model.
3. As a Capsule author who does not use Teams, I want existing auth results to retain their current shape, so that Team support is not a breaking change.
4. As a Capsule author who does not use Teams, I want existing queries and mutations to retain their current behavior, so that Team support does not silently partition data.
5. As a Capsule author who does not use Teams, I want existing file operations and ACL rules to retain their current behavior, so that collaboration remains explicitly adopted.
6. As a newly linked user, I want an initial singleton Team, so that I can begin alone and later add collaborators without changing account models.
7. As a newly linked user, I want to be the first admin of my initial Team, so that every Team starts with someone able to manage it.
8. As an existing linked user when Teams are introduced, I want my initial singleton Team created lazily, so that migration does not require a disruptive bulk rewrite.
9. As an Anonymous user, I do not want a durable Team membership created for my temporary guest identity, so that abandoned sessions do not fill Team storage.
10. As a linked user, I want to create additional Teams, so that I can organise separate groups in the same Capsule.
11. As a linked user, I want to belong to more than one Team, so that collaboration groups are not mutually exclusive.
12. As a Capsule developer, I want every Team operation to name its Team explicitly, so that multi-Team users are never governed by hidden current-Team state.
13. As a Capsule UI author, I want to hide Team navigation when the user has only one singleton Team, so that a single-user Capsule remains visually simple.
14. As a Capsule UI author, I want Team listing to expose enough state to identify singleton membership, so that the UI can make that presentation decision.
15. As a Team creator, I want to give my Team a display name, so that users can distinguish it from their other Teams.
16. As a Team admin, I want to rename my Team, so that its platform identity can follow the group it represents.
17. As a Capsule author, I want Team names to be presentation metadata rather than authorization authority, so that changing a name cannot change access.
18. As a Team member, I want to list only the Teams to which I belong, so that other Teams are not exposed as a Capsule-wide directory.
19. As a Team member, I want to read my own membership and roles, so that the UI can explain my available actions.
20. As an ordinary Team member, I do not want to enumerate other Team memberships, so that teammate identities remain private by default.
21. As a Team admin, I want to list memberships for a Team I administer, so that I can manage that Team.
22. As a Team admin, I do not want my authority to reveal memberships from another Team, so that admin scope remains Team-specific.
23. As a Team admin, I want member listings to contain safe profile fields, so that I can identify members without receiving unnecessary account data.
24. As a Team member, I do not want my email address included in ordinary member listings, so that Team membership does not create an email directory.
25. As a Capsule author, I want to declare application roles such as `author` and `reviewer`, so that my domain can distinguish responsibilities inside a Team.
26. As a Capsule author, I want application-role names validated at Capsule load, so that invalid or reserved role names fail before serving traffic.
27. As a Capsule author, I want `admin` and `member` reserved for Team management, so that application roles cannot impersonate Sporades-owned authority.
28. As a Capsule author, I want a Team membership to hold multiple application roles, so that one user can be both an author and reviewer where appropriate.
29. As a Capsule author, I want the same user to have different application roles in different Teams, so that roles are scoped to membership rather than globally to the user.
30. As a Team admin, I want to add an allowed application role to a member, so that I can grant app-specific responsibility.
31. As a Team admin, I want to remove an application role from a member, so that I can revoke app-specific responsibility.
32. As a Team admin, I want role additions and removals to be atomic, so that concurrent admin actions do not overwrite unrelated assignments.
33. As an ordinary Team member, I do not want to assign roles to myself or others, so that role grants remain administrative actions.
34. As a Team admin, I want new members to join with no application roles, so that opening a Join link never silently grants app authority.
35. As a Capsule author, I want Team admins not to receive every application role automatically, so that Team management and app-data authorization remain distinct.
36. As a Capsule author, I want to check Team-admin status explicitly in ACL, so that I may deliberately grant admins app-data access when my domain requires it.
37. As a Capsule author, I want to check Team membership in ACL, so that rows and files can be shared with exactly one Team.
38. As a Capsule author, I want to check one application role in ACL, so that app data can require a precise responsibility.
39. As a Capsule author, I want to check whether a member has any role from an allowed set, so that ACL declarations stay concise.
40. As a Capsule author, I want Team ACL helpers to be read-only and constrained, so that policy evaluation cannot modify membership or recurse through normal app APIs.
41. As a Capsule author, I want Team ACL helpers to expose decisions rather than raw runtime tables, so that app policy remains independent of Team storage details.
42. As a Capsule author, I want Team-aware ACL to remain allow-by-default only where my existing ACL declaration says so, so that adding Teams does not rewrite established ACL semantics.
43. As a Team admin, I want to create a Join link for one email address, so that I can invite a specific person without building capability security myself.
44. As a Team admin, I want email to be mandatory when creating a Join link, so that a link cannot be issued as an untargeted invitation.
45. As a Team admin, I want the target email normalized consistently with Sporades auth, so that harmless casing or surrounding whitespace does not break matching.
46. As a Team admin, I want every Join link to expire, so that forgotten invitations do not remain usable forever.
47. As a Team admin, I want a bounded TTL when issuing a Join link, so that I can choose an appropriate invitation window without creating effectively permanent credentials.
48. As a Team admin, I want a safe default TTL, so that the common path is secure without extra configuration.
49. As a Team admin, I want to list active Join links for my Team without recovering their secret codes, so that I can manage outstanding invitations safely.
50. As a Team admin, I want to revoke an unused Join link before expiry, so that an invitation can be withdrawn.
51. As a Team admin, I do not want to list or revoke Join links for another Team, so that Join-link authority follows Team administration.
52. As a Capsule author, I want Sporades to return a Join link without sending it, so that my Capsule owns delivery and communication style.
53. As a Capsule author, I want to deliver a Join link through email, chat, or another channel, so that Teams do not depend on SMTP configuration.
54. As a Capsule author, I want the Join page to live on my Capsule origin, so that Sporades does not impose a hosted Team UI.
55. As a Capsule operator, I want Join links constructed from canonical Capsule origin information, so that request headers cannot redirect genuine links to an attacker.
56. As a Capsule author, I want the Join route to be a validated same-origin path, so that the feature cannot become an open redirect.
57. As a recipient, I want to inspect limited safe Join-link information before authenticating, so that the Capsule can explain the pending action without exposing the target email.
58. As an Anonymous recipient, I want the Join link to remain unconsumed while I register or sign in, so that authentication does not destroy my invitation.
59. As an existing linked user, I want to validate a Join link after signing in, so that the Capsule can decide how to handle a mismatched account.
60. As a newly registered email user, I want to validate the Join link after registration, so that the Capsule can continue the invitation flow.
61. As a newly authenticated OAuth user, I want to validate the Join link after the provider callback, so that OAuth works without pre-binding the capability to an Anonymous session.
62. As a Capsule author, I want validation to return only a valid or invalid indicator, so that the browser does not learn why a capability failed.
63. As a Capsule author, I want validation not to consume or reserve the Join link, so that I retain control over what the app does next.
64. As a Capsule author, I want an invalid result for malformed, expired, revoked, consumed, or email-mismatched links, so that failure details are not an oracle.
65. As a Capsule author, I want Join-link email matching to consider emails attached to the current linked user, so that email and OAuth registration flows can both succeed.
66. As a Capsule author, I want email matching to be case-insensitive after normalization, so that equivalent addresses are treated consistently.
67. As a Capsule author, I want Sporades not to require a provider-verified email, so that verification policy remains a per-app decision.
68. As a Capsule author with stricter identity requirements, I want to apply my own verification policy before calling join, so that Sporades does not flatten provider-specific trust decisions.
69. As a Capsule author, I want a failed validation not to delete, disable, or otherwise mutate the newly created user, so that my app decides whether to retain or remove an account.
70. As a linked recipient with a matching email, I want to join the Team through the Join link, so that membership requires no administrator-side user lookup.
71. As a linked recipient, I want joining to repeat email and capability validation, so that an earlier valid indicator cannot bypass current state.
72. As a linked recipient, I want joining to consume the Join link atomically with membership creation, so that a link cannot be replayed.
73. As a linked recipient who is already a member, I want joining to be idempotent without granting roles, so that retries do not corrupt membership.
74. As an Anonymous user, I do not want to join a Team directly, so that durable membership belongs only to a linked account.
75. As a Team admin, I want Join links always to create an ordinary member, so that link possession cannot grant Team administration.
76. As a security reviewer, I want Join codes to be cryptographically unforgeable, so that Team IDs and expiry values cannot be edited by a caller.
77. As a security reviewer, I want Join codes stored only in non-recoverable form, so that a database read does not reveal usable outstanding links.
78. As a security reviewer, I want secret comparisons to use constant-time verification, so that invalid-code checks do not expose verifier information.
79. As a security reviewer, I want Join-link creation throttled and capacity-bounded, so that admins cannot accidentally or maliciously create unbounded runtime state.
80. As a security reviewer, I want expired Join-link records pruned through bounded work, so that cleanup cannot become an unbounded request-path scan.
81. As an operator, I want Join codes and complete Join URLs excluded from logs and diagnostics, so that inspection surfaces do not leak bearer capabilities.
82. As an operator, I want membership and role changes recorded as redacted structured security events, so that administrative activity can be investigated.
83. As a Team admin, I want to remove an ordinary member from my Team, so that access can be revoked.
84. As a Team admin, I want removal to delete the member's application-role assignments atomically, so that orphaned authority cannot survive membership.
85. As a Team admin, I want to promote another member to admin, so that Team administration can be shared.
86. As a Team admin, I want more than one admin to be supported, so that a Team is not dependent on one account.
87. As a Team admin, I want to revoke an admin's status when another admin remains, so that administrative authority can change safely.
88. As a Team admin, I do not want the last admin demoted or removed, so that a Team cannot become unmanageable.
89. As a Team admin, I want concurrent demotions and removals checked transactionally, so that two valid-looking actions cannot leave zero admins.
90. As a Team member, I want to leave a Team when I am not an admin, so that membership is voluntary.
91. As a Team admin, I want to be prevented from leaving while I remain an admin, so that leaving cannot bypass the last-admin invariant.
92. As a Team admin who wants to leave, I want to promote another member and demote myself first, so that the Team retains an administrator.
93. As a Team member, I want self-departure to use the explicit leave operation rather than admin removal, so that self-service and administrative actions remain distinct.
94. As a Team admin, I want member removal not to accept myself as a target, so that the leave rules cannot be bypassed through another method.
95. As a Team admin who is the sole member, I want to delete that Team explicitly, so that unused Teams need not persist forever.
96. As a Team admin, I do not want to delete a Team while other members remain, so that one admin cannot silently erase an active collaboration group.
97. As a runtime maintainer, I want Team creation and creator-admin membership committed together, so that no Team begins without an admin.
98. As a runtime maintainer, I want membership uniqueness enforced by persistent storage, so that concurrent joins cannot create duplicates.
99. As a runtime maintainer, I want Team state stored outside Capsule app schema, so that Capsule schema migrations cannot corrupt runtime authorization.
100. As a runtime maintainer, I want Team persistence to use the configured Database adapter, so that supported database engines retain behavioral parity.
101. As a runtime maintainer, I want removed Capsule role declarations to become inactive without granting access, so that deployment changes fail closed.
102. As a runtime maintainer, I want inactive stored role assignments excluded from public results and ACL success, so that undeclared roles have no authority.
103. As a runtime maintainer, I want adding a previously removed role declaration to restore its retained assignments, so that rollback does not destructively lose authorization state.
104. As a runtime maintainer, I want Team operations to use structured public errors and detailed redacted server diagnostics, so that clients remain stable and operators can investigate failures.
105. As a client developer, I want public TypeScript types for every Team operation and result, so that misuse is caught during development.
106. As a server developer, I want the same current-user Team behavior in trusted Capsule handlers, so that server workflows do not reimplement membership rules.
107. As a server developer, I want Team management unavailable from ACL evaluation, so that policy remains read-only.
108. As a server developer, I do not want ordinary Team administration confused with Privileged server role, so that userless system authority remains a separate actor concept.
109. As an AFK agent, I want Team behavior verified through public runtime seams, so that implementation details can change without invalidating the specification.
110. As an AFK agent, I want generated runtime and public type parity verified, so that Dev, Container, and Hosted Capsules do not ship a different Team contract.
111. As a documentation reader, I want Team, Team membership, Team admin, application role, and Join link defined consistently, so that future work uses one domain language.
112. As a documentation reader, I want examples showing explicit Team IDs in app data and ACL, so that built-in Teams are not mistaken for automatic data partitioning.

## Implementation Decisions

- A Team is scoped to one Capsule. Team identity, membership, roles, and Join
  links never cross Capsule storage or auth identity boundaries.
- Team functionality is built in and available by default. There is no
  `enabled` flag in Capsule or project configuration.
- Existing Capsule behavior remains unchanged unless Capsule code calls a Team
  interface or uses a Team ACL helper. `ctx.auth` does not gain a current Team,
  ordinary app data is not automatically assigned a Team, and DB/file reads
  are not automatically filtered by Team membership.
- Only linked, non-guest Sporades users may hold durable Team memberships.
  Anonymous sessions may inspect the safe public shape of a Join link but may
  not validate it as an account or join a Team.
- Every newly linked user receives one initial singleton Team in the same Auth
  transaction that establishes the linked account. That user receives the
  `admin` management role. Existing linked users receive the same initial Team
  lazily and idempotently on their first Team-interface operation.
- Initial-Team creation is recorded independently from current membership, so
  deleting or leaving Teams later does not repeatedly recreate an initial
  Team.
- A linked user may create additional Teams and may be a member of any bounded
  number of Teams. Every new Team and its creator-admin membership are created
  atomically.
- A Team has a stable opaque ID, bounded display name, creation metadata, and
  no authorization meaning attached to its name.
- There is no implicit or persisted current-Team selection. Every Team-scoped
  operation accepts an explicit Team ID. A Capsule may keep UI selection in
  its own state or current-user preferences.
- A Team membership contains exactly one runtime-owned management role,
  `admin` or `member`, and zero or more application-role assignments.
- The management role governs Team and membership administration only. It does
  not itself grant access to Capsule app rows, files, storage, handlers, or
  application operations.
- Capsule server definition may declare a bounded vocabulary of application
  Team roles. Role identifiers use a stable lowercase identifier grammar;
  `admin`, `member`, Sporades-reserved prefixes, duplicates, malformed values,
  and excessive counts fail Capsule loading with a structured error.
- Application roles belong to one Team membership, not directly to a user or
  globally to the Capsule. One membership may hold multiple declared roles,
  and the same user may hold different roles in different Teams.
- Team admins modify application roles through one atomic update operation
  containing bounded `add` and `remove` sets. The runtime rejects overlap,
  undeclared roles, non-members, and unauthorized callers.
- Join-link acceptance grants `member` with an empty application-role set.
  Join links cannot grant `admin` or application roles. An admin assigns those
  roles through a separate deliberate operation after membership exists.
- Removing an application role from the Capsule declaration deactivates that
  role immediately. Retained assignments for an undeclared role provide no
  ACL authority and are omitted from normal public membership results. They
  remain stored so a rollback or deliberate reintroduction restores the prior
  assignment rather than destructively losing state. Renaming a role is a
  remove-and-add operation and does not migrate assignments automatically.
- The browser-facing `teams` interface uses the existing Sporades client
  transport and structured result envelope. Its operations cover listing the
  caller's Teams and own memberships, creating and renaming Teams, listing
  memberships as an admin, creating/listing/revoking Join links, inspecting
  and validating a Join link, joining, updating application roles, promoting
  or demoting admins, removing a member, leaving, and deleting an eligible
  Team.
- Trusted Capsule handler contexts expose a `ctx.teams` interface with the same
  current-user authorization semantics. It does not provide a bypass for
  arbitrary membership changes.
- Privileged server role remains separate from Team admin and application
  roles. A browser cannot carry Privileged server role, and `ctx.privileged`
  does not turn an ordinary user into a Team admin.
- ACL evaluation gains constrained read-only Team helpers for membership,
  management role, one application role, and any of a bounded role set. The
  helpers are reachable through the existing ACL context, return authorization
  decisions, expose no runtime tables, and cannot mutate Team state.
- Team ACL helpers follow the established ACL async-helper discipline and
  participate in the existing denial and logging behavior. Team support does
  not alter allow-by-default behavior when no ACL rule is declared.
- Team-aware app tables and file paths remain Capsule-defined. Capsule authors
  store explicit Team IDs on their domain rows or in their file-policy model
  and invoke Team ACL helpers deliberately.
- `teams.list()` returns only Teams containing the current user and includes
  the caller's own management role, active application roles, and enough
  bounded membership-count state for a UI to hide singleton Team chrome.
- Reading the caller's own membership does not permit enumeration of other
  members. `listMembers(teamId)` is admin-only and proves that the caller is a
  current admin of that exact Team before returning results.
- Safe member results contain stable user ID, display name, optional picture,
  management role, and active application roles. They omit email credentials,
  provider subjects, Session details, and identities.
- Every admin action rechecks current membership and admin status inside the
  transaction performing the change. A stale browser view never authorizes an
  operation.
- A Team must always retain at least one admin while it exists. Promotion,
  demotion, removal, leave, and deletion rules enforce that invariant under
  concurrency rather than through a prior count followed by an unrelated
  write.
- Any Team admin may promote an ordinary member. An admin may be demoted or
  removed only if another admin remains. Multiple admins are supported.
- `removeMember` cannot target the current caller. A user removes themselves
  only through `leave`, and `leave` rejects callers who remain admins.
- Membership removal and leave atomically remove active and inactive
  application-role assignments for that membership and immediately remove ACL
  authority.
- Team deletion is explicit and allowed only when the caller is the Team's
  sole member and admin. It removes the Team and its outstanding Join-link
  state atomically. It does not delete the Sporades user or app-domain data.
- Creating a Join link requires a Team ID, normalized target email,
  integer `ttlSeconds`, and the Capsule's validated same-origin Join path. The
  runtime supplies a documented safe TTL default when omitted and clamps or
  rejects values outside documented minimum and maximum bounds.
- Join-link construction uses the canonical Capsule origin established by the
  runtime and a Capsule-declared same-origin absolute path with a safe default.
  Request `Host`, forwarded-host, and origin headers do not determine the URL,
  and browser input cannot supply an external return URL.
- Sporades returns the complete Join URL and expiry to the creating admin but
  never sends an email or other message. The Capsule owns delivery, content,
  routing UI, and any persistence of delivery outcomes.
- A Join link is a short-lived, revocable, single-use bearer capability. Its
  versioned opaque code includes a random selector/verifier and an
  HMAC-authenticated binding to the Join-grant identity and expiry. The runtime
  uses a persistent per-Capsule signing secret, stores only non-recoverable
  verifier material plus grant state, and compares verifier/signature material
  in constant time.
- Persistent Join-grant state includes its Team, normalized target email,
  creating admin, creation and expiry times, consumption state, and revocation
  state. The complete code and URL are never stored in recoverable form or
  emitted to logs.
- Active Join-link listing is admin-only and returns bounded management
  metadata without returning or reconstructing the secret code. Revocation is
  admin-only, idempotent, and cannot affect links for another Team.
- Join-link creation is throttled per admin and Team, outstanding links are
  capacity-bounded, and expired-state pruning performs bounded work. Exact
  defaults and caps are implementation constants documented in the public
  contract and tested at their edges.
- Join-link inspection may return only bounded safe Team presentation state,
  expiry, and whether the link is generally usable. It never returns the full
  target email, membership lists, creator identity, verifier state, or failure
  details useful as an oracle.
- `validateJoinLink(code)` is a non-consuming browser operation intended for
  use after registration or sign-in. It returns only `{ valid: boolean }` in
  the normal structured result envelope. Infrastructure failures remain normal
  structured errors; malformed, unknown, expired, revoked, consumed,
  email-mismatched, and unauthorized capabilities return `valid: false`.
- Join-link validation requires a linked current user and compares the grant's
  normalized target email against normalized email credentials and Provider
  identity emails belonging to that Sporades user. It does not trust an email
  supplied by the browser at validation time.
- Sporades checks email equality only. It does not require, infer, persist, or
  enforce a provider-level or mailbox-level verified-email policy for Teams.
  A Capsule with stronger identity requirements performs its own policy checks
  and decides whether to call `join`.
- A false validation result has no side effects. Sporades does not delete or
  disable an account, remove provider identities, consume the link, create a
  membership, or send a message. Account lifecycle decisions remain outside
  the Team module.
- `join(code)` is the authoritative consuming operation. In one transaction it
  revalidates code integrity, grant existence, expiry, revocation, consumption,
  linked-user status, normalized email match, Team existence, and existing
  membership before inserting membership and consuming the grant.
- A successful join returns the committed membership. A retry by the same
  already joined user is idempotent and cannot add roles. A used link cannot
  add a different user.
- User-driven Team administration produces redacted structured runtime
  security events rather than Privileged audit events. Events include operation,
  Team identity, acting user, target user where applicable, and bounded
  outcome/error code, but never Join codes, full Join URLs, Session tokens,
  provider subjects, or raw request payloads.
- Runtime-owned Team state is outside app schema and `ctx.db`. It is created
  and migrated beside other runtime-owned auth-adjacent storage through the
  shared Database adapter contract, with behavioral parity across every
  supported engine.
- All multi-write Team workflows have explicit Transaction boundaries.
  Creation, joining, role mutation, promotion/demotion, member removal, leave,
  link consumption/revocation, and deletion either commit their complete
  outcome or leave prior state intact.
- Public Team interfaces, generated runtime output, public server/client types,
  documentation, and bundled execution remain in parity. Dev sessions, local
  Container sessions, and Hosted Capsules run the same Team behavior.
- The existing roadmap's separate Capsule-roles candidate is reconciled with
  this feature for Team-scoped application roles. A future role model outside
  Team membership requires a distinct demonstrated use case rather than
  duplicating this membership-scoped authority.

## Testing Decisions

- Good tests exercise externally observable behavior through the highest
  available seam and avoid asserting private SQL, helper call order, or module
  layout. Storage-level tests are reserved for adapter conformance, migrations,
  and concurrency invariants that cannot be proven reliably through one client
  request.
- The primary browser seam starts a real Capsule runtime, connects through the
  existing client transport, and drives the public `teams` interface. It proves
  result envelopes, current-user authorization, multi-client identity, Join
  flow, Team management, and persistence without calling runtime internals.
- The trusted-server seam invokes `ctx.teams` from real query, mutation,
  Custom endpoint, App message, middleware, hook, and supported Job contexts
  where the interface is promised. It proves identical current-user authority
  rather than testing a duplicate server implementation.
- The ACL seam declares real app tables and file/storage policy using Team
  helpers, then exercises reads and writes through normal DB and file APIs. It
  proves that membership, admin status, and application roles affect only
  explicitly Team-aware ACL rules and that non-Team Capsules remain unchanged.
- Initial-Team tests cover new email linking, new OAuth linking, existing-user
  lazy creation, idempotent retries, Auth-transaction rollback, Anonymous
  sessions, and the rule that later leave/delete operations do not repeatedly
  bootstrap another initial Team.
- Team-creation tests cover stable IDs, bounded names, creator admin assignment,
  multiple Teams per user, users belonging to multiple Teams, transaction
  rollback, and supported Database adapter parity.
- Membership-visibility tests prove that ordinary members see only their own
  memberships, admins list only Teams they administer, an admin of Team A
  cannot enumerate Team B, and safe results omit emails and provider/session
  data.
- Management-role tests cover promotion, multiple admins, allowed demotion,
  rejection of last-admin demotion/removal, self-removal rejection, non-admin
  leave, admin leave rejection, and deletion only by a sole-member admin.
- Concurrency tests deliberately race two admin demotions/removals and prove
  that at least one admin remains. These tests run at the Database adapter
  Transaction seam where deterministic interleaving is possible, then retain
  at least one full public-seam regression.
- Application-role tests cover declaration validation, reserved identifiers,
  multiple roles, different roles in different Teams, atomic add/remove,
  unauthorized assignment, undeclared-role rejection, join-with-no-roles,
  membership-removal cleanup, declaration removal failing closed, and rollback
  reactivation.
- ACL tests cover `isMember`, `isAdmin`, `hasRole`, and bounded any-role checks
  for true and false cases; async helper discipline; opaque denial behavior;
  structured diagnostic logs; and the absence of mutation/runtime-table access
  from ACL context.
- Compatibility tests boot existing representative Capsules without Team
  declarations or Team calls and prove unchanged auth shapes, queries,
  mutations, DB ACL, file behavior, and generated client behavior.
- Join-code tests cover entropy shape, HMAC tampering, selector/verifier
  mismatch, constant-time comparison seam, non-recoverable storage, expiry
  boundaries, single use, revocation, idempotent revocation, replay, redaction,
  bounded outstanding capacity, throttling, and bounded expiry pruning.
- Link-construction tests prove use of canonical Capsule origin, validated
  same-origin Join path, rejection of external or malformed paths, and
  indifference to attacker-controlled Host/forwarding/origin headers.
- Join-email tests cover required creation email, normalization, casing,
  whitespace, email credential matches, OAuth Provider identity matches,
  accounts with multiple linked identities, mismatches, absent provider email,
  Anonymous sessions, and the explicit absence of any verified-email
  requirement.
- Validation tests prove that inspection/validation do not consume or reserve a
  link; every ordinary invalid condition returns only `valid: false`; target
  email and failure reason are not revealed; and a later join still rechecks
  every condition.
- Join transaction tests cover successful membership plus consumption, failure
  rollback, same-user retry, concurrent redemption, redemption by a different
  matching or non-matching user, deleted Team, revoked/expired capability, and
  the guarantee that no management or application role is granted.
- No-email tests configure SMTP and provider webhooks as well as no mail at all,
  then prove that Team operations never call mail delivery or emit an Email
  event. Returning a Join link is the complete Sporades delivery behavior.
- Security-event tests assert event identity and outcomes through structured
  log inspection while proving that Join secrets, full URLs, target emails,
  Session tokens, provider subjects, and raw payloads are redacted.
- Type tests cover valid client, server-context, Capsule role-declaration, and
  ACL usage plus compile-time rejection of malformed operations and role names
  where the type system can express them.
- Generated-runtime tests build the shipped runtime and repeat representative
  browser, server-context, and ACL flows so source-only behavior cannot pass.
- Documentation tests assert the canonical distinction between Team admin,
  Team membership application roles, Capsule ACL, and Privileged server role;
  the lack of automatic data partitioning; no Team UI or email delivery; and
  email-match rather than verified-email enforcement.
- Prior art includes runtime-owned current-user preferences tests for public
  client transport and identity persistence, auth transaction and OAuth tests
  for linking, runtime-owned Password Reset code tests for non-consuming
  verification and capability redaction, DB/storage ACL tests for constrained
  helper evaluation, file public-URL tests for TTL/revocation behavior, and
  Database adapter conformance suites for portable runtime-owned persistence.

## Out of Scope

- Any Sporades-provided Team, member-management, role-management, registration,
  login, or Join-link UI.
- Sending invitation email, selecting a mail provider, supplying invitation
  copy, recording delivery outcomes, or reconciling provider events.
- Requiring or enforcing verified email addresses. A Capsule may impose its
  own policy before joining.
- Adding mailbox verification to email/password registration or changing the
  trust semantics of existing OAuth provider email claims.
- Automatically deleting or disabling a newly registered account after an
  invalid Join-link result.
- Automatically assigning Team IDs to Capsule app rows, files, or storage
  resources.
- Automatically filtering queries, mutations, App messages, Journey delivery,
  or file reads merely because Team membership exists.
- An implicit current-Team selector in auth state, server context, browser
  local storage, or runtime-owned preferences.
- Join links that grant Team admin or application roles.
- Untargeted, reusable, unlimited-use, or non-expiring Join links.
- Admin approval queues, membership-request queues, public Team discovery, or
  open membership requests. The specified Join link grants direct membership
  after validation.
- Global Teams or membership shared across Capsules or Host servers.
- Global roles on Sporades auth users, platform-operator roles, or any expansion
  of Privileged server role.
- Dynamic creation or deletion of the Capsule's application-role vocabulary by
  Team admins. Role vocabulary is declared by Capsule server code.
- Fine-grained custom permissions beyond the declared role labels and Capsule
  ACL rules.
- Real-time Team/membership subscriptions in the first implementation. Calls
  return committed state; Capsules refresh Team views explicitly.
- Billing, Team ownership transfer as a separate concept, organization
  hierarchy, nested Teams, Team-to-Team membership, or cross-Team inheritance.
- Automatic migration of app-domain rows from user ownership to Team ownership.
- Deleting or rewriting app-domain data when a membership leaves or a Team is
  deleted.

## Further Notes

- The agreed public test/interface seams are the existing client transport for
  browser operations, normal trusted handler contexts for server operations,
  and the existing constrained ACL context for authorization. These are the
  highest established seams that cover the feature without inventing a second
  transport or exposing runtime tables.
- “Built in” means always available and runtime-owned, not automatically
  applied. A one-user Capsule can ignore the Team module completely; a
  Team-aware Capsule deliberately stores Team identity in its own domain model
  and declares how membership affects access.
- “Email validation” in this specification means normalized equality between
  the Join grant and an email already attached to the current linked Sporades
  user. It deliberately says nothing about mailbox ownership or provider-level
  verification. That policy belongs to the Capsule.
- Team admin is a membership-management role. Application roles describe the
  Capsule's domain. Privileged server role remains userless system authority.
  Keeping all three names distinct is a security property, not vocabulary
  ornamentation.
- This specification supersedes the roadmap's previously separate shape where
  generic Capsule roles and Teams for ACL were independent candidates, for the
  membership-scoped roles covered here.
