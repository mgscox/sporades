# 01 — List the current user's initial singleton Team

**What to build:** Give every existing linked Sporades user an initial runtime-owned singleton Team on first Team-interface use, with that user as its admin, and let the user list only their own Teams through the browser and trusted server interfaces. Capsules that never use Teams must retain their existing behavior.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A linked user with no Team bootstrap history receives exactly one initial Team and one `admin` membership when first using the Team interface.
- [ ] Initial-Team creation and creator-admin membership commit atomically and are idempotent across repeated and concurrent calls.
- [ ] Initial-Team creation is recorded independently from current membership so later Team deletion or departure cannot repeatedly bootstrap another initial Team.
- [ ] Anonymous users do not receive durable Teams or memberships and receive a stable structured denial from linked-user-only operations.
- [ ] The browser Team interface lists only Teams containing the current user and returns the caller's own management role, active application roles, safe Team presentation state, and bounded membership-count state.
- [ ] The trusted server Team interface exposes the same current-user list behavior and authorization semantics from supported handler contexts.
- [ ] Team state is runtime-owned, absent from Capsule app schema and normal `ctx.db`, and persisted through the configured Database adapter.
- [ ] Team IDs are stable opaque values and the initial Team receives a bounded presentation name without deriving authorization from that name.
- [ ] Existing auth result shapes, query and mutation behavior, file behavior, App messages, and ACL behavior remain unchanged when a Capsule does not call Team interfaces.
- [ ] There is no enablement flag and no implicit current-Team value in auth, server context, transport state, or current-user preferences.
- [ ] Public client and server types describe the delivered interface and reject unsupported or malformed calls.
- [ ] Tests exercise the public client transport and trusted handler context, cover persistence and restart behavior, and include a representative non-Team Capsule compatibility regression.
- [ ] The generated runtime carries the same singleton and listing behavior as the source runtime.
