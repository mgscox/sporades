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

Demoted is not the same as dispensable, and there is one place this scan is the
*only* cover. A dollar-quoted run is one statement to Postgres and two to SQLite
and libSQL, which have no such quoting — so the separator rule is defeated
legitimately, and the fingerprint below sees one opaque literal under either
reading. The scan is the only walk that looks inside, precisely because it is the
one that does not know dollar quoting. That is why it asks for a different dialect
from everything else here, and why giving that dialect a single line-comment
terminator blinded it: a `--<CR>` exposed a `/*` that swallowed the verb past the
LF, and `SELECT $$a; --b<CR>/*<LF>DROP TABLE t;<LF>*/$$ AS s` was admitted and
dropped the table on both engines. It now runs under both terminators and unions
the hits.

That ignorance used to be spelled as a *second function*. There were two walkers:
one knowing the union of the three engines' quoting, one knowing neither Postgres
form, sharing their comment handling verbatim and then diverging. The divergence
was deliberate and security-critical and was recorded only in a prose comment
beside them — which is a shape an edit can violate while looking obviously
correct, and one did. The carriage-return terminator was right for Postgres, was
applied to both walkers because they looked like the same function, and destroyed
the asymmetry; nothing failed, because no type, parameter or test encoded it. The
same family of defect then recurred four more times, each fix landing in one
walker and leaving its sibling.

The five walks in the inspection region are one tokenizer now,
`skipSqlQuotedOrCommented`, and the engine differences are a dialect profile it
takes as an argument. The keyword scan asks for
`sqlDialectWithoutPostgresStringForms` and asks for it by name, so reading the
call site tells you which lexing it walks with; widening that profile fails a test
rather than a Capsule. The trivia skipper and both identifier readers were a third,
fourth and fifth copy of the same comment and quoting rules, and they go through
the one tokenizer too — a fix that had left any of them in place would not have
removed the class.

The bundling constraint is what shaped the answer rather than something worked
around: a runtime function reaches the generated Capsule bundle as its own source
text, so it cannot close over a module constant, and the profiles are functions
emitted alongside it rather than constants it would have to restate.

**"One tokenizer" is a claim about that region and not about the runtime, and the
difference matters enough to spell out, because the first draft of this section
read as the wider claim and execution falsifies it.** Two other SQL lexers survive,
and one of them is on this path:

- `postgresInterpolate` replaces `?` placeholders, and every Postgres inspection
  query passes through it twice — once for `all()` and once for the `columns()`
  wrap. It ends a line comment at LF only, and knows neither dollar quoting, nor
  E-strings, nor `[…]`. It is **not** inert there, which a second draft of this
  section also got wrong: `SELECT $$?$$ AS s` is admitted by the gate, is legal
  Postgres, and dies in it with `Missing Postgres query parameter`, because the
  `?` sits inside a form it cannot see. That is a Postgres-only false rejection
  and nothing worse — with no parameters the function can return its input
  unchanged or throw, and there is no third case where it returns *different*
  text, so the gate's "the text checked is the text executed" survives it. The
  property is asserted rather than argued. Collapsing it would fix the false
  rejection and would change what a backslash means inside a literal on the
  *write* path, which is a larger surface than this gate and wants its own ticket.
- `splitSqlStatements` decides whether libSQL sends `sequence` or `execute`. It is
  off this path — inspection goes through `prepare`, not `exec` — and is latent
  duplication of the same class, with its own ticket.

A census test is the tripwire for a third. It flags an emitted runtime function
when its source shows any one of four things: a two-character comment delimiter
(`--`, `/*`, `*/`) in a short string literal; one of those inside a regex or
template literal body; a `-`, or both `*` and `/`, in short string literals; or
two or more of `'`, `"`, backtick, `[`, `$` in short string literals. Every
flagged function must be either the one tokenizer or a listed exception carrying
its reason, and the detected set must *equal* the census — so a new match has to
be classified, and a row that stops matching fails too rather than going stale.

A function whose source shows none of the four is not flagged. Some examples, each
planted and confirmed missed rather than reasoned about: one assembling its
delimiters with `String.fromCharCode(45) + String.fromCharCode(45)`; one comparing
`charCodeAt` values against 45 and 47; one whose only quoting alphabet lives in a
regex body the way this file writes `/^['"`[]/`. Reading quote characters out of
pattern bodies would catch that third one and was measured: it flags 87 runtime
functions, which is not a census. **This is a tripwire for the likely spellings,
not a proof that one tokenizer exists.** A future evasion is another example for
that list.

Saying that plainly took three attempts, and the failure is the transferable part.
Each earlier version wrote a *universal negative* — "enumerates every", "mentions
delimiters at all", "spelling them the way this runtime spells them" — and each
was refuted by one more plant style. A universal negative about a source-text
detector is unprovable and permanently falsifiable; describing the mechanism and
listing known misses is neither.

Seven plants tuned it. Two are worth recording because each cost a signal. The
regex-literal plant is why pattern bodies are read at all: it is the *likeliest*
spelling here rather than an exotic one, because `skipSqlQuotedOrCommented` writes
its own terminator rules as `/[\n\r]/ : /\n/` and `/^\$(?:…)\$/`. And a plant whose
delimiter comparisons were copied character-for-character out of this file —
`sql[index] === "-" && sql[index + 1] === "-"`, a line comment ending at LF, the
quote set taken as a parameter rather than named — is why a single comment
character now stands alone as a signal, where it previously needed a quote
delimiter beside it.

Those two signals cost six census rows holding a `-`, or a `*` and a `/`, that is
not a SQL comment delimiter: two sets of CLI hint strings, MIME multipart
boundaries, the `-----BEGIN … PRIVATE KEY-----` header, a hostname label rule, and
cron step syntax. Each was read to confirm it rather than assumed from the name.

The nesting oracle is in the census on its own code — it closes a block comment
with `sql[cursor] === "*" && sql[cursor + 1] === "/"` — and a test asserts that,
because it was previously matched only on the `--x<CR>` examples in its prose.
Rewording a comment would have dropped out the one entry whose disagreement with
the tokenizer is deliberate, and the obvious response to that failure would have
been to delete the row.

Union, not refuse-on-disagreement, and the difference is worth holding onto: the
other walks answer *which statement is this*, where two readings disagreeing means
there is no single answer and the input must be refused; this one answers *is a
destructive verb anywhere in here*, where a verb one reading hides and the other
exposes is simply a verb.

Which verbs that route can reach also has an executed answer, and it is a second
independent reason the six Postgres-only verbs stay off the list. The engines that
read inside such a run are SQLite and libSQL, and neither has `TRUNCATE` or `DO`
at all — measured with a canary, `DROP` and `DELETE` destroy it on both while
`TRUNCATE` and `DO` leave every engine intact. Every verb reachable this way is
one those two engines have, and all of those are listed.

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

Whitespace can be made to agree, and does. Comments cannot: for both kinds there
is no single reading that is right on every engine, so for both the input whose
reading is in dispute is refused rather than guessed at — and whether it is in
dispute is decided by computing both readings and comparing them, not by
recognising the text that usually means they differ. Three attempts at the
recognising version each shipped a hole.

An earlier draft of this section said the walk should take the *shortest* comment
any engine would take, and that taking it was conservative. Both halves were
wrong, and the line-comment case below is where that showed.

**Line comments — closed by refusing, after "take the shortest" failed.** A `--`
comment was ended at a line feed, while Postgres ends one at a carriage return
too; its lexer spells a comment's body `[^\n\r]`. Everything after a bare CR was
trivia to the walk and a fresh statement to the engine, so
`SELECT 1 AS s; -- x<CR> TRUNCATE TABLE t` passed the gate and Postgres executed
both halves; a canary table went from one row to zero. Ending the comment at CR
fixed that.

It was then recorded here that ending at CR "costs a false reject on SQLite",
which reads on to the next LF. It does not, and the reason is that comment
terminators *compose*. Ending the line comment early **exposes** whatever follows
the CR, and if that is a `/*` the walk opens a block comment and runs past the LF
which would have closed SQLite's line comment. The composed walk therefore skips
*more* than SQLite does, which is the hazard this section names, arrived at from
the opposite direction:

    SELECT 1 AS s --x<CR>/*y<LF>; DROP TABLE t --*/ AS z

is a `SELECT` with a long block comment here, and to SQLite and libSQL one line
comment followed by a real second statement — both of them execute the `DROP`,
while Postgres answers `syntax error at or near "AS"`. Nothing reached an engine
through the inspection path, but only because `node:sqlite`'s `prepare()` compiles
the first statement of a multi-statement string and silently discards the rest:
another component holding the boundary shut, which is the thing this ADR refuses
to depend on.

So the CR rule stays — Postgres is the engine that executes multi-statement
strings, so its reading is the right default — but it is no longer asked to be
safe on its own. `sqlContentFingerprint` runs the whole walk under each engine's
line-comment terminator and the input is refused wherever the two draw different
verdicts. What is compared is the content the verdict is drawn from, not the
comment spans: spans differ for an ordinary `-- why<CR><LF>`, where the LF is
inside the comment under one rule and whitespace under the other, and no consumer
can tell those apart. Comparing spans would refuse every CRLF query with a comment
in it; comparing content refuses only where a token, a separator or a literal
boundary actually moves.

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
decrements it. When neither rule terminates, both answer end-of-input and there is
nothing to report; when only the nesting one is unterminated —
`SELECT 1 /* /* */ ; X`, where the non-nesting walk stops at the first `*/` — they
differ and the input is refused, which is correct, because that `;` is a separator
to Postgres and inside a comment to nobody.

## How the numbers here were obtained, which matters more than the numbers

`scripts/inspection-lexing-sweep.mjs` is committed so that everything below can be
re-run and disbelieved. It builds a corpus of comment- and whitespace-shaped
prefixes, asserts the corpus can emit each shape that has previously defeated this
gate, then executes every admitted candidate raw against all three engines — past
the `columns()` wrap, with a canary row that must survive and a probe table that
must never appear, so any non-`SELECT` first token is observable and not only a
destructive one.

`scripts/inspection-lexing-differential.mjs` is committed for the same reason and
answers the two questions either side of it, which a live sweep is the wrong
instrument for: whether a refactor changed any verdict, refusal reason, terminator
strip or internal walk against another build, and whether any *realistic* query is
newly refused — the sweep's corpus being attack-shaped by construction and
structurally unable to answer that. It was added when the figures behind a
"behaviour-preserving" claim turned out to live in an uncommitted harness, which is
this section's own policy being broken by the commit that wrote this section.

**The baseline is the pre-work base, and naming it is not a formality.** Over
310,156 candidates measured against the commit this work started from: this gate
admits 59,818, **none of which has an effect a `SELECT` cannot have on any of the
three engines**, and **nothing is admitted that the pre-work base did not also
admit**. The base admitted 8,691 that are now refused, 291 of which really do
truncate a table or run a `DO` block on Postgres.

That baseline was wrong for four consecutive rounds, and the way it was wrong is
the most transferable thing in this document. Each round compared itself against
the round before it, correctly reported "0 newly admitted", and was measuring the
wrong interval: underneath, 1,170 destructive payloads had been newly admitted
relative to the base — introduced by an early round and preserved by every
comparison after it. A round-over-round check cannot see a regression that a
round introduced and later rounds left alone. Any monotonicity claim about this
gate names the pre-work base or it means nothing.

Two methodology points are worth more than those figures, because each is a
mistake this work actually made.

**A generator that cannot emit the shape reports clean for the wrong reason.** It
happened three times: the corpus could not reach nesting depth, then could not
reach the `/*/` straddle, then had no `--`, `\r` or `\n` in its alphabet at all and
so reported clean about a class of disagreement it could not express. The corpus is
now asserted to contain each of those shapes before any result from it is read,
in the sweep and in `test/database-adapter-engine-seam.test.js` alike. Adding a
rule without adding its alphabet to the generator is how this keeps recurring.

**An oracle that cannot observe the defect is the same failure.** The sweep first
executed on Postgres alone and reported zero for the line-comment class — a class
that exists precisely because SQLite and libSQL run the second statement where
Postgres raises a syntax error. Six real findings were invisible until the sweep
ran on every engine. Whichever engine is most convenient to automate is not
necessarily the one that can see the bug.

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
