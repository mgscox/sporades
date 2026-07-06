# User Preferences Table and SDK

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "User preferences table and SDK")

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

## Problem Statement

Capsule authors who need durable per-user preferences currently have to create
their own app tables, queries, mutations, and client wiring for a very common
platform concern. That duplicates boilerplate across Capsules, makes preference
behavior inconsistent, and forces authors to decide how preferences should
interact with Anonymous sessions, linked accounts, sign-in flows, and connected
clients.

Sporades already owns runtime auth, session identity, transport, and runtime
storage. User preferences belong beside that runtime-owned user state so app
authors can store UI and behavior preferences without reinventing identity-aware
persistence.

## Solution

Sporades provides a runtime-owned current-user preferences store and a small
client SDK surface for reading and updating it. Client code can update JSON
preferences for the current user through a high-level SDK call, and can read
the current preference object through the same client transport that already
carries auth state, query subscriptions, mutations, file operations, and App
messages.

Preferences are scoped to the current Sporades user identity. Anonymous-session
preferences survive provider linking because linked accounts attach to the
existing anonymous account. Preference updates are persisted in runtime-owned
storage and are visible to connected clients for the same current user.

## User Stories

1. As a Capsule author, I want a built-in current-user preferences store, so that I do not need to create an app table for common UI settings.
2. As a Capsule author, I want preferences to be runtime-owned, so that app schema changes do not accidentally break platform preference behavior.
3. As a client developer, I want to read the current user's preferences from `sporades/client`, so that UI can initialize from durable settings.
4. As a client developer, I want to update preferences with a partial JSON object, so that settings screens can save only changed values.
5. As a client developer, I want preference updates to return the next preference object, so that UI can update without a second manual fetch.
6. As a Capsule visitor, I want preferences set during an Anonymous session to persist, so that my local choices are not temporary guesses.
7. As a Capsule visitor, I want preferences to follow me when I link an email or Google account, so that signing in does not reset my app experience.
8. As a signed-in user, I want my preferences to be tied to my Sporades user identity, so that the same account sees the same settings across sessions.
9. As a user with multiple connected clients, I want preference changes to become visible across those clients, so that settings do not drift between tabs or devices.
10. As a Capsule author, I want preferences to use JSON values, so that I can store simple settings without adding a schema migration for every option.
11. As a Capsule author, I want preference values to be per-user, so that one user's settings cannot leak into another user's session.
12. As a Capsule author, I want the SDK to expose TypeScript types, so that client misuse is caught early.
13. As a runtime maintainer, I want preferences stored in runtime-owned tables, so that they can be inspected, migrated, and backed up with other runtime state.
14. As a runtime maintainer, I want preference writes to use the existing database transaction behavior, so that partial updates are not persisted after failures.
15. As an AFK agent, I want preference behavior verified through the existing client-session seams, so that Dev session, Container session, and Hosted Capsule behavior stays aligned.
16. As a documentation reader, I want the preferences API documented as the canonical path, so that new Capsules do not copy obsolete custom preference patterns.

## Implementation Decisions

- Add a runtime-owned user preferences store keyed by Sporades user identity, not by provider account or browser token.
- Preferences are JSON-compatible values. The first API supports merging a partial object into the current preference object rather than replacing the whole record by default.
- The client SDK exposes current-user preference read and update operations from `sporades/client`.
- Preference reads and updates travel over the existing Sporades client transport rather than introducing a separate browser endpoint.
- Preference writes are authenticated by the current session token and resolve against the same runtime-owned auth state used by queries, mutations, file operations, and App messages.
- Anonymous-session preferences are attached to the current anonymous account and therefore survive provider linking under the existing auth model.
- Preference updates notify connected clients for the same current user through the existing transport fan-out machinery where practical.
- Preference storage is runtime-owned and does not appear in Capsule app schema, `ctx.db` app tables, or app migrations.
- Public errors use the existing structured client error conventions. Detailed runtime diagnostics stay in server logs.
- The feature should work in Dev sessions, local Container sessions, and Hosted Capsules because all three run the same bundled runtime code over the same persisted runtime data model.

## Testing Decisions

- Good tests should exercise external behavior through the highest available seam: start a Capsule session, connect through the client transport, read preferences, update preferences, and observe persisted results.
- Tests should avoid asserting private table names or internal SQL details except where a runtime-owned migration/unit seam already exists for system storage.
- Preference update tests should assert partial merge behavior, JSON round-tripping, structured error handling, and TypeScript-visible SDK shape.
- Auth interaction tests should cover Anonymous sessions, provider-linked sessions where the existing harness supports them, and sign-in/session changes without directly mutating internals.
- Connected-client tests should use the existing websocket/client transport harness to assert that another connected client for the same user can observe or refresh to the updated preference object.
- Prior art includes existing auth client tests, websocket query/mutation tests, runtime-owned auth storage tests, and file SDK tests that verify client-facing behavior rather than implementation details.

## Out of Scope

- Preference ACL rules beyond current-user ownership.
- Team, organization, or Capsule-wide preferences.
- Schema-typed preference definitions or validation beyond JSON compatibility.
- Server-side preference helper APIs for Capsule handlers.
- Preference conflict resolution beyond last successful write.
- UI components for preference screens.

## Further Notes

- Keep the feature small and boring. This is a platform convenience, not a
  general settings framework auditioning for a keynote.
- If implementation discovers that connected-client live updates are too large
  for the first slice, the first slice may expose a refreshable read path and
  leave push-style propagation to the second issue.
