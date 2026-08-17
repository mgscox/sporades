import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, mutation, table } from "../dist/server.js";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";

const auth = {
  userId: "mutation-cleanup-user",
  displayName: "Mutation cleanup user",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

test("a throwing mutation drains pending ACL writes and clears cache without masking its primary error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mutation-cleanup-"));
  let aclStarted;
  const started = new Promise((resolve) => { aclStarted = resolve; });
  let releaseAcl;
  const aclGate = new Promise((resolve) => { releaseAcl = resolve; });
  globalThis.__mutationCleanupAcl = async () => {
    aclStarted();
    return await aclGate;
  };
  globalThis.__captureMutationCleanupContext = (context) => {
    globalThis.__mutationCleanupContext = context;
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "mutation-cleanup" }, {
    schema: {
      records: table({ key: String() }).unique("key").acl({
        insert: ({ next }) => next.key === "pending" ? globalThis.__mutationCleanupAcl() : true,
      }),
    },
    mutations: {
      insertCleanly: mutation((ctx) => ctx.db.records.insertOrIgnore({ key: "next" }, "key")),
    },
  });
  try {
    database.contextMiddleware = [
      `async (ctx) => {
        if (ctx.kind === "mutation" && !globalThis.__skipMutationCleanupFailure) {
          ctx.db.records.insertOrIgnore({ key: "pending" }, "key");
          globalThis.__captureMutationCleanupContext(ctx);
          throw new Error("primary mutation failure");
        }
        return ctx;
      }`,
    ];
    database.rowCache.set("stale-before-failure", { value: true });
    let settled = false;
    const resultPromise = runMutation(database, auth, "insertCleanly", []).then((result) => {
      settled = true;
      return result;
    });
    await started;
    await Promise.resolve();
    const settledBeforeCleanup = settled;
    const failedContext = globalThis.__mutationCleanupContext;
    assert.ok(failedContext.__pendingAclWrites.length > 0, "the fixture must leave an ACL write pending when the handler throws");
    for (const pending of failedContext.__pendingAclWrites) pending.catch(() => {});

    releaseAcl(false);
    const failed = await resultPromise;
    assert.equal(settledBeforeCleanup, false, "the mutation must not settle before pending ACL cleanup completes");
    assert.equal(failed.ok, false);
    assert.equal(failed.error.message, "primary mutation failure", "cleanup denial must not mask the handler error");
    assert.equal(failedContext.__pendingAclWrites.length, 0, "completed cleanup must not retain pending ACL promises");
    assert.equal(database.rowCache.size, 0, "the failed transaction clears shared row-cache state");

    globalThis.__skipMutationCleanupFailure = true;
    const next = await runMutation(database, auth, "insertCleanly", []);
    assert.equal(next.ok, true, next.error?.message);
    assert.equal(next.data.key, "next", "the next mutation is not affected by failed-operation cleanup state");
  } finally {
    releaseAcl(true);
    delete globalThis.__mutationCleanupAcl;
    delete globalThis.__captureMutationCleanupContext;
    delete globalThis.__mutationCleanupContext;
    delete globalThis.__skipMutationCleanupFailure;
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
