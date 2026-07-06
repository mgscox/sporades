# SQLite Vector Extension Support

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "SQLite vector extension support")
- `docs/adr/0021-database-adapter-is-internal-runtime-boundary.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

## Problem Statement

Capsule authors building search, recommendation, or AI-assisted features need
to store embeddings and run nearest-neighbor queries. Today the default SQLite
runtime has no vector support, so authors must bolt on an external vector
store — extra infrastructure that defeats the local-first, zero-service
default and has no Sporades-managed lifecycle.

## Solution

The SQLite Database adapter can load the SQLite vector extension at
initialization when a Capsule declares vector usage. Capsule authors declare a
vector field in their schema like any other field kind, write embeddings
through normal mutations using a vector value helper, and run nearest-neighbor
queries through a small ergonomic query API. Quantization and preload behavior
are configurable for larger datasets. Everything stays inside the existing
`ctx.db` model — no external service, no raw SQL.

## User Stories

1. As a Capsule author, I want to declare a vector field (with a fixed dimension) in my table schema, so that embeddings are a first-class column.
2. As a Capsule author, I want to insert and update rows with embedding values through normal mutations, so that vector writes go through the same API and transactions as other data.
3. As a Capsule author, I want a vector value helper (the roadmap's `Blob()` shape) that validates dimension and encodes values for storage, so that malformed embeddings fail fast with a structured error.
4. As a Capsule author, I want a nearest-neighbor query API that returns the top-k rows for a probe vector ordered by distance, so that I can build semantic search without SQL.
5. As a Capsule author, I want distances returned alongside rows, so that I can threshold or display relevance.
6. As a Capsule author, I want to choose the distance metric where the extension supports it, so that I can match my embedding model's training metric.
7. As a Capsule author, I want to configure quantization for vector columns, so that large collections stay compact on disk.
8. As a Capsule author, I want to configure preload behavior, so that hot vector data can be resident in memory for query latency.
9. As a Capsule author, I want vector reads to compose with ordinary row filters where feasible, so that I can scope search to the current user's rows.
10. As a Capsule author, I want a clear structured error if I declare vector usage while running on a non-SQLite Database adapter, so that unsupported engines fail loudly rather than silently misbehave.
11. As a Capsule author, I want the extension loaded only when my Capsule declares vector usage, so that Capsules without vectors keep today's locked-down database initialization.
12. As a Capsule author, I want vector behavior identical across Dev sessions and local Container sessions, so that production-like verification holds.
13. As a Capsule author, I want `sporades db` inspection commands to keep working on tables with vector columns, so that debugging is unchanged.
14. As an AFK agent, I want tests and docs that pin the vector API surface, so that I can build on it without reverse-engineering.

## Implementation Decisions

- Vector support lives inside the SQLite Database adapter behind the internal
  adapter boundary (ADR 0021). Code above the adapter stays engine-agnostic;
  non-SQLite adapters reject vector declarations with a structured error. No
  public adapter/plugin API is exposed.
- The extension is loaded at adapter initialization, and extension loading is
  enabled on the connection only when the Capsule schema declares vector
  usage; it is switched off immediately after loading. The concrete extension
  artifact (the roadmap's `sqlite-vector`; the maintained `sqlite-vec`
  distribution is the leading candidate) is chosen at implementation time and
  must be installable as an npm-distributed prebuilt so `sporades dev` and the
  Container base image need no compiler toolchain.
- Vector fields join the existing field-kind vocabulary with a declared
  dimension; storage is a BLOB column encoded by the vector value helper. The
  helper validates dimension and element type at write time.
- Nearest-neighbor queries are exposed as a small addition to the existing
  table query API (top-k for a probe vector, rows plus distances, metric
  option where supported). Read-path ACL and ownership filtering semantics
  follow the established post-fetch filtering approach from ADR 0022.
- Quantization and preload are per-field schema/configuration options with
  conservative defaults (no quantization, no preload). Their exact vocabulary
  is fixed during implementation of the third slice and documented.
- Schema migrations must handle adding a vector field to an existing table
  using the established additive-migration path.

## Testing Decisions

- Two existing seams, external behavior only:
  - The Database adapter test seam: extension loading, vector column
    round-trip, dimension validation, quantized storage, and the structured
    error on non-SQLite engines — prior art is the existing database-adapter
    test suite that runs the same assertions across adapters.
  - The capsule-session seam: a Capsule schema with a vector field exercised
    end-to-end over the Dev-session harness — write embeddings via mutations,
    run nearest-neighbor queries, assert ordering, distances, and k bounds —
    prior art is the existing Dev-session websocket tests.
- Good tests use small fixed vectors with hand-computable distances so
  ordering assertions do not depend on the extension's internals.

## Out of Scope

- Vector support on postgres or libSQL adapters (future adapter work).
- Managed embedding generation (calling embedding models is app code).
- ANN index tuning surfaces beyond the quantization/preload options above.
- Hosted Capsule rollout considerations beyond what the base image already
  provides; the extension artifact must simply be part of the release bundle
  dependency set.

## Further Notes

- Keep the vector helper name aligned with the roadmap's `Blob()` sketch
  unless implementation reveals a clearer name in the field-kind vocabulary;
  if renamed, update the roadmap wording when removing the item.
