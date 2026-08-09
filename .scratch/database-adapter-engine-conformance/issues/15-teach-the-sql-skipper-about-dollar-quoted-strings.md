Status: done

# Teach The SQL Skipper About Dollar-Quoted Strings

## What to build

`skipSqlStringOrComment` recognises `'`, `"`, backtick and `[` as quoting, but not
Postgres dollar quoting (`$$…$$`, `$tag$…$tag$`) or E-strings (`E'…\'…'`). Two
callers depend on it, and both inherit the blind spot.

`validateReadOnlyInspectionSql` is the pre-existing one: `SELECT $$a;b$$ AS s` is
rejected on all three engines today, because the semicolon inside the literal
reads as a statement separator.

Issue 11 added the second. Postgres's `columns()` primitive strips a trailing
terminator before wrapping the caller's SQL in a subquery, using the same
skipper. A `--` or `/*` inside a dollar-quoted or E-string literal is read as
trailing trivia and the strip cuts there, severing the literal:

    SELECT $$a--b$$ AS s    ->  SELECT $$a      ->  unterminated dollar-quoted string

Issue 11's reviewer established the bounds carefully, and they matter for
priority. The failure is **never silent** — truncation always severs a literal
opener, so the wrap is always a syntax error rather than a wrong answer. A
1156-input sweep comparing the described shape against the actual result found
zero mismatches. And it is **not a parity regression**: a 42-input battery across
all three engines at the pre-seam base and after found the same six divergent
inputs, because SQLite parses `$$a` as a bind parameter and was already answering
differently. What changed is that Postgres moved from quietly right to loudly
wrong on inputs where the other engines were already quietly wrong.

So this is a real gap worth closing, not an urgent one. Teaching the skipper
about dollar quoting and E-strings fixes both call sites at once, which is why it
belongs in one issue rather than as a patch to either.

## Acceptance criteria

- [x] The skipper recognises dollar-quoted strings, including tagged forms, and E-strings.
- [x] A read-only inspection query containing a semicolon inside a dollar-quoted literal is accepted rather than rejected.
- [x] A query containing `--` or `/*` inside a dollar-quoted or E-string literal answers identically on SQLite, libSQL and Postgres, or the remaining difference is recorded as a genuine dialect divergence with its reason.
- [x] The statement-injection surface is unchanged: no second statement can be smuggled past the validator, demonstrated by test.
- [x] Cases fail against the current skipper.

## Blocked by

- None — can start immediately.
