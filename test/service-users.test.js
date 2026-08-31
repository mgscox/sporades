import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, mutation, query, requireAuth } from "../dist/server.js";
import {
  openDevDatabase,
  routeEndpoint,
  runQuery as runRuntimeQuery,
  runMutation as runRuntimeMutation,
} from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter } from "./support/database-adapter-engines.js";

const ADMIN_AUTH = Object.freeze({
  userId: "service-user-administrator",
  userKind: "human",
  displayName: "Service User Administrator",
  email: "administrator@example.com",
  picture: null,
  isAuthenticated: true,
  isGuest: false,
  provider: "email",
});
const ADMIN_SESSION = "service-user-administrator-session";

async function seedAdministrator(database) {
  await database.adapter.insertAuthUser({
    id: ADMIN_AUTH.userId,
    createdAt: "2026-08-31T12:00:00.000Z",
    displayName: ADMIN_AUTH.displayName,
    email: ADMIN_AUTH.email,
    picture: null,
    isAuthenticated: 1,
    isGuest: 0,
    provider: "email",
  });
  await database.adapter.insertAuthSession({
    token: ADMIN_SESSION,
    userId: ADMIN_AUTH.userId,
    provider: "email",
    createdAt: "2026-08-31T12:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

function runMutation(database, name, args) {
  return runRuntimeMutation(database, ADMIN_AUTH, name, args, { sessionToken: ADMIN_SESSION });
}

async function requestEndpoint(database, token) {
  const request = {
    url: "/agent",
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    rawHeaders: ["Authorization", `Bearer ${token}`],
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {},
  };
  const response = {
    status: null,
    body: "",
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body); },
  };
  assert.equal(await routeEndpoint(database, request, response), true);
  return { status: response.status, body: JSON.parse(response.body) };
}

test("a human Session atomically creates, attributes, rotates, and disables a service User", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-users-"));
  const definition = capsule({
    name: "service-users",
    accessKeys: { scopes: ["tickets:read", "tickets:write"] },
    mutations: {
      createAgent: mutation((ctx) => ctx.serviceUsers.create({
        displayName: "Triage Agent",
        accessKey: { name: "production", grants: ["tickets:read", "tickets:write"] },
      })),
      createThenFail: mutation(async (ctx) => {
        await ctx.serviceUsers.create({
          displayName: "Rolled Back Agent",
          accessKey: { name: "rolled-back", grants: ["tickets:read"] },
        });
        throw new Error("roll back service User");
      }),
      issueAgentKey: mutation((ctx, input) => ctx.serviceUsers.issueAccessKey(input.userId, input.accessKey)),
      rotateAgentKey: mutation((ctx, input) => ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, {
        lifecycleRevision: input.lifecycleRevision,
      })),
      listAgentKeys: mutation((ctx, userId) => ctx.serviceUsers.listAccessKeys(userId)),
      disableAgent: mutation((ctx, userId) => ctx.serviceUsers.disable(userId)),
    },
    queries: {
      invalidQueryCreate: query((ctx) => ctx.serviceUsers.create({
        displayName: "Query Agent",
        accessKey: { name: "query", grants: ["tickets:read"] },
      })),
    },
    endpoints: {
      agent: endpoint({ method: "GET", path: "/agent" }, requireAuth({
        credentials: ["access-key"],
        scopes: ["tickets:read"],
      }, (ctx) => ({ body: { auth: ctx.auth, credential: ctx.credential } }))),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition, {
    clock: { now: () => new Date("2026-08-31T12:00:00.000Z") },
  });
  try {
    await seedAdministrator(database);

    const nonTransactional = await runRuntimeQuery(database, ADMIN_AUTH, "invalidQueryCreate", [], { sessionToken: ADMIN_SESSION });
    assert.equal(nonTransactional.error?.code, "SERVICE_USER_MUTATION_REQUIRED");
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?",
    )).get("Query Agent")) ?? null, null);

    const failed = await runMutation(database, "createThenFail", []);
    assert.ok(failed.error);
    assert.match(failed.error.message, /roll back service User/);
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?",
    )).get("Rolled Back Agent")) ?? null, null);

    const created = await runMutation(database, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.deepEqual(created.data.serviceUser, {
      id: created.data.serviceUser.id,
      displayName: "Triage Agent",
      status: "active",
      createdAt: "2026-08-31T12:00:00.000Z",
      disabledAt: null,
    });
    assert.match(created.data.token, /^spk_1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.data.accessKey.lifecycleRevision, 1);

    const admitted = await requestEndpoint(database, created.data.token);
    assert.equal(admitted.status, 200);
    assert.deepEqual(admitted.body.auth, {
      userId: created.data.serviceUser.id,
      userKind: "service",
      displayName: "Triage Agent",
      email: null,
      picture: null,
      isAuthenticated: true,
      isGuest: false,
      provider: "access-key",
    });
    assert.deepEqual(admitted.body.credential, {
      kind: "access-key",
      id: created.data.accessKey.id,
      name: "production",
    });

    const second = await runMutation(database, "issueAgentKey", [{
      userId: created.data.serviceUser.id,
      accessKey: { name: "staging", grants: ["tickets:read"] },
    }]);
    assert.equal(second.error, null, JSON.stringify(second.error));
    assert.match(second.data.token, /^spk_1_/);
    assert.equal(second.data.accessKey.lifecycleRevision, 1);
    const listed = await runMutation(database, "listAgentKeys", [created.data.serviceUser.id]);
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.deepEqual(listed.data.accessKeys.map(({ name }) => name).sort(), ["production", "staging"]);
    assert.equal(JSON.stringify(listed.data).includes(second.data.token), false);

    const rotated = await runMutation(database, "rotateAgentKey", [{
      userId: created.data.serviceUser.id,
      accessKeyId: second.data.accessKey.id,
      lifecycleRevision: second.data.accessKey.lifecycleRevision,
    }]);
    assert.equal(rotated.error, null, JSON.stringify(rotated.error));
    assert.notEqual(rotated.data.token, second.data.token);
    assert.equal((await requestEndpoint(database, second.data.token)).status, 401);
    assert.equal((await requestEndpoint(database, rotated.data.token)).status, 200);

    const disabled = await runMutation(database, "disableAgent", [created.data.serviceUser.id]);
    assert.equal(disabled.error, null, JSON.stringify(disabled.error));
    assert.equal(disabled.data.serviceUser.status, "disabled");
    assert.equal(disabled.data.revokedCount, 2);
    assert.equal((await requestEndpoint(database, created.data.token)).status, 401);
    assert.equal((await requestEndpoint(database, rotated.data.token)).status, 401);

    const stored = await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id], [email], [picture], [provider], [userKind], [lifecycleStatus] " +
      "FROM [sporades_auth_users] WHERE [id] = ?",
    )).get(created.data.serviceUser.id);
    assert.deepEqual({
      userKind: stored.userKind,
      lifecycleStatus: stored.lifecycleStatus,
      email: stored.email,
      picture: stored.picture,
      provider: stored.provider,
    }, {
      userKind: "service",
      lifecycleStatus: "disabled",
      email: null,
      picture: null,
      provider: "service",
    });
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [token] FROM [sporades_auth_sessions] WHERE [userId] = ?",
    )).get(stored.id)) ?? null, null);
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_identities] WHERE [userId] = ?",
    )).get(stored.id)) ?? null, null);
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [email] FROM [sporades_auth_email_credentials] WHERE [userId] = ?",
    )).get(stored.id)) ?? null, null);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("service-User authority rechecks human Sessions and serializes rotation with disablement across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-user-race-"));
  const databasePath = path.join(dir, "data.db");
  const definition = capsule({
    name: "service-user-race",
    accessKeys: { scopes: ["tickets:read", "tickets:write"] },
    mutations: {
      createAgent: mutation((ctx) => ctx.serviceUsers.create({
        displayName: "Race Agent",
        accessKey: { name: "race", grants: ["tickets:read", "tickets:write"] },
      })),
      rotateAgentKey: mutation((ctx, input) => ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, {
        lifecycleRevision: input.lifecycleRevision,
      })),
      disableAgent: mutation((ctx, userId) => ctx.serviceUsers.disable(userId)),
    },
    endpoints: {
      agentCannotManage: endpoint({ method: "GET", path: "/agent-cannot-manage" }, requireAuth({
        credentials: ["access-key"],
        scopes: ["tickets:read"],
      }, (ctx) => ctx.serviceUsers.listAccessKeys(ctx.auth.userId))),
      agent: endpoint({ method: "GET", path: "/agent" }, requireAuth({
        credentials: ["access-key"], scopes: ["tickets:read"],
      }, (ctx) => ({ body: { auth: ctx.auth, credential: ctx.credential } }))),
    },
  });
  let database = await openDevDatabase(databasePath, "", {}, { name: definition.name }, definition, {
    clock: { now: () => new Date("2026-08-31T12:00:00.000Z") },
  });
  try {
    await seedAdministrator(database);
    const created = await runMutation(database, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.equal((await requestEndpoint(database, created.data.token)).status, 200);

    const deniedRequest = {
      url: "/agent-cannot-manage",
      method: "GET",
      headers: { authorization: `Bearer ${created.data.token}` },
      rawHeaders: ["Authorization", `Bearer ${created.data.token}`],
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {},
    };
    const deniedResponse = { status: null, body: "", setHeader() {}, writeHead(status) { this.status = status; }, end(body = "") { this.body = String(body); } };
    assert.equal(await routeEndpoint(database, deniedRequest, deniedResponse), true);
    assert.equal(deniedResponse.status, 403);

    await database.close();
    database = await openDevDatabase(databasePath, "", {}, { name: definition.name }, definition, {
      clock: { now: () => new Date("2026-08-31T12:01:00.000Z") },
    });
    assert.equal((await requestEndpoint(database, created.data.token)).status, 200);

    const [rotate, disable] = await Promise.all([
      runMutation(database, "rotateAgentKey", [{
        userId: created.data.serviceUser.id,
        accessKeyId: created.data.accessKey.id,
        lifecycleRevision: created.data.accessKey.lifecycleRevision,
      }]),
      runMutation(database, "disableAgent", [created.data.serviceUser.id]),
    ]);
    assert.equal(disable.error, null, JSON.stringify(disable.error));
    assert.equal(rotate.error === null || rotate.error.code === "SERVICE_USER_NOT_ACTIVE", true);
    const possibleTokens = [created.data.token, rotate.data?.token].filter(Boolean);
    for (const token of possibleTokens) assert.equal((await requestEndpoint(database, token)).status, 401);

    const secondAdmin = { ...ADMIN_AUTH, userId: "stale-service-user-administrator", email: "stale@example.com" };
    await database.adapter.insertAuthUser({
      id: secondAdmin.userId, createdAt: "2026-08-31T12:00:00.000Z", displayName: secondAdmin.displayName,
      email: secondAdmin.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email",
    });
    await database.adapter.insertAuthSession({
      token: "stale-service-user-session", userId: secondAdmin.userId, provider: "email",
      createdAt: "2026-08-31T12:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await database.adapter.deleteAuthSession("stale-service-user-session");
    const stale = await runRuntimeMutation(database, secondAdmin, "createAgent", [], { sessionToken: "stale-service-user-session" });
    assert.equal(stale.error.code, "FORBIDDEN");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveRemoteEngineServiceUserLifecycle(serverEnv, config) {
  const definition = capsule({
    name: config.name,
    accessKeys: { scopes: ["tickets:read"] },
    mutations: {
      createAgent: mutation((ctx) => ctx.serviceUsers.create({
        displayName: "Remote Agent",
        accessKey: { name: "production", grants: ["tickets:read"] },
      })),
      rotateAgentKey: mutation((ctx, input) => ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, {
        lifecycleRevision: input.lifecycleRevision,
      })),
      disableAgent: mutation((ctx, userId) => ctx.serviceUsers.disable(userId)),
    },
  });
  const first = await openDevDatabase("", "", serverEnv, config, definition);
  let second;
  try {
    await seedAdministrator(first);
    const created = await runMutation(first, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    second = await openDevDatabase("", "", serverEnv, config, definition);
    const [rotated, disabled] = await Promise.all([
      runMutation(first, "rotateAgentKey", [{
        userId: created.data.serviceUser.id,
        accessKeyId: created.data.accessKey.id,
        lifecycleRevision: created.data.accessKey.lifecycleRevision,
      }]),
      runMutation(second, "disableAgent", [created.data.serviceUser.id]),
    ]);
    assert.equal(disabled.error, null, JSON.stringify(disabled.error));
    assert.equal(rotated.error === null || rotated.error.code === "SERVICE_USER_NOT_ACTIVE", true, JSON.stringify(rotated.error));
    const stored = await first.adapter.prepare(first.adapter.dialect.sql(
      "SELECT [lifecycleStatus], [disabledAt] FROM [sporades_auth_users] WHERE [id] = ?",
    )).get(created.data.serviceUser.id);
    assert.equal(stored.lifecycleStatus, "disabled");
    assert.ok(stored.disabledAt);
    const current = await first.adapter.prepare(first.adapter.dialect.sql(
      "SELECT [revokedAt], [selector], [verifierDigest] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ?",
    )).all(created.data.serviceUser.id);
    assert.equal(current.length, 1);
    assert.equal(current.every((key) => key.revokedAt && key.selector === null && key.verifierDigest === null), true);
  } finally {
    await second?.close();
    await first.close();
  }
}

test("libSQL serializes Service-User rotation and disablement across separate runtimes", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    const name = `service-user-libsql-${randomUUID()}`;
    await proveRemoteEngineServiceUserLifecycle(
      { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { name, services: { database: { engine: "libsql" } } },
    );
  }, { isolateProcess: true });
});

test("Postgres serializes Service-User rotation and disablement across separate runtimes", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async () => {
    const name = `service-user-postgres-${randomUUID()}`;
    await proveRemoteEngineServiceUserLifecycle(
      { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { name, services: { database: { engine: "postgres" } } },
    );
  });
});
