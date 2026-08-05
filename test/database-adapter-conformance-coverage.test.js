import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteDatabaseAdapter } from "../dist/server-runtime-source.js";
import { loadDatabaseAdapterConformanceSurfaces } from "./support/database-adapter-conformance.js";
import { withLibsqlAdapter, withSqliteAdapter } from "./support/database-adapter-engines.js";
import {
  CONFORMANCE_EXEMPTION_CATEGORIES,
  CONFORMANCE_EXEMPT_METHODS,
  databaseAdapterMethodNames,
  overriddenDatabaseAdapterMethodNames,
  recordDirectAdapterCalls,
  reviewConformanceMethodCoverage,
} from "./support/database-adapter-method-coverage.js";

// The check that closes this defect class against the method nobody thought to cover.
//
// ADR-0035 says adding a method to the Database adapter without adding it to the conformance
// specification leaves the work incomplete. Until now that was a sentence a contributor had to
// remember. Here it is the ordinary test command: the Database adapter method set is enumerated,
// every surface of the specification is replayed against a recording adapter to see which of those
// methods it actually exercises, and a method that is neither exercised nor explicitly exempt fails
// the run.
//
// The replay is against SQLite. This check answers "does the specification exercise this method",
// which is a question about the specification and not about any engine; whether the engines agree
// on the answer is what the per-engine runs of those same cases already decide.

// Every conformance case from every surface, run once against a fresh adapter per surface, with
// the methods each case calls directly recorded. Storage preparation runs unrecorded on purpose —
// seeding is not specifying.
//
// Only surfaces a test entry point imports are replayed. A surface module nothing imports has
// never run against libSQL, so crediting its cases here would answer "exercised once against
// SQLite" while reporting it as conformance coverage — and SQLite's synchronous statement
// primitives are the one engine's primitives that cannot expose this defect class. Such a module
// is reported by its own test below rather than counted here.
async function exerciseConformanceSurfaces() {
  const surfaces = (await loadDatabaseAdapterConformanceSurfaces()).filter((surface) => surface.entryPointNames.length > 0);
  assert.ok(surfaces.length > 0, "no conformance surface modules with a test entry point were discovered");

  const calledMethodNames = new Set();
  for (const surface of surfaces) {
    await withSqliteAdapter(
      async (adapter) => {
        await surface.prepareStorage?.(adapter);
        const recording = recordDirectAdapterCalls(adapter, calledMethodNames);
        for (const conformanceCase of surface.cases) {
          await conformanceCase.run(recording);
        }
      },
      { appTableNames: surface.appTableNames },
    );
  }
  return { surfaces, calledMethodNames };
}

async function sqliteMethodNames() {
  const adapter = await createSqliteDatabaseAdapter(":memory:");
  try {
    return databaseAdapterMethodNames(adapter);
  } finally {
    adapter.close();
  }
}

test("every Database adapter method has a conformance case or a recorded exemption", async () => {
  const methodNames = await sqliteMethodNames();
  const { surfaces, calledMethodNames } = await exerciseConformanceSurfaces();

  const review = reviewConformanceMethodCoverage({ methodNames, coveredMethodNames: calledMethodNames });

  assert.deepEqual(
    review.uncovered,
    [],
    `Database adapter methods with no conformance case:\n  ${review.uncovered.join("\n  ")}\n\n` +
    "Add a case to a surface module in test/support/conformance-surfaces/ that calls the method and " +
    "asserts what it answers for a given stored state, on both sides of any predicate. Only " +
    "connection lifecycle, SQL dialect emission and transaction session mechanics may be exempted " +
    "instead, and being overridden by an engine is never one of those reasons.",
  );

  // A guard on the measurement rather than on the method set. An exempt method may still be
  // covered — cases reach for `prepare` to seed and to read raw rows — so the floor is every
  // non-exempt method, and the ceiling is the whole method set.
  assert.ok(review.covered.length >= methodNames.length - CONFORMANCE_EXEMPT_METHODS.length);
  assert.ok(review.covered.length <= methodNames.length);
  assert.ok(surfaces.length >= 4, `expected every conformance surface to be replayed, saw ${surfaces.length}`);
});

test("every conformance surface module is run against every engine by a test entry point", async () => {
  const surfaces = await loadDatabaseAdapterConformanceSurfaces();
  assert.ok(surfaces.length > 0, "no conformance surface modules were discovered");

  // Coverage credit and engine execution have to be the same fact. A surface module is only run
  // against libSQL and the gated Postgres adapter because a `database-adapter-conformance-*.test.js`
  // entry point imports it and hands it to `runDatabaseAdapterConformance`; the coverage replay
  // above reaches every module in the directory and runs it against SQLite alone. Without this
  // test a contributor could add a surface, watch the gate go green, and have covered a method on
  // the one engine whose synchronous statement primitives cannot expose an unresolved result —
  // which is this specification's own failure mode, reached from the other side.
  assert.deepEqual(
    surfaces.filter((surface) => surface.entryPointNames.length === 0).map((surface) => surface.fileName),
    [],
    "conformance surface modules that no test entry point imports, so they never run against any engine but SQLite. " +
    "Add a test/database-adapter-conformance-<surface>.test.js that imports the module and passes it to " +
    "runDatabaseAdapterConformance.",
  );
});

test("every conformance exemption names a real method, one of the ADR-0035 mechanics, and a reason", async () => {
  const methodNames = await sqliteMethodNames();
  const review = reviewConformanceMethodCoverage({ methodNames, coveredMethodNames: [] });

  assert.deepEqual(review.staleExemptions, [], "exemptions for methods the Database adapter no longer exposes");
  assert.deepEqual(review.unknownCategories, [], "exemptions claiming a reason outside the ADR-0035 mechanics");
  assert.deepEqual(review.missingReasons, [], "exemptions with no recorded reason");

  // The closed vocabulary is the mechanical part of "being overridden by an engine is never a
  // reason". A contributor who wants to excuse a method because the engines replace it has to add
  // a category here, and that changes this assertion rather than passing unnoticed in a list.
  assert.deepEqual(Object.keys(CONFORMANCE_EXEMPTION_CATEGORIES).sort(), [
    "connection-lifecycle",
    "sql-dialect-emission",
    "transaction-session",
  ]);
});

test("a method an engine overrides still needs a conformance case", async () => {
  const methodNames = await sqliteMethodNames();
  const { calledMethodNames } = await exerciseConformanceSurfaces();

  const overridden = await withLibsqlAdapter(async (libsql) => {
    const shared = await createSqliteDatabaseAdapter(":memory:");
    try {
      return overriddenDatabaseAdapterMethodNames(shared, libsql);
    } finally {
      shared.close();
    }
  });

  // ADR-0034: an engine may change the statement text a method emits, never the answer it gives,
  // and a shared definition shadowed by an await-shim is dormant rather than correct. So the
  // enumeration must not lose an overridden method, and the specification must reach it.
  assert.ok(overridden.length > 0, "expected libSQL to override part of the shared method set");
  assert.deepEqual(overridden.filter((name) => !methodNames.includes(name)), []);

  const exemptNames = new Set(CONFORMANCE_EXEMPT_METHODS.map((exemption) => exemption.method));
  assert.deepEqual(
    overridden.filter((name) => !calledMethodNames.has(name) && !exemptNames.has(name)),
    [],
    "overridden Database adapter methods with no conformance case",
  );
});

test("every engine exposes the same Database adapter method names", async () => {
  const methodNames = await sqliteMethodNames();
  const libsqlMethodNames = await withLibsqlAdapter(async (libsql) => databaseAdapterMethodNames(libsql));

  // The enumeration is taken from the SQLite adapter because ADR-0034 defines the method set once
  // there. That is only sound while the engines present the same names; an engine that added one
  // would otherwise have a method the check could never see.
  assert.deepEqual(libsqlMethodNames, methodNames);
});

test("the coverage review reports a method the specification never exercises", () => {
  // The check's own failure, exercised. A check that has never failed is not known to work, and
  // this is the shape it has to catch: a method added to the adapter with no conformance case.
  const review = reviewConformanceMethodCoverage({
    methodNames: ["insertWidget", "selectWidget"],
    coveredMethodNames: ["selectWidget"],
    exemptions: [],
  });
  assert.deepEqual(review.uncovered, ["insertWidget"]);

  // An engine override is not a way out of that failure — the review has no notion of one, so a
  // shimmed method reports exactly as an unshadowed one does.
  assert.deepEqual(
    reviewConformanceMethodCoverage({
      methodNames: ["insertWidget"],
      coveredMethodNames: [],
      exemptions: [{ method: "insertWidget", category: "engine-override", reason: "libSQL overrides this anyway." }],
    }),
    {
      uncovered: [],
      staleExemptions: [],
      unknownCategories: ["insertWidget: engine-override"],
      missingReasons: [],
      covered: [],
    },
  );

  // And an exemption without a recorded reason, or for a method that no longer exists, is reported
  // rather than quietly honoured.
  const drifted = reviewConformanceMethodCoverage({
    methodNames: ["insertWidget"],
    coveredMethodNames: ["insertWidget"],
    exemptions: [
      { method: "deleteWidget", category: "connection-lifecycle", reason: "removed in a later change" },
      { method: "insertWidget", category: "connection-lifecycle", reason: "  " },
    ],
  });
  assert.deepEqual(drifted.staleExemptions, ["deleteWidget"]);
  assert.deepEqual(drifted.missingReasons, ["insertWidget"]);
});

test("the recording adapter counts a direct call and not a method's internal steps", () => {
  const called = new Set();
  const adapter = {
    outer() {
      return this.inner() + 1;
    },
    inner() {
      return 1;
    },
  };
  const recording = recordDirectAdapterCalls(adapter, called);

  assert.equal(recording.outer(), 2);
  assert.deepEqual([...called], ["outer"]);

  assert.equal(recording.inner(), 1);
  assert.deepEqual([...called].sort(), ["inner", "outer"]);
});
