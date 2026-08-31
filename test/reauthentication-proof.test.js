import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { capsule, mutation, requireAuth, String as Text, table } from "../dist/server.js";
import { createWebSocketHub, hashEmailPassword, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";

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
    assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-1"), "handler rollback retains an unexpired proof");
    assert.equal((await runMutation(database, auth, "commit", ["after rejection"], { sessionToken: "session-1" })).error, null);
    await database.adapter.replaceReauthenticationProof({ id: "proof-2", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    const raced = await Promise.all([runMutation(database, auth, "commit", ["winner-a"], { sessionToken: "session-1" }), runMutation(database, auth, "commit", ["winner-b"], { sessionToken: "session-1" })]); assert.equal(raced.filter(({ error }) => error === null).length, 1); assert.equal(raced.filter(({ error }) => error?.code === "REAUTHENTICATION_REQUIRED").length, 1);
    await database.adapter.replaceReauthenticationProof({ id: "proof-revoked", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() }); await database.adapter.deleteAuthSession("session-1");
    assert.equal((await runMutation(database, auth, "commit", ["revoked session"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.equal(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-revoked"), undefined, "sign-out removes abandoned proofs transactionally");
    await database.adapter.insertAuthSession({ token: "session-1", userId: auth.userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() - 1).toISOString() });
    await database.adapter.replaceReauthenticationProof({ id: "proof-expired", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() - 1).toISOString() });
    assert.equal((await runMutation(database, auth, "commit", ["expired session"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED");
    assert.equal(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-expired"), undefined, "maintenance removes an expired proof before the rejected guarded transaction");
    await database.adapter.refreshAuthSession("session-1", new Date(now.getTime() + 3600000).toISOString());
    await database.adapter.replaceReauthenticationProof({ id: "proof-ineligible-user", userId: auth.userId, sessionToken: "session-1", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    await database.adapter.prepare("UPDATE sporades_auth_users SET isAuthenticated = 0, isGuest = 0 WHERE id = ?").run(auth.userId);
    assert.equal((await runMutation(database, auth, "commit", ["deauthenticated User"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-ineligible-user"));
    await database.close(); database = await openDevDatabase(file, "", {}, { name: definition.name }, definition); assert.equal((await runMutation(database, auth, "commit", ["deauthenticated restart"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-ineligible-user"));
    await database.adapter.prepare("UPDATE sporades_auth_users SET isAuthenticated = 1, isGuest = 1 WHERE id = ?").run(auth.userId); assert.equal((await runMutation(database, auth, "commit", ["guest User"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-ineligible-user"));
    await database.close(); database = await openDevDatabase(file, "", {}, { name: definition.name }, definition); assert.equal((await runMutation(database, auth, "commit", ["guest restart"], { sessionToken: "session-1" })).error.code, "REAUTHENTICATION_REQUIRED"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-ineligible-user"));
    await database.adapter.replaceReauthenticationProof({ id: "proof-startup-expired", userId: auth.userId, sessionToken: "session-1", purpose: "application-lifecycle", createdAt: new Date(now.getTime() - 2000).toISOString(), expiresAt: new Date(now.getTime() - 1000).toISOString() });
    await database.close(); database = await openDevDatabase(file, "", {}, { name: definition.name }, definition); assert.equal(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("proof-startup-expired"), undefined, "restart sweeps abandoned expired proofs");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("persisted email reauthentication reservations share one limit across separate runtimes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-reauth-throttle-")); const file = path.join(dir, "data.db");
  const first = await openDevDatabase(file, "", {}, { name: definition.name }, definition); const second = await openDevDatabase(file, "", {}, { name: definition.name }, definition);
  try {
    const now = new Date(); const input = { keys: ["email:shared", "session:shared"], now: now.toISOString(), resetAt: new Date(now.getTime() + 900000).toISOString(), limit: 5, maxEntries: 256 };
    const results = []; for (let index = 0; index < 8; index += 1) results.push(await (index % 2 ? first : second).adapter.withTransaction((tx) => tx.reserveEmailReauthenticationAttempt(input)));
    assert.equal(results.filter(Boolean).length, 5); assert.equal(results.filter((value) => !value).length, 3);
    await first.close(); const restarted = await openDevDatabase(file, "", {}, { name: definition.name }, definition);
    try { assert.equal(await restarted.adapter.withTransaction((tx) => tx.reserveEmailReauthenticationAttempt(input)), false, "limit survives restart"); }
    finally { await restarted.close(); }
  } finally { await second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Session rotation removes only old-token proofs transactionally without long-running growth", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-reauth-rotation-")); const file = path.join(dir, "data.db"); const database = await openDevDatabase(file, "", {}, { name: definition.name }, definition);
  try {
    const now = new Date(); const userId = "rotation-user"; await database.adapter.insertAuthUser({ id: userId, createdAt: now.toISOString(), displayName: "Rotation", email: "rotation@example.test", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "rotating-0", userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() }); await database.adapter.insertAuthSession({ token: "other-session", userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() });
    await database.adapter.replaceReauthenticationProof({ id: "other-proof", userId, sessionToken: "other-session", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    for (let index = 0; index < 6; index += 1) {
      const previousToken = `rotating-${index}`, token = `rotating-${index + 1}`; await database.adapter.replaceReauthenticationProof({ id: `rotating-proof-${index}`, userId, sessionToken: previousToken, purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
      await database.adapter.withTransaction((tx) => tx.rotateAuthSession(previousToken, { token, userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() }));
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_reauthentication_proofs WHERE sessionToken LIKE 'rotating-%'").get().count, 0, "old-token proof is removed immediately on each committed rotation"); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("other-proof"), "another Session's proof is retained");
    }
    await database.adapter.replaceReauthenticationProof({ id: "rollback-proof", userId, sessionToken: "rotating-6", purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() });
    await assert.rejects(() => database.adapter.withTransaction(async (tx) => { await tx.rotateAuthSession("rotating-6", { token: "rotating-rollback", userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() }); throw new Error("force rotation rollback"); }), /force rotation rollback/);
    assert.ok(await database.adapter.readAuthSessionWithUser("rotating-6")); assert.equal(await database.adapter.readAuthSessionWithUser("rotating-rollback"), null); assert.ok(database.adapter.prepare("SELECT id FROM sporades_auth_reauthentication_proofs WHERE id = ?").get("rollback-proof"), "failed rotation rolls proof cleanup back");
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("email reauthentication reservation failures are opaque and stop before proof issuance", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-reauth-reservation-failure-")); const file = path.join(dir, "data.db");
  const database = await openDevDatabase(file, "", {}, { name: definition.name, auth: { providers: { anonymous: true, email: true } } }, definition);
  const hub = createWebSocketHub(() => database); const server = createServer(); server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; let socket;
  const send = (message) => new Promise((resolve, reject) => { const id = message.id; const listener = (event) => { const value = JSON.parse(String(event.data)); if (value.id !== id) return; socket.removeEventListener("message", listener); resolve(value); }; socket.addEventListener("message", listener); socket.send(JSON.stringify(message)); setTimeout(() => { socket.removeEventListener("message", listener); reject(new Error("WebSocket response timed out")); }, 3000).unref(); });
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/?connectionToken=${hub.createConnectionToken()}`); await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const signedUp = await send({ id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "failure@example.test", password: "password-123", name: "Failure" } }); assert.equal(signedUp.error, null);
    const marker = "sensitive-reservation-database-marker"; const logs = []; database.log = { emit: async (event) => logs.push(event) }; const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    database.adapter.withTransaction = (handler) => originalWithTransaction((tx) => handler(new Proxy(tx, { get(target, property, receiver) { if (property === "reserveEmailReauthenticationAttempt") return async () => { throw new Error(marker); }; return Reflect.get(target, property, receiver); } })));
    const result = await send({ id: "reauth", type: "auth.reauthenticate", provider: "email", credentials: { email: "failure@example.test", password: "password-123" }, purpose: "administrator-authority" });
    assert.equal(result.error.code, "REAUTHENTICATION_FAILED"); assert.doesNotMatch(JSON.stringify(result), new RegExp(marker)); assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_reauthentication_proofs").get().count, 0);
    assert.deepEqual(logs.map(({ event, data }) => ({ event, data })), [{ event: "auth.reauthentication.throttle_failed", data: { provider: "email", purpose: "administrator-authority" } }]); assert.doesNotMatch(JSON.stringify(logs), new RegExp(marker));
  } finally { socket?.close(); hub.disconnectAll(); await new Promise((resolve) => server.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("PostgreSQL serializes throttle reservations and rejects a stale credential CAS after rotation", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL reauthentication races." }, async () => {
  const suffix = randomUUID(); const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL }; const config = { name: `reauth-proof-pg-${suffix}`, services: { database: { engine: "postgres" } } };
  await withPostgresAdapter(async () => {}, { appTableNames: ["effects"] });
  const first = await openDevDatabase("", "", serviceEnv, config, definition); const second = await openDevDatabase("", "", serviceEnv, config, definition);
  try {
    const now = new Date(); const throttle = { keys: [`email:${suffix}`, `session:${suffix}`], now: now.toISOString(), resetAt: new Date(now.getTime() + 900000).toISOString(), limit: 5, maxEntries: 256 };
    const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).adapter.withTransaction((tx) => tx.reserveEmailReauthenticationAttempt(throttle)))); assert.equal(reservations.filter(Boolean).length, 5);
    const userId = `reauth-${suffix}`, email = `${suffix}@example.test`; const oldPassword = hashEmailPassword("old-password"), nextPassword = hashEmailPassword("next-password");
    await first.adapter.insertAuthUser({ id: userId, createdAt: now.toISOString(), displayName: "Race", email, picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" }); await first.adapter.insertEmailCredential({ email, userId, passwordHash: oldPassword.hash, passwordSalt: oldPassword.salt, createdAt: now.toISOString() });
    let readResolve; const read = new Promise((resolve) => { readResolve = resolve; }); let releaseResolve; const release = new Promise((resolve) => { releaseResolve = resolve; });
    const staleIssuance = first.adapter.withTransaction(async (tx) => { const credential = await tx.findEmailCredentialWithUser(email); readResolve(); await release; const claimed = await tx.claimEmailCredentialVersion(email, credential.passwordHash, credential.passwordSalt); if (claimed) await tx.replaceReauthenticationProof({ id: randomUUID(), userId, sessionToken: `session-${suffix}`, purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() }); return claimed; });
    await read; await second.adapter.updateEmailCredentialPassword(email, nextPassword.hash, nextPassword.salt); releaseResolve(); assert.equal(await staleIssuance, false, "rotation winning before CAS prevents stale proof issuance");
    const proofCount = await first.adapter.prepare('SELECT COUNT(*) AS count FROM sporades_auth_reauthentication_proofs WHERE "userId" = ?').get(userId); assert.equal(Number(proofCount.count), 0);

    const current = hashEmailPassword("current-password"), later = hashEmailPassword("later-password"), sessionToken = `session-${suffix}`; await first.adapter.updateEmailCredentialPassword(email, current.hash, current.salt); await first.adapter.insertAuthSession({ token: sessionToken, userId, provider: "email", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() });
    let claimedResolve; const claimedReady = new Promise((resolve) => { claimedResolve = resolve; }); let publishResolve; const publish = new Promise((resolve) => { publishResolve = resolve; });
    const issuanceFirst = first.adapter.withTransaction(async (tx) => { assert.equal(await tx.claimEmailCredentialVersion(email, current.hash, current.salt), true); claimedResolve(); await publish; await tx.replaceReauthenticationProof({ id: randomUUID(), userId, sessionToken, purpose: "administrator-authority", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() }); });
    await claimedReady; let rotationSettled = false; const rotationAfter = second.adapter.updateEmailCredentialPassword(email, later.hash, later.salt).finally(() => { rotationSettled = true; }); await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(rotationSettled, false, "credential rotation waits behind the successful credential claim"); publishResolve(); await issuanceFirst; await rotationAfter;
    assert.ok(await first.adapter.prepare('SELECT id FROM sporades_auth_reauthentication_proofs WHERE "sessionToken" = ? AND purpose = ?').get(sessionToken, "administrator-authority")); const raceAuth = { ...auth, userId, email }; assert.equal((await runMutation(first, raceAuth, "commit", ["CAS-first linearization"], { sessionToken })).error, null, "a proof committed before the later rotation remains valid");
  } finally {
    await first.adapter.prepare("DELETE FROM sporades_auth_reauthentication_throttle WHERE key IN (?, ?)").run(`email:${suffix}`, `session:${suffix}`);
    await first.adapter.prepare("DELETE FROM sporades_auth_email_credentials WHERE email = ?").run(`${suffix}@example.test`);
    await first.adapter.prepare("DELETE FROM sporades_auth_users WHERE id = ?").run(`reauth-${suffix}`);
    await first.close(); await second.close();
  }
});
