import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWebSocketHub, openDevDatabase, runQuery } from "../dist/server-runtime-source.js";

const capsule = {
  name: "teams-test",
  schema: {},
  queries: {
    ownTeams: {
      kind: "query",
      handler: (ctx) => ctx.teams.list(),
    },
  },
};

test("a linked caller lazily receives one persistent singleton Team through public and trusted current-user seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-"));
  const databasePath = path.join(dir, "data.db");
  let runtime = await startRuntime(databasePath);
  let anonymous;
  let linked;
  try {
    anonymous = await runtime.open();
    const anonymousAuth = await send(anonymous, { id: "anonymous-auth", type: "auth.get" });
    const denied = await send(anonymous, { id: "anonymous-teams", type: "teams.list" });
    assert.equal(denied.error.code, "UNAUTHENTICATED");

    const signedUp = await send(anonymous, {
      id: "signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "owner@example.com", password: "password-123", name: "Owner" },
    });
    assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));

    linked = await runtime.open();
    const [first, concurrent] = await Promise.all([
      send(anonymous, { id: "teams-first", type: "teams.list" }),
      send(linked, { id: "teams-concurrent", type: "teams.list", sessionToken: signedUp.data.sessionToken }),
    ]);
    assert.equal(first.error, null, JSON.stringify(first.error));
    assert.deepEqual(first.data, concurrent.data, "concurrent calls create no extra singleton Team");
    assert.equal(first.data.teams.length, 1);
    assert.deepEqual(Object.keys(first.data.teams[0]).sort(), ["applicationRoles", "id", "memberCount", "name", "role"]);
    assert.equal(first.data.teams[0].role, "admin");
    assert.deepEqual(first.data.teams[0].applicationRoles, []);
    assert.equal(first.data.teams[0].memberCount, 1);
    assert.match(first.data.teams[0].id, /^[0-9a-f-]{36}$/i);
    assert.ok(first.data.teams[0].name.length > 0 && first.data.teams[0].name.length <= 80);

    const repeated = await send(linked, { id: "teams-repeat", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.deepEqual(repeated.data, first.data, "retries create no extra singleton Team");

    const trusted = await runQuery(runtime.database, signedUp.data.auth, "ownTeams");
    assert.deepEqual(trusted, { data: first.data, error: null });

    linked.close(); linked = null;
    anonymous.close(); anonymous = null;
    await runtime.close();
    runtime = await startRuntime(databasePath);
    linked = await runtime.open();
    const afterRestart = await send(linked, { id: "teams-after-restart", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.deepEqual(afterRestart.data, first.data, "runtime-owned Team state persists across restart");
    assert.equal(anonymousAuth.data.auth.isGuest, true, "the anonymous denial creates no Team state");
  } finally {
    anonymous?.close(); linked?.close();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function startRuntime(databasePath) {
  const database = await openDevDatabase(databasePath, "", {}, {
    name: "teams-test",
    auth: { providers: { anonymous: true, email: true } },
  }, capsule);
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    database,
    open: () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?connectionToken=${hub.createConnectionToken()}`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
    async close() {
      hub.disconnectAll();
      await new Promise((resolve) => server.close(resolve));
      await database.close();
    },
  };
}

function send(ws, message) {
  return new Promise((resolve) => {
    const listener = ({ data }) => {
      const response = JSON.parse(data);
      if (response.id !== message.id) return;
      ws.removeEventListener("message", listener);
      resolve(response);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify(message));
  });
}
