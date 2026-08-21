import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  openDevDatabase, replaceRuntimeDatabase, runMutation as runRuntimeMutation,
  runRuntimeAccessKeyOperatorAction,
} from "../dist/server-runtime-source.js";
import { mutation } from "../dist/server.js";

const owner = {
  userId: "operator-key-owner",
  displayName: "Private Owner Name",
  email: "private-owner@example.com",
  picture: null,
  isAuthenticated: true,
  isGuest: false,
  provider: "email",
};
const ownerSessionToken = "operator-key-owner-session";

function runMutation(database, auth, name, args) {
  return runRuntimeMutation(database, auth, name, args, { sessionToken: ownerSessionToken });
}

async function insertOwnerSession(database) {
  await database.adapter.insertAuthSession({
    token: ownerSessionToken, userId: owner.userId, provider: owner.provider,
    createdAt: "2026-08-20T12:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

test("Privileged Access-key controls expose only metadata and retirement", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-operator-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "operator-access-keys" }, {
    accessKeys: { scopes: ["requests:read", "requests:write"] },
    mutations: {
      issue: mutation((ctx, name) => ctx.accessKeys.issue({ name, grants: ["requests:*"] })),
      privilegedSurface: mutation((ctx) => ctx.privileged.run({
        operation: "access-keys.surface-probe", targetResourceKind: "access-key",
      }, (privilegedCtx) => Object.keys(privilegedCtx.accessKeys).sort())),
      privilegedList: mutation((ctx, ownerUserId) => ctx.privileged.run({
        operation: "maintenance", targetResourceKind: "capsule",
      }, (privilegedCtx) => privilegedCtx.accessKeys.list(ownerUserId))),
      privilegedListThenFail: mutation((ctx, ownerUserId) => ctx.privileged.run({
        operation: "maintenance-rollback", targetResourceKind: "capsule",
      }, async (privilegedCtx) => {
        await privilegedCtx.accessKeys.list(ownerUserId);
        throw new Error("rollback after Access-key inspection");
      })),
    },
  });
  await database.init();
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId, createdAt: "2026-08-20T12:00:00.000Z", displayName: owner.displayName,
      email: owner.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: owner.provider,
    });
    await insertOwnerSession(database);
    const first = await runMutation(database, owner, "issue", ["automation one"]);
    const second = await runMutation(database, owner, "issue", ["automation two"]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));

    const surface = await runMutation(database, owner, "privilegedSurface", []);
    assert.deepEqual(surface.data, ["delete", "inspect", "list", "revoke", "revokeAll"]);
    const directList = await runMutation(database, owner, "privilegedList", [owner.userId]);
    assert.equal(directList.ok, true, JSON.stringify(directList));
    const actionAuditsBeforeRollback = (await database.adapter.readRecentLogEvents(100))
      .filter((event) => event.data?.operation === "access-keys.list").length;
    const rolledBack = await runMutation(database, owner, "privilegedListThenFail", [owner.userId]);
    assert.equal(rolledBack.ok, false);
    const actionAuditsAfterRollback = (await database.adapter.readRecentLogEvents(100))
      .filter((event) => event.data?.operation === "access-keys.list"
        && event.data?.metadata?.ownerUserId === owner.userId && event.data?.metadata?.actionOwned === true).length;
    assert.equal(actionAuditsAfterRollback, actionAuditsBeforeRollback + 1,
      "action-owned Privileged audit must be reindexed after the surrounding mutation rolls back");
    const auditBeforeInvalidInput = await database.adapter.readRecentLogEvents(100);
    await assert.rejects(runRuntimeAccessKeyOperatorAction(database, "access-keys.inspect", {
      keyId: first.data.accessKey.id, authorization: "Bearer secret-shaped-input",
    }, "operator-cli-dev"), (error) => error.code === "INVALID_ACCESS_KEY_ACTION_INPUT");
    assert.equal((await database.adapter.readRecentLogEvents(100)).length, auditBeforeInvalidInput.length,
      "invalid operator input must fail before audit creation");
    const originalFindById = database.adapter.findAccessKeyRecordById;
    database.adapter.findAccessKeyRecordById = async () => { throw new Error("secret-adapter-detail"); };
    try {
      await assert.rejects(runRuntimeAccessKeyOperatorAction(database, "access-keys.inspect", {
        keyId: first.data.accessKey.id,
      }, "operator-cli-dev"), (error) => error.code === "PRIVILEGED_RUN_FAILED");
    } finally { database.adapter.findAccessKeyRecordById = originalFindById; }
    const failedLookupAudit = await database.adapter.readRecentLogEvents(100);
    assert.ok(failedLookupAudit.some((event) => event.data?.operation === "access-keys.operator-dispatch"
      && event.data?.outcome === "errored" && event.data?.metadata?.accessKeyId === first.data.accessKey.id));
    assert.ok(failedLookupAudit.some((event) => event.data?.operation === "access-keys.inspect"
      && event.data?.outcome === "errored" && event.data?.safeErrorCode === "UNKNOWN_ERROR"
      && event.data?.metadata?.accessKeyId === first.data.accessKey.id));
    assert.equal(JSON.stringify(failedLookupAudit).includes("secret-adapter-detail"), false);

    const listed = await runRuntimeAccessKeyOperatorAction(database, "access-keys.list", {
      userId: owner.userId,
      options: { limit: 1 },
    }, "operator-cli-dev");
    assert.equal(listed.accessKeys.length, 1);
    assert.equal(listed.totalCount, 2);
    assert.equal(listed.accessKeys[0].ownerUserId, owner.userId);
    assert.deepEqual(listed.accessKeys[0].effectiveScopes, ["requests:read", "requests:write"]);

    const inspected = await runRuntimeAccessKeyOperatorAction(database, "access-keys.inspect", {
      keyId: first.data.accessKey.id,
    }, "operator-cli-container");
    assert.equal(inspected.accessKey.ownerUserId, owner.userId);
    assert.equal(inspected.accessKey.name, "automation one");
    const publicJson = JSON.stringify({ listed, inspected });
    assert.equal(publicJson.includes(owner.email), false);
    assert.equal(publicJson.includes(owner.displayName), false);
    assert.equal(publicJson.includes(first.data.token), false);
    assert.equal(/selector|verifier|digest|token/i.test(publicJson), false);

    const revoked = await runRuntimeAccessKeyOperatorAction(database, "access-keys.revoke", {
      keyId: first.data.accessKey.id,
    }, "operator-cli-hosted");
    assert.equal(revoked.accessKey.status, "revoked");
    assert.equal(revoked.accessKey.revocationCause, "operator");
    const deleted = await runRuntimeAccessKeyOperatorAction(database, "access-keys.delete", {
      keyId: first.data.accessKey.id,
    }, "operator-cli-hosted");
    assert.deepEqual(deleted, { id: first.data.accessKey.id, ownerUserId: owner.userId, deleted: true });

    const bulk = await runRuntimeAccessKeyOperatorAction(database, "access-keys.revoke-all", {
      userId: owner.userId,
    }, "operator-cli-dev");
    assert.equal(bulk.revokedCount, 1);
    assert.equal(bulk.accessKeys[0].id, second.data.accessKey.id);
    assert.equal(bulk.accessKeys[0].revocationCause, "operator");

    const audit = await database.adapter.readRecentLogEvents(100);
    const operatorEvents = audit.filter((event) => event.category === "audit" && String(event.data?.operation).startsWith("access-keys."));
    assert.ok(operatorEvents.length >= 15, "each of five operations must emit started/completed/finished");
    assert.equal(operatorEvents.some((event) => event.data?.surface === "operator-cli-hosted"), true);
    const auditJson = JSON.stringify(operatorEvents);
    assert.equal(auditJson.includes(first.data.token), false);
    assert.equal(/selector|verifier|digest/i.test(auditJson), false);
    const actionOwnedList = audit.find((event) => event.data?.operation === "access-keys.list"
      && event.data?.metadata?.actionOwned === true && event.data?.metadata?.ownerUserId === owner.userId);
    assert.ok(actionOwnedList, "direct Privileged projection use must emit its runtime-owned exact-target audit");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator retirement rolls back when its terminal audit cannot be emitted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-operator-audit-rollback-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "operator-audit-rollback" }, {
    accessKeys: { scopes: ["requests:read"] },
    mutations: {
      issue: mutation((ctx, name) => ctx.accessKeys.issue({ name, grants: ["requests:read"] })),
    },
  });
  await database.init();
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId, createdAt: "2026-08-20T12:00:00.000Z", displayName: owner.displayName,
      email: owner.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: owner.provider,
    });
    await insertOwnerSession(database);
    const issued = await runMutation(database, owner, "issue", ["audit rollback"]);
    assert.equal(issued.ok, true, JSON.stringify(issued));

    const originalWithDatabase = database.log.withDatabase.bind(database.log);
    database.log.withDatabase = (adapter) => {
      const transactionLog = originalWithDatabase(adapter);
      return {
        ...transactionLog,
        emit(input) {
          if (input?.data?.operation === "access-keys.operator-dispatch" && input?.data?.outcome === "completed") {
            throw new Error("simulated operator terminal audit failure");
          }
          return transactionLog.emit(input);
        },
      };
    };
    try {
      await assert.rejects(runRuntimeAccessKeyOperatorAction(database, "access-keys.revoke", {
        keyId: issued.data.accessKey.id,
      }, "operator-cli-dev"), (error) => error.code === "PRIVILEGED_AUDIT_EMISSION_FAILED");
    } finally {
      database.log.withDatabase = originalWithDatabase;
    }

    const afterFailure = await database.adapter.findAccessKeyRecordById(issued.data.accessKey.id);
    assert.equal(afterFailure.revokedAt, null, "retirement must roll back with its terminal audit");
    const retried = await runRuntimeAccessKeyOperatorAction(database, "access-keys.revoke", {
      keyId: issued.data.accessKey.id,
    }, "operator-cli-dev");
    assert.equal(retried.accessKey.status, "revoked", "the failed operator call must remain safe to retry");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed runtime initialization does not publish its Access-key scope vocabulary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-scope-publication-"));
  const databasePath = path.join(dir, "data.db");
  const current = await openDevDatabase(databasePath, "", {}, { name: "scope-publication" }, {
    accessKeys: { scopes: ["requests:read"] },
  });
  await current.init();
  const candidate = await openDevDatabase(databasePath, "", {}, { name: "scope-publication" }, {
    accessKeys: { scopes: ["failed:scope"] }, hooks: { init: () => { throw new Error("candidate init failed"); } },
  });
  try {
    await assert.rejects(replaceRuntimeDatabase(current, candidate), /candidate init failed/);
    const actionDatabase = await openDevDatabase(databasePath, "", {}, { name: "scope-publication" }, null, { runtimeActionOnly: true });
    try { assert.deepEqual(actionDatabase.accessKeyScopes, ["requests:read"]); }
    finally { await actionDatabase.close(); }
    const preflightCandidate = await openDevDatabase(databasePath, "", {}, { name: "scope-publication" }, {
      accessKeys: { scopes: ["failed:preflight"] },
    });
    preflightCandidate.__preflightJobExecutionActivation = () => { throw new Error("candidate preflight failed"); };
    await assert.rejects(replaceRuntimeDatabase(current, preflightCandidate), /candidate preflight failed/);
    const afterPreflightFailure = await openDevDatabase(databasePath, "", {}, { name: "scope-publication" }, null, { runtimeActionOnly: true });
    try { assert.deepEqual(afterPreflightFailure.accessKeyScopes, ["requests:read"]); }
    finally { await afterPreflightFailure.close(); }
  } finally {
    await current.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("detached Privileged Access-key reads and mutations lose authority when the run settles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-detached-privileged-"));
  let releaseRead, releaseLookup;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  let detachedRead, detachedRevoke;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "detached-access-keys" }, {
    accessKeys: { scopes: ["requests:read"] },
    hooks: {
      init: (ctx) => ctx.privileged.run({ operation: "detached-probe", targetResourceKind: "access-key" }, (privilegedCtx) => {
        detachedRead = privilegedCtx.accessKeys.list(owner.userId);
        detachedRevoke = privilegedCtx.accessKeys.revoke("detached-key");
        return null;
      }),
    },
  });
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId, createdAt: "2026-08-20T12:00:00.000Z", displayName: owner.displayName,
      email: owner.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: owner.provider,
    });
    await database.adapter.issueAccessKeyRecord({
      id: "detached-key", ownerUserId: owner.userId, name: "detached", reservedName: "detached",
      grantsJson: JSON.stringify(["requests:read"]), secretVersion: 1, selector: "detached-selector",
      verifierDigest: "0".repeat(64), lifecycleRevision: 1, createdAt: "2026-08-20T12:00:00.000Z", expiresAt: null,
    });
    const originalList = database.adapter.listAccessKeyRecordsForOwner.bind(database.adapter);
    const originalFind = database.adapter.findAccessKeyRecordById.bind(database.adapter);
    database.adapter.listAccessKeyRecordsForOwner = async (...args) => { await readGate; return originalList(...args); };
    database.adapter.findAccessKeyRecordById = async (...args) => { await lookupGate; return originalFind(...args); };
    await database.init();
    releaseRead(); releaseLookup();
    const [readResult, revokeResult] = await Promise.allSettled([detachedRead, detachedRevoke]);
    assert.equal(readResult.status, "rejected");
    assert.equal(readResult.reason.code, "FORBIDDEN");
    assert.equal(revokeResult.status, "rejected");
    assert.equal(revokeResult.reason.code, "FORBIDDEN");
    database.adapter.findAccessKeyRecordById = originalFind;
    assert.equal((await originalFind("detached-key")).revokedAt, null, "detached destructive work must not commit");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
