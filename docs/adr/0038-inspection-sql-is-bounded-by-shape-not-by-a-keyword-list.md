# Read-only inspection SQL is bounded by statement shape, not by a keyword list

`sporades db query` admits a string of SQL that a human typed and hands it to a
Database adapter. What keeps that from being arbitrary database access is three
rules, and the side-effect keyword list is not one of them.

**A statement shape.** The first token must be `SELECT`, `WITH`, or one of the
eight safe metadata PRAGMAs. This is an allowlist, it is closed, and it is where
every destructive verb is excluded — `TRUNCATE`, `DO`, `DROP`, `SET`, `COMMENT`,
`COPY`, `CALL`, and whatever the next dialect adds — not because each was
remembered but because none of them is one of the three shapes admitted.

**One statement.** The shape rule means nothing on its own, because a second
statement is a second first token that nothing checked. Postgres's simple query
protocol executes every statement in a multi-statement string, so what stands
between the shape rule and arbitrary execution is a tokenizer walk agreeing with
the engines about where a comment, a literal and whitespace end.

**Text the engine receives unchanged, and read the same way.** A validator can
only make a claim about the text the engine will see. Where the string the
runtime checks and the bytes the engine reads differ, the claim is void, so such
a string is refused. So is a string this walk and an engine would lex
differently, for the same reason one step later: the two rules above are claims
about tokens, and a claim about a token is worthless where the token boundary is
in dispute. The runtime then hands the engine the single statement the gate
accepted — `sqlWithoutTrailingTerminator(sql)` — rather than the raw input, so a
defect in the walk costs a wrong verdict rather than an executed second
statement.

The third rule is what makes the first one true rather than merely intended, and
it was added because the first one was measurably false without it. See "The
disagreements the walk has to close" below.

## Why the keyword scan is demoted rather than completed or replaced

The scan reads every token of an admitted statement and refuses it if a token
names a destructive verb or a side-effecting function. It was reachable as the
last line of defence, and it was treated as a security boundary. It is not one,
and the two obvious repairs both fail.

Completing the list fails because the list has no end. `DO` alone is arbitrary
server-side code execution, and the set of side-effecting *functions* an
expression can reach — `nextval`, `set_config`, `lo_import`, `dblink_exec`, and
whatever the next installed extension adds — grows outside this repository. A
list that must enumerate the destructive verbs of three SQL dialects is
guaranteed to be a list of the ones somebody remembered.

Turning it into an allowlist fails for a different reason: there is nothing to
allow. Inside a `SELECT`, the tokens are table names, column names and aliases,
which are arbitrary by construction. An allowlist over that alphabet is a SQL
parser, and a parser in the Database adapter would be a fourth opinion about
three engines' grammars — the thing this whole feature exists to stop having.

So the allowlist is placed where an allowlist can be closed: at the first token,
over the statement shapes. That rule was already in the code and already doing
this work; naming it is the change.

Two consequences follow, and both are deliberate. The verbs named in the issue
that opened this — `TRUNCATE`, `DO`, `SET`, `COMMENT`, `COPY`, `CALL` — stay out
of the keyword list. Every one of them is a legal column or alias name *inside*
an admitted statement, so listing them would refuse `SELECT comment FROM posts`
and buy nothing, while none of them can *begin* one. That second half is a claim
about where the first token is, it is worth exactly as much as the walk's
agreement with the engines about where the first token is, and the section below
is what makes it hold — it did not hold when this ADR was first written. And
`merge` was added, because it closes the one limb of the scan that genuinely is a
closed set: a data-modifying CTE, where Postgres allows `INSERT`, `UPDATE`,
`DELETE` and — from version 17 — `MERGE` inside a `WITH`, and `MERGE` was the only
one of the four missing. The version qualifier is load-bearing and was checked:
the conformance container is PostgreSQL 16.14, which answers `syntax error at or
near "RETURNING"` for a data-modifying `MERGE` CTE, so the limb is closed there
already and `merge` is protection against the engine a Hosted Capsule may be on
rather than the one the suite runs against. Adding it only ever refuses more, so
being early costs nothing but a column named `merge`.

What remains is defence in depth over what the three rules above already exclude.
The residual it does not close, stated plainly rather than left to be
rediscovered: a side-effecting function reached from an expression inside an
admitted `SELECT` is caught only by this list, and only if the function happens to
be on it.

## The disagreements the walk has to close

A tokenizer that models the engines' lexing is only as good as the model, and
there are two ways a disagreement bites. Text the walk treats as trivia and the
engine treats as content is a place to hide a `;`, which defeats the
one-statement rule. Text the walk treats as *content* and the engine treats as
*comment* is worse and less obvious: the walk then reads its first token out of
text the engine is commenting out, which defeats the statement-shape rule
outright. An earlier draft of this ADR asserted the second direction was merely a
false reject. That was wrong, and the error is left visible here because the
shape of the mistake is the useful part — "we see more than the engine" sounds
conservative right up to the point where what you do with what you see is decide
which statement this is.

Where the engines can be made to agree, the walk takes the *shortest* comment and
the *narrowest* whitespace any of them would take. Where they cannot, the input is
refused rather than guessed at — and whether they can is decided by computing both
readings and comparing them, not by recognising the text that usually means they
differ. Two attempts at the recognising version each shipped a hole.

**Line comments — closed by agreeing.** A `--` comment was ended at a line feed,
while Postgres ends one at a carriage return too; its lexer spells a comment's
body `[^\n\r]`. Everything after a bare CR was trivia to the walk and a fresh
statement to the engine, so `SELECT 1 AS s; -- x<CR> TRUNCATE TABLE t` passed the
gate and Postgres executed both halves; a canary table went from one row to zero.
Ending it at CR costs a false reject on SQLite, which reads on to the next LF,
and buys one verdict that is true on the strictest engine.

**Whitespace — closed by agreeing, on a measured set rather than a documented
one.** Whitespace was JavaScript's `\s`, which matches NBSP, U+1680, the U+2000
block, the line and paragraph separators, U+3000 and the BOM, every one of which
is an *identifier* character to Postgres. It is now `[ \t\n\r\f]`. Those five are
what the engines were observed to take: `SELECT<c>1 AS a` is accepted for each of
them on SQLite, libSQL and Postgres, and refused by all three for vertical tab —
`unrecognized token` on the first two, `syntax error at or near` on Postgres.
`\v` appears in Postgres's published `space` class and is not whitespace in
practice, so this set is the executed one and not the documented one. Getting
that wrong put the walk one character wider than every engine, in the direction
this section calls a security failure.

**Nested block comments — closed by refusing, on a derived test rather than a
described one.** Postgres nests `/*` inside `/*` and closes at the matching `*/`;
SQLite and libSQL close at the first `*/` and read on. The walk did not nest, so
`/*/* */ SELECT 1 */ TRUNCATE TABLE t` was a `SELECT` to the walk and a
`TRUNCATE` to Postgres, and all six of the verbs the section above says cannot
begin an admitted statement began one this way. Neither lexing can be adopted:
nesting opens the mirror hole, where a `;` inside a comment the walk swallows is a
real separator on the two engines that do not nest — confirmed by execution, those
two run the second statement while Postgres answers `unterminated /* comment`. So
the disputed input is refused.

*How* it is detected is the part worth recording, because two attempts to describe
the dangerous text both had blind spots. The first asked whether the comment
contained a `/*` at all. The second asked the same with the terminator trimmed
off, and missed `/*/` — where the nested opener's `*` is also the terminator's
`*`, so the opener straddles the point the string was cut at. `/* /*/ SELECT 1 */
*/ TRUNCATE TABLE t` was admitted by that rule and truncates the table when run.
A third description would very likely have had a third blind spot, and neither
reviewer nor author could enumerate the space.

So the test is derived from the property instead: run a nesting lexer over the
comment and compare where it ends against where the non-nesting walk ended, and
refuse when they differ. Equal means every engine closes the comment in the same
place; unequal means one does not, whatever the text looks like. That holds for
shapes nobody wrote down, which is what a pattern cannot do. The counter is
Postgres's own rule from `scan.l` — `{xcstart}` is `/*` and increments depth (the
trailing `{op_chars}*` is undone by `yyless(2)`), `{xcstop}` is `\*+\/` and
decrements it. An unterminated comment runs to end of input under both rules and
is therefore not a disagreement; every engine either errors on it or comments to
the end, so no second statement exists either way.

Measured over 167,958 comment-shaped inputs, executed raw against a live Postgres
past the `columns()` wrap, with both a canary table and a `CREATE TABLE` probe so
that any non-`SELECT` first token is observable and not only a destructive one:
the build before this change admitted 27,220, of which 268 had an effect a
`SELECT` cannot have. None of those 268 is admitted now. Of the 18,148 admitted
now, 2,646 are inputs the previous substring rule refused — the derived test is
more precise rather than merely stricter — and all 2,646 were executed the same
way with no observable effect.

That corpus was checked for adequacy before it was believed, and this is the part
a later reader should copy rather than the numbers. Both earlier rounds reported
zero findings from generators that could not emit the shape they were reporting
zero about: the first could not reach nesting depth, the second could not reach
the straddle. The generator is now asserted to contain the specific shapes that
defeated each previous round before any result from it is read, in the sweep and
in `test/database-adapter-engine-seam.test.js` alike. A sweep that cannot produce
the dangerous input answers clean for the wrong reason, and it did so twice here.

**Identifier alphabets — left open, deliberately.** The walk reads a bare
identifier as `[A-Za-z_][A-Za-z0-9_]*` where Postgres includes `$` and every
non-ASCII byte, so `select$x` is one identifier to the engine and the keyword
`select` here. That leans the permissive way, but the walk's token is always a
prefix of the engine's, and no SQL statement begins with a bare identifier, so
what the engine parses instead is a syntax error rather than a command. Recorded
so a later reader knows it was looked at rather than missed.

## Why refusing beats guessing

Three of the rules above are agreements and two are refusals, and the refusals are
the load-bearing idea rather than a fallback. The gate's verdict is a claim about
tokens. Where two engines put the token boundary in different places, there is no
verdict that is true of both, so answering at all is answering wrongly on one of
them. Refusing says so.

It also removes a dependence on luck that this ADR had already argued against in
one place and then quietly relied on in another. The nested-comment shape was not
executing before this change, because the Postgres `columns()` probe runs first
and its `SELECT * FROM (…) LIMIT 0` wrap fails to parse the admitted text. That is
the same accident the surrogate-fold case was refused for depending on — *a
boundary held shut by another component's syntax error is not a boundary* — and
it survives exactly as long as the two calls stay in that order, `columns()` keeps
wrapping, and no engine arrives with a native one. None of those three is a
property anybody promised.

## Why unrepresentable text is refused rather than tokenized around

A dollar-quote tag is spelled with Postgres's identifier alphabet, which in
JavaScript is a UTF-16 code-unit range, so an unpaired surrogate counts as a tag
character. Node encodes every unpaired surrogate as U+FFFD on the wire. Two tags
that differ here are therefore one tag to Postgres, which closes a literal the
walk reads straight through — hiding a `;` the engine will honour. A NUL is the
same fault from the other side: it terminates the string Postgres reads off the
wire, so every character checked after it is never seen there.

The narrow fix would be to spell the tag alphabet as scalar values rather than
code units. The refusal is preferred because it closes the class rather than the
instance: any future rule in this walk that reads a character the wire will not
carry has the same defect, and no query a human meant to write contains an
unpaired surrogate or a NUL. It also replaces an accident with an intent. These
inputs were already being refused, but only because hiding a `;` makes the
terminator strip the identity, and the raw multi-statement text then fails to
parse inside the Postgres `columns()` wrap. A boundary held shut by another
component's syntax error is not a boundary.

## Why the Postgres path still uses the simple query protocol

The obvious structural answer is for Postgres to stop accepting multi-statement
strings at all, by moving to the extended query protocol, which parses one
statement per message. It is not taken here. The Postgres engine interpolates
parameters into statement text and issues every statement — not only inspection
queries — over the simple query protocol; converting it is a rewrite of the
engine's statement primitives and its parameter binding, and it belongs to
whoever does that rather than to a tokenizer fix.

What is taken instead is the narrower form of the same idea:
`runReadOnlyInspectionQuery` prepares the statement the gate accepted rather than
the text the human typed. `sqlWithoutTrailingTerminator` stops at the first
separator the walk sees, so a multi-statement string can only reach the engine if
the walk failed to see the separator at all — the same condition under which the
verdict was already wrong. This does not make the class unreachable the way the
extended protocol would; it removes the second, independent failure that turned a
wrong verdict into an executed statement, and it makes the Postgres `columns()`
probe and the following read run identical text instead of two different strings.

Running the inspection query inside `withReadOnlySnapshot` was considered as the
engine-enforced boundary, and rejected on a specific hazard rather than on scope.
All three engines share one connection across the whole runtime. `BEGIN
TRANSACTION READ ONLY` on Postgres, and `PRAGMA query_only = ON` on SQLite and
libSQL, are connection state, so an inspection query held open across an await
would make a concurrent Capsule mutation on the same connection fail. Inspection
is an operator convenience and must not be able to break a running Capsule.
Closing that properly needs the inspection path to have a connection of its own,
which is a Capsule service and connection-lifecycle question rather than this
one.

## Relationship to existing decisions

This extends ADR-0021 and sits inside ADR-0037's seam. The validator, the walk
and the terminator strip are shared definitions in the engine-agnostic method
set, not engine bodies, so the verdict is one verdict and the disagreements above
were disagreements with the engines rather than between them. Nothing here adds a
dialect entry: where a comment ends is not a place the engines cannot agree on
the *text* of a statement, it is a place the walk has to be right about all of
them at once.

Nothing here changes `ctx.db`, the Sporades DB API, or any Capsule authoring
surface. `sporades db query` is a human inspection path, which is why a
conservative false reject is an acceptable price on it and why the dialect
divergence ADR-0037 records for dollar-quoted literals remains acceptable
alongside these rules.
