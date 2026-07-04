import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, runMutation, SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { mutation, query, String, table } from "../dist/server.js";

const createEndpointDatabaseApi = SERVER_RUNTIME_SOURCE_FUNCTIONS.find(
  (fn) => fn.name === "createEndpointDatabaseApi",
);
const runQuery = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runQuery");

function auth(userId) {
  return {
    userId,
    displayName: userId,
    email: null,
    picture: null,
    isAuthenticated: false,
    isGuest: true,
    provider: "anonymous",
  };
}

function isPromiseLike(value) {
  return value && typeof value === "object" && typeof value.then === "function";
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-acl-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openCapsuleDatabase(dir, capsuleDefinition) {
  return openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "acl-test" }, capsuleDefinition);
}

test("table definitions can declare sync and async ACL rules", async () => {
  await withTempDir(async (dir) => {
    const read = ({ row, ctx }) => row.ownerId === ctx.auth.userId;
    const write = async ({ next, ctx }) => next.ownerId === ctx.auth.userId;
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({ read, write }),
      },
    });

    try {
      assert.equal(database.schema.tables[0].acl.read, read);
      assert.equal(database.schema.tables[0].acl.write, write);
      assert.equal(await database.schema.tables[0].acl.write({ next: { ownerId: "u1" }, ctx: { auth: { userId: "u1" } } }), true);
    } finally {
      database.close();
    }
  });
});

test("write ACL is the fallback for insert, update, and delete unless operation-specific rules exist", async () => {
  await withTempDir(async (dir) => {
    const write = () => "write";
    const insert = () => "insert";
    const deleteRule = () => "delete";
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
        }).acl({ write, insert, delete: deleteRule }),
      },
    });

    try {
      const acl = database.schema.tables[0].acl;
      assert.equal(acl.resolve("insert"), insert);
      assert.equal(acl.resolve("update"), write);
      assert.equal(acl.resolve("delete"), deleteRule);
      assert.equal(acl.resolve("read"), undefined);
    } finally {
      database.close();
    }
  });
});

test("missing ACL rules allow operations by default", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
        }),
      },
    });

    try {
      const acl = database.schema.tables[0].acl;
      assert.equal(acl.resolve("read"), undefined);
      assert.equal(acl.resolve("insert"), undefined);
      assert.equal(acl.allowByDefault, true);
    } finally {
      database.close();
    }
  });
});

test("invalid ACL declarations fail with structured Capsule errors", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () =>
        openCapsuleDatabase(dir, {
          schema: {
            notes: table({
              title: String(),
            }).acl({ read: true }),
          },
        }),
      (error) => {
        assert.equal(error.message, "Invalid Capsule table ACL: notes.read");
        assert.equal(error.hint, "ACL rules must be functions for read, write, insert, update, and delete.");
        return true;
      },
    );

    await assert.rejects(
      () =>
        openCapsuleDatabase(dir, {
          schema: {
            notes: table({
              title: String(),
            }).acl({ publish: () => true }),
          },
        }),
      (error) => {
        assert.equal(error.message, "Unsupported Capsule table ACL operation: notes.publish");
        assert.equal(error.hint, "Supported ACL operations are read, write, insert, update, and delete.");
        return true;
      },
    );
  });
});

test("read ACL filters multi-row query results without exposing denied rows", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({
          read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.orderBy("title").all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "Mine", ownerId: "u1" });
      db.notes.insert({ title: "Theirs", ownerId: "u2" });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Mine"],
      );
      assert.equal(result.data.some((row) => row.title === "Theirs"), false);
    } finally {
      database.close();
    }
  });
});

test("tables without read ACLs preserve open read behavior", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.orderBy("title").all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "Mine", ownerId: "u1" });
      db.notes.insert({ title: "Theirs", ownerId: "u2" });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Mine", "Theirs"],
      );
    } finally {
      database.close();
    }
  });
});

test("read ACL filters single-row table API reads", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({
          read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
        }),
      },
      queries: {
        mine: query((ctx) => ctx.db.notes.where("title", "Mine").get()),
        theirs: query((ctx) => ctx.db.notes.where("title", "Theirs").get()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "Mine", ownerId: "u1" });
      db.notes.insert({ title: "Theirs", ownerId: "u2" });

      const allowed = await runQuery(database, auth("u1"), "mine");
      const denied = await runQuery(database, auth("u1"), "theirs");

      assert.equal(allowed.error, null);
      assert.equal(allowed.data.title, "Mine");
      assert.equal(denied.error, null);
      assert.equal(denied.data, null);
    } finally {
      database.close();
    }
  });
});

test("async read ACL rules are awaited before returning query results", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({
          read: async ({ row, ctx }) => {
            await Promise.resolve();
            return row.ownerId === ctx.auth.userId;
          },
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.orderBy("title").all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "Mine", ownerId: "u1" });
      db.notes.insert({ title: "Theirs", ownerId: "u2" });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Mine"],
      );
    } finally {
      database.close();
    }
  });
});

test("write ACLs receive insert, update, and delete row state inside mutations", async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({
          insert: ({ previous, next, ctx }) => {
            calls.push({ operation: "insert", previous, next, userId: ctx.auth.userId });
            return true;
          },
          update: ({ previous, next, ctx }) => {
            calls.push({ operation: "update", previous, next, userId: ctx.auth.userId });
            return true;
          },
          delete: ({ previous, next, ctx }) => {
            calls.push({ operation: "delete", previous, next, userId: ctx.auth.userId });
            return true;
          },
        }),
      },
      mutations: {
        addNote: mutation((ctx, title) => ctx.db.notes.insert({ title, ownerId: ctx.auth.userId })),
        renameNote: mutation((ctx, id, title) => ctx.db.notes.update(id, { title })),
        deleteNote: mutation((ctx, id) => ctx.db.notes.delete(id)),
      },
    });

    try {
      const inserted = await runMutation(database, auth("user-1"), "addNote", ["first"]);
      assert.equal(inserted.ok, true);
      const noteId = inserted.data.id;

      const updated = await runMutation(database, auth("user-1"), "renameNote", [noteId, "second"]);
      assert.equal(updated.ok, true);
      const deleted = await runMutation(database, auth("user-1"), "deleteNote", [noteId]);
      assert.equal(deleted.ok, true);

      assert.equal(calls.length, 3);
      assert.equal(calls[0].operation, "insert");
      assert.equal(calls[0].previous, null);
      assert.equal(calls[0].next.title, "first");
      assert.equal(calls[0].next.ownerId, "user-1");
      assert.equal(calls[0].userId, "user-1");

      assert.equal(calls[1].operation, "update");
      assert.equal(calls[1].previous.title, "first");
      assert.equal(calls[1].next.title, "second");
      assert.equal(calls[1].next.ownerId, "user-1");

      assert.equal(calls[2].operation, "delete");
      assert.equal(calls[2].previous.title, "second");
      assert.equal(calls[2].next, null);
    } finally {
      database.close();
    }
  });
});

test("denied write ACLs roll back mutation writes and skip after hooks", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          ownerId: String(),
        }).acl({
          insert: ({ next }) => next.title !== "blocked",
        }),
        auditLogs: table({
          title: String(),
          ownerId: String(),
        }),
      },
      mutations: {
        addTwoNotes: mutation((ctx, first, second) => {
          ctx.db.notes.insert({ title: first, ownerId: ctx.auth.userId });
          ctx.db.notes.insert({ title: second, ownerId: ctx.auth.userId });
        }),
      },
    });
    database.mutationHooks.afterMutation = [
      `({ ctx }) => {
        ctx.db.auditLogs.insert({ title: "after-hook", ownerId: ctx.auth.userId });
      }`,
    ];

    try {
      const result = await runMutation(database, auth("user-1"), "addTwoNotes", ["allowed", "blocked"]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.error, {
        code: "DENIED",
        message: "Denied.",
        hint: "The current user is not allowed to perform this operation.",
      });

      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[0], {}).map((row) => ({ title: row.title })), []);
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[1], {}).map((row) => ({ title: row.title })), []);
    } finally {
      database.close();
    }
  });
});

test("async ACL writes from after hooks are awaited before commit and can roll back the mutation", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        todos: table({
          title: String(),
          ownerId: String(),
        }),
        auditLogs: table({
          title: String(),
          ownerId: String(),
        }).acl({
          insert: async ({ next }) => {
            await Promise.resolve();
            return next.title !== "deny";
          },
        }),
      },
      mutations: {
        addTodo: mutation((ctx, title) => {
          ctx.db.todos.insert({ title, ownerId: ctx.auth.userId });
        }),
      },
    });
    database.mutationHooks.afterMutation = [
      `({ args, ctx }) => {
        ctx.db.auditLogs.insert({ title: args[0], ownerId: ctx.auth.userId });
      }`,
    ];

    try {
      const allowed = await runMutation(database, auth("user-1"), "addTodo", ["allow"]);
      assert.equal(allowed.ok, true);
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[0], {}).map((row) => ({ title: row.title })), [
        { title: "allow" },
      ]);
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[1], {}).map((row) => ({ title: row.title })), [
        { title: "allow" },
      ]);

      const denied = await runMutation(database, auth("user-1"), "addTodo", ["deny"]);
      assert.equal(denied.ok, false);
      assert.deepEqual(denied.error, {
        code: "DENIED",
        message: "Denied.",
        hint: "The current user is not allowed to perform this operation.",
      });
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[0], {}).map((row) => ({ title: row.title })), [
        { title: "allow" },
      ]);
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[1], {}).map((row) => ({ title: row.title })), [
        { title: "allow" },
      ]);
    } finally {
      database.close();
    }
  });
});

test("denied ACL writes return opaque errors and emit structured redacted diagnosis logs", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          passwordSecret: String(),
          ownerId: String(),
        }).acl({
          update: ({ next }) => next.title !== "locked",
        }),
      },
      mutations: {
        addNote: mutation((ctx, title, passwordSecret) =>
          ctx.db.notes.insert({ title, passwordSecret, ownerId: ctx.auth.userId }),
        ),
        renameNote: mutation((ctx, id, title) => ctx.db.notes.update(id, { title })),
      },
    });

    try {
      const inserted = await runMutation(database, auth("user-1"), "addNote", ["draft", "raw-super-secret"]);
      assert.equal(inserted.ok, true);

      const denied = await runMutation(database, auth("user-1"), "renameNote", [inserted.data.id, "locked"]);

      assert.equal(denied.ok, false);
      assert.deepEqual(denied.error, {
        code: "DENIED",
        message: "Denied.",
        hint: "The current user is not allowed to perform this operation.",
      });

      const [entry] = database.log.recent(10).filter((candidate) => candidate.event === "acl.denied");
      assert.equal(entry.category, "platform");
      assert.equal(entry.level, "warn");
      assert.equal(entry.data.resource.kind, "table");
      assert.equal(entry.data.resource.name, "notes");
      assert.equal(entry.data.operation, "update");
      assert.deepEqual(entry.data.rule, {
        category: "table",
        declaredOperation: "update",
      });
      assert.deepEqual(entry.data.actor, {
        userId: "user-1",
        provider: "anonymous",
        isAuthenticated: false,
        isGuest: true,
      });
      assert.equal(entry.data.row.previousId, inserted.data.id);
      assert.equal(entry.data.row.nextId, inserted.data.id);
      assert.deepEqual(entry.data.row.changedFields, ["title"]);
      assert.equal(entry.data.row.previousFields.includes("title"), true);
      assert.equal(entry.data.row.previousFields.includes("passwordSecret"), false);
      assert.equal(JSON.stringify(entry).includes("raw-super-secret"), false);
    } finally {
      database.close();
    }
  });
});

test("denied ACL reads emit structured diagnosis logs without exposing filtered rows to queries", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
          secretToken: String(),
          ownerId: String(),
        }).acl({
          read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.orderBy("title").all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "Mine", secretToken: "mine-token", ownerId: "u1" });
      const theirs = db.notes.insert({ title: "Theirs", secretToken: "theirs-token", ownerId: "u2" });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Mine"],
      );
      const [entry] = database.log.recent(10).filter((candidate) => candidate.event === "acl.denied");
      assert.equal(entry.data.resource.name, "notes");
      assert.equal(entry.data.operation, "read");
      assert.deepEqual(entry.data.rule, {
        category: "table",
        declaredOperation: "read",
      });
      assert.equal(entry.data.row.id, theirs.id);
      assert.equal(entry.data.row.fields.includes("title"), true);
      assert.equal(entry.data.row.fields.includes("secretToken"), false);
      assert.equal(JSON.stringify(entry).includes("theirs-token"), false);
    } finally {
      database.close();
    }
  });
});

test("ACL user guide documents policy behavior and storage helper boundaries", async () => {
  const guide = await readFile(new URL("../docs/user-guide.md", import.meta.url), "utf8");

  assert.match(guide, /invisible accept\/reject authorization policy/);
  assert.match(guide, /Missing rules allow the\s+operation by default/);
  assert.match(guide, /`write` is the fallback for `insert`, `update`,\s+and `delete`/);
  assert.match(guide, /Read ACLs filter rows after fetch/);
  assert.match(guide, /insert receives `previous = null`/);
  assert.match(guide, /resolved by File ID or absolute File path/);
  assert.match(guide, /do not\s+expose filesystem paths, object keys, Object buckets, runtime table names, or\s+generated read URLs/);
  assert.match(guide, /`sporades doctor` may later warn about missing ACLs or\s+open-to-the-world data/);
});

test("write ACL fallback, operation-specific override, missing ACL, and async rules apply to writes", async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const database = await openCapsuleDatabase(dir, {
      schema: {
        documents: table({
          title: String(),
          ownerId: String(),
        }).acl({
          write: ({ previous, next }) => {
            calls.push({ rule: "write", previous, next });
            return next?.ownerId === "user-1" || previous?.ownerId === "user-1";
          },
          update: async ({ previous, next }) => {
            await Promise.resolve();
            calls.push({ rule: "update", previous, next });
            return next.title !== "locked";
          },
        }),
        openLogs: table({
          title: String(),
        }),
      },
      mutations: {
        addDocument: mutation((ctx, title, ownerId) => ctx.db.documents.insert({ title, ownerId })),
        renameDocument: mutation(async (ctx, id, title) => ctx.db.documents.update(id, { title })),
        deleteDocument: mutation((ctx, id) => ctx.db.documents.delete(id)),
        addOpenLog: mutation((ctx, title) => ctx.db.openLogs.insert({ title })),
      },
    });

    try {
      const inserted = await runMutation(database, auth("user-1"), "addDocument", ["draft", "user-1"]);
      assert.equal(inserted.ok, true);
      assert.equal(calls[0].rule, "write");
      assert.equal(calls[0].previous, null);

      const deniedUpdate = await runMutation(database, auth("user-1"), "renameDocument", [inserted.data.id, "locked"]);
      assert.equal(deniedUpdate.ok, false);
      assert.equal(calls[1].rule, "update");
      assert.equal(calls[1].previous.title, "draft");
      assert.equal(calls[1].next.title, "locked");
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[0], {}).map((row) => ({ title: row.title })), [
        { title: "draft" },
      ]);

      const deleted = await runMutation(database, auth("user-1"), "deleteDocument", [inserted.data.id]);
      assert.equal(deleted.ok, true);
      assert.equal(calls[2].rule, "write");
      assert.equal(calls[2].previous.title, "draft");
      assert.equal(calls[2].next, null);

      const open = await runMutation(database, auth("user-1"), "addOpenLog", ["open"]);
      assert.equal(open.ok, true);
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[1], {}).map((row) => ({ title: row.title })), [
        { title: "open" },
      ]);
    } finally {
      database.close();
    }
  });
});

test("generated insert and update mutations apply write ACLs", async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const database = await openCapsuleDatabase(dir, {
      schema: {
        todos: table({
          text: String(),
          ownerId: String(),
        }).acl({
          write: ({ operation, previous, next }) => {
            calls.push({ operation, previous, next });
            return next?.text !== "blocked";
          },
        }),
      },
    });

    try {
      const inserted = await runMutation(database, auth("user-1"), "addTodo", ["first"]);
      assert.equal(inserted.ok, true);
      assert.equal(calls[0].operation, "insert");
      assert.equal(calls[0].previous, null);
      assert.equal(calls[0].next.text, "first");
      assert.equal(calls[0].next.ownerId, "user-1");

      const [{ id }] = database.sqlite.selectAppRows(database.schema.tables[0], {});
      const deniedUpdate = await runMutation(database, auth("user-1"), "updateTodoText", [id, "blocked"]);
      assert.equal(deniedUpdate.ok, false);
      assert.equal(calls[1].operation, "update");
      assert.equal(calls[1].previous.text, "first");
      assert.equal(calls[1].next.text, "blocked");
      assert.deepEqual(database.sqlite.selectAppRows(database.schema.tables[0], {}).map((row) => ({ text: row.text })), [
        { text: "first" },
      ]);
    } finally {
      database.close();
    }
  });
});

test("ACL db helpers can inspect app tables by stable table name", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        projects: table({
          name: String(),
          ownerId: String(),
        }),
        notes: table({
          title: String(),
          projectId: String(),
        }).acl({
          read: ({ row, ctx }) => {
            const project = ctx.acl.db.get("projects", row.projectId);
            return project?.ownerId === ctx.auth.userId;
          },
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.orderBy("title").all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      const mine = db.projects.insert({ name: "Mine", ownerId: "u1" });
      const theirs = db.projects.insert({ name: "Theirs", ownerId: "u2" });
      db.notes.insert({ title: "Mine", projectId: mine.id });
      db.notes.insert({ title: "Theirs", projectId: theirs.id });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Mine"],
      );
    } finally {
      database.close();
    }
  });
});

test("ACL helpers expose async db exists checks and do not recursively evaluate read ACLs", async () => {
  await withTempDir(async (dir) => {
    let projectAclCalls = 0;
    const database = await openCapsuleDatabase(dir, {
      schema: {
        projects: table({
          name: String(),
          ownerId: String(),
        }).acl({
          read: () => {
            projectAclCalls += 1;
            return false;
          },
        }),
        notes: table({
          title: String(),
          projectId: String(),
        }).acl({
          read: async ({ row, ctx }) => {
            await Promise.resolve();
            return ctx.acl.db.exists("projects", row.projectId);
          },
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      const project = db.projects.insert({ name: "Hidden", ownerId: "u2" });
      db.notes.insert({ title: "Allowed by helper", projectId: project.id });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Allowed by helper"],
      );
      assert.equal(projectAclCalls, 0);
    } finally {
      database.close();
    }
  });
});

test("ACL storage helpers expose live files by File ID and absolute File path", async () => {
  await withTempDir(async (dir) => {
    const seenFiles = new Map();
    const seenExists = new Map();
    const database = await openCapsuleDatabase(dir, {
      schema: {
        attachments: table({
          title: String(),
          fileRef: String(),
        }).acl({
          read: ({ row, ctx }) => {
            const file = ctx.acl.storage.get("files", row.fileRef);
            const exists = ctx.acl.storage.exists("files", row.fileRef);
            seenFiles.set(row.title, file);
            seenExists.set(row.title, exists);
            return (
              exists &&
              file?.ownerId === ctx.auth.userId &&
              file?.path.startsWith("/teams/u1/")
            );
          },
        }),
      },
      queries: {
        attachments: query((ctx) => ctx.db.attachments.all()),
      },
    });

    try {
      database.sqlite.insertFileRow({
        id: "file-1",
        ownerId: "u1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/teams/u1/reports/report.txt",
        name: "report.txt",
        type: "text/plain",
        size: 12,
        version: "version-1",
        status: "uploaded",
        createdAt: "2026-07-04T10:00:00.000Z",
        updatedAt: "2026-07-04T10:00:00.000Z",
      });
      database.sqlite.insertFileRow({
        id: "file-2",
        ownerId: "u1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/teams/u1/reports/annual.txt",
        name: "annual.txt",
        type: "text/plain",
        size: 13,
        version: "version-2",
        status: "uploaded",
        createdAt: "2026-07-04T10:01:00.000Z",
        updatedAt: "2026-07-04T10:01:00.000Z",
      });
      database.sqlite.insertFileRow({
        id: "file-3",
        ownerId: "u1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/teams/u1/images/2026/07/profile.png",
        name: "profile.png",
        type: "image/png",
        size: 14,
        version: "version-3",
        status: "uploaded",
        createdAt: "2026-07-04T10:02:00.000Z",
        updatedAt: "2026-07-04T10:02:00.000Z",
      });
      database.sqlite.insertFileRow({
        id: "file-deleted",
        ownerId: "u1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/teams/u1/reports/deleted.txt",
        name: "deleted.txt",
        type: "text/plain",
        size: 15,
        version: "version-deleted",
        status: "uploaded",
        createdAt: "2026-07-04T10:03:00.000Z",
        updatedAt: "2026-07-04T10:03:00.000Z",
      });
      database.sqlite.markFileDeleted("file-deleted", "2026-07-04T10:04:00.000Z");
      database.sqlite.insertFileRow({
        id: "file-pending",
        ownerId: "u1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/teams/u1/reports/pending.txt",
        name: "pending.txt",
        type: "text/plain",
        size: 16,
        version: "version-pending",
        status: "pending",
        createdAt: "2026-07-04T10:05:00.000Z",
        updatedAt: "2026-07-04T10:05:00.000Z",
      });
      database.sqlite.insertFileRow({
        id: "file-other",
        ownerId: "u2",
        bucketId: "bucket-2",
        bucketName: "default",
        path: "/teams/u2/private.txt",
        name: "private.txt",
        type: "text/plain",
        size: 17,
        version: "version-other",
        status: "uploaded",
        createdAt: "2026-07-04T10:06:00.000Z",
        updatedAt: "2026-07-04T10:06:00.000Z",
      });
      const selectLiveFileByPath = database.sqlite.selectLiveFileByPath.bind(database.sqlite);
      database.sqlite.selectLiveFileByPath = (filePath) => {
        if (filePath === "/teams/u1/ambiguous.txt") {
          return [database.sqlite.selectFileById("file-1"), database.sqlite.selectFileById("file-2")];
        }
        return selectLiveFileByPath(filePath);
      };

      const db = createEndpointDatabaseApi(database);
      db.attachments.insert({ title: "Allowed by ID", fileRef: "file-1" });
      db.attachments.insert({ title: "Allowed by path", fileRef: "/teams/u1/reports/annual.txt" });
      db.attachments.insert({ title: "Allowed slash path", fileRef: "/teams/u1/images/2026/07/profile.png" });
      db.attachments.insert({ title: "Deleted by ID", fileRef: "file-deleted" });
      db.attachments.insert({ title: "Deleted by path", fileRef: "/teams/u1/reports/deleted.txt" });
      db.attachments.insert({ title: "Pending by ID", fileRef: "file-pending" });
      db.attachments.insert({ title: "Missing by path", fileRef: "/teams/u1/reports/missing.txt" });
      db.attachments.insert({ title: "Other owner", fileRef: "/teams/u2/private.txt" });
      db.attachments.insert({ title: "Ambiguous path", fileRef: "/teams/u1/ambiguous.txt" });

      const result = await runQuery(database, auth("u1"), "attachments");

      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["Allowed by ID", "Allowed by path", "Allowed slash path"],
      );
      assert.deepEqual(seenFiles.get("Allowed by path"), {
        id: "file-2",
        bucket: "default",
        size: 13,
        type: "text/plain",
        name: "annual.txt",
        path: "/teams/u1/reports/annual.txt",
        version: "version-2",
        originalName: "annual.txt",
        owner: "u1",
        ownerId: "u1",
        status: "uploaded",
        createdAt: "2026-07-04T10:01:00.000Z",
        updatedAt: "2026-07-04T10:01:00.000Z",
        deletedAt: null,
      });
      assert.equal(isPromiseLike(seenFiles.get("Allowed by ID")), false);
      assert.equal(isPromiseLike(seenExists.get("Allowed by ID")), false);
      assert.equal(seenExists.get("Allowed by ID"), true);
      assert.equal(seenExists.get("Deleted by ID"), false);
      assert.equal(seenFiles.get("Deleted by ID"), null);
      assert.equal(seenFiles.get("Deleted by path"), null);
      assert.equal(seenFiles.get("Pending by ID"), null);
      assert.equal(seenFiles.get("Missing by path"), null);
      assert.equal(seenFiles.get("Ambiguous path"), null);
      assert.deepEqual(
        Object.keys(seenFiles.get("Allowed by ID")).sort(),
        [
          "bucket",
          "createdAt",
          "deletedAt",
          "id",
          "name",
          "originalName",
          "owner",
          "ownerId",
          "path",
          "size",
          "status",
          "type",
          "updatedAt",
          "version",
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("ACL storage helpers fail closed when sync rules touch async file lookups", async () => {
  await withTempDir(async (dir) => {
    const observedExists = [];
    const database = await openCapsuleDatabase(dir, {
      schema: {
        attachments: table({
          title: String(),
          fileRef: String(),
          ownerId: String(),
        }).acl({
          read: ({ row, ctx }) => {
            const exists = ctx.acl.storage.exists("files", row.fileRef);
            observedExists.push(exists);
            return exists && row.ownerId === ctx.auth.userId;
          },
        }),
      },
      queries: {
        attachments: query((ctx) => ctx.db.attachments.all()),
      },
    });

    try {
      database.sqlite.selectFileById = async () => null;

      const db = createEndpointDatabaseApi(database);
      db.attachments.insert({ title: "Missing async file", fileRef: "missing-file", ownerId: "u1" });

      const result = await runQuery(database, auth("u1"), "attachments");

      assert.equal(result.error, null);
      assert.deepEqual(result.data, []);
      assert.equal(observedExists.some(isPromiseLike), true);
    } finally {
      database.close();
    }
  });
});

test("ACL helpers block runtime table names and guard helper read count", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, {
      schema: {
        notes: table({
          title: String(),
        }).acl({
          read: ({ ctx }) => {
            assert.throws(() => ctx.acl.db.get("sporades", "schema"), /Unknown ACL database resource/);
            assert.throws(() => ctx.acl.db.exists("sporades_auth_users", "u1"), /Unknown ACL database resource/);
            assert.throws(() => ctx.acl.db.exists("sporades_log_events", "event-1"), /Unknown ACL database resource/);
            assert.throws(() => ctx.acl.storage.get("sporades_files", "file-1"), /Unknown ACL storage resource/);
            for (let index = 0; index < 33; index += 1) {
              ctx.acl.db.exists("notes", "missing");
            }
            return true;
          },
        }),
      },
      queries: {
        notes: query((ctx) => ctx.db.notes.all()),
      },
    });

    try {
      const db = createEndpointDatabaseApi(database);
      db.notes.insert({ title: "first" });

      const result = await runQuery(database, auth("u1"), "notes");

      assert.equal(result.error.message, "ACL helper read limit exceeded.");
      assert.equal(result.error.hint, "Keep ACL policies bounded; each rule may perform at most 32 helper reads.");
    } finally {
      database.close();
    }
  });
});
