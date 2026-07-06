Status: ready-for-agent

# Vector Field Storage and Extension Load

## Parent

.scratch/sqlite-vector-extension/PRD.md

## What to build

End-to-end vector storage on the SQLite Database adapter: a vector field kind
with a declared dimension in the Capsule schema vocabulary, a vector value
helper (the PRD's `Blob()` shape) that validates dimension/element type and
encodes for BLOB storage, and adapter initialization that enables extension
loading, loads the chosen SQLite vector extension, and disables further
loading — only when the schema declares vector usage. Select the extension
artifact (npm-distributed prebuilt; `sqlite-vec` is the leading candidate) as
part of this slice. Rows with embeddings round-trip through normal mutations
and reads. Non-SQLite adapters reject vector declarations with a structured
error. Additive migrations can add a vector field to an existing table.

## Acceptance criteria

- [ ] A Capsule schema can declare a vector field with a fixed dimension.
- [ ] The vector extension loads at SQLite adapter initialization only when vector usage is declared; extension loading is disabled immediately after.
- [ ] Capsules without vector fields keep today's database initialization behavior exactly.
- [ ] The vector value helper validates dimension and element type, failing writes fast with a structured error.
- [ ] Embeddings written through normal mutations round-trip through normal reads, in Dev sessions and local Container sessions.
- [ ] Declaring a vector field on a non-SQLite adapter produces a structured, engine-named error.
- [ ] Adding a vector field to an existing table works via the additive-migration path.
- [ ] `sporades db` inspection commands still work on tables with vector columns.
- [ ] The chosen extension installs as an npm prebuilt with no compiler toolchain, in both `sporades dev` and the Container base image.
- [ ] Adapter-seam tests cover load, round-trip, validation, and the non-SQLite error; docs cover the field kind and helper.

## Blocked by

None - can start immediately
