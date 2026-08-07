# A deployed Capsule Bundle resolves nothing at runtime

The generated server Bundle must be able to import Node's own builtins and
nothing else. A Hosted Capsule runs `node /app/server.mjs` inside the Sporades
base image, which is `node:22-alpine` with no install step and no `node_modules`
anywhere, and a release mounts only `server.mjs`, `sporades.json` and the public
tree into `/app`, read-only. Nothing else is reachable, so a bare specifier left
in the Bundle is not a slow path or a fallback — it is a container that does not
start. This is why the Capsule module travels as a base64 `data:` URL rather
than as a second file beside the Bundle.

This is a self-containment requirement, not a requirement about how the Bundle
is produced. Assembling it from `Function.prototype.toString()` over
`SERVER_RUNTIME_SOURCE_FUNCTIONS` satisfied it by construction, because
concatenating source text resolves nothing — but so does bundling, provided the
output's only external imports are builtins. Building the Bundle from a real
module graph with esbuild is therefore compatible with the constraint, and
`createServerBundleModuleSource` enforces it from esbuild's metafile at build
time so that it holds by construction there too. A specifier that merely
*resolves* is not enough: a URL import resolves and builds cleanly, and would
still be a fetch from a read-only container.

No second constraint of this kind was found. The Bundle is written once and
read only as an opaque file: nothing inspects its text, no size limit applies to
it, the Host helper checks only that `server.mjs` is present, and
`sporadesServerSource` is carried as data for handler-source extraction rather
than executed as part of the graph. The one-shot inspection action (ADR-0028)
depends on the Capsule module staying unevaluated, which is a property of
loading it through a runtime value rather than a build-time literal, not a
property of how the runtime itself was assembled.

One consequence is easy to get wrong and does not exist under the `toString()`
mechanism at all: building from a graph means reading a file, so the builder has
to locate its own entry. `import.meta.url` is not a safe basis for that, because
`scripts/build-bin.mjs` bundles the CLI into `bin/sporades.js` and esbuild
rewrites `import.meta.url` for the entry point only — every other module in the
graph inherits the entry's. The entry is located by walking to the package root
instead, which is correct both when the CLI runs from `dist/` and when it runs
as the bundled binary.
