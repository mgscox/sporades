import assert from "node:assert/strict";

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
// The Log index also carries the one behaviour this surface asserts because the engines were
// known to disagree about it rather than suspected of it. ADR-0036 replaced a per-engine tie-break
// with a runtime-assigned ordering sequence, and the two ordering cases below are what stop the
// tie-break coming back: each is written so that it fails under the ordering it replaced, on every
// engine, rather than only on the engine whose answer was visibly wrong.
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

// Built by `createAppTable` from inside a case rather than by the schema migration, so that the
// single-table creation path is exercised in its own right and not only as a step the migration
// reaches internally. It is created after the inspection cases have run, so their view of the
// inspectable tables is unaffected.
const STANDALONE_TABLE = {
  name: "conformance_standalone",
  fields: [{ name: "label", kind: "String", sqliteType: "TEXT" }],
};

const STANDALONE_ALIAS_TABLE_NAME = "conformance_standalone_alias";

const UNIQUE_TABLE = {
  name: "conformance_unique_table",
  fields: [
    { name: "identity", kind: "String", sqliteType: "TEXT" },
    { name: "email", kind: "String", sqliteType: "TEXT" },
    { name: "select", kind: "String", sqliteType: "TEXT" },
  ],
  uniqueConstraints: [["identity"], ["select", "email"]],
};

// A Capsule table whose fields are named exactly the way the deleted Postgres column-name table
// used to rename them. Created from inside a case rather than declared in the base schema, so the
// inspection cases' exact table dump is unaffected.
//
// The camelCase spellings these used to be renamed to are deliberately not declared alongside them.
// SQLite and libSQL compare identifiers case-insensitively even when they are quoted, so a table
// carrying both `errorcode` and `errorCode` is a duplicate-column error there — an engine
// difference in what a schema may declare, which is not what this case is about. The exact key set
// is asserted instead, and a read that renamed `errorcode` to `errorCode` fails it just as
// squarely.
const COLLIDING_NAMES_TABLE = {
  name: "conformance_collisions",
  fields: [
    { name: "errorcode", kind: "String", sqliteType: "TEXT" },
    { name: "jobid", kind: "String", sqliteType: "TEXT" },
  ],
};

const MIGRATED_STANDALONE_TABLE = {
  ...STANDALONE_TABLE,
  fields: [...STANDALONE_TABLE.fields, { name: "state", kind: "String", sqliteType: "TEXT", defaultValue: "unset" }],
};

const MIGRATED_ENTRIES_TABLE = {
  ...ENTRIES_TABLE,
  fields: [...ENTRIES_TABLE.fields, { name: "status", kind: "String", sqliteType: "TEXT", defaultValue: "open" }],
};

const UNIQUE_MUTABILITY_TABLE = {
  name: "conformance_unique_mutability",
  fields: [
    { name: "first", kind: "String", sqliteType: "TEXT" },
    { name: "second", kind: "String", sqliteType: "TEXT" },
    { name: "third", kind: "String", sqliteType: "TEXT" },
  ],
  uniqueConstraints: [["first", "second"]],
};

const UNIQUE_MIGRATION_TABLE = {
  name: "conformance_unique_migration",
  fields: [
    { name: "teamId", kind: "String", sqliteType: "TEXT" },
    { name: "slug", kind: "String", sqliteType: "TEXT" },
    { name: "externalId", kind: "String", sqliteType: "TEXT" },
  ],
  uniqueConstraints: [["teamId", "slug"]],
};

const UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID = {
  ...UNIQUE_MIGRATION_TABLE,
  uniqueConstraints: [["teamId", "slug"], ["externalId"]],
};

const UNIQUE_DUPLICATE_MIGRATION_TABLE = {
  ...UNIQUE_MIGRATION_TABLE,
  name: "conformance_unique_duplicate_migration",
};

const UNIQUE_DUPLICATE_MIGRATION_TABLE_WITH_EXTERNAL_ID = {
  ...UNIQUE_DUPLICATE_MIGRATION_TABLE,
  uniqueConstraints: [["teamId", "slug"], ["externalId"]],
};

const BASE_SCHEMA = { tables: [ACCOUNTS_TABLE, ENTRIES_TABLE] };
const MIGRATED_SCHEMA = { tables: [ACCOUNTS_TABLE, MIGRATED_ENTRIES_TABLE, ARCHIVE_TABLE] };
const MIGRATED_SCHEMA_WITH_UNIQUE_MIGRATION_TABLE = { tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE] };
const MIGRATED_SCHEMA_WITH_UNIQUE_MIGRATION_EXTERNAL_ID = { tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID] };
const MIGRATED_SCHEMA_WITH_UNIQUE_MUTABILITY_AND_MIGRATION = {
  tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, UNIQUE_MUTABILITY_TABLE],
};
const MIGRATED_SCHEMA_WITH_UNIQUE_DUPLICATE_MIGRATION = {
  tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, UNIQUE_MUTABILITY_TABLE, UNIQUE_DUPLICATE_MIGRATION_TABLE],
};
const MIGRATED_SCHEMA_WITH_UNIQUE_DUPLICATE_EXTERNAL_ID = {
  tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, UNIQUE_MUTABILITY_TABLE, UNIQUE_DUPLICATE_MIGRATION_TABLE_WITH_EXTERNAL_ID],
};

// The two tables of the migration that must fail partway. A migration walks the schema's tables in
// order, so putting a table that migrates cleanly ahead of one that cannot is what makes the
// failure land after real DDL and real row copying rather than before any of it: the accounts table
// is dropped, rebuilt with its new column and repopulated, and only then does the entries table's
// dangling Reference default abort the whole thing.
const REBUILT_ACCOUNTS_FIELD = { name: "region", kind: "String", sqliteType: "TEXT", defaultValue: "unset" };

const REBUILT_ACCOUNTS_TABLE = {
  ...ACCOUNTS_TABLE,
  fields: [...ACCOUNTS_TABLE.fields, REBUILT_ACCOUNTS_FIELD],
};

const DANGLING_REFERENCE_FIELD = {
  name: "reviewerId",
  kind: "Reference",
  sqliteType: "TEXT",
  targetTable: ACCOUNTS_TABLE.name,
  defaultValue: "account-that-does-not-exist",
};

const FAILING_ENTRIES_TABLE = {
  ...MIGRATED_ENTRIES_TABLE,
  fields: [...MIGRATED_ENTRIES_TABLE.fields, DANGLING_REFERENCE_FIELD],
};

const FAILING_SCHEMA = { tables: [REBUILT_ACCOUNTS_TABLE, FAILING_ENTRIES_TABLE, ARCHIVE_TABLE] };

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

// A Log index envelope whose message and envelope timestamp are chosen by the case rather than
// derived from an index, because the ordering cases need the envelope timestamp to disagree with
// the order the events are indexed in.
function orderedLogEvent(message, timestamp) {
  return {
    timestamp,
    category: "app",
    event: "ctx.log",
    level: "info",
    message,
    capsule: { name: "conformance-app-tables", id: "capsule-conformance" },
    release: { id: "release-order" },
    request: { id: "request-order" },
    correlation: { id: "correlation-order" },
  };
}

// Writes a row straight into the Log index table, bypassing `insertLogIndexEvent` so the row
// carries no ordering sequence. This is the shape every row stored before the ordering field
// existed has, and the only way to reach the backfill from a conformance case.
async function insertLogRowWithoutSequence(adapter, id, message, timestamp) {
  await adapter
    .prepare(
      adapter.dialect.sql(
        "INSERT INTO [sporades_log_events] ([id], [timestamp], [category], [event], [level], [message], [payload]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
    )
    .run(id, timestamp, "app", "ctx.log", "info", message, JSON.stringify(orderedLogEvent(message, timestamp)));
}

async function indexedLogMessages(adapter, limit = 50) {
  return (await adapter.readRecentLogEvents(limit)).map((event) => event.message);
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
    // The blind spot ADR-0036 closes. `readRecentLogEvents` and `pruneLogIndex` used to order by
    // `timestamp` with a per-engine tie-break — `rowid` on SQLite and libSQL, the `randomUUID()`
    // `id` on Postgres — so two Capsules on different engines returned different orders and
    // pruning kept different subsets. Both tie-breaks are gone and every engine now orders by the
    // runtime-assigned sequence, which is the order the events were indexed in.
    //
    // Each limb of this case is what makes it discriminate, on every engine, against the two
    // orderings it replaces:
    //
    // - Three events sharing one envelope timestamp must come back in the order they were indexed.
    //   Under the old Postgres tie-break their order was the UUID order, which is effectively
    //   random, so this limb is what fails there.
    // - An event whose envelope timestamp is older than the ones already indexed must still come
    //   back after them, and one whose timestamp is newer must not jump ahead of anything. Under
    //   either old ordering `timestamp DESC` dominated, so this limb is what fails on SQLite and
    //   libSQL, where the `rowid` tie-break did give indexing order among the tied three.
    name: "readRecentLogEvents and pruneLogIndex order by the runtime-assigned sequence on every engine",
    async run(adapter) {
      assert.deepEqual(await adapter.readRecentLogEvents(50), []);

      const TIED = "2026-07-04T11:00:00.000Z";
      await adapter.insertLogIndexEvent(orderedLogEvent("order-tied-1", TIED));
      await adapter.insertLogIndexEvent(orderedLogEvent("order-tied-2", TIED));
      await adapter.insertLogIndexEvent(orderedLogEvent("order-tied-3", TIED));

      // Indexed fourth, but stamped half an hour before the three above.
      await adapter.insertLogIndexEvent(orderedLogEvent("order-backdated", "2026-07-04T10:30:00.000Z"));
      // Indexed last, and stamped after everything, so the two orderings agree about this one.
      await adapter.insertLogIndexEvent(orderedLogEvent("order-postdated", "2026-07-04T11:30:00.000Z"));

      assert.deepEqual(await indexedLogMessages(adapter), [
        "order-tied-1",
        "order-tied-2",
        "order-tied-3",
        "order-backdated",
        "order-postdated",
      ]);

      // A bounded read takes the most recently indexed events, which is the window
      // `privilegedAuditEventAlreadyIndexed` decides its dedup from.
      assert.deepEqual(await indexedLogMessages(adapter, 2), ["order-backdated", "order-postdated"]);

      // Pruning keeps the same subset that a bounded read returns, rather than a different one.
      assert.equal((await adapter.pruneLogIndex(3)).changes, 2);
      assert.deepEqual(await indexedLogMessages(adapter), ["order-tied-3", "order-backdated", "order-postdated"]);

      assert.equal((await adapter.pruneLogIndex(0)).changes, 3);
      assert.deepEqual(await adapter.readRecentLogEvents(50), []);
    },
  },
  {
    // The additive migration's backfill. Rows stored before the ordering field existed carry no
    // sequence, and `ensureLogStorage` derives one for them from the timestamp they did store, so
    // their relative order survives and they sort against newly indexed rows rather than beside
    // them. Ties among already-stored rows are historical and unrecoverable, so the two legacy
    // rows here are given distinct timestamps and written in the opposite order — which is what
    // makes the case fail if the backfill is skipped and the order falls back to `rowid`.
    name: "ensureLogStorage backfills rows stored before the ordering field into the same order",
    async run(adapter) {
      // Indexed first and therefore holding the lowest `rowid`, but stamped before both legacy
      // rows, so neither `rowid` nor `timestamp` ordering puts it where the sequence does.
      await adapter.insertLogIndexEvent(orderedLogEvent("order-live", "2026-07-04T09:00:00.000Z"));

      await insertLogRowWithoutSequence(adapter, "legacy-newer", "order-legacy-newer", "2026-07-04T09:20:00.000Z");
      await insertLogRowWithoutSequence(adapter, "legacy-older", "order-legacy-older", "2026-07-04T09:10:00.000Z");

      await adapter.ensureLogStorage();

      assert.deepEqual(await indexedLogMessages(adapter), ["order-legacy-older", "order-legacy-newer", "order-live"]);

      // Running the bootstrap again is a no-op rather than a re-backfill that renumbers rows.
      await adapter.ensureLogStorage();
      assert.deepEqual(await indexedLogMessages(adapter), ["order-legacy-older", "order-legacy-newer", "order-live"]);

      // And the backfilled rows prune against the live one on the same scale, so a bound applied
      // after a migration keeps the newest events rather than the ones that happened to be there.
      assert.equal((await adapter.pruneLogIndex(1)).changes, 2);
      assert.deepEqual(await indexedLogMessages(adapter), ["order-live"]);

      assert.equal((await adapter.pruneLogIndex(0)).changes, 1);
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
    // `sporades db query <sql>` is typed by a human, and `validateReadOnlyInspectionSql`
    // deliberately admits one trailing statement terminator. So a semicolon is ordinary input, and
    // a trailing line comment is the shape someone leaves behind while editing a query.
    //
    // Neither is decoration to an engine that cannot ask a statement for its result shape
    // directly. Postgres describes a statement by embedding it in a subquery bounded to no rows: a
    // trailing `;` makes that a syntax error, and a trailing `--` comment swallows the closing
    // parenthesis and everything after it. Both answered on SQLite and libSQL and failed on
    // Postgres, which is the divergence class this whole specification exists to close, so the
    // terminator belongs on both sides of a conformance predicate rather than in none of its SQL.
    name: "runReadOnlyInspectionQuery answers the same for a query with and without a trailing terminator",
    async run(adapter) {
      const plain = await adapter.runReadOnlyInspectionQuery("SELECT id, label FROM conformance_accounts ORDER BY id");
      assert.equal(plain.ok, true);

      const terminated = await adapter.runReadOnlyInspectionQuery("SELECT id, label FROM conformance_accounts ORDER BY id;");
      assert.equal(terminated.ok, true, `a trailing semicolon must not change the answer: ${terminated.error?.message}`);
      assert.equal(terminated.error, null);
      assert.deepEqual(terminated.data.columns, ["id", "label"]);
      assert.deepEqual(terminated.data.rows.map((row) => pick(row, ["id", "label"])), plain.data.rows.map((row) => pick(row, ["id", "label"])));

      // Trailing whitespace after the terminator is the same input a shell leaves behind.
      const spaced = await adapter.runReadOnlyInspectionQuery("SELECT id, label FROM conformance_accounts ORDER BY id ; ");
      assert.equal(spaced.ok, true, `whitespace after a terminator must not change the answer: ${spaced.error?.message}`);
      assert.deepEqual(spaced.data.columns, ["id", "label"]);
    },
  },
  {
    name: "runReadOnlyInspectionQuery answers the same for a query with a trailing line comment",
    async run(adapter) {
      const commented = await adapter.runReadOnlyInspectionQuery(
        "SELECT id, label FROM conformance_accounts ORDER BY id -- the accounts this Capsule holds",
      );
      assert.equal(commented.ok, true, `a trailing line comment must not change the answer: ${commented.error?.message}`);
      assert.equal(commented.error, null);
      assert.deepEqual(commented.data.columns, ["id", "label"]);
      assert.deepEqual(commented.data.rows.map((row) => pick(row, ["id", "label"])), [
        { id: RESIDENT_ACCOUNT.id, label: RESIDENT_ACCOUNT.label },
      ]);

      // A terminator and a comment together, which is what an edited query actually looks like.
      const both = await adapter.runReadOnlyInspectionQuery(
        "SELECT id, label FROM conformance_accounts ORDER BY id; -- keep this around",
      );
      assert.equal(both.ok, true, `a terminator followed by a comment must not change the answer: ${both.error?.message}`);
      assert.deepEqual(both.data.columns, ["id", "label"]);

      // The negative side of the predicate: a `--` inside a string literal is text, not a comment,
      // so nothing may be stripped from it. An over-eager strip would truncate this query into
      // `SELECT ` and fail, or silently answer a different shape.
      const literal = await adapter.runReadOnlyInspectionQuery("SELECT '-- not a comment' AS marker");
      assert.equal(literal.ok, true, `a string literal containing a comment marker must survive: ${literal.error?.message}`);
      assert.deepEqual(literal.data.columns, ["marker"]);
      assert.deepEqual(literal.data.rows.map((row) => row.marker), ["-- not a comment"]);
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
  {
    // Migrations rewrite user data, so the answer that matters most from this method is the one it
    // gives when it cannot finish. ADR-0026 puts a multi-write workflow that must succeed or fail
    // as one unit inside a Database adapter transaction, and a schema migration is the largest one
    // the runtime owns: it drops tables, rebuilds them, copies every row across and then records
    // the new schema. Half of that is not a smaller migration, it is a Capsule whose stored data no
    // longer matches its schema metadata.
    //
    // The failure is driven from inside the migration rather than by breaking the adapter, so the
    // same case means the same thing on every engine: the accounts table migrates cleanly first,
    // then the entries table asks for a Reference default that names no row. What is asserted is
    // the state afterwards — every table's columns, every table's rows, the schema metadata, and
    // the absence of the temporary table the rebuild builds — because a transaction that opened and
    // committed without enclosing its work would leave the accounts rebuild applied and everything
    // after it missing, while throwing exactly the same error.
    name: "a migration that fails partway leaves every table, row and schema metadata value unchanged",
    async run(adapter) {
      const schemaBefore = (await adapter.readSchemaMetadata()).value;
      const hashBefore = (await adapter.readSystemMetadata("schemaHash")).value;
      const dumpBefore = await adapter.dumpInspectableDatabase();
      const accountsBefore = dumpBefore.find((table) => table.name === ACCOUNTS_TABLE.name);
      const entriesBefore = dumpBefore.find((table) => table.name === ENTRIES_TABLE.name);

      // The precondition is what makes the assertions below mean something, so it states the two
      // facts they rely on and nothing more: both tables hold rows, so there is real data to lose,
      // and neither yet has the column the failing migration would add, so its later absence is
      // evidence of a rollback rather than of it never having been attempted.
      //
      // Deliberately derived rather than fixed. Asserting a particular row count here would make
      // this case depend on every earlier case in the surface having cleaned up after itself, and
      // an engine where one of them does not would abort at the precondition — before
      // `migrateAppSchema` is ever called, leaving the case unable to distinguish a working
      // rollback from a broken one on exactly the engine where that question is hardest to answer
      // by reading the code. What the case asserts is that the rollback changed nothing, so the
      // before-state it compares against is whatever it observes, not whatever it expected.
      assert.equal(accountsBefore.rows.length > 0, true);
      assert.equal(entriesBefore.rows.length > 0, true);
      assert.equal(accountsBefore.columns.includes(REBUILT_ACCOUNTS_FIELD.name), false);
      assert.equal(entriesBefore.columns.includes(DANGLING_REFERENCE_FIELD.name), false);

      await assert.rejects(adapter.migrateAppSchema(FAILING_SCHEMA), {
        message: `Invalid reference for field: ${DANGLING_REFERENCE_FIELD.name}`,
        hint: `Pass the id of an existing ${ACCOUNTS_TABLE.name} row.`,
      });

      // The accounts table is the one the migration had already finished rebuilding when the
      // entries table aborted it. Its added column must be gone and its rows must be exactly the
      // rows it held before, not a copy that survived in a half-committed rebuild.
      const dumpAfter = await adapter.dumpInspectableDatabase();
      const accountsAfter = dumpAfter.find((table) => table.name === ACCOUNTS_TABLE.name);
      assert.deepEqual(accountsAfter.columns, accountsBefore.columns);
      assert.deepEqual(
        accountsAfter.rows.map((row) => pick(row, accountsBefore.columns)),
        accountsBefore.rows.map((row) => pick(row, accountsBefore.columns)),
      );

      // The table the migration failed on keeps its own columns and rows too.
      const entriesAfter = dumpAfter.find((table) => table.name === ENTRIES_TABLE.name);
      assert.deepEqual(entriesAfter.columns, entriesBefore.columns);
      assert.deepEqual(
        entriesAfter.rows.map((row) => pick(row, entriesBefore.columns)),
        entriesBefore.rows.map((row) => pick(row, entriesBefore.columns)),
      );

      // The rebuild works through a temporary table, and a rollback has to take that with it.
      assert.equal((await adapter.listInspectableTables()).includes(`__sporades_migrating_${ACCOUNTS_TABLE.name}`), false);
      assert.equal((await adapter.listInspectableTables()).includes(`__sporades_migrating_${ENTRIES_TABLE.name}`), false);

      // And the schema metadata still describes the schema the storage actually has. A recorded
      // schema the tables do not match is what makes a half-applied migration unrecoverable: the
      // next start compares against it and concludes nothing changed.
      assert.equal((await adapter.readSchemaMetadata()).value, schemaBefore);
      assert.equal((await adapter.readSystemMetadata("schemaHash")).value, hashBefore);
      assert.equal((await adapter.readSystemMetadata("schemaVersion")).value, "v1:additive-fields");

      // The transaction really closed rather than being left open behind the failure: an ordinary
      // write after it lands and is readable.
      await adapter.insertAppRow(ACCOUNTS_TABLE, { id: "account-after-rollback", createdAt: NOW, updatedAt: NOW, label: "written after" });
      assert.equal((await adapter.selectAppRowById(ACCOUNTS_TABLE, "account-after-rollback")).label, "written after");
      assert.equal((await adapter.deleteAppRow(ACCOUNTS_TABLE, "account-after-rollback")).changes, 1);
    },
  },
  {
    // ADR-0034's fourth rule limb reaches this method through three writes rather than one: the
    // shared definition used to fire all three and return nothing, so a caller had nothing to
    // await and, on an asynchronous engine, no ordering between them either. What the caller can
    // observe is asserted here — awaiting the call is enough for all three keys to be readable —
    // rather than the return value, which is a resolved statement result on an asynchronous engine
    // and undefined on a synchronous one.
    name: "writeSchemaMetadata records the schema version, hash and JSON, and overwrites them in place",
    async run(adapter) {
      const migratedSchemaJson = (await adapter.readSchemaMetadata()).value;
      const migratedSchemaHash = (await adapter.readSystemMetadata("schemaHash")).value;

      await adapter.writeSchemaMetadata({
        schemaVersion: "v1:conformance",
        schemaHash: "hash-conformance",
        schemaJson: '{"tables":[]}',
      });
      assert.deepEqual(
        {
          schemaVersion: (await adapter.readSystemMetadata("schemaVersion")).value,
          schemaHash: (await adapter.readSystemMetadata("schemaHash")).value,
          schema: (await adapter.readSchemaMetadata()).value,
        },
        { schemaVersion: "v1:conformance", schemaHash: "hash-conformance", schema: '{"tables":[]}' },
      );

      // The other side: a second write replaces all three rather than adding to them.
      await adapter.writeSchemaMetadata({
        schemaVersion: "v1:conformance-replaced",
        schemaHash: "hash-conformance-replaced",
        schemaJson: '{"tables":[{"name":"conformance_written"}]}',
      });
      assert.deepEqual(
        {
          schemaVersion: (await adapter.readSystemMetadata("schemaVersion")).value,
          schemaHash: (await adapter.readSystemMetadata("schemaHash")).value,
          schema: (await adapter.readSchemaMetadata()).value,
        },
        {
          schemaVersion: "v1:conformance-replaced",
          schemaHash: "hash-conformance-replaced",
          schema: '{"tables":[{"name":"conformance_written"}]}',
        },
      );

      // Put back what the migration recorded, so this case cannot change what a later reader of
      // the schema metadata sees.
      await adapter.writeSchemaMetadata({
        schemaVersion: "v1:additive-fields",
        schemaHash: migratedSchemaHash,
        schemaJson: migratedSchemaJson,
      });
      assert.equal((await adapter.readSystemMetadata("schemaVersion")).value, "v1:additive-fields");
      assert.equal((await adapter.readSchemaMetadata()).value, migratedSchemaJson);
    },
  },
  {
    name: "createAppTable creates a table that stores rows, under its own name or a given one, and is idempotent",
    async run(adapter) {
      assert.equal((await adapter.listInspectableTables()).includes(STANDALONE_TABLE.name), false);

      await adapter.createAppTable(STANDALONE_TABLE);
      assert.equal((await adapter.listInspectableTables()).includes(STANDALONE_TABLE.name), true);

      assert.equal(
        (await adapter.insertAppRow(STANDALONE_TABLE, { id: "standalone-kept", createdAt: NOW, updatedAt: NOW, label: "stored" })).changes,
        1,
      );

      // Creating again is what a Capsule restart does, so it has to keep the stored row rather
      // than replace the table.
      await adapter.createAppTable(STANDALONE_TABLE);
      assert.equal((await adapter.selectAppRowById(STANDALONE_TABLE, "standalone-kept")).label, "stored");

      // The second argument names the table instead, which is how the migration builds its
      // temporary copy.
      await adapter.createAppTable(STANDALONE_TABLE, STANDALONE_ALIAS_TABLE_NAME);
      const inspectable = await adapter.listInspectableTables();
      assert.equal(inspectable.includes(STANDALONE_ALIAS_TABLE_NAME), true);
      assert.deepEqual(
        (await adapter.dumpInspectableDatabase()).find((table) => table.name === STANDALONE_ALIAS_TABLE_NAME),
        { name: STANDALONE_ALIAS_TABLE_NAME, columns: ["id", "createdAt", "updatedAt", "label"], rows: [] },
      );
    },
  },
  {
    name: "createAppTable enforces quoted single and composite unique constraints with ordinary SQL null semantics",
    async run(adapter) {
      await adapter.createAppTable(UNIQUE_TABLE);
      const first = { id: "unique-one", createdAt: NOW, updatedAt: NOW, identity: "identity-one", email: "one@example.test", select: "reserved-word" };
      await adapter.insertAppRow(UNIQUE_TABLE, first);
      await assert.rejects(
        async () => adapter.insertAppRow(UNIQUE_TABLE, { ...first, id: "unique-two", email: "two@example.test", select: "other" }),
        /unique constraint|duplicate key|constraint failed/i,
      );
      await assert.rejects(
        async () => adapter.insertAppRow(UNIQUE_TABLE, { ...first, id: "unique-three", identity: "identity-two" }),
        /unique constraint|duplicate key|constraint failed/i,
      );
      await adapter.insertAppRow(UNIQUE_TABLE, { ...first, id: "unique-four", identity: "identity-three", email: null, select: "reserved-word" });
      await adapter.insertAppRow(UNIQUE_TABLE, { ...first, id: "unique-five", identity: "identity-four", email: null, select: "reserved-word" });
    },
  },
  {
    name: "insertAppRowOrIgnore returns no change only for its named unique constraint",
    async run(adapter) {
      const first = { id: "ignore-one", createdAt: NOW, updatedAt: NOW, identity: "ignore-identity", email: "ignore@example.test", select: "ignore-select" };
      assert.equal((await adapter.insertAppRowOrIgnore(UNIQUE_TABLE, first, ["identity"])).changes, 1);
      assert.equal(
        (await adapter.insertAppRowOrIgnore(UNIQUE_TABLE, { ...first, id: "ignore-two", email: "other@example.test", select: "other-select" }, ["identity"])).changes,
        0,
      );
      await assert.rejects(
        async () => adapter.insertAppRowOrIgnore(UNIQUE_TABLE, { ...first, id: "ignore-three", identity: "other-identity" }, ["identity"]),
        /unique constraint|duplicate key|constraint failed/i,
      );
    },
  },
  {
    // The names that used to be renamed on the way out. The Postgres adapter restored the runtime's
    // declared spellings through a table of them, applied per result key with no table provenance,
    // so a Capsule field literally called `errorcode` or `jobid` came back as `errorCode` or
    // `jobId` — a field the Capsule wrote and could not read. Nothing forbade such a field.
    //
    // ADR-0039 removed the table rather than narrowing it, so this asserts the property that
    // replaces it: an app column round-trips under its own declared name whatever it is called.
    // Written as a conformance case rather than a Postgres test because the claim is that every
    // engine answers the same, and only one of them ever answered differently.
    name: "an app column keeps its own declared name, including the names that used to be renamed",
    async run(adapter) {
      await adapter.createAppTable(COLLIDING_NAMES_TABLE);

      assert.equal(
        (await adapter.insertAppRow(COLLIDING_NAMES_TABLE, {
          id: "collision-1",
          createdAt: NOW,
          updatedAt: NOW,
          errorcode: "E_LOWER",
          jobid: "J_LOWER",
        })).changes,
        1,
      );

      // The whole key set, not a field-by-field check: `errorcode` renamed to `errorCode` on the
      // way out satisfies any assertion that reads the field it was renamed to, and leaves the
      // Capsule a field it wrote and cannot read.
      const stored = await adapter.selectAppRowById(COLLIDING_NAMES_TABLE, "collision-1");
      assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "errorcode", "id", "jobid", "updatedAt"]);
      assert.deepEqual(pick(stored, ["errorcode", "jobid"]), { errorcode: "E_LOWER", jobid: "J_LOWER" });

      // And the names work as predicates and as projections, not only as keys of `SELECT *`, so
      // every statement that asks for them names them the way the table was created with.
      assert.deepEqual(
        (await adapter.selectAppRows(COLLIDING_NAMES_TABLE, {
          columns: ["errorcode", "jobid"],
          where: { fieldName: "errorcode", value: "E_LOWER" },
        })).map((row) => pick(row, ["errorcode", "jobid"])),
        [{ errorcode: "E_LOWER", jobid: "J_LOWER" }],
      );
      assert.deepEqual(await adapter.selectAppRows(COLLIDING_NAMES_TABLE, { where: { fieldName: "errorcode", value: "E_OTHER" } }), []);

      assert.equal(
        (await adapter.updateAppRow(COLLIDING_NAMES_TABLE, "collision-1", { errorcode: "E_UPDATED" })).changes,
        1,
      );
      assert.deepEqual(
        pick(await adapter.selectAppRowById(COLLIDING_NAMES_TABLE, "collision-1"), ["errorcode", "jobid"]),
        { errorcode: "E_UPDATED", jobid: "J_LOWER" },
      );

      await adapter.deleteAppRow(COLLIDING_NAMES_TABLE, "collision-1");
    },
  },
  {
    name: "migrateExistingAppTable adds a field with its default to an existing table and keeps stored rows",
    async run(adapter) {
      assert.equal((await adapter.selectAppRowById(STANDALONE_TABLE, "standalone-kept")).state, undefined);

      await adapter.migrateExistingAppTable(STANDALONE_TABLE, MIGRATED_STANDALONE_TABLE);

      // The row written before the migration survives it and takes the added field's default.
      assert.deepEqual(pick(await adapter.selectAppRowById(MIGRATED_STANDALONE_TABLE, "standalone-kept"), ["id", "label", "state"]), {
        id: "standalone-kept",
        label: "stored",
        state: "unset",
      });

      // The other side of the default: a row that supplies the field keeps its own value.
      await adapter.insertAppRow(MIGRATED_STANDALONE_TABLE, {
        id: "standalone-explicit",
        createdAt: NOW,
        updatedAt: LATER,
        label: "explicit",
        state: "set",
      });
      assert.equal((await adapter.selectAppRowById(MIGRATED_STANDALONE_TABLE, "standalone-explicit")).state, "set");

      // The migration rebuilds the table through a temporary copy and must leave nothing behind.
      const inspectable = await adapter.listInspectableTables();
      assert.equal(inspectable.includes(STANDALONE_TABLE.name), true);
      assert.equal(inspectable.includes(`__sporades_migrating_${STANDALONE_TABLE.name}`), false);
    },
  },
  {
    name: "migrateAppSchema adds a unique constraint atomically and records the migrated schema",
    async run(adapter) {
      await adapter.migrateAppSchema(MIGRATED_SCHEMA_WITH_UNIQUE_MIGRATION_TABLE);
      await adapter.insertAppRow(UNIQUE_MIGRATION_TABLE, {
        id: "unique-migration-kept",
        createdAt: NOW,
        updatedAt: NOW,
        teamId: "team-a",
        slug: "home",
        externalId: "external-a",
      });

      await adapter.migrateAppSchema(MIGRATED_SCHEMA_WITH_UNIQUE_MIGRATION_EXTERNAL_ID);

      assert.deepEqual(
        pick(await adapter.selectAppRowById(UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, "unique-migration-kept"), ["teamId", "slug", "externalId"]),
        { teamId: "team-a", slug: "home", externalId: "external-a" },
      );
      const stored = JSON.parse((await adapter.readSchemaMetadata()).value);
      assert.deepEqual(
        stored.tables.find((table) => table.name === UNIQUE_MIGRATION_TABLE.name).uniqueConstraints,
        [["teamId", "slug"], ["externalId"]],
      );
      assert.equal(typeof (await adapter.readSystemMetadata("schemaHash")).value, "string");
      assert.equal((await adapter.listInspectableTables()).includes(`__sporades_migrating_${UNIQUE_MIGRATION_TABLE.name}`), false);
      await assert.rejects(
        async () => adapter.insertAppRow(UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, {
          id: "unique-migration-conflict",
          createdAt: NOW,
          updatedAt: NOW,
          teamId: "team-b",
          slug: "other",
          externalId: "external-a",
        }),
        /unique constraint|duplicate key|constraint failed/i,
      );
    },
  },
  {
    name: "migrateAppSchema rejects non-additive unique changes without rebuilding, copying, or rewriting metadata",
    async run(adapter) {
      await adapter.migrateAppSchema(MIGRATED_SCHEMA_WITH_UNIQUE_MUTABILITY_AND_MIGRATION);
      await adapter.insertAppRow(UNIQUE_MUTABILITY_TABLE, {
        id: "unique-mutability-kept",
        createdAt: NOW,
        updatedAt: NOW,
        first: "first",
        second: "second",
        third: "third",
      });

      const schemaBefore = (await adapter.readSchemaMetadata()).value;
      const hashBefore = (await adapter.readSystemMetadata("schemaHash")).value;
      const tableBefore = (await adapter.dumpInspectableDatabase()).find((table) => table.name === UNIQUE_MUTABILITY_TABLE.name);
      const changes = [
        { name: "remove", uniqueConstraints: [] },
        { name: "replace", uniqueConstraints: [["first"]] },
        { name: "composite-order", uniqueConstraints: [["second", "first"]] },
      ];

      for (const change of changes) {
        const changedTable = { ...UNIQUE_MUTABILITY_TABLE, uniqueConstraints: change.uniqueConstraints };
        const changedSchema = { tables: [...MIGRATED_SCHEMA.tables, UNIQUE_MIGRATION_TABLE_WITH_EXTERNAL_ID, changedTable] };
        await assert.rejects(adapter.migrateAppSchema(changedSchema), {
          message: "Unsupported Capsule schema change.",
          hint: "Only adding new tables, fields, or unique constraints is supported right now. Revert changed constraints, or move data aside and recreate the Runtime directory.",
        }, change.name);

        const tableAfter = (await adapter.dumpInspectableDatabase()).find((table) => table.name === UNIQUE_MUTABILITY_TABLE.name);
        assert.deepEqual(tableAfter.columns, tableBefore.columns, `${change.name} must not change columns`);
        assert.deepEqual(tableAfter.rows, tableBefore.rows, `${change.name} must not copy or change rows`);
        assert.equal((await adapter.listInspectableTables()).includes(`__sporades_migrating_${UNIQUE_MUTABILITY_TABLE.name}`), false, `${change.name} must not create a rebuild table`);
        assert.equal((await adapter.readSchemaMetadata()).value, schemaBefore, `${change.name} must not rewrite schema metadata`);
        assert.equal((await adapter.readSystemMetadata("schemaHash")).value, hashBefore, `${change.name} must not rewrite schema metadata hash`);
        await assert.rejects(
          async () => adapter.insertAppRow(UNIQUE_MUTABILITY_TABLE, {
            id: `unique-mutability-${change.name}`,
            createdAt: NOW,
            updatedAt: NOW,
            first: "first",
            second: "second",
            third: `after-${change.name}`,
          }),
          /unique constraint|duplicate key|constraint failed/i,
          `${change.name} must preserve the original composite unique constraint`,
        );
      }
    },
  },
  {
    name: "migrateAppSchema rejects duplicate data atomically with one opaque unique-migration error",
    async run(adapter) {
      await adapter.migrateAppSchema(MIGRATED_SCHEMA_WITH_UNIQUE_DUPLICATE_MIGRATION);
      await adapter.insertAppRow(UNIQUE_DUPLICATE_MIGRATION_TABLE, {
        id: "unique-duplicate-one",
        createdAt: NOW,
        updatedAt: NOW,
        teamId: "team-a",
        slug: "first",
        externalId: "duplicate-value",
      });
      await adapter.insertAppRow(UNIQUE_DUPLICATE_MIGRATION_TABLE, {
        id: "unique-duplicate-two",
        createdAt: NOW,
        updatedAt: NOW,
        teamId: "team-a",
        slug: "second",
        externalId: "duplicate-value",
      });

      const schemaBefore = (await adapter.readSchemaMetadata()).value;
      const hashBefore = (await adapter.readSystemMetadata("schemaHash")).value;
      const tableBefore = (await adapter.dumpInspectableDatabase()).find((table) => table.name === UNIQUE_DUPLICATE_MIGRATION_TABLE.name);
      await assert.rejects(
        adapter.migrateAppSchema(MIGRATED_SCHEMA_WITH_UNIQUE_DUPLICATE_EXTERNAL_ID),
        (error) => {
          assert.equal(error.message, "Unable to apply unique constraint migration.");
          assert.match(error.hint, /Remove or resolve duplicate data/i);
          assert.doesNotMatch(error.message, /duplicate-value|postgres|key \(/i);
          assert.doesNotMatch(error.hint, /duplicate-value|postgres|key \(/i);
          return true;
        },
      );

      const tableAfter = (await adapter.dumpInspectableDatabase()).find((table) => table.name === UNIQUE_DUPLICATE_MIGRATION_TABLE.name);
      assert.deepEqual(tableAfter.columns, tableBefore.columns);
      assert.deepEqual(tableAfter.rows, tableBefore.rows);
      assert.equal((await adapter.listInspectableTables()).includes(`__sporades_migrating_${UNIQUE_DUPLICATE_MIGRATION_TABLE.name}`), false);
      assert.equal((await adapter.readSchemaMetadata()).value, schemaBefore);
      assert.equal((await adapter.readSystemMetadata("schemaHash")).value, hashBefore);
      await adapter.insertAppRow(UNIQUE_DUPLICATE_MIGRATION_TABLE, {
        id: "unique-duplicate-after-rollback",
        createdAt: NOW,
        updatedAt: NOW,
        teamId: "team-a",
        slug: "third",
        externalId: "duplicate-value",
      });
    },
  },
  {
    name: "user preferences storage stores one Sporades user's preferences, overwrites them, and answers null for another",
    async run(adapter) {
      await adapter.ensureUserPreferencesStorage();

      assert.equal(await adapter.readUserPreferences(OWNER_A), null);

      assert.equal((await adapter.saveUserPreferences({ userId: OWNER_A, value: '{"theme":"dark"}', updatedAt: NOW })).changes, 1);
      assert.deepEqual(pick(await adapter.readUserPreferences(OWNER_A), ["userId", "value", "updatedAt"]), {
        userId: OWNER_A,
        value: '{"theme":"dark"}',
        updatedAt: NOW,
      });

      // Preferences are per Sporades user, so a second user still has none.
      assert.equal(await adapter.readUserPreferences(OWNER_B), null);

      // The save is an upsert: a second save for the same user replaces rather than adds.
      await adapter.saveUserPreferences({ userId: OWNER_A, value: '{"theme":"light"}', updatedAt: LATER });
      assert.deepEqual(pick(await adapter.readUserPreferences(OWNER_A), ["userId", "value", "updatedAt"]), {
        userId: OWNER_A,
        value: '{"theme":"light"}',
        updatedAt: LATER,
      });

      // And a second run of the DDL keeps what is stored, as a Capsule restart requires.
      await adapter.ensureUserPreferencesStorage();
      assert.equal((await adapter.readUserPreferences(OWNER_A)).value, '{"theme":"light"}');
      assert.equal(await adapter.readUserPreferences(OWNER_B), null);
    },
  },
  {
    name: "ensureSystemTable and ensureLogStorage keep what is already stored and leave the storage writable",
    async run(adapter) {
      await adapter.writeSystemMetadata("conformance-idempotence", "written before");
      await adapter.insertLogIndexEvent(logEvent(9));

      // Both run again on every Capsule start, over storage that already holds rows.
      await adapter.ensureSystemTable();
      await adapter.ensureLogStorage();

      assert.equal((await adapter.readSystemMetadata("conformance-idempotence")).value, "written before");
      assert.deepEqual((await adapter.readRecentLogEvents(10)).map((event) => event.message), ["conformance-log-9"]);

      assert.equal((await adapter.writeSystemMetadata("conformance-idempotence", "written after")).changes, 1);
      assert.equal((await adapter.readSystemMetadata("conformance-idempotence")).value, "written after");
      assert.equal((await adapter.insertLogIndexEvent(logEvent(8))).changes, 1);
      // Indexing order, not envelope-timestamp order: event 8 carries the earlier timestamp and is
      // still returned last, because ADR-0036 orders the Log index by when the runtime indexed an
      // event rather than by what the envelope says about when it happened.
      assert.deepEqual((await adapter.readRecentLogEvents(10)).map((event) => event.message), [
        "conformance-log-9",
        "conformance-log-8",
      ]);
    },
  },
  {
    // Only the healthy answer is asserted here. `{ ok: false }` requires a connection that has
    // been broken, which is connection lifecycle and stays in the per-engine tests — but the
    // healthy answer is not incidental: the shared definition derived it from an unresolved
    // statement inside a `try`/`catch` that a rejected Promise cannot reach, and both engines
    // carried an await-shim over it rather than that being fixed.
    name: "checkHealth reports a live connection",
    async run(adapter) {
      assert.deepEqual(await adapter.checkHealth(), { ok: true });

      // Still the same answer once the connection has served the statements above, so it is
      // reporting the connection rather than a constant computed at construction.
      await adapter.readSystemMetadata("conformance-idempotence");
      assert.deepEqual(await adapter.checkHealth(), { ok: true });
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (app tables and runtime metadata)",
  // Every app table this surface migrates, including the one the additive migration adds and the
  // temporary table that migration builds. A table left undeclared survives the Postgres schema
  // reset and is then silently adopted, with its old rows, by `CREATE TABLE IF NOT EXISTS`.
  appTableNames: [
    ACCOUNTS_TABLE.name,
    ENTRIES_TABLE.name,
    ARCHIVE_TABLE.name,
    STANDALONE_TABLE.name,
    STANDALONE_ALIAS_TABLE_NAME,
    COLLIDING_NAMES_TABLE.name,
    UNIQUE_TABLE.name,
    UNIQUE_MUTABILITY_TABLE.name,
    UNIQUE_MIGRATION_TABLE.name,
    UNIQUE_DUPLICATE_MIGRATION_TABLE.name,
    `__sporades_migrating_${ACCOUNTS_TABLE.name}`,
    `__sporades_migrating_${ENTRIES_TABLE.name}`,
    `__sporades_migrating_${STANDALONE_TABLE.name}`,
    `__sporades_migrating_${UNIQUE_MIGRATION_TABLE.name}`,
    `__sporades_migrating_${UNIQUE_DUPLICATE_MIGRATION_TABLE.name}`,
  ],
  prepareStorage: prepareAppTableStorage,
  cases: APP_TABLE_CONFORMANCE_CASES,
};
