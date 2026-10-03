import assert from "node:assert/strict";
import {
  LIVE_QUERY_ANY_TABLE,
  liveQueryNeedsRefresh,
  liveQueryTablesTracked,
  takeLiveQueryDirtyTables,
  trackLiveQueryReads,
} from "../../../dist/live-query-invalidation.js";

const names = ["refresh_todos", "refresh_notes", "refresh_audits"];
const subscriptions = async (adapter) => {
  const reads = [];
  for (const name of names.slice(0, 2)) {
    const tables = new Set();
    await trackLiveQueryReads(tables, () => adapter.selectAppRows({ name }, {}));
    assert.deepEqual([...tables], [name]);
    reads.push(tables);
  }
  return reads;
};
const refreshed = (reads) => {
  const dirty = takeLiveQueryDirtyTables();
  return reads.map((tables) => liveQueryNeedsRefresh(tables, dirty));
};

export const CONFORMANCE_SURFACE = {
  title: "Table-scoped live query invalidation",
  appTableNames: names,
  // The HTTP fixture must not report SQLite writes into the client's dirty window.
  adapterOptions: { isolateProcess: true },
  async prepareStorage(adapter) {
    await adapter.ensureSystemTable();
    await adapter.migrateAppSchema({ tables: names.map((name) => ({ name, fields: [{ name: "text", kind: "String", sqliteType: "TEXT" }] })) });
    for (const name of names) {
      await adapter.insertAppRow({ name }, { id: name, text: "initial", createdAt: "2026-10-03", updatedAt: "2026-10-03" });
    }
    takeLiveQueryDirtyTables();
  },
  cases: [{
    name: "writing one table refreshes only its readers; unrelated and zero-row writes refresh none",
    async run(adapter) {
      const reads = await subscriptions(adapter);
      assert.equal(adapter.dialect.sql("SELECT * FROM [refresh_todos]"), 'SELECT * FROM "refresh_todos"');
      assert.equal(adapter[liveQueryTablesTracked], true);
      await adapter.updateAppRow({ name: "refresh_todos" }, "refresh_todos", { text: "changed" });
      assert.deepEqual(refreshed(reads), [true, false]);
      await adapter.updateAppRow({ name: "refresh_audits" }, "refresh_audits", { text: "unrelated" });
      assert.deepEqual(refreshed(reads), [false, false]);
      await adapter.updateAppRow({ name: "refresh_notes" }, "missing", { text: "absent" });
      assert.deepEqual(refreshed(reads), [false, false]);
    },
  }, {
    name: "exec records single writes and conservatively refreshes all readers for multiple statements",
    async run(adapter) {
      const reads = await subscriptions(adapter);
      takeLiveQueryDirtyTables();
      await adapter.exec('UPDATE "refresh_notes" SET "text" = \'exec\'');
      assert.deepEqual(refreshed(reads), [false, true]);
      await adapter.exec('UPDATE "refresh_todos" SET "text" = \'multi\'; UPDATE "refresh_notes" SET "text" = \'multi\'');
      assert.deepEqual(refreshed(reads), [true, true]);
      await assert.rejects(async () => adapter.exec('UPDATE "refresh_todos" SET "text" = \'partial\'; UPDATE "missing_refresh_table" SET "text" = \'fail\''));
      assert.deepEqual(refreshed(reads), [true, true], "a failed exec may already have executed an earlier write");
    },
  }, {
    name: "zero-result prepared batches and data-modifying CTEs retain committed invalidation",
    async run(adapter) {
      const reads = await subscriptions(adapter);
      takeLiveQueryDirtyTables();
      const zero = await adapter.prepare("UPDATE refresh_audits SET \"text\" = ? WHERE \"id\" = ?").run("absent", "missing");
      assert.equal(zero.changes, 0);
      assert.deepEqual(refreshed(reads), [true, true], "unclassified statements retain full invalidation even with zero rows");
      if (adapter.engine !== "postgres") return; // These statement forms are Postgres-specific.
      const statements = [
        `UPDATE "refresh_todos" SET "text" = 'batch-changed'; UPDATE "refresh_notes" SET "text" = 'absent' WHERE "id" = 'missing'`,
        `WITH changed AS (UPDATE "refresh_todos" SET "text" = 'cte-changed' RETURNING "id") UPDATE "refresh_notes" SET "text" = 'absent' WHERE "id" = 'missing'`,
      ];
      for (const [index, sql] of statements.entries()) {
        takeLiveQueryDirtyTables();
        const result = await adapter.prepare(sql).run();
        assert.equal(result.changes, 0, "the final result does not count the earlier committed write");
        assert.equal((await adapter.selectAppRowById({ name: "refresh_todos" }, "refresh_todos")).text, index === 0 ? "batch-changed" : "cte-changed");
        assert.deepEqual(refreshed(reads), [true, true], "uncertain write counts must keep the full refresh fallback");
      }
    },
  }, {
    name: "transaction and snapshot reads retain their subscription context; rollback never loses writes",
    async run(adapter) {
      const reads = await subscriptions(adapter);
      for (const method of ["withTransaction", "withReadOnlySnapshot"]) {
        const tables = new Set();
        await trackLiveQueryReads(tables, () => adapter[method](async (transaction) => {
          assert.equal(transaction[liveQueryTablesTracked], true);
          await Promise.resolve();
          await transaction.selectAppRowById({ name: "refresh_notes" }, "refresh_notes");
        }));
        assert.deepEqual([...tables], ["refresh_notes"]);
      }
      takeLiveQueryDirtyTables();
      await adapter.withTransaction((transaction) => transaction.updateAppRow({ name: "refresh_notes" }, "refresh_notes", { text: "committed" }));
      assert.deepEqual(refreshed(reads), [false, true]);
      await assert.rejects(async () => adapter.withTransaction(async (transaction) => {
        await transaction.updateAppRow({ name: "refresh_todos" }, "refresh_todos", { text: "rolled back" });
        throw new Error("rollback-test");
      }), /rollback-test/);
      assert.deepEqual(refreshed(reads), [true, false]);
      assert.notEqual((await adapter.selectAppRowById({ name: "refresh_todos" }, "refresh_todos")).text, "rolled back");
    },
  }, {
    name: "dedicated resource connections track reads and writes; unsupported engines reject before callback",
    async run(adapter) {
      if (adapter.engine === "libsql") {
        await assert.rejects(async () => adapter.withResourceTransaction(() => assert.fail("unsupported callback executed")), { code: "RESOURCE_ADAPTER_UNSUPPORTED" });
        return;
      }
      const reads = await subscriptions(adapter);
      // Bootstrap DDL is intentionally an unknown write. Warm it before asserting scope.
      const resource = { table: "refresh_todos", id: "refresh_todos" };
      await adapter.withResourceTransaction(() => undefined, undefined, resource);
      takeLiveQueryDirtyTables();
      const tables = new Set();
      await trackLiveQueryReads(tables, () => adapter.withResourceTransaction(async (transaction) => {
        await transaction.selectAppRowById({ name: "refresh_todos" }, "refresh_todos");
        await transaction.updateAppRow({ name: "refresh_notes" }, "refresh_notes", { text: "resource" });
      }, adapter.engine === "postgres" ? () => { takeLiveQueryDirtyTables(); } : undefined, resource));
      assert(tables.has("refresh_todos"), "application reads on the dedicated connection are tracked");
      assert.deepEqual(refreshed(reads), [false, true]);
      await assert.rejects(async () => adapter.withResourceTransaction(async (transaction) => {
        await transaction.exec('UPDATE "refresh_todos" SET "text" = \'resource rollback\'');
        if (adapter.engine === "postgres") takeLiveQueryDirtyTables();
        throw new Error("resource-rollback-test");
      }, undefined, resource), /resource-rollback-test/);
      assert.deepEqual(refreshed(reads), [true, false]);
      assert.notEqual((await adapter.selectAppRowById({ name: "refresh_todos" }, "refresh_todos")).text, "resource rollback");
    },
  }, {
    name: "unparseable reads and writes retain the full refresh fallback",
    async run(adapter) {
      const tables = new Set();
      await trackLiveQueryReads(tables, () => adapter.prepare("SELECT 1 AS n").get());
      assert.deepEqual([...tables], [LIVE_QUERY_ANY_TABLE]);
      const reads = await subscriptions(adapter);
      takeLiveQueryDirtyTables();
      // Valid in each dialect, but an unquoted table is outside the extractor's grammar.
      await adapter.prepare("UPDATE refresh_audits SET text = ?").run("unknown-table-write");
      assert.deepEqual([...takeLiveQueryDirtyTables()], [LIVE_QUERY_ANY_TABLE]);
      await adapter.exec('SELECT 1; UPDATE "refresh_notes" SET "text" = \'after-select\'');
      assert.deepEqual(refreshed(reads), [true, true]);
    },
  }],
};
