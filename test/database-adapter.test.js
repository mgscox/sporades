import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkRuntimeSqlite,
  createPendingFileUpload,
  createSqliteDatabaseAdapter,
  dumpDatabase,
  listDatabaseTables,
  openDevDatabase,
  resolveAnonymousSession,
  runMutation,
  runReadOnlyQuery,
  signUpWithEmail,
} from "../src/server-runtime-source.js";

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

    assert.equal(database.adapter, database.sqlite);
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

test("SQLite database adapter owns app schema metadata, migrations, references, queries, and mutations", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      const usersTable = {
        name: "users",
        fields: [
          { name: "name", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      const postsTable = {
        name: "posts",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "authorId", kind: "Reference", sqliteType: "TEXT", targetTable: "users" },
          { name: "published", kind: "Boolean", sqliteType: "INTEGER", defaultValue: false },
        ],
      };

      adapter.ensureSystemTable();
      adapter.migrateAppSchema({ tables: [usersTable, postsTable] });

      const schemaMetadata = adapter.readSchemaMetadata();
      assert.match(schemaMetadata.value, /"posts"/);
      assert.deepEqual(
        adapter.prepare("PRAGMA table_info(posts)").all().map((column) => column.name),
        ["id", "createdAt", "updatedAt", "text", "authorId", "published"],
      );

      const now = "2026-07-04T10:00:00.000Z";
      adapter.insertAppRow(usersTable, {
        id: "user-1",
        createdAt: now,
        updatedAt: now,
        name: "Ada",
        ownerId: "owner-1",
      });
      assert.equal(adapter.referenceExists({ targetTable: "users" }, "user-1"), true);
      assert.equal(adapter.referenceExists({ targetTable: "users" }, "missing"), false);

      adapter.insertAppRow(postsTable, {
        id: "post-1",
        createdAt: now,
        updatedAt: now,
        text: "First",
        authorId: "user-1",
        published: 0,
      });
      adapter.updateAppRow(postsTable, "post-1", {
        text: "Updated",
        published: 1,
        updatedAt: "2026-07-04T11:00:00.000Z",
      });

      assert.deepEqual(
        adapter
          .selectAppRows(postsTable, {
            columns: ["id", "text", "published"],
            where: { fieldName: "authorId", value: "user-1" },
            orderBy: { fieldName: "createdAt", direction: "desc" },
            limit: 1,
          })
          .map((row) => ({ ...row })),
        [{ id: "post-1", text: "Updated", published: 1 }],
      );
      assert.equal(adapter.selectAppRowById(postsTable, "post-1").text, "Updated");
      assert.equal(adapter.deleteAppRow(postsTable, "missing").changes, 0);

      const migratedPostsTable = {
        ...postsTable,
        fields: [
          ...postsTable.fields,
          { name: "editorId", kind: "Reference", sqliteType: "TEXT", targetTable: "users", defaultValue: "user-1" },
          { name: "summary", kind: "String", sqliteType: "TEXT", defaultValue: "draft" },
        ],
      };
      adapter.migrateAppSchema({ tables: [usersTable, migratedPostsTable] });

      assert.deepEqual(
        adapter.prepare("PRAGMA table_info(posts)").all().map((column) => column.name),
        ["id", "createdAt", "updatedAt", "text", "authorId", "published", "editorId", "summary"],
      );
      assert.deepEqual(
        adapter
          .selectAppRows(migratedPostsTable, { columns: ["text", "editorId", "summary"] })
          .map((row) => ({ ...row })),
        [{ text: "Updated", editorId: "user-1", summary: "draft" }],
      );
      assert.equal(adapter.deleteAppRow(migratedPostsTable, "post-1").changes, 1);
      assert.deepEqual(adapter.selectAppRows(migratedPostsTable), []);

      assert.throws(
        () =>
          adapter.migrateAppSchema({
            tables: [
              usersTable,
              {
                ...migratedPostsTable,
                fields: migratedPostsTable.fields.filter((field) => field.name !== "summary"),
              },
            ],
          }),
        {
          message: "Unsupported Capsule schema change.",
          hint: "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        },
      );
      assert.throws(
        () =>
          adapter.migrateAppSchema({
            tables: [
              usersTable,
              {
                ...migratedPostsTable,
                fields: [
                  ...migratedPostsTable.fields,
                  {
                    name: "reviewerId",
                    kind: "Reference",
                    sqliteType: "TEXT",
                    targetTable: "users",
                    defaultValue: "missing",
                  },
                ],
              },
            ],
          }),
        {
          message: "Invalid reference for field: reviewerId",
          hint: "Pass the id of an existing users row.",
        },
      );
    } finally {
      adapter.close();
    }
  });
});

test("SQLite database adapter owns runtime storage for auth, files, logs, and system metadata", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      adapter.ensureSystemTable();
      adapter.writeSystemMetadata("runtimeKey", "runtime-value");
      assert.deepEqual({ ...adapter.readSystemMetadata("runtimeKey") }, { value: "runtime-value" });

      adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
      const now = "2026-07-04T10:00:00.000Z";
      adapter.insertAuthUser({
        id: "user-1",
        createdAt: now,
        displayName: "Anonymous",
        email: null,
        picture: null,
        isAuthenticated: 0,
        isGuest: 1,
        provider: "anonymous",
      });
      adapter.insertAuthSession({
        token: "session-1",
        userId: "user-1",
        createdAt: now,
        expiresAt: "2026-08-03T10:00:00.000Z",
      });
      assert.equal(adapter.readAuthSessionWithUser("session-1").provider, "anonymous");

      adapter.insertEmailCredential({
        email: "mira@example.com",
        userId: "user-1",
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: now,
      });
      assert.equal(adapter.emailCredentialExists("mira@example.com"), true);
      adapter.linkAuthUser({
        id: "user-1",
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "email",
      });
      assert.equal(adapter.findEmailCredentialWithUser("mira@example.com").displayName, "Mira");
      adapter.rotateAuthSession("session-1", {
        token: "session-2",
        userId: "user-1",
        createdAt: "2026-07-04T11:00:00.000Z",
        expiresAt: "2026-08-03T11:00:00.000Z",
      });
      assert.equal(adapter.readAuthSessionWithUser("session-1"), null);
      assert.equal(adapter.readAuthSessionWithUser("session-2").token, "session-2");
      adapter.insertOAuthState({
        state: "oauth-state",
        sessionToken: "session-2",
        returnTo: "http://127.0.0.1:4000/after",
        redirectUri: "http://127.0.0.1:4000/__sporades/auth/google/callback",
        createdAt: now,
      });
      assert.equal(adapter.consumeOAuthState("oauth-state").sessionToken, "session-2");
      assert.equal(adapter.consumeOAuthState("oauth-state"), null);

      adapter.ensureFileStorage();
      adapter.createFileBucket({ id: "bucket-1", ownerId: "user-1", name: "default", createdAt: now });
      assert.equal(adapter.findFileBucket("user-1", "default").id, "bucket-1");
      adapter.insertFileRow({
        id: "file-1",
        ownerId: "user-1",
        bucketId: "bucket-1",
        bucketName: "default",
        name: "hello.txt",
        type: "text/plain",
        size: 5,
        version: "version-1",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      adapter.insertFileUpload({
        id: "upload-1",
        fileId: "file-1",
        ownerId: "user-1",
        version: "version-1",
        expectedSize: 5,
        createdAt: now,
      });
      assert.equal(adapter.selectFileUpload("upload-1").fileId, "file-1");
      adapter.completeFileUpload(adapter.selectFileUpload("upload-1"), 5, "2026-07-04T10:01:00.000Z");
      adapter.deleteFileUpload("upload-1");
      assert.equal(adapter.selectFileUpload("upload-1"), null);
      assert.equal(adapter.fileRowForOwner("file-1", "user-1").status, "uploaded");
      adapter.insertPublicFileUrl({
        id: "public-1",
        fileId: "file-1",
        ownerId: "user-1",
        version: "version-1",
        expiresAt: null,
        createdAt: now,
      });
      assert.equal(adapter.selectPublicFileRow("public-1").publicVersion, "version-1");
      adapter.updatePendingFileRow({
        id: "file-1",
        name: "goodbye.txt",
        type: "text/plain",
        size: 7,
        version: "version-2",
        status: "pending",
        updatedAt: "2026-07-04T10:02:00.000Z",
      });
      adapter.revokePublicFileUrlsForFile("file-1", "2026-07-04T10:02:00.000Z");
      assert.equal(adapter.selectPublicFileRow("public-1").revokedAt, "2026-07-04T10:02:00.000Z");
      adapter.markFileDeleted("file-1", "2026-07-04T10:03:00.000Z");
      assert.equal(adapter.fileRowForOwner("file-1", "user-1"), null);

      adapter.ensureLogStorage();
      for (const index of [1, 2, 3]) {
        adapter.insertLogIndexEvent({
          timestamp: `2026-07-04T10:00:0${index}.000Z`,
          category: "app",
          event: "ctx.log",
          level: "info",
          message: `log-${index}`,
          capsule: { name: "adapter-island" },
          release: null,
          request: null,
          correlation: null,
        });
      }
      adapter.pruneLogIndex(2);
      assert.deepEqual(
        adapter.readRecentLogEvents(10).map((entry) => entry.message),
        ["log-2", "log-3"],
      );
    } finally {
      adapter.close();
    }
  });
});

test("SQLite database adapter owns transactions for successful and failing mutations", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    try {
      const table = {
        name: "todos",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      database.mutations = [
        {
          name: "addThenFail",
          handler: (ctx) => {
            ctx.db.todos.insert({ text: "rolled back", ownerId: ctx.auth.userId });
            throw new Error("nope");
          },
        },
      ];
      database.mutationHooks = { beforeMutation: [], afterMutation: [] };
      database.sqlite.migrateAppSchema(database.schema);

      const committed = await runMutation(database, { userId: "user-1" }, "addTodo", ["committed"]);
      assert.equal(committed.ok, true);
      assert.equal(database.sqlite.selectAppRows(table).length, 1);

      const failed = await runMutation(database, { userId: "user-1" }, "addThenFail", []);
      assert.deepEqual(failed, {
        ok: false,
        error: {
          message: "nope",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, { columns: ["text"], orderBy: { fieldName: "createdAt", direction: "asc" } })
          .map((row) => ({ ...row })),
        [{ text: "committed" }],
      );
    } finally {
      database.close();
    }
  });
});

test("SQLite database adapter owns inspection and health surfaces", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    try {
      const table = {
        name: "todos",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "todo-1",
        createdAt: "2026-07-04T10:00:00.000Z",
        updatedAt: "2026-07-04T10:00:00.000Z",
        text: "inspect me",
        ownerId: "user-1",
      });

      assert.equal(typeof database.sqlite.listInspectableTables, "function");
      assert.equal(typeof database.sqlite.dumpInspectableDatabase, "function");
      assert.equal(typeof database.sqlite.runReadOnlyInspectionQuery, "function");
      assert.equal(typeof database.sqlite.checkHealth, "function");
      assert.equal(database.adapter, database.sqlite);
      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "todos"), ["todos"]);
      const dumpedTodos = (await dumpDatabase(database)).find((dumpedTable) => dumpedTable.name === "todos");
      assert.deepEqual({ ...dumpedTodos, rows: dumpedTodos.rows.map((row) => ({ ...row })) }, {
        name: "todos",
        columns: ["id", "createdAt", "updatedAt", "text", "ownerId"],
        rows: [
          {
            id: "todo-1",
            createdAt: "2026-07-04T10:00:00.000Z",
            updatedAt: "2026-07-04T10:00:00.000Z",
            text: "inspect me",
            ownerId: "user-1",
          },
        ],
      });
      const queryResult = await runReadOnlyQuery(database, "SELECT text FROM todos");
      assert.deepEqual(
        {
          ...queryResult,
          data: {
            ...queryResult.data,
            rows: queryResult.data.rows.map((row) => ({ ...row })),
          },
        },
        {
          ok: true,
          data: {
            columns: ["text"],
            rows: [{ text: "inspect me" }],
          },
          error: null,
        },
      );
      assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
    } finally {
      database.close();
    }
  });
});

test("runtime database paths await promise-returning adapter operations", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
      files: { storagePath: path.join(dir, "files") },
    });
    const syncAdapter = database.sqlite;
    const asyncAdapter = wrapAsyncRuntimeAdapter(syncAdapter);
    database.adapter = asyncAdapter;
    database.sqlite = asyncAdapter;
    database.close = () => syncAdapter.close();

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      await database.sqlite.migrateAppSchema(database.schema);

      const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
      const inserted = await runMutation(database, auth, "addNote", ["await me"]);
      assert.equal(inserted.ok, true);
      assert.deepEqual(
        (await database.sqlite.selectAppRows(table, { columns: ["text"] })).map((row) => ({ ...row })),
        [{ text: "await me" }],
      );

      database.mutations = [
        {
          name: "addThenFail",
          handler: (ctx) => {
            ctx.db.notes.insert({ text: "rolled back", ownerId: ctx.auth.userId });
            throw new Error("rollback me");
          },
        },
      ];
      const failed = await runMutation(database, auth, "addThenFail", []);
      assert.equal(failed.ok, false);
      assert.deepEqual(
        (await database.sqlite.selectAppRows(table, { columns: ["text"], orderBy: { fieldName: "createdAt", direction: "asc" } })).map(
          (row) => ({ ...row }),
        ),
        [{ text: "await me" }],
      );

      const originalUpdateAppRow = asyncAdapter.updateAppRow.bind(asyncAdapter);
      let asyncUpdateSettled = false;
      asyncAdapter.updateAppRow = async (...args) => {
        if (args[1] === "missing-note") {
          await Promise.resolve();
          asyncUpdateSettled = true;
          throw new Error("async update exploded");
        }
        return await originalUpdateAppRow(...args);
      };
      const failedMissingUpdate = await runMutation(database, auth, "updateNoteText", ["missing-note", "should fail"]);
      assert.equal(asyncUpdateSettled, true);
      assert.deepEqual(failedMissingUpdate, {
        ok: false,
        error: {
          message: "async update exploded",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });

      const session = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, session, "email", {
        email: "ada@example.com",
        password: "correct horse",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      const upload = await createPendingFileUpload(database, signUp.auth, {
        file: { name: "proof.txt", type: "text/plain", size: 5 },
      });
      assert.equal(upload.ok, true);

      await database.log.emit({ category: "app", event: "ctx.log", level: "info", message: "async log" });
      assert.deepEqual(
        (await database.log.recent(1)).map((event) => event.message),
        ["async log"],
      );

      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "notes"), ["notes"]);
      assert.equal((await dumpDatabase(database)).find((dumpedTable) => dumpedTable.name === "notes").rows.length, 1);
      assert.deepEqual(
        (await runReadOnlyQuery(database, "SELECT text FROM notes")).data.rows.map((row) => ({ ...row })),
        [{ text: "await me" }],
      );
      assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
    } finally {
      database.close();
    }
  });
});

function wrapAsyncRuntimeAdapter(adapter) {
  const asyncMethods = new Set([
    "ensureSystemTable",
    "readSystemMetadata",
    "writeSystemMetadata",
    "readSchemaMetadata",
    "writeSchemaMetadata",
    "ensureLogStorage",
    "insertLogIndexEvent",
    "pruneLogIndex",
    "readRecentLogEvents",
    "ensureFileStorage",
    "findFileBucket",
    "createFileBucket",
    "insertFileRow",
    "updatePendingFileRow",
    "insertFileUpload",
    "selectFileById",
    "selectFileUpload",
    "completeFileUpload",
    "deleteFileUpload",
    "selectPublicFileRow",
    "insertPublicFileUrl",
    "revokePublicFileUrl",
    "revokePublicFileUrlsForFile",
    "markFileDeleted",
    "fileRowForOwner",
    "ensureAuthStorage",
    "findAuthUserByProviderEmail",
    "insertAuthUser",
    "updateAuthUserProfile",
    "linkAuthUser",
    "insertAuthSession",
    "deleteAuthSession",
    "refreshAuthSession",
    "rotateAuthSession",
    "readAuthSessionWithUser",
    "insertOAuthState",
    "consumeOAuthState",
    "emailCredentialExists",
    "insertEmailCredential",
    "findEmailCredentialWithUser",
    "migrateAppSchema",
    "referenceExists",
    "withTransaction",
    "insertAppRow",
    "selectAppRowById",
    "updateAppRow",
    "deleteAppRow",
    "selectAppRows",
    "listInspectableTables",
    "dumpInspectableDatabase",
    "runReadOnlyInspectionQuery",
    "checkHealth",
  ]);
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !asyncMethods.has(property) || typeof value !== "function") {
        return value;
      }
      return async (...args) => await value.apply(target, args);
    },
  });
}
