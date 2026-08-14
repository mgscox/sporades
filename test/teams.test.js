import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWebSocketHub, openDevDatabase, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { mutation } from "../dist/server.js";

const capsule = {
  name: "teams-test",
  schema: {},
  queries: {
    ownTeams: {
      kind: "query",
      handler: (ctx) => ctx.teams.list(),
    },
  },
  mutations: {
    createAdditionalTeam: mutation((ctx, name) => ctx.teams.create(name)),
    renameAdditionalTeam: mutation((ctx, teamId, name) => ctx.teams.rename(teamId, name)),
  },
};

test("a newly linked caller immediately receives one persistent singleton Team through public and trusted current-user seams", async () => {
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
    assert.equal(
      runtime.database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(signedUp.data.auth.userId).count,
      1,
      "email account linking commits the initial Team before any Team-interface call",
    );

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

test("linked users create and rename explicit additional Teams through browser and trusted seams", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-additional-"));
  const databasePath = path.join(dir, "data.db");
  let runtime = await startRuntime(databasePath);
  let owner;
  let stranger;
  try {
    owner = await runtime.open();
    const signedUp = await send(owner, {
      id: "additional-owner-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "additional-owner@example.com", password: "password-123", name: "Additional Owner" },
    });
    assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));

    const created = await send(owner, { id: "additional-create", type: "teams.create", name: "  Product\u00a0Team  " });
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.deepEqual(created.data, {
      team: {
        id: created.data.team.id,
        name: "Product Team",
        role: "admin",
        applicationRoles: [],
        memberCount: 1,
      },
    });

    const invalid = await send(owner, { id: "additional-invalid-name", type: "teams.create", name: "   " });
    assert.equal(invalid.error.code, "INVALID_TEAM_NAME");

    const listed = await send(owner, { id: "additional-list", type: "teams.list" });
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.teams.length, 2);
    assert.deepEqual(listed.data.teams.map((team) => team.id), [listed.data.teams[0].id, created.data.team.id]);

    const trustedCreate = await runMutation(runtime.database, signedUp.data.auth, "createAdditionalTeam", ["Trusted Team"]);
    assert.equal(trustedCreate.error, null, JSON.stringify(trustedCreate.error));
    assert.equal(trustedCreate.data.team.name, "Trusted Team");

    const trustedRename = await runMutation(runtime.database, signedUp.data.auth, "renameAdditionalTeam", [trustedCreate.data.team.id, "Trusted Renamed Team"]);
    assert.equal(trustedRename.error, null, JSON.stringify(trustedRename.error));
    assert.equal(trustedRename.data.team.name, "Trusted Renamed Team");

    const renamedOverBrowser = await send(owner, {
      id: "additional-rename",
      type: "teams.rename",
      teamId: created.data.team.id,
      name: "  Platform Team  ",
    });
    assert.equal(renamedOverBrowser.error, null, JSON.stringify(renamedOverBrowser.error));
    assert.equal(renamedOverBrowser.data.team.name, "Platform Team");

    const auditEvents = (await runtime.database.log.tail(20)).filter((event) => event.event.startsWith("teams."));
    assert.deepEqual(auditEvents.map((event) => event.event), ["teams.created", "teams.created", "teams.renamed", "teams.renamed"]);
    assert.doesNotMatch(JSON.stringify(auditEvents), /Product Team|Platform Team|sessionToken|provider/);

    stranger = await runtime.open();
    const strangerSignUp = await send(stranger, {
      id: "additional-stranger-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "additional-stranger@example.com", password: "password-123", name: "Additional Stranger" },
    });
    assert.equal(strangerSignUp.error, null, JSON.stringify(strangerSignUp.error));
    const denied = await send(stranger, {
      id: "additional-stranger-rename",
      type: "teams.rename",
      teamId: created.data.team.id,
      name: "Leaked name",
    });
    assert.equal(denied.error.code, "DENIED");
    assert.equal(denied.error.message, "Team operation denied.");
    assert.doesNotMatch(JSON.stringify(denied), /Product Team|Platform Team|additional-owner/);

    owner.close(); owner = null;
    stranger.close(); stranger = null;
    await runtime.close();
    runtime = await startRuntime(databasePath);
    owner = await runtime.open();
    const afterRestart = await send(owner, { id: "additional-after-restart", type: "teams.list", sessionToken: signedUp.data.sessionToken });
    assert.equal(afterRestart.error, null, JSON.stringify(afterRestart.error));
    assert.deepEqual(afterRestart.data.teams.map((team) => team.name), ["My Team", "Platform Team", "Trusted Renamed Team"]);
  } finally {
    owner?.close(); stranger?.close();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("additional Team creation is atomic and bounded across the trusted server interface", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-atomic-"));
  const databasePath = path.join(dir, "data.db");
  const runtime = await startRuntime(databasePath);
  const auth = { userId: "team-atomic-user", displayName: "Atomic", email: "atomic@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
  const baseAdapter = runtime.database.adapter;
  try {
    await baseAdapter.withTransaction((tx) => tx.linkAuthUser({
      id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
      isAuthenticated: 1, isGuest: 0, provider: "email",
    }));
    runtime.database.mutationHooks.afterMutation = ["() => { throw new Error('post-create rollback'); }"];
    const rolledBack = await runMutation(runtime.database, auth, "createAdditionalTeam", ["Will Roll Back"]);
    assert.equal(rolledBack.ok, false);
    assert.equal(countTeams(baseAdapter), 0, "a failed Team mutation leaves no orphan Team");
    assert.equal(countMemberships(baseAdapter), 0);

    runtime.database.mutationHooks.afterMutation = [];
    for (let index = 0; index < 24; index += 1) {
      const created = await runMutation(runtime.database, auth, "createAdditionalTeam", [`Bounded Team ${index + 1}`]);
      assert.equal(created.ok, true, JSON.stringify(created));
    }
    const overLimit = await runMutation(runtime.database, auth, "createAdditionalTeam", ["One Team Too Many"]);
    assert.equal(overLimit.ok, false);
    assert.equal(overLimit.error.code, "TEAM_LIMIT_REACHED");
    assert.equal(countTeams(baseAdapter), 25);
    assert.equal(countMemberships(baseAdapter), 25);
    const listed = await runQuery(runtime.database, auth, "ownTeams");
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.teams.length, 25);
  } finally {
    runtime.database.mutationHooks.afterMutation = [];
    await runtime.close();
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

function countTeams(adapter) {
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams]").get().count);
}

function countMemberships(adapter) {
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships]").get().count);
}
