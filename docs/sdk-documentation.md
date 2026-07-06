# SDK Documentation

Sporades keeps three kinds of SDK documentation, each with a different job.

## Conceptual Guides

Use handwritten guides for workflows, product language, and architecture. The
user guide explains how to build a Capsule, run a Dev session, add auth, work
with files, and deploy locally or to a Host server.

Conceptual docs should use Sporades terms consistently: Capsule, Dev session,
Container session, Hosted Capsule, App message, File path, and Anonymous
session. They should explain when and why to use an API, not enumerate every
property in the SDK.

## Generated API Reference

The generated API reference is built from the public TypeScript declaration
files for `sporades/server` and `sporades/client`:

```sh
npm run docs:api
```

The generated output is written to `docs/api/`. It is the right place to look up
exported types, function signatures, result shapes, and short examples for the
public client/server SDK surface.

## Source Comments

Public SDK declarations use TSDoc-flavoured JSDoc comments. These comments
should focus on app-author-facing behavior: runtime constraints, important
Sporades terminology, security boundaries, and compact examples.

Avoid comments that only restate the TypeScript type. If a name and signature
already explain the shape, add a comment only when it clarifies behavior that an
app author could otherwise get wrong.
