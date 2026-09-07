# Restore multi-element query arguments

Status: implementation pending

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
