import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { replaceFilesAtomically } from "../dist/file-transaction.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-file-transaction-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function injectedError(code = "EIO") {
  return Object.assign(new Error("injected path /secret/value should be bounded"), { code });
}

function faultExecutor(handler) {
  const operations = [];
  return {
    operations,
    execute: async (operation, action) => {
      operations.push({ phase: operation.phase, action: operation.action, label: operation.label });
      return handler(operation, action);
    },
  };
}

async function transactionArtifacts(dir) {
  return (await readdir(dir)).filter((name) => name.includes(".sporades-tx-"));
}

async function captureRejection(promise) {
  try {
    await promise;
    assert.fail("Expected transaction to reject.");
  } catch (error) {
    return error;
  }
}

function assertBoundedTransactionError(error, dir, secrets, recovery) {
  assert.equal(error.message, "Unable to update OAuth configuration atomically.");
  assert.equal(error.diagnostics.recovery, recovery);
  const serialized = JSON.stringify({
    message: error.message,
    hint: error.hint,
    diagnostics: error.diagnostics,
  });
  assert.doesNotMatch(serialized, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const secret of secrets) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.doesNotMatch(serialized, /injected path|\\.tmp|\\.bak/);
}

test("atomic file replacement commits every target and removes transaction artifacts", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "sporades.json");
    const envPath = path.join(dir, ".env.sporades.server");
    await writeFile(configPath, "old-config\n");

    await replaceFilesAtomically([
      { path: configPath, label: "project configuration", contents: "new-config\n" },
      { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
    ]);

    assert.equal(await readFile(configPath, "utf8"), "new-config\n");
    assert.equal(await readFile(envPath, "utf8"), "TOKEN=new-env\n");
    assert.deepEqual(await transactionArtifacts(dir), []);
  });
});

test("atomic file replacement leaves targets exact when the first staged write partially mutates its temp file", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "sporades.json");
    const envPath = path.join(dir, ".env.sporades.server");
    const oldConfig = "old-config-exact\n";
    const oldEnv = "TOKEN=old-env-secret\n";
    await writeFile(configPath, oldConfig);
    await writeFile(envPath, oldEnv);
    const fault = faultExecutor(async (operation, action) => {
      if (operation.phase === "stage" && operation.label === "project configuration") {
        await writeFile(operation.artifactPath, "partial-temp-secret");
        throw injectedError();
      }
      return action();
    });

    const error = await captureRejection(replaceFilesAtomically([
      { path: configPath, label: "project configuration", contents: "new-config-secret\n" },
      { path: envPath, label: "server environment", contents: "TOKEN=new-env-secret\n" },
    ], { execute: fault.execute }));

    assert.equal(await readFile(configPath, "utf8"), oldConfig);
    assert.equal(await readFile(envPath, "utf8"), oldEnv);
    assert.deepEqual(await transactionArtifacts(dir), []);
    assertBoundedTransactionError(error, dir, ["partial-temp-secret", "new-config-secret", "new-env-secret"], "complete");
    assert.deepEqual(error.diagnostics.original, {
      phase: "stage",
      action: "write",
      label: "project configuration",
      code: "EIO",
    });
  });
});

for (const priorEnv of ["existing", "missing"]) {
  test(`atomic file replacement restores config and ${priorEnv} env after the second commit fails`, async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "sporades.json");
      const envPath = path.join(dir, ".env.sporades.server");
      const oldConfig = "old-config-exact\n";
      const oldEnv = "TOKEN=old-env-secret\n";
      await writeFile(configPath, oldConfig);
      if (priorEnv === "existing") await writeFile(envPath, oldEnv);
      const fault = faultExecutor(async (operation, action) => {
        if (operation.phase === "commit" && operation.action === "replace" && operation.label === "server environment") {
          await action();
          throw injectedError("ENOSPC");
        }
        return action();
      });

      const error = await captureRejection(replaceFilesAtomically([
        { path: configPath, label: "project configuration", contents: "new-config-secret\n" },
        { path: envPath, label: "server environment", contents: "TOKEN=new-env-secret\n" },
      ], { execute: fault.execute }));

      assert.equal(await readFile(configPath, "utf8"), oldConfig);
      if (priorEnv === "existing") {
        assert.equal(await readFile(envPath, "utf8"), oldEnv);
      } else {
        await assert.rejects(readFile(envPath), { code: "ENOENT" });
      }
      assert.deepEqual(await transactionArtifacts(dir), []);
      assertBoundedTransactionError(error, dir, ["new-config-secret", "new-env-secret"], "complete");
      assert.equal(error.diagnostics.original.code, "ENOSPC");
    });
  });
}

test("a config rollback failure does not prevent the env rollback attempt", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "sporades.json");
    const envPath = path.join(dir, ".env.sporades.server");
    await writeFile(configPath, "old-config\n");
    await writeFile(envPath, "TOKEN=old-env\n");
    const fault = faultExecutor(async (operation, action) => {
      if (operation.phase === "commit" && operation.action === "replace" && operation.label === "server environment") {
        await action();
        throw injectedError("ENOSPC");
      }
      if (operation.phase === "rollback" && operation.action === "restore" && operation.label === "project configuration") {
        throw injectedError("EACCES");
      }
      return action();
    });

    const error = await captureRejection(replaceFilesAtomically([
      { path: configPath, label: "project configuration", contents: "new-config\n" },
      { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
    ], { execute: fault.execute }));

    assert.equal(await readFile(configPath, "utf8"), "new-config\n");
    assert.equal(await readFile(envPath, "utf8"), "TOKEN=old-env\n");
    assert.equal((await transactionArtifacts(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
    assert.equal((await transactionArtifacts(dir)).filter((name) => name.endsWith(".bak")).length, 1);
    const configRollback = fault.operations.findIndex((operation) =>
      operation.phase === "rollback" && operation.action === "restore" && operation.label === "project configuration");
    const envRollback = fault.operations.findIndex((operation) =>
      operation.phase === "rollback" && operation.action === "restore" && operation.label === "server environment");
    assert.ok(configRollback >= 0);
    assert.ok(envRollback > configRollback);
    assertBoundedTransactionError(error, dir, ["new-config", "new-env"], "incomplete");
    assert.deepEqual(error.diagnostics.recoveryFailures, [{
      action: "restore",
      label: "project configuration",
      code: "EACCES",
    }]);
  });
});

test("an env rollback failure is surfaced and does not prevent config rollback", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "sporades.json");
    const envPath = path.join(dir, ".env.sporades.server");
    await writeFile(configPath, "old-config\n");
    await writeFile(envPath, "TOKEN=old-env\n");
    const fault = faultExecutor(async (operation, action) => {
      if (operation.phase === "commit" && operation.action === "replace" && operation.label === "server environment") {
        await action();
        throw injectedError("ENOSPC");
      }
      if (operation.phase === "rollback" && operation.action === "restore" && operation.label === "server environment") {
        throw injectedError("EACCES");
      }
      return action();
    });

    const error = await captureRejection(replaceFilesAtomically([
      { path: configPath, label: "project configuration", contents: "new-config\n" },
      { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
    ], { execute: fault.execute }));

    assert.equal(await readFile(configPath, "utf8"), "old-config\n");
    assert.equal(await readFile(envPath, "utf8"), "TOKEN=new-env\n");
    assert.equal((await transactionArtifacts(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
    assert.equal((await transactionArtifacts(dir)).filter((name) => name.endsWith(".bak")).length, 1);
    assert.ok(fault.operations.some((operation) =>
      operation.phase === "rollback" && operation.action === "restore" && operation.label === "project configuration"));
    assertBoundedTransactionError(error, dir, ["new-config", "new-env"], "incomplete");
    assert.deepEqual(error.diagnostics.recoveryFailures, [{
      action: "restore",
      label: "server environment",
      code: "EACCES",
    }]);
  });
});
