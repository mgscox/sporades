import assert from "node:assert/strict";

// The human-identity termination surface of the Database adapter conformance specification
// (ADR-0035, ADR-0057). `terminateHumanIdentity` is one shared transition; these cases prove the
// same observed outcome for present, absent, ineligible and terminal identities on every engine,
// including the complete set of runtime effects, rollback, idempotency and uniqueness release.
//
// No case branches on `adapter.engine`. Every assertion compares an observed value, and every
// predicate is exercised on both sides: the terminated user loses every row while a bystander
// with the same shapes keeps all of them.

const NOW = "2026-10-19T09:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const LATER = "2026-10-19T09:30:00.000Z";

function human(id, overrides = {}) {
  return {
    id, createdAt: NOW, displayName: `Display ${id}`, email: `${id}@example.test`, picture: `https://example.test/${id}.png`,
    isAuthenticated: 1, isGuest: 0, provider: "email", ...overrides,
  };
}

const TERMINATED = human("hit-terminated");
const BYSTANDER = human("hit-bystander");
const ROLLBACK = human("hit-rollback");
const MEMBER = human("hit-member");
const UNLINKED = human("hit-unlinked");
const GUEST = human("hit-guest", { email: null, isAuthenticated: 0, isGuest: 1, provider: "anonymous" });
const SERVICE = human("hit-service", { email: null, provider: "unknown", userKind: "service" });

async function count(adapter, table, column, value) {
  const row = await adapter.prepare(adapter.dialect.sql(`SELECT COUNT(*) AS [count] FROM [${table}] WHERE [${column}] = ?`)).get(value);
  return Number(row?.count ?? 0);
}

async function userRow(adapter, id) {
  const row = await adapter.prepare(adapter.dialect.sql(
    "SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], [userKind], [lifecycleStatus] FROM [sporades_auth_users] WHERE [id] = ?",
  )).get(id);
  return row ? { ...row, isAuthenticated: Number(row.isAuthenticated), isGuest: Number(row.isGuest) } : null;
}

async function keyRows(adapter, ownerUserId) {
  const rows = await adapter.prepare(adapter.dialect.sql(
    "SELECT [id], [revokedAt], [revocationCause], [selector], [verifierDigest] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? ORDER BY [id]",
  )).all(ownerUserId);
  return rows.map((row) => ({ ...row }));
}

// Every runtime-owned row a terminated human may own, counted per table.
async function footprint(adapter, userId) {
  return {
    credentials: await count(adapter, "sporades_auth_email_credentials", "userId", userId),
    identities: await count(adapter, "sporades_auth_identities", "userId", userId),
    sessions: await count(adapter, "sporades_auth_sessions", "userId", userId),
    proofs: await count(adapter, "sporades_auth_reauthentication_proofs", "userId", userId),
    oauthStates: await count(adapter, "sporades_auth_oauth_states", "sessionToken", `session-a-${userId}`),
    resetCodes: await count(adapter, "sporades_auth_password_reset_codes", "userId", userId),
    preferences: await count(adapter, "sporades_user_preferences", "userId", userId),
  };
}

const FULL_FOOTPRINT = { credentials: 2, identities: 2, sessions: 2, proofs: 1, oauthStates: 1, resetCodes: 2, preferences: 1 };
const EMPTY_FOOTPRINT = { credentials: 0, identities: 0, sessions: 0, proofs: 0, oauthStates: 0, resetCodes: 0, preferences: 0 };

async function seedLinkedHuman(adapter, user) {
  await adapter.insertAuthUser(user);
  for (const suffix of ["a", "b"]) {
    await adapter.insertEmailCredential({ email: `${suffix}-${user.email}`, userId: user.id, passwordHash: `hash-${suffix}`, passwordSalt: `salt-${suffix}`, createdAt: NOW });
    await adapter.insertAuthIdentity({ id: `identity-${suffix}-${user.id}`, userId: user.id, provider: suffix === "a" ? "google" : "microsoft", subject: `subject-${user.id}`, email: user.email, displayName: user.displayName, picture: null, createdAt: NOW, updatedAt: NOW });
    await adapter.insertAuthSession({ token: `session-${suffix}-${user.id}`, userId: user.id, provider: "email", createdAt: NOW, expiresAt: FUTURE });
    await adapter.insertPasswordResetCode({ selector: `selector-${suffix}-${user.id}`, verifierHash: "verifier", email: `${suffix}-${user.email}`, userId: user.id, createdAt: NOW, expiresAt: FUTURE });
  }
  await adapter.insertOAuthState({ state: `state-${user.id}`, provider: "google", sessionToken: `session-a-${user.id}`, returnTo: "/", redirectUri: "https://capsule.test/callback", createdAt: NOW, expiresAt: FUTURE });
  await adapter.replaceReauthenticationProof({ id: `proof-${user.id}`, userId: user.id, sessionToken: `session-a-${user.id}`, purpose: "closure", createdAt: NOW, expiresAt: FUTURE });
  await adapter.saveUserPreferences({ userId: user.id, value: JSON.stringify({ theme: "dark" }), updatedAt: NOW });
  for (const [suffix, expiresAt] of [["active", null], ["expired", FUTURE], ["revoked", null]]) {
    const record = {
      id: `key-${suffix}-${user.id}`, ownerUserId: user.id, name: suffix, reservedName: suffix, grantsJson: "[\"*\"]", secretVersion: 1,
      selector: `key-selector-${suffix}-${user.id}`, verifierDigest: `digest-${suffix}`, lifecycleRevision: 1, createdAt: PAST, expiresAt,
    };
    assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
  }
  // Issuance refuses a past expiry, so the expired current key is aged in place.
  await adapter.prepare(adapter.dialect.sql("UPDATE [sporades_auth_access_keys] SET [expiresAt] = ? WHERE [id] = ?")).run(PAST, `key-expired-${user.id}`);
  await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({ ownerUserId: user.id, id: `key-revoked-${user.id}`, revokedAt: PAST, revocationCause: "owner" }));
}

function terminate(adapter, userId, revokedAt = LATER) {
  return adapter.withTransaction((tx) => tx.terminateHumanIdentity({ userId, revocationTime: () => revokedAt }));
}

async function prepareStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
  await adapter.ensureUserPreferencesStorage();
  await adapter.ensureTeamsStorage();
  for (const user of [TERMINATED, BYSTANDER, ROLLBACK, MEMBER]) await seedLinkedHuman(adapter, user);
  await adapter.insertAuthUser(UNLINKED);
  await adapter.insertAuthUser(GUEST);
  await adapter.insertAuthUser(SERVICE);
  await adapter.insertEmailCredential({ email: "service@example.test", userId: SERVICE.id, passwordHash: "h", passwordSalt: "s", createdAt: NOW });
  await adapter.prepare(adapter.dialect.sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("hit-team", "Shared", NOW, BYSTANDER.id);
  await adapter.prepare(adapter.dialect.sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)")).run("hit-team", MEMBER.id, NOW);
}

export const HUMAN_IDENTITY_TERMINATION_CONFORMANCE_CASES = [
  {
    name: "terminateHumanIdentity denies absent, unlinked, guest, service and reserved targets without writes",
    async run(adapter) {
      for (const userId of ["hit-absent", UNLINKED.id, GUEST.id, SERVICE.id, "__privileged__", ""]) {
        assert.deepEqual(await terminate(adapter, userId), { status: "denied" }, `target ${userId}`);
      }
      assert.equal((await userRow(adapter, UNLINKED.id)).lifecycleStatus, "active");
      assert.equal((await userRow(adapter, SERVICE.id)).lifecycleStatus, "active");
      assert.equal(await count(adapter, "sporades_auth_email_credentials", "userId", SERVICE.id), 1);
      assert.equal(await userRow(adapter, "hit-absent"), null, "an unknown ID never becomes a tombstone");
    },
  },
  {
    name: "terminateHumanIdentity is blocked by any Team membership and changes nothing",
    async run(adapter) {
      assert.deepEqual(await terminate(adapter, MEMBER.id), { status: "blocked" });
      assert.deepEqual(await footprint(adapter, MEMBER.id), FULL_FOOTPRINT);
      assert.equal((await userRow(adapter, MEMBER.id)).lifecycleStatus, "active");
      assert.equal((await keyRows(adapter, MEMBER.id)).filter((row) => row.revokedAt === null).length, 2);
    },
  },
  {
    name: "terminateHumanIdentity rolls back every effect with its enclosing transaction",
    async run(adapter) {
      await assert.rejects(adapter.withTransaction(async (tx) => {
        assert.equal((await tx.terminateHumanIdentity({ userId: ROLLBACK.id, revocationTime: () => LATER })).status, "terminated");
        throw new Error("rollback after termination");
      }), /rollback after termination/);
      assert.deepEqual(await footprint(adapter, ROLLBACK.id), FULL_FOOTPRINT);
      assert.deepEqual(await userRow(adapter, ROLLBACK.id), {
        id: ROLLBACK.id, displayName: ROLLBACK.displayName, email: ROLLBACK.email, picture: ROLLBACK.picture, isAuthenticated: 1, isGuest: 0,
        provider: "email", userKind: "human", lifecycleStatus: "active",
      });
      assert.equal((await keyRows(adapter, ROLLBACK.id)).filter((row) => row.revokedAt === null).length, 2);
      assert.equal(await count(adapter, "sporades_team_bootstrap", "userId", ROLLBACK.id), 0);
    },
  },
  {
    name: "terminateHumanIdentity tombstones the human and removes every credential, Session and recovery row",
    async run(adapter) {
      assert.deepEqual(await footprint(adapter, TERMINATED.id), FULL_FOOTPRINT);
      const outcome = await terminate(adapter, TERMINATED.id);
      assert.equal(outcome.status, "terminated");
      assert.equal(outcome.revokedAccessKeys.revokedCount, 2, "active and expired current keys retire; a revoked key is not counted");
      assert.deepEqual(outcome.revokedAccessKeys.records.map((row) => row.id).sort(), [`key-active-${TERMINATED.id}`, `key-expired-${TERMINATED.id}`]);
      assert.deepEqual(await footprint(adapter, TERMINATED.id), EMPTY_FOOTPRINT);
      assert.deepEqual(await userRow(adapter, TERMINATED.id), {
        id: TERMINATED.id, displayName: "", email: null, picture: null, isAuthenticated: 0, isGuest: 0,
        provider: "unknown", userKind: "human", lifecycleStatus: "terminated",
      });
      assert.deepEqual(await keyRows(adapter, TERMINATED.id), [
        { id: `key-active-${TERMINATED.id}`, revokedAt: LATER, revocationCause: "owner-deleted", selector: null, verifierDigest: null },
        { id: `key-expired-${TERMINATED.id}`, revokedAt: LATER, revocationCause: "owner-deleted", selector: null, verifierDigest: null },
        { id: `key-revoked-${TERMINATED.id}`, revokedAt: PAST, revocationCause: "owner", selector: null, verifierDigest: null },
      ]);
      assert.equal(await adapter.readAuthSessionWithUser(`session-a-${TERMINATED.id}`), null);
      assert.equal(await adapter.findEmailCredentialWithUser(`a-${TERMINATED.email}`), null);
      assert.equal(await count(adapter, "sporades_team_bootstrap", "userId", TERMINATED.id), 1, "the tombstone can never bootstrap a personal Team");
      // The bystander with the same row shapes keeps every one of them.
      assert.deepEqual(await footprint(adapter, BYSTANDER.id), FULL_FOOTPRINT);
      assert.equal((await userRow(adapter, BYSTANDER.id)).lifecycleStatus, "active");
      assert.equal((await keyRows(adapter, BYSTANDER.id)).filter((row) => row.revokedAt === null).length, 2);
    },
  },
  {
    name: "terminateHumanIdentity is idempotent for a tombstone and writes nothing on repeat",
    async run(adapter) {
      const before = { user: await userRow(adapter, TERMINATED.id), keys: await keyRows(adapter, TERMINATED.id) };
      assert.deepEqual(await terminate(adapter, TERMINATED.id, "2027-01-01T00:00:00.000Z"), { status: "already-terminated" });
      assert.deepEqual({ user: await userRow(adapter, TERMINATED.id), keys: await keyRows(adapter, TERMINATED.id) }, before);
    },
  },
  {
    name: "terminateHumanIdentity releases the email and provider-subject associations for a new identity",
    async run(adapter) {
      const replacement = human("hit-replacement");
      await adapter.insertAuthUser(replacement);
      await adapter.insertEmailCredential({ email: `a-${TERMINATED.email}`, userId: replacement.id, passwordHash: "new-hash", passwordSalt: "new-salt", createdAt: LATER });
      await adapter.insertAuthIdentity({ id: "identity-replacement", userId: replacement.id, provider: "google", subject: `subject-${TERMINATED.id}`, email: null, displayName: null, picture: null, createdAt: LATER, updatedAt: LATER });
      assert.equal((await adapter.findEmailCredentialWithUser(`a-${TERMINATED.email}`))?.userId, replacement.id);
      assert.equal((await adapter.findAuthIdentityByProviderSubject("google", `subject-${TERMINATED.id}`))?.userId, replacement.id);
      assert.deepEqual(await terminate(adapter, TERMINATED.id), { status: "already-terminated" }, "reuse never changes the original ID's replay");
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance: human identity termination",
  prepareStorage,
  cases: HUMAN_IDENTITY_TERMINATION_CONFORMANCE_CASES,
};
