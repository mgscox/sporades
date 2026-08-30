import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capsule, mutation, requireAuth, String as Text, table } from "../dist/server.js";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";

const auth = { userId: "human-1", displayName: "Human", email: "human@example.test", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
const definition = capsule({ name: "reauth-proof", auth: { reauthentication: { purposes: { "administrator-authority": { maxAgeSeconds: 900 } } } }, schema: { effects: table({ value: Text() }) }, mutations: {
  commit: mutation(requireAuth({ credentials: ["session"], reauthentication: "administrator-authority" }, async (ctx, value) => ctx.db.effects.insert({ value }))),
  reject: mutation(requireAuth({ credentials: ["session"], reauthentication: "administrator-authority" }, async (ctx) => { await ctx.db.effects.insert({ value: "rolled-back" }); throw new Error("rejected"); })),
} });

test("runtime-owned proof consumption commits atomically, preserves rejected proof, and has one concurrent winner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-reauth-")); const file = path.join(dir, "data.db"); let database = await openDevDatabase(file, "", {}, { name: definition.name }, definition);
  try {
    const now = new Date(); await database.adapter.insertAuthUser({ id: auth.userId, createdAt: now.toISOString(), displayName: auth.displayName, email: auth.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" }); await database.adapter.insertAuthSession({ token: "session-1", userId: auth.userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() });
    await database.adapter.replaceReauthenticationProof({ id: "proof-1", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    assert.ok((await runMutation(database, auth, "reject", [], { sessionToken: "session-1" })).error);
    assert.equal((await runMutation(database, auth, "commit", ["after rejection"], { sessionToken: "session-1" })).error, null);
    await database.adapter.replaceReauthenticationProof({ id: "proof-2", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    const raced = await Promise.all([runMutation(database, auth, "commit", ["winner-a"], { sessionToken: "session-1" }), runMutation(database, auth, "commit", ["winner-b"], { sessionToken: "session-1" })]); assert.equal(raced.filter(({ error }) => error === null).length, 1); assert.equal(raced.filter(({ error }) => error?.code === "REAUTHENTICATION_REQUIRED").length, 1);
    await database.adapter.replaceReauthenticationProof({ id: "proof-revoked", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() }); await database.adapter.deleteAuthSession("session-1");
    assert.equal((await runMutation(database, auth, "commit", ["revoked session"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-revoked"), "revoked Session leaves proof retained but unusable");
    await database.adapter.insertAuthSession({ token: "session-1", userId: auth.userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() - 1).toISOString() });
    assert.equal((await runMutation(database, auth, "commit", ["expired session"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-revoked"), "expired Session leaves proof retained but unusable");
    await database.close(); database = await openDevDatabase(file, "", {}, { name: definition.name }, definition); assert.equal((await runMutation(database, auth, "commit", ["restart cannot revive"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});
