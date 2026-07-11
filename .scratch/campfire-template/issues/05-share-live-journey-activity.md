# 05 — Share live Journey activity

**What to build:** Make Campfire the complete User journey tracker exemplar. Visitors can explicitly share privacy-safe current activity, observe channel reading and expiring typing indicators, and understand multiple live sessions through a global “What's happening” panel without exposing message content or surveillance data.

**Blocked by:** 03 — Exchange realtime channel messages.

**Status:** ready-for-agent

- [ ] Campfire declares the runtime-owned User journey tracker through the public Capsule declaration.
- [ ] Activity publication remains off until the visitor affirmatively selects “Share my activity”.
- [ ] Campfire remains fully usable for chat when Journey sharing is disabled.
- [ ] The consent UI states what semantic activity is shared and explicitly states that draft text, message text, raw URLs, query strings, email addresses, passwords, message IDs, and keystrokes are not shared.
- [ ] Revoking consent calls the public disable behavior and removes the current connection's live Journey state immediately.
- [ ] Selecting a channel publishes a bounded `reading` state with only the safe channel slug when consent is enabled.
- [ ] Editing the composer publishes and renews a bounded `typing` state for the selected channel at a controlled cadence.
- [ ] Typing state expires shortly after input stops and does not require a durable offline or stopped-typing record.
- [ ] Sending or clearing a draft replaces typing with safe channel-reading activity.
- [ ] Reaction activity, if published, contains only a semantic status and safe channel slug, never the target message or reaction record identifier.
- [ ] The global panel consumes the public Journey subscription's initial snapshot and subsequent additions, replacements, expirations, and removals.
- [ ] The panel maps runtime user identity to safe Musketeer presentation without extending Journey records with email or provider profile data.
- [ ] Multiple live Journey sessions for one user remain visible rather than being overwritten as one stored presence record.
- [ ] A late-joining observer immediately sees all unexpired current activity.
- [ ] Reload, reconnect, disable, and auth-transition behavior matches ADR 0031 and the existing Journey contract; Campfire adds no private resume or impersonation path.
- [ ] Automated assertions inspect every Campfire-published Journey record and prove forbidden draft, message, credential, identity, identifier, and raw-location data is absent.
- [ ] Integration coverage uses at least two isolated sessions to prove consent gating, reading, typing renewal, TTL expiry, snapshot convergence, disablement, and identity-transition retirement.
