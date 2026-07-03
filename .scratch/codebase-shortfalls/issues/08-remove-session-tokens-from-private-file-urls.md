# Remove session tokens from private file URLs

Status: done

## What to build

Stop putting Sporades session tokens into private file URLs. Private file reads should authenticate through a non-URL mechanism such as an SDK-managed request header, while preserving the app-facing `files.url()` or `files.download()` ergonomics as much as possible.

The completed slice should prevent private file session tokens from appearing in browser history, access logs, referrers, copied URLs, or screenshots.

## Acceptance criteria

- [ ] Private file reads no longer require or return URLs containing the session token.
- [ ] `files.download(fileId)` continues to download files owned by the current user.
- [ ] Unauthorized, missing, deleted, expired, or stale-version private file reads still return `404 Not Found` or structured SDK errors as appropriate.
- [ ] Public file URLs keep working without session credentials.
- [ ] Tests verify that generated private file URLs or SDK-visible paths do not contain the session token.

## Blocked by

None - can start immediately
