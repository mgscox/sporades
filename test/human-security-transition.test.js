import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capsule, mutation, String as Text, table } from "../dist/server.js";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";

const actor = { userId: "administrator", displayName: "Administrator", email: "admin@example.test", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
const definition = capsule({ name: "human-security-transition", schema: { effects: table({ value: Text() }) }, mutations: {
  revoke: mutation(async (ctx, userId) => { const result = await ctx.serverAuth.revokeHumanSecurity(userId); await ctx.db.effects.insert({ value: userId }); return result; }),
  rollback: mutation(async (ctx, userId) => { await ctx.serverAuth.revokeHumanSecurity(userId); await ctx.db.effects.insert({ value: "rolled-back" }); throw new Error("force rollback"); }),
} });

test("human security transition revokes Sessions and Access keys with the enclosing mutation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-human-security-")); const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 3600000).toISOString();
  const seed = async (suffix) => {
    const userId = `human-${suffix}`; await database.adapter.insertAuthUser({ id: userId, createdAt: now, displayName: userId, email: `${suffix}@example.test`, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: `session-${suffix}`, userId, provider: "email", createdAt: now, expiresAt: expiry });
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id: `key-${suffix}`, ownerUserId: userId, name: "human key", reservedName: "human key", grantsJson: "[]", secretVersion: 1, selector: `selector-${suffix}`, verifierDigest: `digest-${suffix}`, lifecycleRevision: 1, createdAt: now, expiresAt: null })), { status: "issued" }); return userId;
  };
  try {
    await database.adapter.insertAuthUser({ id: actor.userId, createdAt: now, displayName: actor.displayName, email: actor.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "actor-session", userId: actor.userId, provider: "email", createdAt: now, expiresAt: expiry });
    const committed = await seed("commit"); const result = await runMutation(database, actor, "revoke", [committed], { sessionToken: "actor-session" }); assert.equal(result.error, null); assert.deepEqual(result.data, { userId: committed, revokedSessionCount: 1, revokedAccessKeyCount: 1 });
    assert.equal(await database.adapter.readAuthSessionWithUser("session-commit"), null); assert.ok(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-commit").revokedAt);
    const rolledBack = await seed("rollback"); assert.ok((await runMutation(database, actor, "rollback", [rolledBack], { sessionToken: "actor-session" })).error); assert.ok(await database.adapter.readAuthSessionWithUser("session-rollback")); assert.equal(database.adapter.prepare("SELECT revokedAt FROM sporades_auth_access_keys WHERE id = ?").get("key-rollback").revokedAt, null); assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM effects WHERE value = ?").get("rolled-back")).count, 0);
    await database.adapter.insertAuthUser({ id: "guest-target", createdAt: now, displayName: "Guest", email: null, picture: null, isAuthenticated: 0, isGuest: 1, provider: "anonymous" }); assert.equal((await runMutation(database, actor, "revoke", ["guest-target"])).error.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await runMutation(database, { ...actor, isAuthenticated: false }, "revoke", [committed], { sessionToken: "actor-session" })).error.code, "HUMAN_SECURITY_TRANSITION_DENIED");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});
