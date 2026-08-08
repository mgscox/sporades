// The read-only inspection validator for `sporades db query`, and the tokenizer it is built on.
//
// This is the first region of the runtime to leave `server-runtime-source.ts` and become an
// ordinary module. Why it was chosen, and what is different now, are the same fact: this gate went
// through five rounds of fixes and four independent reviews, every one finding a real defect of the
// same family, because the emitted-list bundler forbade it from having helpers. A runtime function
// reaches the generated Capsule bundle as its own source text, so a helper it called had to be
// registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a `ReferenceError` in a deployed
// Capsule — and the cheaper answer, every time, was to write the logic out again. Two skippers, a
// trivia skipper and two identifier readers were five copies of one set of comment and quoting
// rules; ADR-0038 records what that cost.
//
// Inside a module a helper needs no registration, because both bundlers now carry this file whole:
//
//   - the module-graph bundle imports it, and esbuild pulls in whatever it references;
//   - the emitted-list bundle carries this module's own compiled text as one block, rather than
//     `fn.toString()` over a list of its functions — see `createServerBundleSource`.
//
// So a name that fails to travel is a compile error in `npm run build` rather than a
// `ReferenceError` a deployed Capsule reaches at runtime, and extracting a helper is an ordinary
// edit. `nestingBlockCommentEnd` and `opensQuotedRun` below are the first two taken on those terms:
// neither is exported, neither is registered anywhere, and both survive into both bundles.
// ADR-0041 records the mechanism.
//
// **What is exported and what is not is not a statement about coupling.** Most of what is exported
// here has no caller outside this file. It is exported because the guards that hold this gate shut
// need the functions as *values*: the walker census, the terminator-spelling checks in
// `test/database-adapter-engine-seam.test.js`, and the internal-walk comparison in
// `scripts/inspection-lexing-differential.mjs` all call them directly. Narrowing the surface would
// buy tidiness and cost the evidence that this region is the same region it was before it moved.
// The two new helpers are private because nothing needs them as values — the census reads them out
// of this file's source text, which is what makes a private helper visible to it at all.
//
// Four names are reached from outside this module, and they are the real boundary. Two are the
// gate: `validateReadOnlyInspectionSql` and `sqlWithoutTrailingTerminator`, which the Database
// adapters' `runReadOnlyInspectionQuery` and the Postgres `columns()` primitive call from
// `server-runtime-source.ts`. Two are the tokenizer: `skipSqlTrivia` and `readSqlQuotedIdentifier`,
// which the internal log-index table guard lexes a table reference with.
//
// That second pair is a coupling the single file was hiding, and it has one consumer:
// `log-index-guard.ts`. The guard is not part of this gate — ADR-0038 is a document about what this
// gate is a boundary by, and concealing an internal table is not one of those things — so it is a
// module beside this one rather than inside it, and its header states that reasoning. What changed
// when it moved is that the tokenizer stopped being reachable from 13,700 lines of unrelated
// domains and became a named dependency of one file that lexes SQL on this same path.

// The read-only inspection gate for `sporades db query`. What it is a boundary *by* is worth being
// explicit about, because a reader who takes the keyword scan below for the boundary will keep
// trying to complete a list that cannot be completed (ADR-0038):
//
//   1. A **statement-shape allowlist**. The first token must be `SELECT`, `WITH`, or one of the
//      eight safe metadata PRAGMAs. Every destructive verb — `TRUNCATE`, `DO`, `DROP`, `SET`,
//      `COMMENT`, `COPY`, `CALL`, and whatever the next dialect adds — is out here, not because it
//      was remembered but because it is not one of the three shapes admitted.
//   2. **One statement**, which is what makes (1) mean anything: a second statement is a second
//      first token that nothing checked. Postgres's simple query protocol executes a
//      multi-statement string, so this rests on `hasMultipleSqlStatements` agreeing with the
//      engines about where a comment, a literal and whitespace end. A disagreement there is the
//      whole boundary, which is how a line comment ending at LF where Postgres ends one at CR came
//      to be a live `TRUNCATE`.
//   3. **The text checked is the text executed, and is read the same way.** A string the wire
//      cannot carry unchanged is refused; so is a string this walk and an engine would lex
//      differently, because rules (1) and (2) are claims about tokens and a claim about a token is
//      void where the token boundary is in dispute. `runReadOnlyInspectionQuery` then hands the
//      engine the one statement this gate accepted rather than the raw input.
//
// Rule (3) is what makes rule (1) true rather than merely intended. Before it, a nested block
// comment — which Postgres closes at the *outer* `*/` and the other two close at the first —
// let `/*/* */ SELECT 1 */ TRUNCATE TABLE t` past this gate: the walk took its first token from
// `SELECT`, inside text Postgres treats as comment, and the statement Postgres would have parsed
// was the `TRUNCATE`. `DO`, `SET`, `COMMENT` and `COPY` all rode the same shape.
//
// The side-effect keyword scan is not on that list. It is defence in depth over what (1), (2) and
// (3) already exclude, and ADR-0038 records why it cannot be promoted.
export function validateReadOnlyInspectionSql(sql: any) {
  const text = String(sql ?? "");

  // A validator can only promise something about text the engine will actually receive. Node
  // encodes an unpaired surrogate as U+FFFD, so `$\ud800$` and `$\ud801$` are one delimiter to
  // Postgres and two here — enough for the walk to read one literal spanning a `;` that Postgres
  // closes before. A NUL is the same fault from the other side: it terminates the string Postgres
  // reads off the wire, so everything checked after it is never seen there. Neither can occur in a
  // query a human meant to write, and refusing both is what keeps the rest of this gate a claim
  // about the statement the engine runs.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\0/.test(text)) {
    return unrepresentableInspectionSqlError();
  }

  const disagreement = sqlTheEnginesLexDifferently(text);
  if (disagreement) {
    return ambiguousInspectionSqlError(disagreement);
  }

  const firstToken = readFirstSqlToken(text);
  if (!firstToken || hasMultipleSqlStatements(text)) {
    return readOnlyInspectionSqlError();
  }

  const keyword = firstToken.toLowerCase();
  if (keyword === "pragma") {
    return isSafeInspectionPragma(text, firstToken.length) ? { ok: true as const } : readOnlyInspectionSqlError();
  }

  if ((keyword === "select" || keyword === "with") && !containsSideEffectSqlToken(text)) {
    return { ok: true as const };
  }

  return readOnlyInspectionSqlError();
}

export function readOnlyInspectionSqlError() {
  return {
    ok: false as const,
    data: null as any,
    error: {
      message: "Only read-only SQL is allowed.",
      hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
    },
  };
}

export function unrepresentableInspectionSqlError() {
  return {
    ok: false as const,
    data: null as any,
    error: {
      message: "Only SQL text the database receives unchanged is allowed.",
      hint: "Remove the NUL or unpaired surrogate character from the `sporades db query` SQL.",
    },
  };
}

export function ambiguousInspectionSqlError(hint: string) {
  return {
    ok: false as const,
    data: null as any,
    error: {
      message: "Only SQL the database reads the same way this check does is allowed.",
      hint,
    },
  };
}

// The characters outside a quoted run where this walk's reading and an engine's reading come apart,
// found in one pass because both are the same question asked of a bare character. Answers the hint
// naming what to take out, or null when there is nothing in dispute.
//
// The gate's verdict is a claim about tokens — which one comes first, and whether a `;` separates
// two statements — so it is void wherever the token boundary is not agreed. Refusing the disputed
// input is what lets the rest of this file describe one lexing rather than three, and it is the
// same shape as `unrepresentableInspectionSqlError`: the walk declines to answer about text it
// cannot answer about, instead of answering and being right on one engine.
//
// **Nested block comments.** Postgres nests `/*` inside `/*` and closes at the matching `*/`;
// SQLite and libSQL close at the first `*/` and read on. So `/*/* */ SELECT 1 */ TRUNCATE TABLE t`
// is a `SELECT` to the two and a `TRUNCATE` to Postgres — and the walk, which does not nest, took
// its first token from inside what Postgres was treating as a comment. Neither lexing can be
// chosen: nesting opens the mirror hole, where a `;` inside a comment this walk swallows is a real
// separator to SQLite. Refusing the disputed input is the only reading right about all three.
//
// The test for "disputed" is *derived rather than described*, and that is the point of it. Two
// earlier versions asked what the comment's text looked like — first "does it contain a `/*`", then
// the same with the terminator trimmed off — and each missed a shape the other did not. The second
// missed `/*/`, where the nested opener's `*` is also the terminator's `*`, so the opener straddled
// the boundary the substring was cut at and `/* /*/ SELECT 1 */ */ TRUNCATE TABLE t` was admitted
// and ran. A third guess at that substring would have had a third blind spot.
//
// So the question is asked directly instead: run a nesting lexer over the same comment and compare
// where it ends against where the non-nesting walk ended. Equal means every engine closes the
// comment in the same place and the walk's reading is nobody's guess; unequal means at least one
// engine disagrees, whatever the text happens to look like. That is true by construction for shapes
// nobody thought to write down, which a pattern cannot be.
//
// The counter is Postgres's own rule from `scan.l`: `{xcstart}` is `/*` and increments the depth
// (its trailing `{op_chars}*` is undone by `yyless(2)`, so only `/*` is consumed), `{xcstop}` is
// `\*+\/` and decrements it. Counting `*/` rather than `\*+\/` reaches the same end index, because a
// run of asterisks before the slash only moves where the token starts, not where it stops.
//
// **Whitespace no engine has.** All three engines take space, tab, LF, CR and form feed and no
// others — vertical tab included, which is a lexer error on every one of them, and every character
// JavaScript's `\s` adds beyond those is an identifier character to Postgres. Skipping any of them
// said a statement ended where the engine reads on.
export function sqlTheEnginesLexDifferently(sql: string) {
  // The line-comment terminator, compared the same derived way the block-comment nesting is, and
  // for a sharper reason: this one composes. Ending `--x<CR>` at the CR *exposes* a `/*` that the
  // walk then runs past the following LF, so the composed walk skips more than SQLite does — the
  // hazard this whole gate is built to avoid. `SELECT 1 AS s --x<CR>/*y<LF>; DROP TABLE t --*/ AS z`
  // is one line comment and a real second statement to SQLite and libSQL, which execute the DROP,
  // and a `SELECT` with a long block comment to Postgres. Ending the comment at CR alone is not the
  // conservative direction an earlier version of this file claimed it was.
  //
  // What is compared is the content the verdict is drawn from, not the comment spans. Spans differ
  // for `-- why<CR><LF>` — the LF is inside the comment under one rule and whitespace under the
  // other — and no consumer can tell those apart, so comparing spans would refuse every CRLF query
  // with a comment in it. Comparing content refuses only where a token, a separator or a literal
  // boundary actually moves.
  if (sqlContentFingerprint(sql, true) !== sqlContentFingerprint(sql, false)) {
    return "Remove the carriage return from inside the `-- ...` comment in the `sporades db query` SQL — SQLite ends a line comment at a line feed and Postgres ends one at either.";
  }

  const dialect = sqlDialectEveryEngineQuotes(true);
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      // Only a block comment can be read two ways here, so only a block comment is counted. This
      // test is deliberately still spelled out at the call site rather than folded into the counter:
      // it is what puts this function in the walker census on its own code rather than on its prose,
      // and a reworded comment must not be able to drop it out. See the census in
      // `test/database-adapter-engine-seam.test.js`.
      if (sql[index] === "/" && sql[index + 1] === "*") {
        // `nestingBlockCommentEnd` cannot answer past `sql.length`: both of its steps advance only
        // over characters that exist, so an unterminated comment lands exactly on it. When *neither*
        // rule terminates, both answer `sql.length` and there is no disagreement to report. When only
        // the nesting one is unterminated — `SELECT 1 /* /* */ ; X`, where the non-nesting walk stops
        // at the first `*/` — they differ and the input is refused, which is the strict direction and
        // correct: that `;` is a separator to Postgres and inside a comment to nobody.
        if (nestingBlockCommentEnd(sql, index) !== skipped) {
          return "Remove the nested `/* ... */` comment from the `sporades db query` SQL — Postgres and SQLite disagree about where it ends.";
        }
      }
      index = skipped;
      continue;
    }
    if (/\s/.test(sql[index]) && !/[ \t\n\r\f]/.test(sql[index])) {
      return "Replace the invisible character outside quotes — a non-breaking space, a vertical tab, or another character the engines do not treat as whitespace — with an ordinary space.";
    }
    index += 1;
  }
  return null;
}

// Where Postgres closes the block comment that opens at `index`, counting depth the way its own
// lexer does. The counter to `skipSqlQuotedOrCommented`'s non-nesting reading, and the whole content
// of "the two engines disagree about this comment": equal ends mean every engine closes it in the
// same place, unequal ends mean at least one does not, whatever the text looks like.
//
// The rule is Postgres's, from `scan.l`: `{xcstart}` is `/*` and increments the depth — its trailing
// `{op_chars}*` is undone by `yyless(2)`, so only `/*` is consumed — and `{xcstop}` is `\*+\/` and
// decrements it. Counting `*/` rather than `\*+\/` reaches the same end index, because a run of
// asterisks before the slash only moves where the token starts, not where it stops.
//
// **This is the first helper extracted here on the new terms, and the extraction is the point.**
// It is not exported, it is not registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or in any other
// list, and it reaches both generated bundles anyway, because both now carry this module whole
// rather than function by function. Under the old mechanism this could not have been a function at
// all: its caller travels into the emitted-list bundle as its own source text, so a helper it called
// and nobody registered was a `ReferenceError` in a deployed Capsule, invisible to every test.
// That is why the counter was written inline, and why the four other copies of this file's lexing
// rules existed. ADR-0041 records the mechanism; ADR-0038 records what the inline version cost.
//
// It is still visible to the walker census, which reads this module's source text rather than a list
// of registered functions, so a private helper that lexes SQL cannot hide behind not being exported.
function nestingBlockCommentEnd(sql: string, index: number) {
  let depth = 0;
  let cursor = index;
  while (cursor < sql.length) {
    if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        break;
      }
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

// Everything a verdict is drawn from, under one engine's line-comment rule, in a form two runs can
// be compared with. It records three things:
//
//   - **which characters are content**, position included, so a token that moves is a difference;
//   - **which characters are trivia**, comment and whitespace collapsed together, because no
//     consumer distinguishes them and keeping them apart would refuse every `-- why<CR><LF>`;
//   - **where a quoted run starts and ends**, emitted opaquely, so that a `;` inside a literal under
//     one rule and outside it under the other is a difference rather than the same character at the
//     same offset.
//
// This covers exactly the four consumers that ask for `sqlDialectEveryEngineQuotes` — the first
// token, the separator search, the safe PRAGMA check and the terminator strip. Two runs that agree
// here cannot disagree in any of those.
//
// It does **not** cover the side-effect keyword scan, and an earlier version of this comment claimed
// it did. That scan asks for `sqlDialectWithoutPostgresStringForms`, which knows neither dollar
// quoting nor E-strings, so it can read a span this one treats as a single opaque literal — which
// is the whole reason it asks for that dialect. Agreement here says nothing about it: `"--<CR>E`
// yields the token `e` under one line-comment rule and none under the other while this fingerprint
// is identical under both. The scan is covered instead by being run under both rules and unioned;
// see `containsSideEffectSqlToken`.
//
// The comparison is derived rather than described, for the reason recorded on the block-comment
// counter above and demonstrated twice there: a rule that recognises the dangerous text is a rule
// with a blind spot in it somewhere nobody has looked yet.
export function sqlContentFingerprint(sql: string, lineCommentEndsAtCarriageReturn: boolean) {
  const dialect = sqlDialectEveryEngineQuotes(lineCommentEndsAtCarriageReturn);
  let fingerprint = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      if (opensQuotedRun(sql, index)) {
        fingerprint += `q${index}-${skipped};`;
      }
      index = skipped;
      continue;
    }
    if (!/[ \t\n\r\f]/.test(sql[index])) {
      fingerprint += `${index}:${sql[index]};`;
    }
    index += 1;
  }
  return fingerprint;
}

export function readFirstSqlToken(sql: string) {
  return readBareSqlIdentifier(sql, skipSqlTrivia(sql, 0, true))?.value ?? null;
}

export function hasMultipleSqlStatements(sql: string) {
  const dialect = sqlDialectEveryEngineQuotes(true);
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === ";") {
      return skipSqlTrivia(sql, index + 1, true) < sql.length;
    }
    index += 1;
  }
  return false;
}

export function isSafeInspectionPragma(sql: string, pragmaTokenLength: number) {
  let index = skipSqlTrivia(sql, skipSqlTrivia(sql, 0, true) + pragmaTokenLength, true);
  let identifier = readBareSqlIdentifier(sql, index);
  if (!identifier) {
    return false;
  }

  let pragmaName = identifier.value.toLowerCase();
  index = skipSqlTrivia(sql, identifier.nextIndex, true);
  if (sql[index] === ".") {
    identifier = readBareSqlIdentifier(sql, skipSqlTrivia(sql, index + 1, true));
    if (!identifier) {
      return false;
    }
    pragmaName = identifier.value.toLowerCase();
    index = skipSqlTrivia(sql, identifier.nextIndex, true);
  }

  if (!SAFE_INSPECTION_PRAGMAS.has(pragmaName)) {
    return false;
  }

  const dialect = sqlDialectEveryEngineQuotes(true);
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "=") {
      return false;
    }
    index += 1;
  }
  return true;
}

// The three keyword tables the read-only gate consults. Exported because a module-level binding
// does not travel with the source text of a function that closes over it: the bundle template
// serializes these into its constant preamble so the emitted gate has them.
export const SAFE_INSPECTION_PRAGMAS = new Set([
  "database_list",
  "foreign_key_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "table_info",
  "table_list",
  "table_xinfo",
]);

// The scan runs under *both* line-comment terminators and reports a hit found under either, which is
// the only combination that is safe here and is not the same operation the gate's other walks do.
// They compare two readings and refuse a disagreement, because they answer "which statement is
// this" and a disagreement means there is no single answer. This one answers "is a destructive verb
// anywhere in here", so two readings compose by union: a verb one reading hides behind a comment and
// the other exposes is still a verb, and there is nothing to be ambiguous about.
//
// Taking the union rather than picking a terminator is what this needed, and picking one is the
// mistake that was here. The tokenizer this scan walks with was given the CR rule along with every
// other walk — it was a separate function then, so "every walk" was an edit repeated by hand — and
// that composes exactly as the main walk's did: the CR ends the `--`, exposing a `/*` that then
// swallows the verb past the LF.
//
//     SELECT $$a; --b<CR>/*<LF>DROP TABLE t;<LF>*/$$ AS s
//
// Postgres reads all of that as one dollar-quoted literal and answers a string. SQLite and libSQL
// have no dollar quoting, so to them it is a real `DROP` in a second statement — and they execute
// it. This scan is the only cover for that, deliberately, because it is the one walk that does not
// know dollar quoting and so can see inside a literal the other two engines never see as one; the
// separator walk cannot help, since `$$…;…$$` genuinely *is* one statement to Postgres, and
// `sqlContentFingerprint` cannot see it either, because the whole span is one opaque quoted run to
// it under both readings. Under the LF rule the `DROP` is plain text and the scan fires. Under CR
// alone it was invisible.
export function containsSideEffectSqlToken(sql: string) {
  return (
    containsSideEffectSqlTokenUnder(sql, true) || containsSideEffectSqlTokenUnder(sql, false)
  );
}

export function containsSideEffectSqlTokenUnder(sql: string, lineCommentEndsAtCarriageReturn: boolean) {
  for (const token of readSqlTokens(sql, lineCommentEndsAtCarriageReturn)) {
    const value = token.value.toLowerCase();
    if (SIDE_EFFECT_SQL_KEYWORDS.has(value)) {
      return true;
    }
    if (
      SIDE_EFFECT_SQL_FUNCTIONS.has(value) &&
      sql[skipSqlTrivia(sql, token.nextIndex, lineCommentEndsAtCarriageReturn)] === "("
    ) {
      return true;
    }
  }
  return false;
}

// Defence in depth, not the boundary — ADR-0038 demotes this scan deliberately, and the demotion
// is the point rather than an admission. The boundary is the statement-shape allowlist and the
// one-statement rule on `validateReadOnlyInspectionSql`; a verb here is only reachable at all
// *inside* an admitted `SELECT`, `WITH` or safe PRAGMA.
//
// `TRUNCATE`, `DO`, `SET`, `COMMENT`, `COPY` and `CALL` are absent on purpose and adding them would
// make this list worse. Every one of them is a legal column or alias name inside an admitted
// statement, so listing them would refuse `SELECT comment FROM posts` to buy nothing, while none of
// them can *begin* one — a destructive verb is excluded by not being one of the three admitted
// shapes, which is a closed rule, rather than by being remembered here, which is not.
//
// That second half is a claim about where the first token is, and it is only worth as much as the
// walk's agreement with the engines about where the first token is. It has been false twice: a
// nested block comment let all six of them begin a statement the walk had read a `SELECT` out of,
// and the first attempt to close that missed the `/*/` straddle and left the same six reachable.
// `sqlTheEnginesLexDifferently` is what makes it true, and it is the thing to check first if it ever
// looks false again — the reason its nesting test is derived rather than described is that the two
// described versions were the two failures.
//
// What this list does close is the one limb that *is* a closed set: a data-modifying CTE, where
// Postgres allows `INSERT`, `UPDATE`, `DELETE` and — from version 17 — `MERGE` inside a `WITH`.
// `merge` was the only one of the four missing. The version qualifier is checked rather than
// assumed: PostgreSQL 16.14 answers `syntax error at or near "RETURNING"` for a data-modifying
// `MERGE` CTE, so listing it guards the engine a Hosted Capsule may run rather than the one the
// suite runs. What no list can close is a side-effecting *function* reached from
// an expression — `nextval` and `set_config` below are two of an open set that grows with every
// extension installed — which is why this is where the scan stops being a boundary and starts being
// a belt.
export const SIDE_EFFECT_SQL_KEYWORDS = new Set([
  "alter",
  "analyze",
  "attach",
  "create",
  "delete",
  "detach",
  "drop",
  "insert",
  "merge",
  "reindex",
  "replace",
  "update",
  "vacuum",
]);

export const SIDE_EFFECT_SQL_FUNCTIONS = new Set([
  "load_extension",
  "nextval",
  "set_config",
  "setval",
]);

// The scan asks for the dialect that withholds Postgres's two string forms, and asks for it by
// name. That withholding is the belt described on `sqlDialectWithoutPostgresStringForms`, and
// naming it here is the point of the parameter: this used to be the difference between two function
// bodies, so the only way to know which lexing a walk had was to read a comment beside it and trust
// that nobody had since edited the other one to match.
// The terminator is required rather than defaulted. It defaulted to the carriage-return reading,
// which is the one that blinded this scan: a `--<CR>` exposes a `/*` that then swallows the verb
// past the LF. No caller relied on the default — the only one passes both readings in turn — so a
// default here bought nothing and left a new caller one omitted argument away from the defect.
export function readSqlTokens(sql: string, lineCommentEndsAtCarriageReturn: boolean) {
  const dialect = sqlDialectWithoutPostgresStringForms(lineCommentEndsAtCarriageReturn);
  const tokens = [];
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const identifier = readSqlTokenIdentifier(sql, index);
    if (identifier) {
      tokens.push(identifier);
      index = identifier.nextIndex;
      continue;
    }
    index += 1;
  }
  return tokens;
}

export function readBareSqlIdentifier(sql: string, index: number) {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
  return match ? { value: match[0], nextIndex: index + match[0].length } : null;
}

// The keyword scan's identifier reader. It does not recognise `'`, because the dialect the scan
// walks with already consumes an ordinary string literal as a quoted run before this is reached; a
// `'…'` here would turn literal text into a token.
export function readSqlTokenIdentifier(sql: string, index: number) {
  return readSqlQuotedIdentifier(sql, index, '"`[');
}

// A quoted identifier's *value*, over the quoting forms the caller names.
//
// Where the run ends is not decided here — that is the one tokenizer's question and this asks it,
// under a dialect that recognises the given quotes and nothing else. What is left is unescaping,
// which is a different question: `[…]` has no doubling and `'`, `"` and backtick do.
//
// Which of the two a run is comes from the character the tokenizer stopped on rather than from a
// second table of quote pairs. A run whose closing character is its opening character is a doubling
// form; `[…]` is the only one where they differ.
//
// An unterminated run is not an identifier, and the dialect asks for that answer directly:
// `unterminatedQuotedRunReachesEndOfInput` false makes the tokenizer report "nothing opens here",
// so the caller steps one character and keeps reading. That matters to the keyword scan — stopping
// at an unterminated `"` instead would hide every token after it, and `SELECT "a; DROP` would be
// admitted.
export function readSqlQuotedIdentifier(sql: string, index: number, quotes: string) {
  const end = skipSqlQuotedOrCommented(sql, index, sqlDialectQuotedIdentifiersOnly(quotes));
  if (end === index) {
    // Either the character opens no quoted run, or it opens one that never closes. A quote
    // character cannot begin a bare identifier, so the same fallback answers both.
    return readBareSqlIdentifier(sql, index);
  }
  const closingQuote = sql[end - 1];
  const value = sql.slice(index + 1, end - 1);
  return {
    value: closingQuote === sql[index] ? value.replaceAll(closingQuote + closingQuote, closingQuote) : value,
    nextIndex: end,
  };
}

// The five dialect profiles the read-only inspection path asks `skipSqlQuotedOrCommented` for.
//
// They are functions rather than module constants, and that used to be forced rather than chosen: a
// runtime function reached the generated Capsule bundle as its own source text, so a constant it
// closed over would not follow it and would be a `ReferenceError` in a deployed Capsule, while a
// function it called did follow through `SERVER_RUNTIME_SOURCE_FUNCTIONS`. That constraint is gone
// for this file — a module constant declared here now travels into both bundles exactly as the
// keyword tables below do — so the shape is no longer forced. It is kept because two of the five
// take an argument and the other three read the same way beside them, and because changing the
// shape of a security-critical profile table is a change to make on its own evidence rather than as
// a side effect of moving the file. What is *not* kept is writing the profiles as object literals at
// each call site: that would travel too, and would put the same drift one edit away that the
// tokenizer collapse exists to remove.
//
// The first two name an *engine difference* and are the reason this file has a parameter at all.
// The last three name a *question* — they are the union profile with one part switched off, for
// callers that need to step over comments but not literals, or the reverse.

// Everything all three engines quote with, which is the union rather than any one engine's rules:
// `'…'` with `''` doubling, `"…"`, backtick and `[…]` identifier quoting, `--` and `/*…*/` comments,
// and Postgres's two extra string forms — dollar quoting (`$$…$$`, `$tag$…$tag$`) and E-strings,
// where a backslash escapes the next character.
//
// This is what the separator search, the safe-PRAGMA check, the terminator strip and the content
// fingerprint ask for. Covering the union is right for those four because each answers "where does
// this statement end", and a form only one engine has still hides a `;` from that engine.
export function sqlDialectEveryEngineQuotes(lineCommentEndsAtCarriageReturn: boolean) {
  return {
    comments: true,
    lineCommentEndsAtCarriageReturn,
    dollarQuoting: true,
    escapeStrings: true,
    quotes: "'\"`[",
    unterminatedQuotedRunReachesEndOfInput: true,
  };
}

// The same, less Postgres's two string forms — and the asymmetry is the security-critical one this
// file's defect history is made of, so it is stated here rather than beside a second function body.
//
// The side-effect keyword scan asks for this. Widening it would let `SELECT $$a; DROP TABLE t$$ AS s`
// through as one literal: true of Postgres, and false of SQLite and libSQL, which have no dollar
// quoting and read a real second statement there and execute the `DROP`. The separator walk cannot
// help, because that text genuinely *is* one statement to Postgres, and the content fingerprint
// cannot either, because the whole span is one opaque quoted run to it under both line-comment
// rules. This scan is the only cover, and it is cover only while it stays ignorant.
//
// Refusing that costs a conservative false reject on Postgres and buys the other two a belt no
// other walk here can give them.
//
// Identifier quoting is withheld for a different reason: `readSqlTokenIdentifier` consumes a quoted
// identifier as a *token*, which is what lets the scan see a verb spelled `"drop"`. Skipping it as
// a quoted run instead would hide it.
export function sqlDialectWithoutPostgresStringForms(lineCommentEndsAtCarriageReturn: boolean) {
  return {
    comments: true,
    lineCommentEndsAtCarriageReturn,
    dollarQuoting: false,
    escapeStrings: false,
    quotes: "'",
    unterminatedQuotedRunReachesEndOfInput: true,
  };
}

// Comments and nothing else, for `skipSqlTrivia`. Trivia steps over whitespace and comments; a
// string literal is content and must stop it.
export function sqlDialectCommentsOnly(lineCommentEndsAtCarriageReturn: boolean) {
  return {
    comments: true,
    lineCommentEndsAtCarriageReturn,
    dollarQuoting: false,
    escapeStrings: false,
    quotes: "",
    unterminatedQuotedRunReachesEndOfInput: true,
  };
}

// Quoted runs and nothing else, for `opensQuotedRun` — the one caller now, where there used to be
// two spelling the same request out in full. It is asked of the run the union profile just stepped
// over: a run this also recognises is a literal, and a run it does not is a comment. That is derived
// from the tokenizer rather than re-tested against the two characters that opened the run, so it
// cannot fall out of step with what the tokenizer actually did.
export function sqlDialectQuotedRunsOnly() {
  return {
    comments: false,
    lineCommentEndsAtCarriageReturn: true,
    dollarQuoting: true,
    escapeStrings: true,
    quotes: "'\"`[",
    unterminatedQuotedRunReachesEndOfInput: true,
  };
}

// One identifier-quoting form set, for `readSqlQuotedIdentifier`. An unterminated run reports
// "nothing opens here" rather than running to the end of the input, because an identifier that
// never closes is not an identifier — see the note there for why that answer is load-bearing.
export function sqlDialectQuotedIdentifiersOnly(quotes: string) {
  return {
    comments: false,
    lineCommentEndsAtCarriageReturn: true,
    dollarQuoting: false,
    escapeStrings: false,
    quotes,
    unterminatedQuotedRunReachesEndOfInput: false,
  };
}

// The end of the quoted or commented run starting at `index`, or `index` itself when the character
// there opens neither, under the dialect profile the caller passes.
//
// There used to be two of these. `skipSqlStringOrComment` knew the union of the three engines'
// quoting and served the validator and the terminator strip; `skipSqlLiteralOrComment` knew neither
// Postgres form and served the side-effect keyword scan. They shared their comment handling
// verbatim and then diverged, and the divergence was deliberate, security-critical and recorded
// only in a prose comment.
//
// That is a shape an edit can violate while looking obviously correct, and one did: a change that
// ended line comments at a carriage return was right for Postgres, was applied to both walkers
// because they looked like the same function, and destroyed the asymmetry. Nothing failed, because
// no type, parameter or test encoded it. The same family of defect then recurred four more times,
// each fix landing in one walker and leaving its sibling. The differences are an argument now, so
// there is one body to fix and the call site says which lexing it asked for.
//
// A line comment ends at CR as well as LF, because Postgres spells a comment's body `non_newline`,
// which is `[^\n\r]`, while SQLite reads on to the next LF. Ending one at LF alone made everything
// after a bare CR trivia here and a fresh statement there, so
// `SELECT 1 AS s; -- x<CR> TRUNCATE TABLE t` passed the gate and Postgres's simple query protocol
// executed both halves.
//
// Taking the shorter of the two readings is *not* on its own the conservative direction, and an
// earlier version of this comment said it was. Ending the comment early exposes whatever follows the
// CR — and if that is a `/*`, this walk then runs past the LF that would have closed SQLite's line
// comment, so the composed walk skips *more* than SQLite does and a `;` hides in the difference.
// `SELECT 1 AS s --x<CR>/*y<LF>; DROP TABLE t --*/ AS z` is a `SELECT` here and a real second
// statement on SQLite and libSQL, both of which execute the DROP. There is no single reading of a
// line comment that is safe on every engine, which is why the CR rule is paired with
// `sqlTheEnginesLexDifferently` refusing every input the two readings draw a different verdict from,
// rather than left to lean.
//
// Block comments are deliberately not nested, though Postgres nests them, and that is *not* safe by
// leaning — the earlier version of this comment claimed it was, and was wrong. A non-nesting walk
// ends such a comment earlier than Postgres, so it sees content the engine is still commenting out,
// and `readFirstSqlToken` then takes the statement's first token from inside a Postgres comment:
// `/*/* */ SELECT 1 */ TRUNCATE TABLE t` read as a `SELECT` here and a `TRUNCATE` there. Nesting
// instead would open the mirror hole on the engines that do not nest. Neither reading is right about
// all three, so `sqlTheEnginesLexDifferently` runs first and refuses every comment whose non-nesting
// end differs from where a nesting lexer would end it. What reaches this walk is therefore only
// comments the two rules close in the same place — which is a derived property rather than a claim
// about how the text looks, because the two attempts to describe that shape in text each missed a
// case.
//
// Everything here is written inline rather than factored into further helpers, and **that is now a
// judgement rather than a constraint.** It used to be the constraint, and the sentence that said so
// is the one the runtime-bundle PRD quotes as the whole problem: the generated server bundle was
// assembled from the source text of the functions in `SERVER_RUNTIME_SOURCE_FUNCTIONS`, so a helper
// this one called had to travel with it or become a `ReferenceError` in a deployed Capsule. It no
// longer has to. This file is a module and both bundlers carry it whole (ADR-0041), so a helper
// costs a `function` keyword and nothing else — `nestingBlockCommentEnd` and `opensQuotedRun` above
// are two taken on exactly those terms.
//
// What keeps this body inline is what should have been keeping it inline all along: it is one lexer
// reading one character at a time, its branches share `sql`, `index` and `dialect` and nothing else,
// and cutting it up would move the reader further from the question "what does the engine do with
// the character here". Extracting from it is now an ordinary edit that fails the build if it is
// wrong, so the next person to want a helper here should take one.
export function skipSqlQuotedOrCommented(sql: string, index: number, dialect: any) {
  if (dialect.comments && sql[index] === "/" && sql[index + 1] === "*") {
    const end = sql.indexOf("*/", index + 2);
    return end === -1 ? sql.length : end + 2;
  }
  if (dialect.comments && sql[index] === "-" && sql[index + 1] === "-") {
    // Which terminator this is asked with is the caller's, not a default. The separator walk and
    // the strip run under Postgres's, `sqlContentFingerprint` runs the same walk under both and
    // refuses a disagreement, and the keyword scan runs under both and unions the hits — a verb one
    // reading hides behind a comment and the other exposes is still a verb.
    const end = (dialect.lineCommentEndsAtCarriageReturn ? /[\n\r]/ : /\n/).exec(sql.slice(index + 2));
    return end ? index + 2 + end.index + 1 : sql.length;
  }

  // Postgres's two forms are recognised only where Postgres's own longest-match lexer would
  // recognise them, which is why both are guarded on the preceding character. `$` and `E` are
  // ordinary identifier characters there — as is every non-ASCII byte — so `t1$$` is the identifier
  // `t1$$` followed by a stray delimiter, and `aE'…'` is the identifier `aE` followed by an
  // ordinary string. Reading either as one literal is how a `;` hides: `validateReadOnlyInspectionSql`
  // permits exactly one trailing semicolon precisely so that a second statement cannot reach
  // Postgres's simple query protocol, which executes multi-statement strings.
  //
  // Guarded on the dialect first so the keyword scan, which asks for neither form, does not pay for
  // the lookbehind at every character of every statement it walks.
  const opensToken =
    (dialect.dollarQuoting || dialect.escapeStrings) && !/[A-Za-z0-9_$\u0080-\uffff]/.test(sql[index - 1] ?? "");

  // A dollar-quoted string ends at the first repeat of its own opening delimiter, tag and all.
  //
  // A tag is spelled with the identifier alphabet above less the `$`, non-ASCII included, because
  // that is the alphabet Postgres spells one with. The two rules have to name the same set or they
  // contradict each other, and they did: while the tag alphabet was ASCII-only, `$é$a--b$é$` was a
  // literal to the engine and a stray delimiter here, so the strip severed it and the validator
  // refused a `;` inside it. Widening the guard without widening this is the same bug mirrored.
  //
  // An unterminated one is deliberately not skipped at all, whatever the dialect says about the
  // plain quoting forms below. That is the conservative direction: the walk reads straight on
  // through the content, so a `;` inside it stays a separator and the validator refuses. Nothing
  // legal is lost, because every engine also refuses to parse the input.
  if (dialect.dollarQuoting && sql[index] === "$" && opensToken) {
    const delimiter = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(index))?.[0];
    if (!delimiter) {
      return index;
    }
    const end = sql.indexOf(delimiter, index + delimiter.length);
    return end === -1 ? index : end + delimiter.length;
  }

  // An E-string takes both escape regimes: `\` escapes whatever follows it, and `''` still doubles.
  // An ordinary `'…'` takes only the doubling, which is why this cannot be folded into the loop
  // below — the two are different quoting regimes sharing a delimiter, and a backslash is content
  // in one and punctuation in the other.
  if (dialect.escapeStrings && (sql[index] === "E" || sql[index] === "e") && sql[index + 1] === "'" && opensToken) {
    let cursor = index + 2;
    while (cursor < sql.length) {
      if (sql[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (sql[cursor] === "'") {
        if (sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return index;
  }

  const quote = sql[index];
  const closingQuote = quote === "[" ? "]" : quote;
  if (quote === undefined || !dialect.quotes.includes(quote)) {
    return index;
  }

  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === closingQuote) {
      if (quote !== "[" && sql[cursor + 1] === closingQuote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  // An unterminated run. The walks that answer "where does this statement end" want the whole
  // remainder swallowed, so a `;` after an unclosed quote is not read as a separator in text no
  // engine can parse. `readSqlQuotedIdentifier` wants the opposite and asks for it by name.
  return dialect.unterminatedQuotedRunReachesEndOfInput ? sql.length : index;
}

// Whether the run starting at `index` is a quoted literal rather than a comment.
//
// The two callers that have to tell content from trivia — `sqlContentFingerprint` and
// `sqlWithoutTrailingTerminator` — reach this after the union profile has already stepped over a
// run, and ask it of the same tokenizer under a dialect that recognises only quoting. A run this
// also recognises is a literal; a run it does not is a comment. Derived from the tokenizer rather
// than re-tested against the two characters that opened the run, so it cannot fall out of step with
// what the tokenizer actually did.
//
// **The second helper extracted on the new terms, and the more ordinary of the two.** It was two
// copies of the same two lines, one of them on the write path through
// `sqlWithoutTrailingTerminator`, kept apart for no reason except that a helper had to be registered
// in `SERVER_RUNTIME_SOURCE_FUNCTIONS` to survive into a deployed Capsule. Two copies of a rule
// about where a literal ends is exactly the shape ADR-0038's defect history is made of, at a smaller
// scale. Nothing had to be registered to remove it; see `nestingBlockCommentEnd` and ADR-0041.
function opensQuotedRun(sql: string, index: number) {
  return skipSqlQuotedOrCommented(sql, index, sqlDialectQuotedRunsOnly()) > index;
}

// One statement's text with its terminating semicolon and any trailing whitespace or comment
// removed, for the callers that have to embed it in more SQL. The walk asks the one tokenizer for
// the same dialect the read-only inspection validator asks for, so a semicolon or a `--` inside a
// string literal is text rather than a terminator: `SELECT '--not a comment' AS s` keeps every
// character it had.
//
// Trailing trivia goes with the terminator because a line comment is the worse of the two. A
// semicolon makes the embedding a syntax error, which is at least loud; an unterminated line
// comment silently eats whatever the embedder appends.
//
// Whitespace is spelled `[ \t\n\r\f]` rather than `\s` for the reason given on `skipSqlTrivia`:
// those five characters are what the engines call whitespace, and every wider character JavaScript
// would have matched is content to them.
export function sqlWithoutTrailingTerminator(sql: any) {
  const text = String(sql ?? "");
  const dialect = sqlDialectEveryEngineQuotes(true);
  let index = 0;
  let contentEnd = 0;
  while (index < text.length) {
    const skipped = skipSqlQuotedOrCommented(text, index, dialect);
    if (skipped > index) {
      // A quoted string is content and ends the statement's text at its closing quote; a comment
      // is not content, so it never moves the end forward.
      if (opensQuotedRun(text, index)) {
        contentEnd = skipped;
      }
      index = skipped;
      continue;
    }
    if (text[index] === ";") {
      break;
    }
    if (!/[ \t\n\r\f]/.test(text[index])) {
      contentEnd = index + 1;
    }
    index += 1;
  }
  return text.slice(0, contentEnd);
}

// Whitespace and comments, skipped the way the engines skip them rather than the way JavaScript
// would. Both halves of that mattered, and both were wrong in the same direction — treating as
// trivia what the engine treats as content, which is how "nothing follows the terminator" gets
// answered about a second statement.
//
// Whitespace is `[ \t\n\r\f]`, which is the set measured against the engines rather than read off
// their grammars: `SELECT<c>1 AS a` is accepted for each of those five on SQLite, libSQL and
// Postgres alike, and rejected by all three for vertical tab — `unrecognized token` on the first
// two and `syntax error at or near` on Postgres — so `\v` is not whitespace anywhere here despite
// appearing in Postgres's published `space` class. JavaScript's `\s` matches it, and also NBSP,
// U+1680, the U+2000 block, the line and paragraph separators, U+3000 and the BOM, every one of
// which is an *identifier* character to Postgres. Skipping any of them said a query ended where the
// engine reads on, so `sqlTheEnginesLexDifferently` refuses one outside a quoted run rather than
// leaving the operator to read "not read-only" about a pasted non-breaking space.
//
// Where a comment ends is not decided here. This asks the one tokenizer for `sqlDialectCommentsOnly`
// — comments recognised, quoting not, because a string literal is content and has to stop trivia —
// and loops until neither a run of whitespace nor a comment advances it. A line comment ends at CR
// as well as LF for the reason set out on `skipSqlQuotedOrCommented`, and this used to be a third
// copy of that rule: the CR edit had to land here as well as in both skippers, and each fix in this
// file's history landed in one of the three and left the others.
//
// The terminator is required rather than defaulted, for the reason given on `readSqlTokens`. It
// defaulted to the carriage-return reading, which every caller here does want, so this is
// consistency rather than a fix — but a default is how a reading gets chosen by omission, and every
// call site naming the one it wants is the whole point of having made the difference an argument.
export function skipSqlTrivia(sql: string, startIndex: any, lineCommentEndsAtCarriageReturn: boolean) {
  const dialect = sqlDialectCommentsOnly(lineCommentEndsAtCarriageReturn);
  let index = startIndex;
  let advanced = true;
  while (advanced) {
    advanced = false;
    while (/[ \t\n\r\f]/.test(sql[index] ?? "")) {
      index += 1;
      advanced = true;
    }
    const skipped = skipSqlQuotedOrCommented(sql, index, dialect);
    if (skipped > index) {
      index = skipped;
      advanced = true;
    }
  }
  return index;
}
