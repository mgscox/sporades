# Add a guestbook template

Status: needs-triage

## What to build

Add a `guestbook` template inspired by the Lakebed guestbook example. The template should demonstrate a shared feed, server-owned authorship, bounded text input, and auth-aware UI behavior.

## Acceptance criteria

- [ ] `sporades create <name> --template guestbook` creates a runnable guestbook app.
- [ ] The server defines an `entries` table with body, author ID, author name, and author picture fields.
- [ ] The entries query returns the newest entries first and limits the shared feed to a reasonable number of rows.
- [ ] The sign mutation trims input, rejects empty input, bounds entry length, and stores author metadata from `ctx.auth`.
- [ ] The client UI uses Sporades auth, query, and mutation APIs without importing auth provider SDKs.
- [ ] Anonymous sessions can create entries, and provider-linked sessions display richer author metadata when available.
- [ ] Guestbook includes a visible Google sign-in path that exercises the real redirect-based provider auth flow.
- [ ] Guestbook is used as the live-site acceptance test for Google authentication.
- [ ] After Google sign-in, guestbook entries use richer author metadata from `ctx.auth`.
- [ ] Guestbook uses `ctx.auth.picture` when available.
- [ ] Guestbook does not add avatar uploads as a template dependency.
- [ ] Template docs call out that trusted author fields must come from the server, not from client-submitted input.

## Reference

- Lakebed guestbook example: https://docs.lakebed.dev/examples/guestbook/

## Blocked by

- .scratch/sporades-v2/issues/02-support-new-template-selection-and-blank-default.md
