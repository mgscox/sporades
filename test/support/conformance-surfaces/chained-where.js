import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Boolean as Flag, Date as Timestamp, Number as Numeric, String as Text, mutation, query, table } from "../../../dist/server.js";
import { createWebSocketHub, openDevDatabase, runMutation, runQuery } from "../../../dist/server-runtime-source.js";
import { liveQueryNeedsRefresh, takeLiveQueryDirtyTables, trackLiveQueryReads } from "../../../dist/live-query-invalidation.js";

const name = "chained_reminder_runs";
const auth = { userId: "where-test", isAuthenticated: false, isGuest: true, provider: "anonymous" };
const today = "2026-11-08T00:00:00.000Z";

export const CONFORMANCE_SURFACE = {
  title: "Chained where predicates",
  appTableNames: [name],
  adapterOptions: { isolateProcess: true },
  cases: [{
    name: "get and all preserve both predicates and live-query read tracking",
    async run(adapter, engineContext) {
      const dir = await mkdtemp(path.join(tmpdir(), "chained-where-"));
      let database;
      let server;
      let hub;
      let socket;
      try {
        const serviceEnv = adapter.engine === "sqlite" ? {} : {
          SPORADES_SERVICE_DATABASE_ENGINE: adapter.engine,
          SPORADES_SERVICE_DATABASE_URL: adapter.engine === "libsql" ? engineContext.url : process.env.SPORADES_POSTGRES_TEST_URL,
        };
        database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, {
          name: "chained-where", services: { database: { engine: adapter.engine } },
        }, {
          schema: { [name]: table({ label: Text(), venueId: Text(), runDate: Timestamp(), sent: Flag(), attempts: Numeric() }) },
          mutations: { add: mutation((ctx, row) => ctx.db[name].insert(row)) },
          queries: { reminders: query(async (ctx) => {
            const venue = ctx.db[name].where("venueId", "a");
            const current = venue.where("runDate", today);
            return {
              first: await current.orderBy("label").get(),
              rows: await current.orderBy("label").limit(10).all(),
              venue: await venue.orderBy("label").all(),
              contradiction: await venue.where("venueId", "b").all(),
              serialized: await current.where("sent", false).where("attempts", 2).all(),
            };
          }) },
        });
        assert.equal(database.adapter.engine, adapter.engine);
        await database.init();
        const add = async (row) => {
          const result = await runMutation(database, auth, "add", [row]);
          assert.equal(result.error, null);
        };
        // Put the false match first so get() cannot pass by selecting a lucky row.
        await add({ label: "1-other-venue", venueId: "b", runDate: today, sent: false, attempts: 2 });
        await add({ label: "2-yesterday", venueId: "a", runDate: "2026-11-07T00:00:00.000Z", sent: false, attempts: 2 });
        await add({ label: "3-match", venueId: "a", runDate: today, sent: false, attempts: 2 });
        const reads = new Set();
        takeLiveQueryDirtyTables();
        const result = await trackLiveQueryReads(reads, () => runQuery(database, auth, "reminders"));
        assert.equal(result.error, null);
        assert.equal(result.data.first.label, "3-match");
        assert.deepEqual(result.data.rows.map(row => row.label), ["3-match"]);
        assert.deepEqual(result.data.venue.map(row => row.label), ["2-yesterday", "3-match"], "branches keep their original predicate");
        assert.deepEqual(result.data.contradiction, [], "same-field clauses must both hold");
        assert.deepEqual(result.data.serialized.map(row => row.label), ["3-match"]);
        assert(reads.has(name), "live query tracks the filtered table");
        await add({ label: "4-match", venueId: "a", runDate: today, sent: true, attempts: 1 });
        assert(liveQueryNeedsRefresh(reads, takeLiveQueryDirtyTables()));
        const refreshed = await runQuery(database, auth, "reminders");
        assert.equal(refreshed.error, null);
        assert.deepEqual(refreshed.data.rows.map(row => row.label), ["3-match", "4-match"]);
        assert.deepEqual(refreshed.data.serialized.map(row => row.label), ["3-match"]);

        hub = createWebSocketHub(() => database);
        server = createServer();
        server.on("upgrade", (request, peer) => { void hub.accept(request, peer); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
        await once(socket, "open");
        const response = (trigger) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error("Subscription response timed out")); }, 5000);
          const onMessage = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.id !== "reminders") return;
            clearTimeout(timer);
            socket.removeEventListener("message", onMessage);
            resolve(value);
          };
          socket.addEventListener("message", onMessage);
          trigger();
        });
        const initial = await response(() => socket.send(JSON.stringify({ id: "reminders", type: "query.subscribe", query: "reminders" })));
        assert.equal(initial.error, null);
        assert.deepEqual(initial.data.rows.map(row => row.label), ["3-match", "4-match"]);
        const nextResult = response(() => socket.send(JSON.stringify({
          id: "insert", type: "mutation.run", mutation: "add",
          args: [{ label: "5-match", venueId: "a", runDate: today, sent: true, attempts: 1 }],
        })));
        const delivered = await nextResult;
        assert.equal(delivered.id, "reminders");
        assert.equal(delivered.error, null);
        assert.deepEqual(delivered.data.rows.map(row => row.label), ["3-match", "4-match", "5-match"]);
      } finally {
        socket?.close();
        hub?.disconnectAll();
        if (server) await new Promise(resolve => server.close(resolve));
        if (database) { await database.shutdown(); await database.close(); }
        await rm(dir, { recursive: true, force: true });
      }
    },
  }],
};
