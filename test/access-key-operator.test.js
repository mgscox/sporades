import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, runMutation, runRuntimeAccessKeyOperatorAction } from "../dist/server-runtime-source.js";
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

test("Privileged Access-key controls expose only metadata and retirement", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-operator-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "operator-access-keys" }, {
    accessKeys: { scopes: ["requests:read", "requests:write"] },
    mutations: {
      issue: mutation((ctx, name) => ctx.accessKeys.issue({ name, grants: ["requests:*"] })),
      privilegedSurface: mutation((ctx) => ctx.privileged.run({
        operation: "access-keys.surface-probe", targetResourceKind: "access-key",
      }, (privilegedCtx) => Object.keys(privilegedCtx.accessKeys).sort())),
    },
  });
  await database.init();
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId, createdAt: "2026-08-20T12:00:00.000Z", displayName: owner.displayName,
      email: owner.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: owner.provider,
    });
    const first = await runMutation(database, owner, "issue", ["automation one"]);
    const second = await runMutation(database, owner, "issue", ["automation two"]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));

    const surface = await runMutation(database, owner, "privilegedSurface", []);
    assert.deepEqual(surface.data, ["delete", "inspect", "list", "revoke", "revokeAll"]);

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
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
