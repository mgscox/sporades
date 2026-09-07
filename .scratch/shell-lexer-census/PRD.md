# Document shell quote handlers in the SQL lexer census

Status: complete

The SQL architecture test deliberately scans all shipped runtime functions for
quote/comment delimiter handling. `exactShellVocabularyToken` and
`shellWordHasPathExpansion` screen uploaded text for Bash commands; neither is a
SQL parser. They are missing from the exact expected non-SQL exception list,
causing the architecture check to fail on main.

Add both functions to `RUN_LEXER_CENSUS` with their non-SQL purposes documented.
Update the stale introductory count to describe mixed-language detection without
a fixed count. Preserve the detector, exact-set comparison, module coverage, and
SQL tokenizer invariants. No runtime behavior or generated artifact change.

Verify the original failure, then run the database-adapter engine seam test file
and generated-artifact validation after the change.

## Verification

The original focused test failed before the change. After adding the two
purpose-documented entries, the full `database-adapter-engine-seam.test.js` file
passed: 25 passed, 5 PostgreSQL tests skipped because no test service was
configured. Generated-artifact validation and diff whitespace checks passed.
The detector and runtime source are unchanged.
