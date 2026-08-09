import assert from "node:assert/strict";
import test from "node:test";

import { ensureJobStorage, ensureScheduleStorage, postgresRowNormalization, sqliteDatabaseDialect } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter, withSqliteAdapter } from "./support/database-adapter-engines.js";

// Postgres folds an unquoted identifier to lower case, so a runtime-owned table declared with
// `createdAt TEXT NOT NULL` used to be stored as `createdat` and to hand that name back on every
// read. The Database adapter folded it back through a hand-maintained table of declared spellings,
// and a column missing from that table was not an error anywhere: the read answered `undefined` for
// that field and the runtime carried on. That is how a missing `verifierHash` entry rejected every
// valid password Reset code on Postgres while reporting an ordinary "invalid code".
//
// ADR-0039 removed the mechanism rather than completing the table. Every identifier the runtime
// emits — DDL included — is quoted through the dialect, so Postgres stores and returns the declared
// spelling and `postgresRowNormalization().columnName` is the identity, like the other engines'.
//
// This file is that claim's guard, and it is a stronger claim than the one it replaces. The old
// check asked whether the table of spellings covered every camelCase column a runtime table
// declares — a question about a lookup. This one asks whether the declared spellings survive the
// Postgres read path with no lookup in between, which is the thing quoting is supposed to make
// true. It is still derived rather than restated: the tables are bootstrapped exactly as a Capsule
// boot bootstraps them, and the columns they actually declare are enumerated rather than listed, so
// a runtime table gaining a column reaches this check without anyone remembering to bring it here.
//
// The Job queue and Schedule surfaces get their read paths exercised here as well. ADR-0035's
// conformance specification asserts at the Database adapter method boundary, and these tables are
// reached through raw statements rather than through adapter methods, so they are outside that
// specification by design — which is also why nothing had ever read them back on Postgres.

// The two bootstraps are imported by name rather than looked up in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS`. That lookup returned them until batch 4 moved the jobs and
// schedules domain into `jobs-runtime.js`, at which point it returns `undefined` — and because
// these two were resolved at module scope, the whole file failed to import rather than failing one
// assertion. They resolve through `server-runtime-source.js` because it re-exports the module
// whole; this is the same edit batch 3 made to thirteen call sites when auth moved.

// Postgres is the only engine that ever folded, so it is the only engine the round-trip is in
// doubt on; the other two are where the declared spellings can be enumerated. Every engine runs the
// read-path cases.
const ENGINES = [
  { name: "SQLite", skip: false, withAdapter: withSqliteAdapter, preservesDeclaredCase: true },
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter, preservesDeclaredCase: true },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter, preservesDeclaredCase: false },
];

const NOW = "2026-08-01T09:00:00.000Z";
const LATER = "2026-08-01T09:05:00.000Z";
const NEXT_OCCURRENCE = "2026-08-01T10:00:00.000Z";

// The bootstrap a Capsule start performs, in the order `initializeRuntime` performs it. Every
// runtime-owned table is created by one of these calls, so what they leave behind is the whole set
// of tables whose spellings have to survive.
async function bootstrapRuntimeStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
  await adapter.ensureUserPreferencesStorage();
  await ensureJobStorage(adapter);
  await ensureScheduleStorage(adapter);
  await adapter.ensureFileStorage();
  await adapter.ensureLogStorage();
}

// The columns the runtime-owned tables actually declare, read back from an engine that stores
// identifiers as written. Enumerated rather than listed, so a column added to a runtime table
// reaches this check without anyone remembering to bring it here.
async function declaredRuntimeColumns(adapter) {
  const tables = await adapter
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sporades%' ORDER BY name")
    .all();
  const declared = [];
  for (const { name } of tables) {
    const columns = await adapter.prepare(`PRAGMA table_info("${name}")`).all();
    for (const column of columns) {
      declared.push({ table: String(name), column: String(column.name) });
    }
  }
  return declared;
}

// The check, as a function, so that its own failure can be exercised below. A check that has never
// failed is not known to work, and this one exists precisely because the failure it guards against
// is invisible.
//
// `readBackColumnNames(table)` answers the names that table's read path produces on Postgres. A
// declared spelling the read path does not answer is reported as `table.column`; a name Postgres
// answers that nothing declared is reported too, because a column silently renamed on the way out
// is the same defect seen from the other side.
async function columnsThatDoNotRoundTrip(declaredByTable, readBackColumnNames) {
  const mismatches = [];
  for (const [table, columns] of [...declaredByTable].sort()) {
    const readBack = await readBackColumnNames(table);
    for (const column of columns) {
      if (!readBack.includes(column)) mismatches.push(`${table}.${column}`);
    }
    for (const column of readBack) {
      if (!columns.includes(column)) mismatches.push(`${table}.${column} (returned but not declared)`);
    }
  }
  return mismatches.sort();
}

async function declaredRuntimeColumnsByTable() {
  const declared = await withSqliteAdapter(async (adapter) => {
    await bootstrapRuntimeStorage(adapter);
    return await declaredRuntimeColumns(adapter);
  });
  const declaredByTable = new Map();
  for (const { table, column } of declared) {
    declaredByTable.set(table, [...(declaredByTable.get(table) ?? []), column]);
  }
  return { declared, declaredByTable };
}

// Records the statement text a shared schema definition emits, without an engine underneath it.
// A shared definition is sent verbatim to whichever engine is configured, so a statement only one
// engine understands is a defect in the definition rather than in the engine that rejects it.
// A fake engine, built the way the seam says an engine is built: statement primitives plus a
// dialect. It carries SQLite's real dialect on purpose, because SQLite is the engine whose
// add-a-missing-column idiom is `PRAGMA table_info` — so if a shared bootstrap could still reach a
// PRAGMA through the dialect, this is the dialect that would produce one.
function recordingSchemaAdapter() {
  const statements = [];
  return {
    statements,
    dialect: sqliteDatabaseDialect(),
    exec(sql) {
      statements.push(String(sql));
      return Promise.resolve(undefined);
    },
    prepare(sql) {
      statements.push(String(sql));
      return {
        all: async () => [],
        get: async () => null,
        run: async () => ({ changes: 0 }),
      };
    },
  };
}

for (const engine of ENGINES.filter((candidate) => candidate.preservesDeclaredCase)) {
  test(`the runtime-owned tables declare the camelCase columns this guard is about: declared on ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (adapter) => {
      await bootstrapRuntimeStorage(adapter);
      const declared = await declaredRuntimeColumns(adapter);

      // Guard the measurement: an enumeration that found nothing would satisfy the round-trip
      // assertion below without checking anything at all.
      assert.ok(declared.length > 100, `expected the runtime-owned tables to declare their columns, saw ${declared.length}`);
      assert.ok(
        declared.filter(({ column }) => column !== column.toLowerCase()).length > 40,
        "expected the runtime-owned tables to declare camelCase columns",
      );
      for (const table of ["sporades_jobs", "sporades_schedules", "sporades_schedule_occurrences", "sporades_auth_password_reset_codes"]) {
        assert.ok(declared.some((entry) => entry.table === table), `${table} was not created by the runtime storage bootstrap`);
      }
    });
  });
}

test("every runtime-owned table's declared spellings survive the Postgres read path", { skip: POSTGRES_SKIP_REASON }, async () => {
  // The claim ADR-0039 makes, settled against Postgres itself. Every runtime-owned table is
  // bootstrapped there, and the column names a read of that table produces are compared against the
  // names the same bootstrap declares on an engine that stores identifiers as written.
  const { declaredByTable } = await declaredRuntimeColumnsByTable();
  assert.ok(declaredByTable.size >= 16, `expected the runtime storage bootstrap to declare its tables, saw ${declaredByTable.size}`);

  await withPostgresAdapter(async (adapter) => {
    await bootstrapRuntimeStorage(adapter);

    // With nothing folded there is nothing to restore, so the read path applies no lookup at all.
    // Asserted rather than assumed, because a lookup reintroduced here is exactly the mechanism
    // that renamed a Capsule field called `errorcode` to `errorCode`.
    assert.equal(adapter.normalization.columnName("errorcode"), "errorcode");
    assert.equal(adapter.normalization.columnName("verifierHash"), "verifierHash");
    assert.equal(postgresRowNormalization().columnName("jobid"), "jobid");

    const mismatches = await columnsThatDoNotRoundTrip(declaredByTable, async (table) => {
      // `columns()` is the adapter's own read-path naming: it runs the statement's row description
      // through the same normalization every returned row goes through.
      const readBack = await adapter.prepare(`SELECT * FROM ${adapter.dialect.quoteIdentifier(table)}`).columns();
      return readBack.map((column) => column.name);
    });

    assert.deepEqual(
      mismatches,
      [],
      "runtime-owned columns whose declared spelling does not survive the Postgres read path. " +
      "Reading one of these on Postgres yields `undefined` rather than an error. The statement that " +
      "declares the column is emitting an identifier unquoted; route it through `dialect.sql` in " +
      "src/server-runtime-source.ts.",
    );
  }, { appTableNames: [] });
});

test("the guard reports a runtime column declared by a deliberately unquoted statement", { skip: POSTGRES_SKIP_REASON }, async () => {
  // The guard's own failure, exercised against the real defect on a real Postgres: a `CREATE TABLE`
  // that names its columns unquoted, which is what every runtime-owned table's DDL did before
  // ADR-0039. Postgres folds `launchedAt` to `launchedat`, so the declared spelling does not come
  // back and the guard says so. Without this case the assertion above would pass just as happily
  // against a guard that could never fail.
  await withPostgresAdapter(async (adapter) => {
    await adapter.exec('DROP TABLE IF EXISTS "sporades_widgets"');
    await adapter.exec("CREATE TABLE sporades_widgets (id TEXT PRIMARY KEY, createdAt TEXT, launchedAt TEXT)");
    try {
      const declaredByTable = new Map([["sporades_widgets", ["id", "createdAt", "launchedAt"]]]);
      const mismatches = await columnsThatDoNotRoundTrip(declaredByTable, async (table) => {
        const readBack = await adapter.prepare(`SELECT * FROM ${adapter.dialect.quoteIdentifier(table)}`).columns();
        return readBack.map((column) => column.name);
      });

      assert.deepEqual(mismatches, [
        "sporades_widgets.createdAt",
        "sporades_widgets.createdat (returned but not declared)",
        "sporades_widgets.launchedAt",
        "sporades_widgets.launchedat (returned but not declared)",
      ]);

      // And the same table declared through the dialect round-trips, so the guard is reporting the
      // quoting and not merely the table name.
      await adapter.exec('DROP TABLE IF EXISTS "sporades_widgets"');
      await adapter.exec(
        adapter.dialect.sql("CREATE TABLE [sporades_widgets] ([id] TEXT PRIMARY KEY, [createdAt] TEXT, [launchedAt] TEXT)"),
      );
      const quoted = await columnsThatDoNotRoundTrip(declaredByTable, async (table) => {
        const readBack = await adapter.prepare(`SELECT * FROM ${adapter.dialect.quoteIdentifier(table)}`).columns();
        return readBack.map((column) => column.name);
      });
      assert.deepEqual(quoted, []);
    } finally {
      await adapter.exec('DROP TABLE IF EXISTS "sporades_widgets"');
    }
  }, { appTableNames: [] });
});

test("the ADR-0033 Reset code verifier survives the Postgres read path", { skip: POSTGRES_SKIP_REASON }, async () => {
  // The regression issue 03 fixed, kept as its own case and asserted as the round-trip rather than
  // as the mechanism that used to deliver it: a `verifierHash` that reads back undefined is an
  // "invalid code" message for every valid Reset code on Postgres.
  await withPostgresAdapter(async (adapter) => {
    await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
    await adapter.insertPasswordResetCode({
      selector: "reset-selector-roundtrip",
      verifierHash: "verifier-hash-roundtrip",
      email: "reset@example.com",
      userId: "user-reset",
      createdAt: NOW,
      expiresAt: NEXT_OCCURRENCE,
    });

    const found = await adapter.findPasswordResetCode("reset-selector-roundtrip");
    assert.equal(found?.verifierHash, "verifier-hash-roundtrip");
    assert.deepEqual(Object.keys(found).sort(), ["createdAt", "email", "expiresAt", "selector", "userId", "verifierHash"]);
  }, { appTableNames: [] });
});

test("the shared Job queue storage bootstrap emits no single-engine statement", async () => {
  // `ensureJobStorage` is a shared definition: the Database adapter sends its statements verbatim
  // to whichever engine is configured. A `PRAGMA` in it is SQLite's alone, and Postgres rejects it
  // outright, so the Job queue never reaches the point of returning a wrongly-named field there.
  const recording = recordingSchemaAdapter();
  await ensureJobStorage(recording);

  assert.ok(recording.statements.length > 0, "expected the Job queue storage bootstrap to emit statements");
  assert.deepEqual(
    recording.statements.filter((sql) => /\bPRAGMA\b/i.test(sql)),
    [],
    "SQLite-only statements in the shared Job queue storage definition, which every engine receives verbatim.",
  );

  // And no marker survives into a statement, on any bootstrap. An identifier that reached an engine
  // still written `[likeThis]` would mean a statement built without going through the dialect.
  assert.deepEqual(recording.statements.filter((sql) => /\[[A-Za-z_]/.test(sql)), []);

  const scheduleRecording = recordingSchemaAdapter();
  await ensureScheduleStorage(scheduleRecording);
  assert.ok(scheduleRecording.statements.length > 0, "expected the Schedule storage bootstrap to emit statements");
  assert.deepEqual(scheduleRecording.statements.filter((sql) => /\bPRAGMA\b/i.test(sql)), []);
  assert.deepEqual(scheduleRecording.statements.filter((sql) => /\[[A-Za-z_]/.test(sql)), []);
});

for (const engine of ENGINES) {
  test(`the Job queue and Schedule read paths return correctly-named fields: ${engine.name}`, { skip: engine.skip }, async (t) => {
    await engine.withAdapter(async (adapter) => {
      await bootstrapRuntimeStorage(adapter);
      const sql = adapter.dialect.sql;

      await t.test("a Job row reads back under the field names the Job queue reads", async () => {
        await adapter
          .prepare(
            sql(
              "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], " +
              "[status], [availableAt], [attempts], [idempotencyKey], [createdAt], [startedAt], [retryJson], " +
              "[attemptHistory], [leaseExpiresAt], [scheduleName], [scheduledFor]) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
          )
          .run(
            "job-read-back",
            "sendWelcome",
            "user-enqueued-by",
            "user-actor",
            "email",
            '{"to":"someone@example.com"}',
            "running",
            NOW,
            1,
            "welcome-once",
            NOW,
            LATER,
            '{"maxAttempts":3,"delayMs":250}',
            "[]",
            NEXT_OCCURRENCE,
            "nightly",
            NOW,
          );

        const row = await adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get("job-read-back");
        assert.deepEqual(
          {
            id: row?.id,
            handler: row?.handler,
            enqueuedByUserId: row?.enqueuedByUserId,
            actorUserId: row?.actorUserId,
            actorProvider: row?.actorProvider,
            status: row?.status,
            availableAt: row?.availableAt,
            attempts: Number(row?.attempts),
            idempotencyKey: row?.idempotencyKey,
            createdAt: row?.createdAt,
            startedAt: row?.startedAt,
            retryJson: row?.retryJson,
            attemptHistory: row?.attemptHistory,
            leaseExpiresAt: row?.leaseExpiresAt,
            scheduleName: row?.scheduleName,
            scheduledFor: row?.scheduledFor,
            completedAt: row?.completedAt,
            failedAt: row?.failedAt,
            cancelRequestedAt: row?.cancelRequestedAt,
          },
          {
            id: "job-read-back",
            handler: "sendWelcome",
            enqueuedByUserId: "user-enqueued-by",
            actorUserId: "user-actor",
            actorProvider: "email",
            status: "running",
            availableAt: NOW,
            attempts: 1,
            idempotencyKey: "welcome-once",
            createdAt: NOW,
            startedAt: LATER,
            retryJson: '{"maxAttempts":3,"delayMs":250}',
            attemptHistory: "[]",
            leaseExpiresAt: NEXT_OCCURRENCE,
            scheduleName: "nightly",
            scheduledFor: NOW,
            completedAt: null,
            failedAt: null,
            cancelRequestedAt: null,
          },
        );

        // The whole key set, not only the fields read above: a read path that recovered some names
        // and left others folded would satisfy a field-by-field check on the names it happened to
        // cover, which is exactly the state `verifierHash` was in.
        assert.deepEqual(Object.keys(row).sort(), [
          "actorProvider",
          "actorUserId",
          "attemptHistory",
          "attempts",
          "availableAt",
          "cancelRequestedAt",
          "completedAt",
          "createdAt",
          "enqueuedByUserId",
          "failedAt",
          "failure",
          "handler",
          "id",
          "idempotencyKey",
          "leaseExpiresAt",
          "payload",
          "result",
          "retryJson",
          "scheduleName",
          "scheduledFor",
          "startedAt",
          "status",
        ]);

        // The absent row answers differently from the stored one, so a read that always produced
        // the same shape would not pass. `?? null` because these are raw statement primitives
        // rather than Database adapter methods, and the engines differ on whether an empty `get`
        // is `undefined` or `null` — engine mechanics, not the field naming under test here.
        assert.equal((await adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get("job-never-enqueued")) ?? null, null);
      });

      await t.test("a Schedule row and its occurrence read back under the field names the Schedule runtime reads", async () => {
        await adapter
          .prepare(
            sql(
              "INSERT INTO [sporades_schedules] ([name], [definitionFingerprint], [expression], [effectiveTimezone], " +
              "[missedRunPolicy], [enabled], [nextOccurrence], [latestScheduledFor], [latestOutcome], [latestJobId], " +
              "[latestErrorCode]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
          )
          .run("nightly", "fingerprint-1", "0 3 * * *", "UTC", "skip", 1, NEXT_OCCURRENCE, NOW, "enqueued", "job-read-back", null);

        const schedule = await adapter.prepare(sql("SELECT * FROM [sporades_schedules] WHERE [name] = ?")).get("nightly");
        assert.deepEqual(
          {
            name: schedule?.name,
            definitionFingerprint: schedule?.definitionFingerprint,
            expression: schedule?.expression,
            effectiveTimezone: schedule?.effectiveTimezone,
            missedRunPolicy: schedule?.missedRunPolicy,
            enabled: Number(schedule?.enabled),
            nextOccurrence: schedule?.nextOccurrence,
            latestScheduledFor: schedule?.latestScheduledFor,
            latestOutcome: schedule?.latestOutcome,
            latestJobId: schedule?.latestJobId,
            latestErrorCode: schedule?.latestErrorCode,
          },
          {
            name: "nightly",
            definitionFingerprint: "fingerprint-1",
            expression: "0 3 * * *",
            effectiveTimezone: "UTC",
            missedRunPolicy: "skip",
            enabled: 1,
            nextOccurrence: NEXT_OCCURRENCE,
            latestScheduledFor: NOW,
            latestOutcome: "enqueued",
            latestJobId: "job-read-back",
            latestErrorCode: null,
          },
        );

        await adapter
          .prepare(
            sql(
              "INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [scheduledFor], [status], [claimToken], " +
              "[claimExpiresAt], [jobId], [errorCode], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
          )
          .run("nightly@" + NOW, "nightly", NOW, "pending", "claim-token", NEXT_OCCURRENCE, "job-read-back", null, NOW, LATER);

        const occurrence = await adapter
          .prepare(sql("SELECT * FROM [sporades_schedule_occurrences] WHERE [id] = ?"))
          .get("nightly@" + NOW);
        assert.deepEqual(
          {
            id: occurrence?.id,
            scheduleName: occurrence?.scheduleName,
            scheduledFor: occurrence?.scheduledFor,
            status: occurrence?.status,
            claimToken: occurrence?.claimToken,
            claimExpiresAt: occurrence?.claimExpiresAt,
            jobId: occurrence?.jobId,
            errorCode: occurrence?.errorCode,
            createdAt: occurrence?.createdAt,
            updatedAt: occurrence?.updatedAt,
          },
          {
            id: "nightly@" + NOW,
            scheduleName: "nightly",
            scheduledFor: NOW,
            status: "pending",
            claimToken: "claim-token",
            claimExpiresAt: NEXT_OCCURRENCE,
            jobId: "job-read-back",
            errorCode: null,
            createdAt: NOW,
            updatedAt: LATER,
          },
        );

        // The projections the Schedule runtime actually selects, rather than `SELECT *`, keep their
        // names too — the claim sweep reads these two columns by name.
        const pending = await adapter
          .prepare(
            sql(
              "SELECT [scheduleName], [scheduledFor] FROM [sporades_schedule_occurrences] " +
              "WHERE [status] = 'pending' ORDER BY [scheduledFor] ASC",
            ),
          )
          .all();
        assert.deepEqual(
          pending.map((entry) => ({ scheduleName: entry.scheduleName, scheduledFor: entry.scheduledFor })),
          [{ scheduleName: "nightly", scheduledFor: NOW }],
        );

        assert.equal((await adapter.prepare(sql("SELECT * FROM [sporades_schedules] WHERE [name] = ?")).get("never-declared")) ?? null, null);
      });

      await t.test("running the Job queue and Schedule storage bootstrap again keeps the stored rows", async () => {
        await ensureJobStorage(adapter);
        await ensureScheduleStorage(adapter);

        assert.equal((await adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get("job-read-back"))?.availableAt, NOW);
        assert.equal(
          (await adapter.prepare(sql("SELECT * FROM [sporades_schedules] WHERE [name] = ?")).get("nightly"))?.nextOccurrence,
          NEXT_OCCURRENCE,
        );
        assert.equal(
          (await adapter.prepare(sql("SELECT * FROM [sporades_schedule_occurrences] WHERE [id] = ?")).get("nightly@" + NOW))?.claimExpiresAt,
          NEXT_OCCURRENCE,
        );
      });
    }, { appTableNames: [] });
  });
}
