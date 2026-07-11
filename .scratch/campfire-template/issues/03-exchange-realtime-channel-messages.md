# 03 — Exchange realtime channel messages

**What to build:** Turn the seeded Campfire shell into a working multi-user chat. Distinct Musketeers can select a channel, read its history, send bounded messages, and see new messages arrive in realtime with authorship derived from the authenticated server context.

**Blocked by:** 02 — Seed and switch between the four Musketeers.

**Status:** ready-for-agent

- [ ] Channel selection displays only that channel's messages in chronological order and remains stable when unrelated realtime data changes.
- [ ] A signed-in Musketeer can send a non-empty bounded message to the selected channel.
- [ ] Empty and whitespace-only messages are rejected with a clear user-visible outcome and create no durable record.
- [ ] Oversized messages are rejected at the server boundary and create no durable record.
- [ ] Message authorship is derived from `ctx.auth`; client-submitted data cannot impersonate another Musketeer.
- [ ] Each displayed message includes safe author presentation and its creation time.
- [ ] A message sent in one isolated browser session appears in another subscribed session without polling or page reload.
- [ ] Messages in other channels do not appear in the selected channel's feed.
- [ ] Reloading or reconnecting restores durable message history independently of Journey state.
- [ ] The generated Capsule uses public schema, query, mutation, auth, and client subscription surfaces rather than private runtime APIs.
- [ ] Integration coverage runs at least two isolated authenticated client sessions and proves message convergence and authorship enforcement.
- [ ] The generated Campfire Capsule continues to install and build from a clean scaffold output.
