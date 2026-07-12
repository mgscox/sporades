# Add a guestbook template

Status: done

## What to build

Add a `guestbook` template. The template should demonstrate a shared feed, server-owned authorship, bounded text input, and auth-aware UI behavior.

## Acceptance criteria

- [x] `sporades create <name> --template guestbook` creates a runnable guestbook app.
- [x] The server defines an `entries` table with body, author ID, author name, and author picture fields.
- [x] The entries query returns the newest entries first and limits the shared feed to a reasonable number of rows.
- [x] The sign mutation trims input, rejects empty input, bounds entry length, and stores author metadata from `ctx.auth`.
- [x] The client UI uses Sporades auth, query, and mutation APIs without importing auth provider SDKs.
- [x] Anonymous sessions can create entries, and provider-linked sessions display richer author metadata when available.
- [x] Guestbook includes a visible Google sign-in path that exercises the real redirect-based provider auth flow.
- [x] Guestbook is used as the live-site acceptance test for Google authentication.
- [x] After Google sign-in, guestbook entries use richer author metadata from `ctx.auth`.
- [x] Guestbook uses `ctx.auth.picture` when available.
- [x] Guestbook does not add avatar uploads as a template dependency.
- [x] Template docs call out that trusted author fields must come from the server, not from client-submitted input.

## Blocked by

- .scratch/sporades-v2/issues/02-support-new-template-selection-and-blank-default.md
