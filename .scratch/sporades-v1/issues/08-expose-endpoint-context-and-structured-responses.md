# Expose endpoint context and structured responses

Status: done

## What to build

Make custom endpoints useful by giving endpoint handlers access to the same server-owned context concepts as queries and mutations, plus a documented response shape. Endpoint handlers should be able to read request data, use `ctx.db`, `ctx.auth`, `ctx.env`, and `ctx.log`, and return structured HTTP responses.

## Acceptance criteria

- [ ] Endpoint handlers receive a context that includes `ctx.db`, `ctx.auth`, `ctx.env`, and `ctx.log`.
- [ ] Endpoint handlers can read method, path, headers, query parameters, and request body data.
- [ ] Endpoint handlers can return status, headers, and body in a documented structured response format.
- [ ] Endpoint handlers can use the table API to read and write Capsule data.
- [ ] Endpoint responses work consistently in Dev sessions and Container sessions.
- [ ] Invalid endpoint responses fail with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v1/issues/07-add-minimal-http-endpoint-path.md
