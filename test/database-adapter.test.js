import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSqliteDatabaseAdapter, openDevDatabase } from "../src/server-runtime-source.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-database-adapter-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("SQLite database adapter owns setup, query execution, and close lifecycle", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "nested", "data.db"));

    adapter.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    adapter.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("one", "hello");

    assert.deepEqual({ ...adapter.prepare("SELECT id, value FROM entries WHERE id = ?").get("one") }, {
      id: "one",
      value: "hello",
    });
    assert.deepEqual(adapter.prepare("SELECT id, value FROM entries ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "one", value: "hello" },
    ]);
    assert.equal(adapter.prepare("PRAGMA journal_mode").get().journal_mode, "wal");

    adapter.close();
    assert.throws(() => adapter.prepare("SELECT 1").get(), /database is not open/i);
  });
});

test("SQLite database adapter propagates execution failures", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      assert.throws(() => adapter.exec("CREATE TABLE broken ("), /incomplete input|syntax error/i);
      assert.throws(() => adapter.prepare("SELECT * FROM missing_table").all(), /no such table/i);
    } finally {
      adapter.close();
    }
  });
});

test("runtime opens and closes SQLite through the internal adapter boundary", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {});

    assert.equal(typeof database.sqlite.exec, "function");
    assert.equal(typeof database.sqlite.prepare, "function");
    assert.equal(typeof database.sqlite.close, "function");
    assert.deepEqual({ ...database.sqlite.prepare("SELECT value FROM sporades WHERE key = ?").get("schemaVersion") }, {
      value: "v1:additive-fields",
    });

    database.close();
    assert.throws(() => database.sqlite.prepare("SELECT 1").get(), /database is not open/i);
  });
});
