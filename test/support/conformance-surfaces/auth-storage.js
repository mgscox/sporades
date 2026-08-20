import assert from "node:assert/strict";

// The runtime-owned auth storage surface of the Database adapter conformance specification
// (ADR-0035): Sessions, Provider identities, email credentials and Reset codes.
//
// The seeded surface in `database-adapter-conformance.test.js` covers the specific auth methods
// that were already known to be broken. This surface covers their neighbours on the same tables,
// which had only ever been verified on SQLite. It owns its own adapter, its own prepared storage
// and its own fixture constants — there is deliberately no shared fixtures module, because that
// file would be the one place two surfaces had to edit at once.
//
// Two rules from ADR-0034 and ADR-0035 shape every case. Every assertion compares an observed
// value against an expected value, because none of the six known defects threw. And every
// predicate is exercised on both sides: an existence check is run against a stored row and an
// absent one, a count against a known non-zero quantity, and a write against both a row that
// matches and one that does not, because a check that always answers true, a count that always
// answers zero and an update that always reports one change each satisfy a single positive
// assertion.
//
// No case branches on `adapter.engine`. A case that could not pass on one engine would be a
// divergence to fix at the shared method definition, not a gate to add here.

const NOW = "2026-08-01T09:00:00.000Z";
const LATER = "2026-08-01T09:30:00.000Z";
const NEXT_MONTH = "2026-09-01T09:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const LONG_PAST_CREATED = "2020-01-01T00:00:00.000Z";
const LONG_PAST_EXPIRED = "2020-01-01T01:00:00.000Z";

const RESERVED_AUTH_USER_ID = "__privileged__";
const RESERVED_EMAIL = "reserved-role@example.com";

// The Sporades user whose Session, Provider identity and email credential the ordinary-path
// cases read.
const SIGNED_IN_USER = {
  id: "auth-user-signed-in",
  createdAt: NOW,
  displayName: "Signed In User",
  email: "signed-in@example.com",
  picture: "https://example.com/signed-in.png",
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

// A second Sporades user, so every "for one user" method can be shown to leave another user's
// rows alone rather than merely to delete something.
const BYSTANDER_USER = {
  id: "auth-user-bystander",
  createdAt: NOW,
  displayName: "Bystander User",
  email: "bystander@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

// A third Sporades user owned solely by the Session sweep case, so the number of Sessions
// `deleteAuthSessionsForUser` reports is a known quantity rather than whatever earlier cases
// happened to leave behind.
const SWEPT_USER = {
  id: "auth-user-swept",
  createdAt: NOW,
  displayName: "Swept User",
  email: "swept@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

const ACCESS_KEY_TRANSITION_USER = {
  id: "auth-user-access-key-transition",
  createdAt: NOW,
  displayName: "Access Key Transition User",
  email: "access-key-transition@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

const ACCESS_KEY_RESET_USER = {
  id: "auth-user-access-key-reset",
  createdAt: NOW,
  displayName: "Access Key Reset User",
  email: "access-key-reset@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

const ACCESS_KEY_COLLISION_USER = {
  id: "auth-user-access-key-collision",
  createdAt: NOW,
  displayName: "Access Key Collision User",
  email: "access-key-collision@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

const ACCESS_KEY_RESTART_USER = {
  id: "auth-user-access-key-restart",
  createdAt: NOW,
  displayName: "Access Key Restart User",
  email: "access-key-restart@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

// A fourth Sporades user, created by a case rather than seeded, so that `insertAuthUser` can be
// shown to store a row that was not there before and `updateAuthUserProfile` and `linkAuthUser`
// can rewrite one without disturbing a user another case reads.
const REGISTERED_USER = {
  id: "auth-user-registered",
  createdAt: NOW,
  displayName: "Registered User",
  email: "registered@example.com",
  picture: null,
  isAuthenticated: 0,
  isGuest: 1,
  provider: "guest",
};

const REGISTERED_SESSION_TOKEN = "session-registered";

// `insertOAuthState` defaults an unspecified expiry to ten minutes after creation.
const TEN_MINUTES_AFTER_NOW = "2026-08-01T09:10:00.000Z";

// The reserved Privileged server role identity is written with raw statements on purpose: the
// adapter's insert helpers refuse it, and a guard that suppresses it only means something when
// the rows it is meant to suppress are actually stored. Every lookup that joins the Sporades
// user table gets a reserved row to suppress.
async function seedReservedAuthUser(adapter) {
  const sql = adapter.dialect.sql;
  await adapter
    .prepare(
      sql(
        "INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], " +
        "[isGuest], [provider]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
    )
    .run(RESERVED_AUTH_USER_ID, NOW, "Privileged", RESERVED_EMAIL, null, 1, 0, "email");
  await adapter
    .prepare(
      sql("INSERT INTO [sporades_auth_sessions] ([token], [userId], [provider], [createdAt], [expiresAt]) VALUES (?, ?, ?, ?, ?)"),
    )
    .run("session-reserved", RESERVED_AUTH_USER_ID, "email", NOW, FAR_FUTURE);
  await adapter
    .prepare(
      sql(
        "INSERT INTO [sporades_auth_email_credentials] ([email], [userId], [passwordHash], [passwordSalt], [createdAt]) " +
        "VALUES (?, ?, ?, ?, ?)",
      ),
    )
    .run(RESERVED_EMAIL, RESERVED_AUTH_USER_ID, "reserved-hash", "reserved-salt", NOW);
  const insertIdentity = sql(
    "INSERT INTO [sporades_auth_identities] " +
    "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await adapter
    .prepare(insertIdentity)
    .run("identity-reserved", RESERVED_AUTH_USER_ID, "google", "reserved-subject", RESERVED_EMAIL, "Privileged", null, NOW, NOW);
  await adapter
    .prepare(insertIdentity)
    .run("identity-reserved-legacy", RESERVED_AUTH_USER_ID, "google", "legacy:reserved", RESERVED_EMAIL, "Privileged", null, NOW, NOW);
}

// Raw row counts, used only to prove a fixture is actually stored before asserting that a method
// declines to return it. Without that, a guard that never fires and a seed that never landed
// produce the same `null`.
async function countRows(adapter, sql, ...params) {
  const row = await adapter.prepare(adapter.dialect.sql(sql)).get(...params);
  return Number(row?.count ?? 0);
}

async function prepareAuthStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });

  await adapter.insertAuthUser(SIGNED_IN_USER);
  await adapter.insertAuthUser(BYSTANDER_USER);
  await adapter.insertAuthUser(SWEPT_USER);
  await adapter.insertAuthUser(ACCESS_KEY_TRANSITION_USER);
  await adapter.insertAuthUser(ACCESS_KEY_RESET_USER);
  await adapter.insertAuthUser(ACCESS_KEY_COLLISION_USER);
  await adapter.insertAuthUser(ACCESS_KEY_RESTART_USER);
  await seedReservedAuthUser(adapter);
}

function sessionFields(row) {
  return {
    token: row?.token,
    userId: row?.userId,
    provider: row?.provider,
    expiresAt: row?.expiresAt,
    displayName: row?.displayName,
    email: row?.email,
    picture: row?.picture,
    isAuthenticated: Number(row?.isAuthenticated),
    isGuest: Number(row?.isGuest),
  };
}

// Row projections rather than whole-row comparisons, matching the seeded surface. The engines
// agree on every column value but not on the row object's prototype — `node:sqlite` hands back
// null-prototype objects where the asynchronous engines build plain ones — and that is row
// representation, not what the method answers for a given stored state.
function identityFields(row) {
  return row === null || row === undefined
    ? row
    : {
        id: row.id,
        userId: row.userId,
        provider: row.provider,
        subject: row.subject,
        email: row.email,
        displayName: row.displayName,
        picture: row.picture,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
}

function oauthStateFields(row) {
  return row === null || row === undefined
    ? row
    : {
        state: row.state,
        provider: row.provider,
        sessionToken: row.sessionToken,
        returnTo: row.returnTo,
        redirectUri: row.redirectUri,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        nonce: row.nonce,
        pkceVerifier: row.pkceVerifier,
      };
}

function resetCodeFields(row) {
  return row === null || row === undefined
    ? row
    : {
        selector: row.selector,
        verifierHash: row.verifierHash,
        email: row.email,
        userId: row.userId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
}

function signedInSession(overrides) {
  return {
    token: "session-primary",
    userId: SIGNED_IN_USER.id,
    provider: "email",
    expiresAt: NEXT_MONTH,
    displayName: SIGNED_IN_USER.displayName,
    email: SIGNED_IN_USER.email,
    picture: SIGNED_IN_USER.picture,
    isAuthenticated: 1,
    isGuest: 0,
    ...overrides,
  };
}

const AUTH_STORAGE_CONFORMANCE_CASES = [
  {
    name: "insertAuthSession stores a Session that readAuthSessionWithUser returns with its joined Sporades user",
    async run(adapter) {
      assert.equal(await adapter.readAuthSessionWithUser("session-primary"), null);

      const inserted = await adapter.insertAuthSession({
        token: "session-primary",
        userId: SIGNED_IN_USER.id,
        provider: "email",
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(inserted.changes, 1);

      assert.deepEqual(sessionFields(await adapter.readAuthSessionWithUser("session-primary")), signedInSession());
      assert.equal(await adapter.readAuthSessionWithUser("session-never-issued"), null);
    },
  },
  {
    name: "insertAuthSession refuses the reserved Privileged server role identity",
    async run(adapter) {
      await assert.rejects(
        async () =>
          await adapter.insertAuthSession({
            token: "session-forged",
            userId: RESERVED_AUTH_USER_ID,
            provider: "email",
            createdAt: NOW,
            expiresAt: FAR_FUTURE,
          }),
        (error) => {
          assert.equal(error.code, "RESERVED_AUTH_USER_ID");
          return true;
        },
      );

      assert.equal(await adapter.readAuthSessionWithUser("session-forged"), null);
      assert.equal(await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [token] = ?", "session-forged"), 0);
    },
  },
  {
    name: "refreshAuthSession extends the named Session and reports nothing refreshed for an absent one",
    async run(adapter) {
      const refreshed = await adapter.refreshAuthSession("session-primary", FAR_FUTURE);
      assert.equal(refreshed.changes, 1);
      assert.equal((await adapter.readAuthSessionWithUser("session-primary")).expiresAt, FAR_FUTURE);

      const missed = await adapter.refreshAuthSession("session-never-issued", FAR_FUTURE);
      assert.equal(missed.changes, 0);
      assert.equal(await adapter.readAuthSessionWithUser("session-never-issued"), null);

      // Back to the fixture expiry so later cases read a known value.
      assert.equal((await adapter.refreshAuthSession("session-primary", NEXT_MONTH)).changes, 1);
      assert.equal((await adapter.readAuthSessionWithUser("session-primary")).expiresAt, NEXT_MONTH);
    },
  },
  {
    name: "setAuthSessionProvider records Session provenance on one Session without touching another",
    async run(adapter) {
      assert.equal(
        (await adapter.insertAuthSession({
          token: "session-provenance-bystander",
          userId: BYSTANDER_USER.id,
          provider: "email",
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        })).changes,
        1,
      );

      const changed = await adapter.setAuthSessionProvider("session-primary", "google");
      assert.equal(changed.changes, 1);
      assert.equal((await adapter.readAuthSessionWithUser("session-primary")).provider, "google");
      assert.equal((await adapter.readAuthSessionWithUser("session-provenance-bystander")).provider, "email");

      const missed = await adapter.setAuthSessionProvider("session-never-issued", "google");
      assert.equal(missed.changes, 0);

      assert.equal((await adapter.setAuthSessionProvider("session-primary", "email")).changes, 1);
      assert.equal((await adapter.readAuthSessionWithUser("session-primary")).provider, "email");
    },
  },
  {
    name: "rotateAuthSession replaces the previous Session token and leaves the old token unreadable",
    async run(adapter) {
      const rotated = await adapter.rotateAuthSession("session-primary", {
        token: "session-rotated",
        userId: SIGNED_IN_USER.id,
        provider: "google",
        createdAt: LATER,
        expiresAt: FAR_FUTURE,
      });
      assert.equal(rotated.changes, 1);

      assert.equal(await adapter.readAuthSessionWithUser("session-primary"), null);
      assert.deepEqual(
        sessionFields(await adapter.readAuthSessionWithUser("session-rotated")),
        signedInSession({ token: "session-rotated", provider: "google", expiresAt: FAR_FUTURE }),
      );

      const missed = await adapter.rotateAuthSession("session-never-issued", {
        token: "session-from-nowhere",
        userId: SIGNED_IN_USER.id,
        provider: "email",
        createdAt: LATER,
        expiresAt: FAR_FUTURE,
      });
      assert.equal(missed.changes, 0);
      assert.equal(await adapter.readAuthSessionWithUser("session-from-nowhere"), null);
    },
  },
  {
    name: "deleteAuthSession removes one Session and reports whether it removed anything",
    async run(adapter) {
      assert.equal(
        (await adapter.insertAuthSession({
          token: "session-disposable",
          userId: SIGNED_IN_USER.id,
          provider: "email",
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        })).changes,
        1,
      );
      assert.equal((await adapter.readAuthSessionWithUser("session-disposable")).userId, SIGNED_IN_USER.id);

      assert.equal((await adapter.deleteAuthSession("session-disposable")).changes, 1);
      assert.equal(await adapter.readAuthSessionWithUser("session-disposable"), null);

      assert.equal((await adapter.deleteAuthSession("session-disposable")).changes, 0);

      // Deleting one Session leaves the Sporades user's other Sessions alone.
      assert.equal((await adapter.readAuthSessionWithUser("session-rotated")).token, "session-rotated");
    },
  },
  {
    name: "deleteAuthSessionsForUser removes every Session for one Sporades user and leaves other users' Sessions",
    async run(adapter) {
      const sweptTokens = ["session-swept-a", "session-swept-b", "session-swept-c"];
      for (const token of sweptTokens) {
        assert.equal(
          (await adapter.insertAuthSession({
            token,
            userId: SWEPT_USER.id,
            provider: "email",
            createdAt: NOW,
            expiresAt: NEXT_MONTH,
          })).changes,
          1,
        );
      }
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [userId] = ?", SWEPT_USER.id),
        3,
      );

      const swept = await adapter.deleteAuthSessionsForUser(SWEPT_USER.id);
      assert.equal(swept.changes, 3);
      for (const token of sweptTokens) {
        assert.equal(await adapter.readAuthSessionWithUser(token), null);
      }
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [userId] = ?", SWEPT_USER.id),
        0,
      );

      // Another Sporades user's Sessions survive, and a second sweep of the emptied user reports
      // nothing removed rather than repeating the first answer.
      assert.equal((await adapter.readAuthSessionWithUser("session-rotated")).userId, SIGNED_IN_USER.id);
      assert.equal((await adapter.readAuthSessionWithUser("session-provenance-bystander")).userId, BYSTANDER_USER.id);
      assert.equal((await adapter.deleteAuthSessionsForUser(SWEPT_USER.id)).changes, 0);
    },
  },
  {
    name: "findAuthIdentityByProviderSubject finds a Provider identity by its provider and subject pair",
    async run(adapter) {
      assert.equal(await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in"), null);

      const inserted = await adapter.insertAuthIdentity({
        id: "identity-signed-in",
        userId: SIGNED_IN_USER.id,
        provider: "google",
        subject: "subject-signed-in",
        email: "signed-in@gmail.example.com",
        displayName: "Signed In User",
        picture: "https://example.com/identity.png",
        createdAt: NOW,
        updatedAt: NOW,
      });
      assert.equal(inserted.changes, 1);

      assert.deepEqual(identityFields(await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in")), {
        id: "identity-signed-in",
        userId: SIGNED_IN_USER.id,
        provider: "google",
        subject: "subject-signed-in",
        email: "signed-in@gmail.example.com",
        displayName: "Signed In User",
        picture: "https://example.com/identity.png",
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Both halves of the identity key have to match: a Provider subject is meaningful only
      // together with its provider.
      assert.equal(await adapter.findAuthIdentityByProviderSubject("google", "subject-never-linked"), null);
      assert.equal(await adapter.findAuthIdentityByProviderSubject("microsoft", "subject-signed-in"), null);
    },
  },
  {
    name: "updateAuthIdentity rewrites one Provider identity's mutable attributes and its subject",
    async run(adapter) {
      const updated = await adapter.updateAuthIdentity({
        id: "identity-signed-in",
        subject: "subject-signed-in-renumbered",
        email: "renamed@gmail.example.com",
        displayName: "Renamed User",
        picture: null,
        updatedAt: LATER,
      });
      assert.equal(updated.changes, 1);

      assert.equal(await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in"), null);
      assert.deepEqual(identityFields(await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in-renumbered")), {
        id: "identity-signed-in",
        userId: SIGNED_IN_USER.id,
        provider: "google",
        subject: "subject-signed-in-renumbered",
        email: "renamed@gmail.example.com",
        displayName: "Renamed User",
        picture: null,
        createdAt: NOW,
        updatedAt: LATER,
      });

      const missed = await adapter.updateAuthIdentity({
        id: "identity-never-stored",
        subject: "subject-from-nowhere",
        email: null,
        displayName: null,
        picture: null,
        updatedAt: LATER,
      });
      assert.equal(missed.changes, 0);
      assert.equal(await adapter.findAuthIdentityByProviderSubject("google", "subject-from-nowhere"), null);
    },
  },
  {
    name: "findLegacyAuthIdentitiesByProviderEmail returns only the legacy identities for that provider email",
    async run(adapter) {
      assert.deepEqual(await adapter.findLegacyAuthIdentitiesByProviderEmail("google", "legacy-owner@example.com"), []);

      // Inserted newest first so the returned order proves the query orders by createdAt rather
      // than by insertion.
      for (const identity of [
        { id: "identity-legacy-second", subject: "legacy:second", createdAt: LATER },
        { id: "identity-legacy-first", subject: "legacy:first", createdAt: NOW },
      ]) {
        await adapter.insertAuthIdentity({
          id: identity.id,
          userId: BYSTANDER_USER.id,
          provider: "google",
          subject: identity.subject,
          email: "legacy-owner@example.com",
          displayName: "Legacy Owner",
          picture: null,
          createdAt: identity.createdAt,
          updatedAt: identity.createdAt,
        });
      }
      // Same provider and email, but a modern Provider subject rather than a legacy one.
      await adapter.insertAuthIdentity({
        id: "identity-legacy-modern",
        userId: BYSTANDER_USER.id,
        provider: "google",
        subject: "modern-subject",
        email: "legacy-owner@example.com",
        displayName: "Legacy Owner",
        picture: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // Same email and a legacy subject, but a different provider.
      await adapter.insertAuthIdentity({
        id: "identity-legacy-other-provider",
        userId: BYSTANDER_USER.id,
        provider: "microsoft",
        subject: "legacy:other-provider",
        email: "legacy-owner@example.com",
        displayName: "Legacy Owner",
        picture: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      assert.deepEqual(
        (await adapter.findLegacyAuthIdentitiesByProviderEmail("google", "legacy-owner@example.com")).map((row) => row.id),
        ["identity-legacy-first", "identity-legacy-second"],
      );
      assert.deepEqual(
        (await adapter.findLegacyAuthIdentitiesByProviderEmail("microsoft", "legacy-owner@example.com")).map((row) => row.id),
        ["identity-legacy-other-provider"],
      );
      assert.deepEqual(await adapter.findLegacyAuthIdentitiesByProviderEmail("google", "nobody@example.com"), []);

      const [first] = await adapter.findLegacyAuthIdentitiesByProviderEmail("google", "legacy-owner@example.com");
      assert.deepEqual(identityFields(first), {
        id: "identity-legacy-first",
        userId: BYSTANDER_USER.id,
        provider: "google",
        subject: "legacy:first",
        email: "legacy-owner@example.com",
        displayName: "Legacy Owner",
        picture: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
  },
  {
    name: "every lookup joining the Sporades user table refuses the reserved Privileged server role identity",
    async run(adapter) {
      // The guards are only meaningful if the rows they suppress are stored, so prove that first.
      // Otherwise a guard that never fires and a fixture that never seeded look identical.
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?", RESERVED_AUTH_USER_ID),
        1,
      );
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [token] = ?", "session-reserved"),
        1,
      );
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_email_credentials] WHERE [email] = ?", RESERVED_EMAIL),
        1,
      );
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_identities] WHERE [userId] = ?", RESERVED_AUTH_USER_ID),
        2,
      );

      assert.equal(await adapter.readAuthSessionWithUser("session-reserved"), null);
      assert.equal(await adapter.findEmailCredentialWithUser(RESERVED_EMAIL), null);
      // The boundary of the guard, asserted rather than left implied: `emailCredentialExists`
      // does not join the Sporades user table, so it reports the address as taken and keeps the
      // reserved address from being registered, while returning no Sporades user attributes.
      assert.equal(await adapter.emailCredentialExists(RESERVED_EMAIL), true);
      assert.equal(await adapter.findAuthIdentityByProviderSubject("google", "reserved-subject"), null);
      assert.deepEqual(await adapter.findLegacyAuthIdentitiesByProviderEmail("google", RESERVED_EMAIL), []);

      // The same lookups still answer for an ordinary Sporades user, so the guard suppresses the
      // reserved identity rather than everything.
      assert.equal((await adapter.readAuthSessionWithUser("session-rotated")).userId, SIGNED_IN_USER.id);
      assert.equal(
        (await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in-renumbered")).userId,
        SIGNED_IN_USER.id,
      );
      assert.equal((await adapter.findLegacyAuthIdentitiesByProviderEmail("google", "legacy-owner@example.com")).length, 2);
    },
  },
  {
    name: "insertEmailCredential registers an address that emailCredentialExists then distinguishes from an unregistered one",
    async run(adapter) {
      assert.equal(await adapter.emailCredentialExists(SIGNED_IN_USER.email), false);
      assert.equal(await adapter.emailCredentialExists("unregistered@example.com"), false);

      const inserted = await adapter.insertEmailCredential({
        email: SIGNED_IN_USER.email,
        userId: SIGNED_IN_USER.id,
        passwordHash: "hash-original",
        passwordSalt: "salt-original",
        createdAt: NOW,
      });
      assert.equal(inserted.changes, 1);

      assert.equal(await adapter.emailCredentialExists(SIGNED_IN_USER.email), true);
      assert.equal(await adapter.emailCredentialExists("unregistered@example.com"), false);

      await assert.rejects(
        async () =>
          await adapter.insertEmailCredential({
            email: "forged@example.com",
            userId: RESERVED_AUTH_USER_ID,
            passwordHash: "hash",
            passwordSalt: "salt",
            createdAt: NOW,
          }),
        (error) => {
          assert.equal(error.code, "RESERVED_AUTH_USER_ID");
          return true;
        },
      );
      assert.equal(await adapter.emailCredentialExists("forged@example.com"), false);
    },
  },
  {
    name: "findEmailCredentialWithUser returns the stored secret joined to its Sporades user",
    async run(adapter) {
      const found = await adapter.findEmailCredentialWithUser(SIGNED_IN_USER.email);
      assert.deepEqual(
        {
          email: found?.email,
          userId: found?.userId,
          passwordHash: found?.passwordHash,
          passwordSalt: found?.passwordSalt,
          displayName: found?.displayName,
          picture: found?.picture,
          isAuthenticated: Number(found?.isAuthenticated),
          isGuest: Number(found?.isGuest),
        },
        {
          email: SIGNED_IN_USER.email,
          userId: SIGNED_IN_USER.id,
          passwordHash: "hash-original",
          passwordSalt: "salt-original",
          displayName: SIGNED_IN_USER.displayName,
          picture: SIGNED_IN_USER.picture,
          isAuthenticated: 1,
          isGuest: 0,
        },
      );

      assert.equal(await adapter.findEmailCredentialWithUser("unregistered@example.com"), null);
    },
  },
  {
    name: "updateEmailCredentialPassword replaces the secret for one address only",
    async run(adapter) {
      await adapter.insertEmailCredential({
        email: BYSTANDER_USER.email,
        userId: BYSTANDER_USER.id,
        passwordHash: "bystander-hash",
        passwordSalt: "bystander-salt",
        createdAt: NOW,
      });

      const updated = await adapter.updateEmailCredentialPassword(SIGNED_IN_USER.email, "hash-rotated", "salt-rotated");
      assert.equal(updated.changes, 1);

      const rotated = await adapter.findEmailCredentialWithUser(SIGNED_IN_USER.email);
      assert.deepEqual(
        { passwordHash: rotated?.passwordHash, passwordSalt: rotated?.passwordSalt },
        { passwordHash: "hash-rotated", passwordSalt: "salt-rotated" },
      );

      const untouched = await adapter.findEmailCredentialWithUser(BYSTANDER_USER.email);
      assert.deepEqual(
        { passwordHash: untouched?.passwordHash, passwordSalt: untouched?.passwordSalt },
        { passwordHash: "bystander-hash", passwordSalt: "bystander-salt" },
      );

      const missed = await adapter.updateEmailCredentialPassword("unregistered@example.com", "hash-rotated", "salt-rotated");
      assert.equal(missed.changes, 0);
      assert.equal(await adapter.emailCredentialExists("unregistered@example.com"), false);
    },
  },
  {
    name: "insertPasswordResetCode issues a Reset code that findPasswordResetCode returns by selector",
    async run(adapter) {
      assert.equal(await adapter.findPasswordResetCode("reset-never-issued"), null);

      const issued = await adapter.insertPasswordResetCode({
        selector: "reset-selector-live",
        verifierHash: "verifier-hash-live",
        email: SIGNED_IN_USER.email,
        userId: SIGNED_IN_USER.id,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(issued.changes, 1);

      assert.deepEqual(resetCodeFields(await adapter.findPasswordResetCode("reset-selector-live")), {
        selector: "reset-selector-live",
        verifierHash: "verifier-hash-live",
        email: SIGNED_IN_USER.email,
        userId: SIGNED_IN_USER.id,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(await adapter.findPasswordResetCode("reset-never-issued"), null);

      await assert.rejects(
        async () =>
          await adapter.insertPasswordResetCode({
            selector: "reset-selector-forged",
            verifierHash: "verifier-hash-forged",
            email: RESERVED_EMAIL,
            userId: RESERVED_AUTH_USER_ID,
            createdAt: NOW,
            expiresAt: NEXT_MONTH,
          }),
        (error) => {
          assert.equal(error.code, "RESERVED_AUTH_USER_ID");
          return true;
        },
      );
      assert.equal(await adapter.findPasswordResetCode("reset-selector-forged"), null);
    },
  },
  {
    name: "countPasswordResetCodesForEmail counts outstanding Reset codes and excludes expired ones",
    async run(adapter) {
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 1);
      assert.equal(await adapter.countPasswordResetCodesForEmail("nobody@example.com", NOW), 0);

      await adapter.insertPasswordResetCode({
        selector: "reset-selector-live-second",
        verifierHash: "verifier-hash-live-second",
        email: SIGNED_IN_USER.email,
        userId: SIGNED_IN_USER.id,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 2);

      // An expired Reset code is stored but is not outstanding, because the ADR-0033 cap is a cap
      // on codes a user could still spend.
      await adapter.insertPasswordResetCode({
        selector: "reset-selector-expired",
        verifierHash: "verifier-hash-expired",
        email: SIGNED_IN_USER.email,
        userId: SIGNED_IN_USER.id,
        createdAt: LONG_PAST_CREATED,
        expiresAt: LONG_PAST_EXPIRED,
      });
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] WHERE [email] = ?", SIGNED_IN_USER.email),
        3,
      );
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 2);

      // The same stored rows count as zero once the clock passes their expiry, so the exclusion
      // follows the supplied instant rather than a fixed row.
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, FAR_FUTURE), 0);

      // The count is per email address, not per Sporades user.
      await adapter.insertPasswordResetCode({
        selector: "reset-selector-bystander",
        verifierHash: "verifier-hash-bystander",
        email: BYSTANDER_USER.email,
        userId: BYSTANDER_USER.id,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(await adapter.countPasswordResetCodesForEmail(BYSTANDER_USER.email, NOW), 1);
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 2);
    },
  },
  {
    name: "prunePasswordResetCodes removes expired Reset codes and keeps outstanding ones",
    async run(adapter) {
      const pruned = await adapter.prunePasswordResetCodes(NOW);
      assert.equal(pruned.changes, 1);

      assert.equal(await adapter.findPasswordResetCode("reset-selector-expired"), null);
      assert.equal((await adapter.findPasswordResetCode("reset-selector-live")).verifierHash, "verifier-hash-live");
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 2);

      // Nothing is left to prune at the same instant, and pruning past every expiry removes the
      // rest, so the predicate is exercised on both sides.
      assert.equal((await adapter.prunePasswordResetCodes(NOW)).changes, 0);
      assert.equal((await adapter.prunePasswordResetCodes(FAR_FUTURE)).changes, 3);
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 0);
      assert.equal(await adapter.findPasswordResetCode("reset-selector-live"), null);
    },
  },
  {
    name: "deletePasswordResetCode consumes one exact Reset code and the user sweep removes its siblings",
    async run(adapter) {
      for (const selector of ["reset-selector-sweep-a", "reset-selector-sweep-b"]) {
        await adapter.insertPasswordResetCode({
          selector,
          verifierHash: `verifier-hash-${selector}`,
          email: SIGNED_IN_USER.email,
          userId: SIGNED_IN_USER.id,
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        });
      }
      await adapter.insertPasswordResetCode({
        selector: "reset-selector-sweep-bystander",
        verifierHash: "verifier-hash-sweep-bystander",
        email: BYSTANDER_USER.email,
        userId: BYSTANDER_USER.id,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 2);

      const consumed = await adapter.deletePasswordResetCode("reset-selector-sweep-a");
      assert.equal(consumed.changes, 1);
      assert.equal(await adapter.findPasswordResetCode("reset-selector-sweep-a"), null);
      assert.equal((await adapter.findPasswordResetCode("reset-selector-sweep-b")).userId, SIGNED_IN_USER.id);
      assert.equal((await adapter.findPasswordResetCode("reset-selector-sweep-bystander")).userId, BYSTANDER_USER.id);
      assert.equal((await adapter.deletePasswordResetCode("reset-selector-sweep-a")).changes, 0);

      const deleted = await adapter.deletePasswordResetCodesForUser(SIGNED_IN_USER.id);
      assert.equal(deleted.changes, 1);
      assert.equal(await adapter.countPasswordResetCodesForEmail(SIGNED_IN_USER.email, NOW), 0);
      assert.equal(await adapter.findPasswordResetCode("reset-selector-sweep-a"), null);
      assert.equal(await adapter.findPasswordResetCode("reset-selector-sweep-b"), null);

      // Another Sporades user's Reset codes survive, and a second sweep reports nothing removed.
      assert.equal((await adapter.findPasswordResetCode("reset-selector-sweep-bystander")).userId, BYSTANDER_USER.id);
      assert.equal(await adapter.countPasswordResetCodesForEmail(BYSTANDER_USER.email, NOW), 1);
      assert.equal((await adapter.deletePasswordResetCodesForUser(SIGNED_IN_USER.id)).changes, 0);
    },
  },
  {
    name: "insertAuthUser stores a Sporades user that a Session join reads back, and refuses the reserved identity",
    async run(adapter) {
      assert.equal(await adapter.readAuthSessionWithUser(REGISTERED_SESSION_TOKEN), null);

      assert.equal((await adapter.insertAuthUser(REGISTERED_USER)).changes, 1);

      // The adapter reads a Sporades user row only through a join, so the stored row is asserted
      // through the Session lookup that a request actually takes.
      await adapter.insertAuthSession({
        token: REGISTERED_SESSION_TOKEN,
        userId: REGISTERED_USER.id,
        provider: "guest",
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      assert.deepEqual(sessionFields(await adapter.readAuthSessionWithUser(REGISTERED_SESSION_TOKEN)), {
        token: REGISTERED_SESSION_TOKEN,
        userId: REGISTERED_USER.id,
        provider: "guest",
        expiresAt: NEXT_MONTH,
        displayName: REGISTERED_USER.displayName,
        email: REGISTERED_USER.email,
        picture: null,
        isAuthenticated: 0,
        isGuest: 1,
      });

      // The other side of the reserved-identity guard, which the insert helpers enforce rather
      // than suppress.
      await assert.rejects(
        async () => await adapter.insertAuthUser({ ...REGISTERED_USER, id: RESERVED_AUTH_USER_ID, email: "forged@example.com" }),
        (error) => {
          assert.equal(error.code, "RESERVED_AUTH_USER_ID");
          return true;
        },
      );
    },
  },
  {
    name: "updateAuthUserProfile rewrites profile attributes and linkAuthUser additionally rewrites the address",
    async run(adapter) {
      const updated = await adapter.updateAuthUserProfile({
        id: REGISTERED_USER.id,
        displayName: "Registered User Renamed",
        picture: "https://example.com/registered.png",
        isAuthenticated: 1,
        isGuest: 0,
      });
      assert.equal(updated.changes, 1);

      // The profile columns change and the address does not, which is what separates this method
      // from `linkAuthUser` below.
      assert.deepEqual(sessionFields(await adapter.readAuthSessionWithUser(REGISTERED_SESSION_TOKEN)), {
        token: REGISTERED_SESSION_TOKEN,
        userId: REGISTERED_USER.id,
        provider: "guest",
        expiresAt: NEXT_MONTH,
        displayName: "Registered User Renamed",
        email: REGISTERED_USER.email,
        picture: "https://example.com/registered.png",
        isAuthenticated: 1,
        isGuest: 0,
      });

      const linked = await adapter.linkAuthUser({
        id: REGISTERED_USER.id,
        displayName: "Registered User Linked",
        email: "registered-linked@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
      });
      assert.equal(linked.changes, 1);
      assert.deepEqual(sessionFields(await adapter.readAuthSessionWithUser(REGISTERED_SESSION_TOKEN)), {
        token: REGISTERED_SESSION_TOKEN,
        userId: REGISTERED_USER.id,
        provider: "guest",
        expiresAt: NEXT_MONTH,
        displayName: "Registered User Linked",
        email: "registered-linked@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
      });

      // Both sides of each write: a Sporades user that does not exist is reported as unchanged
      // rather than silently created, and neither method will touch the reserved identity.
      const absent = { id: "auth-user-absent", displayName: "Nobody", email: "nobody@example.com", picture: null, isAuthenticated: 1, isGuest: 0 };
      assert.equal((await adapter.updateAuthUserProfile(absent)).changes, 0);
      assert.equal((await adapter.linkAuthUser(absent)).changes, 0);

      for (const write of ["updateAuthUserProfile", "linkAuthUser"]) {
        await assert.rejects(
          async () => await adapter[write]({ ...absent, id: RESERVED_AUTH_USER_ID }),
          (error) => {
            assert.equal(error.code, "RESERVED_AUTH_USER_ID");
            return true;
          },
        );
      }

      // The reserved row really is stored, so the refusals above suppressed a write that would
      // otherwise have landed rather than failing over an absent row.
      assert.equal(await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?", RESERVED_AUTH_USER_ID), 1);
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ? AND [displayName] = ?", RESERVED_AUTH_USER_ID, "Privileged"),
        1,
      );
    },
  },
  {
    // `consumeOAuthState` is the override ADR-0034 names as a genuine dialect difference: a SELECT
    // followed by a DELETE in the shared definition, a single `DELETE ... RETURNING` on Postgres
    // and libSQL. An override may change the statement text; it may not change the answer, and
    // reading the two bodies cannot establish which it did. This case is what establishes it.
    name: "insertOAuthState stores an OAuth state that consumeOAuthState returns once and then forgets",
    async run(adapter) {
      assert.equal(await adapter.consumeOAuthState("oauth-state-never-issued"), null);

      const inserted = await adapter.insertOAuthState({
        state: "oauth-state-explicit",
        provider: "github",
        sessionToken: "session-oauth",
        returnTo: "/after-sign-in",
        redirectUri: "https://example.com/auth/callback",
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
        nonce: "nonce-explicit",
        pkceVerifier: "verifier-explicit",
      });
      assert.equal(inserted.changes, 1);

      assert.deepEqual(oauthStateFields(await adapter.consumeOAuthState("oauth-state-explicit")), {
        state: "oauth-state-explicit",
        provider: "github",
        sessionToken: "session-oauth",
        returnTo: "/after-sign-in",
        redirectUri: "https://example.com/auth/callback",
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
        nonce: "nonce-explicit",
        pkceVerifier: "verifier-explicit",
      });

      // Consuming spends the state, so the second read answers as it did before the state existed.
      assert.equal(await adapter.consumeOAuthState("oauth-state-explicit"), null);
      assert.equal(await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_oauth_states] WHERE [state] = ?", "oauth-state-explicit"), 0);

      // The defaults the method fills in for an OAuth start that supplies neither: the provider,
      // an expiry ten minutes after creation, and null for the optional secrets.
      await adapter.insertOAuthState({
        state: "oauth-state-defaulted",
        sessionToken: "session-oauth",
        returnTo: "/",
        redirectUri: "https://example.com/auth/callback",
        createdAt: NOW,
      });
      assert.deepEqual(oauthStateFields(await adapter.consumeOAuthState("oauth-state-defaulted")), {
        state: "oauth-state-defaulted",
        provider: "google",
        sessionToken: "session-oauth",
        returnTo: "/",
        redirectUri: "https://example.com/auth/callback",
        createdAt: NOW,
        expiresAt: TEN_MINUTES_AFTER_NOW,
        nonce: null,
        pkceVerifier: null,
      });

      // One state is consumed by name, so a second stored state is left alone by the first's read.
      await adapter.insertOAuthState({ state: "oauth-state-kept", sessionToken: "session-oauth", returnTo: "/", redirectUri: "https://example.com/auth/callback", createdAt: NOW });
      await adapter.insertOAuthState({ state: "oauth-state-spent", sessionToken: "session-oauth", returnTo: "/", redirectUri: "https://example.com/auth/callback", createdAt: NOW });
      assert.equal((await adapter.consumeOAuthState("oauth-state-spent")).state, "oauth-state-spent");
      assert.equal((await adapter.consumeOAuthState("oauth-state-kept")).state, "oauth-state-kept");
    },
  },
  {
    name: "Access-key lifecycle methods preserve owner, selector, and revocation invariants",
    async run(adapter) {
      const record = {
        id: "access-key-conformance",
        ownerUserId: SIGNED_IN_USER.id,
        name: "conformance-reader",
        reservedName: "conformance-reader",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "abcdefghijklmnopqrstuv",
        verifierDigest: "ab".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
      assert.equal((await adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
        ...record,
        id: "access-key-name-collision",
        selector: "bcdefghijklmnopqrstuvw",
      }))).status, "name-conflict");

      const listed = await adapter.listAccessKeyRecordsForOwner(SIGNED_IN_USER.id);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, record.id);
      assert.equal(listed[0].grantsJson, record.grantsJson);
      assert.equal((await adapter.listAccessKeyRecordsForOwner(BYSTANDER_USER.id)).length, 0);

      const inspected = await adapter.findAccessKeyRecordById(record.id);
      assert.equal(inspected.id, record.id);
      assert.equal(inspected.ownerUserId, SIGNED_IN_USER.id);
      assert.equal(inspected.grantsJson, record.grantsJson);
      assert.equal(inspected.selector, undefined);
      assert.equal(inspected.verifierDigest, undefined);
      assert.equal(await adapter.findAccessKeyRecordById("unknown-access-key-id"), null);

      const authenticated = await adapter.findAccessKeyAuthenticationRecord(record.selector);
      assert.equal(authenticated.id, record.id);
      assert.equal(authenticated.ownerDisplayName, SIGNED_IN_USER.displayName);
      assert.equal(Number(authenticated.ownerIsAuthenticated), 1);
      assert.equal(await adapter.findAccessKeyAuthenticationRecord("unknown-selector-value"), null);
      assert.equal((await adapter.touchAccessKeyLastUsed(record.id, LATER, NOW)).changes, 1);
      assert.equal((await adapter.touchAccessKeyLastUsed(record.id, NEXT_MONTH, LATER)).changes, 0);

      const revoked = await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: SIGNED_IN_USER.id,
        id: record.id,
        revokedAt: LATER,
        revocationCause: "owner",
      }));
      assert.equal(revoked.revokedAt, LATER);
      assert.equal(revoked.revocationCause, "owner");
      assert.equal(Number(revoked.lifecycleRevision), 2);
      assert.equal(await adapter.findAccessKeyAuthenticationRecord(record.selector), null);
      const idempotent = await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: SIGNED_IN_USER.id,
        id: record.id,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner",
      }));
      assert.equal(idempotent.revokedAt, LATER);
      assert.equal(Number(idempotent.lifecycleRevision), 2);
      assert.equal(await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: BYSTANDER_USER.id,
        id: record.id,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner",
      })), null);

      const ledger = await adapter.prepare(adapter.dialect.sql(
        "SELECT [currentCount], [totalCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?",
      )).get(SIGNED_IN_USER.id);
      assert.equal(Number(ledger.currentCount), 0);
      assert.equal(Number(ledger.totalCount), 1);

      const reused = { ...record, id: "access-key-name-reused", selector: "cdefghijklmnopqrstuvwx" };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(reused)), { status: "issued" });
      assert.equal((await adapter.findAccessKeyAuthenticationRecord(reused.selector)).id, reused.id);
      await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: SIGNED_IN_USER.id,
        id: reused.id,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner",
      }));
    },
  },
  {
    name: "Access-key issuance serializes same-name contenders and rolls back quota reservations",
    async run(adapter) {
      const contender = (suffix) => ({
        id: `access-key-contender-${suffix}`,
        ownerUserId: SIGNED_IN_USER.id,
        name: "concurrent-reader",
        reservedName: "concurrent-reader",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: suffix === "a" ? "defghijklmnopqrstuvwxy" : "efghijklmnopqrstuvwxyz",
        verifierDigest: (suffix === "a" ? "cd" : "de").repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      });
      const outcomes = await Promise.all([
        adapter.withTransaction((tx) => tx.issueAccessKeyRecord(contender("a"))),
        adapter.withTransaction((tx) => tx.issueAccessKeyRecord(contender("b"))),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["issued", "name-conflict"]);
      const winner = (await adapter.listAccessKeyRecordsForOwner(SIGNED_IN_USER.id))
        .find((row) => row.name === "concurrent-reader");
      assert.ok(winner);
      await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: SIGNED_IN_USER.id,
        id: winner.id,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner",
      }));

      const rollbackMarker = new Error("rollback Access-key issuance");
      await assert.rejects(
        adapter.withTransaction(async (tx) => {
          assert.deepEqual(await tx.issueAccessKeyRecord({
            ...contender("a"),
            id: "access-key-rolled-back",
            name: "rolled-back-reader",
            reservedName: "rolled-back-reader",
            selector: "fghijklmnopqrstuvwxyza",
          }), { status: "issued" });
          throw rollbackMarker;
        }),
        rollbackMarker,
      );
      assert.equal(
        (await adapter.listAccessKeyRecordsForOwner(SIGNED_IN_USER.id)).some((row) => row.id === "access-key-rolled-back"),
        false,
      );
    },
  },
  {
    name: "Access-key rotation CAS, bulk retirement, and revoked-history deletion preserve lifecycle invariants",
    async run(adapter) {
      const record = {
        id: "access-key-complete-lifecycle",
        ownerUserId: SIGNED_IN_USER.id,
        name: "complete-lifecycle",
        reservedName: "complete-lifecycle",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "hijklmnopqrstuvwxyzabc",
        verifierDigest: "ac".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
      const rotated = await adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
        ownerUserId: record.ownerUserId,
        id: record.id,
        lifecycleRevision: 1,
        secretVersion: 1,
        selector: "ijklmnopqrstuvwxyzabcd",
        verifierDigest: "bd".repeat(32),
        rotatedAt: LATER,
      }));
      assert.equal(rotated.status, "rotated");
      assert.equal(Number(rotated.record.lifecycleRevision), 2);
      assert.equal(rotated.record.name, record.name);
      assert.equal(rotated.record.grantsJson, record.grantsJson);
      assert.equal(rotated.record.expiresAt, record.expiresAt);
      assert.equal(await adapter.findAccessKeyAuthenticationRecord(record.selector), null);
      assert.equal((await adapter.findAccessKeyAuthenticationRecord("ijklmnopqrstuvwxyzabcd")).id, record.id);
      assert.equal((await adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
        ownerUserId: record.ownerUserId,
        id: record.id,
        lifecycleRevision: 1,
        secretVersion: 1,
        selector: "jklmnopqrstuvwxyzabcde",
        verifierDigest: "ce".repeat(32),
        rotatedAt: "2026-08-01T10:00:00.000Z",
      }))).status, "revision-conflict");

      const bulk = await adapter.withTransaction((tx) => tx.bulkRevokeAccessKeysForOwner({
        ownerUserId: record.ownerUserId,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner-unlinked",
      }));
      assert.ok(bulk.revokedCount >= 1);
      const retired = (await adapter.listAccessKeyRecordsForOwner(record.ownerUserId)).find((row) => row.id === record.id);
      assert.equal(retired.revocationCause, "owner-unlinked");
      assert.equal(Number(retired.lifecycleRevision), 3);
      assert.equal(await adapter.findAccessKeyAuthenticationRecord("ijklmnopqrstuvwxyzabcd"), null);
      const deleted = await adapter.withTransaction((tx) => tx.deleteRevokedAccessKeyRecord({
        ownerUserId: record.ownerUserId,
        id: record.id,
      }));
      assert.deepEqual({ status: deleted.status, id: deleted.id }, { status: "deleted", id: record.id });
      assert.equal((await adapter.listAccessKeyRecordsForOwner(record.ownerUserId)).some((row) => row.id === record.id), false);

      const competing = {
        ...record,
        id: "access-key-competing-rotation",
        name: "competing-rotation",
        reservedName: "competing-rotation",
        selector: "klmnopqrstuvwxyzabcdef",
      };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(competing)), { status: "issued" });
      const rotations = await Promise.all([
        adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
          ownerUserId: competing.ownerUserId,
          id: competing.id,
          lifecycleRevision: 1,
          secretVersion: 1,
          selector: "lmnopqrstuvwxyzabcdefg",
          verifierDigest: "df".repeat(32),
          rotatedAt: LATER,
        })),
        adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
          ownerUserId: competing.ownerUserId,
          id: competing.id,
          lifecycleRevision: 1,
          secretVersion: 1,
          selector: "mnopqrstuvwxyzabcdefgh",
          verifierDigest: "e1".repeat(32),
          rotatedAt: LATER,
        })),
      ]);
      assert.deepEqual(rotations.map((outcome) => outcome.status).sort(), ["revision-conflict", "rotated"]);
      await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
        ownerUserId: competing.ownerUserId,
        id: competing.id,
        revokedAt: NEXT_MONTH,
        revocationCause: "owner",
      }));
      await adapter.withTransaction((tx) => tx.deleteRevokedAccessKeyRecord({ ownerUserId: competing.ownerUserId, id: competing.id }));
    },
  },
  {
    name: "Access-key rotation normalizes a cross-owner selector race",
    async run(adapter) {
      const left = {
        id: "access-key-selector-race-left",
        ownerUserId: SIGNED_IN_USER.id,
        name: "selector-race-left",
        reservedName: "selector-race-left",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "selectorraceleft0000000",
        verifierDigest: "d1".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      const right = {
        ...left,
        id: "access-key-selector-race-right",
        ownerUserId: ACCESS_KEY_COLLISION_USER.id,
        name: "selector-race-right",
        reservedName: "selector-race-right",
        selector: "selectorraceright000000",
      };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(left)), { status: "issued" });
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(right)), { status: "issued" });
      const selector = "sharedrotationselector0";
      const results = await Promise.all([left, right].map((record, index) =>
        adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
          ownerUserId: record.ownerUserId,
          id: record.id,
          lifecycleRevision: 1,
          secretVersion: 1,
          selector,
          verifierDigest: `${index + 2}a`.repeat(32),
          rotatedAt: LATER,
        }))));
      assert.deepEqual(results.map((result) => result.status).sort(), ["rotated", "selector-conflict"]);
      assert.equal((await adapter.findAccessKeyAuthenticationRecord(selector)).id,
        results[0].status === "rotated" ? left.id : right.id);
      for (const record of [left, right]) {
        await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
          ownerUserId: record.ownerUserId,
          id: record.id,
          revokedAt: NEXT_MONTH,
          revocationCause: "owner",
        }));
        await adapter.withTransaction((tx) => tx.deleteRevokedAccessKeyRecord({ ownerUserId: record.ownerUserId, id: record.id }));
      }
    },
  },
  {
    name: "Access-key issuance serializes with unlink and owner deletion transitions",
    async run(adapter) {
      const raced = {
        id: "access-key-owner-transition-race",
        ownerUserId: ACCESS_KEY_TRANSITION_USER.id,
        name: "owner-transition-race",
        reservedName: "owner-transition-race",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "ownertransitionrace000",
        verifierDigest: "d2".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      let releaseTransition;
      let transitionLocked;
      const locked = new Promise((resolve) => { transitionLocked = resolve; });
      const release = new Promise((resolve) => { releaseTransition = resolve; });
      const transition = adapter.withTransaction(async (tx) => {
          await tx.bulkRevokeAccessKeysForOwner({
            ownerUserId: raced.ownerUserId,
            revokedAt: LATER,
            revocationCause: "owner-unlinked",
          });
          transitionLocked();
          await release;
          await tx.updateAuthUserProfile({
            id: raced.ownerUserId,
            displayName: ACCESS_KEY_TRANSITION_USER.displayName,
            picture: null,
            isAuthenticated: 0,
            isGuest: 1,
          });
      });
      await locked;
      const issue = adapter.withTransaction((tx) => tx.issueAccessKeyRecord(raced));
      releaseTransition();
      const [, issueOutcome] = await Promise.all([transition, issue]);
      assert.equal(issueOutcome.status, "owner-ineligible");
      const ledger = await adapter.prepare(adapter.dialect.sql(
        "SELECT [currentCount], [totalCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?",
      )).get(raced.ownerUserId);
      assert.deepEqual({ currentCount: Number(ledger.currentCount), totalCount: Number(ledger.totalCount) }, {
        currentCount: 0,
        totalCount: 0,
      });
      assert.equal(await adapter.findAccessKeyAuthenticationRecord(raced.selector), null);
      assert.equal((await adapter.listAccessKeyRecordsForOwner(raced.ownerUserId)).every((row) => row.revokedAt !== null), true);

      await adapter.linkAuthUser({ ...ACCESS_KEY_TRANSITION_USER, isAuthenticated: 1, isGuest: 0 });
      const afterRelink = await adapter.listAccessKeyRecordsForOwner(raced.ownerUserId);
      assert.equal(afterRelink.every((row) => row.revokedAt !== null), true);

      const deletedOwnerKey = { ...raced, id: "access-key-owner-deleted", name: "owner-deleted", reservedName: "owner-deleted", selector: "ownerdeletedselector000" };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(deletedOwnerKey)), { status: "issued" });
      const deletionContender = {
        ...raced,
        id: "access-key-owner-delete-contender",
        name: "owner-delete-contender",
        reservedName: "owner-delete-contender",
        selector: "ownerdeletecontender00",
      };
      let releaseDeletion;
      let deletionLocked;
      const deletionReady = new Promise((resolve) => { deletionLocked = resolve; });
      const deletionRelease = new Promise((resolve) => { releaseDeletion = resolve; });
      const deletion = adapter.withTransaction(async (tx) => {
        await tx.bulkRevokeAccessKeysForOwner({
          ownerUserId: raced.ownerUserId,
          revokedAt: NEXT_MONTH,
          revocationCause: "owner-deleted",
        });
        deletionLocked();
        await deletionRelease;
        await tx.prepare(tx.dialect.sql("DELETE FROM [sporades_auth_users] WHERE [id] = ?")).run(raced.ownerUserId);
      });
      await deletionReady;
      const issueDuringDeletion = adapter.withTransaction((tx) => tx.issueAccessKeyRecord(deletionContender));
      releaseDeletion();
      const [, deletionIssueOutcome] = await Promise.all([deletion, issueDuringDeletion]);
      assert.equal(deletionIssueOutcome.status, "owner-ineligible");
      const deletedHistory = (await adapter.listAccessKeyRecordsForOwner(raced.ownerUserId)).find((row) => row.id === deletedOwnerKey.id);
      assert.equal(deletedHistory.revocationCause, "owner-deleted");
      assert.equal(await adapter.findAccessKeyAuthenticationRecord(deletedOwnerKey.selector), null);
    },
  },
  {
    name: "Session and Access-key password-reset retirement commits and rolls back atomically",
    async run(adapter) {
      const record = {
        id: "access-key-reset-atomicity",
        ownerUserId: ACCESS_KEY_RESET_USER.id,
        name: "reset-atomicity",
        reservedName: "reset-atomicity",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "resetatomicityselector00",
        verifierDigest: "d3".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      await adapter.insertEmailCredential({
        email: ACCESS_KEY_RESET_USER.email,
        userId: ACCESS_KEY_RESET_USER.id,
        passwordHash: "old-reset-hash",
        passwordSalt: "old-reset-salt",
        createdAt: NOW,
      });
      for (const selector of ["reset-atomicity-primary", "reset-atomicity-sibling"]) {
        await adapter.insertPasswordResetCode({
          selector,
          verifierHash: `${selector}-hash`,
          email: ACCESS_KEY_RESET_USER.email,
          userId: ACCESS_KEY_RESET_USER.id,
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        });
      }
      await adapter.insertAuthSession({ token: "session-reset-atomicity", userId: record.ownerUserId, provider: "email", createdAt: NOW, expiresAt: NEXT_MONTH });
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
      const rollback = new Error("rollback reset retirement");
      await assert.rejects(adapter.withTransaction(async (tx) => {
        await tx.deletePasswordResetCode("reset-atomicity-primary");
        await tx.updateEmailCredentialPassword(ACCESS_KEY_RESET_USER.email, "new-reset-hash", "new-reset-salt");
        await tx.deletePasswordResetCodesForUser(record.ownerUserId);
        await tx.deleteAuthSessionsForUser(record.ownerUserId);
        await tx.bulkRevokeAccessKeysForOwner({ ownerUserId: record.ownerUserId, revokedAt: LATER, revocationCause: "password-reset" });
        throw rollback;
      }), rollback);
      assert.equal((await adapter.findPasswordResetCode("reset-atomicity-primary")).userId, record.ownerUserId);
      assert.equal((await adapter.findPasswordResetCode("reset-atomicity-sibling")).userId, record.ownerUserId);
      assert.equal((await adapter.findEmailCredentialWithUser(ACCESS_KEY_RESET_USER.email)).passwordHash, "old-reset-hash");
      assert.equal((await adapter.readAuthSessionWithUser("session-reset-atomicity")).userId, record.ownerUserId);
      assert.equal((await adapter.findAccessKeyAuthenticationRecord(record.selector)).id, record.id);

      await adapter.withTransaction(async (tx) => {
        await tx.deletePasswordResetCode("reset-atomicity-primary");
        await tx.updateEmailCredentialPassword(ACCESS_KEY_RESET_USER.email, "new-reset-hash", "new-reset-salt");
        await tx.deletePasswordResetCodesForUser(record.ownerUserId);
        await tx.deleteAuthSessionsForUser(record.ownerUserId);
        await tx.bulkRevokeAccessKeysForOwner({ ownerUserId: record.ownerUserId, revokedAt: NEXT_MONTH, revocationCause: "password-reset" });
      });
      assert.equal(await adapter.findPasswordResetCode("reset-atomicity-primary"), null);
      assert.equal(await adapter.findPasswordResetCode("reset-atomicity-sibling"), null);
      assert.equal((await adapter.findEmailCredentialWithUser(ACCESS_KEY_RESET_USER.email)).passwordHash, "new-reset-hash");
      assert.equal(await adapter.readAuthSessionWithUser("session-reset-atomicity"), null);
      const retired = (await adapter.listAccessKeyRecordsForOwner(record.ownerUserId))[0];
      assert.equal(retired.revocationCause, "password-reset");
      assert.equal(await adapter.findAccessKeyAuthenticationRecord(record.selector), null);
    },
  },
  {
    name: "rotated Access-key credentials remain singular for restart proof",
    async run(adapter) {
      const record = {
        id: "access-key-restart-rotated",
        ownerUserId: ACCESS_KEY_RESTART_USER.id,
        name: "restart-rotated",
        reservedName: "restart-rotated",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "restartoldselector00000",
        verifierDigest: "d4".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      };
      assert.deepEqual(await adapter.withTransaction((tx) => tx.issueAccessKeyRecord(record)), { status: "issued" });
      const rotated = await adapter.withTransaction((tx) => tx.rotateAccessKeyRecord({
        ownerUserId: record.ownerUserId,
        id: record.id,
        lifecycleRevision: 1,
        secretVersion: 1,
        selector: "restartnewselector00000",
        verifierDigest: "d5".repeat(32),
        rotatedAt: LATER,
      }));
      assert.equal(rotated.status, "rotated");
    },
  },
  {
    name: "Access-key current quota rejects the next issue without corrupting owner counters",
    async run(adapter) {
      for (let index = 0; index < 100; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const selector = Buffer.from(`quota-${suffix}`).toString("base64url").padEnd(22, "x").slice(0, 22);
        const outcome = await adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
          id: `access-key-quota-${suffix}`,
          ownerUserId: BYSTANDER_USER.id,
          name: `quota-${suffix}`,
          reservedName: `quota-${suffix}`,
          grantsJson: JSON.stringify(["requests:read"]),
          secretVersion: 1,
          selector,
          verifierDigest: "ef".repeat(32),
          lifecycleRevision: 1,
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        }));
        assert.deepEqual(outcome, { status: "issued" });
      }
      const rejected = await adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
        id: "access-key-quota-overflow",
        ownerUserId: BYSTANDER_USER.id,
        name: "quota-overflow",
        reservedName: "quota-overflow",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "ghijklmnopqrstuvwxyzab",
        verifierDigest: "fa".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      }));
      assert.deepEqual(rejected, { status: "limit" });
      const ledger = await adapter.prepare(adapter.dialect.sql(
        "SELECT [currentCount], [totalCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?",
      )).get(BYSTANDER_USER.id);
      assert.deepEqual({ currentCount: Number(ledger.currentCount), totalCount: Number(ledger.totalCount) }, {
        currentCount: 100,
        totalCount: 100,
      });
      assert.equal((await adapter.listAccessKeyRecordsForOwner(BYSTANDER_USER.id)).length, 100);
    },
  },
  {
    name: "Access-key retained quota rejects record 1001 without corrupting historical counters",
    async run(adapter) {
      for (let index = 0; index < 1000; index += 1) {
        const suffix = String(index).padStart(4, "0");
        const id = `access-key-retained-${suffix}`;
        const issued = await adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
          id,
          ownerUserId: SWEPT_USER.id,
          name: "reusable-retained-name",
          reservedName: "reusable-retained-name",
          grantsJson: JSON.stringify(["requests:read"]),
          secretVersion: 1,
          selector: `r${index.toString(36).padStart(21, "0")}`,
          verifierDigest: "fb".repeat(32),
          lifecycleRevision: 1,
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        }));
        assert.deepEqual(issued, { status: "issued" });
        const revoked = await adapter.withTransaction((tx) => tx.revokeAccessKeyRecord({
          ownerUserId: SWEPT_USER.id,
          id,
          revokedAt: LATER,
          revocationCause: "owner",
        }));
        assert.equal(revoked.id, id);
      }
      const rejected = await adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
        id: "access-key-retained-overflow",
        ownerUserId: SWEPT_USER.id,
        name: "reusable-retained-name",
        reservedName: "reusable-retained-name",
        grantsJson: JSON.stringify(["requests:read"]),
        secretVersion: 1,
        selector: "roverflow00000000000000",
        verifierDigest: "fc".repeat(32),
        lifecycleRevision: 1,
        createdAt: NOW,
        expiresAt: NEXT_MONTH,
      }));
      assert.deepEqual(rejected, { status: "limit" });
      const ledger = await adapter.prepare(adapter.dialect.sql(
        "SELECT [currentCount], [totalCount] FROM [sporades_auth_access_key_owners] WHERE [ownerUserId] = ?",
      )).get(SWEPT_USER.id);
      assert.deepEqual({ currentCount: Number(ledger.currentCount), totalCount: Number(ledger.totalCount) }, {
        currentCount: 0,
        totalCount: 1000,
      });
      assert.equal((await adapter.listAccessKeyRecordsForOwner(SWEPT_USER.id)).length, 1000);
    },
  },
  {
    // A DDL method, so ADR-0034 lets the engines emit different statement text for it — Postgres
    // uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` where the shared definition probes
    // `PRAGMA table_info` first. What they may not differ on is what a Capsule boot finds
    // afterwards, and every Capsule start re-runs this over a populated store.
    name: "ensureAuthStorage creates writable auth storage and keeps stored rows when run again",
    async run(adapter) {
      // An OAuth state is seeded here rather than relied on from the case above, which consumed
      // every state it created. Without a stored state crossing the call below, a DDL path that
      // recreated the OAuth state table would satisfy every other assertion in this case while
      // breaking every in-flight OAuth handshake on each Capsule restart.
      await adapter.insertOAuthState({
        state: "oauth-state-across-ensure",
        provider: "google",
        sessionToken: "session-oauth",
        returnTo: "/",
        redirectUri: "https://example.com/auth/callback",
        createdAt: NOW,
      });

      await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });

      // Rows written by the cases above survive the second run, across each table the method owns.
      assert.equal((await adapter.readAuthSessionWithUser(REGISTERED_SESSION_TOKEN))?.userId, REGISTERED_USER.id);
      assert.equal(
        await countRows(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_auth_oauth_states] WHERE [state] = ?", "oauth-state-across-ensure"),
        1,
      );
      assert.equal((await adapter.consumeOAuthState("oauth-state-across-ensure"))?.returnTo, "/");
      assert.equal(await adapter.emailCredentialExists(SIGNED_IN_USER.email), true);
      assert.equal((await adapter.findPasswordResetCode("reset-selector-sweep-bystander"))?.userId, BYSTANDER_USER.id);
      assert.equal(
        identityFields(await adapter.findAuthIdentityByProviderSubject("google", "subject-signed-in-renumbered"))?.userId,
        SIGNED_IN_USER.id,
      );

      // And the storage is still writable afterwards rather than merely intact.
      assert.equal(
        (await adapter.insertAuthSession({
          token: "session-after-ensure",
          userId: REGISTERED_USER.id,
          provider: "guest",
          createdAt: NOW,
          expiresAt: NEXT_MONTH,
        })).changes,
        1,
      );
      assert.equal((await adapter.readAuthSessionWithUser("session-after-ensure"))?.userId, REGISTERED_USER.id);
      assert.equal((await adapter.insertOAuthState({ state: "oauth-state-after-ensure", sessionToken: "session-oauth", returnTo: "/", redirectUri: "https://example.com/auth/callback", createdAt: NOW })).changes, 1);
      assert.equal((await adapter.consumeOAuthState("oauth-state-after-ensure")).provider, "google");
    },
  },
  {
    name: "Access-key owner rows and indexed credentials survive an adapter restart",
    async run(adapter, engineContext) {
      if (!engineContext?.restart) return;
      const restarted = await engineContext.restart();
      assert.equal((await restarted.listAccessKeyRecordsForOwner(BYSTANDER_USER.id)).length, 100);
      const persisted = await restarted.findAccessKeyAuthenticationRecord(
        Buffer.from("quota-000").toString("base64url").padEnd(22, "x").slice(0, 22),
      );
      assert.equal(persisted.id, "access-key-quota-000");
      assert.equal(persisted.ownerUserId, BYSTANDER_USER.id);
      assert.equal(await restarted.findAccessKeyAuthenticationRecord("restartoldselector00000"), null);
      assert.equal((await restarted.findAccessKeyAuthenticationRecord("restartnewselector00000")).id, "access-key-restart-rotated");
      const resetHistory = (await restarted.listAccessKeyRecordsForOwner(ACCESS_KEY_RESET_USER.id))[0];
      assert.equal(resetHistory.revocationCause, "password-reset");
      const storedResetHistory = await restarted.prepare(restarted.dialect.sql(
        "SELECT [selector], [verifierDigest] FROM [sporades_auth_access_keys] WHERE [id] = ?",
      )).get(resetHistory.id);
      assert.deepEqual({ selector: storedResetHistory.selector, verifierDigest: storedResetHistory.verifierDigest }, {
        selector: null,
        verifierDigest: null,
      });
      assert.equal((await restarted.listAccessKeyRecordsForOwner(SIGNED_IN_USER.id)).some((row) => row.id === "access-key-complete-lifecycle"), false);
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (auth storage)",
  appTableNames: [],
  prepareStorage: prepareAuthStorage,
  cases: AUTH_STORAGE_CONFORMANCE_CASES,
};
