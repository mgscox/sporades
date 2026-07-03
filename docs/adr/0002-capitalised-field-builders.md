# Capitalised field builders: String() and Boolean()

Status: Accepted

Sporades field type builders use capitalised names (`String()`, `Boolean()`)
instead of lowercase (`string()`, `boolean()`). TypeScript's `string` and
`boolean` are reserved primitive type keywords - using them as function names
causes compilation errors and conflicts in type signatures.

The capitalised convention now covers the implemented field builders:
`String()`, `Boolean()`, `Number()`, `Date()`, `Json()`, and `Reference()`.
Future field builders should keep using the same convention.
