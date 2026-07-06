Status: ready-for-agent

# Nearest-Neighbor Query API

## Parent

.scratch/sqlite-vector-extension/PRD.md

## What to build

An ergonomic nearest-neighbor query surface on the existing table query API:
given a probe vector, a vector field, and k, return the top-k rows ordered by
distance, with distances included, and a metric option where the extension
supports it. Results respect the established post-fetch filtering semantics
so vector reads can be scoped (e.g. to the current user's rows) consistently
with ADR 0022. No raw SQL is exposed to app code.

## Acceptance criteria

- [ ] A nearest-neighbor query on a vector field returns at most k rows ordered by ascending distance.
- [ ] Each result carries its distance alongside the row data.
- [ ] A metric option is honored where the loaded extension supports it, with a structured error for unsupported metrics.
- [ ] Vector query results pass through the same post-fetch read filtering semantics as ordinary reads.
- [ ] Malformed probe vectors (wrong dimension or element type) fail with a structured error.
- [ ] TypeScript types cover the query surface.
- [ ] Capsule-session tests use small fixed vectors with hand-computable distances to assert ordering, distances, and k bounds end-to-end.
- [ ] Docs show a complete semantic-search example through `ctx.db`.

## Blocked by

- .scratch/sqlite-vector-extension/issues/01-vector-field-storage-and-extension-load.md
