import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

import {
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
  createDatabaseDialect,
  createDatabaseNormalization,
  createSharedDatabaseAdapterMethods,
  createSqliteDatabaseAdapter,
  libsqlRowNormalization,
  postgresDatabaseDialect,
  postgresRowNormalization,
  skipSqlQuotedOrCommented,
  sqlContentFingerprint,
  sqlDialectEveryEngineQuotes,
  sqlDialectWithoutPostgresStringForms,
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

// ---------------------------------------------------------------------------------------------
// What the walker guards below read.
//
// They used to read `SERVER_RUNTIME_SOURCE_FUNCTIONS` alone, because that list was both how the
// generated Capsule bundle was assembled and where every SQL walker in the runtime lived. The
// read-only inspection gate is a module now (ADR-0041) and reaches both bundles whole rather than
// one registered function at a time, so none of its functions is in that list any more — and a
// guard that kept reading only the list would have gone quiet about the one tokenizer while
// reporting success.
//
// So the subject set is the union: the emitted list, plus every function each *migrated* module
// declares — `MIGRATED_RUNTIME_MODULES` below, which every batch of that migration extends.
// Those are read out of each module's compiled *source text* rather than out of its exports, and
// that is the load-bearing half. A module's whole point here is that a helper needs no registration
// to survive, so the census has to be able to see a helper that is exported from nothing —
// `nestingBlockCommentEnd` is exactly that, and it is in the census below. Reading exports would
// have made privacy a way to leave the census, which is the opposite of what this guard is for.
//
// `getStart` returns the node's first token, which for an exported declaration is `export` rather
// than `function`. That is a superset of what `Function.prototype.toString()` gives for the entries
// that come from the emitted list, and the difference does not reach any detector below — none of
// them can match on the word `export`. What matters is that the prose *above* a declaration is
// excluded, which `getStart` does by skipping leading trivia, and that comments *inside* a body are
// included, which both forms do.
//
// **Two declaration forms, because this file can now legally hold both.** A top-level
// `const foo = (…) => {…}` is a `VariableStatement`, not a `FunctionDeclaration`, and reading only
// the latter made it invisible here — a real second SQL walker written that way passed both guards
// and reached both bundles. That form was not previously possible in this region: under the emitted
// list a helper travelled as `fn.toString()`, which for an arrow produces an expression and no
// top-level declaration, so `inspection-sql`'s predecessors were forced into `function` declarations
// and the gap could not be reached. Carrying the module whole made the form legal here for the first
// time and opened the gap in the same change, which is why it is closed in the same file.
//
// Still not a proof, and the misses are worth naming rather than leaving to be rediscovered: a
// walker declared as a class method, one assigned to a property of an exported object, or one nested
// inside another declaration is not collected in its own right — though the last is covered through
// its enclosing declaration's text, which was confirmed by execution rather than assumed.
function declaredFunctions(source, label) {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const declared = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      declared.push({ name: node.name.text, source: source.slice(node.getStart(parsed), node.getEnd()) });
      continue;
    }
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !initializer) continue;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
      declared.push({
        name: declaration.name.text,
        source: source.slice(declaration.getStart(parsed), declaration.getEnd()),
      });
    }
  }
  return declared;
}

// The collector's own coverage, settled on source small enough to read rather than inferred from
// the count of what it found in the real module. A collector that had quietly stopped seeing one of
// the two forms would leave every guard below passing, and `declaredFunctions` returning plenty of
// entries is exactly what that failure looks like from the outside.
test("the walker guards' collector sees both forms a top-level function can take", () => {
  // Each entry is a form and the body token that proves the body came with it. A collector that
  // returned the right names with the wrong spans would pass a names-only check and then match
  // nothing, which is the same silence as not collecting at all.
  const forms = [
    ["declaredAndExported", "BODY_ONE", "export function declaredAndExported(a) { return BODY_ONE; }"],
    ["declaredPrivate", "BODY_TWO", "function declaredPrivate(a) { return BODY_TWO; }"],
    ["conciseArrow", "BODY_THREE", "export const conciseArrow = (a) => BODY_THREE;"],
    ["blockArrow", "BODY_FOUR", "const blockArrow = (a) => { return BODY_FOUR; };"],
    ["functionExpression", "BODY_FIVE", "const functionExpression = function (a) { return BODY_FIVE; };"],
  ];
  const fixture = [
    ...forms.map(([, , text]) => text),
    "const notAFunction = 1;",
    "export const alsoNotAFunction = new Set([1]);",
  ].join("\n");

  const collected = declaredFunctions(fixture, "fixture.js");
  assert.deepEqual(
    collected.map(({ name }) => name).sort(),
    forms.map(([name]) => name).sort(),
  );

  for (const [name, body] of forms) {
    assert.match(
      collected.find((entry) => entry.name === name).source,
      new RegExp(body),
      `${name} was collected without its body`,
    );
  }
});

// Every region that has left `server-runtime-source.ts`. **A batch that migrates a domain adds its
// module here, and that is not optional bookkeeping.**
//
// The subject set below is the union of the emitted list and these modules, and the emitted list
// shrinks every time a batch removes functions from it. A migrated module that is not listed here
// is a set of functions no walker guard can see any more — and the guards keep passing, because
// their subjects went away rather than started failing. That is the one failure mode of this
// eight-batch sequence that nothing goes red for.
//
// `atLeast` and `sentinel` guard each module's *own* measurement rather than the union's. A floor on
// the total would be satisfied by `inspection-sql` alone however badly a later module parsed, so a
// module whose functions had silently stopped being collected would still leave this file green with
// its own contents invisible. Each sentinel is a function that must survive any honest edit to that
// module, and `log-index-guard`'s is deliberately its *private* one: it is exported from nothing and
// registered in nothing, so its presence here is the evidence that privacy is not a way out of these
// guards.
const MIGRATED_RUNTIME_MODULES = [
  { file: "inspection-sql.js", atLeast: 15, sentinel: "skipSqlQuotedOrCommented" },
  { file: "log-index-guard.js", atLeast: 3, sentinel: "readSqlIdentifier" },
  // Batch 2. `mail-runtime`'s sentinel is private for the same reason the log-index guard's is: it
  // is exported from nothing and registered in nothing, so finding it here is the evidence that
  // twenty-one newly-private mail helpers did not leave the census by becoming private.
  // `encodeMimeHeaderValue` is the one every MIME header in the domain passes through, so no honest
  // edit to that module removes it.
  //
  // `mail-config` holds exactly one function, so its floor is 0 — a floor is only ever asserting
  // that the parse returned something, and for this module "something" is one. It is listed
  // separately rather than folded into `mail-runtime` because it is a separate file with a
  // build-time consumer, and a module that is carried into the bundle must be a subject here
  // whatever its size: `validateMailConfig` is a census entry, and it stopped being an entry in the
  // emitted list in this same batch.
  { file: "mail-runtime.js", atLeast: 20, sentinel: "encodeMimeHeaderValue" },
  { file: "mail-config.js", atLeast: 0, sentinel: "validateMailConfig" },
  // Batch 3, and the largest subject added here: 104 functions, 51 of them private. The sentinel is
  // private for the third time running, and this one is worth naming. `passwordResetCodeParts` mints
  // the reset selector and verifier and is exported from nothing and registered in nothing — under
  // the emitted list it was an entry, so it was visible to these guards by being registered rather
  // than by being read. Finding it here is the evidence that fifty-one newly-private auth helpers,
  // including the credential hashing, did not leave the census by becoming private.
  //
  // `runtime-errors` held one function when batch 3 wrote this, so its floor was 0, for the same
  // reason `mail-config`'s is: a floor only asserts that the parse returned something. It is a
  // subject because it is carried, and `commandError` stopped being an entry in the emitted list in
  // that same batch.
  //
  // Batch 4 added `assertJsonCompatible` and `invalidJsonFieldValueError` to it, so the floor is 2
  // now. The sentinel moved to the private one deliberately: `invalidJsonFieldValueError` is the
  // first name in that module that is not exported, and it was an emitted-list entry before this
  // batch — so finding it here is the evidence that a helper which stopped being registered did not
  // thereby stop being a census subject.
  //
  // Batch 5 carried seven more auth functions into it — 111 declarations now, four of the seven
  // private — so the floor rises with the module rather than staying where batch 3 left it. A floor
  // that never moves is how a census keeps passing while covering a smaller fraction of its subject.
  { file: "auth-runtime.js", atLeast: 95, sentinel: "passwordResetCodeParts" },
  { file: "runtime-errors.js", atLeast: 2, sentinel: "invalidJsonFieldValueError" },
  // Batch 4: jobs and schedules, 34 declarations of which 5 are private. The sentinel is private for
  // the fourth time running. `scheduleWallClockParts` is the one every occurrence calculation passes
  // through — `nextScheduleOccurrence` converts each candidate instant to wall-clock fields with it
  // before matching the cron expression — so no honest edit to this module removes it, and it is
  // exported from nothing and registered in nothing. Under the emitted list it was an entry, so it
  // was visible to these guards by being registered; finding it here is the evidence that the five
  // newly-private schedule helpers did not leave the census by becoming private.
  //
  // The floor is 25 against 34 declarations, leaving room for an honest edit to fold a helper away
  // without failing the guard, while still catching a parse that returned a fraction of the module.
  { file: "jobs-runtime.js", atLeast: 25, sentinel: "scheduleWallClockParts" },
  // Batch 5: user preferences, 6 declarations of which 1 is private. The sentinel is private for the
  // fifth time running. `createPreferencesError` is the one both refusal paths in that module pass
  // through — the shape gate throws it, and `updateCurrentUserPreferences` builds its fallback with
  // it — so no honest edit to that module removes it, and it is exported from nothing and registered
  // in nothing. Under the emitted list it was an entry, so it was visible to these guards by being
  // registered; finding it here is the evidence that it did not leave the census by becoming private.
  //
  // The floor is 4 against 6. A domain this small has little room between "parsed a fraction of the
  // module" and "an honest edit folded a helper away", and 4 is the value that still fails if either
  // of the two functions holding the SQL and the validation stopped being collected.
  { file: "user-preferences-runtime.js", atLeast: 4, sentinel: "createPreferencesError" },
  // Batch 6: file and object storage, 51 declarations of which 27 are private. The sentinel is
  // private for the sixth time running. `resolveLiveFileReference` is the one every ownership-scoped
  // File lookup passes through — `createPendingFileUpload`, `getPrivateFileUrl`, `createPublicFileUrl`,
  // `deletePrivateFile` and `fileRowForOwner` all resolve an id or an absolute File path through it —
  // so no honest edit to that module removes it, and it is exported from nothing and registered in
  // nothing. Under the emitted list it was an entry, so it was visible to these guards by being
  // registered; finding it here is the evidence that 27 newly-private storage helpers, most of the
  // S3 request path among them, did not leave the census by becoming private.
  //
  // This module matters to these guards more than its size suggests: `filePathBackfillSql` and
  // `activeFilePathDedupeSql` answer statement text carrying identifier markers, so they are exactly
  // the shape the emitted-SQL quoting guards below exist to read, and both became private in this
  // batch. The floor is 40 against 51 — room for an honest edit to fold a helper away, and not
  // enough for a parse that returned a fraction of the module.
  //
  // `maybe-promise` holds three functions and its floor is 2, for the same reason `mail-config`'s and
  // `runtime-errors`'s were: a floor only asserts that the parse returned something. Its sentinel is
  // `isPromiseLike`, and it is the one entry here whose sentinel is *exported* — this module has no
  // private function, because all three of its names are resolved from the monolith. It is still the
  // right sentinel for the reason the private ones are: both other functions in that file are
  // defined in terms of it, so no honest edit removes it.
  { file: "maybe-promise.js", atLeast: 2, sentinel: "isPromiseLike" },
  { file: "file-storage-runtime.js", atLeast: 40, sentinel: "resolveLiveFileReference" },
  // Batch 7's two non-domain modules, each holding two functions, so each floor is 1 — a floor only
  // ever asserts that the parse returned something, and for a module this size "something" is both.
  // Both sentinels are exported, as `mail-config`'s and `maybe-promise`'s are, because the monolith
  // resolves every name in both files and neither has a private one.
  //
  // `isSensitiveLogKey` is the sentinel that matters here: it is the only thing in this runtime that
  // decides which field names never reach the platform log, and it is read by the log redactor still
  // in the monolith *and* by the ACL denial record that left it. It was an emitted-list entry until
  // this batch, so it was visible to these guards by being registered; finding it here is the
  // evidence that it did not leave the census by moving.
  { file: "runtime-log-policy.js", atLeast: 1, sentinel: "isSensitiveLogKey" },
  { file: "stored-row-decoding.js", atLeast: 1, sentinel: "deserializeRow" },
  // Batch 7: ACL and privileged audit, 55 functions of which 31 are private. The sentinel is private
  // for the seventh time in eight entries, and this one is the most pointed of them.
  // `markAsyncAclHelperRead` is the fuse every ACL helper read passes through — it is what makes a
  // rule that reached an asynchronous adapter read fail closed instead of answering on a value it
  // never awaited — and it is one of the four production `ReferenceError`s that
  // `test/server-bundle-free-bindings.test.js` exists because of. It was an emitted-list entry until
  // this batch, so it was visible to these guards by being registered; finding it here is the
  // evidence that 31 newly-private ACL and audit helpers, the whole denial record among them, did
  // not leave the census by becoming private.
  //
  // The floor is 45 against 55 — room for an honest edit to fold a helper away, and not enough for a
  // parse that returned a fraction of the module.
  { file: "acl-runtime.js", atLeast: 45, sentinel: "markAsyncAclHelperRead" },
];

function migratedModuleDeclaredFunctions() {
  return MIGRATED_RUNTIME_MODULES.flatMap(({ file, atLeast, sentinel }) => {
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    const declared = declaredFunctions(source, file);
    // Guard the measurement before trusting it. A parse that had silently produced nothing — a moved
    // file, a changed compiler target, a module that stopped being top-level functions — would make
    // every guard below pass by having no subjects, which is indistinguishable from a clean census.
    assert.ok(
      declared.length > atLeast,
      `expected the functions of dist/${file}, saw ${declared.length} — the walker guards would be reading nothing of it`,
    );
    assert.ok(
      declared.some(({ name }) => name === sentinel),
      `${sentinel} is not among the functions read out of dist/${file}`,
    );
    return declared;
  });
}

// Every function the walker guards below consider, as `{ name, source }`.
function walkerGuardSubjects() {
  return [
    ...SERVER_RUNTIME_SOURCE_FUNCTIONS.map((fn) => ({ name: fn.name, source: fn.toString() })),
    ...migratedModuleDeclaredFunctions(),
  ];
}

function walkerGuardSubject(name) {
  return walkerGuardSubjects().find((entry) => entry.name === name);
}

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

const BACKTICK = String.fromCharCode(96);

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

// Postgres nests block comments. SQLite and libSQL close one at the first `*/` and read on, and so
// did this walk — so the walk took its first token out of text Postgres was still commenting out.
// `/*/* */ SELECT 1 */ TRUNCATE TABLE t` is a `SELECT` to the walk and a `TRUNCATE` to Postgres,
// and every verb the keyword scan deliberately does not list rides the same shape.
//
// The statement-shape allowlist is the whole of what excludes those verbs, so a disagreement about
// *where the first token is* defeats it completely. It was held shut only by the `columns()` wrap
// failing to parse the admitted text, which is the accident this issue refused to rely on for the
// surrogate case and must not rely on here either.
//
// Neither lexing can simply be adopted: nesting would open the mirror hole, where a `;` inside a
// comment the walk swallowed is a real separator on the two engines that do not nest. So the
// ambiguous shape is refused, with its own reason.
const NESTED_BLOCK_COMMENT_ATTEMPTS = [
  "/*/* */ SELECT 1 */ TRUNCATE TABLE sporades_injection_canary",
  "/*/* */ SELECT 1 */ DELETE FROM sporades_injection_canary",
  "/*/* */ SELECT 1 */ DO $z$ BEGIN EXECUTE 'DELETE FROM sporades_injection_canary'; END $z$",
  "/*/* */ SELECT 1 */ SET x = 1",
  "/*/* */ SELECT 1 */ COMMENT ON TABLE sporades_injection_canary IS 'owned'",
  "/*/* */ SELECT 1 */ COPY sporades_injection_canary FROM PROGRAM 'x'",
  "/*/* */ SELECT 1 */ CALL p()",
  // The nested opener need not be adjacent, need not be at the start, and the comment need not be
  // the first thing in the statement.
  "/* a /* b */ SELECT 1 */ TRUNCATE TABLE sporades_injection_canary",
  "SELECT 1 /*/* */ AS s */ ; TRUNCATE TABLE sporades_injection_canary",
  // The mirror hole, which is why nesting was not adopted instead: to SQLite and libSQL this is a
  // real second statement, and a nesting walk would have read the whole tail as one comment.
  "SELECT 1 /*/* */; DROP TABLE sporades_injection_canary /* */",

  // The straddle. The nested opener's `*` is also the terminator's `*`, so `/*/` is one opener to
  // Postgres — `scan.l` matches `{xcstart}` and `yyless(2)` back to just `/*` — and the first
  // attempt to close this class asked whether the comment's body contained `/*` with the
  // terminator trimmed off, which cut the string exactly through the opener it was looking for.
  // These were admitted, and executed: `psql` run directly on the first one truncates the table.
  //
  // They are here rather than folded into the list above because the shape is the reason the test
  // for nesting is now derived instead of described. A regression that reintroduces a substring
  // rule will pass every case before this point and fail these.
  "/* /*/ SELECT 1 */ */ TRUNCATE TABLE sporades_injection_canary",
  "/*/*/ SELECT 1 */ */ TRUNCATE TABLE sporades_injection_canary",
  "/*/*/ SELECT 1 */**/ TRUNCATE TABLE sporades_injection_canary",
  "/* /*/ SELECT 1 */ */ DO $z$ BEGIN EXECUTE 'DELETE FROM sporades_injection_canary'; END $z$",
  "/* /*/ SELECT 1 */ */ DELETE FROM sporades_injection_canary",
  "/*/*/ SELECT 1 */ */ SET x = 1",
];

// The line-comment terminator, which composes with the block-comment one and was the round-3
// regression. Ending `--x<CR>` at the CR is right for Postgres and wrong for SQLite, and ending it
// early *exposes* a `/*` that this walk then runs past the LF which would have closed SQLite's line
// comment. The composed walk therefore skips more than SQLite does — the exact hazard the CR fix
// was introduced to remove, reappearing one comment-kind over.
//
// These are second statements SQLite and libSQL genuinely execute: handed to `exec`, the first one
// drops the table on both, while Postgres answers `syntax error at or near "AS"`. Nothing ran
// through the adapter only because `node:sqlite`'s `prepare()` compiles the first statement of a
// multi-statement string and silently discards the rest — another component's behaviour holding the
// boundary shut, which is what this gate exists not to depend on.
const LINE_COMMENT_COMPOSITION_ATTEMPTS = [
  "SELECT 1 AS s --x\r/*y\n; DROP TABLE sporades_injection_canary --*/ AS z",
  "SELECT 1 AS s --x\r/*y\n; TRUNCATE TABLE sporades_injection_canary --*/ AS z",
  "SELECT 1 --x\r/*\n; DROP TABLE sporades_injection_canary /*\r*/ AS z",
  // Without the block comment the disagreement is still a disagreement: the `;` is inside SQLite's
  // line comment and outside Postgres's, so the two engines answer different statements.
  "SELECT 1 AS s --x\r; DROP TABLE sporades_injection_canary",
  "SELECT 1 AS s --x\r AS z",
];

// Which verbs are reachable through the dollar-quote route is a question with an executed answer,
// it is only about which payloads belong in this battery. It is *not* a reason to relax anything:
// the exploit is `DROP` and `CREATE`, both of which SQLite and libSQL have and both of which were
// refused at the pre-work base and admitted at 80c14e4. The engines that read *inside* such a run
// are SQLite and libSQL — Postgres reads a literal — and those two have no `TRUNCATE` and no `DO`,
// so a payload built from those verbs would pass whatever the gate did. Measured with a canary on
// all three:
//
//     DROP      SQLite=GONE     libSQL=GONE     Postgres=intact
//     DELETE    SQLite=EMPTIED  libSQL=EMPTIED  Postgres=intact
//     TRUNCATE  SQLite=intact   libSQL=intact   Postgres=intact
//     DO        SQLite=intact   libSQL=intact   Postgres=intact
//
// So the belt has to cover every destructive verb SQLite and libSQL have, and it does. A `TRUNCATE`
// payload here would be a test that passes for a reason that has nothing to do with the gate — this
// battery had one until the canary said otherwise, and it was replaced with `DELETE` and `UPDATE`
// rather than deleted, because the class needs more than one live witness.
//
// A destructive verb inside a dollar-quoted run. Three things line up, and the third was this
// work's own regression.
//
// `$$…;…$$` genuinely is one statement to Postgres, so the separator walk is defeated legitimately
// and `sqlContentFingerprint` sees one opaque quoted run under both line-comment rules. The only
// cover is the side-effect keyword scan, which walks a deliberately different tokenizer that knows
// nothing of dollar quoting and therefore reads the verb SQLite and libSQL will really execute.
//
// Round 1 gave that tokenizer the CR line-comment rule along with every other walk, which blinded
// it by exactly the composition round 4 fixed elsewhere: the CR ends the `--`, exposing a `/*` that
// swallows the verb past the LF. The scan now runs under both terminators and unions the hits.
//
// These are refused at the pre-work base and were admitted at 80c14e4 — the regression was
// invisible to four rounds of round-over-round comparison, which is why the differential baseline is
// now the base rather than the previous commit.
const DOLLAR_QUOTE_BELT_ATTEMPTS = [
  "SELECT $$a; --b\r/*\nDROP TABLE sporades_injection_canary;\n*/$$ AS s",
  "SELECT $$a; --b\r/*\nDELETE FROM sporades_injection_canary;\n*/$$ AS s",
  "SELECT $$a--\r/*\nDROP TABLE sporades_injection_canary;$$ AS s",
  "SELECT $tag$a; --b\r/*\nDROP TABLE sporades_injection_canary;\n*/$tag$ AS s",
  "SELECT $$a; --b\r/*\nUPDATE sporades_injection_canary SET id = 'x';\n*/$$ AS s",
  // The same belt, without the comment trick: the scan has always caught these and must keep doing
  // so, because the separator walk cannot.
  "SELECT $$a; DROP TABLE sporades_injection_canary$$ AS s",
  // The `CREATE TABLE` limb of the same shape, in both dollar-quote spellings. A canary row only
  // witnesses a *destructive* first token; a second statement beginning `CREATE` leaves it alone
  // and is still not a `SELECT`, so it needs the probe below to be observed at all. Running a
  // canary and calling that an oracle is how an earlier sweep of this work reported clean for a
  // whole class.
  "SELECT $$a; CREATE TABLE sporades_injection_probe (id int)$$ AS s",
  "SELECT $tag$a; CREATE TABLE sporades_injection_probe (id int)$tag$ AS s",
  "SELECT $$a; --b\r/*\nCREATE TABLE sporades_injection_probe (id int);\n*/$$ AS s",
];

// Whether the table those payloads try to bring into existence exists. `to_regclass` answers NULL
// rather than raising when it does not, and the two SQLite-family engines answer no rows.
const PROBE_TABLE_EXISTS = {
  Postgres: "SELECT to_regclass('sporades_injection_probe') AS t",
  SQLite: "SELECT name AS t FROM sqlite_schema WHERE name = 'sporades_injection_probe'",
  libSQL: "SELECT name AS t FROM sqlite_schema WHERE name = 'sporades_injection_probe'",
};

const AMBIGUOUS_LEXING_MESSAGE = "Only SQL the database reads the same way this check does is allowed.";

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
  for (const sql of [...INJECTION_ATTEMPTS, ...DOLLAR_QUOTE_BELT_ATTEMPTS]) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a second statement was admitted: ${JSON.stringify(sql)}`);
    assert.equal(validation.error.message, "Only read-only SQL is allowed.");
  }

  // The CR battery is refused one limb earlier than it used to be, and by a truer reason. Every one
  // of these really is read differently by the two engine families — Postgres sees two statements
  // where SQLite sees one and a trailing comment — so "the engines do not agree about this text" is
  // the accurate answer, and its hint names the carriage return rather than suggesting a SELECT.
  for (const sql of LINE_ENDING_INJECTION_ATTEMPTS) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a second statement was admitted: ${JSON.stringify(sql)}`);
    assert.equal(validation.error.message, AMBIGUOUS_LEXING_MESSAGE, JSON.stringify(sql));
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

  for (const sql of LINE_COMMENT_COMPOSITION_ATTEMPTS) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a statement SQLite reads differently was admitted: ${JSON.stringify(sql)}`);
    assert.equal(
      validation.error.message,
      AMBIGUOUS_LEXING_MESSAGE,
      `refused for the wrong reason: ${JSON.stringify(sql)}`,
    );
    assert.match(validation.error.hint, /carriage return/);
  }

  for (const sql of NESTED_BLOCK_COMMENT_ATTEMPTS) {
    const validation = validateReadOnlyInspectionSql(sql);
    assert.equal(validation.ok, false, `a statement Postgres reads differently was admitted: ${JSON.stringify(sql)}`);
    assert.equal(
      validation.error.message,
      AMBIGUOUS_LEXING_MESSAGE,
      `refused for the wrong reason, which leaves the boundary resting on the columns() wrap: ${JSON.stringify(sql)}`,
    );
    assert.match(validation.error.hint, /nested/);
  }
});

// Two rounds of this were closed by describing the dangerous text and both descriptions had a blind
// spot, so this asserts the property instead of the pattern: everything the gate admits must close
// its block comments where a *nesting* lexer closes them. The model below is written independently
// of the runtime's — it hops between delimiters with `indexOf` where the runtime walks character by
// character — so agreement between them is evidence rather than a tautology.
//
// The corpus is checked for adequacy before it is used. A sweep that cannot emit the dangerous shape
// answers zero for the wrong reason, which is how both earlier rounds reported clean.
//
// One caveat on how much fidelity the model below carries: it is an independent *implementation* of
// nesting, not an independent *model* of Postgres. It encodes the same reading the runtime does —
// leftmost non-overlapping delimiters, left to right, quoting not special inside a comment — so
// agreement between the two is a regression guard rather than evidence that either matches the
// engine. What supplies that evidence is running the text against a live Postgres, which the
// per-engine batteries and `scripts/inspection-lexing-sweep.mjs` do.
function nestingBlockCommentEnd(sql, start) {
  let depth = 0;
  let cursor = start;
  while (cursor < sql.length) {
    const open = sql.indexOf("/*", cursor);
    const close = sql.indexOf("*/", cursor);
    if (close === -1) return sql.length;
    if (open !== -1 && open < close) {
      depth += 1;
      cursor = open + 2;
      continue;
    }
    depth -= 1;
    cursor = close + 2;
    if (depth === 0) return cursor;
  }
  return sql.length;
}

test("everything admitted closes its block comments where a nesting lexer does", () => {
  // Two corpora, because one alphabet cannot serve both classes at a workable depth.
  //
  // The piece set is the part of this test that has been wrong four times: it could not reach
  // nesting depth in round 2, could not reach the `/*/` straddle in round 3, had no `--`, `\r` or
  // `\n` at all in round 4, and in round 5 had no quote characters and only ever *appended* the
  // verb — so it could not express a verb hidden *inside* a quoted run, which is exactly the shape
  // that regressed. Adding a rule without adding its alphabet here is how that keeps happening.
  const commentPieces = ["/*", "*/", "/*/", "**/", "--", "\r", "\n", " ", " SELECT 1 "];
  const quotingPieces = ["/*", "*/", "--", "\r", "\n", " ", "$$", "'", '"', "E'"];

  const corpus = [];
  const build = (pieces, maxDepth, shapes) => {
    const walk = (depth, acc) => {
      if (depth === 0) {
        for (const shape of shapes) corpus.push(shape(acc));
        return;
      }
      for (const piece of pieces) walk(depth - 1, acc + piece);
    };
    for (let depth = 1; depth <= maxDepth; depth += 1) walk(depth, "");
  };

  // Appended: the verb follows whatever trivia the prefix turned out to be.
  build(commentPieces, 5, [(acc) => `${acc} TRUNCATE TABLE t`, (acc) => `${acc}; DROP TABLE t`]);
  // Surrounded: the verb sits inside a quoted run, which is where the separator walk and the
  // keyword scan read the same bytes differently and only the scan can see it.
  build(quotingPieces, 4, [
    (acc) => `SELECT $$a${acc}DROP TABLE t;$$ AS s`,
    (acc) => `SELECT 'a${acc}DROP TABLE t;' AS s`,
    (acc) => `SELECT $$a${acc}TRUNCATE TABLE t;$$ AS s`,
  ]);

  // Corpus adequacy, asserted rather than assumed: the shape that defeated each previous round must
  // be in here, or a clean result below means nothing. Every round so far reported clean from a
  // corpus that could not emit the shape it was reporting clean about.
  assert.ok(corpus.includes("/*/* SELECT 1 */*/ TRUNCATE TABLE t"), "corpus cannot emit a round-1 nesting shape");
  assert.ok(corpus.includes("/*/*/ SELECT 1 */*/ TRUNCATE TABLE t"), "corpus cannot emit a round-2 straddle shape");
  assert.ok(corpus.includes("-- SELECT 1 \r/*; DROP TABLE t"), "corpus cannot emit the round-3 line-comment composition");
  assert.ok(
    corpus.some((sql) => sql.includes("--") && sql.includes("\r") && sql.includes("/*")),
    "corpus cannot compose a line comment, a carriage return and a block comment",
  );
  // Round 5's shape: a destructive verb inside a dollar-quoted run, hidden from the keyword scan by
  // a `--<CR>/*<LF>` composition. One statement to Postgres, two to SQLite and libSQL.
  assert.ok(
    corpus.includes("SELECT $$a--\r/*\nDROP TABLE t;$$ AS s"),
    "corpus cannot emit the round-5 dollar-quote-wrapped shape",
  );
  assert.ok(
    corpus.some((sql) => /\$\$.*DROP/s.test(sql)),
    "corpus cannot wrap a verb in a dollar quote at all",
  );
  assert.ok(corpus.length > 15000, `corpus is too small to be meaningful: ${corpus.length}`);

  let admitted = 0;
  for (const sql of corpus) {
    if (!validateReadOnlyInspectionSql(sql).ok) continue;
    admitted += 1;

    // The line-comment rule, held to the same standard as the nesting one: what the gate admitted
    // must read the same way under SQLite's terminator as under Postgres's.
    assert.equal(
      sqlContentFingerprint(sql, true),
      sqlContentFingerprint(sql, false),
      `admitted text the two line-comment rules read differently: ${JSON.stringify(sql)}`,
    );
    // The nesting property is checked on the quote-free half only. Stepping over both comment kinds
    // is the whole of the traversal there; once a payload carries `'`, `$$` or `"`, deciding whether
    // a `/*` opens a comment or sits inside a literal needs the runtime's own quoting walk, and
    // reimplementing that here would be asserting this test against itself. The quoted half is
    // covered by the fingerprint assertion above, by the batteries, and by the live sweep.
    if (/['"$`[]|E'/.test(sql)) continue;
    let index = 0;
    while (index < sql.length) {
      if (sql[index] === "-" && sql[index + 1] === "-") {
        const found = /[\n\r]/.exec(sql.slice(index + 2));
        index = found ? index + 2 + found.index + 1 : sql.length;
        continue;
      }
      if (sql[index] === "/" && sql[index + 1] === "*") {
        const found = sql.indexOf("*/", index + 2);
        const nonNesting = found === -1 ? sql.length : found + 2;
        assert.equal(
          nestingBlockCommentEnd(sql, index),
          nonNesting,
          `admitted a comment the two lexings close in different places: ${JSON.stringify(sql)}`,
        );
        index = nonNesting;
        continue;
      }
      index += 1;
    }
  }

  // A refusal that refused everything would satisfy the loop above and be useless.
  assert.ok(admitted > 500, `too few admitted for this to be evidence: ${admitted}`);
});

// The invariant that five rounds of defects were able to violate, written where an edit cannot
// violate it quietly.
//
// The keyword scan must walk without knowing Postgres's dollar quoting or its E-strings. That is
// not an oversight to be tidied up: `SELECT $$a; DROP TABLE t$$ AS s` is one literal to Postgres
// and a real second statement to SQLite and libSQL, which have neither form and execute the `DROP`.
// A walk that knew dollar quoting would skip the verb as literal content and admit it.
//
// Until now that asymmetry lived in a prose comment beside two near-identical functions, and a
// change that was right for one of them and applied to both destroyed it without failing anything.
// It is a named argument now, so widening it fails here — asked of the tokenizer rather than read
// off the profile's fields, because a field can be renamed and a behaviour cannot.
test("the dialect the keyword scan asks for withholds the two string forms only Postgres has", () => {
  const withheld = sqlDialectWithoutPostgresStringForms(true);
  const everyEngine = sqlDialectEveryEngineQuotes(true);

  // The union profile recognises both forms, so the assertions below are an asymmetry rather than
  // a tokenizer that recognises nothing.
  assert.equal(skipSqlQuotedOrCommented("$$a; DROP TABLE t$$", 0, everyEngine), 19);
  assert.equal(skipSqlQuotedOrCommented("$tag$a; DROP TABLE t$tag$", 0, everyEngine), 25);
  assert.equal(skipSqlQuotedOrCommented("E'a; DROP TABLE t'", 0, everyEngine), 18);

  // And the withholding profile recognises neither, so the keyword scan reads the verb SQLite and
  // libSQL will really execute. `0` is "nothing opens here", which is what makes the scan step one
  // character and go on to read `DROP` as a token.
  assert.equal(
    skipSqlQuotedOrCommented("$$a; DROP TABLE t$$", 0, withheld),
    0,
    "the keyword scan's dialect learned dollar quoting — `SELECT $$a; DROP TABLE t$$ AS s` is now admitted on SQLite and libSQL",
  );
  assert.equal(
    skipSqlQuotedOrCommented("$tag$a; DROP TABLE t$tag$", 0, withheld),
    0,
    "the keyword scan's dialect learned tagged dollar quoting",
  );
  assert.equal(
    skipSqlQuotedOrCommented("E'a; DROP TABLE t'", 0, withheld),
    0,
    "the keyword scan's dialect learned E-strings",
  );

  // The scan is the consumer that has to ask for it, and the call site has to say so. A profile
  // nothing asks for protects nothing.
  const keywordScan = walkerGuardSubject("readSqlTokens");
  assert.ok(keywordScan, "the keyword scan no longer travels into the bundle");
  assert.match(
    keywordScan.source,
    /sqlDialectWithoutPostgresStringForms/,
    "the keyword scan stopped naming the dialect it walks with, so a reader has to infer it again",
  );
});

// A tripwire for a second function that decides where a SQL comment or quoted run ends.
//
// **What it matches.** A runtime function is flagged when its source shows any one of:
//
//   1. a two-character comment delimiter — `--`, `/*` or `*/` — in a short string literal;
//   2. one of those inside a regex or template literal body;
//   3. a `-`, or both `*` and `/`, in short string literals;
//   4. two or more of `'`, `"`, backtick, `[`, `$` in short string literals.
//
// **What it does not match.** A function whose source shows none of the four is not flagged. Some
// examples, each planted and confirmed missed rather than reasoned about: one assembling its
// delimiters at runtime with `String.fromCharCode(45) + String.fromCharCode(45)`; one comparing
// `charCodeAt` values against 45 and 47; one whose only quoting alphabet lives in a regex body,
// the way this file writes `/^['"\`[]/`. Reading quote characters out of pattern bodies would
// catch that third one and was measured: it flags 87 runtime functions, which is not a census.
//
// So this is a tripwire for the likely spellings, not a proof that one tokenizer exists. Its value
// is that the spellings this file actually uses are covered, and that a new match has to be
// classified rather than absorbed. A future evasion is another example for the list above.
//
// **Why these four.** Signal 3 is the one that matters most and was the last to arrive. The first
// version of this guard grepped for four source spellings unique to the collapsed body; a walker
// written the way the pre-collapse ones were written — `char === "-" && next === "-"`, a line
// comment ending at LF only, which is the historical defect — passed all four. The version after
// that required a quote delimiter alongside a single comment character, and a walker whose
// delimiter comparisons were copied character-for-character out of this file, taking its quote set
// as a parameter instead of naming one, passed that too. Signal 3 standing alone is what catches
// it, and it costs two rows that hold a `-` which is a hostname hyphen and a cron step.
//
// Signal 2 exists because omitting it missed the idiom this file uses most: `skipSqlQuotedOrCommented`
// writes its own terminator rules as `/[\n\r]/ : /\n/` and `/^\$(?:…)\$/`, so the likeliest spelling
// of the next run lexer here was exactly the one the earlier versions could not see.
const shortStringLiterals = (source) => {
  const found = new Set();
  for (const match of source.matchAll(/"((?:[^"\\]|\\.){1,2})"|'((?:[^'\\]|\\.){1,2})'/g)) {
    found.add(match[1] ?? match[2]);
  }
  return found;
};

// Regex and template literal bodies, backslashes removed so `\/\*` reads as the delimiter it
// matches. Bodies only — including a regex's closing `/` makes every pattern ending in `*` look
// like it names `*/`.
const patternBodies = (source) => {
  const bodies = [];
  for (const match of source.matchAll(/\/(?![/*])((?:\[(?:[^\]\\]|\\.)*\]|[^/\\\n[]|\\.)+)\/[dgimsuvy]*/g)) {
    bodies.push(match[1].replaceAll("\\", ""));
  }
  for (const match of source.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    bodies.push(match[1].replaceAll("\\", ""));
  }
  return bodies;
};

const namesRunDelimiters = (source) => {
  const literals = shortStringLiterals(source);
  const quotes = ["'", '"', "`", "[", "$"].filter((quote) => literals.has(quote));
  // Only the two-character comment forms count inside a pattern: single characters are far too
  // common there to mean anything, and reading every regex-body character flags 69 of these.
  const commentDelimiterInAPattern = patternBodies(source).some(
    (body) => body.includes("--") || body.includes("/*") || body.includes("*/"),
  );
  return (
    literals.has("--") ||
    literals.has("/*") ||
    literals.has("*/") ||
    commentDelimiterInAPattern ||
    literals.has("-") ||
    (literals.has("*") && literals.has("/")) ||
    quotes.length >= 2
  );
};

// The census, and the point of it: the detected set must equal this exactly. A new walker fails
// because it is not listed; a listed one that disappears fails too, so the reasons below cannot
// quietly go stale. Each entry says why it is not the one tokenizer.
//
// Four of the seven lex JavaScript rather than SQL. They are here because no detector working from
// delimiter literals can tell the two apart — both spell a string run with the same three quote
// characters — and listing them with the reason is honest where narrowing the detector to exclude
// them would just be the spelling-coupled guard again under a new name.
const RUN_LEXER_CENSUS = {
  skipSqlQuotedOrCommented: "the one tokenizer every read-only inspection consumer asks a dialect of",
  // On the inspection path — every Postgres inspection query passes through it twice — and left
  // uncollapsed deliberately. It is *not* inert there: a `?` inside a form it does not know makes it
  // throw, which is a Postgres-only false rejection. It fails closed, and the property the gate
  // depends on is asserted below. Collapsing it would change what a backslash means inside a
  // literal on the write path, which is a larger surface than this gate.
  postgresInterpolate: "recorded exception: on the inspection path, fails closed, see its comment",
  // Off the inspection path: reached only from libSQL's `exec`, and `runReadOnlyInspectionQuery`
  // goes through `prepare`. Latent duplication of the same class; has its own ticket.
  splitSqlStatements: "recorded exception: reached only from libSQL exec, not from the inspection path",
  extractObjectPropertySource: "lexes Capsule definition JavaScript, not SQL",
  findMatchingDelimiter: "lexes Capsule definition JavaScript, not SQL",
  findMatchingParen: "lexes Capsule definition JavaScript, not SQL",
  splitTopLevelList: "lexes Capsule definition JavaScript, not SQL",
  // The nesting oracle, in two parts since the counter was extracted into a helper. Neither lexes a
  // quoted run — together they count block-comment depth and compare the end against the one
  // tokenizer's — and both are *required* to disagree with it, which is the opposite of the property
  // this census enforces.
  //
  // The oracle is matched on its own code, `sql[index] === "/" && sql[index + 1] === "*"`, which is
  // asserted below: it used to be matched only on the `--x<CR>` examples in its prose, and a reworded
  // comment would have dropped it out of the census silently. That test is why the block-comment
  // check stayed at the call site when the counter moved out, rather than going with it.
  sqlTheEnginesLexDifferently: "the nesting oracle, required to disagree with the one tokenizer",
  // The counter itself, and the reason this census reads source text rather than a list. It is a
  // private helper of `inspection-sql`: exported from nothing, registered in nothing, and reaching
  // both generated bundles anyway because that module travels whole (ADR-0041). Under the emitted-list
  // mechanism it could not have existed as a function at all — its caller travels as source text, so
  // an unregistered helper was a `ReferenceError` in a deployed Capsule. Being here is the evidence
  // that privacy is not a way out of this guard.
  nestingBlockCommentEnd: "the nesting oracle's counter, required to disagree with the one tokenizer",
  // The rest hold a `-`, or a `*` and a `/`, that is not a SQL comment delimiter. Each was read to
  // confirm it rather than assumed from the name.
  beginOAuthSignIn: "not a lexer: `--client-id`, `--client-secret`, `--client-json` in CLI hint strings",
  createSharedDatabaseAdapterMethods: "not a lexer: `sporades logs --json` in CLI hint strings",
  buildSmtpMessage: "not a lexer: `--${boundary}` MIME multipart delimiters",
  isSensitiveLogString: "not a lexer: the `-----BEGIN … PRIVATE KEY-----` PEM header pattern",
  validateMailConfig: "not a lexer: a hostname label may not start or end with `-`",
  parseScheduleExpression: "not a lexer: cron step syntax, `split(\"/\")` and `base === \"*\"`",
  // Batch 3, and this entry is a blind spot closing rather than a new function. It is the same class
  // as `beginOAuthSignIn` two lines up — a CLI flag in a hint string, `--email` — and it has been in
  // the runtime the whole time. The census could not see it because `walkerGuardSubjects()` reads
  // the emitted list plus the migrated modules, and `simulateLocalIdentitySession` was an *export*
  // of `server-runtime-source.ts` that was never an entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS`: the
  // CLI imports it directly, so nothing ever registered it. Carrying the auth domain as a module put
  // it in front of this guard for the first time.
  //
  // Worth stating for the batches that follow: the emitted list was never the whole runtime, so a
  // census derived from it was never a census of the runtime. Every batch that moves a domain should
  // expect subjects that were invisible rather than new.
  simulateLocalIdentitySession: "not a lexer: `--email` in a CLI hint string",
};

test("no second function decides where a SQL comment or quoted run ends", () => {
  const detected = walkerGuardSubjects()
    .filter(({ source }) => namesRunDelimiters(source))
    .map(({ name }) => name)
    .sort();

  assert.deepEqual(
    detected,
    Object.keys(RUN_LEXER_CENSUS).sort(),
    "the set of runtime functions that lex comment or quoted runs changed — add it to the census with the reason it is not the one tokenizer, or route it through",
  );

  // `postgresInterpolate` is on the inspection path, so what it does there is asserted rather than
  // assumed — and it is not the identity, which an earlier draft of this test claimed.
  //
  // The property the gate depends on is narrower and is the one that holds: with no parameters, it
  // either returns its input unchanged or it throws. There is no third case where it returns
  // *different* text. That is what keeps "the text checked is the text executed" true across it; a
  // silent rewrite would break the gate's whole claim, a throw only costs a false rejection.
  //
  // The alphabet below has `?` in it deliberately. It is the only character this function acts on,
  // so a corpus without it reports inertness for the same reason a corpus without `\r` reported the
  // line-comment class clean.
  const interpolate = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "postgresInterpolate");
  const identityOrThrow = (sql) => {
    try {
      return interpolate(sql) === sql ? "identity" : "REWROTE";
    } catch {
      return "threw";
    }
  };

  let threw = 0;
  const corpus = [];
  for (const piece of ["", "?", "$$?$$", "'?'", '"?"', "E'?'", "[?]", "-- ?\r", "/* ? */", "$tag$?$tag$", "\\?"]) {
    corpus.push(`SELECT ${piece} AS s`, `SELECT 1 AS s ${piece}`, `WITH t AS (SELECT ${piece} AS s) SELECT * FROM t`);
  }
  corpus.push(...INJECTION_ATTEMPTS, ...DOLLAR_QUOTE_BELT_ATTEMPTS);

  for (const sql of corpus) {
    for (const text of [sql, sqlWithoutTrailingTerminator(sql), `SELECT * FROM (${sqlWithoutTrailingTerminator(sql)}) AS c LIMIT 0`]) {
      const outcome = identityOrThrow(text);
      assert.notEqual(
        outcome,
        "REWROTE",
        `postgresInterpolate silently rewrote an inspection statement, so the text checked is not the text executed: ${JSON.stringify(text)}`,
      );
      if (outcome === "threw") threw += 1;
    }
  }

  // And the corpus must actually be able to reach the throwing branch, or the assertion above is
  // satisfied by a corpus that never exercises it.
  assert.ok(threw > 0, "corpus cannot reach postgresInterpolate's throwing branch — it proves nothing");
  assert.equal(identityOrThrow("SELECT $$?$$ AS s"), "threw", "the recorded Postgres-only false rejection changed");
  assert.equal(identityOrThrow("SELECT '?' AS s"), "identity", "a `?` inside an ordinary literal stopped being protected");

  // The nesting oracle is a census entry, and the only one whose disagreement with the tokenizer is
  // the point rather than the defect: it counts block-comment depth and refuses every input the two
  // readings close in different places. Being listed is not enough for it, because the census only
  // asserts the *names* — so the property that makes it an oracle rather than a sixth walker is
  // asserted here.
  const oracle = walkerGuardSubject("sqlTheEnginesLexDifferently");
  assert.ok(oracle, "the nesting oracle no longer travels into the bundle");
  assert.match(oracle.source, /skipSqlQuotedOrCommented/, "the oracle stopped comparing against the one tokenizer");

  // The counter is a separate function now, so the oracle's comparison against it is asserted too.
  // Extracting it was only possible because the gate is a module: the counter is exported from
  // nothing and registered in nothing.
  const counter = walkerGuardSubject("nestingBlockCommentEnd");
  assert.ok(counter, "the nesting oracle's counter no longer travels into the bundle");
  assert.match(oracle.source, /nestingBlockCommentEnd/, "the oracle stopped comparing against a nesting reading");

  // And both are in the census on their code rather than on their prose. The oracle used to be
  // matched only on the `--x<CR>` examples in its comments, which meant rewording a comment would
  // have dropped the one entry whose disagreement with the tokenizer is deliberate — and the obvious
  // response to a census failure naming it would have been to delete the row. The counter carries the
  // `*/` comparison and the oracle kept the `/*` one for exactly this reason.
  const withoutComments = (source) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  for (const { name, source } of [oracle, counter]) {
    assert.equal(
      namesRunDelimiters(withoutComments(source)),
      true,
      `${name} is in the census only because of its prose — reword a comment and it drops out silently`,
    );
  }
});

// The spelling checks the first version of this guard consisted of, kept as a second and weaker
// line: they cannot catch a walker written in a different style, but they do catch a copy that
// reuses this one's, which is how a "just extract it for reuse" edit would look.
test("no terminator rule of the one tokenizer is spelled twice", () => {
  const facts = [
    ["a line comment's terminator", /lineCommentEndsAtCarriageReturn \? \/\[\\n\\r\]\/ : \/\\n\//],
    ["a dollar-quote delimiter", /\\\$\(\?:\[A-Za-z_/],
    ["an E-string's opener", /sql\[index\] === "E" \|\| sql\[index\] === "e"/],
    ["a bracket-quoted identifier's close", /=== "\[" \? "\]"/],
  ];

  const subjects = walkerGuardSubjects();
  for (const [fact, pattern] of facts) {
    const encoders = subjects.filter(({ source }) => pattern.test(source)).map(({ name }) => name);
    assert.deepEqual(
      encoders,
      ["skipSqlQuotedOrCommented"],
      `${fact} is encoded in ${encoders.length} runtime functions rather than one: ${encoders.join(", ")}`,
    );
  }

  // The two functions the class came from are gone rather than left as aliases beside the
  // tokenizer, and nothing still calls them.
  const allSource = subjects.map(({ name, source }) => `${name}\n${source}`).join("\n");
  for (const gone of ["skipSqlStringOrComment", "skipSqlLiteralOrComment"]) {
    assert.equal(allSource.includes(gone), false, `${gone} still exists, so the pair was not collapsed`);
  }

  // Every consumer reaches the one tokenizer. Named individually rather than derived, because this
  // is the list the ticket asked to be established: two skippers, a trivia skipper and two token
  // readers, plus the walks each of them serves. `opensQuotedRun` joined it when the two copies of
  // the literal-or-comment test were factored into it — a private helper of the inspection module,
  // which is the extraction the emitted-list mechanism used to forbid.
  for (const consumer of [
    "hasMultipleSqlStatements",
    "isSafeInspectionPragma",
    "sqlWithoutTrailingTerminator",
    "sqlContentFingerprint",
    "sqlTheEnginesLexDifferently",
    "readSqlTokens",
    "readSqlQuotedIdentifier",
    "skipSqlTrivia",
    "opensQuotedRun",
  ]) {
    const fn = subjects.find((each) => each.name === consumer);
    assert.ok(fn, `${consumer} no longer travels into the bundle`);
    assert.match(fn.source, /skipSqlQuotedOrCommented/, `${consumer} does not reach the one tokenizer`);
  }

  // And the literal-or-comment test is asked in one place now rather than two. `sqlContentFingerprint`
  // and `sqlWithoutTrailingTerminator` each spelled `skipSqlQuotedOrCommented(…, quotedRunsOnly)` out
  // in full — two copies of a rule about where a literal ends, one of them on the write path, which
  // is the shape ADR-0038's defect history is made of.
  const asksForQuotedRunsOnly = subjects
    .filter(({ name, source }) => name !== "sqlDialectQuotedRunsOnly" && /sqlDialectQuotedRunsOnly\(\)/.test(source))
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(
    asksForQuotedRunsOnly,
    ["opensQuotedRun"],
    `the literal-or-comment test is spelled in ${asksForQuotedRunsOnly.length} places rather than one: ${asksForQuotedRunsOnly.join(", ")}`,
  );
});

// The refusal is of the disputed shape, not of block comments. A comment both lexings close in the
// same place is untouched, whatever it contains.
test("an unambiguous block comment is still an ordinary comment", () => {
  for (const sql of [
    "SELECT 1 /* why */ AS s",
    "/* why */ SELECT 1 AS s",
    "SELECT 1 AS s /* why */ ;",
    "SELECT 1 /* a * b / c */ AS s",
    // A `/*` that is inside a string literal is content, not a nested opener.
    "SELECT '/*' AS s /* why */",
    "SELECT $$/*$$ AS s",
    // The closing delimiter's own `/` cannot be misread as opening a nested comment.
    "SELECT 1 /* why/ */ AS s",
  ]) {
    assert.equal(validateReadOnlyInspectionSql(sql).ok, true, `an unambiguous comment was refused: ${JSON.stringify(sql)}`);
  }
});

// Trivia is the other half of the same disagreement, and CR was not the only instance. The accepted
// set below is measured rather than read off a grammar: `SELECT<c>1 AS a` is accepted for each of
// space, tab, LF, CR and form feed on SQLite, libSQL and Postgres, and refused by all three for
// vertical tab, which appears in Postgres's published `space` class and is a lexer error in
// practice. Everything JavaScript's `\s` adds beyond those five is an identifier character to
// Postgres, so a walk that skips one reports "nothing follows the terminator" about text the engine
// reads on into.
test("only the whitespace every engine calls whitespace is trivia", () => {
  // `\v` sits at the head of this list deliberately: it was in the accepted set until the engines
  // were asked, and it is the one character here that a grammar would have told you was fine.
  for (const space of ["\v", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    const escaped = JSON.stringify(space);
    for (const sql of [`SELECT 1 AS s;${space}`, `${space}SELECT 1 AS s`, `SELECT${space}1 AS s`]) {
      const validation = validateReadOnlyInspectionSql(sql);
      assert.equal(validation.ok, false, `skipped as whitespace: ${escaped} in ${JSON.stringify(sql)}`);
      // The operator is told what to take out. Told "not read-only" about their `SELECT`, they have
      // no way to see an invisible character, and pasting from a document is how this arrives.
      assert.equal(validation.error.message, AMBIGUOUS_LEXING_MESSAGE, escaped);
      assert.match(validation.error.hint, /invisible character/);
    }
  }

  for (const space of [" ", "\t", "\n", "\r", "\f"]) {
    const escaped = JSON.stringify(space);
    assert.equal(validateReadOnlyInspectionSql(`SELECT 1 AS s;${space}`).ok, true, `refused real whitespace: ${escaped}`);
    assert.equal(validateReadOnlyInspectionSql(`${space}SELECT 1 AS s`).ok, true, `refused real whitespace: ${escaped}`);
    assert.equal(validateReadOnlyInspectionSql(`SELECT${space}1 AS s`).ok, true, `refused real whitespace: ${escaped}`);
  }

  // Inside a quoted run it is content, not trivia, and the engines take it there.
  assert.equal(validateReadOnlyInspectionSql("SELECT 'a\u00a0b' AS s").ok, true);
  assert.equal(validateReadOnlyInspectionSql("SELECT 1 AS s -- a\u00a0b").ok, true);
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
            ...LINE_ENDING_INJECTION_ATTEMPTS.map((sql) => [sql, AMBIGUOUS_LEXING_MESSAGE]),
            ...UNREPRESENTABLE_TEXT_ATTEMPTS.map((sql) => [sql, UNREPRESENTABLE_TEXT_MESSAGE]),
            ...NESTED_BLOCK_COMMENT_ATTEMPTS.map((sql) => [sql, AMBIGUOUS_LEXING_MESSAGE]),
            ...LINE_COMMENT_COMPOSITION_ATTEMPTS.map((sql) => [sql, AMBIGUOUS_LEXING_MESSAGE]),
            ...DOLLAR_QUOTE_BELT_ATTEMPTS.map((sql) => [sql, "Only read-only SQL is allowed."]),
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

            // And the probe, which is the half a canary cannot see. A `CREATE TABLE` that ran leaves
            // the canary intact, so without this the battery would be blind to every non-destructive
            // first token the gate is equally supposed to exclude.
            const probed = await adapter.runReadOnlyInspectionQuery(PROBE_TABLE_EXISTS[engine.name]);
            assert.equal(probed.ok, true, probed.error?.message);
            assert.deepEqual(
              probed.data.rows.filter((row) => row.t),
              [],
              `a second statement created a table: ${JSON.stringify(sql)}`,
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
          await adapter.exec("DROP TABLE IF EXISTS sporades_injection_probe");
        }
      },
      { appTableNames: ["sporades_injection_canary", "sporades_injection_probe"] },
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
  const attempts = [
    ...INJECTION_ATTEMPTS,
    ...LINE_ENDING_INJECTION_ATTEMPTS,
    ...UNREPRESENTABLE_TEXT_ATTEMPTS,
    ...NESTED_BLOCK_COMMENT_ATTEMPTS,
    ...LINE_COMMENT_COMPOSITION_ATTEMPTS,
    ...DOLLAR_QUOTE_BELT_ATTEMPTS,
  ];
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
    "sql",
    "upsertSql",
  ]);

  // `sql` is derived from `quoteIdentifier` rather than supplied, so an engine cannot answer the
  // quoting entry and then receive statement text that bypassed it. It is the entry every emitted
  // identifier goes through (ADR-0039).
  assert.equal(
    sqliteDatabaseDialect().sql("SELECT [ownerId] FROM [notes] WHERE [id] = ?"),
    'SELECT "ownerId" FROM "notes" WHERE "id" = ?',
  );
  assert.equal(
    postgresDatabaseDialect().sql("SELECT [ownerId] FROM [notes] WHERE [id] = ?"),
    'SELECT "ownerId" FROM "notes" WHERE "id" = ?',
  );

  // A dialect built with a different quoting answer routes the same statement through its own,
  // which is the point of the derivation: the marker is not the answer.
  const backtickDialect = createDatabaseDialect({
    ...sqliteDatabaseDialect(),
    name: "mysql",
    quoteIdentifier: (identifier) => BACKTICK + identifier + BACKTICK,
  });
  assert.equal(backtickDialect.sql("SELECT [ownerId] FROM [notes]"), "SELECT " + BACKTICK + "ownerId" + BACKTICK + " FROM " + BACKTICK + "notes" + BACKTICK);
});

test("every normalization answers the whole seam", () => {
  const entries = ["columnName", "name", "row", "value"];
  assert.deepEqual(Object.keys(sqliteRowNormalization()).sort(), entries);
  assert.deepEqual(Object.keys(postgresRowNormalization()).sort(), entries);
  assert.deepEqual(Object.keys(libsqlRowNormalization()).sort(), entries);

  // `row` is derived from `columnName` and `value` rather than supplied, so an engine cannot apply
  // one and forget the other.
  //
  // Postgres's `columnName` is the identity, like the other two engines'. It used to be a table of
  // declared spellings folded back after Postgres lower-cased the runtime's unquoted DDL; ADR-0039
  // quoted that DDL, so nothing folds and there is nothing to restore. A row therefore arrives
  // under the names the statement asked for, whatever their case.
  assert.deepEqual(postgresRowNormalization().row({ verifierHash: "hashed", selector: "abc" }), {
    verifierHash: "hashed",
    selector: "abc",
  });
  // And a column whose declared name is already lower case is left alone rather than guessed at —
  // the collision that renamed a Capsule field called `errorcode` to `errorCode`.
  assert.deepEqual(postgresRowNormalization().row({ errorcode: "E1", jobid: "J1" }), { errorcode: "E1", jobid: "J1" });
  assert.deepEqual(libsqlRowNormalization().row({ attempts: { type: "integer", value: "3" } }), { attempts: 3 });
  assert.deepEqual(sqliteRowNormalization().row({ verifierHash: "hashed" }), { verifierHash: "hashed" });
});
