import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openDevDatabase, resolveAnonymousSession, signUpWithEmail, signInWithEmail, linkProviderIdentity, simulateLocalIdentitySession } from "../dist/server-runtime-source.js";
import { capsule, String as Text, table } from "../dist/server.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, withPostgresAdapter } from "./support/database-adapter-engines.js";

const password = "dummy-password-123";
const credentials = (email) => ({ email, password, name: email });
const config = { name: "signup-transition", auth: { providers: { anonymous: true, email: true } } };
const definition = capsule({ name: config.name, schema: { claims: table({ userId: Text() }) }, auth: { registration: {
  admit: () => ({ allow: true }),
  finalize: async (ctx) => { await ctx.db.claims.insert({ userId: ctx.evidence.userId }); },
} } });
const tables = ["sporades_auth_users", "sporades_auth_sessions", "sporades_auth_email_credentials", "sporades_auth_identities", "sporades_teams", "sporades_team_memberships", "sporades_team_bootstrap", "claims"];
async function snapshot(database) {
  return Object.fromEntries(await Promise.all(tables.map(async (name) => [name, await database.adapter.prepare(database.adapter.dialect.sql(`SELECT * FROM [${name}] ORDER BY 1`)).all()])));
}
async function withRuntime(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-signup-transition-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, config, definition);
  try { await run(database); }
  finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
}

for (const provider of ["email", "google", "microsoft", "apple", "facebook", "local"]) {
  test(`email signup rejects an already ${provider}-linked human without writes`, async () => withRuntime(async (database) => {
    const guest = await resolveAnonymousSession(database, null);
    let token;
    if (provider === "email") token = (await signUpWithEmail(database, guest, "email", credentials("original@example.test"))).sessionToken;
    else if (provider === "local") token = (await simulateLocalIdentitySession(database, { provider: "email", email: "local@example.test" })).data.localStorage.value;
    else {
      const linked = await linkProviderIdentity(database, guest, provider, { subject: `dummy-${provider}`, email: null, displayName: "Original profile" });
      assert.equal(linked.ok, true);
      token = guest.token;
    }
    const session = await resolveAnonymousSession(database, token);
    assert.equal(session.auth.isAuthenticated, true);
    const before = await snapshot(database);
    const result = await signUpWithEmail(database, session, "email", credentials("added@example.test"));
    assert.equal(result.error?.code, "REGISTRATION_DENIED");
    if (provider === "email") {
      const duplicate = await signUpWithEmail(database, session, "email", credentials("original@example.test"));
      assert.equal(duplicate.error?.code, "REGISTRATION_DENIED");
    }
    assert.deepEqual(await snapshot(database), before);
    assert.equal((await resolveAnonymousSession(database, token)).token, token);
  }));
}

test("email signup fences current identity even when the caller retains a guest snapshot", async () => withRuntime(async (database) => {
  const guest = await resolveAnonymousSession(database, null);
  await linkProviderIdentity(database, guest, "google", { subject: "dummy-google", displayName: "Original" });
  const before = await snapshot(database);
  const result = await signUpWithEmail(database, guest, "email", credentials("stale-guest@example.test"));
  assert.equal(result.error?.code, "REGISTRATION_DENIED");
  assert.deepEqual(await snapshot(database), before);
}));

test("guest registration preserves its identity, bootstrap and sign-in; duplicate email rolls back", async () => withRuntime(async (database) => {
  const guest = await resolveAnonymousSession(database, null);
  const registered = await signUpWithEmail(database, guest, "email", credentials("fresh@example.test"));
  assert.equal(registered.ok, true);
  assert.equal(registered.auth.userId, guest.auth.userId);
  assert.notEqual(registered.sessionToken, guest.token);
  assert.equal(await database.adapter.readAuthSessionWithUser(guest.token), null);
  const other = await resolveAnonymousSession(database, null);
  const before = await snapshot(database);
  const duplicate = await signUpWithEmail(database, other, "email", credentials("fresh@example.test"));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.message, "Email is already registered.");
  assert.deepEqual(await snapshot(database), before);
  const signedIn = await signInWithEmail(database, other, credentials("fresh@example.test"));
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.auth.userId, guest.auth.userId);
}));

for (const invalid of ["deleted", "expired", "moved", "terminated"]) {
  test(`email signup rejects a ${invalid} Session without writes`, async () => withRuntime(async (database) => {
    const guest = await resolveAnonymousSession(database, null);
    if (invalid === "deleted") await database.adapter.deleteAuthSession(guest.token);
    if (invalid === "expired") await database.adapter.prepare("UPDATE sporades_auth_sessions SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE token = ?").run(guest.token);
    if (invalid === "moved") {
      const other = await resolveAnonymousSession(database, null);
      await database.adapter.prepare("UPDATE sporades_auth_sessions SET userId = ? WHERE token = ?").run(other.auth.userId, guest.token);
    }
    if (invalid === "terminated") await database.adapter.prepare("UPDATE sporades_auth_users SET lifecycleStatus = 'terminated' WHERE id = ?").run(guest.auth.userId);
    const before = await snapshot(database);
    const result = await signUpWithEmail(database, guest, "email", credentials("invalid@example.test"));
    assert.equal(result.error?.code, "AUTH_SESSION_INVALID");
    assert.deepEqual(await snapshot(database), before);
  }));
}

async function proveConcurrentSignup(first, second = first, sibling = false) {
  const guest = await resolveAnonymousSession(first, null);
  let otherToken = guest.token;
  if (sibling) {
    otherToken = `${guest.token}-sibling`;
    const now = new Date();
    await first.adapter.insertAuthSession({ token: otherToken, userId: guest.auth.userId, provider: "anonymous", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
  }
  const stale = await resolveAnonymousSession(second, otherToken);
  const results = await Promise.all([
    signUpWithEmail(first, guest, "email", credentials("race-one@example.test")),
    signUpWithEmail(second, stale, "email", credentials("race-two@example.test")),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.ok(["REGISTRATION_DENIED", "AUTH_SESSION_INVALID"].includes(results.find((result) => !result.ok)?.error?.code));
  const after = await snapshot(first);
  for (const name of tables.filter((name) => name !== "sporades_auth_identities")) assert.equal(after[name].length, name === "sporades_auth_sessions" && sibling ? 2 : 1, name);
  assert.equal(after.sporades_auth_identities.length, 0);
  const winner = results.find((result) => result.ok);
  assert.equal(after.sporades_auth_email_credentials[0].email, winner.auth.email);
  const beforeRetry = await snapshot(first);
  const retry = await signUpWithEmail(second, stale, "email", credentials("race-retry@example.test"));
  assert.equal(retry.ok, false);
  assert.deepEqual(await snapshot(first), beforeRetry);
}

test("one runtime serializes two signups from the same guest snapshot", async () => withRuntime(proveConcurrentSignup));
test("one runtime fences signups using different Sessions of the same guest identity", async () => withRuntime((database) => proveConcurrentSignup(database, database, true)));

for (const engine of ["libsql", "postgres"]) for (const sibling of [false, true]) {
  test(`${engine} separate runtimes fence simultaneous signup on one guest (${sibling ? "different Sessions" : "same Session"})`, { skip: engine === "postgres" && POSTGRES_SKIP_REASON }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-signup-${engine}-`));
    const run = async (url) => {
      const runtimeConfig = { ...config, services: { database: { kind: "database", engine } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: engine, SPORADES_SERVICE_DATABASE_URL: url };
      const first = await openDevDatabase(path.join(dir, "first.db"), "", {}, runtimeConfig, definition, { serviceEnv });
      const second = await openDevDatabase(path.join(dir, "second.db"), "", {}, runtimeConfig, definition, { serviceEnv });
      try { await proveConcurrentSignup(first, second, sibling); }
      finally { await Promise.allSettled([first.close(), second.close()]); }
    };
    try {
      if (engine === "libsql") await withFakeLibsqlService(path.join(dir, "shared.db"), ({ url }) => run(url));
      else await withPostgresAdapter(() => run(postgresTestUrl()), { appTableNames: ["claims"] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
