import assert from "node:assert/strict";
import test from "node:test";

import { ensureJobStorage, ensureScheduleStorage } from "../dist/server-runtime-source.js";
import { loadDatabaseAdapterConformanceSurfaces } from "./support/database-adapter-conformance.js";
import { withSqliteAdapter } from "./support/database-adapter-engines.js";

// The audit ADR-0039 turned into a check.
//
// Postgres folds an unquoted identifier to lower case, so a statement that names a column in a
// style its table was not created with is a live defect there and invisible on the two engines that
// fold nothing. The fix was to route every identifier the runtime emits through the dialect, which
// is only true while it stays true: one statement added later with a bare `ownerId` in it puts the
// defect straight back, on the engine the default Dev session does not use.
//
// This reads the statements themselves rather than the source that produces them. Every statement
// the runtime hands an engine while it bootstraps its own storage and while it runs the whole of
// ADR-0035's conformance specification is captured, and any that names a runtime-owned table or
// column without quoting it is reported. Reading the emitted text rather than the source text is
// what makes the check exact — there is no parse to get wrong, and a statement assembled from three
// concatenated fragments is checked as the one thing the engine receives.
//
// What it checks is derived, not restated: the runtime-owned tables are bootstrapped exactly as a
// Capsule start bootstraps them and their columns are enumerated from what those tables actually
// declare, so a table or column added later is covered without anyone bringing it here.
//
// Its bound is the paths driven below. A statement on a path neither the storage bootstrap nor the
// conformance specification reaches is not seen here; the round-trip guard in
// `postgres-runtime-column-names.test.js` and the conformance runs against a real Postgres are what
// cover those, and this is a third net rather than the only one.

// The two Job and Schedule bootstraps are imported by name rather than looked up in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS`. That lookup returned them until batch 4 moved the jobs and
// schedules domain into `jobs-runtime.js`, at which point it returns `undefined` — a domain that
// leaves the emitted list stops being findable there, which is the silent shape the re-export
// bridge exists to prevent and the same edit batch 3 made to thirteen call sites when auth moved.
// They resolve through `server-runtime-source.js` because it re-exports the module whole.
async function bootstrapRuntimeStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
  await adapter.ensureUserPreferencesStorage();
  await ensureJobStorage(adapter);
  await ensureScheduleStorage(adapter);
  await adapter.ensureFileStorage();
  await adapter.ensureLogStorage();
}

// The names the runtime-owned tables actually declare, read back from an engine that stores
// identifiers as written.
async function runtimeSchemaNames(adapter) {
  const tables = await adapter
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sporades%' ORDER BY name")
    .all();
  const tableNames = tables.map(({ name }) => String(name));
  const columnNames = new Set();
  for (const name of tableNames) {
    for (const column of await adapter.prepare(`PRAGMA table_info("${name}")`).all()) {
      columnNames.add(String(column.name));
    }
  }
  return { tableNames: new Set(tableNames), columnNames };
}

// Records every statement handed to the engine, and runs it, so the paths under audit behave
// exactly as they do without the recorder underneath them.
//
// `runReadOnlyInspectionQuery` is the one place the runtime emits statement text it did not author:
// `sporades db query <sql>` is typed by a human and reaches the engine as typed, because rewriting
// it would change the answer the operator asked for. What that method is given is noted and
// excluded, so the audit covers the runtime's own statements and says so rather than quietly
// tolerating anything that looks like a query.
function recordEmittedStatements(adapter, statements, passthrough = new Set()) {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "exec") {
        return (sql, ...rest) => {
          statements.push(String(sql));
          return target.exec(sql, ...rest);
        };
      }
      if (property === "prepare") {
        return (sql, ...rest) => {
          statements.push(String(sql));
          return target.prepare(sql, ...rest);
        };
      }
      if (property === "runReadOnlyInspectionQuery") {
        return (sql, ...rest) => {
          passthrough.add(String(sql));
          return target.runReadOnlyInspectionQuery.call(receiver, sql, ...rest);
        };
      }
      if (property === "withTransaction") {
        return (fn) => target.withTransaction(() => fn(receiver));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(receiver) : value;
    },
  });
}

// The identifiers a statement names without quoting them. Quoted identifiers and SQL string
// literals are removed first, so a value such as `'pending'` is not read as a column, and the
// comparison is case-sensitive so that `COUNT`, `TEXT` and `ORDER` are never confused with the
// columns `count`, `text` and `order`.
export function unquotedRuntimeIdentifiers(statement, tableNames, columnNames) {
  const withoutQuotedIdentifiers = String(statement).replace(/"(?:[^"]|"")*"/g, " ");
  const withoutSqlStrings = withoutQuotedIdentifiers.replace(/'[^']*'/g, " ");
  const found = new Set();
  for (const word of withoutSqlStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (tableNames.has(word) || columnNames.has(word)) found.add(word);
  }
  return [...found].sort();
}

function reportUnquoted(statements, tableNames, columnNames) {
  const offenders = [];
  for (const statement of statements) {
    const unquoted = unquotedRuntimeIdentifiers(statement, tableNames, columnNames);
    if (unquoted.length > 0) offenders.push(`${unquoted.join(", ")} in ${JSON.stringify(statement)}`);
  }
  return offenders;
}

test("every statement the runtime storage bootstrap emits quotes the identifiers it names", async () => {
  const { statements, tableNames, columnNames } = await withSqliteAdapter(async (adapter) => {
    const statements = [];
    await bootstrapRuntimeStorage(recordEmittedStatements(adapter, statements));

    // Run it again: the second pass is the one a Capsule restart performs, and it is where the
    // additive `ALTER TABLE ... ADD COLUMN` idiom and the backfills that follow it are emitted
    // against tables that already exist.
    await bootstrapRuntimeStorage(recordEmittedStatements(adapter, statements));

    return { statements, ...(await runtimeSchemaNames(adapter)) };
  });

  assert.ok(tableNames.size >= 16, `expected the runtime storage bootstrap to declare its tables, saw ${tableNames.size}`);
  assert.ok(columnNames.size > 60, `expected the runtime-owned tables to declare their columns, saw ${columnNames.size}`);
  assert.ok(statements.length > 60, `expected the bootstrap to emit its statements, saw ${statements.length}`);

  // And no marker reaches an engine. A `[likeThis]` in emitted text means a statement was built
  // without going through the dialect at all.
  assert.deepEqual(statements.filter((sql) => /\[[A-Za-z_]/.test(sql)), []);

  assert.deepEqual(
    reportUnquoted(statements, tableNames, columnNames),
    [],
    "runtime identifiers emitted without the dialect's quoting (ADR-0039). Postgres folds these to " +
    "lower case and the table they name was created case-preserved, so the statement fails there " +
    "and nowhere else. Write the identifier as `[name]` and pass the statement through `dialect.sql`.",
  );
});

test("every statement the conformance specification drives the adapter to emit quotes the identifiers it names", async () => {
  // The shared Database adapter method set, exercised through ADR-0035's own cases rather than
  // through a list of methods kept here: auth storage, File metadata storage, app tables, the Log
  // index, system metadata and the inspection surface all emit their statements under this
  // recorder. A method added to the adapter arrives here with the conformance case that ADR-0035
  // already requires it to have.
  const surfaces = (await loadDatabaseAdapterConformanceSurfaces()).filter((surface) => surface.entryPointNames.length > 0);
  assert.ok(surfaces.length > 0, "no conformance surface modules with a test entry point were discovered");

  const offenders = [];
  let statementCount = 0;
  for (const surface of surfaces) {
    await withSqliteAdapter(
      async (adapter) => {
        await bootstrapRuntimeStorage(adapter);
        const { tableNames, columnNames } = await runtimeSchemaNames(adapter);
        await surface.prepareStorage?.(adapter);

        const statements = [];
        const passthrough = new Set();
        const recording = recordEmittedStatements(adapter, statements, passthrough);
        for (const conformanceCase of surface.cases) {
          await conformanceCase.run(recording);
        }
        const emitted = statements.filter((sql) => !passthrough.has(sql));
        statementCount += emitted.length;
        offenders.push(...reportUnquoted(emitted, tableNames, columnNames));
        assert.deepEqual(emitted.filter((sql) => /\[[A-Za-z_]/.test(sql)), []);
      },
      { appTableNames: surface.appTableNames },
    );
  }

  assert.ok(statementCount > 100, `expected the conformance specification to emit its statements, saw ${statementCount}`);
  assert.deepEqual(
    offenders,
    [],
    "runtime identifiers emitted without the dialect's quoting (ADR-0039). Postgres folds these to " +
    "lower case and the table they name was created case-preserved, so the statement fails there " +
    "and nowhere else. Write the identifier as `[name]` and pass the statement through `dialect.sql`.",
  );
});

test("the check reports a statement that names a runtime column unquoted", async () => {
  // The check's own failure, against the statement the original defect produced. A check that has
  // never failed is not known to work, and this one exists because the failure it guards against is
  // invisible on the default engine.
  const { tableNames, columnNames } = await withSqliteAdapter(async (adapter) => {
    await bootstrapRuntimeStorage(adapter);
    return await runtimeSchemaNames(adapter);
  });

  assert.deepEqual(
    unquotedRuntimeIdentifiers(`UPDATE "sporades_jobs" SET "status"='queued' WHERE availableAt <= ?`, tableNames, columnNames),
    ["availableAt"],
  );
  assert.deepEqual(
    unquotedRuntimeIdentifiers(`SELECT * FROM sporades_schedules WHERE "name"=?`, tableNames, columnNames),
    ["sporades_schedules"],
  );

  // The same statements written the way the runtime writes them report nothing, so the check is
  // reporting the missing quoting rather than the statement.
  assert.deepEqual(
    unquotedRuntimeIdentifiers(`UPDATE "sporades_jobs" SET "status"='queued' WHERE "availableAt" <= ?`, tableNames, columnNames),
    [],
  );
  assert.deepEqual(
    unquotedRuntimeIdentifiers(`SELECT * FROM "sporades_schedules" WHERE "name"=?`, tableNames, columnNames),
    [],
  );

  // A value that happens to spell a column name is a value, not an identifier.
  assert.deepEqual(
    unquotedRuntimeIdentifiers(`UPDATE "sporades_jobs" SET "handler" = 'availableAt' WHERE "id" = ?`, tableNames, columnNames),
    [],
  );
});
