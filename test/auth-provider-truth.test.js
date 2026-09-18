import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDevDatabase, resolveAnonymousSession, simulateLocalIdentitySession, signUpWithEmail, signInWithEmail, linkProviderIdentity, unlinkCurrentAuthUser } from "../dist/server-runtime-source.js";

const config = { auth: { providers: { anonymous: true, email: true } } };
async function withDatabase(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-provider-truth-"));
  const file = path.join(dir, "data.db");
  const database = await openDevDatabase(file, "", {}, config);
  try { await run(database, file); } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
}
const user = (db, id) => db.adapter.prepare("SELECT * FROM sporades_auth_users WHERE id = ?").get(id);

test("local registration and an existing identity upgrade persist the actual provider", async () => {
  await withDatabase(async (db) => {
    for (const provider of ["email", "google"]) {
      const options = { provider, email: `${provider}@example.test`, displayName: "Local" };
      const first = await simulateLocalIdentitySession(db, options);
      assert.equal(first.ok, true);
      assert.equal(user(db, first.data.auth.userId).provider, provider);
      // Reproduce an old corrupted row, bypassing the guarded new writer.
      db.adapter.prepare("UPDATE sporades_auth_users SET provider = 'anonymous' WHERE id = ?").run(first.data.auth.userId);
      const again = await simulateLocalIdentitySession(db, options);
      assert.equal(again.data.auth.userId, first.data.auth.userId);
      assert.equal(user(db, first.data.auth.userId).provider, provider);
    }
  });
});

test("email registration and later email sign-in record the method without rewriting other Sessions", async () => {
  await withDatabase(async (db) => {
    const guest = await resolveAnonymousSession(db, null);
    assert.equal(user(db, guest.auth.userId).provider, "anonymous");
    const credentials = { email: "email@example.test", password: "correct horse battery staple", name: "Email" };
    const signedUp = await signUpWithEmail(db, guest, "email", credentials);
    assert.equal(signedUp.ok, true);
    assert.equal(user(db, guest.auth.userId).provider, "email");
    const emailSession = await resolveAnonymousSession(db, signedUp.sessionToken);
    const google = await linkProviderIdentity(db, emailSession, "google", { subject: "google-email-user", displayName: "Google" });
    assert.equal(google.ok, true);
    assert.equal(user(db, guest.auth.userId).provider, "google");
    const anotherGuest = await resolveAnonymousSession(db, null);
    const signedIn = await signInWithEmail(db, anotherGuest, credentials);
    assert.equal(signedIn.ok, true);
    assert.equal(user(db, guest.auth.userId).provider, "email");
    assert.equal(db.adapter.readAuthSessionWithUser(emailSession.token).provider, "google");
    assert.equal(db.adapter.readAuthSessionWithUser(signedIn.sessionToken).provider, "email");
  });
});

test("a second method upgrades an anonymous row and unlink restores the canonical anonymous label", async () => {
  await withDatabase(async (db) => {
    const firstGuest = await resolveAnonymousSession(db, null);
    const google = await linkProviderIdentity(db, firstGuest, "google", { subject: "google-1" });
    assert.equal(google.ok, true);
    const firstSession = await resolveAnonymousSession(db, firstGuest.token);
    const second = await linkProviderIdentity(db, firstSession, "facebook", { subject: "facebook-1" });
    assert.equal(second.ok, true);
    const nextGuest = await resolveAnonymousSession(db, null);
    const resolved = await linkProviderIdentity(db, nextGuest, "facebook", { subject: "facebook-1" });
    assert.equal(resolved.auth.userId, google.auth.userId);
    assert.equal(user(db, google.auth.userId).provider, "facebook");
    assert.equal(user(db, nextGuest.auth.userId).provider, "anonymous");
    await unlinkCurrentAuthUser(db, { kind: "mutation", auth: resolved.auth, credential: { kind: "session" }, sessionToken: nextGuest.token });
    const unlinked = user(db, google.auth.userId);
    assert.deepEqual([unlinked.provider, unlinked.isAuthenticated, unlinked.isGuest], ["anonymous", 0, 1]);
  });
});

async function corruptFixture(db) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  for (const [id, authenticated, provider] of [["broken-email", 1, "anonymous"], ["broken-google", 1, "anonymous"], ["guest", 0, "anonymous"], ["orphan", 1, "anonymous"], ["multiple", 1, "anonymous"], ["unsupported", 1, "anonymous"], ["patched", 1, "email"], ["unlinked", 0, "guest"]]) {
    db.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)").run(id, createdAt, id, `${id}@example.test`, authenticated, 1 - authenticated, provider);
    await db.adapter.insertAuthSession({ token: `fixture-${id}`, userId: id, provider: authenticated ? "email" : "anonymous", createdAt, expiresAt });
  }
  for (const [id, provider] of [["broken-email", "email"], ["broken-google", "google"], ["multiple", "google"], ["multiple", "facebook"], ["unsupported", "anonymous"]]) {
    await db.adapter.insertAuthIdentity({ id: `${id}-${provider}`, userId: id, provider, subject: `fixture-${id}-${provider}`, email: null, displayName: null, picture: null, createdAt, updatedAt: createdAt });
  }
  // Multiple identities for the same method are still unambiguous evidence.
  await db.adapter.insertAuthIdentity({ id: "another-email", userId: "broken-email", provider: "email", subject: "another-email", email: null, displayName: null, picture: null, createdAt, updatedAt: createdAt });
}
const rows = (db, table) => db.adapter.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }));

test("corrupted-row fixture: no authenticated row reads anonymous after migration", async () => {
  await withDatabase(async (db, file) => {
    await corruptFixture(db);
    const reopened = await openDevDatabase(file, "", {}, config);
    try {
      assert.equal(reopened.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users WHERE isAuthenticated = 1 AND provider = 'anonymous'").get().count, 0);
      for (const [id, provider] of [["broken-email", "email"], ["broken-google", "google"], ["guest", "anonymous"], ["orphan", "unknown"], ["multiple", "unknown"], ["unsupported", "unknown"], ["patched", "email"], ["unlinked", "anonymous"]]) assert.equal(user(reopened, id).provider, provider, id);
      assert.deepEqual([user(reopened, "guest").isAuthenticated, user(reopened, "guest").isGuest], [0, 1]);
    } finally { await reopened.close(); }
  });
});

test("corrupted-row fixture: migration is label-only, preserves Sessions, and is idempotent", async () => {
  await withDatabase(async (db) => {
    await corruptFixture(db);
    const withoutProvider = (records) => records.map(({ provider, ...rest }) => rest);
    const beforeUsers = rows(db, "sporades_auth_users");
    const beforeSessions = rows(db, "sporades_auth_sessions");
    const beforeIdentities = rows(db, "sporades_auth_identities");
    await db.adapter.ensureAuthStorage();
    const after = rows(db, "sporades_auth_users");
    assert.notDeepEqual(after, beforeUsers, "fixture must exercise a real label migration");
    assert.deepEqual(withoutProvider(after), withoutProvider(beforeUsers));
    assert.deepEqual(rows(db, "sporades_auth_sessions"), beforeSessions);
    assert.deepEqual(rows(db, "sporades_auth_identities"), beforeIdentities);
    await db.adapter.ensureAuthStorage();
    assert.deepEqual(rows(db, "sporades_auth_users"), after);
    assert.deepEqual(rows(db, "sporades_auth_sessions"), beforeSessions);
    for (const stored of beforeSessions) {
      const resolved = await resolveAnonymousSession(db, stored.token);
      assert.equal(resolved.token, stored.token);
      assert.equal(resolved.auth.userId, stored.userId);
    }
  });
});

test("all auth user writers reject authenticated anonymous labels before changing rows", async () => {
  await withDatabase(async (db) => {
    const guest = await resolveAnonymousSession(db, null);
    const original = user(db, guest.auth.userId);
    for (const method of ["insertAuthUser", "updateAuthUserProfile", "linkAuthUser"]) {
      for (const provider of ["anonymous", "guest", "", undefined]) {
        await assert.rejects(async () => db.adapter[method]({ ...original, id: method === "insertAuthUser" ? "invalid" : original.id, isAuthenticated: 1, isGuest: 0, provider }), { code: "INVALID_AUTH_USER_PROVIDER" });
      }
    }
    assert.deepEqual(user(db, guest.auth.userId), original);
    assert.equal(user(db, "invalid"), undefined);
  });
});

test("startup repair indexes identity lookups for thousands of historical users", async (t) => {
  await withDatabase(async (db) => {
    const userCount = 3000;
    const createdAt = new Date().toISOString();
    const insertUser = db.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, 1, 0, 'anonymous')");
    const insertIdentity = db.adapter.prepare("INSERT INTO sporades_auth_identities (id, userId, provider, subject, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
    db.adapter.exec("BEGIN");
    try {
      for (let index = 0; index < userCount; index++) {
        const id = `bulk-${index}`;
        insertUser.run(id, createdAt, id);
        // Same-method duplicates, mixed methods, unsupported evidence, and missing evidence.
        const methods = [["email", "email", "email"], ["google", "google", "google"], ["google", "facebook", "google"], ["unsupported", "unsupported", "unsupported"], []][index % 5];
        for (const [offset, provider] of methods.entries()) {
          const identityId = `${id}-${offset}`;
          insertIdentity.run(identityId, id, provider, identityId, createdAt, createdAt);
        }
      }
      db.adapter.exec("COMMIT");
    } catch (error) {
      db.adapter.exec("ROLLBACK");
      throw error;
    }
    // Simulate an existing Capsule whose schema predates the index.
    db.adapter.exec("DROP INDEX IF EXISTS sporades_auth_identities_user_id");
    const originalExec = db.adapter.exec;
    let migrationPlan;
    db.adapter.exec = function (sql) {
      if (sql.startsWith(this.dialect.sql("UPDATE [sporades_auth_users] SET [provider] = CASE"))) {
        migrationPlan = this.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      }
      return originalExec.call(this, sql);
    };
    try { await db.adapter.ensureAuthStorage(); } finally { db.adapter.exec = originalExec; }
    assert.ok(migrationPlan, "inspect the actual startup migration statement");
    const details = migrationPlan.map(row => row.detail).join("\n");
    assert.match(details, /SEARCH i USING INDEX sporades_auth_identities_user_id \(userId=\?\)/);
    assert.doesNotMatch(details, /SCAN i\b/, "each user must not scan the identity table");
    t.diagnostic(`Migrated ${userCount} users and 7200 identities; query plan: ${details}`);
    const expected = ["email", "google", "unknown", "unknown", "unknown"];
    for (let index = 0; index < userCount; index++) {
      assert.equal(user(db, `bulk-${index}`).provider, expected[index % 5]);
    }
    const after = rows(db, "sporades_auth_users");
    await db.adapter.ensureAuthStorage();
    assert.deepEqual(rows(db, "sporades_auth_users"), after, "repeated startup remains idempotent");
  });
});
