Status: done

# Replace Query-String Session Tokens With Page-Bound Connection Tokens

## What to build

Remove session-token transport from URLs. The initial served page should establish a page-bound connection token that the client runtime can send when opening the WebSocket. The server should validate that token during initial WebSocket connection handling before associating a Sporades session. Custom endpoints should accept session tokens through headers only.

## Acceptance criteria

- [ ] Client runtime no longer places Sporades session tokens in WebSocket query strings.
- [ ] Server-side WebSocket connection handling validates a page-bound connection token before activating or associating the session.
- [ ] Custom endpoints no longer accept `sessionToken` from query strings and continue to accept the documented session-token header.
- [ ] Existing auth, query subscription, mutation, file, preference, and App message flows continue to work through the updated transport.
- [ ] Regression tests prove session tokens do not appear in generated WebSocket URLs, private file URLs, public file URLs, or accepted endpoint query strings.

## Blocked by

- .scratch/security-hardening/issues/01-enforce-configured-origin-checks.md
