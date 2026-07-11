# 04 — React and protect the crown

**What to build:** Add durable, realtime thumbs-up and thumbs-down reactions to Campfire messages, making the seeded `#protect-the-crown` prompt playful and interactive without implying anonymous poll or election semantics.

**Blocked by:** 03 — Exchange realtime channel messages.

**Status:** ready-for-agent

- [ ] Every message can display thumbs-up and thumbs-down reaction totals.
- [ ] The current authenticated user can add either reaction through a server-authorized mutation.
- [ ] Repeating an active reaction removes that user's reaction rather than creating a duplicate.
- [ ] A user may hold one thumbs-up and one thumbs-down reaction on the same message; toggling one does not silently change the other.
- [ ] Durable state prevents duplicate rows for the same user, message, and reaction kind under repeated or concurrent requests.
- [ ] Clients cannot add, remove, or attribute a reaction as another user.
- [ ] Reaction totals converge across at least two connected browser sessions without polling.
- [ ] Reloading preserves reactions and their totals because they are durable Capsule data.
- [ ] The seeded `#protect-the-crown` channel contains a crown-protection prompt with the agreed “All for one” and “One more guard, perhaps” meanings.
- [ ] The UI calls these interactions reactions and does not claim anonymity, secrecy, poll closure, or winner semantics.
- [ ] Accessible labels communicate reaction kind, total, and current-user active state without relying on emoji or colour alone.
- [ ] Integration tests cover adding, removing, duplicate prevention, identity enforcement, and realtime convergence through public behavior.
