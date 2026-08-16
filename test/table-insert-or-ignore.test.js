import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, mutation, table } from "../dist/server.js";
import { createEndpointDatabaseApi, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";

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

test("concurrent Postgres mutation bootstraps insert one singleton and the loser rereads it", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres mutation integration test.",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-insert-or-ignore-postgres-"));
  const teamId = `team-${randomUUID()}`;
  const appTableName = "ticket04_postgres_idempotent_subscriptions";
  const definition = {
    schema: { [appTableName]: table({ teamId: String(), plan: String() }).unique("teamId") },
    mutations: {
      bootstrap: mutation(async (ctx) => {
        const inserted = await ctx.db[appTableName].insertOrIgnore({ teamId, plan: "pro" }, "teamId");
        const winner = inserted ?? await ctx.db[appTableName].where("teamId", teamId).get();
        return { inserted: inserted !== null, winnerId: winner?.id ?? null };
      }),
    },
  };
  const config = {
    name: "insert-or-ignore-postgres-test",
    services: { database: { engine: "postgres" } },
  };
  const env = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  let firstDatabase;
  let secondDatabase;
  try {
    // The guard in withPostgresAdapter/resetPostgresSchema permits this destructive setup only
    // against the dedicated local sporades_w17 test schema, never a developer's database.
    await withPostgresAdapter(async () => {}, { appTableNames: [appTableName] });
    // Initialise the schema before opening two independent Capsule runtimes. The race below is
    // therefore two separate Postgres connections racing only the mutation, not migration DDL.
    const initializer = await openDevDatabase(path.join(dir, "initializer.db"), "", env, config, definition);
    await initializer.close();
    firstDatabase = await openDevDatabase(path.join(dir, "first.db"), "", env, config, definition);
    secondDatabase = await openDevDatabase(path.join(dir, "second.db"), "", env, config, definition);
    const auth = { userId: "postgres-bootstrap", displayName: "Postgres Bootstrap", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
    const [first, second] = await Promise.all([
      runMutation(firstDatabase, auth, "bootstrap", []),
      runMutation(secondDatabase, auth, "bootstrap", []),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal([first.data.inserted, second.data.inserted].filter(Boolean).length, 1);
    assert.notEqual(first.data.winnerId, null, "the winner is returned by the inserting Capsule");
    assert.equal(first.data.winnerId, second.data.winnerId, "the losing Capsule rereads the inserted winner");
    assert.equal((await firstDatabase.adapter.prepare(`SELECT COUNT(*) AS "count" FROM "${appTableName}" WHERE "teamId" = ?`).get(teamId)).count, 1);
  } finally {
    await Promise.all([firstDatabase?.close(), secondDatabase?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
