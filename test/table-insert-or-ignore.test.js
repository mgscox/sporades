import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, table } from "../dist/server.js";
import { createEndpointDatabaseApi, openDevDatabase } from "../dist/server-runtime-source.js";

test("insertOrIgnore inserts a declared singleton once and returns null only for its named conflict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-insert-or-ignore-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "insert-or-ignore-test" }, {
      schema: { subscriptions: table({ teamId: String(), externalId: String() }).unique("teamId").unique("externalId") },
    });
    try {
      const subscriptions = createEndpointDatabaseApi(database).subscriptions;
      const first = await subscriptions.insertOrIgnore({ teamId: "team-a", externalId: "external-a" }, "teamId");
      assert.equal(first.teamId, "team-a");

      assert.equal(await subscriptions.insertOrIgnore({ teamId: "team-a", externalId: "external-b" }, "teamId"), null);
      await assert.rejects(
        async () => subscriptions.insertOrIgnore({ teamId: "team-b", externalId: "external-a" }, "teamId"),
        /unique constraint|duplicate key|constraint failed/i,
      );
      await assert.rejects(
        async () => subscriptions.insertOrIgnore({ teamId: "team-c", externalId: "external-c" }, "externalId", "teamId"),
        /declared unique constraint/i,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
