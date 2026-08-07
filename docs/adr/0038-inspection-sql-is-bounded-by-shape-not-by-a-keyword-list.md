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

**Text the engine receives unchanged.** A validator can only make a claim about
the text the engine will see. Where the string the runtime checks and the bytes
the engine reads differ, the claim is void, so such a string is refused. The
runtime also hands the engine the single statement the gate accepted —
`sqlWithoutTrailingTerminator(sql)` — rather than the raw input, so a defect in
the walk costs a wrong verdict rather than an executed second statement.

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
of the keyword list. None can begin an admitted statement, so none is reachable
through it; every one of them is a legal column or alias name *inside* one, so
listing them would refuse `SELECT comment FROM posts` and buy nothing. And
`merge` was added, because it closes the one limb of the scan that genuinely is a
closed set: a data-modifying CTE, where Postgres allows exactly `INSERT`,
`UPDATE`, `DELETE` and `MERGE` inside a `WITH`, and `MERGE` was the only one of
the four missing.

What remains is defence in depth over what the three rules above already exclude.
The residual it does not close, stated plainly rather than left to be
rediscovered: a side-effecting function reached from an expression inside an
admitted `SELECT` is caught only by this list, and only if the function happens to
be on it.

## What the walk has to agree with, and which way it leans

A tokenizer that models the engines' lexing is only as good as the model, and a
disagreement in one direction is a security failure rather than a wrong answer.
The direction matters: text the walk treats as trivia and the engine treats as
content is a place to hide a `;`. Text the walk treats as content and the engine
treats as trivia is a false reject.

The rule is therefore that the walk takes the *shortest* comment and the
*narrowest* whitespace any engine would take. One shared verdict cannot be
correct on three engines any other way, and a false reject is a query a human
retypes while the other direction is a table.

Two disagreements were live when this was written, and both were of the first
kind. A `--` comment was ended at a line feed, while Postgres ends one at a
carriage return too — its lexer spells a comment's body `[^\n\r]`. Everything
after a bare CR was trivia to the walk and a fresh statement to the engine, so
`SELECT 1 AS s; -- x<CR> TRUNCATE TABLE t` passed the gate and Postgres executed
both halves; a canary table went from one row to zero. And whitespace was
JavaScript's `\s`, which matches NBSP, U+1680, the U+2000 block, the line and
paragraph separators, U+3000 and the BOM. Postgres spells its whitespace
`[ \t\n\r\f\v]` and SQLite's `sqlite3Isspace` is the same six characters, and
every one of the wider set is an *identifier* character to Postgres, so skipping
them answered "nothing follows the terminator" about text the engine reads on
into.

Block comments are deliberately left non-nesting although Postgres nests them,
because that leans the safe way on its own: a non-nesting walk always ends a
comment at or before where Postgres ends one, so it can only ever see more
content than the engine, never less.

The identifier alphabets disagree too and are deliberately not changed. The walk
reads a bare identifier as `[A-Za-z_][A-Za-z0-9_]*` where Postgres includes `$`
and every non-ASCII byte, so `select$x` is one identifier to the engine and the
keyword `select` here. That leans the permissive way, but harmlessly: no SQL
statement begins with a bare identifier, so what the engine parses instead is a
syntax error rather than a command. Recorded so a later reader knows it was
looked at.

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
