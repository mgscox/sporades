import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSqliteDatabaseAdapter } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter } from "./support/database-adapter-engines.js";

async function assertNestedTransactionModesRejectPromptly(adapter) {
  for (const outerMode of ["withTransaction", "withReadOnlySnapshot"]) {
    for (const nestedMode of ["withTransaction", "withReadOnlySnapshot"]) {
      let nestedCallbackEntered = false;
      const outcome = await Promise.race([
        adapter[outerMode](async (transaction) => {
          await transaction[nestedMode](async () => { nestedCallbackEntered = true; });
        }).then(
          () => ({ kind: "resolved" }),
          (error) => ({ kind: "rejected", error }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 100)),
      ]);
      assert.equal(outcome.kind, "rejected", `${outerMode} -> ${nestedMode} rejects instead of waiting on its own connection queue`);
      assert.match(outcome.error.message, /nested database transactions are not supported/i);
      assert.equal(nestedCallbackEntered, false);
    }
  }
}

test("a single connection does not begin a second transaction until the first has completed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-transaction-serialization-"));
  try {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      let releaseFirst;
      let secondEntered = false;
      const first = adapter.withTransaction(async () => await new Promise((resolve) => { releaseFirst = resolve; }));
      await new Promise((resolve) => setImmediate(resolve));
      const second = adapter.withTransaction(async () => { secondEntered = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(secondEntered, false);
      releaseFirst();
      await Promise.all([first, second]);
      assert.equal(secondEntered, true);
    } finally {
      adapter.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite transaction callbacks reject nested transaction modes without deadlocking", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-nested-transaction-sqlite-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    await assertNestedTransactionModesRejectPromptly(adapter);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL transaction callbacks reject nested transaction modes without deadlocking", async () => {
  await withLibsqlAdapter(async (adapter) => {
    await assertNestedTransactionModesRejectPromptly(adapter);
  });
});

test("Postgres transaction callbacks reject nested transaction modes without deadlocking", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (adapter) => {
    await assertNestedTransactionModesRejectPromptly(adapter);
  });
});
