import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capsule, endpoint, message, mutation, query, String as Text, table } from "../dist/server.js";
import { openDevDatabase, runAppMessage, runEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter } from "./support/database-adapter-engines.js";

const actor = { userId: "administrator", displayName: "Administrator", email: "admin@example.test", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
const definition = capsule({ name: "human-security-transition", schema: { effects: table({ value: Text() }) }, mutations: {
  revoke: mutation(async (ctx, userId) => { const result = await ctx.serverAuth.revokeHumanSecurity(userId); await ctx.db.effects.insert({ value: userId }); return result; }),
  rollback: mutation(async (ctx, userId) => { await ctx.serverAuth.revokeHumanSecurity(userId); await ctx.db.effects.insert({ value: "rolled-back" }); throw new Error("force rollback"); }),
  revokeWithoutAwait: mutation(async (ctx, userId) => { ctx.serverAuth.revokeHumanSecurity(userId); await ctx.db.effects.insert({ value: `unawaited:${userId}` }); return { queued: true }; }),
  rollbackWithoutAwait: mutation((ctx, userId) => { ctx.serverAuth.revokeHumanSecurity(userId); throw new Error("force unawaited rollback"); }),
  retainServerAuth: mutation((ctx) => { globalThis.__retainedServerAuth = ctx.serverAuth; return null; }),
  invokeRetainedServerAuth: mutation((_ctx, userId) => globalThis.__retainedServerAuth.revokeHumanSecurity(userId)),
  retainAwaitThenRevoke: mutation(async (ctx, input) => {
    globalThis.__retainedServerAuth = ctx.serverAuth;
    globalThis.__retainedCapabilityReady?.();
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    return await ctx.serverAuth.revokeHumanSecurity(input.legitimateTargetId);
  }),
}, messages: {
  revokeAwaited: message(async (ctx, userId) => await ctx.serverAuth.revokeHumanSecurity(userId)),
  revokeWithoutAwait: message((ctx, userId) => { ctx.serverAuth.revokeHumanSecurity(userId); return { queued: true }; }),
}, endpoints: {
  revokeAwaited: endpoint({ method: "POST", path: "/revoke-awaited" }, async (ctx) => await ctx.serverAuth.revokeHumanSecurity("human-message")),
  revokeWithoutAwait: endpoint({ method: "POST", path: "/revoke-unawaited" }, (ctx) => { ctx.serverAuth.revokeHumanSecurity("human-message"); return { queued: true }; }),
  invokeRetained: endpoint({ method: "POST", path: "/invoke-retained" }, () => globalThis.__retainedServerAuth.revokeHumanSecurity("human-overlap-exploit")),
}, queries: {
  invokeRetained: query((_ctx, userId) => globalThis.__retainedServerAuth.revokeHumanSecurity(userId)),
} });

test("human security transition revokes Sessions and Access keys with the enclosing mutation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-human-security-")); const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 3600000).toISOString();
  const seed = async (suffix) => {
    const userId = `human-${suffix}`; await database.adapter.insertAuthUser({ id: userId, createdAt: now, displayName: userId, email: `${suffix}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertEmailCredential({ email: `${suffix}@example.test`, userId, passwordHash: `hash-${suffix}`, passwordSalt: `salt-${suffix}`, createdAt: now });
    await database.adapter.insertAuthSession({ token: `session-${suffix}`, userId, provider: "email", createdAt: now, expiresAt: expiry });
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id: `key-${suffix}`, ownerUserId: userId, name: "human key", reservedName: "human key", grantsJson: "[]", secretVersion: 1, selector: `selector-${suffix}`, verifierDigest: `digest-${suffix}`, lifecycleRevision: 1, createdAt: now, expiresAt: null })), { status: "issued" }); return userId;
  };
  try {
    await database.adapter.insertAuthUser({ id: actor.userId, createdAt: now, displayName: actor.displayName, email: actor.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "actor-session", userId: actor.userId, provider: "email", createdAt: now, expiresAt: expiry });
    const messageTarget = await seed("message");
    const messageKeyBefore = await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-message");
    const ownerBefore = await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(messageTarget);
    const awaitedMessage = await runAppMessage(database, actor, "revokeAwaited", messageTarget, { sessionToken: "actor-session" });
    assert.equal(awaitedMessage.error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const unawaitedMessage = await runAppMessage(database, actor, "revokeWithoutAwait", messageTarget, { sessionToken: "actor-session" });
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unawaitedMessage.error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.deepEqual(unhandled, []);
    assert.ok(await database.adapter.readAuthSessionWithUser("session-message"));
    assert.deepEqual(await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-message"), messageKeyBefore);
    assert.deepEqual(await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(messageTarget), ownerBefore);
    const endpointRequest = () => Object.assign(Readable.from([]), { method: "POST", headers: { cookie: "session=actor-session" } });
    const overlapExploit = await seed("overlap-exploit");
    const overlapLegitimate = await seed("overlap-legitimate");
    const overlapKeyBefore = await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-overlap-exploit");
    const overlapOwnerBefore = await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(overlapExploit);
    let signalOverlapReady;
    const overlapReady = new Promise((resolve) => { signalOverlapReady = resolve; });
    globalThis.__retainedCapabilityReady = signalOverlapReady;
    const activeMutation = runMutation(database, actor, "retainAwaitThenRevoke", [{ legitimateTargetId: overlapLegitimate, delayMs: 120 }], { sessionToken: "actor-session" });
    await overlapReady;
    assert.throws(() => globalThis.__retainedServerAuth.revokeHumanSecurity(overlapExploit),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runQuery(database, actor, "invokeRetained", [overlapExploit], { sessionToken: "actor-session" })).error?.code,
      "HUMAN_SECURITY_TRANSITION_DENIED");
    await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/invoke-retained"), new URL("http://capsule.test/invoke-retained"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runMutation(database, actor, "invokeRetainedServerAuth", [overlapExploit], { sessionToken: "actor-session" })).error?.code,
      "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await activeMutation).error, null, "the owning mutation resumes with its authority after await");
    assert.ok(await database.adapter.readAuthSessionWithUser("session-overlap-exploit"));
    assert.equal(await database.adapter.readAuthSessionWithUser("session-overlap-legitimate"), null);
    assert.deepEqual(await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-overlap-exploit"), overlapKeyBefore);
    assert.deepEqual(await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(overlapExploit), overlapOwnerBefore);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM effects").get()).count, 0);
    const awaitedEndpoint = database.endpoints.find((candidate) => candidate.options.path === "/revoke-awaited");
    const unawaitedEndpoint = database.endpoints.find((candidate) => candidate.options.path === "/revoke-unawaited");
    await assert.rejects(runEndpoint(database, awaitedEndpoint, new URL("http://capsule.test/revoke-awaited"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_UNAVAILABLE");
    const endpointUnhandled = [];
    const onEndpointUnhandled = (reason) => endpointUnhandled.push(reason);
    process.on("unhandledRejection", onEndpointUnhandled);
    await assert.rejects(runEndpoint(database, unawaitedEndpoint, new URL("http://capsule.test/revoke-unawaited"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_UNAVAILABLE");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onEndpointUnhandled);
    assert.deepEqual(endpointUnhandled, []);
    assert.ok(await database.adapter.readAuthSessionWithUser("session-message"));
    assert.deepEqual(await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-message"), messageKeyBefore);
    assert.deepEqual(await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(messageTarget), ownerBefore);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM effects").get()).count, 0);
    assert.equal((await runMutation(database, actor, "retainServerAuth", [], { sessionToken: "actor-session" })).error, null);
    assert.throws(() => globalThis.__retainedServerAuth.revokeHumanSecurity(messageTarget), (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    const retainedDuringLaterMutation = await runMutation(database, actor, "invokeRetainedServerAuth", [messageTarget], { sessionToken: "actor-session" });
    assert.equal(retainedDuringLaterMutation.error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.ok(await database.adapter.readAuthSessionWithUser("session-message"));
    assert.deepEqual(await database.adapter.prepare("SELECT lifecycleRevision, revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-message"), messageKeyBefore);
    assert.deepEqual(await database.adapter.prepare("SELECT operationRevision, currentCount FROM sporades_auth_access_key_owners WHERE ownerUserId = ?").get(messageTarget), ownerBefore);
    const committed = await seed("commit"); const result = await runMutation(database, actor, "revoke", [committed], { sessionToken: "actor-session" }); assert.equal(result.error, null); assert.deepEqual(result.data, { userId: committed, revokedSessionCount: 1, revokedAccessKeyCount: 1 });
    assert.equal(await database.adapter.readAuthSessionWithUser("session-commit"), null); assert.ok(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-commit").revokedAt);
    const unawaited = await seed("unawaited"); const unawaitedResult = await runMutation(database, actor, "revokeWithoutAwait", [unawaited], { sessionToken: "actor-session" }); assert.equal(unawaitedResult.error, null); assert.deepEqual(unawaitedResult.data, { queued: true }); assert.equal(await database.adapter.readAuthSessionWithUser("session-unawaited"), null); assert.ok(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-unawaited").revokedAt);
    const rolledBack = await seed("rollback"); assert.ok((await runMutation(database, actor, "rollback", [rolledBack], { sessionToken: "actor-session" })).error); assert.ok(await database.adapter.readAuthSessionWithUser("session-rollback")); assert.equal(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-rollback").revokedAt, null); assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM effects WHERE value = ?").get("rolled-back")).count, 0);
    const unawaitedRollback = await seed("unawaited-rollback"); assert.ok((await runMutation(database, actor, "rollbackWithoutAwait", [unawaitedRollback], { sessionToken: "actor-session" })).error); assert.ok(await database.adapter.readAuthSessionWithUser("session-unawaited-rollback")); assert.equal(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-unawaited-rollback").revokedAt, null);
    await database.adapter.insertAuthUser({ id: "guest-target", createdAt: now, displayName: "Guest", email: null, picture: null, isAuthenticated: 0, isGuest: 1, provider: "anonymous" }); assert.equal((await runMutation(database, actor, "revoke", ["guest-target"])).error.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runMutation(database, { ...actor, isAuthenticated: false }, "revoke", [committed], { sessionToken: "actor-session" })).error.code, "HUMAN_SECURITY_TRANSITION_DENIED");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});

async function proveAppMessagesCannotRevokeHumanSecurity(serverEnv, config) {
  const database = await openDevDatabase("", "", serverEnv, config, definition);
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const targetId = `message-target-${randomUUID()}`;
  const keyId = `message-key-${randomUUID()}`;
  try {
    await database.adapter.insertAuthUser({ id: actor.userId, createdAt: now, displayName: actor.displayName, email: actor.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "actor-session", userId: actor.userId, provider: "email", createdAt: now, expiresAt: expiry });
    await database.adapter.insertAuthUser({ id: targetId, createdAt: now, displayName: targetId, email: `${targetId}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertEmailCredential({ email: `${targetId}@example.test`, userId: targetId, passwordHash: "hash", passwordSalt: "salt", createdAt: now });
    await database.adapter.insertAuthSession({ token: `session-${targetId}`, userId: targetId, provider: "email", createdAt: now, expiresAt: expiry });
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id: keyId, ownerUserId: targetId, name: "human key", reservedName: "human key", grantsJson: "[]", secretVersion: 1, selector: `selector-${randomUUID()}`, verifierDigest: "digest", lifecycleRevision: 1, createdAt: now, expiresAt: null })), { status: "issued" });
    const keyBefore = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [revokedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId);
    const ownerBefore = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [operationRevision], [currentCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?")).get(targetId);
    assert.equal((await runAppMessage(database, actor, "revokeAwaited", targetId, { sessionToken: "actor-session" })).error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    assert.equal((await runAppMessage(database, actor, "revokeWithoutAwait", targetId, { sessionToken: "actor-session" })).error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, []);
    assert.ok(await database.adapter.readAuthSessionWithUser(`session-${targetId}`));
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [revokedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId), keyBefore);
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [operationRevision], [currentCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?")).get(targetId), ownerBefore);
    const endpointRequest = () => Object.assign(Readable.from([]), { method: "POST", headers: { cookie: "session=actor-session" } });
    await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/revoke-awaited"), new URL("http://capsule.test/revoke-awaited"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_UNAVAILABLE");
    const endpointUnhandled = [];
    const onEndpointUnhandled = (reason) => endpointUnhandled.push(reason);
    process.on("unhandledRejection", onEndpointUnhandled);
    await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/revoke-unawaited"), new URL("http://capsule.test/revoke-unawaited"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_UNAVAILABLE");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onEndpointUnhandled);
    assert.deepEqual(endpointUnhandled, []);
    assert.equal((await runMutation(database, actor, "retainServerAuth", [], { sessionToken: "actor-session" })).error, null);
    assert.throws(() => globalThis.__retainedServerAuth.revokeHumanSecurity(targetId),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runMutation(database, actor, "invokeRetainedServerAuth", [targetId], { sessionToken: "actor-session" })).error?.code,
      "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.ok(await database.adapter.readAuthSessionWithUser(`session-${targetId}`));
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [revokedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId), keyBefore);
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [operationRevision], [currentCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?")).get(targetId), ownerBefore);
    const legitimateId = `overlap-legitimate-${randomUUID()}`;
    await database.adapter.insertAuthUser({ id: legitimateId, createdAt: now, displayName: legitimateId, email: `${legitimateId}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertEmailCredential({ email: `${legitimateId}@example.test`, userId: legitimateId, passwordHash: "hash", passwordSalt: "salt", createdAt: now });
    await database.adapter.insertAuthSession({ token: `session-${legitimateId}`, userId: legitimateId, provider: "email", createdAt: now, expiresAt: expiry });
    let signalOverlapReady;
    const overlapReady = new Promise((resolve) => { signalOverlapReady = resolve; });
    globalThis.__retainedCapabilityReady = signalOverlapReady;
    const activeMutation = runMutation(database, actor, "retainAwaitThenRevoke", [{ legitimateTargetId: legitimateId, delayMs: 120 }], { sessionToken: "actor-session" });
    await overlapReady;
    assert.throws(() => globalThis.__retainedServerAuth.revokeHumanSecurity(targetId),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runQuery(database, actor, "invokeRetained", [targetId], { sessionToken: "actor-session" })).error?.code,
      "HUMAN_SECURITY_TRANSITION_DENIED");
    await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/invoke-retained"), new URL("http://capsule.test/invoke-retained"), endpointRequest()),
      (error) => error?.code === "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runMutation(database, actor, "invokeRetainedServerAuth", [targetId], { sessionToken: "actor-session" })).error?.code,
      "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await activeMutation).error, null);
    assert.ok(await database.adapter.readAuthSessionWithUser(`session-${targetId}`));
    assert.equal(await database.adapter.readAuthSessionWithUser(`session-${legitimateId}`), null);
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [lifecycleRevision], [revokedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId), keyBefore);
    assert.deepEqual(await database.adapter.prepare(database.adapter.dialect.sql("SELECT [operationRevision], [currentCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?")).get(targetId), ownerBefore);
    const mutationResult = await runMutation(database, actor, "revokeWithoutAwait", [targetId], { sessionToken: "actor-session" });
    assert.equal(mutationResult.error, null, JSON.stringify(mutationResult.error));
    assert.equal(await database.adapter.readAuthSessionWithUser(`session-${targetId}`), null);
    assert.ok((await database.adapter.prepare(database.adapter.dialect.sql("SELECT [revokedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId)).revokedAt);
  } finally {
    await database.close();
  }
}

test("libSQL App messages cannot inherit human-security mutation authority", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    await proveAppMessagesCannotRevokeHumanSecurity(
      { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { name: `human-security-message-libsql-${randomUUID()}`, services: { database: { engine: "libsql" } } },
    );
  }, { isolateProcess: true });
});

test("Postgres App messages cannot inherit human-security mutation authority", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    await proveAppMessagesCannotRevokeHumanSecurity(
      { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { name: `human-security-message-postgres-${randomUUID()}`, services: { database: { engine: "postgres" } } },
    );
  });
});
