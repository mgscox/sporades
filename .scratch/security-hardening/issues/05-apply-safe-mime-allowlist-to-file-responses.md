Status: done

# Apply A Safe MIME Allowlist To File URL Responses

## What to build

Serve uploaded file bytes with a safe MIME allowlist for both private and public File URL responses. Known safe inline types may keep their declared content type; every non-allowlisted, executable, ambiguous, missing, or unknown type should be rewritten to `application/octet-stream` before response headers are sent.

## Acceptance criteria

- [ ] Private File URL responses preserve only allowlisted safe MIME types.
- [ ] Public File URL responses use the same MIME allowlist behavior as private File URLs.
- [ ] Dangerous or ambiguous types such as HTML, SVG, XML, missing type, and unknown type are returned as `application/octet-stream`.
- [ ] Existing safe raster image and plain text flows remain usable where intentionally allowlisted.
- [ ] Tests cover private and public File URLs for allowlisted and rewritten MIME types.

## Blocked by

None - can start immediately
