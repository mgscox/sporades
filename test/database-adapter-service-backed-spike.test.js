import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createServiceBackedSqliteAdapter } from "./support/service-backed-sqlite-adapter.js";
import { dumpDatabase, listDatabaseTables, runReadOnlyQuery } from "../dist/server-runtime-source.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-backed-adapter-spike-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("spike proof: a service-backed SQLite-compatible adapter can run representative runtime paths", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createServiceBackedSqliteAdapter(path.join(dir, "service.db"));
    const database = { adapter };
    try {
      const notesTable = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
          { name: "done", kind: "Boolean", sqliteType: "INTEGER", defaultValue: false },
        ],
      };

      adapter.ensureSystemTable();
      adapter.writeSystemMetadata("spike", "service-backed");
      await adapter.migrateAppSchema({ tables: [notesTable] });
      assert.equal(adapter.readSystemMetadata("spike").value, "service-backed");

      const now = "2026-07-04T10:00:00.000Z";
      adapter.insertAppRow(notesTable, {
        id: "note-1",
        createdAt: now,
        updatedAt: now,
        text: "prove app table path",
        ownerId: "user-1",
        done: 0,
      });
      adapter.updateAppRow(notesTable, "note-1", { done: 1, updatedAt: "2026-07-04T10:01:00.000Z" });
      assert.deepEqual(
        adapter.selectAppRows(notesTable, { columns: ["text", "done"], where: { fieldName: "ownerId", value: "user-1" } }),
        [{ text: "prove app table path", done: 1 }],
      );

      adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
      adapter.insertAuthUser({
        id: "user-1",
        createdAt: now,
        displayName: "Spike User",
        email: "spike@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "email",
      });
      adapter.insertAuthSession({
        token: "session-1",
        userId: "user-1",
        provider: "email",
        createdAt: now,
        expiresAt: "2026-08-03T10:00:00.000Z",
      });
      assert.equal(adapter.readAuthSessionWithUser("session-1").email, "spike@example.com");

      adapter.ensureFileStorage();
      adapter.createFileBucket({ id: "bucket-1", ownerId: "user-1", name: "default", createdAt: now });
      adapter.insertFileRow({
        id: "file-1",
        ownerId: "user-1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/proof.txt",
        name: "proof.txt",
        type: "text/plain",
        size: 5,
        version: "version-1",
        status: "uploaded",
        createdAt: now,
        updatedAt: now,
      });
      assert.equal(adapter.fileRowForOwner("file-1", "user-1").name, "proof.txt");

      adapter.ensureLogStorage();
      adapter.insertLogIndexEvent({
        timestamp: "2026-07-04T10:02:00.000Z",
        category: "app",
        event: "ctx.log",
        level: "info",
        message: "proof log",
        capsule: { name: "service-backed-spike" },
      });
      assert.deepEqual(
        adapter.readRecentLogEvents(1).map((event) => event.message),
        ["proof log"],
      );

      await assert.rejects(
        adapter.withTransaction(async () => {
          adapter.insertAppRow(notesTable, {
            id: "note-rolled-back",
            createdAt: now,
            updatedAt: now,
            text: "rolled back",
            ownerId: "user-1",
            done: 0,
          });
          throw new Error("rollback proof");
        }),
        /rollback proof/,
      );
      assert.equal(adapter.selectAppRowById(notesTable, "note-rolled-back"), null);

      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "notes"), ["notes"]);
      assert.equal((await dumpDatabase(database)).find((table) => table.name === "notes").rows.length, 1);
      assert.deepEqual((await runReadOnlyQuery(database, "SELECT text FROM notes")).data.rows, [{ text: "prove app table path" }]);
    } finally {
      adapter.close();
    }
  });
});
