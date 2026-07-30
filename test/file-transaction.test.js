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

test("atomic file replacement rejects duplicate lexical target aliases before filesystem operations", async () => {
  await withTempDir(async (dir) => {
    const targetPath = path.join(dir, "sporades.json");
    const original = "old-config-exact\n";
    await writeFile(targetPath, original);
    const fault = faultExecutor(async (_operation, action) => action());

    const error = await captureRejection(replaceFilesAtomically([
      { path: targetPath, label: "project configuration", contents: "replacement-one-secret\n" },
      { path: targetPath, label: "duplicate exact", contents: "replacement-two-secret\n" },
      { path: `${dir}/./sporades.json`, label: "duplicate dot", contents: "replacement-three-secret\n" },
      { path: `${dir}/unused/../sporades.json`, label: "duplicate parent", contents: "replacement-four-secret\n" },
    ], { execute: fault.execute }));

    assert.equal(await readFile(targetPath, "utf8"), original);
    assert.deepEqual(fault.operations, []);
    assert.deepEqual(await transactionArtifacts(dir), []);
    assertBoundedTransactionError(error, dir, [
      "replacement-one-secret",
      "replacement-two-secret",
      "replacement-three-secret",
      "replacement-four-secret",
    ], "complete");
    assert.deepEqual(error.diagnostics.original, {
      phase: "validate",
      action: "reject-duplicate",
      label: "transaction",
      code: "DUPLICATE_TARGET",
    });
  });
});

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

const commitFaultCases = [
  { name: "before first backup", label: "project configuration", action: "backup", timing: "before", priorEnv: "existing" },
  { name: "after first backup", label: "project configuration", action: "backup", timing: "after", priorEnv: "existing" },
  { name: "before first replace", label: "project configuration", action: "replace", timing: "before", priorEnv: "existing" },
  { name: "after first replace", label: "project configuration", action: "replace", timing: "after", priorEnv: "existing" },
  { name: "before later backup", label: "server environment", action: "backup", timing: "before", priorEnv: "existing" },
  { name: "after later backup", label: "server environment", action: "backup", timing: "after", priorEnv: "existing" },
  { name: "before later existing replace", label: "server environment", action: "replace", timing: "before", priorEnv: "existing" },
  { name: "after later existing replace", label: "server environment", action: "replace", timing: "after", priorEnv: "existing" },
  { name: "before later missing replace", label: "server environment", action: "replace", timing: "before", priorEnv: "missing" },
  { name: "after later missing replace", label: "server environment", action: "replace", timing: "after", priorEnv: "missing" },
];

for (const faultCase of commitFaultCases) {
  test(`atomic file replacement recovers a ${faultCase.name} failure`, async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "sporades.json");
      const envPath = path.join(dir, ".env.sporades.server");
      const oldConfig = "old-config-exact\n";
      const oldEnv = "TOKEN=old-env-secret\n";
      await writeFile(configPath, oldConfig);
      if (faultCase.priorEnv === "existing") await writeFile(envPath, oldEnv);
      const fault = faultExecutor(async (operation, action) => {
        if (
          operation.phase === "commit" &&
          operation.action === faultCase.action &&
          operation.label === faultCase.label
        ) {
          if (faultCase.timing === "after") await action();
          throw injectedError("EIO");
        }
        return action();
      });

      const error = await captureRejection(replaceFilesAtomically([
        { path: configPath, label: "project configuration", contents: "new-config-secret\n" },
        { path: envPath, label: "server environment", contents: "TOKEN=new-env-secret\n" },
      ], { execute: fault.execute }));

      assert.equal(await readFile(configPath, "utf8"), oldConfig);
      if (faultCase.priorEnv === "existing") {
        assert.equal(await readFile(envPath, "utf8"), oldEnv);
      } else {
        await assert.rejects(readFile(envPath), { code: "ENOENT" });
      }
      assert.deepEqual(await transactionArtifacts(dir), []);
      assertBoundedTransactionError(error, dir, ["new-config-secret", "new-env-secret"], "complete");
      assert.deepEqual(error.diagnostics.original, {
        phase: "commit",
        action: faultCase.action,
        label: faultCase.label,
        code: "EIO",
      });
    });
  });
}

test("atomic file replacement cleans every staged temp after a later partial stage failure", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "sporades.json");
    const envPath = path.join(dir, ".env.sporades.server");
    await writeFile(configPath, "old-config\n");
    await writeFile(envPath, "TOKEN=old-env\n");
    const fault = faultExecutor(async (operation, action) => {
      if (operation.phase === "stage" && operation.label === "server environment") {
        await writeFile(operation.artifactPath, "partial-later-secret");
        throw injectedError("ENOSPC");
      }
      return action();
    });

    const error = await captureRejection(replaceFilesAtomically([
      { path: configPath, label: "project configuration", contents: "new-config\n" },
      { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
    ], { execute: fault.execute }));

    assert.equal(await readFile(configPath, "utf8"), "old-config\n");
    assert.equal(await readFile(envPath, "utf8"), "TOKEN=old-env\n");
    assert.deepEqual(await transactionArtifacts(dir), []);
    assertBoundedTransactionError(error, dir, ["partial-later-secret", "new-config", "new-env"], "complete");
  });
});

for (const timing of ["before", "after"]) {
  test(`rollback remove ${timing} ambiguity reports the missing-target state truthfully`, async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "sporades.json");
      const envPath = path.join(dir, ".env.sporades.server");
      await writeFile(configPath, "old-config\n");
      const fault = faultExecutor(async (operation, action) => {
        if (operation.phase === "commit" && operation.action === "replace" && operation.label === "server environment") {
          await action();
          throw injectedError("ENOSPC");
        }
        if (operation.phase === "rollback" && operation.action === "remove" && operation.label === "server environment") {
          if (timing === "after") await action();
          throw injectedError("EACCES");
        }
        return action();
      });

      const error = await captureRejection(replaceFilesAtomically([
        { path: configPath, label: "project configuration", contents: "new-config\n" },
        { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
      ], { execute: fault.execute }));

      assert.equal(await readFile(configPath, "utf8"), "old-config\n");
      if (timing === "after") {
        await assert.rejects(readFile(envPath), { code: "ENOENT" });
        assert.deepEqual(await transactionArtifacts(dir), []);
        assertBoundedTransactionError(error, dir, ["new-config", "new-env"], "complete");
        assert.deepEqual(error.diagnostics.recoveryFailures, []);
      } else {
        assert.equal(await readFile(envPath, "utf8"), "TOKEN=new-env\n");
        assertBoundedTransactionError(error, dir, ["new-config", "new-env"], "incomplete");
        assert.deepEqual(error.diagnostics.recoveryFailures, [{
          action: "remove",
          label: "server environment",
          code: "EACCES",
        }]);
      }
    });
  });
}

for (const label of ["project configuration", "server environment"]) {
  for (const timing of ["before", "after"]) {
    test(`rollback restore ${timing} ambiguity for ${label} reports the existing-target state truthfully`, async () => {
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
          if (operation.phase === "rollback" && operation.action === "restore" && operation.label === label) {
            if (timing === "after") await action();
            throw injectedError("EACCES");
          }
          return action();
        });

        const error = await captureRejection(replaceFilesAtomically([
          { path: configPath, label: "project configuration", contents: "new-config\n" },
          { path: envPath, label: "server environment", contents: "TOKEN=new-env\n" },
        ], { execute: fault.execute }));

        const expectedComplete = timing === "after";
        assert.equal(
          await readFile(configPath, "utf8"),
          label === "project configuration" && !expectedComplete ? "new-config\n" : "old-config\n",
        );
        assert.equal(
          await readFile(envPath, "utf8"),
          label === "server environment" && !expectedComplete ? "TOKEN=new-env\n" : "TOKEN=old-env\n",
        );
        const artifacts = await transactionArtifacts(dir);
        assert.equal(artifacts.filter((name) => name.endsWith(".tmp")).length, 0);
        assert.equal(artifacts.filter((name) => name.endsWith(".bak")).length, expectedComplete ? 0 : 1);
        if (!expectedComplete) {
          assert.equal(
            await readFile(path.join(dir, artifacts[0]), "utf8"),
            label === "project configuration" ? "old-config\n" : "TOKEN=old-env\n",
          );
        }
        assertBoundedTransactionError(error, dir, ["new-config", "new-env"], expectedComplete ? "complete" : "incomplete");
        assert.deepEqual(error.diagnostics.recoveryFailures, expectedComplete ? [] : [{
          action: "restore",
          label,
          code: "EACCES",
        }]);
      });
    });
  }
}

for (const timing of ["before", "after"]) {
  test(`recovery temp cleanup ${timing} ambiguity reports artifact state truthfully`, async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "sporades.json");
      await writeFile(configPath, "old-config\n");
      const fault = faultExecutor(async (operation, action) => {
        if (operation.phase === "stage" && operation.label === "project configuration") {
          await writeFile(operation.artifactPath, "partial-temp-secret");
          throw injectedError("ENOSPC");
        }
        if (operation.phase === "cleanup" && operation.action === "remove-temp") {
          if (timing === "after") await action();
          throw injectedError("EACCES");
        }
        return action();
      });

      const error = await captureRejection(replaceFilesAtomically([
        { path: configPath, label: "project configuration", contents: "new-config-secret\n" },
      ], { execute: fault.execute }));

      assert.equal(await readFile(configPath, "utf8"), "old-config\n");
      const artifacts = await transactionArtifacts(dir);
      assert.equal(artifacts.length, timing === "after" ? 0 : 1);
      if (timing === "before") {
        assert.equal(await readFile(path.join(dir, artifacts[0]), "utf8"), "partial-temp-secret");
      }
      assertBoundedTransactionError(error, dir, ["partial-temp-secret", "new-config-secret"], timing === "after" ? "complete" : "incomplete");
      assert.deepEqual(error.diagnostics.recoveryFailures, timing === "after" ? [] : [{
        action: "remove-temp",
        label: "project configuration",
        code: "EACCES",
      }]);
    });
  });
}

for (const timing of ["before", "after"]) {
  test(`committed backup cleanup ${timing} ambiguity reports artifact state truthfully`, async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "sporades.json");
      await writeFile(configPath, "old-config\n");
      const fault = faultExecutor(async (operation, action) => {
        if (operation.phase === "cleanup" && operation.action === "remove-backup") {
          if (timing === "after") await action();
          throw injectedError("EACCES");
        }
        return action();
      });

      const transaction = replaceFilesAtomically([
        { path: configPath, label: "project configuration", contents: "new-config-secret\n" },
      ], { execute: fault.execute });

      if (timing === "after") {
        await transaction;
        assert.equal(await readFile(configPath, "utf8"), "new-config-secret\n");
        assert.deepEqual(await transactionArtifacts(dir), []);
      } else {
        const error = await captureRejection(transaction);
        assert.equal(await readFile(configPath, "utf8"), "new-config-secret\n");
        const artifacts = (await transactionArtifacts(dir)).filter((name) => name.endsWith(".bak"));
        assert.equal(artifacts.length, 1);
        assert.equal(await readFile(path.join(dir, artifacts[0]), "utf8"), "old-config\n");
        assertBoundedTransactionError(error, dir, ["new-config-secret"], "committed");
        assert.deepEqual(error.diagnostics.recoveryFailures, [{
          action: "remove-backup",
          label: "project configuration",
          code: "EACCES",
        }]);
      }
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
