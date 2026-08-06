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
