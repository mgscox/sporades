Status: ready-for-agent

# Keep preferences coherent across auth and connected clients

## Parent

.scratch/user-preferences-table-and-sdk/PRD.md

## What to build

Make current-user preferences behave coherently across the existing
runtime-owned auth lifecycle and multiple connected clients. Preferences set
during an Anonymous session should remain attached when that session links a
provider account, reads should reflect the current session after auth changes,
and connected clients for the same user should be able to observe or refresh to
the latest preference object after an update.

## Acceptance criteria

- [ ] Preferences created during an Anonymous session remain available after the session links to an email or Google account.
- [ ] Preference reads follow the current resolved auth state after sign-in, sign-out, provider linking, or local identity simulation where supported by the test harness.
- [ ] Two connected clients for the same user can converge on the updated preference object after one client updates preferences.
- [ ] Preference updates for one user are not visible to another user's connected client.
- [ ] Tests cover auth lifecycle behavior through existing auth/session helpers rather than direct table mutation.
- [ ] Docs explain how preferences interact with Anonymous sessions and linked accounts.

## Blocked by

- .scratch/user-preferences-table-and-sdk/issues/01-persist-current-user-preferences-through-client-sdk.md
