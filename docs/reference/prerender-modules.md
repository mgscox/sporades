# Prerender render modules

A configured Vite prerender module default-exports a zero-argument function
returning an HTML string or a promise of one. Modules are trusted build code;
Sporades does not supply a Server runtime, Database, Session or Server-env context.

JavaScript and TypeScript code imports are bundled for Node execution. CommonJS
helpers retain their module-relative location and require behavior. ESM
`import.meta.url` refers to the source module. Each renderer executes in a fresh,
disposable Worker so cached dependencies and global state cannot carry over from
the CLI or previous builds. Workers provide lifecycle isolation, not a security
sandbox; trusted code retains filesystem and network access.

Use literal import specifiers, including `import("./helper.mjs")` when asynchronous
loading is useful. Computed dynamic imports such as `import(variable)` fail the
build with an explicit diagnostic: their source-module resolution cannot be
preserved by the bundled evaluator. Express the supported choices with explicit
imports instead. Renderer-only CSS, image or other asset output is unsupported;
assets used by static HTML must already belong to the ordinary Vite client graph.

Fragment HTML must be valid for its marker's document context. The build checks
the parsed DOM without rewriting the emitted HTML: content moved outside its
handover boundaries by HTML parsing fails with a placement diagnostic. For
example, render rows at a marker inside a table, not a `div` or plain text that
the browser would move before the table. Markers inside inert `template` content
are not supported. Valid implicit table wrappers remain supported.
