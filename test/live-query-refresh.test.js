import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_QUERY_ANY_TABLE,
  liveQueryNeedsRefresh,
  recordLiveQueryStatementRead,
  recordLiveQueryStatementWrite,
  recordLiveQueryTableRead,
  takeLiveQueryDirtyTables,
  trackLiveQueryReads,
} from "../dist/live-query-invalidation.js";
import { promiseCombinatorKind, releasePromiseObserver, retainPromiseObserver } from "../dist/promise-coordinator.js";

test("live query reads are attributed only to the tracked run, in either identifier quoting", async () => {
  recordLiveQueryStatementRead('SELECT * FROM "outside" WHERE "id" = ?');
  const tables = new Set();
  await trackLiveQueryReads(tables, async () => {
    recordLiveQueryStatementRead('SELECT * FROM "todos" WHERE "ownerId" = ?');
    await Promise.resolve();
    recordLiveQueryStatementRead("SELECT [p].[id] FROM [proofs] [p] JOIN [sessions] [s] ON [s].[token] = [p].[token]");
    recordLiveQueryTableRead("cachedRows");
  });
  assert.deepEqual([...tables].sort(), ["cachedRows", "proofs", "sessions", "todos"]);

  const unidentified = new Set();
  trackLiveQueryReads(unidentified, () => recordLiveQueryStatementRead("SELECT 1"));
  assert.deepEqual([...unidentified], [LIVE_QUERY_ANY_TABLE]);
});

test("live query writes mark only changed tables, and take starts a new window", () => {
  takeLiveQueryDirtyTables();
  recordLiveQueryStatementWrite('INSERT INTO "todos" ("id") VALUES (?)', { changes: 1 });
  recordLiveQueryStatementWrite('UPDATE "notes" SET "text" = ? WHERE "id" = ?', { changes: 2 });
  recordLiveQueryStatementWrite("DELETE FROM [archive] WHERE [id] = ?", { changes: 1 });
  recordLiveQueryStatementWrite('INSERT OR IGNORE INTO "fences" ("id") VALUES (?)', { changes: 1 });
  recordLiveQueryStatementWrite('UPDATE "untouched" SET "id" = "id" WHERE "id" = ?', { changes: 0 });
  recordLiveQueryStatementWrite("BEGIN IMMEDIATE");
  recordLiveQueryStatementWrite("COMMIT");
  recordLiveQueryStatementWrite("PRAGMA busy_timeout = 0");
  assert.deepEqual([...takeLiveQueryDirtyTables()].sort(), ["archive", "fences", "notes", "todos"]);
  assert.deepEqual([...takeLiveQueryDirtyTables()], [], "a taken window is not reported twice");

  recordLiveQueryStatementWrite('CREATE TABLE IF NOT EXISTS "todos" ("id" TEXT PRIMARY KEY)');
  assert.deepEqual([...takeLiveQueryDirtyTables()], [LIVE_QUERY_ANY_TABLE], "unidentified writes mark every table");
});

test("live query refresh decisions re-run only subscriptions that read a changed table", () => {
  const dirty = new Set(["notes"]);
  assert.equal(liveQueryNeedsRefresh(new Set(["todos"]), dirty), false);
  assert.equal(liveQueryNeedsRefresh(new Set(["todos", "notes"]), dirty), true);
  assert.equal(liveQueryNeedsRefresh(undefined, dirty), true, "a subscription whose first run is in flight re-runs");
  assert.equal(liveQueryNeedsRefresh(null, dirty), true, "a subscription with an unidentified read re-runs");
  assert.equal(liveQueryNeedsRefresh(new Set(["todos"]), new Set([LIVE_QUERY_ANY_TABLE])), true);
  assert.equal(liveQueryNeedsRefresh(new Set(["todos"]), new Set()), false);
});

test("the Promise hook identifies native combinator roots without formatting stack traces", async () => {
  const observer = {};
  const previousPrepareStackTrace = Error.prepareStackTrace;
  let formattedStacks = 0;
  const spy = (error, callSites) => {
    formattedStacks += 1;
    return previousPrepareStackTrace ? previousPrepareStackTrace(error, callSites) : `${error}\n${callSites.map((site) => `    at ${site}`).join("\n")}`;
  };
  Error.prepareStackTrace = spy;
  retainPromiseObserver(observer);
  try {
    const all = Promise.all([Promise.resolve(1), Promise.resolve(2)]);
    const allSettled = Promise.allSettled([Promise.resolve(1)]);
    const any = Promise.any([Promise.resolve(1)]);
    const race = Promise.race([Promise.resolve(1)]);
    assert.equal(promiseCombinatorKind(all), "all");
    assert.equal(promiseCombinatorKind(allSettled), "allSettled");
    assert.equal(promiseCombinatorKind(any), "any");
    assert.equal(promiseCombinatorKind(race), "race");
    await Promise.all([all, allSettled, any, race]);

    const plain = Promise.resolve(1).then((value) => value + 1);
    assert.equal(promiseCombinatorKind(plain), undefined);
    await plain;

    assert.equal(formattedStacks, 0, "combinator detection reads structured call sites, not formatted stacks");
    assert.equal(Error.prepareStackTrace, spy, "the caller's stack formatter is restored");
  } finally {
    releasePromiseObserver(observer);
    Error.prepareStackTrace = previousPrepareStackTrace;
  }
});
