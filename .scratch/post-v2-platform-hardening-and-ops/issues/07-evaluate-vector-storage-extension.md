# Add SQLite vector extension support

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Add narrow support for loading the SQLite vector extension for AI tasks. This
should preserve Sporades' SQLite-first data model: the runtime downloads or
locates the appropriate `sqlite-vector` release artifact and loads it with
SQLite extension loading, rather than introducing a second database engine.

The app-facing schema also needs a `Blob()` field builder so Capsules can store
embedding bytes or other binary values in normal app tables.

The extension is not only a loaded binary plus `BLOB` storage. It also has a
small SQL lifecycle that Sporades should either document clearly or wrap with a
thin helper API:

- initialize a vector column with `vector_init(table, column, options)`,
- choose vector type, dimension, and distance metric,
- optionally quantize and preload quantized data,
- run nearest-neighbor scans through `vector_quantize_scan(...)`.

## Acceptance criteria

- [ ] `Blob()` is available as a schema field builder and maps to SQLite `BLOB`.
- [ ] The runtime can load a configured SQLite extension during Capsule startup.
- [ ] The design records how `sqlite-vector` release artifacts are downloaded, cached, verified, and selected per platform.
- [ ] The design defines how Capsules declare vector columns that need `vector_init`, including type, dimension, and distance metric options.
- [ ] The design records whether vector initialization runs automatically during schema setup or remains an explicit app/server call.
- [ ] The design covers quantization and preload behavior, including whether these are manual operations, startup hooks, or CLI/runtime-managed tasks.
- [ ] The design includes the intended nearest-neighbor query shape, either as documented SQL or a thin server-side helper around `vector_quantize_scan`.
- [ ] Dev sessions, Container sessions, and Hosted Capsules have defined behavior when the extension is missing, unsupported, or fails to load.
- [ ] Startup failures use structured errors with actionable hints.
- [ ] The design identifies any app-facing vector helper APIs without coupling the core table API to one vector library prematurely.
- [ ] The design records migration and hosting implications for `Blob()` fields and loaded extensions.
- [ ] v2 does not add vector storage unless maintainers explicitly promote this marker.

## Notes

The earlier MySQL wording was a typo. The intended shape is SQLite extension
support, initially proven with `sqlite-vector`.
