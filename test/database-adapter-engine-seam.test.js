import assert from "node:assert/strict";
import test from "node:test";

import {
  createDatabaseDialect,
  createDatabaseNormalization,
  createSharedDatabaseAdapterMethods,
  createSqliteDatabaseAdapter,
  libsqlRowNormalization,
  postgresDatabaseDialect,
  postgresRowNormalization,
  sqlWithoutTrailingTerminator,
  sqliteDatabaseDialect,
  sqliteRowNormalization,
  validateReadOnlyInspectionSql,
} from "../dist/server-runtime-source.js";
import {
  POSTGRES_SKIP_REASON,
  withLibsqlAdapter,
  withPostgresAdapter,
  withSqliteAdapter,
} from "./support/database-adapter-engines.js";
import { databaseAdapterMethodNames, overriddenDatabaseAdapterMethodNames } from "./support/database-adapter-method-coverage.js";

// The engine seam, asserted as a property rather than counted once in a commit message (ADR-0037).
//
// A Database engine supplies three things: statement primitives with their connection and
// transaction session mechanics, a dialect, and row and value normalization. Every behavioural
// method body comes from the shared method set. Before this seam existed the count of per-engine
// behavioural overrides was the only measure of how close the codebase was to that, and a count is
// something a reader has to recompute; these tests are the same claim written so the build keeps
// it.
//
// This is not a restatement of the conformance specification, which asks whether the engines agree
// on the answers. It asks the structural question the specification cannot: whether an engine has
// a place to disagree from.

// The five things a Database engine is allowed to supply for itself. Each is already exempt from
// the conformance coverage gate under one of the three ADR-0035 mechanics — connection lifecycle,
// SQL dialect emission, transaction session mechanics — which is the same line drawn from the
// other side.
const ENGINE_MECHANICS = ["close", "exec", "prepare", "withReadOnlySnapshot", "withTransaction"];

const ENGINES = [
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter },
];

async function withSharedMethodReference(fn) {
  const reference = await createSqliteDatabaseAdapter(":memory:");
  try {
    return await fn(reference);
  } finally {
    reference.close();
  }
}

for (const engine of ENGINES) {
  test(`an engine supplies no behavioural method body of its own: ${engine.name}`, { skip: engine.skip }, async () => {
    const overridden = await engine.withAdapter(
      async (adapter) => withSharedMethodReference((shared) => overriddenDatabaseAdapterMethodNames(shared, adapter)),
      { appTableNames: [] },
    );

    assert.deepEqual(
      overridden.sort(),
      ENGINE_MECHANICS,
      `${engine.name} replaces a shared Database adapter method body. A difference the engines genuinely have ` +
      "belongs in the dialect or in row normalization, which ADR-0034 licenses; a replacement method body is " +
      "how a behavioural divergence gets in, and how the shared definition it shadows stays wrong and dormant.",
    );
  });

  // Issue 09's reviewer flagged that `migrateAppSchema` reaches the in-transaction table rebuild
  // directly rather than through `migrateExistingAppTable` — it has to, because libSQL's
  // transaction adapter throws on a nested `withTransaction` — and that a future engine's override
  // of that method would therefore be silently bypassed from inside a migration. The seam is the
  // answer: an engine has nowhere to put such an override. The bypass now skips a transaction
  // wrapper and nothing else, and this is the case that keeps saying so if the seam ever slips.
  test(`the migration's direct table rebuild bypasses no engine definition: ${engine.name}`, { skip: engine.skip }, async () => {
    const overridden = await engine.withAdapter(
      async (adapter) => withSharedMethodReference((shared) => overriddenDatabaseAdapterMethodNames(shared, adapter)),
      { appTableNames: [] },
    );
    assert.equal(overridden.includes("migrateExistingAppTable"), false);
    assert.equal(overridden.includes("createAppTable"), false);
    assert.equal(overridden.includes("referenceExists"), false);
  });

  test(`an engine declares a dialect and a normalization: ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(
      async (adapter) => {
        assert.equal(typeof adapter.dialect?.name, "string");
        assert.equal(typeof adapter.normalization?.name, "string");
        // Reached through the adapter rather than passed alongside it, so a module-level helper the
        // shared method set delegates to cannot emit a different engine's SQL than its caller.
        assert.equal(typeof adapter.dialect.quoteIdentifier, "function");
        assert.equal(typeof adapter.normalization.row, "function");
      },
      { appTableNames: [] },
    );
  });
}

test("SQLite is an engine like the others, not the set the others borrow from", async () => {
  await withSqliteAdapter(async (adapter) => {
    assert.equal(adapter.dialect.name, "sqlite");
    assert.equal(adapter.normalization.name, "sqlite");
  });

  // The shared set is reachable without any engine at all, which is the mechanical form of "no
  // adapter obtains its methods by constructing another engine's adapter".
  const shared = createSharedDatabaseAdapterMethods(sqliteDatabaseDialect());
  const sharedNames = databaseAdapterMethodNames(shared);
  assert.ok(sharedNames.includes("emailCredentialExists"));
  assert.deepEqual(sharedNames.filter((name) => ENGINE_MECHANICS.includes(name)), []);

  await withSqliteAdapter(async (adapter) => {
    assert.deepEqual(
      databaseAdapterMethodNames(adapter),
      [...sharedNames, ...ENGINE_MECHANICS].sort(),
      "the SQLite adapter is the shared method set plus the five engine mechanics, and nothing else",
    );
  });
});

// An engine that cannot ask a statement for its result shape has to embed the statement in more
// SQL, and embedding is where a trailing terminator or comment stops being decoration. The
// conformance specification asserts that the engines agree about such a query; this asserts the
// piece of machinery they agree through, including the shapes a conformance case would need a
// contrived query to reach.
test("a statement's text can be taken without its terminator or trailing trivia", () => {
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1;"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 ; "), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 -- why"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1; -- why"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 /* why */"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1\n-- why\n"), "SELECT 1");

  // Nothing inside a string literal is punctuation. An over-eager strip would truncate the first
  // of these to `SELECT ` and change what the second one answers.
  assert.equal(sqlWithoutTrailingTerminator("SELECT '-- not a comment' AS s"), "SELECT '-- not a comment' AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 'a;b' AS s;"), "SELECT 'a;b' AS s");
  assert.equal(sqlWithoutTrailingTerminator(`SELECT "odd;name" FROM t;`), `SELECT "odd;name" FROM t`);

  // A statement that is only trivia has no text, and neither null nor undefined may throw.
  assert.equal(sqlWithoutTrailingTerminator("-- nothing here"), "");
  assert.equal(sqlWithoutTrailingTerminator(";"), "");
  assert.equal(sqlWithoutTrailingTerminator(null), "");
  assert.equal(sqlWithoutTrailingTerminator(undefined), "");
});

// Postgres has two string forms the other two engines have no spelling for at all: dollar quoting
// (`$$…$$`, `$tag$…$tag$`) and E-strings, where a backslash escapes the next character. One
// tokenizer serves both callers, so what it does not recognise both of them get wrong — the
// validator read a `;` inside such a literal as a statement separator and refused a legal query,
// and the strip read a `--` inside one as trailing trivia and cut there, severing the literal.
test("a statement's text survives a dollar-quoted or an E-string literal", () => {
  // Everything between the delimiters is content, whatever it looks like.
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a--b$$ AS s"), "SELECT $$a--b$$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a/*b$$ AS s"), "SELECT $$a/*b$$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a;b$$ AS s;"), "SELECT $$a;b$$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $tag$a--b$tag$ AS s"), "SELECT $tag$a--b$tag$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$--$$ AS s"), "SELECT $$--$$ AS s");

  // A tag is spelled with Postgres's identifier alphabet less the `$`, which means every non-ASCII
  // character too — the same alphabet the guard below counts as continuing an identifier. The two
  // rules have to name one alphabet or they disagree with each other, and the engine takes all of
  // these tags.
  assert.equal(sqlWithoutTrailingTerminator("SELECT $é$a--b$é$ AS s"), "SELECT $é$a--b$é$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $日$a--b$日$ AS s"), "SELECT $日$a--b$日$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $ñx$a;b$ñx$ AS s;"), "SELECT $ñx$a;b$ñx$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $µ$a--b$µ$ AS s"), "SELECT $µ$a--b$µ$ AS s");

  // A literal closes at the first occurrence of its own delimiter, which is what Postgres does, so
  // an inner delimiter that only looks like nesting is content rather than a close.
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a$x$b$$ AS s"), "SELECT $$a$x$b$$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $a$x$b$y$a$ AS s"), "SELECT $a$x$b$y$a$ AS s");

  // Trailing trivia after such a literal is still trivia.
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a$$ AS s -- why"), "SELECT $$a$$ AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a$$ AS s; -- why"), "SELECT $$a$$ AS s");

  // E-strings, in both spellings. The backslash escape is the whole of the difference from an
  // ordinary string, and the two regimes share a delimiter, so `''` doubling has to keep closing
  // both of them and a backslash has to keep being content in the ordinary one.
  assert.equal(sqlWithoutTrailingTerminator("SELECT E'a\\'--b' AS s"), "SELECT E'a\\'--b' AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT e'a\\';b' AS s;"), "SELECT e'a\\';b' AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT E'a''--b' AS s"), "SELECT E'a''--b' AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 'a''--b' AS s"), "SELECT 'a''--b' AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 'a\\'; b"), "SELECT 'a\\'");

  // `$` and `E` are ordinary identifier characters to Postgres, whose lexer takes the longest
  // match, so `t1$$` is the identifier `t1$$` and `aE` is the identifier `aE`. Neither opens a
  // literal. This is the same judgement the injection case below depends on, asserted here on the
  // text so a change to it shows up as a strip result rather than only as a verdict.
  assert.equal(sqlWithoutTrailingTerminator("SELECT t1$$;b$$ AS s"), "SELECT t1$$");
  assert.equal(sqlWithoutTrailingTerminator("SELECT aE'x\\';y' AS s"), "SELECT aE'x\\'");

  // An unterminated literal is not a literal. Leaving it unskipped is the conservative direction:
  // the walk reads on through its content, so a `;` inside stays a separator and the validator
  // refuses. No legal query is lost, because every engine also refuses to parse this.
  assert.equal(sqlWithoutTrailingTerminator("SELECT $$a; b"), "SELECT $$a");
  assert.equal(sqlWithoutTrailingTerminator("SELECT $a$x$b$ AS s"), "SELECT $a$x$b$ AS s");
});

test("a read-only inspection query may hold a separator inside a dollar-quoted or an E-string literal", () => {
  for (const sql of [
    "SELECT $$a;b$$ AS s",
    "SELECT $tag$a;b$tag$ AS s",
    "SELECT $ñx$a;b$ñx$ AS s",
    "SELECT $日$a;b$日$ AS s",
    "SELECT E'a\\';b' AS s",
    "SELECT e'a\\';b' AS s",
    // Plus the one trailing terminator the validator already admits, which is the shape a human
    // types and the reason the strip exists at all.
    "SELECT $$a;b$$ AS s;",
  ]) {
    assert.equal(
      validateReadOnlyInspectionSql(sql).ok,
      true,
      `a literal's contents were read as punctuation: ${sql}`,
    );
  }
});

// `validateReadOnlyInspectionSql` permits exactly one trailing semicolon so that a second statement
// cannot be smuggled in, and Postgres's simple query protocol will execute a multi-statement string
// if one gets through. This tokenizer is the whole of that defence for a second statement that is
// itself read-only, so every quoting form it learns is a new place to hide a separator.
//
// Half of these smuggle a `SELECT 2` rather than a `DROP`, deliberately. A `DROP` in a second
// statement is refused twice over, because the side-effect keyword scan reads it through a
// different tokenizer that still knows nothing of these two forms — so an attempt carrying one
// cannot tell whether the separator walk refused it or the keyword scan did. A second `SELECT`
// leaves only the walk, which is the part this issue changed. Perturbing either of the walk's two
// defensive decisions admits an attempt below: dropping the identifier-prefix guard admits the two
// `t1$$` and `aE'` forms, and swallowing an unterminated dollar quote to the end of the input
// instead of declining to treat it as a literal admits the two after them.
const INJECTION_ATTEMPTS = [
  // The plain forms, for the boundary the new quoting shares with every other.
  "SELECT 1; DROP TABLE sporades_injection_canary",
  "SELECT 1; SELECT 2",
  "SELECT $$a$$; DROP TABLE sporades_injection_canary",
  "SELECT $$a$$ AS s; SELECT 2",
  "SELECT $tag$a$tag$; DROP TABLE sporades_injection_canary",
  "SELECT $tag$a$tag$ AS s; SELECT 2",

  // A `$$` or an `E'` that continues an identifier opens nothing, because Postgres lexes `t1$$` as
  // the identifier `t1$$` and `aE` as the identifier `aE`. The `;` after either really does
  // separate statements, and the trailing `--$$` or `--'` really is a comment rather than a closing
  // delimiter. Read as one literal, each of these is a parsed and executed second statement.
  "SELECT t1$$; SELECT 2; --$$",
  "SELECT aE'\\'; SELECT 2; --'",
  "SELECT t1$$; DROP TABLE sporades_injection_canary; --$$",
  "SELECT aE'\\'; DROP TABLE sporades_injection_canary; --'",

  // The same hole reached through a non-ASCII identifier, which is the arm of the guard the wider
  // tag alphabet puts under most pressure. Both of these really are two statements to Postgres —
  // `SELECT 1 AS café$$; SELECT 2; --$$` returns two result sets when handed to the engine raw.
  "SELECT 1 AS café$$; SELECT 2; --$$",
  "SELECT 1 AS t1$$; SELECT 2; --$$",
  "SELECT 1 AS café$$; DROP TABLE sporades_injection_canary; --$$",

  // A tag that almost matches never closes the literal, and neither does an absent close. The
  // near-miss pairs differ only in a non-ASCII character, which is the shape a wider tag alphabet
  // makes newly possible.
  "SELECT $a$x$b$; SELECT 2",
  "SELECT $$x; SELECT 2",
  "SELECT E'x\\'; SELECT 2",
  "SELECT $é$a$è$; SELECT 2",
  "SELECT $é$x; SELECT 2",
  "SELECT $日$a$本$; SELECT 2",
  "SELECT $a$x$b$; DROP TABLE sporades_injection_canary",
  "SELECT $$x; DROP TABLE sporades_injection_canary",
  "SELECT E'x\\'; DROP TABLE sporades_injection_canary",
  "SELECT $é$a$è$; DROP TABLE sporades_injection_canary",
  "SELECT $é$x; DROP TABLE sporades_injection_canary",

  // Nesting-shaped input closes at its first matching delimiter, exactly as Postgres does, so the
  // separator after it is outside the literal.
  "SELECT $$a$x$b$$; SELECT 2",
  "SELECT $$a$$ || $$b$$; SELECT 2",
  "SELECT $é$a$è$b$é$; SELECT 2",
  "SELECT $$a$x$b$$; DROP TABLE sporades_injection_canary",
  "SELECT $$a$$ || $$b$$; DROP TABLE sporades_injection_canary",
  "SELECT $é$a$è$b$é$; DROP TABLE sporades_injection_canary",

  // A delimiter inside a comment cannot re-open a literal that already closed.
  "SELECT $$a$$ AS s; SELECT 2 -- $$",
  "SELECT $$a$$ AS s; /* $$ */ SELECT 2",
  "SELECT $$a$$ AS s; DROP TABLE sporades_injection_canary -- $$",
  "SELECT $$a$$ AS s; /* $$ */ DROP TABLE sporades_injection_canary",
  "SELECT $$a$$ AS s; DROP TABLE sporades_injection_canary; --$$",

  // A write hidden inside what the walk now reads as one literal. Postgres agrees it is a literal
  // and would answer these as ordinary strings, so refusing them is a conservative false reject
  // rather than a claim they are dangerous there. It is not conservative on the other two engines,
  // which have no dollar quoting and read a real second statement — and the refusal comes from the
  // side-effect keyword scan, which reads the whole statement through the separate tokenizer that
  // deliberately still knows nothing of these forms. Widening that one too would trade this belt
  // for nothing.
  "SELECT $$a; DROP TABLE sporades_injection_canary$$ AS s",
  "SELECT $$a; DELETE FROM sporades_injection_canary$$ AS s",
  "SELECT $tag$a; DROP TABLE sporades_injection_canary$tag$ AS s",
  "SELECT $é$a; DROP TABLE sporades_injection_canary$é$ AS s",
  "SELECT E'a\\'; DROP TABLE sporades_injection_canary' AS s",
];

// A line comment ends at a carriage return as well as at a line feed, because that is where the
// engine ends one: Postgres spells the body of a `--` comment `[^\n\r]`. The walk ended one at a
// line feed alone, so everything after a bare CR was trivia to the walk and a fresh statement to
// the engine — the walk saw one statement ending at the visible `;` and Postgres's simple query
// protocol executed all of it. `TRUNCATE` and `DO` are the payloads here rather than `DROP`
// because neither is in the side-effect keyword scan, which isolates the walk: with a `DROP` a
// refusal could not tell you which of the two defences produced it, and the point of these is that
// the second one has holes that no list will close.
//
// SQLite ends a line comment at a line feed alone, so the walk is now stricter than SQLite and
// exactly as strict as Postgres. That is the direction one shared verdict has to take: the walk
// takes the shortest comment any engine would take, so a `;` it admits is a `;` no engine can be
// hiding.
const LINE_ENDING_INJECTION_ATTEMPTS = [
  "SELECT 1 AS s; -- x\r TRUNCATE TABLE sporades_injection_canary",
  "SELECT 1 AS s; -- x\r DELETE FROM sporades_injection_canary",
  "SELECT 1 AS s; -- x\r SELECT 2",
  "SELECT 1 AS s;\r-- x\r SELECT 2",
  "SELECT 1 AS s; /* y */ -- x\r SELECT 2",
  "SELECT 1 AS s; -- x\r DO $z$ BEGIN EXECUTE 'DELETE FROM sporades_injection_canary'; END $z$",
  "SELECT 1 AS s; -- x\r COMMENT ON TABLE sporades_injection_canary IS 'owned'",
  // The comment need not be the trailing one, and the CR need not be the first line ending.
  "SELECT 1 -- x\r AS s; -- y\r TRUNCATE TABLE sporades_injection_canary",
  "SELECT 1 AS s; -- x\n-- y\r TRUNCATE TABLE sporades_injection_canary",
];

// The same species one level down: text the walk reads is not always the text the engine receives.
// The dollar-quote tag alphabet is a UTF-16 code-unit range, so an unpaired surrogate counts as a
// tag character — and Node folds every unpaired surrogate to U+FFFD on the wire, so two tags that
// differ here are one tag to Postgres. The walk reads `$\ud800$a$\ud801$` as an open literal that
// closes at the far `$\ud800$`, hiding both separators; Postgres reads `$�$a$�$` and
// closes at the first one, leaving a second statement it will parse.
//
// These were already refused before this issue, but by accident: hiding a `;` makes the strip the
// identity, and the raw multi-statement text then fails to parse inside the `columns()` wrap. The
// refusal has to come from the validator, so the assertion is on the reason.
const UNREPRESENTABLE_TEXT_ATTEMPTS = [
  "SELECT $\ud800$a$\ud801$; TRUNCATE TABLE sporades_injection_canary; SELECT $\ud802$b$\ud800$",
  "SELECT $\ud800$a$\ud801$; SELECT 2; SELECT $\ud802$b$\ud800$",
  "SELECT $\udc00$a$\udc01$; TRUNCATE TABLE sporades_injection_canary; SELECT $\udc02$b$\udc00$",
  // A NUL terminates the string Postgres reads off the wire, so the text after it is checked here
  // and never seen there. Truncation cannot smuggle a statement, but validating text the engine
  // will not receive is the same fault, and it is refused for the same reason.
  "SELECT 1 AS s\0; TRUNCATE TABLE sporades_injection_canary",
];

const UNREPRESENTABLE_TEXT_MESSAGE = "Only SQL text the database receives unchanged is allowed.";

test("no second statement hides inside a dollar-quoted or an E-string literal", () => {
  for (const sql of [...INJECTION_ATTEMPTS, ...LINE_ENDING_INJECTION_ATTEMPTS]) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a second statement was admitted: ${JSON.stringify(sql)}`);
    assert.equal(validation.error.message, "Only read-only SQL is allowed.");
  }

  for (const sql of UNREPRESENTABLE_TEXT_ATTEMPTS) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a second statement was admitted: ${JSON.stringify(sql)}`);
    assert.equal(
      validation.error.message,
      UNREPRESENTABLE_TEXT_MESSAGE,
      `refused for the wrong reason, which is the accident this issue exists to replace: ${JSON.stringify(sql)}`,
    );
  }
});

// Trivia is the other half of the same disagreement, and CR was not the only instance. JavaScript's
// `\s` matches NBSP, the Unicode spaces, the line and paragraph separators and the BOM; Postgres
// spells its whitespace `[ \t\n\r\f\v]` and SQLite's `sqlite3Isspace` is the same six characters,
// and every one of the wider set is an *identifier* character to Postgres. A walk that skips them
// reports "nothing follows the terminator" about text the engine will try to parse.
test("only the whitespace every engine calls whitespace is trivia", () => {
  for (const space of ["\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    const escaped = JSON.stringify(space);
    assert.equal(
      validateReadOnlyInspectionSql(`SELECT 1 AS s;${space}`).ok,
      false,
      `text after the terminator was skipped as whitespace: ${escaped}`,
    );
    assert.equal(
      validateReadOnlyInspectionSql(`${space}SELECT 1 AS s`).ok,
      false,
      `text before the first token was skipped as whitespace: ${escaped}`,
    );
  }

  for (const space of [" ", "\t", "\n", "\r", "\f", "\v"]) {
    const escaped = JSON.stringify(space);
    assert.equal(validateReadOnlyInspectionSql(`SELECT 1 AS s;${space}`).ok, true, `refused real whitespace: ${escaped}`);
    assert.equal(validateReadOnlyInspectionSql(`${space}SELECT 1 AS s`).ok, true, `refused real whitespace: ${escaped}`);
  }
});

// The refusal above is about surrogates that are *unpaired*. A paired one is an ordinary character
// that survives the wire intact, and Postgres spells a tag with every non-ASCII character, so an
// astral tag is a legal tag and must keep working.
test("an astral dollar-quote tag is a tag, not unrepresentable text", () => {
  assert.equal(validateReadOnlyInspectionSql("SELECT $\u{1f600}$a;b$\u{1f600}$ AS s").ok, true);
  assert.equal(
    sqlWithoutTrailingTerminator("SELECT $\u{1f600}$a--b$\u{1f600}$ AS s;"),
    "SELECT $\u{1f600}$a--b$\u{1f600}$ AS s",
  );
  assert.equal(validateReadOnlyInspectionSql("SELECT $\u{1f600}$a$\u{1f601}$; SELECT 2").ok, false);
});

// The strip is the other caller of the same walk, so the terminator fix has to show up there too:
// a bare CR ends the comment, and the text after it is content the strip must not swallow.
test("a statement's text keeps what follows a carriage-return-ended comment", () => {
  // The comment is interior once it ends at the CR, so the text after it is content the strip
  // keeps — where before it read to the end of the input and cut the statement down to `SELECT 1`.
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 -- why\r AS s"), "SELECT 1 -- why\r AS s");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 -- why\r"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1 -- why\r\n"), "SELECT 1");
  assert.equal(sqlWithoutTrailingTerminator("SELECT 1;\r-- why\r"), "SELECT 1");
});

// The strip's failure was never silent — a severed literal is a syntax error rather than a wrong
// answer — but loud on Postgres while the input is quietly accepted elsewhere is still the
// divergence class this specification exists to close. This is the call site, run for real: the
// Postgres `columns()` primitive strips the terminator before wrapping the statement in a subquery.
test("Postgres describes a statement whose literal holds a comment marker", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(
    async (adapter) => {
      for (const [sql, value] of [
        ["SELECT $$a--b$$ AS s", "a--b"],
        ["SELECT $$a/*b$$ AS s", "a/*b"],
        ["SELECT $tag$a--b$tag$ AS s", "a--b"],
        ["SELECT $é$a--b$é$ AS s", "a--b"],
        ["SELECT $日$a--b$日$ AS s", "a--b"],
        ["SELECT $ñx$a;b$ñx$ AS s;", "a;b"],
        ["SELECT $µ$a/*b$µ$ AS s", "a/*b"],
        ["SELECT $$a;b$$ AS s", "a;b"],
        ["SELECT $$a;b$$ AS s;", "a;b"],
        ["SELECT $$a--b$$ AS s; -- keep this around", "a--b"],
        ["SELECT E'a\\'--b' AS s", "a'--b"],
        ["SELECT E'a\\';b' AS s;", "a';b"],
        // A tag whose character is astral. The pair survives the wire intact, so this really is one
        // tag to Postgres — which is what makes the unpaired case a refusal about representability
        // rather than about non-ASCII tags.
        ["SELECT $\u{1f600}$a--b$\u{1f600}$ AS s", "a--b"],
        ["SELECT $\u{1f600}$a;b$\u{1f600}$ AS s;", "a;b"],
        // A comment ended by a bare carriage return, answered rather than swallowed.
        ["SELECT 1 AS s -- why\r", 1],
      ]) {
        const result = await adapter.runReadOnlyInspectionQuery(sql);
        assert.equal(result.ok, true, `${sql}: ${result.error?.message}`);
        assert.deepEqual(result.data.columns, ["s"]);
        assert.deepEqual(result.data.rows.map((row) => row.s), [value]);
      }
    },
    { appTableNames: [] },
  );
});

// Postgres is the engine that would execute a smuggled statement, but the validator is shared, so
// the claim is worth making against every engine rather than only the one that could be hurt by it.
for (const engine of [{ name: "SQLite", skip: false, withAdapter: withSqliteAdapter }, ...ENGINES]) {
  test(`no injection attempt reaches a second statement: ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(
      async (adapter) => {
        await adapter.exec("CREATE TABLE sporades_injection_canary (id TEXT PRIMARY KEY)");
        try {
          await adapter.exec("INSERT INTO sporades_injection_canary (id) VALUES ('alive')");
          const attempts = [
            ...INJECTION_ATTEMPTS.map((sql) => [sql, "Only read-only SQL is allowed."]),
            ...LINE_ENDING_INJECTION_ATTEMPTS.map((sql) => [sql, "Only read-only SQL is allowed."]),
            ...UNREPRESENTABLE_TEXT_ATTEMPTS.map((sql) => [sql, UNREPRESENTABLE_TEXT_MESSAGE]),
          ];
          for (const [sql, message] of attempts) {
            const result = await adapter.runReadOnlyInspectionQuery(sql);

            // The canary is read back after every attempt rather than once at the end, so a failure
            // names the attempt that emptied it instead of leaving the battery to be bisected.
            const alive = await adapter.runReadOnlyInspectionQuery("SELECT id FROM sporades_injection_canary");
            assert.equal(alive.ok, true, alive.error?.message);
            assert.deepEqual(
              alive.data.rows.map((row) => row.id),
              ["alive"],
              `a second statement reached the engine: ${JSON.stringify(sql)}`,
            );

            assert.equal(result.ok, false, `an injection attempt was admitted: ${JSON.stringify(sql)}`);
            assert.equal(
              result.error.message,
              message,
              `refused by the engine rather than by the validator, which is luck rather than a boundary: ${JSON.stringify(sql)}`,
            );
          }

          // Refused before the engine, and the canary is the proof that nothing ran anyway.
          const survivors = await adapter.runReadOnlyInspectionQuery("SELECT id FROM sporades_injection_canary");
          assert.equal(survivors.ok, true, survivors.error?.message);
          assert.deepEqual(survivors.data.rows.map((row) => row.id), ["alive"]);
        } finally {
          await adapter.exec("DROP TABLE IF EXISTS sporades_injection_canary");
        }
      },
      { appTableNames: ["sporades_injection_canary"] },
    );
  });
}

// A canary says nothing ran. This says nothing was sent, which is the stronger claim and the one
// that does not depend on the engine having refused what it was handed. libSQL is the engine whose
// harness can see every statement text, so it is where the claim is made; what it is a claim about
// is the shared method set, which is the same code on all three.
//
// Two things have to hold for it. The gate refuses the attempt, so no statement is prepared at all;
// and for anything the gate does admit, `runReadOnlyInspectionQuery` prepares the statement the
// gate accepted rather than the raw input, so a `;` the walk saw cannot be carried to the engine
// even if a later change lets one past the verdict.
test("no injection attempt is sent to the engine at all", async () => {
  const sent = [];
  const attempts = [...INJECTION_ATTEMPTS, ...LINE_ENDING_INJECTION_ATTEMPTS, ...UNREPRESENTABLE_TEXT_ATTEMPTS];
  const admitted = [];
  await withLibsqlAdapter(
    async (adapter) => {
      await adapter.exec("CREATE TABLE sporades_injection_canary (id TEXT PRIMARY KEY)");
      await adapter.exec("INSERT INTO sporades_injection_canary (id) VALUES ('alive')");

      // The recorder, proved against a query that does reach the engine, so an empty tape below is
      // a refusal rather than a hook that never fired.
      sent.length = 0;
      await adapter.runReadOnlyInspectionQuery("SELECT id FROM sporades_injection_canary;  -- trailing");
      assert.deepEqual(
        sent,
        ["SELECT id FROM sporades_injection_canary"],
        "the engine is handed the statement the gate accepted, without the terminator or the trivia after it",
      );

      sent.length = 0;
      for (const sql of attempts) {
        if ((await adapter.runReadOnlyInspectionQuery(sql)).ok) {
          admitted.push(sql);
        }
      }
    },
    {
      appTableNames: ["sporades_injection_canary"],
      service: {
        beforeStatement(sql) {
          sent.push(String(sql ?? ""));
        },
      },
    },
  );

  assert.deepEqual(admitted, [], "an injection attempt was admitted");
  assert.deepEqual(sent, [], "an injection attempt was handed to the engine");
});

// The acceptance criterion asks for one answer on all three engines, or the difference recorded as
// a genuine dialect divergence with its reason. It is the second, and unreachably so: dollar
// quoting and E-strings are not forms SQLite and libSQL spell differently, they are forms those
// engines do not have. `$…` is a bind parameter there, so `SELECT $$a--b$$ AS s` names one unbound
// parameter and answers NULL under a column named after the whole expression; `E'…'` is the column
// `E` beside a string, and resolves to nothing. No tokenizer in the Database adapter can close
// that, because the disagreement is in the engines' grammars rather than in anything this seam
// emits.
//
// What the seam can make uniform, and now does, is the verdict. `validateReadOnlyInspectionSql` is
// a shared definition, so a literal's contents are content on every engine and the query reaches
// the engine instead of being refused before it. Where the engines part is in parsing it.
//
// One residual belongs in the record rather than in a later rediscovery. Admitting a `;` inside a
// dollar-quoted literal means SQLite and libSQL now answer such a query quietly — they prepare the
// text up to the `;` and discard the rest — where before they refused it. That widens a divergence
// they already had, since they were already answering NULL for a dollar-quoted literal with no `;`
// in it, and the alternative is leaving Postgres wrong about its own syntax. The bound on it is the
// case above: a write inside such a literal stays refused on every engine.
test("a literal that only Postgres can spell diverges by dialect, not by seam", async () => {
  const dollarQuoted = "SELECT $$a--b$$ AS s";
  const eString = "SELECT E'a\\'--b' AS s";

  for (const sql of [dollarQuoted, eString]) {
    assert.equal(validateReadOnlyInspectionSql(sql).ok, true, `the shared verdict is not shared: ${sql}`);
  }

  for (const [name, withAdapter] of [["SQLite", withSqliteAdapter], ["libSQL", withLibsqlAdapter]]) {
    await withAdapter(
      async (adapter) => {
        const parameter = await adapter.runReadOnlyInspectionQuery(dollarQuoted);
        assert.equal(parameter.ok, true, `${name}: ${parameter.error?.message}`);
        assert.notDeepEqual(parameter.data.columns, ["s"], `${name} answered the literal after all`);
        assert.deepEqual(parameter.data.rows.map((row) => Object.values(row)), [[null]], name);

        const missingColumn = await adapter.runReadOnlyInspectionQuery(eString);
        assert.equal(missingColumn.ok, false, `${name} answered an E-string after all`);
        assert.match(missingColumn.error.message, /no such column: E/, name);
      },
      { appTableNames: [] },
    );
  }
});

test("a dialect that answers only some of the seam fails at construction", () => {
  // The failure a new engine will actually hit, and the point of making it a construction-time
  // error: an entry nobody wrote is otherwise discovered by the first statement that needed it,
  // which on this seam means in production on the engine nobody ran the suite against.
  assert.throws(
    () => createDatabaseDialect({ name: "mysql", quoteIdentifier: (name) => `\`${name}\`` }),
    (error) => {
      assert.match(error.message, /Incomplete Database adapter dialect/);
      assert.match(error.message, /columnType/);
      assert.match(error.message, /upsertSql/);
      assert.match(error.message, /addMissingColumn/);
      return true;
    },
  );

  assert.throws(
    () => createDatabaseNormalization({ name: "mysql", columnName: (name) => name }),
    (error) => {
      assert.match(error.message, /Incomplete Database adapter normalization/);
      assert.match(error.message, /value/);
      return true;
    },
  );

  // An entry written as null is the same gap as an entry not written at all, and is the likelier
  // of the two: it is what a placeholder looks like. Rejecting only `undefined` would let it
  // through construction and fail at the first statement that needed it, which is the failure this
  // factory exists to move forward.
  assert.throws(
    () => createDatabaseDialect({ ...sqliteDatabaseDialect(), upsertSql: null }),
    /Incomplete Database adapter dialect: upsertSql/,
  );
  assert.throws(
    () => createDatabaseNormalization({ name: "mysql", columnName: (name) => name, value: null }),
    /Incomplete Database adapter normalization: value/,
  );
});

test("every dialect answers the whole seam", () => {
  const entries = Object.keys(sqliteDatabaseDialect()).sort();
  assert.deepEqual(Object.keys(postgresDatabaseDialect()).sort(), entries);

  // Pinned rather than merely compared, so that adding an entry to the seam is a visible decision
  // in a diff and not a quiet widening of what an engine has to answer.
  assert.deepEqual(entries, [
    "addMissingColumn",
    "columnType",
    "describeColumns",
    "listTables",
    "name",
    "quoteIdentifier",
    "upsertSql",
  ]);
});

test("every normalization answers the whole seam", () => {
  const entries = ["columnName", "name", "row", "value"];
  assert.deepEqual(Object.keys(sqliteRowNormalization()).sort(), entries);
  assert.deepEqual(Object.keys(postgresRowNormalization()).sort(), entries);
  assert.deepEqual(Object.keys(libsqlRowNormalization()).sort(), entries);

  // `row` is derived from `columnName` and `value` rather than supplied, so an engine cannot apply
  // one and forget the other.
  assert.deepEqual(postgresRowNormalization().row({ verifierhash: "hashed", selector: "abc" }), {
    verifierHash: "hashed",
    selector: "abc",
  });
  assert.deepEqual(libsqlRowNormalization().row({ attempts: { type: "integer", value: "3" } }), { attempts: 3 });
  assert.deepEqual(sqliteRowNormalization().row({ verifierHash: "hashed" }), { verifierHash: "hashed" });
});
