# Add authenticated endpoint behavior

Status: ready-for-agent

## What to build

Make custom endpoints participate in the same anonymous and linked-account auth model as queries and mutations. Requests to endpoints should be able to resolve the current session and expose the resulting auth state through `ctx.auth` so endpoints can safely read and write session-owned data.

## Acceptance criteria

- [ ] Endpoint requests can resolve an existing anonymous session when the client sends the Sporades session token.
- [ ] Endpoint requests can resolve linked authenticated users when Google OAuth mode is configured.
- [ ] `ctx.auth` in endpoint handlers matches the documented auth context shape.
- [ ] Endpoint handlers can use `ctx.auth.userId` to read and write session-owned rows.
- [ ] Missing or invalid session tokens have a documented behavior and do not crash the server runtime.
- [ ] Auth behavior is covered for both Dev sessions and Container sessions.

## Blocked by

- .scratch/sporades-v1/issues/08-expose-endpoint-context-and-structured-responses.md
