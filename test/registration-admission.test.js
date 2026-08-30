import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { resolveAnonymousSession, signUpWithEmail, simulateLocalIdentitySession } from "../dist/auth-runtime.js";
import { String, table } from "../dist/server.js";

async function withDatabase(definition, body) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-registration-"));
  let database;
  try { database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "registration", auth: { providers: { anonymous: true, email: true } } }, definition); await body(database); }
  finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
}

test("Registration Admission denies email registration without creating app or runtime identity state", async () => {
  const capsule = { name: "denied", schema: { claims: table({ userId: String() }) }, auth: { registration: { admit: () => ({ allow: false }), finalize: () => { throw new Error("unreachable"); } } } };
  await withDatabase(capsule, async (database) => {
    const result = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "denied@example.com", password: "password-123" });
    assert.equal(result.error.code, "REGISTRATION_DENIED");
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_email_credentials").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 0);
  });
});

test("Registration Admission finalizer writes and runtime identity commit together", async () => {
  let retained;
  const capsule = { name: "admitted", schema: { claims: table({ userId: String() }).unique("userId") }, auth: { registration: {
    admit: (ctx) => ({ allow: ctx.admission?.key === "first" }),
    finalize: async (ctx) => { retained = ctx.db.claims; await ctx.db.claims.insert({ userId: ctx.evidence.userId }); },
  } } };
  await withDatabase(capsule, async (database) => {
    const result = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email: "first@example.com", password: "password-123" }, { key: "first" });
    assert.equal(result.ok, true);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 1);
    assert.throws(() => retained.all(), /no longer active/);
  });
});

test("Registration Admission finalizer failure rolls back app and runtime registration state", async () => {
  let fail = true;
  const capsule = { name: "rollback", schema: { claims: table({ userId: String() }) }, auth: { registration: {
    admit: () => ({ allow: true }),
    finalize: async (ctx) => {
      await ctx.db.claims.insert({ userId: ctx.evidence.userId });
      if (fail) throw new Error("controlled finalizer failure");
    },
  } } };
  await withDatabase(capsule, async (database) => {
    const session = await resolveAnonymousSession(database, null);
    const before = {
      users: (await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users").get()).count,
      sessions: (await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions").get()).count,
    };
    const result = await signUpWithEmail(database, session, "email", { email: "rollback@example.com", password: "password-123" });
    assert.equal(result.error.code, "REGISTRATION_DENIED");
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users").get()).count, before.users);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_email_credentials").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions").get()).count, before.sessions);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_teams").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_team_memberships").get()).count, 0);
    fail = false;
    const retried = await signUpWithEmail(database, session, "email", { email: "rollback@example.com", password: "password-123" });
    assert.equal(retried.ok, true);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 1);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_email_credentials").get()).count, 1);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_teams").get()).count, 1);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_team_memberships").get()).count, 1);
  });
});

test("local identity simulation enforces admission atomically and bypasses it for an existing identity", async () => {
  let mode = "deny";
  const evidence = [];
  const capsule = { name: "local-admission", schema: { claims: table({ userId: String() }).unique("userId") }, auth: { registration: {
    admit: (ctx) => { evidence.push({ kind: ctx.evidence.kind, admission: ctx.admission }); return { allow: mode !== "deny" }; },
    finalize: async (ctx) => { await ctx.db.claims.insert({ userId: ctx.evidence.userId }); if (mode === "rollback") throw new Error("local finalizer failure"); },
  } } };
  await withDatabase(capsule, async (database) => {
    const options = { provider: "email", email: "local@example.com", displayName: "Local User", registration: { invitation: "invite-1" } };
    const denied = await simulateLocalIdentitySession(database, options);
    assert.equal(denied.error.code, "REGISTRATION_DENIED");
    assert.deepEqual(evidence, [{ kind: "local", admission: { invitation: "invite-1" } }]);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities").get()).count, 0);

    mode = "rollback";
    const rolledBack = await simulateLocalIdentitySession(database, options);
    assert.equal(rolledBack.error.code, "REGISTRATION_DENIED");
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities").get()).count, 0);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_teams").get()).count, 0);

    mode = "allow";
    const admitted = await simulateLocalIdentitySession(database, options);
    assert.equal(admitted.ok, true);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 1);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities").get()).count, 1);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_teams").get()).count, 1);

    mode = "deny";
    const existing = await simulateLocalIdentitySession(database, { ...options, displayName: "Updated Local User", registration: { invitation: "invalid" } });
    assert.equal(existing.ok, true, "an existing linked identity bypasses new-registration admission");
    assert.equal(evidence.length, 3, "existing identity does not invoke admission or finalization again");
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM claims").get()).count, 1);
  });
});
