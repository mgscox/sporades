import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { job, mutation, query, requireAuth, String as Text, table } from "../../../dist/server.js";
import { createWebSocketHub, openDevDatabase, runCurrentUserJobWorker } from "../../../dist/server-runtime-source.js";
import { takeLiveQueryDirtyTables } from "../../../dist/live-query-invalidation.js";
import { createLibsqlLostAckProxy } from "../libsql-lost-ack-proxy.js";

const names = ["transport_todos", "transport_notes", "transport_audits"];
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function waitForGate(promise, label) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gate timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export const CONFORMANCE_SURFACE = {
  title: "Live query transport table scoping",
  appTableNames: names,
  adapterOptions: { isolateProcess: true },
  cases: [{
    name: "mutations, Jobs and overlapping adapter writes preserve table-scoped WebSocket refreshes",
    async run(adapter, engineContext) {
      const dir = await mkdtemp(path.join(tmpdir(), "query-transport-"));
      const runs = [0, 0];
      let heldTodoQuery;
      let deniedRuns = 0;
      const definition = {
        schema: Object.fromEntries(names.map((name) => [name, table({ text: Text() }).acl({ read: () => true, write: () => true })])),
        queries: { ...Object.fromEntries(names.slice(0, 2).map((name, index) => [name, query(async (ctx) => {
          runs[index] += 1;
          await Promise.resolve();
          const rows = await ctx.db[name].all();
          if (index === 0 && heldTodoQuery && (!heldTodoQuery.userId || heldTodoQuery.userId === ctx.auth.userId)) {
            const held = heldTodoQuery;
            heldTodoQuery = undefined;
            held.started = true;
            held.entered.resolve();
            await held.release.promise;
            held.finished?.resolve();
          }
          return rows;
        })])), denied: query((ctx) => {
          deniedRuns++;
          // Bound a broken diagnostic feedback loop so this regression fails
          // an assertion instead of starving timers and hanging the test runner.
          if (deniedRuns > 2) return [];
          return requireAuth(ctx);
        }) },
        mutations: {
          write: mutation((ctx, name, text = "mutation") => ctx.db[name].insert({ text })),
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
      let lostAckProxy;
      try {
        if (adapter.engine === "libsql") {
          lostAckProxy = await createLibsqlLostAckProxy(engineContext.url);
          serviceEnv.SPORADES_SERVICE_DATABASE_URL = lostAckProxy.url;
        }
        database = await openDevDatabase(path.join(dir, "database.db"), "", serviceEnv, {
          name: "query-transport",
          services: { database: { engine: adapter.engine } },
        }, definition);
        assert.equal(database.adapter.engine, adapter.engine, "transport must use the requested database engine");
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
        const expectSocketResult = async (peer, id, text, trigger) => {
          const delivered = Promise.withResolvers();
          const onResult = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.id === id && value.data?.some((row) => row.text === text)) delivered.resolve(value);
          };
          peer.addEventListener("message", onResult);
          const timer = setTimeout(() => delivered.reject(new Error(`Subscription stayed stale: ${text}`)), 2000);
          try {
            const [value] = await Promise.all([delivered.promise, Promise.resolve().then(trigger)]);
            assert.equal(value.error, null);
          } finally {
            clearTimeout(timer);
            peer.removeEventListener("message", onResult);
          }
        };
        const expectResult = (id, text, trigger) => expectSocketResult(socket, id, text, trigger);
        const expectTodo = (text, trigger) => expectResult("transport_todos", text, trigger);
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

        if (adapter.engine === "libsql") {
          takeLiveQueryDirtyTables();
          const before = [...runs];
          events.length = 0;
          assert.equal((await database.adapter.prepare('UPDATE "transport_todos" SET "text" = ? WHERE "id" = ?').run("absent", "missing")).changes, 0);
          database.__notifyJobStateQueries();
          await pause();
          await send({ id: "zero-row-sentinel", type: "auth.get" });
          assert.deepEqual(runs, before, "successful recognized zero-row writes still refresh none");
          assert.deepEqual(events.filter((event) => event.type === "query.result"), []);

          const sql = 'UPDATE "transport_todos" SET "text" = ?';
          lostAckProxy.loseNextAcknowledgement(sql);
          await assert.rejects(database.adapter.prepare(sql).run("lost-ack-value"), /fetch failed/);
          assert.equal(lostAckProxy.lostAcknowledgements, 1, "the response was lost after storage completed the write");
          assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "lost-ack-value");
          const delivered = Promise.withResolvers();
          const onResult = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.id === "transport_todos" && value.data?.some((row) => row.text === "lost-ack-value")) delivered.resolve(value);
          };
          socket.addEventListener("message", onResult);
          let timeout;
          try {
            database.__notifyJobStateQueries();
            const value = await Promise.race([delivered.promise, new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Lost libsql acknowledgement left subscription stale")), 1000);
            })]);
            assert.equal(value.error, null);
            assert.deepEqual(runs, [before[0] + 1, before[1]], "the rejected write refreshes only its table's readers");
          } finally {
            clearTimeout(timeout);
            socket.removeEventListener("message", onResult);
          }

          // Storage is a separate process: the proxy delays forwarding exec's write,
          // so a completion refresh can consume the old window before it commits.
          const delayedSql = `UPDATE "transport_todos" SET "text" = 'committed-exec'`;
          const delayed = lostAckProxy.delayNextStatement(delayedSql);
          const execution = database.adapter.exec(delayedSql);
          try {
            await waitForGate(delayed.entered, "delayed exec");
            await database.adapter.prepare(sql).run("lost-ack-value");
            await expectTodo("lost-ack-value", () => database.__notifyJobStateQueries());
            delayed.release();
            await execution;
            assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "committed-exec");
            await expectTodo("committed-exec", () => database.__notifyJobStateQueries());
          } finally {
            delayed.release();
            await execution;
          }

          // Hold a real refresh after it reads its snapshot. A write invalidation
          // arriving mid-refresh must cause a follow-up without another notification.
          const beforeOverlap = [...runs];
          const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
          heldTodoQuery = held;
          const overlappingSql = `UPDATE "transport_todos" SET "text" = 'committed-during-refresh'`;
          const overlapping = lostAckProxy.delayNextStatement(overlappingSql);
          let overlappingExecution;
          try {
            await database.adapter.prepare(sql).run("committed-exec");
            database.__notifyJobStateQueries();
            await waitForGate(held.entered.promise, "in-flight refresh snapshot");
            overlappingExecution = database.adapter.exec(overlappingSql);
            await waitForGate(overlapping.entered, "overlapping exec");
            overlapping.release();
            await overlappingExecution;
            assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "committed-during-refresh");
            await expectTodo("committed-during-refresh", () => held.release.resolve());
            assert.deepEqual(runs, [beforeOverlap[0] + 2, beforeOverlap[1]], "follow-up refresh stays scoped to the invalidated table");
          } finally {
            held.release.resolve();
            heldTodoQuery = undefined;
            overlapping.release();
            await overlappingExecution;
          }

          const lostExecSql = `UPDATE "transport_todos" SET "text" = 'exec-lost-ack'`;
          lostAckProxy.loseNextAcknowledgement(lostExecSql);
          await assert.rejects(database.adapter.exec(lostExecSql), /fetch failed/);
          assert.equal(lostAckProxy.lostAcknowledgements, 2);
          assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "exec-lost-ack");
          await expectTodo("exec-lost-ack", () => database.__notifyJobStateQueries());

          assert.equal((await send({ id: "denied", type: "query.subscribe", query: "denied" })).error.code, "UNAUTHENTICATED");
          takeLiveQueryDirtyTables();
          await database.adapter.prepare(sql).run("diagnostic-refresh");
          await expectTodo("diagnostic-refresh", () => database.__notifyJobStateQueries());
          await pause();
          await send({ id: "diagnostic-sentinel", type: "auth.get" });
          assert.equal(deniedRuns, 2, "a denied query's diagnostic write must not refresh itself repeatedly");
        }

        // Postgres resource scopes use an independent connection, so an ordinary
        // mutation can refresh subscriptions while their writes are still hidden.
        if (adapter.engine === "postgres") {
          const resource = { table: "transport_todos", id: "refresh-race" };
          await database.adapter.withResourceTransaction(() => undefined, undefined, resource);
          takeLiveQueryDirtyTables();
          const entered = Promise.withResolvers();
          const release = Promise.withResolvers();
          let committedResult;
          const committed = Promise.withResolvers();
          const onResult = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.id === "transport_todos" && value.data?.some((row) => row.text === "resource-committed")) {
              committedResult = value;
              committed.resolve();
            }
          };
          socket.addEventListener("message", onResult);
          const transaction = database.adapter.withResourceTransaction(
            (tx) => tx.prepare('UPDATE "transport_todos" SET "text" = ?').run("resource-committed"),
            async () => { entered.resolve(); await release.promise; },
            resource,
          );
          try {
            await entered.promise;
            assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "mutation");
            // This real mutation triggers and consumes a refresh before COMMIT.
            assert.equal((await send({ id: "race-write", type: "mutation.run", mutation: "write", args: ["transport_audits"] })).error, null);
            await pause();
            assert.equal(committedResult, undefined, "uncommitted resource writes stay hidden");
            release.resolve();
            await transaction;
            assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, "resource-committed");
            // The same completion notification used by the Job worker must still
            // refresh the reader after another refresh consumed the earlier window.
            database.__notifyJobStateQueries();
            let timeout;
            try {
              await Promise.race([committed.promise, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("Committed resource result was never delivered")), 1000);
              })]);
            } finally { clearTimeout(timeout); }
            assert.equal(committedResult.error, null);
          } finally {
            release.resolve();
            await transaction;
            socket.removeEventListener("message", onResult);
          }
        }
        if (adapter.engine === "postgres") {
          const statements = [
            { expected: "batch-committed", sql: `UPDATE "transport_todos" SET "text" = 'batch-committed'; UPDATE "transport_notes" SET "text" = 'absent' WHERE "id" = 'missing'` },
            { expected: "cte-committed", sql: `WITH changed AS (UPDATE "transport_todos" SET "text" = 'cte-committed' RETURNING "id") UPDATE "transport_notes" SET "text" = 'absent' WHERE "id" = 'missing'` },
            { expected: "committed-before-error", rejects: true, sql: `BEGIN; UPDATE "transport_todos" SET "text" = 'committed-before-error'; COMMIT; SELECT 1/0` },
          ];
          for (const { expected, sql, rejects } of statements) {
            takeLiveQueryDirtyTables();
            if (rejects) await assert.rejects(database.adapter.prepare(sql).run(), /division by zero/);
            else assert.equal((await database.adapter.prepare(sql).run()).changes, 0);
            assert.equal((await database.adapter.prepare('SELECT "text" FROM "transport_todos"').get()).text, expected);
            const delivered = Promise.withResolvers();
            const onResult = (event) => {
              const value = JSON.parse(String(event.data));
              if (value.id === "transport_todos" && value.data?.some((row) => row.text === expected)) delivered.resolve(value);
            };
            socket.addEventListener("message", onResult);
            let timeout;
            try {
              // Job completion must deliver committed writes even when the final
              // command reports zero rows or rejects after an earlier COMMIT.
              database.__notifyJobStateQueries();
              const value = await Promise.race([delivered.promise, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`Prepared statement left subscription stale: ${expected}`)), 1000);
              })]);
              assert.equal(value.error, null);
            } finally {
              clearTimeout(timeout);
              socket.removeEventListener("message", onResult);
            }
          }
        }
        // A held reader must not become a scheduling dependency for another
        // client's subscriptions, including while cancelled work still awaits release.
        for (const lifecycle of ["completion", "unsubscribe", "disconnect", "replacement"]) {
          const todoSocket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
          const todoEvents = [];
          const todoPending = new Map();
          todoSocket.addEventListener("message", (event) => {
            const value = JSON.parse(String(event.data));
            todoEvents.push(value);
            todoPending.get(value.id)?.(value);
            todoPending.delete(value.id);
          });
          const todoSend = (message) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => { todoPending.delete(message.id); reject(new Error(`Todo response timeout: ${message.id}`)); }, 5000);
            todoPending.set(message.id, (value) => { clearTimeout(timer); resolve(value); });
            todoSocket.send(JSON.stringify(message));
          });
          const held = { entered: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
          let released = false;
          try {
            await once(todoSocket, "open");
            held.userId = (await todoSend({ id: "todo-auth", type: "auth.get" })).data.auth.userId;
            assert.equal((await todoSend({ id: "held-todo", type: "query.subscribe", query: "transport_todos" })).error, null);
            takeLiveQueryDirtyTables();
            heldTodoQuery = held;
            assert.equal((await send({ id: `hold-${lifecycle}`, type: "mutation.run", mutation: "write", args: ["transport_todos", `todo-before-${lifecycle}`] })).error, null);
            await waitForGate(held.entered.promise, `held Todo ${lifecycle}`);
            const writeNote = async (label) => {
              await expectResult("transport_notes", label, async () => {
                const result = await send({ id: label, type: "mutation.run", mutation: "write", args: ["transport_notes", label] });
                assert.equal(result.error, null);
              });
              assert.equal(released, false, "Notes must arrive before the held Todo query is released");
            };
            await writeNote(`notes-before-${lifecycle}`);
            // Queue another invalidation for the held subscription, then cancel
            // it. Its abandoned follow-up must never become a live scheduling slot.
            const pendingText = `todo-pending-${lifecycle}`;
            assert.equal((await send({ id: `pending-${lifecycle}`, type: "mutation.run", mutation: "write", args: ["transport_todos", pendingText] })).error, null);
            await pause();
            if (lifecycle === "completion") {
              await writeNote("notes-after-pending-completion");
              await expectSocketResult(todoSocket, "held-todo", pendingText, () => {
                released = true;
                held.release.resolve();
              });
              assert.equal(todoEvents.filter((event) => event.type === "query.result").length, 3,
                "the held snapshot and one coalesced follow-up must preserve the pending write");
              continue;
            } else if (lifecycle === "unsubscribe") {
              assert.equal((await todoSend({ id: "unsubscribe", type: "query.unsubscribe", subscriptionId: "held-todo" })).data.removed, true);
            } else if (lifecycle === "disconnect") {
              const closed = once(todoSocket, "close");
              todoSocket.close();
              await closed;
            } else {
              assert.equal((await todoSend({ id: "held-todo", type: "query.subscribe", query: "transport_notes" })).error, null,
                "the replacement must deliver before the old query is released");
            }
            const after = `notes-after-${lifecycle}`;
            if (lifecycle === "replacement") {
              await expectSocketResult(todoSocket, "held-todo", after, () => writeNote(after));
            } else {
              await writeNote(after);
            }
            const beforeRelease = todoEvents.filter((event) => event.type === "query.result").length;
            released = true;
            held.release.resolve();
            await waitForGate(held.finished.promise, `cancelled Todo ${lifecycle} settlement`);
            await pause();
            assert.equal(todoEvents.filter((event) => event.type === "query.result").length, beforeRelease, "cancelled refreshes and their queued work must deliver nothing");
          } finally {
            held.release.resolve();
            if (held.started) await waitForGate(held.finished.promise, `Todo ${lifecycle} cleanup`);
            if (heldTodoQuery === held) heldTodoQuery = undefined;
            todoSocket.close();
          }
        }
      } finally {
        socket?.close();
        hub?.disconnectAll();
        if (server) await new Promise((resolve) => server.close(resolve));
        if (database) { await database.shutdown(); await database.close(); }
        await lostAckProxy?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  }],
};
