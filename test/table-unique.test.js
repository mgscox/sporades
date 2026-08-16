import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, table } from "../dist/server.js";
import { openDevDatabase } from "../dist/server-runtime-source.js";

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
