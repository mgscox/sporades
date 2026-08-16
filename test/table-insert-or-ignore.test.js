import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Number as NumberField, Reference, String, mutation, query, table } from "../dist/server.js";
import { createEndpointDatabaseApi, createWebSocketHub, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
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

test("insertOrIgnore preserves insert ACL and field-integrity errors for an exact named constraint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-insert-or-ignore-errors-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "insert-or-ignore-errors" }, {
      schema: {
        parents: table({ slug: String() }).unique("slug"),
        children: table({
          key: String(),
          parentId: Reference("parents"),
          score: NumberField(),
        }).unique("key").acl({
          insert: ({ next }) => next.key !== "denied",
        }),
      },
    });
    try {
      const db = createEndpointDatabaseApi(database);
      const parent = await db.parents.insert({ slug: "parent" });

      await assert.rejects(
        async () => db.children.insertOrIgnore({ key: "denied", parentId: parent.id, score: 1 }, "key"),
        { code: "DENIED", message: "Denied." },
      );
      await assert.rejects(
        async () => db.children.insertOrIgnore({ key: "missing-parent", parentId: "missing", score: 1 }, "key"),
        { message: "Invalid reference for field: parentId" },
      );
      await assert.rejects(
        async () => db.children.insertOrIgnore({ key: "invalid-score", parentId: parent.id, score: Number.POSITIVE_INFINITY }, "key"),
        { message: "Invalid number for field: score" },
      );
      assert.equal((await db.children.all()).length, 0, "ordinary insert errors never become null conflict results or rows");
    } finally {
      await database.close();
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

test("a no-write insertOrIgnore mutation does not refresh subscriptions while another write still does", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-insert-or-ignore-refresh-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "insert-or-ignore-refresh" }, {
    schema: {
      subscriptions: table({ teamId: String(), plan: String() }).unique("teamId"),
      mutation_audits: table({ message: String() }),
    },
    queries: {
      subscriptions: query((ctx) => ctx.db.subscriptions.all()),
    },
    mutations: {
      bootstrap: mutation((ctx, teamId) => ctx.db.subscriptions.insertOrIgnore({ teamId, plan: "pro" }, "teamId")),
      bootstrapAndAudit: mutation((ctx, teamId) => {
        const singleton = ctx.db.subscriptions.insertOrIgnore({ teamId, plan: "pro" }, "teamId");
        ctx.db.mutation_audits.insert({ message: `checked:${teamId}` });
        return singleton;
      }),
    },
  });
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?connectionToken=${hub.createConnectionToken()}`);
  const frames = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
    }
  });
  const waitFor = (predicate, timeoutMs = 2_000) => {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for frame; saw ${frames.map((frame) => `${frame.id}:${frame.type}`).join(", ")}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  const send = async (message) => {
    socket.send(JSON.stringify(message));
    return await waitFor((frame) => frame.id === message.id && frame.type === "mutation.result");
  };
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ id: "subscriptions", type: "query.subscribe", query: "subscriptions" }));
    await waitFor((frame) => frame.id === "subscriptions" && frame.type === "query.result");

    await send({ id: "insert", type: "mutation.run", mutation: "bootstrap", args: ["team-a"] });
    await waitFor((frame) => frame.id === "subscriptions" && frame.type === "query.result" && frame.data.length === 1);
    const afterInsertRefreshes = frames.filter((frame) => frame.id === "subscriptions" && frame.type === "query.result").length;

    const duplicate = await send({ id: "duplicate", type: "mutation.run", mutation: "bootstrap", args: ["team-a"] });
    assert.equal(duplicate.data, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      frames.filter((frame) => frame.id === "subscriptions" && frame.type === "query.result").length,
      afterInsertRefreshes,
      "a pure conflict loser does not invalidate or refresh the subscription",
    );

    const beforeOtherWrite = frames.filter((frame) => frame.id === "subscriptions" && frame.type === "query.result").length;
    await send({ id: "other-write", type: "mutation.run", mutation: "bootstrapAndAudit", args: ["team-a"] });
    await waitFor((_frame) => frames.filter((frame) => frame.id === "subscriptions" && frame.type === "query.result").length > beforeOtherWrite);
  } finally {
    socket.close();
    hub.disconnectAll();
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
