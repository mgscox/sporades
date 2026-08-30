import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { resolveAnonymousSession, signUpWithEmail } from "../dist/auth-runtime.js";
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
