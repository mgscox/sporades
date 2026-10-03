import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { job, mutation, query, String as Text, table } from "../../../dist/server.js";
import { createWebSocketHub, openDevDatabase, runCurrentUserJobWorker } from "../../../dist/server-runtime-source.js";
import { takeLiveQueryDirtyTables } from "../../../dist/live-query-invalidation.js";

const names = ["transport_todos", "transport_notes", "transport_audits"];
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

export const CONFORMANCE_SURFACE = {
  title: "Live query transport table scoping",
  appTableNames: names,
  adapterOptions: { isolateProcess: true },
  cases: [{
    name: "writing mutations and Jobs re-run only matching subscriptions over a real WebSocket",
    async run(adapter, engineContext) {
      const dir = await mkdtemp(path.join(tmpdir(), "query-transport-"));
      const runs = [0, 0];
      const definition = {
        schema: Object.fromEntries(names.map((name) => [name, table({ text: Text() }).acl({ read: () => true, write: () => true })])),
        queries: Object.fromEntries(names.slice(0, 2).map((name, index) => [name, query(async (ctx) => {
          runs[index] += 1;
          await Promise.resolve();
          return await ctx.db[name].all();
        })])),
        mutations: {
          write: mutation((ctx, name) => ctx.db[name].insert({ text: "mutation" })),
          enqueue: mutation((ctx) => ctx.jobs.enqueue("writeNote", null)),
        },
        jobs: { writeNote: job(async (ctx) => { await ctx.db.transport_notes.insert({ text: "job" }); }) },
      };
      const serviceEnv = adapter.engine === "sqlite" ? {} : {
        SPORADES_SERVICE_DATABASE_ENGINE: adapter.engine,
        SPORADES_SERVICE_DATABASE_URL: adapter.engine === "libsql" ? engineContext.url : process.env.SPORADES_POSTGRES_TEST_URL,
      };
      let database;
      let hub;
      let server;
      let socket;
      try {
        database = await openDevDatabase(path.join(dir, "database.db"), "", serviceEnv, { name: "query-transport" }, definition);
        await database.init();
        hub = createWebSocketHub(() => database);
        server = createServer();
        server.on("upgrade", (request, peer) => { void hub.accept(request, peer); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
        const events = [];
        const pending = new Map();
        socket.addEventListener("message", (event) => {
          const value = JSON.parse(String(event.data));
          events.push(value);
          pending.get(value.id)?.(value);
          pending.delete(value.id);
        });
        await once(socket, "open");
        const send = (message) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`Response timeout: ${message.id}`)); }, 5000);
          pending.set(message.id, (value) => { clearTimeout(timer); resolve(value); });
          socket.send(JSON.stringify(message));
        });
        for (const name of names.slice(0, 2)) {
          const result = await send({ id: name, type: "query.subscribe", query: name });
          assert.equal(result.error, null);
        }
        takeLiveQueryDirtyTables();
        assert.deepEqual(runs, [1, 1]);
        const write = async (name, expected) => {
          events.length = 0;
          const result = await send({ id: `write-${name}`, type: "mutation.run", mutation: "write", args: [name] });
          assert.equal(result.error, null);
          await pause();
          await send({ id: `sentinel-${name}`, type: "auth.get" });
          assert.deepEqual(runs, expected);
          assert.deepEqual(events.filter((event) => event.type === "query.result").map((event) => event.id), name === "transport_audits" ? [] : [name]);
        };
        await write("transport_todos", [2, 1]);
        await write("transport_audits", [2, 1]);
        await write("transport_notes", [2, 2]);
        events.length = 0;
        assert.equal((await send({ id: "enqueue", type: "mutation.run", mutation: "enqueue" })).error, null);
        await runCurrentUserJobWorker(database);
        await pause();
        assert.deepEqual(runs, [2, 3]);
        assert.deepEqual(events.filter((event) => event.type === "query.result").map((event) => event.id), ["transport_notes"]);
      } finally {
        socket?.close();
        hub?.disconnectAll();
        if (server) await new Promise((resolve) => server.close(resolve));
        if (database) { await database.shutdown(); await database.close(); }
        await rm(dir, { recursive: true, force: true });
      }
    },
  }],
};
