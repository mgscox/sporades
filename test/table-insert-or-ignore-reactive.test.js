import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, mutation, query, table } from "../dist/server.js";
import { createWebSocketHub, openDevDatabase } from "../dist/server-runtime-source.js";

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
