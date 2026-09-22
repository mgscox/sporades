# Prerender render modules

A configured Vite prerender module default-exports a zero-argument function
returning an HTML string or a promise of one. Modules are trusted build code;
Sporades does not supply a Server runtime, Database, Session or Server-env context.

JavaScript and TypeScript code imports are bundled for Node execution. CommonJS
helpers retain their module-relative location and require behavior, including
`module.filename`, `module.id`, and `module.path` for the original source helper.
TypeScript helper module kind is detected after stripping types; CommonJS `.ts`
and `.tsx` helpers receive the same module-local wrappers as `.cjs` helpers.
Direct `module.require()` calls preserve locality, literal code dependencies and
method reassignment alongside ordinary `require()`.
ESM `import.meta.url` refers to the source module. Each renderer executes in a fresh,
disposable Worker so cached dependencies and global state cannot carry over from
the CLI or previous builds. Workers provide lifecycle isolation, not a security
sandbox; trusted code retains filesystem and network access.

Use literal import specifiers, including `import("./helper.mjs")` when asynchronous
loading is useful. Computed dynamic imports such as `import(variable)` fail the
build with an explicit diagnostic: their source-module resolution cannot be
preserved by the bundled evaluator. Express the supported choices with explicit
imports instead.
Direct CommonJS `eval()` is also rejected because string-hidden code cannot retain
the owning module's wrapper bindings through bundling. Use explicit code instead.
Renderer-only CSS, image or other asset output is unsupported;
assets used by static HTML must already belong to the ordinary Vite client graph.

Computed CommonJS `require(variable)` supports CommonJS dependencies only.
Runtime `require()` of ESM is disabled in the renderer Worker because Node's
CommonJS cache does not expose the ESM descendants needed for reliable Dev
watching. Use a literal import or require for ESM dependencies so the bundler can
track their complete code graph. This restriction is consistent across supported
Node releases.

Fragment HTML must be valid for its marker's document context. The build checks
the parsed DOM without rewriting the emitted HTML: content moved outside its
handover boundaries by HTML parsing fails with a placement diagnostic. For
example, render rows at a marker inside a table, not a `div` or plain text that
the browser would move before the table. Markers inside inert `template` content
are not supported. Valid implicit table wrappers remain supported.
Close fragment-created elements explicitly: an omitted optional closing tag can
leave a fragment ancestor spanning its end boundary, which also fails validation.
Fragments also cannot add attributes to the author-owned html or body roots
through parser-ignored document tags. Reserved boundaries are checked using the
HTML parser, including bogus declarations that become browser comments.
Fragments cannot close an author-owned ancestor or leave behind a fragment-only
implicit wrapper after dismissal. Put sole static table rows in an author-owned
`tbody`; implicit `tbody` is supported when author rows independently require it.
