Status: done

# Build The Server Bundle From A Module Graph

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

A deployed Capsule boots from a server bundle produced by esbuild from ordinary imports,
and behaves identically to the bundle produced by stringifying a list of functions.

This is the expand half of an expand–contract sequence. Nothing moves out of the runtime
module and nothing is deleted. The existing emitted-list path stays exactly as it is, and
both bundles are built, so the new one can be shown equivalent before anything depends on
it.

esbuild is already a direct dependency and already builds the CLI binary and the client
pipeline, so this introduces no new tooling — it applies tooling the repo already trusts
to the one artifact still assembled by string concatenation.

The deliverable is the proof, not the switch. A bundle that boots is not evidence; a
bundle that boots and answers identically across the runtime's real surfaces is. The
generated bundle carries config, sealed server env, the Capsule module as a data URL and
the runtime's own source text, so equivalence has to be established over behaviour rather
than over bytes — the two bundles will not be textually identical and are not expected to
be.

Treat the possibility that `toString()` was chosen for a reason as a live question rather
than a settled one. A deployed Capsule may need to be self-contained with no
`node_modules` resolution at runtime, and if some constraint of that kind exists, this is
the ticket that surfaces it — while the old path is still in place and nothing has been
migrated on the assumption that the answer is no. Record what you find either way.

Scope is the server runtime bundle only. The client bundle pipeline already builds with
esbuild and is not part of this problem.

## Acceptance criteria

- [ ] The server bundle can be built from a module graph with esbuild, alongside the existing emitted-list bundle rather than replacing it.
- [ ] A Capsule built the new way boots and serves, demonstrated by the existing bundle-booting suites running against it.
- [ ] Behavioural equivalence between the two bundles is demonstrated across the runtime's real surfaces — HTTP, auth, jobs, schedules, file storage and the database adapters — not asserted from the fact that both boot.
- [ ] The constants the preamble currently serializes carry identical values and types in the new bundle, checked by evaluating them rather than by diffing text.
- [ ] Whether a self-containment or runtime-resolution constraint motivated the original approach is established and written down, including a negative finding.
- [ ] The existing bundle remains the one that ships at the end of this ticket; no deployment path changes.
- [ ] The client bundle pipeline is untouched.

## Blocked by

- None — can start immediately.
