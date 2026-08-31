import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, job, mutation, query, requireAuth, String as StringField, table } from "../dist/server.js";
import {
  openDevDatabase,
  routeEndpoint,
  runCurrentUserJobWorker,
  runQuery as runRuntimeQuery,
  runMutation as runRuntimeMutation,
} from "../dist/server-runtime-source.js";
import { readJobAuthSnapshot } from "../dist/jobs-runtime.js";
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

async function requestSessionEndpoint(database, operation) {
  const request = {
    url: `/manage-agent?operation=${encodeURIComponent(operation)}&serviceUserMutationAuthority=forged&mutationSurface=true`,
    method: "POST",
    headers: { "x-sporades-session-token": ADMIN_SESSION },
    rawHeaders: ["x-sporades-session-token", ADMIN_SESSION],
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {},
  };
  const response = {
    status: null,
    body: "",
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body; },
  };
  assert.equal(await routeEndpoint(database, request, response), true);
  let body = response.body;
  try { body = typeof body === "string" ? JSON.parse(body) : body; } catch {}
  return { status: response.status, body };
}

test("authenticated custom endpoints cannot forge Service-User mutation authority or touch storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-user-endpoint-authority-"));
  const definition = capsule({
    name: "service-user-endpoint-authority",
    accessKeys: { scopes: ["tickets:read"] },
    schema: { effects: table({ value: StringField() }) },
    endpoints: {
      manageAgent: endpoint({ method: "POST", path: "/manage-agent" }, requireAuth({ credentials: ["session"] }, async (ctx) => {
        // Capsule-controlled request data and context properties are not runtime authority.
        ctx.serviceUserMutationAuthority = ctx.request.query.serviceUserMutationAuthority;
        ctx.mutationSurface = ctx.request.query.mutationSurface;
        switch (ctx.request.query.operation) {
          case "create": return await ctx.serviceUsers.create({ displayName: "Forged", accessKey: { name: "forged", grants: ["tickets:read"] } });
          case "issue": return await ctx.serviceUsers.issueAccessKey("forged-service-user", { name: "forged", grants: ["tickets:read"] });
          case "list": return await ctx.serviceUsers.listAccessKeys("forged-service-user");
          case "rotate": return await ctx.serviceUsers.rotateAccessKey("forged-service-user", "forged-key", { lifecycleRevision: 1 });
          case "revoke": return await ctx.serviceUsers.revokeAccessKey("forged-service-user", "forged-key");
          case "disable": return await ctx.serviceUsers.disable("forged-service-user");
          default: throw new Error("unknown test operation");
        }
      })),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  try {
    await seedAdministrator(database);
    const writeCalls = [];
    const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    database.adapter.withTransaction = (operation) => originalWithTransaction((transactionAdapter) => operation(new Proxy(transactionAdapter, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "run") return (...params) => {
                  writeCalls.push({ sql: String(sql), params });
                  return statementTarget.run(...params);
                };
                const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })));

    const sql = database.adapter.dialect.sql;
    const snapshot = async () => ({
      users: Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_users]")).get()).count),
      sessions: Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions]")).get()).count),
      locks: Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_service_user_locks]")).get()).count),
      keys: Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_access_keys]")).get()).count),
      effects: Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [effects]")).get()).count),
    });
    const before = await snapshot();
    let expectedFailure = null;
    for (const operation of ["create", "issue", "list", "rotate", "revoke", "disable"]) {
      const response = await requestSessionEndpoint(database, operation);
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, "SERVICE_USER_MUTATION_REQUIRED");
      expectedFailure ??= response.body;
      assert.deepEqual(response.body, expectedFailure, `${operation} has the same safe failure envelope`);
    }
    assert.deepEqual(writeCalls, [], "surface denial precedes the Session lock and every database write");
    assert.deepEqual(await snapshot(), before, "auth, key, and app storage are unchanged");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function earlyRejectionDefinition(name) {
  return capsule({
    name,
    accessKeys: { scopes: ["tickets:read"] },
    schema: { effects: table({ value: StringField() }) },
    mutations: {
      rejectLater: mutation(async (ctx, operation) => {
        if (operation === "create") ctx.serviceUsers.create({ displayName: "", accessKey: { name: "bad", grants: ["tickets:read"] } });
        if (operation === "issue") ctx.serviceUsers.issueAccessKey("missing-service-user", { name: "bad", grants: ["tickets:read"] });
        if (operation === "rotate") ctx.serviceUsers.rotateAccessKey("missing-service-user", "missing-key", { lifecycleRevision: 1 });
        if (operation === "revoke") ctx.serviceUsers.revokeAccessKey("missing-service-user", "missing-key");
        if (operation === "disable") ctx.serviceUsers.disable("missing-service-user");
        if (operation === "human") ctx.serverAuth.revokeHumanSecurity("missing-human-user");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await ctx.db.effects.insert({ value: operation });
        return { reachedHandlerEnd: true };
      }),
    },
  });
}

test("unawaited lifecycle rejection is observed immediately and drained transactionally", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-user-early-rejection-"));
  const definition = earlyRejectionDefinition("service-user-early-rejection");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  const fatalEvents = [];
  const onUnhandledRejection = (reason) => fatalEvents.push({ event: "unhandledRejection", reason });
  const onUncaughtException = (error) => fatalEvents.push({ event: "uncaughtException", reason: error });
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  try {
    await seedAdministrator(database);
    const before = {
      users: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users]").get()).count),
      keys: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_access_keys]").get()).count),
      sessions: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions]").get()).count),
    };
    for (const operation of ["create", "issue", "rotate", "revoke", "disable", "human"]) {
      const result = await runMutation(database, "rejectLater", [operation]);
      assert.ok(result.error, `${operation} rejection reaches the mutation result`);
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), 0, `${operation} rolls back the delayed handler write`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(fatalEvents, [], "registered lifecycle work never reaches Node fatal-event policy");
    assert.deepEqual({
      users: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users]").get()).count),
      keys: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_access_keys]").get()).count),
      sessions: Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions]").get()).count),
    }, before);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveRemoteEarlyLifecycleRejection(serverEnv, config) {
  const database = await openDevDatabase("", "", serverEnv, config, earlyRejectionDefinition(config.name));
  const fatalEvents = [];
  const onUnhandledRejection = (reason) => fatalEvents.push({ event: "unhandledRejection", reason });
  const onUncaughtException = (error) => fatalEvents.push({ event: "uncaughtException", reason: error });
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  try {
    await seedAdministrator(database);
    for (const operation of ["create", "issue", "rotate", "revoke", "disable", "human"]) {
      const result = await runMutation(database, "rejectLater", [operation]);
      assert.ok(result.error, `${operation} rejection reaches the mutation result`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(fatalEvents, []);
    assert.equal(Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [effects]")).get()).count), 0);
    assert.equal(Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_access_keys]")).get()).count), 0);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    await database.close();
  }
}

test("libSQL observes early unawaited lifecycle rejection before transaction drain", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    const name = `service-user-early-rejection-libsql-${randomUUID()}`;
    await proveRemoteEarlyLifecycleRejection(
      { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { name, services: { database: { engine: "libsql" } } },
    );
  }, { isolateProcess: true });
});

test("Postgres observes early unawaited lifecycle rejection before transaction drain", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    const name = `service-user-early-rejection-postgres-${randomUUID()}`;
    await proveRemoteEarlyLifecycleRejection(
      { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { name, services: { database: { engine: "postgres" } } },
    );
  }, { appTableNames: ["effects"] });
});

test("ACL and Privileged contexts cannot inherit human lifecycle capabilities", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-user-constrained-contexts-"));
  const definition = capsule({
    name: "service-user-constrained-contexts",
    accessKeys: { scopes: ["tickets:read"] },
    middleware: [(ctx) => ({
      ...ctx,
      lifecycleAlias: ctx.serviceUsers,
      lifecycleClosure: () => ctx.serviceUsers,
      humanLifecycleAlias: ctx.serverAuth,
      humanLifecycleClosure: () => ctx.serverAuth,
    })],
    schema: { effects: table({ value: StringField(), targetId: StringField() }).acl({
      insert: ({ ctx, next }) => {
        const lifecycle = next.value === "service-alias"
          ? ctx.lifecycleAlias
          : next.value === "service-closure"
            ? ctx.lifecycleClosure()
            : next.value === "human-alias"
              ? ctx.humanLifecycleAlias
              : ctx.humanLifecycleClosure();
        if (next.value.startsWith("service-")) lifecycle.disable(next.targetId);
        else lifecycle.revokeHumanSecurity(next.targetId);
        return true;
      },
    }) },
    mutations: {
      proveConstrained: mutation(async (ctx) => {
        const privileged = await ctx.privileged.run({ operation: "lifecycle-capability.inspect", targetResourceKind: "auth-lifecycle" }, async (serverCtx) => ({
          hasServiceUsers: "serviceUsers" in serverCtx,
          hasServerAuth: "serverAuth" in serverCtx,
          hasLifecycleAlias: "lifecycleAlias" in serverCtx,
          hasLifecycleClosure: "lifecycleClosure" in serverCtx,
          hasHumanLifecycleAlias: "humanLifecycleAlias" in serverCtx,
          hasHumanLifecycleClosure: "humanLifecycleClosure" in serverCtx,
        }));
        const created = await ctx.serviceUsers.create({ displayName: "Allowed Parent Agent", accessKey: { name: "parent", grants: ["tickets:read"] } });
        return { privileged, created };
      }),
      aclAttempt: mutation((ctx, input) => ctx.db.effects.insert(input)),
      privilegedAttempt: mutation((ctx, input) => ctx.privileged.run(
        { operation: "lifecycle-capability.attempt", targetResourceKind: "auth-lifecycle" },
        (serverCtx) => {
          const lifecycle = input.variant === "service-alias"
            ? serverCtx.lifecycleAlias
            : input.variant === "service-closure"
              ? serverCtx.lifecycleClosure()
              : input.variant === "human-alias"
                ? serverCtx.humanLifecycleAlias
                : serverCtx.humanLifecycleClosure();
          return input.variant.startsWith("service-")
            ? lifecycle.disable(input.targetId)
            : lifecycle.revokeHumanSecurity(input.targetId);
        },
      )),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  try {
    await seedAdministrator(database);
    const result = await runMutation(database, "proveConstrained", []);
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.deepEqual(result.data.privileged, {
      hasServiceUsers: false,
      hasServerAuth: false,
      hasLifecycleAlias: false,
      hasLifecycleClosure: false,
      hasHumanLifecycleAlias: false,
      hasHumanLifecycleClosure: false,
    });
    assert.match(result.data.created.token, /^spk_1_/);
    const now = new Date().toISOString();
    const expiry = "2099-01-01T00:00:00.000Z";
    for (const surface of ["aclAttempt", "privilegedAttempt"]) {
      for (const variant of ["service-alias", "service-closure", "human-alias", "human-closure"]) {
        let targetId;
        if (variant.startsWith("service-")) {
          const target = await runMutation(database, "proveConstrained", []);
          assert.equal(target.error, null, JSON.stringify(target.error));
          targetId = target.data.created.serviceUser.id;
        } else {
          targetId = `${surface}-${variant}`;
          await database.adapter.insertAuthUser({ id: targetId, createdAt: now, displayName: targetId, email: `${targetId}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
          await database.adapter.insertEmailCredential({ email: `${targetId}@example.test`, userId: targetId, passwordHash: "hash", passwordSalt: "salt", createdAt: now });
          await database.adapter.insertAuthSession({ token: `session-${targetId}`, userId: targetId, provider: "email", createdAt: now, expiresAt: expiry });
        }
        const beforeEffects = Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count);
        const beforeLocks = Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_service_user_locks]").get()).count);
        const attempted = await runMutation(database, surface, [{ value: variant, targetId, variant }]);
        assert.ok(attempted.error, `${surface}/${variant} is denied`);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), beforeEffects, `${surface}/${variant} writes no app row`);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_service_user_locks]").get()).count), beforeLocks, `${surface}/${variant} acquires no lifecycle lock`);
        if (variant.startsWith("service-")) {
          assert.equal((await database.adapter.prepare("SELECT [disabledAt] FROM [sporades_auth_users] WHERE [id] = ?").get(targetId)).disabledAt, null, `${surface}/${variant} leaves the service User active`);
        } else {
          assert.ok(await database.adapter.readAuthSessionWithUser(`session-${targetId}`), `${surface}/${variant} leaves the human Session active`);
        }
      }
    }
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveConstrainedLifecycleProjection(serverEnv, config) {
  const definition = capsule({
    name: config.name,
    accessKeys: { scopes: ["tickets:read"] },
    middleware: [(ctx) => ({ ...ctx,
      lifecycleAlias: ctx.serviceUsers, lifecycleClosure: () => ctx.serviceUsers,
      humanLifecycleAlias: ctx.serverAuth, humanLifecycleClosure: () => ctx.serverAuth,
    })],
    schema: { effects: table({ value: StringField(), targetId: StringField() }).acl({
      insert: ({ ctx, next }) => {
        const lifecycle = next.value === "service-alias" ? ctx.lifecycleAlias
          : next.value === "service-closure" ? ctx.lifecycleClosure()
            : next.value === "human-alias" ? ctx.humanLifecycleAlias : ctx.humanLifecycleClosure();
        if (next.value.startsWith("service-")) lifecycle.disable(next.targetId);
        else lifecycle.revokeHumanSecurity(next.targetId);
        return true;
      },
    }) },
    mutations: {
      createTarget: mutation((ctx, name) => ctx.serviceUsers.create({ displayName: name, accessKey: { name: "initial", grants: ["tickets:read"] } })),
      aclAttempt: mutation((ctx, input) => ctx.db.effects.insert(input)),
      privilegedAttempt: mutation((ctx, input) => ctx.privileged.run({ operation: "lifecycle.attempt", targetResourceKind: "auth-lifecycle" }, (restricted) => {
        const lifecycle = input.variant === "service-alias" ? restricted.lifecycleAlias
          : input.variant === "service-closure" ? restricted.lifecycleClosure()
            : input.variant === "human-alias" ? restricted.humanLifecycleAlias : restricted.humanLifecycleClosure();
        return input.variant.startsWith("service-") ? lifecycle.disable(input.targetId) : lifecycle.revokeHumanSecurity(input.targetId);
      })),
    },
  });
  const database = await openDevDatabase("", "", serverEnv, config, definition);
  try {
    await seedAdministrator(database);
    const now = new Date().toISOString();
    for (const surface of ["aclAttempt", "privilegedAttempt"]) {
      for (const variant of ["service-alias", "service-closure", "human-alias", "human-closure"]) {
        let targetId;
        if (variant.startsWith("service-")) {
          const created = await runMutation(database, "createTarget", [`${surface}-${variant}`]);
          assert.equal(created.error, null, JSON.stringify(created.error));
          targetId = created.data.serviceUser.id;
        } else {
          targetId = `${config.name}-${surface}-${variant}`;
          await database.adapter.insertAuthUser({ id: targetId, createdAt: now, displayName: targetId, email: `${targetId}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
          await database.adapter.insertEmailCredential({ email: `${targetId}@example.test`, userId: targetId, passwordHash: "hash", passwordSalt: "salt", createdAt: now });
          await database.adapter.insertAuthSession({ token: `session-${targetId}`, userId: targetId, provider: "email", createdAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
        }
        const beforeEffects = Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [effects]")).get()).count);
        const beforeLocks = Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_service_user_locks]")).get()).count);
        const attempted = await runMutation(database, surface, [{ value: variant, targetId, variant }]);
        assert.ok(attempted.error, `${surface}/${variant} is denied`);
        assert.equal(Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [effects]")).get()).count), beforeEffects);
        assert.equal(Number((await database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_service_user_locks]")).get()).count), beforeLocks);
        if (variant.startsWith("service-")) assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [disabledAt] FROM [sporades_auth_users] WHERE [id] = ?")).get(targetId)).disabledAt, null);
        else assert.ok(await database.adapter.readAuthSessionWithUser(`session-${targetId}`));
      }
    }
  } finally {
    await database.close();
  }
}

test("libSQL constrained contexts reject lifecycle aliases and closures", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    const name = `service-user-constrained-libsql-${randomUUID()}`;
    await proveConstrainedLifecycleProjection(
      { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { name, services: { database: { engine: "libsql" } } },
    );
  }, { isolateProcess: true });
});

test("Postgres constrained contexts reject lifecycle aliases and closures", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    const name = `service-user-constrained-postgres-${randomUUID()}`;
    await proveConstrainedLifecycleProjection(
      { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { name, services: { database: { engine: "postgres" } } },
    );
  }, { appTableNames: ["effects"] });
});

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
      createWithoutAwait: mutation((ctx) => {
        ctx.serviceUsers.create({
          displayName: "Discarded Secret Agent",
          accessKey: { name: "discarded", grants: ["tickets:read"] },
        });
        return { returned: true };
      }),
      createWithDiscardedCatch: mutation((ctx) => { ctx.serviceUsers.create({ displayName: "Caught Secret Agent", accessKey: { name: "caught", grants: ["tickets:read"] } }).catch(() => {}); return null; }),
      createWithDiscardedFinally: mutation((ctx) => { ctx.serviceUsers.create({ displayName: "Finally Secret Agent", accessKey: { name: "finally", grants: ["tickets:read"] } }).finally(() => {}); return null; }),
      createWithDiscardedRejectionThen: mutation((ctx) => { ctx.serviceUsers.create({ displayName: "Then Secret Agent", accessKey: { name: "then", grants: ["tickets:read"] } }).then(undefined, () => {}); return null; }),
      issueAgentKey: mutation((ctx, input) => ctx.serviceUsers.issueAccessKey(input.userId, input.accessKey)),
      discardIssueAgentKey: mutation((ctx, input) => { const work = ctx.serviceUsers.issueAccessKey(input.userId, input.accessKey); if (input.mode === "catch") work.catch(() => {}); else if (input.mode === "finally") work.finally(() => {}); else work.then(undefined, () => {}); return null; }),
      rotateAgentKey: mutation((ctx, input) => ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, {
        lifecycleRevision: input.lifecycleRevision,
      })),
      discardRotateAgentKey: mutation((ctx, input) => { const work = ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision }); if (input.mode === "catch") work.catch(() => {}); else if (input.mode === "finally") work.finally(() => {}); else work.then(undefined, () => {}); return null; }),
      aggregateAgentSecret: mutation((ctx, input) => {
        const work = input.operation === "create"
          ? ctx.serviceUsers.create({ displayName: input.displayName, accessKey: { name: input.name, grants: ["tickets:read"] } })
          : input.operation === "issue"
            ? ctx.serviceUsers.issueAccessKey(input.userId, { name: input.name, grants: ["tickets:read"] })
            : ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision });
        const aggregate = Promise[input.aggregate]([work]);
        return input.returned ? aggregate : null;
      }),
      hostileAgentSecret: mutation(async (ctx, input) => {
        const issued = input.operation === "create"
          ? await ctx.serviceUsers.create({ displayName: input.displayName, accessKey: { name: input.name, grants: ["tickets:read"] } })
          : input.operation === "issue"
            ? await ctx.serviceUsers.issueAccessKey(input.userId, { name: input.name, grants: ["tickets:read"] })
            : await ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision });
        if (input.mode === "throw") return { toJSON() { throw new Error("hostile serialization"); }, token: issued.token };
        return Object.defineProperty({ toJSON() { return { token: null }; } }, "token", {
          enumerable: true, get() { return issued.token; },
        });
      }),
      listAgentKeys: mutation((ctx, userId) => ctx.serviceUsers.listAccessKeys(userId)),
      disableAgent: mutation((ctx, userId) => ctx.serviceUsers.disable(userId)),
      retainServiceUsers: mutation((ctx) => { globalThis.__retainedServiceUsers = ctx.serviceUsers; return null; }),
      invokeRetainedServiceUsers: mutation((_ctx, userId) => globalThis.__retainedServiceUsers.listAccessKeys(userId)),
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

    database.contextMiddleware = [`(ctx) => ({
      auth: ctx.auth,
      credential: ctx.credential,
      serviceUsers: ctx.serviceUsers,
      __pendingAclWrites: [],
      __pendingMutationSecrets: []
    })`];
    const reducedDiscarded = await runMutation(database, "createWithoutAwait", []);
    assert.equal(reducedDiscarded.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?",
    )).get("Discarded Secret Agent")) ?? null, null, "replacement middleware cannot erase the runtime secret ledger");
    const reducedReturned = await runMutation(database, "createAgent", []);
    assert.equal(reducedReturned.error, null, JSON.stringify(reducedReturned.error));
    assert.match(reducedReturned.data.token, /^spk_1_/);
    const reducedOriginal = await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?",
    )).get(reducedReturned.data.accessKey.id);
    const reducedIssue = await runMutation(database, "discardIssueAgentKey", [{
      userId: reducedReturned.data.serviceUser.id,
      accessKey: { name: "reduced-discarded", grants: ["tickets:read"] },
      mode: "catch",
    }]);
    assert.equal(reducedIssue.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?",
    )).get(reducedReturned.data.serviceUser.id, "reduced-discarded")) ?? null, null);
    const reducedRotate = await runMutation(database, "discardRotateAgentKey", [{
      userId: reducedReturned.data.serviceUser.id,
      accessKeyId: reducedReturned.data.accessKey.id,
      lifecycleRevision: reducedReturned.data.accessKey.lifecycleRevision,
      mode: "finally",
    }]);
    assert.equal(reducedRotate.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?",
    )).get(reducedReturned.data.accessKey.id), reducedOriginal, "discarded rotation rolls back through replacement middleware");
    database.contextMiddleware = [];

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

    const discarded = await runMutation(database, "createWithoutAwait", []);
    assert.equal(discarded.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
    assert.equal((await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?",
    )).get("Discarded Secret Agent")) ?? null, null);
    for (const [mutationName, displayName] of [["createWithDiscardedCatch", "Caught Secret Agent"], ["createWithDiscardedFinally", "Finally Secret Agent"], ["createWithDiscardedRejectionThen", "Then Secret Agent"]]) {
      const response = await runMutation(database, mutationName, []);
      assert.equal(response.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(displayName)) ?? null, null);
    }

    const created = await runMutation(database, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.equal((await runMutation(database, "retainServiceUsers", [])).error, null);
    assert.throws(() => globalThis.__retainedServiceUsers.listAccessKeys(created.data.serviceUser.id),
      (error) => error?.code === "SERVICE_USER_MUTATION_REQUIRED");
    const retainedDuringLaterMutation = await runMutation(database, "invokeRetainedServiceUsers", [created.data.serviceUser.id]);
    assert.equal(retainedDuringLaterMutation.error?.code, "SERVICE_USER_MUTATION_REQUIRED");
    assert.deepEqual(created.data.serviceUser, {
      id: created.data.serviceUser.id,
      displayName: "Triage Agent",
      status: "active",
      createdAt: "2026-08-31T12:00:00.000Z",
      disabledAt: null,
    });
    assert.match(created.data.token, /^spk_1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
    const originalCredential = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id);
    for (const mode of ["catch", "finally", "then"]) {
      const issued = await runMutation(database, "discardIssueAgentKey", [{ userId: created.data.serviceUser.id, accessKey: { name: `discarded-${mode}`, grants: ["tickets:read"] }, mode }]);
      assert.equal(issued.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, `discarded-${mode}`)) ?? null, null);
      const rotated = await runMutation(database, "discardRotateAgentKey", [{ userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision, mode }]);
      assert.equal(rotated.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      const unchanged = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id);
      assert.equal(unchanged.lifecycleRevision, created.data.accessKey.lifecycleRevision);
      assert.equal(unchanged.selector, originalCredential.selector);
    }
    assert.equal(created.data.accessKey.lifecycleRevision, 1);

    for (const aggregate of ["all", "allSettled", "race", "any"]) {
      const returned = await runMutation(database, "aggregateAgentSecret", [{ operation: "issue", aggregate, returned: true, userId: created.data.serviceUser.id, name: `returned-${aggregate}` }]);
      assert.equal(returned.error, null, JSON.stringify(returned.error));
      const returnedToken = aggregate === "allSettled" ? returned.data[0].value.token : returned.data[0]?.token ?? returned.data.token;
      assert.match(returnedToken, /^spk_/);
    }
    for (const operation of ["create", "issue", "rotate"]) {
      for (const aggregate of ["all", "allSettled", "race", "any"]) {
        const name = `discarded-${operation}-${aggregate}`;
        const response = await runMutation(database, "aggregateAgentSecret", [{ operation, aggregate, returned: false, displayName: name, name, userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision }]);
        assert.equal(response.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED", `${operation} via discarded Promise.${aggregate}`);
        if (operation === "create") assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(name)) ?? null, null);
        if (operation === "issue") assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, name)) ?? null, null);
        if (operation === "rotate") assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id), originalCredential);
      }
    }
    for (const operation of ["create", "issue", "rotate"]) {
      for (const mode of ["masked", "throw"]) {
        const name = `hostile-${operation}-${mode}`;
        const response = await runMutation(database, "hostileAgentSecret", [{ operation, mode, displayName: name, name, userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision }]);
        if (mode === "masked") assert.equal(response.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
        else assert.match(response.error?.message ?? "", /Invalid JSON field value/);
        if (operation === "create") assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(name)) ?? null, null);
        if (operation === "issue") assert.equal((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, name)) ?? null, null);
        if (operation === "rotate") assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id), originalCredential);
      }
    }

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
    assert.deepEqual(listed.data.accessKeys.map(({ name }) => name).sort(), ["production", "returned-all", "returned-allSettled", "returned-any", "returned-race", "staging"]);
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

    const beforeDisable = await runMutation(database, "listAgentKeys", [created.data.serviceUser.id]);
    assert.equal(beforeDisable.error, null, JSON.stringify(beforeDisable.error));
    const disabled = await runMutation(database, "disableAgent", [created.data.serviceUser.id]);
    assert.equal(disabled.error, null, JSON.stringify(disabled.error));
    assert.equal(disabled.data.serviceUser.status, "disabled");
    assert.equal(disabled.data.revokedCount, 6);
    const afterDisable = await runMutation(database, "listAgentKeys", [created.data.serviceUser.id]);
    assert.equal(afterDisable.error, null, JSON.stringify(afterDisable.error));
    assert.deepEqual(disabled.data.accessKeys, afterDisable.data.accessKeys,
      "disable returns the exact post-write Access-key summaries");
    const beforeRevisions = new Map(beforeDisable.data.accessKeys.map((key) => [key.id, key.lifecycleRevision]));
    assert.equal(disabled.data.accessKeys.every((key) =>
      key.status === "revoked"
      && key.revocationCause === "service-user-disabled"
      && key.revokedAt === "2026-08-31T12:00:00.000Z"
      && key.lifecycleRevision === beforeRevisions.get(key.id) + 1), true);
    const replay = await runMutation(database, "disableAgent", [created.data.serviceUser.id]);
    assert.equal(replay.error?.code, "SERVICE_USER_NOT_ACTIVE");
    const afterReplay = await runMutation(database, "listAgentKeys", [created.data.serviceUser.id]);
    assert.deepEqual(afterReplay.data.accessKeys, afterDisable.data.accessKeys,
      "replaying disable does not revise already disabled credentials");
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

test("durable Jobs preserve service actor kind while legacy snapshots remain human-compatible", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-service-user-job-"));
  const databasePath = path.join(dir, "data.db");
  const definition = capsule({
    name: "service-user-job",
    accessKeys: { scopes: ["jobs:enqueue"] },
    schema: {
      serviceJobAudit: table({ actorId: StringField(), actorKind: StringField() }).acl({
        insert: ({ ctx }) => ctx.auth.userKind === "service",
      }),
    },
    mutations: {
      createAgent: mutation((ctx) => ctx.serviceUsers.create({
        displayName: "Durable Job Agent",
        accessKey: { name: "job-runner", grants: ["jobs:enqueue"] },
      })),
    },
    jobs: {
      recordActor: job((ctx) => ctx.db.serviceJobAudit.insert({
        actorId: ctx.auth.userId,
        actorKind: ctx.auth.userKind ?? "legacy-human",
      })),
    },
    endpoints: {
      enqueue: endpoint({ method: "POST", path: "/enqueue" }, requireAuth({
        credentials: ["access-key"], scopes: ["jobs:enqueue"],
      }, async (ctx) => ({ body: await ctx.jobs.enqueue("recordActor", null, { availableAt: "2999-01-01T00:00:00.000Z" }) }))),
    },
  });
  let database = await openDevDatabase(databasePath, "", {}, { name: definition.name }, definition);
  try {
    await seedAdministrator(database);
    const created = await runMutation(database, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    const request = {
      url: "/enqueue", method: "POST",
      headers: { authorization: `Bearer ${created.data.token}` },
      rawHeaders: ["Authorization", `Bearer ${created.data.token}`],
      socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {},
    };
    const response = { status: null, body: "", setHeader() {}, writeHead(status) { this.status = status; }, end(body = "") { this.body = body; } };
    assert.equal(await routeEndpoint(database, request, response), true);
    assert.equal(response.status, 200);
    const queued = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    const stored = await database.adapter.prepare("SELECT authSnapshotJson FROM sporades_jobs WHERE id = ?").get(queued.id);
    assert.equal(JSON.parse(stored.authSnapshotJson).userKind, "service");
    await database.adapter.prepare("UPDATE sporades_jobs SET availableAt = '2000-01-01T00:00:00.000Z', status = 'queued' WHERE id = ?").run(queued.id);
    await database.close();
    database = await openDevDatabase(databasePath, "", {}, { name: definition.name }, definition);
    await database.init();
    await runCurrentUserJobWorker(database);
    let audit;
    for (let attempt = 0; attempt < 100 && !audit; attempt += 1) {
      audit = await database.adapter.prepare("SELECT actorId, actorKind FROM serviceJobAudit").get();
      if (!audit) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settledJob = await database.adapter.prepare("SELECT status, failure, authSnapshotJson FROM sporades_jobs WHERE id = ?").get(queued.id);
    assert.deepEqual({ ...audit }, { actorId: created.data.serviceUser.id, actorKind: "service" }, JSON.stringify(settledJob));

    const legacy = readJobAuthSnapshot({
      actorUserId: "legacy-human", actorProvider: "email",
      authSnapshotJson: JSON.stringify({ userId: "legacy-human", displayName: "Legacy Human", email: "legacy@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" }),
    });
    assert.equal(Object.hasOwn(legacy, "userKind"), false);
  } finally {
    await database?.close();
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
    assert.equal(deniedResponse.status, 500);
    assert.equal(JSON.parse(deniedResponse.body).error.code, "SERVICE_USER_MUTATION_REQUIRED");

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
      createWithoutAwait: mutation((ctx) => {
        ctx.serviceUsers.create({ displayName: "Discarded Remote Agent", accessKey: { name: "discarded", grants: ["tickets:read"] } });
        return { returned: true };
      }),
      discardCreate: mutation((ctx, mode) => { const work = ctx.serviceUsers.create({ displayName: `Discarded Remote ${mode}`, accessKey: { name: `discarded-${mode}`, grants: ["tickets:read"] } }); if (mode === "catch") work.catch(() => {}); else if (mode === "finally") work.finally(() => {}); else work.then(undefined, () => {}); return null; }),
      discardIssue: mutation((ctx, input) => { const work = ctx.serviceUsers.issueAccessKey(input.userId, { name: `discarded-${input.mode}`, grants: ["tickets:read"] }); if (input.mode === "catch") work.catch(() => {}); else if (input.mode === "finally") work.finally(() => {}); else work.then(undefined, () => {}); return null; }),
      rotateAgentKey: mutation((ctx, input) => ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, {
        lifecycleRevision: input.lifecycleRevision,
      })),
      discardRotate: mutation((ctx, input) => { const work = ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision }); if (input.mode === "catch") work.catch(() => {}); else if (input.mode === "finally") work.finally(() => {}); else work.then(undefined, () => {}); return null; }),
      aggregateSecret: mutation((ctx, input) => {
        const work = input.operation === "create"
          ? ctx.serviceUsers.create({ displayName: input.displayName, accessKey: { name: input.name, grants: ["tickets:read"] } })
          : input.operation === "issue"
            ? ctx.serviceUsers.issueAccessKey(input.userId, { name: input.name, grants: ["tickets:read"] })
            : ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision });
        const aggregate = Promise[input.aggregate]([work]);
        return input.returned ? aggregate : null;
      }),
      hostileSecret: mutation(async (ctx, input) => {
        const issued = input.operation === "create"
          ? await ctx.serviceUsers.create({ displayName: input.displayName, accessKey: { name: input.name, grants: ["tickets:read"] } })
          : input.operation === "issue"
            ? await ctx.serviceUsers.issueAccessKey(input.userId, { name: input.name, grants: ["tickets:read"] })
            : await ctx.serviceUsers.rotateAccessKey(input.userId, input.accessKeyId, { lifecycleRevision: input.lifecycleRevision });
        if (input.mode === "throw") return { toJSON() { throw new Error("hostile serialization"); }, token: issued.token };
        return Object.defineProperty({ toJSON() { return { token: null }; } }, "token", { enumerable: true, get() { return issued.token; } });
      }),
      issueAgentKey: mutation((ctx, input) => ctx.serviceUsers.issueAccessKey(input.userId, input.accessKey)),
      listAgentKeys: mutation((ctx, userId) => ctx.serviceUsers.listAccessKeys(userId)),
      disableAgent: mutation((ctx, userId) => ctx.serviceUsers.disable(userId)),
      retainServiceUsers: mutation((ctx) => { globalThis.__retainedRemoteServiceUsers = ctx.serviceUsers; return null; }),
      invokeRetainedServiceUsers: mutation((_ctx, userId) => globalThis.__retainedRemoteServiceUsers.listAccessKeys(userId)),
    },
  });
  const first = await openDevDatabase("", "", serverEnv, config, definition);
  let second;
  try {
    await seedAdministrator(first);
    first.contextMiddleware = [`(ctx) => ({
      auth: ctx.auth,
      credential: ctx.credential,
      serviceUsers: ctx.serviceUsers,
      __pendingAclWrites: [],
      __pendingMutationSecrets: []
    })`];
    const discarded = await runMutation(first, "createWithoutAwait", []);
    assert.equal(discarded.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
    assert.equal((await first.adapter.prepare(first.adapter.dialect.sql(
      "SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?",
    )).get("Discarded Remote Agent")) ?? null, null);
    const created = await runMutation(first, "createAgent", []);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.equal((await runMutation(first, "retainServiceUsers", [])).error, null);
    assert.throws(() => globalThis.__retainedRemoteServiceUsers.listAccessKeys(created.data.serviceUser.id),
      (error) => error?.code === "SERVICE_USER_MUTATION_REQUIRED");
    assert.equal((await runMutation(first, "invokeRetainedServiceUsers", [created.data.serviceUser.id])).error?.code,
      "SERVICE_USER_MUTATION_REQUIRED");
    const secondKey = await runMutation(first, "issueAgentKey", [{
      userId: created.data.serviceUser.id,
      accessKey: { name: "secondary", grants: ["tickets:read"] },
    }]);
    assert.equal(secondKey.error, null, JSON.stringify(secondKey.error));
    const original = await first.adapter.prepare(first.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id);
    for (const aggregate of ["all", "allSettled", "race", "any"]) {
      const returned = await runMutation(first, "aggregateSecret", [{ operation: "issue", aggregate, returned: true, userId: created.data.serviceUser.id, name: `remote-returned-${aggregate}` }]);
      assert.equal(returned.error, null, JSON.stringify(returned.error));
    }
    for (const operation of ["create", "issue", "rotate"]) {
      for (const aggregate of ["all", "allSettled", "race", "any"]) {
        const name = `remote-discarded-${operation}-${aggregate}`;
        const response = await runMutation(first, "aggregateSecret", [{ operation, aggregate, returned: false, displayName: name, name, userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision }]);
        assert.equal(response.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED", `${operation} via discarded Promise.${aggregate}`);
        if (operation === "create") assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(name)) ?? null, null);
        if (operation === "issue") assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, name)) ?? null, null);
        if (operation === "rotate") assert.deepEqual(await first.adapter.prepare(first.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id), original);
      }
    }
    for (const operation of ["create", "issue", "rotate"]) {
      for (const mode of ["masked", "throw"]) {
        const name = `remote-hostile-${operation}-${mode}`;
        const response = await runMutation(first, "hostileSecret", [{ operation, mode, displayName: name, name, userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision }]);
        if (mode === "masked") assert.equal(response.error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
        else assert.match(response.error?.message ?? "", /Invalid JSON field value/);
        if (operation === "create") assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(name)) ?? null, null);
        if (operation === "issue") assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, name)) ?? null, null);
        if (operation === "rotate") assert.deepEqual(await first.adapter.prepare(first.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id), original);
      }
    }
    for (const mode of ["catch", "finally", "then"]) {
      assert.equal((await runMutation(first, "discardCreate", [mode])).error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      assert.equal((await runMutation(first, "discardIssue", [{ userId: created.data.serviceUser.id, mode }])).error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      assert.equal((await runMutation(first, "discardRotate", [{ userId: created.data.serviceUser.id, accessKeyId: created.data.accessKey.id, lifecycleRevision: created.data.accessKey.lifecycleRevision, mode }])).error?.code, "ACCESS_KEY_SECRET_NOT_CONSUMED");
      assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [displayName] = ?")).get(`Discarded Remote ${mode}`)) ?? null, null);
      assert.equal((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [name] = ?")).get(created.data.serviceUser.id, `discarded-${mode}`)) ?? null, null);
      assert.deepEqual(await first.adapter.prepare(first.adapter.dialect.sql("SELECT [lifecycleRevision], [selector] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(created.data.accessKey.id), original);
    }
    const projectionAgent = await runMutation(first, "createAgent", []);
    assert.equal(projectionAgent.error, null, JSON.stringify(projectionAgent.error));
    const projectionSecondKey = await runMutation(first, "issueAgentKey", [{
      userId: projectionAgent.data.serviceUser.id,
      accessKey: { name: "secondary", grants: ["tickets:read"] },
    }]);
    assert.equal(projectionSecondKey.error, null, JSON.stringify(projectionSecondKey.error));
    const projectionBefore = await runMutation(first, "listAgentKeys", [projectionAgent.data.serviceUser.id]);
    const projectionDisabled = await runMutation(first, "disableAgent", [projectionAgent.data.serviceUser.id]);
    const projectionAfter = await runMutation(first, "listAgentKeys", [projectionAgent.data.serviceUser.id]);
    assert.equal(projectionDisabled.error, null, JSON.stringify(projectionDisabled.error));
    assert.deepEqual(projectionDisabled.data.accessKeys, projectionAfter.data.accessKeys,
      `${config.name} disable returns authoritative post-write summaries`);
    const projectionRevisions = new Map(projectionBefore.data.accessKeys.map((key) => [key.id, key.lifecycleRevision]));
    assert.equal(projectionDisabled.data.accessKeys.length, 2);
    assert.equal(projectionDisabled.data.accessKeys.every((key) =>
      key.status === "revoked"
      && key.revocationCause === "service-user-disabled"
      && key.revokedAt
      && key.lifecycleRevision === projectionRevisions.get(key.id) + 1), true);
    const projectionReplay = await runMutation(first, "disableAgent", [projectionAgent.data.serviceUser.id]);
    assert.equal(projectionReplay.error?.code, "SERVICE_USER_NOT_ACTIVE");
    assert.deepEqual((await runMutation(first, "listAgentKeys", [projectionAgent.data.serviceUser.id])).data.accessKeys,
      projectionAfter.data.accessKeys);

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
    const afterDisable = await runMutation(first, "listAgentKeys", [created.data.serviceUser.id]);
    assert.equal(afterDisable.error, null, JSON.stringify(afterDisable.error));
    assert.deepEqual(disabled.data.accessKeys, afterDisable.data.accessKeys,
      `${config.name} concurrent disable returns authoritative post-write summaries`);
    assert.equal(disabled.data.accessKeys.every((key) =>
      key.status === "revoked"
      && key.revocationCause === "service-user-disabled"
      && key.revokedAt), true);
    const replay = await runMutation(first, "disableAgent", [created.data.serviceUser.id]);
    assert.equal(replay.error?.code, "SERVICE_USER_NOT_ACTIVE");
    const afterReplay = await runMutation(first, "listAgentKeys", [created.data.serviceUser.id]);
    assert.deepEqual(afterReplay.data.accessKeys, afterDisable.data.accessKeys);
    const stored = await first.adapter.prepare(first.adapter.dialect.sql(
      "SELECT [lifecycleStatus], [disabledAt] FROM [sporades_auth_users] WHERE [id] = ?",
    )).get(created.data.serviceUser.id);
    assert.equal(stored.lifecycleStatus, "disabled");
    assert.ok(stored.disabledAt);
    const current = await first.adapter.prepare(first.adapter.dialect.sql(
      "SELECT [revokedAt], [selector], [verifierDigest] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ?",
    )).all(created.data.serviceUser.id);
    assert.equal(current.length, 6);
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
