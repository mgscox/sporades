import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../src/server-runtime-source.js";
import { query, String, table } from "../src/server.js";

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
