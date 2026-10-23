import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createEmailPasswordResetLink,
  hashEmailPassword,
  openDevDatabase,
  resolveAnonymousSession,
  signInWithEmail,
  setOwnEmailPassword,
  signUpWithEmail,
} from "../dist/server-runtime-source.js";
import { confirmPasswordReset } from "../dist/auth-runtime.js";

// A browser password change is a credential-security transition, not a value
// write: every Session, reauthentication proof, outstanding Reset code and
// human Access key for the account must die with the password update, in one
// transaction, audited after commit. These tests use dummy accounts only.

const emailAuthConfig = {
  name: "password-change",
  auth: { providers: { email: { enabled: true } } },
};

const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function withDatabase(config, run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-change-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, config, {}, options);
  try {
    await database.init();
    return await run(database);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function registerEmailAccount(database, email, password) {
  const session = await resolveAnonymousSession(database, null);
  const result = await signUpWithEmail(database, session, "email", { email, password });
  assert.equal(result.ok, true, result.error?.message);
  return result;
}

async function signIn(database, email, password) {
  const result = await signInWithEmail(database, await resolveAnonymousSession(database, null), { email, password });
  return result;
}

async function issueOwnerAccessKey(database, ownerUserId, name, selector) {
  // Human-owned Access keys are seeded through the adapter the way an
  // interactive `ctx.accessKeys.issue` would have created them.
  await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
    id: `password-change-key-${name}`,
    ownerUserId,
    name,
    reservedName: name,
    grantsJson: JSON.stringify(["*"]),
    secretVersion: 1,
    selector,
    verifierDigest: "ab".repeat(32),
    lifecycleRevision: 1,
    createdAt: now(),
    expiresAt: null,
  }));
}

async function issueResetCode(database, email) {
  const result = await createEmailPasswordResetLink(database, await resolveAnonymousSession(database, null), email);
  assert.equal(result.ok, true, result.error?.message);
  return new URL(result.link).searchParams.get("code");
}

async function seedReauthenticationProof(database, userId, sessionToken, purpose = "credential-check") {
  await database.adapter.withTransaction((tx) => tx.replaceReauthenticationProof({
    id: `proof-${purpose}-${sessionToken}`,
    userId,
    sessionToken,
    purpose,
    createdAt: now(),
    expiresAt: later(),
  }));
}

async function proofStillConsumable(database, userId, sessionToken, purpose = "credential-check") {
  return await database.adapter.consumeReauthenticationProof({
    sessionToken,
    userId,
    purpose,
    now: now(),
  });
}

function setPasswordSession(token, auth) {
  // The transport resolves `{ token, auth }` per message; `setOwnEmailPassword`
  // receives exactly that shape.
  return { token, auth };
}

test("a browser password change revokes both sibling Sessions, Reset codes, reauthentication proofs and human Access keys", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "owner@example.com", "original-password");
    const initiator = await signIn(database, "owner@example.com", "original-password");
    const sibling = await signIn(database, "owner@example.com", "original-password");
    assert.equal(initiator.ok, true, initiator.error?.message);
    assert.equal(sibling.ok, true, sibling.error?.message);

    await issueOwnerAccessKey(database, registered.auth.userId, "change-retired-key", "changeselector0000000");
    const code = await issueResetCode(database, "owner@example.com");
    const [resetSelector] = code.split(".");
    await seedReauthenticationProof(database, registered.auth.userId, sibling.sessionToken);
    await seedReauthenticationProof(database, registered.auth.userId, initiator.sessionToken);

    const changed = await setOwnEmailPassword(
      database,
      setPasswordSession(initiator.sessionToken, initiator.auth),
      "owner@example.com",
      "original-password",
      "next-password",
    );
    assert.equal(changed.ok, true, changed.error?.message);

    for (const [label, token] of [["the initiating", initiator.sessionToken], ["the sibling", sibling.sessionToken]]) {
      const resolved = await resolveAnonymousSession(database, token);
      assert.equal(resolved.auth.isAuthenticated, false, `${label} Session must not survive the password change`);
    }
    const withOldPassword = await signIn(database, "owner@example.com", "original-password");
    assert.equal(withOldPassword.ok, false, "the old password must stop working");
    const withNewPassword = await signIn(database, "owner@example.com", "next-password");
    assert.equal(withNewPassword.ok, true, withNewPassword.error?.message);

    assert.equal(await database.adapter.findPasswordResetCode(resetSelector), null, "outstanding Reset codes must die with the change");
    assert.equal(await proofStillConsumable(database, registered.auth.userId, initiator.sessionToken), false, "the initiating Session's reauthentication proof must die with the change");
    assert.equal(await proofStillConsumable(database, registered.auth.userId, sibling.sessionToken), false, "the sibling Session's reauthentication proof must die with the change");

    const record = (await database.adapter.listAccessKeyRecordsForOwner(registered.auth.userId))[0];
    assert.equal(record.revocationCause, "password-change");
    assert.equal(record.revokedAt !== null, true);
    assert.equal(record.lifecycleRevision, 2);
    assert.equal(await database.adapter.findAccessKeyAuthenticationRecord("changeselector0000000"), null);

    const events = (await database.log.tail(200)).filter((event) => event.event === "access-key.revoked");
    assert.deepEqual(events.map((event) => ({
      operation: event.data.operation,
      actor: event.data.actor,
      target: event.data.target,
      credential: event.data.credential,
      cause: event.data.revocationCause,
      accessKeyId: event.data.accessKey?.id,
    })), [{
      operation: "auth.setPassword",
      actor: { userId: registered.auth.userId },
      target: { ownerUserId: registered.auth.userId },
      credential: { kind: "session" },
      cause: "password-change",
      accessKeyId: "password-change-key-change-retired-key",
    }]);
  });
});

test("a wrong current password leaves password and security state unchanged", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "wrong@example.com", "original-password");
    const initiator = await signIn(database, "wrong@example.com", "original-password");
    const sibling = await signIn(database, "wrong@example.com", "original-password");
    await issueOwnerAccessKey(database, registered.auth.userId, "change-kept-key", "keptselector00000000");
    await seedReauthenticationProof(database, registered.auth.userId, sibling.sessionToken);

    const rejected = await setOwnEmailPassword(
      database,
      setPasswordSession(initiator.sessionToken, initiator.auth),
      "wrong@example.com",
      "not-the-owner-password",
      "next-password",
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "INVALID_CURRENT_PASSWORD");
    const withOldPassword = await signIn(database, "wrong@example.com", "original-password");
    assert.equal(withOldPassword.ok, true, withOldPassword.error?.message);
    const withNewPassword = await signIn(database, "wrong@example.com", "next-password");
    assert.equal(withNewPassword.ok, false, "a rejected change must not set the requested password");
    const resolved = await resolveAnonymousSession(database, sibling.sessionToken);
    assert.equal(resolved.auth.isAuthenticated, true, "a rejected change must not revoke Sessions");
    assert.equal(await proofStillConsumable(database, registered.auth.userId, sibling.sessionToken), true, "a rejected change must not consume reauthentication proofs");
    const record = (await database.adapter.listAccessKeyRecordsForOwner(registered.auth.userId))[0];
    assert.equal(record.revokedAt, null, "a rejected change must not retire Access keys");
    assert.notEqual(await database.adapter.findAccessKeyAuthenticationRecord("keptselector00000000"), null, "a rejected change must keep the key authenticating");
    const events = (await database.log.tail(200)).filter((event) => event.event === "access-key.revoked");
    assert.deepEqual(events, [], "a rejected change must not emit revocation audits");
  });
});

test("another account's email cannot authorize a change", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "target@example.com", "original-password");
    const foreign = await registerEmailAccount(database, "intruder@example.com", "intruder-password-1");

    const rejected = await setOwnEmailPassword(
      database,
      setPasswordSession(foreign.sessionToken, foreign.auth),
      "target@example.com",
      "original-password",
      "attacker-chosen-1",
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "AUTH_EMAIL_NOT_OWNED");
    const withTargetPassword = await signIn(database, "target@example.com", "original-password");
    assert.equal(withTargetPassword.ok, true, withTargetPassword.error?.message);
    const targetKeys = await database.adapter.listAccessKeyRecordsForOwner(registered.auth.userId);
    assert.deepEqual(targetKeys, [], "the foreign change must leave the target's security state untouched");
    const intruderKeys = await database.adapter.listAccessKeyRecordsForOwner(foreign.auth.userId);
    assert.deepEqual(intruderKeys, [], "the foreign change must not retire the intruder's keys either");
  });
});

test("a stale Session cannot authorize a change", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "stale@example.com", "original-password");
    const stale = await signIn(database, "stale@example.com", "original-password");
    // Model a caller that still holds the resolved auth blob of its revoked
    // Session: the preflight credentials all look right, but the live Session
    // no longer exists.
    await database.adapter.deleteAuthSession(stale.sessionToken);

    const rejected = await setOwnEmailPassword(
      database,
      setPasswordSession(stale.sessionToken, stale.auth),
      "stale@example.com",
      "original-password",
      "next-password",
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "AUTH_SESSION_INVALID");
    const withOldPassword = await signIn(database, "stale@example.com", "original-password");
    assert.equal(withOldPassword.ok, true, withOldPassword.error?.message);
    const withNewPassword = await signIn(database, "stale@example.com", "next-password");
    assert.equal(withNewPassword.ok, false, "a stale-Session change must not set the requested password");
  });
});

test("an injected transition failure rolls the whole transition back", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "injected@example.com", "original-password");
    const initiator = await signIn(database, "injected@example.com", "original-password");
    const sibling = await signIn(database, "injected@example.com", "original-password");
    await issueOwnerAccessKey(database, registered.auth.userId, "injected-kept-key", "injectedselector000");
    const code = await issueResetCode(database, "injected@example.com");
    const [resetSelector] = code.split(".");
    await seedReauthenticationProof(database, registered.auth.userId, sibling.sessionToken);

    const originalUpdate = database.adapter.updateEmailCredentialPassword.bind(database.adapter);
    database.adapter.updateEmailCredentialPassword = () => {
      throw Object.assign(new Error("injected transition failure"), { code: "INJECTED_FAILURE" });
    };
    try {
      await assert.rejects(
        setOwnEmailPassword(
          database,
          setPasswordSession(initiator.sessionToken, initiator.auth),
          "injected@example.com",
          "original-password",
          "next-password",
        ),
        (error) => error.code === "INJECTED_FAILURE",
        "an unexpected storage failure must roll the transition back",
      );
    } finally {
      database.adapter.updateEmailCredentialPassword = originalUpdate;
    }

    const withOldPassword = await signIn(database, "injected@example.com", "original-password");
    assert.equal(withOldPassword.ok, true, withOldPassword.error?.message);
    const withNewPassword = await signIn(database, "injected@example.com", "next-password");
    assert.equal(withNewPassword.ok, false);
    const resolved = await resolveAnonymousSession(database, sibling.sessionToken);
    assert.equal(resolved.auth.isAuthenticated, true, "the rollback must keep the sibling Session");
    assert.notEqual(await database.adapter.findPasswordResetCode(resetSelector), null, "the rollback must keep the outstanding Reset code");
    assert.equal(await proofStillConsumable(database, registered.auth.userId, sibling.sessionToken), true, "the rollback must keep the reauthentication proof");
    const record = (await database.adapter.listAccessKeyRecordsForOwner(registered.auth.userId))[0];
    assert.equal(record.revokedAt, null, "the rollback must keep the Access key active");
    assert.notEqual(await database.adapter.findAccessKeyAuthenticationRecord("injectedselector000"), null, "the rolled-back key must still authenticate");
    const events = (await database.log.tail(200)).filter((event) => event.event === "access-key.revoked");
    assert.deepEqual(events, [], "a rolled-back transition must not emit revocation audits");
  });
});

test("a superseded verification cannot authorize the change", async () => {
  // Models PostgreSQL commit ordering: the preflight verified one password
  // snapshot, then a concurrent change committed before this transaction
  // read the credential under its lock. The fence must refuse, and nothing
  // from this contender may commit.
  const preflight = hashEmailPassword("original-password");
  const committed = hashEmailPassword("concurrent-password");
  const userId = "racing-change-user";
  const email = "racing@example.com";
  let passwordUpdates = 0;
  let sessionRevocations = 0;
  let codeDeletions = 0;
  let bulkRevocations = 0;
  let inTransaction = 0;
  const adapter = {
    dialect: { name: "sqlite", sql: (text) => text },
    async findEmailCredentialWithUser() {
      if (inTransaction === 0) return { email, userId, passwordHash: preflight.hash, passwordSalt: preflight.salt, displayName: "Racing", picture: null, isAuthenticated: 1, isGuest: 0 };
      return { email, userId, passwordHash: committed.hash, passwordSalt: committed.salt, displayName: "Racing", picture: null, isAuthenticated: 1, isGuest: 0 };
    },
    async readAuthSessionWithUser(token) {
      return token === "live-token" ? { token, userId, isAuthenticated: 1, isGuest: 0, expiresAt: "2099-01-01T00:00:00.000Z", displayName: "Racing", email, picture: null, provider: "email" } : null;
    },
    async lockAuthUserFileAuthority() {
      return { id: userId, userKind: "human", lifecycleStatus: "active" };
    },
    async claimEmailCredentialVersion() {
      // The verified fingerprint no longer matches the committed credential.
      return false;
    },
    async updateEmailCredentialPassword() {
      passwordUpdates += 1;
      return { changes: 1 };
    },
    async deletePasswordResetCodesForUser() {
      codeDeletions += 1;
      return { changes: 0 };
    },
    async deleteAuthSessionsForUser() {
      sessionRevocations += 1;
      return { changes: 1 };
    },
    async bulkRevokeAccessKeysForOwner(input) {
      assert.equal(input.revocationCause, "password-change");
      // The owner-security helper revokes inside the same transaction the fence
      // fails in; the real-adapter rollback test proves that contender commits
      // nothing. Here the recorder only proves the fenced writes never ran.
      bulkRevocations += 1;
      return { revokedCount: 0, records: [] };
    },
    async withTransaction(run) {
      inTransaction += 1;
      try {
        return await run(adapter);
      } finally {
        inTransaction -= 1;
      }
    },
  };
  const database = {
    authConfig: { providers: { email: { enabled: true } } },
    adapter,
    clock: { now: () => new Date("2031-03-01T09:30:00.000Z") },
    log: { emit: async () => {} },
  };
  const session = setPasswordSession("live-token", { userId, isAuthenticated: true, isGuest: false, provider: "email" });

  const result = await setOwnEmailPassword(database, session, email, "original-password", "next-password");

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_CURRENT_PASSWORD");
  assert.equal(passwordUpdates, 0, "a superseded verification must not update the password");
  assert.equal(sessionRevocations, 0, "a superseded verification must not revoke Sessions");
  assert.equal(codeDeletions, 0, "a superseded verification must not delete Reset codes");
  assert.equal(bulkRevocations, 1, "the helper's in-transaction revocation is the only write, and its transaction rolls back");
});

test("a sign-in cannot mint a Session from a superseded password snapshot", async () => {
  // The credentials verified outside the Auth transaction, then a concurrent
  // password change committed before the sign-in's transaction re-read the
  // credential. The sign-in must fail rather than mint surviving authority.
  const preflight = hashEmailPassword("original-password");
  const committed = hashEmailPassword("concurrent-password");
  const userId = "racing-signin-user";
  const email = "racing-signin@example.com";
  let sessionRotations = 0;
  let inTransaction = 0;
  const adapter = {
    dialect: { name: "sqlite", sql: (text) => text },
    async findEmailCredentialWithUser() {
      if (inTransaction === 0) {
        return { email, userId, passwordHash: preflight.hash, passwordSalt: preflight.salt, displayName: "Racing", picture: null, isAuthenticated: 1, isGuest: 0 };
      }
      // The concurrent change replaced the password before this re-read.
      return { email, userId, passwordHash: committed.hash, passwordSalt: committed.salt, displayName: "Racing", picture: null, isAuthenticated: 1, isGuest: 0 };
    },
    async claimEmailCredentialVersion(claimedEmail, hash, salt) {
      assert.equal(inTransaction, 1);
      assert.equal(claimedEmail, email);
      assert.equal(hash, preflight.hash);
      assert.equal(salt, preflight.salt);
      return false;
    },
    async updateAuthUserProfile() { return { changes: 0 }; },
    prepare() {
      return {
        get: async () => null,
        all: async () => [],
        run: async () => ({ changes: 0 }),
      };
    },
    async rotateAuthSession() {
      sessionRotations += 1;
      return { changes: 1 };
    },
    async withTransaction(run) {
      inTransaction += 1;
      try {
        return await run(adapter);
      } finally {
        inTransaction -= 1;
      }
    },
  };
  const database = {
    authConfig: { providers: { email: { enabled: true } } },
    adapter,
    clock: { now: () => new Date("2031-03-01T09:30:00.000Z") },
    log: { emit: async () => {} },
  };
  const session = {};

  const result = await signInWithEmail(database, session, { email, password: "original-password" });

  assert.equal(result.ok, false, "a superseded password snapshot must not mint a Session");
  assert.equal(sessionRotations, 0, "a superseded password snapshot must not rotate a Session");
});

test("a racing old-password sign-in cannot survive a concurrent password change", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "race@example.com", "original-password");
    const initiating = await signIn(database, "race@example.com", "original-password");
    assert.equal(initiating.ok, true, initiating.error?.message);

    const [changed, raced] = await Promise.all([
      setOwnEmailPassword(
        database,
        setPasswordSession(initiating.sessionToken, initiating.auth),
        "race@example.com",
        "original-password",
        "next-password",
      ),
      signInWithEmail(database, await resolveAnonymousSession(database, null), {
        email: "race@example.com",
        password: "original-password",
      }),
    ]);

    assert.equal(changed.ok, true, changed.error?.message);
    // Whichever contender won the serialized transaction, a Session minted
    // from the superseded password must not survive the change.
    if (raced.ok) {
      const resolved = await resolveAnonymousSession(database, raced.sessionToken);
      assert.equal(
        resolved.auth.isAuthenticated,
        false,
        "a Session minted from the superseded password must not survive",
      );
    }
    const withNewPassword = await signIn(database, "race@example.com", "next-password");
    assert.equal(withNewPassword.ok, true, withNewPassword.error?.message);
  });
});

test("a racing old-password sign-in cannot survive a concurrent reset confirmation", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "race-reset@example.com", "original-password");
    const code = await issueResetCode(database, "race-reset@example.com");

    const [confirmed, raced] = await Promise.all([
      confirmPasswordReset(database, {}, code, "reset-password"),
      signInWithEmail(database, await resolveAnonymousSession(database, null), {
        email: "race-reset@example.com",
        password: "original-password",
      }),
    ]);

    assert.equal(confirmed.ok, true, confirmed.error?.message);
    if (raced.ok) {
      const resolved = await resolveAnonymousSession(database, raced.sessionToken);
      assert.equal(
        resolved.auth.isAuthenticated,
        false,
        "a Session minted from the superseded password must not survive the reset",
      );
    }
    const withResetPassword = await signIn(database, "race-reset@example.com", "reset-password");
    assert.equal(withResetPassword.ok, true, withResetPassword.error?.message);
  });
});