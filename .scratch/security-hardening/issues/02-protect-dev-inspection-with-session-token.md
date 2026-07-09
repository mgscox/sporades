Status: done

# Protect Dev Inspection Routes With A Per-Session Token

## What to build

Protect Dev session inspection routes with an unguessable inspection token generated when the Dev session starts. CLI inspection commands should read the token from Dev session state and send it automatically, while browser requests without the token cannot read logs, inspect database state, run inspection SQL, or simulate local auth identities.

## Acceptance criteria

- [ ] Starting a Dev session creates an unguessable per-session inspection token and records it in Dev session state.
- [ ] All Dev inspection routes require the inspection token through a dedicated request header.
- [ ] CLI commands that inspect logs, database state, or local auth simulation send the token automatically.
- [ ] Requests without the token or with an invalid token fail without exposing inspection data or mutating local identity state.
- [ ] Tests cover successful CLI inspection, rejected unauthenticated browser-style requests, and token rotation across Dev session restarts.

## Blocked by

None - can start immediately
