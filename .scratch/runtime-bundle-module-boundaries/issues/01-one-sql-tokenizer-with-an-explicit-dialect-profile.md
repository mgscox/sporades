Status: ready-for-agent

# One SQL Tokenizer With An Explicit Dialect Profile

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

`sporades db query` decides whether a statement is read-only by walking its text. Today
that walk exists twice. `skipSqlStringOrComment` knows the union of the three engines'
quoting — including Postgres's dollar quoting and E-strings — and serves the validator
and the terminator strip. `skipSqlLiteralOrComment` knows neither Postgres form and
serves the side-effect keyword scan. The two share their block-comment and line-comment
logic verbatim and then diverge.

**The divergence is deliberate and security-critical, and it is recorded only in a prose
comment.** Withholding dollar quoting from the keyword scan is what keeps
`SELECT $$a; DROP TABLE t$$ AS s` refused: Postgres reads that as one literal, while
SQLite and libSQL have no dollar quoting and read a real second statement. The comment
calls it "a belt this walk cannot give them."

An invariant that lives in a comment can be violated by an edit that looks obviously
correct, and was. A change that ended line comments at a carriage return — right for
Postgres, and applied to both walkers because they looked like the same function —
destroyed the asymmetry. Nothing failed, because no type, parameter or test encoded it.
The same family of defect then recurred four more times, each fix landing in one walker
and leaving its sibling.

Replace the two functions with one tokenizer that takes the engine differences as an
argument. What a comment terminates at, whether dollar quoting and E-strings are
recognised, and which identifier-quoting forms exist become fields of a profile the
caller passes, not the difference between two function bodies. The keyword scan asks for
the profile that withholds the Postgres forms, and asks for it visibly.

Note the constraint this ticket works inside rather than against: a runtime function
cannot call a helper unless the helper also travels into the generated bundle. One
function taking a parameter needs no helper, so this is achievable today. The wider fix
is the rest of this feature.

Establish the real set of walkers before collapsing them. The two named above are the
pair that caused the defects, but the validator region also contains token readers and a
trivia skipper that encode overlapping lexical assumptions, and a fix that leaves a third
copy in place has not removed the class.

## Acceptance criteria

- [ ] One tokenizer serves every consumer in the read-only inspection path; no second function re-implements where a comment, string or quoted identifier ends.
- [ ] The engine differences are an explicit argument. Reading a call site tells you which dialect profile it asked for, without reading a comment.
- [ ] `SELECT $$a; DROP TABLE t$$ AS s` and its tagged and `CREATE TABLE` variants stay refused, demonstrated against a live canary on SQLite, libSQL and Postgres.
- [ ] The profile that withholds the Postgres forms is covered by a test that fails if a future edit widens it, so the invariant is enforced rather than described.
- [ ] Every payload class already known to this work stays refused: nested and straddled block comments, carriage-return line comments, line-and-block composition, unpaired surrogates and NUL.
- [ ] No realistic query is newly refused. Measured against the pre-work baseline, not against the previous revision.
- [ ] Any sweep or property test used as evidence asserts that its corpus can actually emit the shapes it reports clean about, and runs against all three engines rather than Postgres alone.

## Blocked by

- None — can start immediately.
