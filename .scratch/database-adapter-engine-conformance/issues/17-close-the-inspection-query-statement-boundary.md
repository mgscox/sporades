Status: done

# Close The Inspection Query Statement Boundary

## What to build

**A live SQL injection in `sporades db query`.** Found while reviewing issue 15,
reproduced independently by the coordinator against PostgreSQL 16.14. It is
pre-existing — present before issue 15 and unchanged by it — and it is not
theoretical:

    SELECT 1 AS s; -- x<CR> TRUNCATE TABLE <table>

The validator admits it and the table is emptied. Confirmed by execution: a
canary table went from one row to zero. `DO $z$ … EXECUTE 'DELETE FROM …' … $z$`
works the same way.

Two independent failures line up to make it reachable, and both want fixing.

**The comment terminator disagrees with the engine.** A `--` comment is ended
with `indexOf("\n")` in both `skipSqlStringOrComment` and `skipSqlTrivia`.
Postgres ends a line comment at CR *or* LF — its lexer spells `non_newline` as
`[^\n\r]`. Everything after a bare CR is therefore trivia to the validator's walk
and a fresh statement to the engine. The strip cuts at the visible `;`, so the
`columns()` wrap parses cleanly, and `all()` then hands the raw multi-statement
string to Postgres's simple query protocol, which executes all of it.

**The side-effect keyword scan is a denylist with holes.** `TRUNCATE`, `DO`,
`SET`, `COMMENT`, `COPY` and `CALL` are all absent from
`SIDE_EFFECT_SQL_KEYWORDS`, so even the second line of defence waves the payload
through. A denylist that must enumerate every destructive verb in three SQL
dialects is the wrong shape for a security boundary; `DO` alone is arbitrary
code execution and no list will stay complete.

Fix the terminator so the walk agrees with the engine about where a comment ends
— check the same disagreement for other whitespace and trivia the engine treats
as a line ending, since CR is unlikely to be the only one. Then decide what the
keyword scan is actually for: if it is a security boundary it should be an
allowlist of the read-only shapes the runtime intends to permit, not a denylist
of the destructive ones it happens to remember; if it is a convenience check,
something else has to be the boundary.

Worth stating for whoever picks this up: the reason a single tokenizer bug
becomes remote code execution is that the boundary rests on the validator alone.
The engines differ here — SQLite and libSQL structurally refuse to prepare past a
first statement, so they are unaffected, while Postgres's simple query protocol
executes everything it is given. Consider whether the Postgres path should stop
handing multi-statement strings to that protocol at all, which would make the
class unreachable rather than merely patched.

## Second symptom: unpaired surrogates fold on the wire

Also found in issue 15's review, contained and not currently exploitable, but the
same species — the skipper's model of the engine's lexing diverging from the
engine.

The dollar-quote tag class is a UTF-16 code-unit range, so unpaired surrogates
count as tag characters. Node folds every unpaired surrogate to U+FFFD on the
wire, so two tags that differ in JavaScript can be byte-identical to Postgres,
and Postgres can close a literal earlier than the skipper does. Issue 15's
reviewer replayed 56,000 fold shapes through the adapter: all refused, canary
alive, `all()` never reached — because whenever the skipper hides a `;` the strip
becomes the identity and the `columns()` wrap then fails to parse. So it is held
shut by an accident of the wrap rather than by intent, which is worth closing
deliberately while the terminator work is open.

## Acceptance criteria

- [ ] `SELECT 1 AS s; -- x<CR> TRUNCATE TABLE t` is refused, demonstrated by a test that fails against the current code with a live canary table.
- [ ] The walk agrees with the engine on where a line comment ends, for every character the engine treats as a line ending.
- [ ] Other trivia and whitespace handling is audited for the same class of disagreement, not just CR.
- [ ] A decision is recorded about the keyword scan: allowlist, or explicitly demoted to a convenience check with the real boundary named.
- [ ] No second statement reaches any engine, demonstrated by a canary battery on all three.
- [ ] The surrogate-fold case is refused by intent rather than by the wrap's parse failure.
- [ ] Issue 15's dollar-quote and E-string behaviour is unchanged; its cases stay green.

## Blocked by

- None — can start immediately.

## Comments

Superseded and completed by
`.scratch/runtime-bundle-module-boundaries/issues/01-one-sql-tokenizer-with-an-explicit-dialect-profile.md`.

Five worker rounds against this ticket produced a branch that was never merged; all
four of its independent reviews returned REQUEST_CHANGES, and the last revision was
unreviewed when that swarm stopped. Rather than discard it, ticket 01 merged that
branch as its first commit and collapsed the duplicated walkers on top, so the work
finally received an independent review as part of ticket 01's own.

Every acceptance criterion above is met and verified by execution on SQLite, libSQL
and Postgres: the CR-terminated line comment, nested and `/*/`-straddled block
comments, line/block composition, the dollar-quote keyword-scan blinding, unpaired
surrogates and NUL are all refused — by the validator with its own reason, not by an
engine syntax error. Measured against the pre-work base the change closes 291 real
Postgres offenders and admits nothing new.

Two items raised here are deliberately **not** closed and want their own tickets:
`splitSqlStatements`, a lexer of the same class gating libSQL's multi-statement
`exec` path; and the `PRAGMA writable_schema` gap in the side-effect keyword belt,
which is pre-existing and unchanged. `postgresInterpolate` remains a second run
lexer on the inspection path, recorded in ADR-0038 with the identity-or-throw
property the gate depends on asserted rather than argued.
