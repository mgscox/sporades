import assert from "node:assert/strict";

// The browser password-change surface of the Database adapter conformance specification
// (ADR-0035). `auth.setPassword` composes the shared identity/credential primitives into one
// credential-security transition (cause `password-change`); these cases prove that the composed
// effects — the password write, the Sessions and their reauthentication proofs, the outstanding
// Reset codes, the human Access keys with their authentication records and the fingerprint fence —
// commit together and roll back together on every engine. A bystander seeded with the same shapes
// keeps everything, so no case can pass by masking an unimplemented effect.
//
// No case branches on `adapter.engine`, and no case imports runtime code: like the password-reset
// retirement case of the auth-storage surface, they drive the adapter primitives through the same
// composition the runtime performs, so engine agreement is observable without coupling surfaces to a
// snapshot of runtime source.

const NOW = "2026-10-23T09:00:00.000Z";
const NEXT_MONTH = "2026-11-23T09:00:00.000Z";
const LATER = "2026-10-23T09:30:00.000Z";

const CHANGED = {
  id: "pcr-changed", createdAt: NOW, displayName: "Display changed", email: "changed@example.test", picture: null,
  isAuthenticated: 1, isGuest: 0, provider: "email",
};
const BYSTANDER = {
  id: "pcr-bystander", createdAt: NOW, displayName: "Display bystander", email: "bystander@example.test", picture: null,
  isAuthenticated: 1, isGuest: 0, provider: "email",
};
const ROLLBACK = {
  id: "pcr-rollback", createdAt: NOW, displayName: "Display rollback", email: "rollback@example.test", picture: null,
  isAuthenticated: 1, isGuest: 0, provider: "email",
};

// The verified fingerprint a browser change passes into the fence, and the new password it writes.
const FINGERPRINT = { hash: "pcr-hash-current", salt: "pcr-salt-current", nextHash: "pcr-hash-next", nextSalt: "pcr-salt-next" };

async function count(adapter, table, column, value) {
  const row = await adapter.prepare(adapter.dialect.sql(`SELECT COUNT(*) AS [count] FROM [${table}] WHERE [${column}] = ?`)).get(value);
  return Number(row?.count ?? 0);
}

function keyRecord(owner, suffix, selector) {
  return {
    id: `key-${suffix}-${owner.id}`, ownerUserId: owner.id, name: suffix, reservedName: suffix,
    grantsJson: '["requests:read"]', secretVersion: 1,
    selector, verifierDigest: `pcr${suffix}digest`.padEnd(64, "0"),
    lifecycleRevision: 1, createdAt: NOW, expiresAt: NEXT_MONTH,
  };
}

async function seedChangableHuman(adapter, owner, sessionSuffixes) {
  await adapter.insertAuthUser(owner);
  await adapter.insertEmailCredential({ email: owner.email, userId: owner.id, passwordHash: FINGERPRINT.hash, passwordSalt: FINGERPRINT.salt, createdAt: NOW });
  for (const suffix of sessionSuffixes) {
    await adapter.insertAuthSession({ token: `session-${suffix}-${owner.id}`, userId: owner.id, provider: "email", createdAt: NOW, expiresAt: NEXT_MONTH });
  }
  await adapter.replaceReauthenticationProof({ id: `proof-${owner.id}`, userId: owner.id, sessionToken: `session-primary-${owner.id}`, purpose: "credential-check", createdAt: NOW, expiresAt: NEXT_MONTH });
  await adapter.insertPasswordResetCode({
    selector: `reset-${owner.id}`, verifierHash: `${owner.id}-verifier`, email: owner.email, userId: owner.id,
    createdAt: NOW, expiresAt: NEXT_MONTH,
  });
  const record = keyRecord(owner, "active", `pcr${owner.id}selector0`);
  assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
}

async function prepareStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
  await seedChangableHuman(adapter, CHANGED, ["primary", "sibling"]);
  await seedChangableHuman(adapter, BYSTANDER, ["primary", "sibling"]);
  await seedChangableHuman(adapter, ROLLBACK, ["primary", "sibling"]);
}

// The composition `setOwnEmailPassword` performs inside
// `runAccessKeyOwnerSecurityTransition`: the Access-key revocation first (cause `password-change`),
// then the transition's revalidation fence and the password and recovery writes, all in one
// transaction. `fingerprint` is the verification the caller presented; write the next password only
// after the fence confirms the live credential is still that fingerprint.
async function browserPasswordChange(adapter, owner, fingerprint = FINGERPRINT, options = {}) {
  return await adapter.withTransaction(async (tx) => {
    const revokedAccessKeys = await tx.bulkRevokeAccessKeysForOwner({
      ownerUserId: owner.id,
      revocationTime: () => LATER,
      revocationCause: "password-change",
    });
    const current = await tx.readAuthSessionWithUser(`session-primary-${owner.id}`);
    if (!current || current.userId !== owner.id || !current.isAuthenticated || current.isGuest) {
      throw new Error("pcr stale session");
    }
    const lockedOwner = await tx.lockAuthUserFileAuthority(owner.id);
    if (!lockedOwner || lockedOwner.lifecycleStatus !== "active") {
      throw new Error("pcr stale owner");
    }
    const live = await tx.findEmailCredentialWithUser(owner.email);
    if (!live || live.userId !== owner.id) {
      throw new Error("pcr credential not owned");
    }
    if (!await tx.claimEmailCredentialVersion(owner.email, fingerprint.hash, fingerprint.salt)) {
      throw new Error("pcr superseded fingerprint");
    }
    await tx.updateEmailCredentialPassword(owner.email, fingerprint.nextHash, fingerprint.nextSalt);
    await tx.deletePasswordResetCodesForUser(owner.id);
    await tx.deleteAuthSessionsForUser(owner.id);
    if (options.failAfterWrite) throw new Error(options.failAfterWrite);
    return revokedAccessKeys;
  });
}

async function changedFootprint(adapter, owner) {
  return {
    sessions: await count(adapter, "sporades_auth_sessions", "userId", owner.id),
    proofs: await count(adapter, "sporades_auth_reauthentication_proofs", "userId", owner.id),
    resetCodes: await count(adapter, "sporades_auth_password_reset_codes", "userId", owner.id),
    activeKeys: (await adapter.listAccessKeyRecordsForOwner(owner.id)).filter((row) => row.revokedAt === null).length,
    authenticationRecords: (await adapter.findAccessKeyAuthenticationRecord(`pcr${owner.id}selector0`)) === null ? 0 : 1,
  };
}

const EMPTY_CHANGE_FOOTPRINT = { sessions: 0, proofs: 0, resetCodes: 0, activeKeys: 0, authenticationRecords: 0 };
const FULL_CHANGE_FOOTPRINT = { sessions: 2, proofs: 1, resetCodes: 1, activeKeys: 1, authenticationRecords: 1 };

export const PASSWORD_CHANGE_REVOCATION_CONFORMANCE_CASES = [
  {
    name: "The browser password-change retirement commits every revocation with its password write on the fingerprint fence",
    async run(adapter) {
      assert.deepEqual(await changedFootprint(adapter, CHANGED), FULL_CHANGE_FOOTPRINT);
      // The fence accepts the verification before the write and rejects an unverified fingerprint.
      assert.equal(await adapter.claimEmailCredentialVersion(CHANGED.email, FINGERPRINT.hash, FINGERPRINT.salt), true);
      assert.equal(await adapter.claimEmailCredentialVersion(CHANGED.email, FINGERPRINT.nextHash, FINGERPRINT.nextSalt), false);

      const revokedAccessKeys = await browserPasswordChange(adapter, CHANGED);
      assert.equal(revokedAccessKeys.revokedCount, 1, "the change revokes the account's current human Access keys");
      assert.deepEqual(revokedAccessKeys.records.map((record) => record.id), [`key-active-${CHANGED.id}`]);

      assert.deepEqual(await changedFootprint(adapter, CHANGED), EMPTY_CHANGE_FOOTPRINT);
      assert.equal(await adapter.readAuthSessionWithUser(`session-sibling-${CHANGED.id}`), null, "the sibling Session is revoked");
      assert.equal((await adapter.findEmailCredentialWithUser(CHANGED.email)).passwordHash, FINGERPRINT.nextHash);
      // The fence now rejects the superseded fingerprint and accepts the new password.
      assert.equal(await adapter.claimEmailCredentialVersion(CHANGED.email, FINGERPRINT.hash, FINGERPRINT.salt), false, "a verification against the superseded password cannot claim the credential");
      assert.equal(await adapter.claimEmailCredentialVersion(CHANGED.email, FINGERPRINT.nextHash, FINGERPRINT.nextSalt), true);

      // The bystander with the same shapes keeps everything.
      assert.deepEqual(await changedFootprint(adapter, BYSTANDER), FULL_CHANGE_FOOTPRINT);
      assert.equal((await adapter.findEmailCredentialWithUser(BYSTANDER.email)).passwordHash, FINGERPRINT.hash);
      assert.equal(await adapter.claimEmailCredentialVersion(BYSTANDER.email, FINGERPRINT.hash, FINGERPRINT.salt), true);
    },
  },
  {
    name: "The browser password-change retirement rolls back every effect with its enclosing transaction",
    async run(adapter) {
      assert.deepEqual(await changedFootprint(adapter, ROLLBACK), FULL_CHANGE_FOOTPRINT);
      await assert.rejects(
        browserPasswordChange(adapter, ROLLBACK, FINGERPRINT, { failAfterWrite: "pcr injected rollback" }),
        /pcr injected rollback/,
      );
      // Nothing committed: the password, Sessions, proofs, Reset codes, keys and fence are untouched.
      assert.deepEqual(await changedFootprint(adapter, ROLLBACK), FULL_CHANGE_FOOTPRINT);
      assert.equal((await adapter.readAuthSessionWithUser(`session-primary-${ROLLBACK.id}`)).userId, ROLLBACK.id);
      assert.equal((await adapter.findEmailCredentialWithUser(ROLLBACK.email)).passwordHash, FINGERPRINT.hash);
      assert.equal(await adapter.claimEmailCredentialVersion(ROLLBACK.email, FINGERPRINT.hash, FINGERPRINT.salt), true);
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance: browser password-change revocation",
  prepareStorage,
  cases: PASSWORD_CHANGE_REVOCATION_CONFORMANCE_CASES,
};