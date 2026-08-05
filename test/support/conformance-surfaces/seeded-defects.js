import assert from "node:assert/strict";

// One conformance specification for the Database adapter boundary, executed once per engine
// (ADR-0035). It asserts what a method answers for a given stored state, never how it reached
// that answer, so an adapter is free to return a plain value or a Promise (ADR-0034).
//
// Two rules shape every case here, and both come from how the defects this suite exists to
// catch actually behaved. Every assertion compares an observed value against an expected value,
// because none of those defects threw. And every predicate is exercised on both sides, because
// a check that always answers true and a count that always answers zero each satisfy a single
// positive assertion.
//
// This file is one surface of that specification: the cases seeded from the six defects the
// suite was built to catch. A surface owns its cases, its app tables and its prepared storage,
// and exports them as a surface module in this directory. `runDatabaseAdapterConformance` is the
// single place engine iteration and the Postgres gate live, and every surface in this directory
// is discovered and run through it. Coverage for a further surface goes in its own sibling module
// here, with its own title, so no two surfaces share a file, an adapter, or a row.

const CONFORMANCE_APP_TABLE = {
  name: "conformance_notes",
  fields: [
    { name: "text", kind: "String", sqliteType: "TEXT" },
    { name: "ownerId", kind: "String", sqliteType: "TEXT" },
  ],
};

const NOW = "2026-07-04T10:00:00.000Z";
const LATER = "2026-07-04T10:05:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const RESERVED_AUTH_USER_ID = "__privileged__";

const ORDINARY_USER = {
  id: "user-ordinary",
  createdAt: NOW,
  displayName: "Ordinary User",
  email: "ordinary@example.com",
  picture: null,
  isAuthenticated: 1,
  isGuest: 0,
  provider: "email",
};

// The reserved Privileged server role identity is written with raw statements on purpose: the
// adapter's own insert helpers refuse it, and the guards under test only mean something when
// the row they are meant to suppress is actually stored.
async function seedReservedAuthUser(adapter) {
  await adapter
    .prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(RESERVED_AUTH_USER_ID, NOW, "Privileged", "reserved@example.com", null, 1, 0, "email");
  await adapter
    .prepare("INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)")
    .run("session-reserved", RESERVED_AUTH_USER_ID, "email", NOW, FAR_FUTURE);
  await adapter
    .prepare(
      "INSERT INTO sporades_auth_email_credentials (email, userId, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run("reserved@example.com", RESERVED_AUTH_USER_ID, "hash", "salt", NOW);
}

async function prepareConformanceStorage(adapter) {
  await adapter.ensureSystemTable();
  await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
  await adapter.ensureFileStorage();
  await adapter.migrateAppSchema({ tables: [CONFORMANCE_APP_TABLE] });

  await adapter.insertAppRow(CONFORMANCE_APP_TABLE, {
    id: "note-present",
    createdAt: NOW,
    updatedAt: NOW,
    text: "a row that exists",
    ownerId: ORDINARY_USER.id,
  });

  await adapter.insertAuthUser(ORDINARY_USER);
  await adapter.insertAuthSession({
    token: "session-ordinary",
    userId: ORDINARY_USER.id,
    provider: "email",
    createdAt: NOW,
    expiresAt: FAR_FUTURE,
  });
  await seedReservedAuthUser(adapter);

  await adapter.createFileBucket({ id: "bucket-1", ownerId: ORDINARY_USER.id, name: "default", createdAt: NOW });
}

function pendingUpload(overrides) {
  return {
    ownerId: ORDINARY_USER.id,
    bucketId: "bucket-1",
    bucketName: "default",
    type: "text/plain",
    version: "version-1",
    expectedSize: 5,
    createdAt: NOW,
    ...overrides,
  };
}

const DATABASE_ADAPTER_CONFORMANCE_CASES = [
  {
    // Defect: emailCredentialExists derived from the pending query, so it answered true for
    // every address and made email sign-up impossible on the asynchronous engines.
    name: "emailCredentialExists distinguishes a stored credential from an absent one",
    async run(adapter) {
      assert.equal(await adapter.emailCredentialExists("absent@example.com"), false);

      await adapter.insertEmailCredential({
        email: "stored@example.com",
        userId: ORDINARY_USER.id,
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: NOW,
      });

      assert.equal(await adapter.emailCredentialExists("stored@example.com"), true);
      assert.equal(await adapter.emailCredentialExists("absent@example.com"), false);
    },
  },
  {
    // Defect: referenceExists had the same shape, so Reference() never rejected a reference to
    // a row that does not exist.
    name: "referenceExists distinguishes a present target row from a dangling one",
    async run(adapter) {
      assert.equal(await adapter.referenceExists({ targetTable: CONFORMANCE_APP_TABLE.name }, "note-present"), true);
      assert.equal(await adapter.referenceExists({ targetTable: CONFORMANCE_APP_TABLE.name }, "note-absent"), false);

      await adapter.insertAppRow(CONFORMANCE_APP_TABLE, {
        id: "note-absent",
        createdAt: NOW,
        updatedAt: NOW,
        text: "no longer absent",
        ownerId: ORDINARY_USER.id,
      });
      assert.equal(await adapter.referenceExists({ targetTable: CONFORMANCE_APP_TABLE.name }, "note-absent"), true);

      await adapter.deleteAppRow(CONFORMANCE_APP_TABLE, "note-absent");
      assert.equal(await adapter.referenceExists({ targetTable: CONFORMANCE_APP_TABLE.name }, "note-absent"), false);
    },
  },
  {
    // Defect: completeFileUpload branched on a pending sibling-method result, always took the
    // update branch, and so never wrote File metadata for a file that had no row yet.
    name: "completeFileUpload writes File metadata for a new file and updates an existing one",
    async run(adapter) {
      assert.equal(await adapter.selectFileById("file-new"), null);
      await adapter.insertFileUpload(
        pendingUpload({ id: "upload-new", fileId: "file-new", path: "/default/new.txt", name: "new.txt" }),
      );

      await adapter.completeFileUpload(await adapter.selectFileUpload("upload-new"), 5, LATER);

      const inserted = await adapter.selectFileById("file-new");
      assert.deepEqual(
        {
          name: inserted?.name,
          path: inserted?.path,
          size: inserted?.size,
          status: inserted?.status,
          version: inserted?.version,
          updatedAt: inserted?.updatedAt,
        },
        { name: "new.txt", path: "/default/new.txt", size: 5, status: "uploaded", version: "version-1", updatedAt: LATER },
      );

      await adapter.insertFileRow({
        id: "file-existing",
        ownerId: ORDINARY_USER.id,
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/existing.txt",
        name: "existing.txt",
        type: "text/plain",
        size: 3,
        version: "version-1",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-existing",
          fileId: "file-existing",
          path: "/default/existing.txt",
          name: "existing.txt",
          version: "version-2",
          expectedSize: 7,
        }),
      );

      await adapter.completeFileUpload(await adapter.selectFileUpload("upload-existing"), 7, LATER);

      const updated = await adapter.selectFileById("file-existing");
      assert.deepEqual(
        { size: updated?.size, status: updated?.status, version: updated?.version, updatedAt: updated?.updatedAt },
        { size: 7, status: "uploaded", version: "version-2", updatedAt: LATER },
      );

      // The upload row is consumed by completion, so completing it again must change nothing.
      assert.equal(await adapter.selectFileUpload("upload-new"), null);
      const replayed = await adapter.completeFileUpload(
        pendingUpload({ id: "upload-new", fileId: "file-new", path: "/default/new.txt", name: "new.txt" }),
        99,
        FAR_FUTURE,
      );
      assert.equal(replayed.changes, 0);
      assert.equal((await adapter.selectFileById("file-new")).size, 5);
    },
  },
  {
    // Defect: the reserved-user guard tested a Promise rather than the row, so it never fired
    // and the reserved Privileged server role identity was readable as an ordinary user.
    name: "readAuthSessionWithUser returns an ordinary Session and suppresses the reserved one",
    async run(adapter) {
      const ordinary = await adapter.readAuthSessionWithUser("session-ordinary");
      assert.deepEqual(
        { token: ordinary?.token, userId: ordinary?.userId, email: ordinary?.email },
        { token: "session-ordinary", userId: ORDINARY_USER.id, email: "ordinary@example.com" },
      );

      assert.equal(await adapter.readAuthSessionWithUser("session-reserved"), null);
      assert.equal(await adapter.readAuthSessionWithUser("session-absent"), null);
    },
  },
  {
    // Defect: the same guard, in the same shape, on the email credential lookup.
    name: "findEmailCredentialWithUser returns an ordinary credential and suppresses the reserved one",
    async run(adapter) {
      await adapter.insertEmailCredential({
        email: "ordinary@example.com",
        userId: ORDINARY_USER.id,
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: NOW,
      });

      const ordinary = await adapter.findEmailCredentialWithUser("ordinary@example.com");
      assert.deepEqual(
        { email: ordinary?.email, userId: ordinary?.userId, displayName: ordinary?.displayName },
        { email: "ordinary@example.com", userId: ORDINARY_USER.id, displayName: "Ordinary User" },
      );

      assert.equal(await adapter.findEmailCredentialWithUser("reserved@example.com"), null);
      assert.equal(await adapter.findEmailCredentialWithUser("absent@example.com"), null);
    },
  },
  {
    // Defect: countPasswordResetCodesForEmail coerced the pending query, so it always answered
    // zero and the ADR-0033 cap on outstanding Reset codes never tripped.
    name: "countPasswordResetCodesForEmail counts outstanding Reset codes and excludes expired ones",
    async run(adapter) {
      assert.equal(await adapter.countPasswordResetCodesForEmail("resets@example.com", NOW), 0);

      for (const index of [1, 2, 3]) {
        await adapter.insertPasswordResetCode({
          selector: `selector-${index}`,
          verifierHash: `verifier-hash-${index}`,
          email: "resets@example.com",
          userId: ORDINARY_USER.id,
          createdAt: NOW,
          expiresAt: FAR_FUTURE,
        });
        assert.equal(await adapter.countPasswordResetCodesForEmail("resets@example.com", NOW), index);
      }

      await adapter.insertPasswordResetCode({
        selector: "selector-expired",
        verifierHash: "verifier-hash-expired",
        email: "resets@example.com",
        userId: ORDINARY_USER.id,
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T01:00:00.000Z",
      });
      assert.equal(await adapter.countPasswordResetCodesForEmail("resets@example.com", NOW), 3);

      // The count is per email, and drops back to zero once the stored codes are gone.
      assert.equal(await adapter.countPasswordResetCodesForEmail("nobody@example.com", NOW), 0);
      await adapter.deletePasswordResetCodesForUser(ORDINARY_USER.id);
      assert.equal(await adapter.countPasswordResetCodesForEmail("resets@example.com", NOW), 0);
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance",
  appTableNames: [CONFORMANCE_APP_TABLE.name],
  prepareStorage: prepareConformanceStorage,
  cases: DATABASE_ADAPTER_CONFORMANCE_CASES,
};
