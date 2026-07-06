Status: ready-for-agent

# Persist current-user preferences through the client SDK

## Parent

.scratch/user-preferences-table-and-sdk/PRD.md

## What to build

Add the first end-to-end current-user preferences loop. A client should be able
to read the current user's preference object, update it with a partial JSON
object, receive the persisted next value, and observe the same value after a
runtime restart. The store is runtime-owned and scoped to the current Sporades
user identity rather than Capsule app schema.

## Acceptance criteria

- [ ] `sporades/client` exposes typed current-user preference read and update operations.
- [ ] Updating preferences merges a partial JSON object into the current user's stored preference object and returns the next value.
- [ ] Preferences are persisted in runtime-owned storage and survive runtime restart.
- [ ] Preferences are scoped to the current Sporades user identity and do not appear in Capsule app tables.
- [ ] Client-facing failures use the existing structured error shape.
- [ ] Documentation presents the SDK as the canonical way to store durable per-user preferences.
- [ ] Tests exercise the behavior through a real Capsule/client-session seam rather than private storage details.

## Blocked by

None - can start immediately
