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
      const outcome = await adapter[outerMode](async (transaction) => {
        let timeout;
        const timedOut = new Promise((resolve) => { timeout = setTimeout(() => resolve({ kind: "timed-out" }), 100); });
        try {
          return await Promise.race([
            Promise.resolve().then(() => transaction[nestedMode](async () => { nestedCallbackEntered = true; })).then(
              () => ({ kind: "resolved" }),
              (error) => ({ kind: "rejected", error }),
            ),
            timedOut,
          ]);
        } finally { clearTimeout(timeout); }
      });
      assert.equal(outcome.kind, "rejected", `${outerMode} -> ${nestedMode} rejects instead of waiting on its own connection queue`);
      assert.match(outcome.error.message, /nested database transactions are not supported/i);
      assert.equal(nestedCallbackEntered, false);
    }
  }
}

async function assertCapturedRootTransactionReentryRejectsPromptly(adapter) {
  for (const timing of ["before await", "after await"]) {
    let nested;
    let nestedCallbackEntered = false;
    const outcome = await adapter.withTransaction(async () => {
      if (timing === "after await") await Promise.resolve();
      nested = adapter.withTransaction(async () => { nestedCallbackEntered = true; });
      const nestedOutcome = await Promise.race([
        nested.then(
          () => ({ kind: "resolved" }),
          (error) => ({ kind: "rejected", error }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 100)),
      ]);
      if (nestedOutcome.kind === "timed-out") throw new Error(`captured root reentry timed out ${timing}`);
      return nestedOutcome;
    }).catch((error) => ({ kind: "outer-rejected", error }));

    if (nested) await nested.catch(() => {});
    assert.equal(outcome.kind, "rejected", `captured root reentry ${timing} rejects instead of waiting on its own connection queue`);
    assert.match(outcome.error.message, /nested database transactions are not supported/i);
    assert.equal(nestedCallbackEntered, false);
  }
}

async function assertPublicOperationsWaitForTransactionOwner(adapter, prefix) {
  const rowsTable = `${prefix}_rows`;
  await adapter.exec(`CREATE TABLE ${rowsTable} (id TEXT PRIMARY KEY)`);
  for (const outcome of ["commit", "rollback"]) {
    const outsideTable = `${prefix}_${outcome}_outside`;
    let releaseOwner;
    let ownerEntered;
    let transactionOwner;
    const entered = new Promise((resolve) => { ownerEntered = resolve; });
    const release = new Promise((resolve) => { releaseOwner = resolve; });
    const transaction = adapter.withTransaction(async (owner) => {
      transactionOwner = owner;
      await owner.prepare(`INSERT INTO ${rowsTable} (id) VALUES (?)`).run(outcome);
      assert.equal(Number((await owner.prepare(`SELECT COUNT(*) AS count FROM ${rowsTable} WHERE id = ?`).get(outcome)).count), 1);
      ownerEntered();
      await release;
      if (outcome === "rollback") throw new Error("rollback owner");
    });
    await entered;

    let outsideReadFinished = false;
    let outsideExecFinished = false;
    const outsideRead = Promise.resolve(adapter.prepare(`SELECT COUNT(*) AS count FROM ${rowsTable} WHERE id = ?`).get(outcome)).then((row) => {
      outsideReadFinished = true;
      return Number(row.count);
    });
    const outsideExec = Promise.resolve(adapter.exec(`CREATE TABLE ${outsideTable} (id TEXT PRIMARY KEY)`)).then(() => {
      outsideExecFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outsideReadFinished, false, `${outcome}: a public read waits outside the active transaction`);
    assert.equal(outsideExecFinished, false, `${outcome}: a public exec waits outside the active transaction`);
    assert.equal(
      Number((await transactionOwner.prepare(`SELECT COUNT(*) AS count FROM ${rowsTable} WHERE id = ?`).get(outcome)).count),
      1,
      `${outcome}: the transaction owner continues while public operations wait`,
    );
    releaseOwner();
    if (outcome === "rollback") await assert.rejects(transaction, /rollback owner/);
    else await transaction;
    assert.equal(await outsideRead, outcome === "commit" ? 1 : 0);
    await outsideExec;
  }
}

async function assertChainedPublicOperationsResumeAfterTransaction(adapter, prefix) {
  const table = `${prefix}_rows`;
  await adapter.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
  await adapter.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run("one");

  let releaseOwner;
  let ownerEntered;
  const entered = new Promise((resolve) => { ownerEntered = resolve; });
  const release = new Promise((resolve) => { releaseOwner = resolve; });
  const transaction = adapter.withTransaction(async (owner) => {
    await owner.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run("two");
    ownerEntered();
    await release;
  });
  await entered;

  const observed = [];
  const chainedReads = (async () => {
    observed.push(Number((await adapter.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count));
    observed.push(Number((await adapter.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count));
  })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, []);

  releaseOwner();
  await transaction;
  const outcome = await Promise.race([
    chainedReads.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);
  assert.equal(outcome, "completed", "a chained public operation must not be stranded after transaction release");
  assert.deepEqual(observed, [2, 2]);
}

test("nested transaction deadlines begin after a cold adapter enters its callback", async () => {
  const nestedError = new Error("Nested database transactions are not supported.");
  const transaction = {
    withTransaction: async () => { throw nestedError; },
    withReadOnlySnapshot: async () => { throw nestedError; },
  };
  const coldAdapter = {
    withTransaction: async (callback) => {
      await new Promise((resolve) => setTimeout(resolve, 125));
      return await callback(transaction);
    },
    withReadOnlySnapshot: async (callback) => {
      await new Promise((resolve) => setTimeout(resolve, 125));
      return await callback(transaction);
    },
  };
  await assertNestedTransactionModesRejectPromptly(coldAdapter);
});

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

test("SQLite rejects captured root transaction reentry before and after await", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-captured-root-transaction-sqlite-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    await assertCapturedRootTransactionReentryRejectsPromptly(adapter);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL transaction callbacks reject nested transaction modes without deadlocking", async () => {
  await withLibsqlAdapter(async (adapter) => {
    await assertNestedTransactionModesRejectPromptly(adapter);
  }, { isolateProcess: true });
});

test("Postgres transaction callbacks reject nested transaction modes without deadlocking", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (adapter) => {
    await assertNestedTransactionModesRejectPromptly(adapter);
  });
});

test("Postgres rejects captured root transaction reentry before and after await", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (adapter) => {
    await assertCapturedRootTransactionReentryRejectsPromptly(adapter);
  });
});

test("SQLite keeps public operations outside a transaction while owner operations proceed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-transaction-owner-sqlite-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    await assertPublicOperationsWaitForTransactionOwner(adapter, "ticket04_sqlite_gate");
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite resumes chained public operations after a transaction completes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-transaction-chain-sqlite-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    await assertChainedPublicOperationsResumeAfterTransaction(adapter, "ticket04_sqlite_chain");
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Postgres keeps public operations outside a transaction while owner operations proceed", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (adapter) => {
    await assertPublicOperationsWaitForTransactionOwner(adapter, "ticket04_postgres_gate");
  }, {
    appTableNames: [
      "ticket04_postgres_gate_rows",
      "ticket04_postgres_gate_commit_outside",
      "ticket04_postgres_gate_rollback_outside",
    ],
  });
});

test("Postgres resumes chained public operations after a transaction completes", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (adapter) => {
    await assertChainedPublicOperationsResumeAfterTransaction(adapter, "ticket04_postgres_chain");
  }, {
    appTableNames: ["ticket04_postgres_chain_rows"],
  });
});
