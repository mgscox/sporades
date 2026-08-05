import assert from "node:assert/strict";

import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";

// The app table and runtime metadata surface of the Database adapter conformance specification
// (ADR-0035), executed once per engine through the shared runner.
//
// App tables are what Capsule code reaches through `ctx.db`, so a divergence here is the one a
// Capsule author sees first. The runtime metadata surfaces alongside them — system metadata, the
// schema metadata a migration writes, the Log index, and the inspection surface — are runtime
// owned rather than Capsule owned, but code above the adapter depends on all of them answering
// the same thing on every engine.
//
// Every assertion here compares an observed value against an expected value, and every predicate
// is exercised on both sides: an update is run against a matching and a non-matching owner, a
// filter against a value that matches and one that does not, the inspection table filter against
// a table it keeps and one it hides. That is the discipline ADR-0034 and ADR-0035 impose, because
// the defects this suite exists to catch returned plausible wrong values rather than throwing.
//
// Two shapes in this surface are the ones ADR-0034 singles out.
//
// The shared `readRecentLogEvents`, `listInspectableTables`, `dumpInspectableDatabase` and
// `runReadOnlyInspectionQuery` all derived from an unresolved statement result. They were correct
// on libSQL only because libSQL overrode each of them with a byte-identical await-shim, so a case
// written against libSQL would have exercised the shim and never the broken shared body. Those
// shims are gone: the shared definitions are promise-aware, and libSQL now runs them, so these
// cases reach the definition rather than the shadow.
//
// The shared `insertLogIndexEvent` and `pruneLogIndex` were write-only and returned nothing, so a
// caller had nothing to await and no way to know the write had landed — harmless on SQLite where
// it already had, wrong on the asynchronous engines where it had not. ADR-0034's fourth rule limb
// requires a writing method to return its statement result, so the Log index cases below assert
// the reported change count and then assert that the write is observable once that result has
// been awaited.
//
// Reference integrity is deliberately not re-asserted here. The seeded surface in
// `database-adapter-conformance.test.js` already exercises `referenceExists` against a target row
// that resolves and one that dangles, and duplicating it would put the same behaviour in two
// places, which is exactly what ADR-0035's single specification is meant to prevent.

const ACCOUNTS_TABLE = {
  name: "conformance_accounts",
  fields: [{ name: "label", kind: "String", sqliteType: "TEXT" }],
};

const ENTRIES_TABLE = {
  name: "conformance_entries",
  fields: [
    { name: "note", kind: "String", sqliteType: "TEXT" },
    { name: "ownerId", kind: "String", sqliteType: "TEXT" },
    { name: "accountId", kind: "Reference", sqliteType: "TEXT", targetTable: "conformance_accounts" },
  ],
};

// The two shapes the additive migration case introduces: a brand new table, and an existing table
// gaining a field that carries a default.
const ARCHIVE_TABLE = {
  name: "conformance_archive",
  fields: [{ name: "note", kind: "String", sqliteType: "TEXT" }],
};

const MIGRATED_ENTRIES_TABLE = {
  ...ENTRIES_TABLE,
  fields: [...ENTRIES_TABLE.fields, { name: "status", kind: "String", sqliteType: "TEXT", defaultValue: "open" }],
};

const BASE_SCHEMA = { tables: [ACCOUNTS_TABLE, ENTRIES_TABLE] };
const MIGRATED_SCHEMA = { tables: [ACCOUNTS_TABLE, MIGRATED_ENTRIES_TABLE, ARCHIVE_TABLE] };

const NOW = "2026-07-04T10:00:00.000Z";
const LATER = "2026-07-04T10:05:00.000Z";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

const RESIDENT_ACCOUNT = { id: "account-open", createdAt: NOW, updatedAt: NOW, label: "Open account" };

function entryRow(overrides) {
  return { createdAt: NOW, updatedAt: NOW, note: "a note", ownerId: OWNER_A, accountId: RESIDENT_ACCOUNT.id, ...overrides };
}

function logEvent(index) {
  return {
    timestamp: `2026-07-04T10:0${index}:00.000Z`,
    category: "app",
    event: "ctx.log",
    level: "info",
    message: `conformance-log-${index}`,
    capsule: { name: "conformance-app-tables", id: "capsule-conformance" },
    release: { id: `release-${index}` },
    request: { id: `request-${index}` },
    correlation: { id: `correlation-${index}` },
  };
}

// Rows come back from three engines with three row representations, so every comparison is made
// against a fresh object literal built from the columns the case is actually asserting.
function pick(row, keys) {
  return Object.fromEntries(keys.map((key) => [key, row?.[key]]));
}

async function prepareAppTableStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureLogStorage();
  await adapter.migrateAppSchema(BASE_SCHEMA);

  // The one resident app row in this surface. Every case that adds rows removes them again, so
  // the inspection cases can assert an exact table dump.
  await adapter.insertAppRow(ACCOUNTS_TABLE, RESIDENT_ACCOUNT);
}

const APP_TABLE_CONFORMANCE_CASES = [
  {
    name: "insertAppRow, selectAppRowById and deleteAppRow round trip an app row and report their writes",
    async run(adapter) {
      assert.equal(await adapter.selectAppRowById(ENTRIES_TABLE, "entry-crud"), null);

      const inserted = await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-crud", note: "first note" }));
      assert.equal(inserted.changes, 1);

      const stored = await adapter.selectAppRowById(ENTRIES_TABLE, "entry-crud");
      assert.deepEqual(pick(stored, ["id", "createdAt", "updatedAt", "note", "ownerId", "accountId"]), {
        id: "entry-crud",
        createdAt: NOW,
        updatedAt: NOW,
        note: "first note",
        ownerId: OWNER_A,
        accountId: RESIDENT_ACCOUNT.id,
      });

      assert.equal(await adapter.selectAppRowById(ENTRIES_TABLE, "entry-absent"), null);

      const deleted = await adapter.deleteAppRow(ENTRIES_TABLE, "entry-crud");
      assert.equal(deleted.changes, 1);
      assert.equal(await adapter.selectAppRowById(ENTRIES_TABLE, "entry-crud"), null);

      // Deleting a row that is not stored is not an error and must report no change, so a caller
      // can tell the two outcomes apart.
      assert.equal((await adapter.deleteAppRow(ENTRIES_TABLE, "entry-crud")).changes, 0);
    },
  },
  {
    name: "updateAppRow applies an unscoped update and refuses one scoped to a different owner",
    async run(adapter) {
      await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-owned", note: "owned by A" }));

      const unscoped = await adapter.updateAppRow(ENTRIES_TABLE, "entry-owned", { note: "updated unscoped", updatedAt: LATER });
      assert.equal(unscoped.changes, 1);
      assert.deepEqual(pick(await adapter.selectAppRowById(ENTRIES_TABLE, "entry-owned"), ["note", "updatedAt"]), {
        note: "updated unscoped",
        updatedAt: LATER,
      });

      const matchingOwner = await adapter.updateAppRow(ENTRIES_TABLE, "entry-owned", { note: "updated by the owner" }, { ownerId: OWNER_A });
      assert.equal(matchingOwner.changes, 1);
      assert.equal((await adapter.selectAppRowById(ENTRIES_TABLE, "entry-owned")).note, "updated by the owner");

      // The other side of the owner scope: a scoped update whose owner does not match must change
      // nothing and must say so.
      const otherOwner = await adapter.updateAppRow(ENTRIES_TABLE, "entry-owned", { note: "updated by someone else" }, { ownerId: OWNER_B });
      assert.equal(otherOwner.changes, 0);
      assert.equal((await adapter.selectAppRowById(ENTRIES_TABLE, "entry-owned")).note, "updated by the owner");

      assert.equal((await adapter.updateAppRow(ENTRIES_TABLE, "entry-owned", {})).changes, 0);
      assert.equal((await adapter.updateAppRow(ENTRIES_TABLE, "entry-absent", { note: "nothing to update" })).changes, 0);

      await adapter.deleteAppRow(ENTRIES_TABLE, "entry-owned");
    },
  },
  {
    name: "selectAppRows projects columns, filters by field and owner, and orders and limits rows",
    async run(adapter) {
      await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-a1", note: "shared note", ownerId: OWNER_A }));
      await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-a2", note: "private note", ownerId: OWNER_A }));
      await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-b1", note: "shared note", ownerId: OWNER_B }));

      const ascending = await adapter.selectAppRows(ENTRIES_TABLE, { orderBy: { fieldName: "id", direction: "asc" } });
      assert.deepEqual(ascending.map((row) => row.id), ["entry-a1", "entry-a2", "entry-b1"]);

      // Column projection returns exactly the requested columns, and nothing else.
      const projected = await adapter.selectAppRows(ENTRIES_TABLE, {
        columns: ["id", "note"],
        orderBy: { fieldName: "id", direction: "asc" },
      });
      assert.deepEqual(projected.map((row) => Object.keys(row).sort()), [
        ["id", "note"],
        ["id", "note"],
        ["id", "note"],
      ]);
      assert.deepEqual(projected.map((row) => pick(row, ["id", "note"])), [
        { id: "entry-a1", note: "shared note" },
        { id: "entry-a2", note: "private note" },
        { id: "entry-b1", note: "shared note" },
      ]);

      // Filtering by field, on a value that matches rows and one that matches none.
      const matchingField = await adapter.selectAppRows(ENTRIES_TABLE, {
        where: { fieldName: "note", value: "shared note" },
        orderBy: { fieldName: "id", direction: "asc" },
      });
      assert.deepEqual(matchingField.map((row) => row.id), ["entry-a1", "entry-b1"]);
      assert.deepEqual(await adapter.selectAppRows(ENTRIES_TABLE, { where: { fieldName: "note", value: "no such note" } }), []);

      // Owner scope, alone and combined with a field filter.
      const ownedByA = await adapter.selectAppRows(ENTRIES_TABLE, { ownerId: OWNER_A, orderBy: { fieldName: "id", direction: "asc" } });
      assert.deepEqual(ownedByA.map((row) => row.id), ["entry-a1", "entry-a2"]);
      const ownedAndFiltered = await adapter.selectAppRows(ENTRIES_TABLE, {
        ownerId: OWNER_A,
        where: { fieldName: "note", value: "shared note" },
      });
      assert.deepEqual(ownedAndFiltered.map((row) => row.id), ["entry-a1"]);
      assert.deepEqual(await adapter.selectAppRows(ENTRIES_TABLE, { ownerId: "owner-nobody" }), []);

      const descending = await adapter.selectAppRows(ENTRIES_TABLE, { orderBy: { fieldName: "id", direction: "desc" } });
      assert.deepEqual(descending.map((row) => row.id), ["entry-b1", "entry-a2", "entry-a1"]);

      const limited = await adapter.selectAppRows(ENTRIES_TABLE, { orderBy: { fieldName: "id", direction: "asc" }, limit: 2 });
      assert.deepEqual(limited.map((row) => row.id), ["entry-a1", "entry-a2"]);
      assert.deepEqual(await adapter.selectAppRows(ENTRIES_TABLE, { limit: 0 }), []);

      for (const id of ["entry-a1", "entry-a2", "entry-b1"]) {
        await adapter.deleteAppRow(ENTRIES_TABLE, id);
      }
      assert.deepEqual(await adapter.selectAppRows(ENTRIES_TABLE), []);
    },
  },
  {
    name: "system metadata round trips, overwrites in place, and answers null for a key that was never written",
    async run(adapter) {
      assert.equal(await adapter.readSystemMetadata("conformance-metadata"), null);

      const written = await adapter.writeSystemMetadata("conformance-metadata", "first value");
      assert.equal(written.changes, 1);
      assert.equal((await adapter.readSystemMetadata("conformance-metadata")).value, "first value");

      // The write is an upsert, so a second write against the same key replaces rather than adds.
      await adapter.writeSystemMetadata("conformance-metadata", "second value");
      assert.equal((await adapter.readSystemMetadata("conformance-metadata")).value, "second value");

      assert.equal(await adapter.readSystemMetadata("conformance-metadata-absent"), null);
    },
  },
  {
    name: "schema metadata records the migrated schema that migrateAppSchema wrote",
    async run(adapter) {
      assert.equal((await adapter.readSystemMetadata("schemaVersion")).value, "v1:additive-fields");

      const schemaRow = await adapter.readSchemaMetadata();
      const storedSchema = JSON.parse(schemaRow.value);
      assert.deepEqual(storedSchema.tables.map((table) => table.name), [ACCOUNTS_TABLE.name, ENTRIES_TABLE.name]);
      assert.deepEqual(
        storedSchema.tables.find((table) => table.name === ENTRIES_TABLE.name).fields.map((field) => field.name),
        ["note", "ownerId", "accountId"],
      );

      // The recorded hash is what a later migrateAppSchema compares against to decide whether the
      // schema changed, so it has to be the stored digest of the stored schema JSON.
      const schemaHashRow = await adapter.readSystemMetadata("schemaHash");
      assert.equal(typeof schemaHashRow.value, "string");
      assert.equal(schemaHashRow.value.length, 64);
    },
  },
  {
    name: "insertLogIndexEvent reports its write, which is observable once the result has been awaited",
    async run(adapter) {
      assert.deepEqual(await adapter.readRecentLogEvents(10), []);

      // ADR-0034's fourth rule limb: a writing method returns its statement result, so the caller
      // has something to await and can tell that the write landed. Asserting the reported change
      // count is what distinguishes a method that returns its result from one that discards it,
      // on every engine, without asserting whether the return was a Promise.
      const inserted = await adapter.insertLogIndexEvent(logEvent(1));
      assert.equal(inserted.changes, 1);
      assert.deepEqual((await adapter.readRecentLogEvents(10)).map((event) => event.message), ["conformance-log-1"]);

      await adapter.insertLogIndexEvent(logEvent(2));
      await adapter.insertLogIndexEvent(logEvent(3));

      // Recent events read back oldest first, and the whole payload round trips, not just a column.
      assert.deepEqual((await adapter.readRecentLogEvents(10)).map((event) => event.message), [
        "conformance-log-1",
        "conformance-log-2",
        "conformance-log-3",
      ]);
      assert.deepEqual(await adapter.readRecentLogEvents(1), [logEvent(3)]);
      assert.deepEqual((await adapter.readRecentLogEvents(2)).map((event) => event.message), [
        "conformance-log-2",
        "conformance-log-3",
      ]);
    },
  },
  {
    name: "pruneLogIndex reports its write and bounds the Log index to the most recent events",
    async run(adapter) {
      assert.equal((await adapter.readRecentLogEvents(50)).length, 3);
      await adapter.insertLogIndexEvent(logEvent(4));
      await adapter.insertLogIndexEvent(logEvent(5));
      assert.equal((await adapter.readRecentLogEvents(50)).length, 5);

      const pruned = await adapter.pruneLogIndex(2);
      assert.equal(pruned.changes, 3);
      assert.deepEqual((await adapter.readRecentLogEvents(50)).map((event) => event.message), [
        "conformance-log-4",
        "conformance-log-5",
      ]);

      // Pruning to a bound the index already satisfies removes nothing and reports nothing.
      const prunedAgain = await adapter.pruneLogIndex(2);
      assert.equal(prunedAgain.changes, 0);
      assert.deepEqual((await adapter.readRecentLogEvents(50)).map((event) => event.message), [
        "conformance-log-4",
        "conformance-log-5",
      ]);

      assert.equal((await adapter.pruneLogIndex(0)).changes, 2);
      assert.deepEqual(await adapter.readRecentLogEvents(50), []);
    },
  },
  {
    name: "listInspectableTables lists the app and system tables and hides the internal Log index table",
    async run(adapter) {
      const tables = await adapter.listInspectableTables();

      assert.equal(tables.includes(ACCOUNTS_TABLE.name), true);
      assert.equal(tables.includes(ENTRIES_TABLE.name), true);
      assert.equal(tables.includes("sporades"), true);

      // Both sides of the filter: the Log index table exists — the cases above wrote to it — and
      // must still be absent from the inspectable list.
      assert.equal(tables.includes("sporades_log_events"), false);

      // The table added by the later migration case is not there yet, which is the negative side
      // of the assertion that case makes once it has run.
      assert.equal(tables.includes(ARCHIVE_TABLE.name), false);

      assert.deepEqual(tables, [...tables].sort());
    },
  },
  {
    name: "dumpInspectableDatabase dumps each inspectable table's columns and rows",
    async run(adapter) {
      const dump = await adapter.dumpInspectableDatabase();

      assert.deepEqual(dump.map((table) => table.name), await adapter.listInspectableTables());
      assert.equal(dump.some((table) => table.name === "sporades_log_events"), false);

      const accounts = dump.find((table) => table.name === ACCOUNTS_TABLE.name);
      assert.deepEqual(accounts.columns, ["id", "createdAt", "updatedAt", "label"]);
      assert.deepEqual(accounts.rows.map((row) => pick(row, ["id", "createdAt", "updatedAt", "label"])), [RESIDENT_ACCOUNT]);

      // The other side: a table that is inspectable and empty dumps its columns and no rows.
      const entries = dump.find((table) => table.name === ENTRIES_TABLE.name);
      assert.deepEqual(entries.columns, ["id", "createdAt", "updatedAt", "note", "ownerId", "accountId"]);
      assert.deepEqual(entries.rows, []);
    },
  },
  {
    name: "runReadOnlyInspectionQuery returns rows for a read-only query and refuses everything else",
    async run(adapter) {
      const selected = await adapter.runReadOnlyInspectionQuery("SELECT id, label FROM conformance_accounts ORDER BY id");
      assert.equal(selected.ok, true);
      assert.equal(selected.error, null);
      assert.deepEqual(selected.data.columns, ["id", "label"]);
      assert.deepEqual(selected.data.rows.map((row) => pick(row, ["id", "label"])), [
        { id: RESIDENT_ACCOUNT.id, label: RESIDENT_ACCOUNT.label },
      ]);

      // A read-only query that matches nothing is a success with no rows, not a failure.
      const empty = await adapter.runReadOnlyInspectionQuery("SELECT id, label FROM conformance_accounts WHERE id = 'account-absent'");
      assert.equal(empty.ok, true);
      assert.deepEqual(empty.data.rows, []);
      assert.deepEqual(empty.data.columns, ["id", "label"]);

      const write = await adapter.runReadOnlyInspectionQuery("DELETE FROM conformance_accounts");
      assert.deepEqual(pick(write, ["ok", "data"]), { ok: false, data: null });
      assert.equal(write.error.message, "Only read-only SQL is allowed.");

      const logIndex = await adapter.runReadOnlyInspectionQuery("SELECT * FROM sporades_log_events");
      assert.deepEqual(pick(logIndex, ["ok", "data"]), { ok: false, data: null });
      assert.equal(logIndex.error.message, "Internal log index tables are not available through generic DB inspection.");

      // A query the engine rejects is reported as a failed result rather than thrown. The engine
      // writes the message, so the engine-agnostic part is the shape and the hint.
      const broken = await adapter.runReadOnlyInspectionQuery("SELECT id FROM conformance_no_such_table");
      assert.deepEqual(pick(broken, ["ok", "data"]), { ok: false, data: null });
      assert.equal(broken.error.hint, "Check the SQL syntax and table names, then retry the query.");
      assert.equal(typeof broken.error.message, "string");
      assert.equal(broken.error.message.length > 0, true);

      // The rows the accounts table holds are unchanged, so the refused write really was refused.
      assert.deepEqual((await adapter.selectAppRows(ACCOUNTS_TABLE)).map((row) => row.id), [RESIDENT_ACCOUNT.id]);
    },
  },
  {
    name: "migrateAppSchema additively adds a table and a field with a default, keeping stored rows",
    async run(adapter) {
      await adapter.insertAppRow(ENTRIES_TABLE, entryRow({ id: "entry-kept", note: "written before the migration" }));
      const before = await adapter.selectAppRowById(ENTRIES_TABLE, "entry-kept");
      assert.equal(before.status, undefined);

      await adapter.migrateAppSchema(MIGRATED_SCHEMA);

      // The row written before the migration survives it and takes the new field's default.
      const after = await adapter.selectAppRowById(MIGRATED_ENTRIES_TABLE, "entry-kept");
      assert.deepEqual(pick(after, ["id", "createdAt", "note", "ownerId", "accountId", "status"]), {
        id: "entry-kept",
        createdAt: NOW,
        note: "written before the migration",
        ownerId: OWNER_A,
        accountId: RESIDENT_ACCOUNT.id,
        status: "open",
      });

      // A row inserted after the migration without the new field also takes its default.
      await adapter.insertAppRow(MIGRATED_ENTRIES_TABLE, entryRow({ id: "entry-defaulted", note: "written after the migration" }));
      assert.equal((await adapter.selectAppRowById(MIGRATED_ENTRIES_TABLE, "entry-defaulted")).status, "open");

      // And a row that supplies the field keeps its own value rather than the default.
      await adapter.insertAppRow(MIGRATED_ENTRIES_TABLE, entryRow({ id: "entry-explicit", note: "explicit status", status: "closed" }));
      assert.equal((await adapter.selectAppRowById(MIGRATED_ENTRIES_TABLE, "entry-explicit")).status, "closed");

      // The added table exists, is inspectable, and stores rows.
      assert.equal((await adapter.listInspectableTables()).includes(ARCHIVE_TABLE.name), true);
      assert.equal((await adapter.insertAppRow(ARCHIVE_TABLE, { id: "archive-1", createdAt: NOW, updatedAt: NOW, note: "archived" })).changes, 1);
      assert.deepEqual(pick(await adapter.selectAppRowById(ARCHIVE_TABLE, "archive-1"), ["id", "note"]), {
        id: "archive-1",
        note: "archived",
      });

      // The migration rewrote the schema metadata, so a reader sees the migrated schema.
      const storedSchema = JSON.parse((await adapter.readSchemaMetadata()).value);
      assert.deepEqual(storedSchema.tables.map((table) => table.name), [
        ACCOUNTS_TABLE.name,
        ARCHIVE_TABLE.name,
        ENTRIES_TABLE.name,
      ]);
      assert.deepEqual(
        storedSchema.tables.find((table) => table.name === ENTRIES_TABLE.name).fields.map((field) => field.name),
        ["note", "ownerId", "accountId", "status"],
      );
    },
  },
];

runDatabaseAdapterConformance({
  title: "Database adapter conformance (app tables and runtime metadata)",
  // Every app table this surface migrates, including the one the additive migration adds and the
  // temporary table that migration builds. A table left undeclared survives the Postgres schema
  // reset and is then silently adopted, with its old rows, by `CREATE TABLE IF NOT EXISTS`.
  appTableNames: [ACCOUNTS_TABLE.name, ENTRIES_TABLE.name, ARCHIVE_TABLE.name, `__sporades_migrating_${ENTRIES_TABLE.name}`],
  prepareStorage: prepareAppTableStorage,
  cases: APP_TABLE_CONFORMANCE_CASES,
});
