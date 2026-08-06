import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter, withSqliteAdapter } from "./support/database-adapter-engines.js";

// Postgres folds an unquoted identifier to lower case, so a runtime-owned table declared with
// `createdAt TEXT NOT NULL` is stored as `createdat` and hands that name back on every read. The
// Database adapter restores the declared spelling in `postgresRuntimeColumnName`, and a column
// missing from it is not an error anywhere: the read returns `undefined` for that field and the
// runtime carries on. That is how a missing `verifierHash` entry rejected every valid password
// Reset code on Postgres while reporting an ordinary "invalid code".
//
// This file is the check that stops the next one. It does not restate the mapping — a second
// hand-maintained list would drift from the first — but derives what the mapping must cover from
// the schema the runtime actually declares: it bootstraps every runtime-owned table exactly as a
// Capsule boot does, on an engine that preserves declared case, enumerates the columns each table
// really has, and fails on any camelCase column the mapping cannot restore. A runtime table
// gaining a camelCase column without an entry is therefore an ordinary `npm test` failure rather
// than a silent wrong answer in a Hosted Capsule.
//
// The Job queue and Schedule surfaces get their read paths exercised here as well. ADR-0035's
// conformance specification asserts at the Database adapter method boundary, and these tables are
// reached through raw statements rather than through adapter methods, so they are outside that
// specification by design — which is also why nothing had ever read them back on Postgres.

function runtimeFunction(name) {
  const fn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((candidate) => candidate.name === name);
  assert.ok(fn, `${name} is not a server runtime source function`);
  return fn;
}

const ensureJobStorage = runtimeFunction("ensureJobStorage");
const ensureScheduleStorage = runtimeFunction("ensureScheduleStorage");
const postgresRuntimeColumnName = runtimeFunction("postgresRuntimeColumnName");

// Postgres is the only engine whose declared case is destroyed, so it is the only engine the
// mapping exists for; the other two are where the declared case can still be read back and are
// therefore where the mapping's completeness is decided. Every engine runs the read-path cases.
const ENGINES = [
  { name: "SQLite", skip: false, withAdapter: withSqliteAdapter, preservesDeclaredCase: true },
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter, preservesDeclaredCase: true },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter, preservesDeclaredCase: false },
];

const NOW = "2026-08-01T09:00:00.000Z";
const LATER = "2026-08-01T09:05:00.000Z";
const NEXT_OCCURRENCE = "2026-08-01T10:00:00.000Z";

// The bootstrap a Capsule start performs, in the order `initializeRuntime` performs it. Every
// runtime-owned table is created by one of these calls, so what they leave behind is the whole
// set of tables the mapping has to cover.
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

// The check, as a function, so that its own failure can be exercised below. A check that has
// never failed is not known to work, and this one exists precisely because the failure it guards
// against is invisible.
function unrestorableRuntimeColumns(declared, restore) {
  return declared
    .filter(({ column }) => column !== column.toLowerCase())
    .filter(({ column }) => restore(column.toLowerCase()) !== column)
    .map(({ table, column }) => `${table}.${column}`);
}

// Records the statement text a shared schema definition emits, without an engine underneath it.
// A shared definition is sent verbatim to whichever engine is configured, so a statement only one
// engine understands is a defect in the definition rather than in the engine that rejects it.
function recordingSchemaAdapter() {
  const statements = [];
  return {
    statements,
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
  test(`every camelCase column a runtime-owned table declares is restored on Postgres: declared on ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (adapter) => {
      await bootstrapRuntimeStorage(adapter);
      const declared = await declaredRuntimeColumns(adapter);

      // Guard the measurement: an enumeration that found nothing would satisfy the assertion
      // below without checking anything at all.
      assert.ok(declared.length > 100, `expected the runtime-owned tables to declare their columns, saw ${declared.length}`);
      assert.ok(
        declared.filter(({ column }) => column !== column.toLowerCase()).length > 40,
        "expected the runtime-owned tables to declare camelCase columns",
      );
      for (const table of ["sporades_jobs", "sporades_schedules", "sporades_schedule_occurrences", "sporades_auth_password_reset_codes"]) {
        assert.ok(declared.some((entry) => entry.table === table), `${table} was not created by the runtime storage bootstrap`);
      }

      assert.deepEqual(
        unrestorableRuntimeColumns(declared, postgresRuntimeColumnName),
        [],
        "runtime-owned columns Postgres folds to lower case that the Database adapter cannot restore. " +
        "Reading one of these on Postgres yields `undefined` rather than an error. Add the declared " +
        "spelling to `postgresRuntimeColumnName` in src/server-runtime-source.ts.",
      );
    });
  });
}

test("every runtime-owned table hands back its declared column names on Postgres", { skip: POSTGRES_SKIP_REASON }, async () => {
  // The mapping check above decides completeness on an engine that never folds anything, which
  // makes it a statement about the mapping rather than about Postgres. This is the same claim
  // settled against Postgres itself: every runtime-owned table is bootstrapped there, and the
  // column names a read of that table produces are compared against the names the same bootstrap
  // declares on an engine that stores identifiers as written.
  const declared = await withSqliteAdapter(async (adapter) => {
    await bootstrapRuntimeStorage(adapter);
    return await declaredRuntimeColumns(adapter);
  });
  const declaredByTable = new Map();
  for (const { table, column } of declared) {
    declaredByTable.set(table, [...(declaredByTable.get(table) ?? []), column]);
  }
  assert.ok(declaredByTable.size >= 16, `expected the runtime storage bootstrap to declare its tables, saw ${declaredByTable.size}`);

  await withPostgresAdapter(async (adapter) => {
    await bootstrapRuntimeStorage(adapter);

    for (const [table, columns] of [...declaredByTable].sort()) {
      // `columns()` is the adapter's own read-path naming: it runs the statement's row
      // description through the same restoration every returned row goes through.
      const readBack = await adapter.prepare(`SELECT * FROM ${table}`).columns();
      assert.deepEqual(
        readBack.map((column) => column.name).sort(),
        [...columns].sort(),
        `${table} hands back column names on Postgres that differ from the ones the runtime declares`,
      );
    }
  }, { appTableNames: [] });
});

test("the check reports a runtime column whose Postgres-folded name cannot be restored", () => {
  // The guard's own failure, exercised against a deliberately unmapped column. `launchedAt` is
  // not a runtime column and has no entry, which is exactly the state every column on the Job
  // queue and Schedule tables was in before this change.
  const declared = [
    { table: "sporades_widgets", column: "id" },
    { table: "sporades_widgets", column: "createdAt" },
    { table: "sporades_widgets", column: "launchedAt" },
  ];
  assert.deepEqual(unrestorableRuntimeColumns(declared, postgresRuntimeColumnName), ["sporades_widgets.launchedAt"]);

  // And it says nothing about a column the mapping does restore, so the report is a list of gaps
  // rather than a list of camelCase columns.
  assert.deepEqual(unrestorableRuntimeColumns(declared.slice(0, 2), postgresRuntimeColumnName), []);
});

test("the ADR-0033 Reset code verifier survives the Postgres fold", () => {
  // The regression issue 03 fixed, kept as its own case: this one entry is what stands between a
  // valid Reset code and an "invalid code" message on Postgres.
  assert.equal(postgresRuntimeColumnName("verifierhash"), "verifierHash");

  // An identifier the runtime does not declare is handed back untouched rather than guessed at.
  assert.equal(postgresRuntimeColumnName("id"), "id");
  assert.equal(postgresRuntimeColumnName("column_from_an_app_table"), "column_from_an_app_table");
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

  const scheduleRecording = recordingSchemaAdapter();
  await ensureScheduleStorage(scheduleRecording);
  assert.ok(scheduleRecording.statements.length > 0, "expected the Schedule storage bootstrap to emit statements");
  assert.deepEqual(scheduleRecording.statements.filter((sql) => /\bPRAGMA\b/i.test(sql)), []);
});

for (const engine of ENGINES) {
  test(`the Job queue and Schedule read paths return correctly-named fields: ${engine.name}`, { skip: engine.skip }, async (t) => {
    await engine.withAdapter(async (adapter) => {
      await bootstrapRuntimeStorage(adapter);

      await t.test("a Job row reads back under the field names the Job queue reads", async () => {
        await adapter
          .prepare(
            "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, actorProvider, payload, status, availableAt, " +
            "attempts, idempotencyKey, createdAt, startedAt, retryJson, attemptHistory, leaseExpiresAt, scheduleName, scheduledFor) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

        const row = await adapter.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get("job-read-back");
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

        // The whole key set, not only the fields read above: a restoration that recovered some
        // names and left others folded would satisfy a field-by-field check on the names it
        // happened to cover, which is exactly the state `verifierHash` was in.
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
        assert.equal((await adapter.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get("job-never-enqueued")) ?? null, null);
      });

      await t.test("a Schedule row and its occurrence read back under the field names the Schedule runtime reads", async () => {
        await adapter
          .prepare(
            "INSERT INTO sporades_schedules (name, definitionFingerprint, expression, effectiveTimezone, missedRunPolicy, enabled, " +
            "nextOccurrence, latestScheduledFor, latestOutcome, latestJobId, latestErrorCode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("nightly", "fingerprint-1", "0 3 * * *", "UTC", "skip", 1, NEXT_OCCURRENCE, NOW, "enqueued", "job-read-back", null);

        const schedule = await adapter.prepare("SELECT * FROM sporades_schedules WHERE name = ?").get("nightly");
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
            "INSERT INTO sporades_schedule_occurrences (id, scheduleName, scheduledFor, status, claimToken, claimExpiresAt, jobId, " +
            "errorCode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("nightly@" + NOW, "nightly", NOW, "pending", "claim-token", NEXT_OCCURRENCE, "job-read-back", null, NOW, LATER);

        const occurrence = await adapter.prepare("SELECT * FROM sporades_schedule_occurrences WHERE id = ?").get("nightly@" + NOW);
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

        // The projections the Schedule runtime actually selects, rather than `SELECT *`, restore
        // their names too — the claim sweep reads these two columns by name.
        const pending = await adapter
          .prepare("SELECT scheduleName, scheduledFor FROM sporades_schedule_occurrences WHERE status = 'pending' ORDER BY scheduledFor ASC")
          .all();
        assert.deepEqual(
          pending.map((entry) => ({ scheduleName: entry.scheduleName, scheduledFor: entry.scheduledFor })),
          [{ scheduleName: "nightly", scheduledFor: NOW }],
        );

        assert.equal((await adapter.prepare("SELECT * FROM sporades_schedules WHERE name = ?").get("never-declared")) ?? null, null);
      });

      await t.test("running the Job queue and Schedule storage bootstrap again keeps the stored rows", async () => {
        await ensureJobStorage(adapter);
        await ensureScheduleStorage(adapter);

        assert.equal((await adapter.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get("job-read-back"))?.availableAt, NOW);
        assert.equal((await adapter.prepare("SELECT * FROM sporades_schedules WHERE name = ?").get("nightly"))?.nextOccurrence, NEXT_OCCURRENCE);
        assert.equal(
          (await adapter.prepare("SELECT * FROM sporades_schedule_occurrences WHERE id = ?").get("nightly@" + NOW))?.claimExpiresAt,
          NEXT_OCCURRENCE,
        );
      });
    }, { appTableNames: [] });
  });
}
