# Restore multi-element query arguments

Status: complete

## Problem

The v0.9.17 server query argument validator uses an over-escaped digit pattern
in its array-index regex. Valid argument tuples with two or more elements, and
nested arrays with two or more elements, fail with `Invalid query arguments.`
before the handler runs. A single object without multi-element arrays works.
The generated browser validator has the correct escaping for its template.

## Required change

Correct the server regex without changing the browser template. Preserve rejection
of sparse arrays and non-index array properties, opaque validation errors, and
the existing JSON/UTF-8 size contract. Regenerate shipped runtime and CLI artifacts.

## Verification

Cover multiple arguments, nested arrays, indices above nine, and malformed arrays
through the server query entry point. Exercise the generated browser and actual
WebSocket subscription transport with multi-element arguments. Run build,
generated-artifact checks, focused tests, and the full suite.

## Implementation and verification

- Corrected the server digit regex; generated browser code was already correct.
- Regenerated runtime, CLI, source map, and source manifest.
- New server regression failed on the original two-argument case before the fix.
- Build/typechecking and generated-artifact validation passed.
- Focused server/browser suites: 60 passed. Actual WebSocket regression: 1 passed.
- Standards review: 0 findings. Spec review: 0 findings (implementation 0ec9795f).
- Full suite: 2,154 passed, 126 skipped, 2 failed. One failure is the SQL lexer
  census in `database-adapter-engine-seam.test.js`, reproduced identically on
  unchanged main (3da789a4). It detects `exactShellVocabularyToken` and
  `shellWordHasPathExpansion`, which are absent from its expected census.
- The other full-suite failure records termination of a stalled `teams.test.js`
  child after it stopped progressing at libSQL admission. The isolated admission
  case passed on both main and this branch. A complete bounded Team-file retry
  passed: 26 passed, 2 skipped. The full run therefore is not a clean green run.
