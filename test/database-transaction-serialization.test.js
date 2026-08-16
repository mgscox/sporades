import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSqliteDatabaseAdapter } from "../dist/server-runtime-source.js";

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
