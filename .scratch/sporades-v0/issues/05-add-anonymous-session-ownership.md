# Add anonymous session ownership to todos

Status: done

## What to build

Make the todo data path session-owned. Every visitor should receive a persistent anonymous session managed by the server, the session token should be sent by the client transport on WebSocket connection, and todo queries/mutations should use `ctx.auth.userId` to isolate each anonymous account's data.

## Acceptance criteria

- [ ] Anonymous auth is the default when `auth.mode` is unset or set to `anonymous`.
- [ ] The server initializes Better Auth with the Anonymous plugin and a SQLite-backed session store without exposing Better Auth to app client code.
- [ ] The client transport stores a session token in `localStorage` and sends it on WebSocket connection.
- [ ] `ctx.auth` is populated for queries and mutations with `userId`, `displayName`, `email`, `picture`, `isAuthenticated`, `isGuest`, and `provider`.
- [ ] Todo queries only return rows owned by the current anonymous session.
- [ ] Todo mutations write `ownerId` from `ctx.auth.userId`, not from client-provided data.
- [ ] Reloading the browser preserves the anonymous session and its todos.

## Blocked by

- .scratch/sporades-v0/issues/04-run-todo-query-mutation-loop.md
