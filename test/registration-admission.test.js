import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { resolveAnonymousSession, signUpWithEmail, simulateLocalIdentitySession } from "../dist/auth-runtime.js";
import { Boolean as BooleanField, capsule, String, table } from "../dist/server.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, withPostgresAdapter } from "./support/database-adapter-engines.js";

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

async function proveSeparateRuntimeRegistrationFence({ dir, config, serviceEnv, invitation }) {
  const definition = capsule({ name: "registration-fence", schema: {
    claims: table({ userId: String() }),
    invitations: table({ key: String(), used: BooleanField() }),
  }, auth: { registration: {
    admit: async (ctx) => {
      if (!invitation) { const allow = (await ctx.db.claims.all()).length === 0; await new Promise((resolve) => setTimeout(resolve, 40)); return { allow }; }
      const row = (await ctx.db.invitations.all()).find((candidate) => candidate.key === ctx.admission?.key && candidate.used === false);
      await new Promise((resolve) => setTimeout(resolve, 40)); return row ? { allow: true, state: { invitationId: row.id } } : { allow: false };
    },
    finalize: async (ctx, admitted) => { if (admitted.state?.invitationId) await ctx.db.invitations.update(admitted.state.invitationId, { used: true }); await ctx.db.claims.insert({ userId: ctx.evidence.userId }); },
  } } });
  const first = await openDevDatabase(path.join(dir, "first.db"), "", {}, config, definition, { serviceEnv });
  const second = await openDevDatabase(path.join(dir, "second.db"), "", {}, config, definition, { serviceEnv });
  try {
    assert.notEqual(first, second); assert.notEqual(first.adapter, second.adapter);
    if (invitation) await first.adapter.insertAppRow(first.schema.tables.find((table) => table.name === "invitations"), { id: "invite-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", key: "single", used: false });
    const sessions = await Promise.all([resolveAnonymousSession(first, null), resolveAnonymousSession(second, null)]);
    const results = await Promise.all([
      signUpWithEmail(first, sessions[0], "email", { email: `one-${invitation ? "invite" : "first"}@example.com`, password: "password-123" }, invitation ? { key: "single" } : undefined),
      signUpWithEmail(second, sessions[1], "email", { email: `two-${invitation ? "invite" : "first"}@example.com`, password: "password-123" }, invitation ? { key: "single" } : undefined),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1); assert.equal(results.filter((result) => result.error?.code === "REGISTRATION_DENIED").length, 1);
    assert.equal(Number((await first.adapter.prepare(first.adapter.dialect.sql("SELECT COUNT(*) AS [count] FROM [claims]")).get()).count), 1);
    if (invitation) assert.equal(globalThis.Boolean((await first.adapter.prepare(first.adapter.dialect.sql("SELECT [used] FROM [invitations] WHERE [key] = ?")).get("single")).used), true);
  } finally { await Promise.allSettled([first.close(), second.close()]); }
}

for (const invitation of [false, true]) test(`libSQL separate runtimes serialize ${invitation ? "single-use invitation" : "first-user"} Registration Admission`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-registration-libsql-fence-"));
  try { await withFakeLibsqlService(path.join(dir, "shared.db"), async ({ url }) => proveSeparateRuntimeRegistrationFence({ dir, config: { name: "registration-fence", auth: { providers: { anonymous: true, email: true } }, services: { database: { kind: "database", engine: "libsql" } } }, serviceEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url }, invitation })); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

for (const invitation of [false, true]) test(`Postgres separate runtimes serialize ${invitation ? "single-use invitation" : "first-user"} Registration Admission`, { skip: POSTGRES_SKIP_REASON }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-registration-postgres-fence-"));
  try { await withPostgresAdapter(async () => proveSeparateRuntimeRegistrationFence({ dir, config: { name: "registration-fence", auth: { providers: { anonymous: true, email: true } }, services: { database: { kind: "database", engine: "postgres" } } }, serviceEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, invitation }), { appTableNames: ["claims", "invitations"] }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
