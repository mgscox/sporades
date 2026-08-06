import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter, withSqliteAdapter } from "./support/database-adapter-engines.js";

// The upgrade path for ADR-0036's ordering column, exercised from the table shape that existed
// before the column did.
//
// `test/log-index-sequence.test.js` covers the field itself and `backfillLogIndexSequences` covers
// the values it derives, but both start from the current DDL, which already creates
// `indexSequence`. Nothing there ever reaches the `ALTER TABLE ... ADD COLUMN` in
// `createLogIndexTables`, so the one statement the whole upgrade story rests on could be deleted
// and every committed test would stay green. Issue 10's reviewer confirmed that by hand. This file
// is that hand probe, made permanent: it builds the pre-change table, seeds it, and boots the real
// storage bootstrap.

const ENGINES = [
  { name: "SQLite", skip: false, withAdapter: withSqliteAdapter },
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter },
];

const LOG_INDEX_TABLE = "sporades_log_events";

// Legacy rows whose insertion order, timestamps and ids all disagree, so that an order which
// accidentally followed any one of them would be visible. Two of them share a timestamp, which is
// the routine case ADR-0036 exists for rather than an exotic one.
//
// The backfill reads `ORDER BY timestamp ASC, id ASC`, so the order it assigns is: tied-a, tied-b
// (same instant, lower id first), second, third. That is none of the three orders below.
const LEGACY_ROWS = [
  { id: "legacy-c", timestamp: "2026-07-04T10:00:02.000Z", message: "legacy-third" },
  { id: "legacy-a", timestamp: "2026-07-04T10:00:00.000Z", message: "legacy-tied-a" },
  { id: "legacy-d", timestamp: "2026-07-04T10:00:01.000Z", message: "legacy-second" },
  { id: "legacy-b", timestamp: "2026-07-04T10:00:00.000Z", message: "legacy-tied-b" },
];

const BACKFILLED_ORDER = ["legacy-tied-a", "legacy-tied-b", "legacy-second", "legacy-third"];

// The exact values the backfill is expected to write, stated as literals rather than recomputed, so
// that a change to the derivation or to the tie separation has to be made deliberately here too.
// `2026-07-04T10:00:00.000Z` is 1783159200000 ms, so 1783159200000000000ns, padded to twenty
// digits. The second row on that instant is separated by a single nanosecond, because ties among
// already-stored rows are unrecoverable and the backfill only has to make the result defined.
const BACKFILLED_SEQUENCES = [
  "01783159200000000000",
  "01783159200000000001",
  "01783159201000000000",
  "01783159202000000000",
];

function runtimeFunction(name) {
  const fn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((candidate) => candidate.name === name);
  assert.ok(fn, `${name} is not a server runtime source function`);
  return fn;
}

// The pre-change table shape, derived from the shipping DDL rather than copied from it.
//
// `createLogIndexTables` builds its `CREATE TABLE` as a literal, so the only way to get at it
// without duplicating it is to run the function against a recorder that answers every call and
// executes nothing. Issue 10 added exactly one column, so the current statement minus that column
// is the shape a Capsule built before issue 10 has. Deriving it this way means a later change to
// the DDL — issue 12 quoting every identifier, for instance — flows into this fixture instead of
// leaving a stale copy behind that no longer describes any real database.
function logIndexBootstrapStatements() {
  const statements = [];
  const recorder = {
    exec: (sql) => {
      statements.push(String(sql));
    },
    prepare: (sql) => {
      statements.push(String(sql));
      return { all: () => [], run: () => undefined };
    },
    dialect: {
      addMissingColumn: (_adapter, table, column, type) => {
        statements.push(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      },
    },
  };
  runtimeFunction("createLogIndexTables")(recorder);
  return statements;
}

function legacyLogIndexDdl() {
  const [createTable] = logIndexBootstrapStatements();
  assert.match(
    String(createTable),
    new RegExp(`^CREATE TABLE IF NOT EXISTS "?${LOG_INDEX_TABLE}"?\\s*\\(`, "i"),
    "the Log index bootstrap no longer opens with the CREATE TABLE this fixture is derived from",
  );

  // Tolerant of the column sitting anywhere in the list and of the identifier being quoted, so that
  // neither a reordering nor issue 12's quoting silently produces a fixture that still has the
  // column in it.
  const legacy = String(createTable)
    .replace(/\s*"?indexSequence"?\s+TEXT\s*,/i, "")
    .replace(/,\s*"?indexSequence"?\s+TEXT\s*(?=\))/i, "");

  assert.notEqual(legacy, String(createTable), "the ordering column was not found in the Log index DDL, so the fixture would not be a pre-change shape");
  assert.equal(/indexSequence/i.test(legacy), false, "the derived legacy DDL still declares the ordering column");
  return legacy;
}

// The engines word it differently — SQLite and libSQL say `no such column: indexSequence`, Postgres
// says `column "indexsequence" does not exist` — so the shared assertion is that the failure names
// the column, rather than that any failure happened at all.
async function rejectionMessage(adapter, sql) {
  try {
    await adapter.prepare(sql).all();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

function legacyEvent(row) {
  return {
    timestamp: row.timestamp,
    category: "app",
    event: "ctx.log",
    level: "info",
    message: row.message,
    capsule: { name: "log-index-upgrade", id: "capsule-upgrade" },
    release: { id: "release-1" },
    request: { id: "request-1" },
    correlation: { id: "correlation-1" },
  };
}

function liveEvent(message) {
  return legacyEvent({ timestamp: new Date().toISOString(), message });
}

// Seeded through the old column set, which is the point: `insertLogIndexEvent` writes the ordering
// column, so using it would defeat the fixture. Every name here is lower case in the DDL, so the
// statement means the same thing whether or not the identifiers around it are quoted.
async function seedLegacyRows(adapter) {
  for (const row of LEGACY_ROWS) {
    await adapter
      .prepare(
        `INSERT INTO ${LOG_INDEX_TABLE} (id, timestamp, category, event, level, message, payload) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.timestamp, "app", "ctx.log", "info", row.message, JSON.stringify(legacyEvent(row)));
  }
}

async function readIndexedRows(adapter) {
  return await adapter
    .prepare(`SELECT id, message, indexSequence FROM ${LOG_INDEX_TABLE} ORDER BY indexSequence ASC`)
    .all();
}

for (const engine of ENGINES) {
  test(`a Log index built before the ordering column picks it up on boot: ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (adapter) => {
      try {
        await adapter.exec(legacyLogIndexDdl());
        await seedLegacyRows(adapter);

        // The fixture is only worth anything if it really lacks the column. Asserted rather than
        // assumed, because a fixture that quietly included it would make everything below pass
        // while testing nothing.
        assert.match(
          String(await rejectionMessage(adapter, `SELECT indexSequence FROM ${LOG_INDEX_TABLE}`)),
          /indexsequence/i,
          `${engine.name} answered the ordering column before the upgrade, so the fixture is not a pre-change shape`,
        );

        // The real bootstrap, not a re-implementation of it: `CREATE TABLE IF NOT EXISTS` is a
        // no-op against the existing table, so the column can only arrive through the additive
        // migration, and the backfill only has rows to find because they were written without it.
        await adapter.ensureLogStorage();

        const upgraded = await readIndexedRows(adapter);
        assert.deepEqual(upgraded.map((row) => row.message), BACKFILLED_ORDER);
        assert.deepEqual(upgraded.map((row) => row.indexSequence), BACKFILLED_SEQUENCES);

        for (const row of upgraded) {
          assert.equal(typeof row.indexSequence, "string", `${engine.name} handed the backfilled column back as ${typeof row.indexSequence}`);
          assert.match(row.indexSequence, /^[0-9]{20}$/, "a backfilled value is not the fixed width the lexicographic order depends on");
        }

        // Rows written after the upgrade sort after every backfilled one. This is the property the
        // backfill exists for: a bound applied later has to keep the newest events rather than
        // whichever ones the migration happened to touch.
        const newestLegacy = Math.max(...LEGACY_ROWS.map((row) => Date.parse(row.timestamp)));
        assert.equal(newestLegacy < Date.now(), true, "the legacy fixture is not in the past, so it cannot test ordering against a live row");
        await adapter.insertLogIndexEvent(liveEvent("after-upgrade"));

        const withLive = await readIndexedRows(adapter);
        assert.deepEqual(withLive.map((row) => row.message), [...BACKFILLED_ORDER, "after-upgrade"]);
        const live = withLive.at(-1).indexSequence;
        assert.match(live, /^[0-9]{20}$/);
        assert.equal(live > BACKFILLED_SEQUENCES.at(-1), true, "a row indexed after the upgrade did not sort after the backfilled rows");

        // A second boot is a no-op. The migration has to tolerate the column already existing, and
        // on Postgres that is why it asks for `ADD COLUMN IF NOT EXISTS` rather than swallowing the
        // duplicate-column error: a swallowed error would abort the enclosing transaction and every
        // statement after it would fail. The backfill selection is empty by now, so no value moves.
        await adapter.ensureLogStorage();

        assert.deepEqual(await readIndexedRows(adapter), withLive);
      } finally {
        // Postgres storage outlives the process and the harness only drops on entry, so a table
        // this test left behind in any shape would be the next suite's starting point.
        await adapter.exec(`DROP TABLE IF EXISTS ${LOG_INDEX_TABLE}`);
      }
    }, { appTableNames: [] });
  });
}
