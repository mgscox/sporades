import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, table } from "../dist/server.js";
import { createSqliteDatabaseAdapter, openDevDatabase } from "../dist/server-runtime-source.js";

test("table definitions declare a single-field unique constraint", () => {
  const users = table({ email: String() }).unique("email");

  assert.deepEqual(users.uniqueConstraints, [["email"]]);
});

test("unique constraints survive ACL chaining in normalized Capsule schema metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  try {
    const acl = { read: () => true };
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "unique-test" }, {
      schema: {
        slugs: table({ teamId: String(), slug: String(), title: String() })
          .unique("teamId", "slug")
          .acl(acl)
          .unique("title"),
      },
    });
    try {
      assert.equal(database.schema.tables[0].acl.read, acl.read);
      assert.deepEqual(database.schema.tables[0].uniqueConstraints, [["teamId", "slug"], ["title"]]);
      const stored = JSON.parse((await database.adapter.readSchemaMetadata()).value);
      assert.deepEqual(stored.tables[0].uniqueConstraints, [["teamId", "slug"], ["title"]]);
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declared unique constraints reject duplicate ordinary inserts but permit SQL nulls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "unique-test" }, {
      schema: { users: table({ email: String(), teamId: String(), slug: String() }).unique("email").unique("teamId", "slug") },
    });
    try {
      const users = database.schema.tables[0];
      await database.adapter.insertAppRow(users, { id: "one", email: "one@example.test", teamId: "team", slug: "home", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" });
      assert.throws(
        () => database.adapter.insertAppRow(users, { id: "two", email: "one@example.test", teamId: "team", slug: "other", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" }),
        /unique constraint/i,
      );
      await database.adapter.insertAppRow(users, { id: "three", email: null, teamId: null, slug: "home", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" });
      await database.adapter.insertAppRow(users, { id: "four", email: null, teamId: null, slug: "home", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" });
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema validation rejects malformed, unknown, repeated, and permutation-duplicate unique declarations before migration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  try {
    for (const uniqueConstraints of [[[]], [["missing"]], [["email", "email"]], [["email", "teamId"], ["teamId", "email"]], "email"]) {
      await assert.rejects(
        () => openDevDatabase(path.join(dir, `${JSON.stringify(uniqueConstraints)}.db`), "", {}, { name: "unique-test" }, {
          schema: { users: { kind: "table", fields: { email: String(), teamId: String() }, uniqueConstraints } },
        }),
        /unique declaration/i,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalized unique metadata orders constraints by field set without reordering composite fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "unique-test" }, {
      schema: { users: table({ alpha: String(), beta: String(), gamma: String() }).unique("gamma").unique("beta", "alpha") },
    });
    try {
      assert.deepEqual(database.schema.tables[0].uniqueConstraints, [["beta", "alpha"], ["gamma"]]);
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing tables reject unique-constraint changes before migration can rebuild or copy them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  const initial = { tables: [{ name: "users", fields: [{ name: "email", kind: "String", sqliteType: "TEXT" }] }] };
  const addingUnique = { tables: [{ name: "users", fields: [{ name: "email", kind: "String", sqliteType: "TEXT" }], uniqueConstraints: [["email"]] }] };
  try {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      await adapter.ensureSystemTable();
      await adapter.migrateAppSchema(initial);
      await adapter.insertAppRow(initial.tables[0], { id: "kept", email: "kept@example.test", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" });
      const metadataBefore = (await adapter.readSchemaMetadata()).value;

      await assert.rejects(
        async () => adapter.migrateAppSchema(addingUnique),
        /Unsupported Capsule schema change/,
      );

      assert.equal((await adapter.readSchemaMetadata()).value, metadataBefore);
      assert.deepEqual((await adapter.selectAppRows(initial.tables[0])).map((row) => ({ ...row })), [{ id: "kept", email: "kept@example.test", createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" }]);
      assert.equal((await adapter.listInspectableTables()).includes("__sporades_migrating_users"), false);
    } finally {
      adapter.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing-table unique constraint removal, replacement, and composite-field reordering stay deferred", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-table-unique-"));
  const initial = { tables: [{ name: "users", fields: [{ name: "email", kind: "String", sqliteType: "TEXT" }, { name: "teamId", kind: "String", sqliteType: "TEXT" }], uniqueConstraints: [["email", "teamId"]] }] };
  const changes = [
    [],
    [["email"]],
    [["teamId", "email"]],
  ];
  try {
    for (const uniqueConstraints of changes) {
      const adapter = await createSqliteDatabaseAdapter(path.join(dir, `${JSON.stringify(uniqueConstraints)}.db`));
      try {
        await adapter.ensureSystemTable();
        await adapter.migrateAppSchema(initial);
        await assert.rejects(
          async () => adapter.migrateAppSchema({ tables: [{ ...initial.tables[0], uniqueConstraints }] }),
          /Unsupported Capsule schema change/,
        );
      } finally {
        adapter.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
