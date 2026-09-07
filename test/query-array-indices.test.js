import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { capsule, query } from "../dist/server.js";
import { openDevDatabase, runQuery } from "../dist/server-runtime-source.js";

const auth = { userId: "array-indices", isAuthenticated: false, isGuest: true, provider: "anonymous" };

test("server queries accept multi-element argument tuples and nested arrays without admitting malformed arrays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-query-array-indices-"));
  let calls = 0;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {}, capsule({
    name: "query-array-indices",
    queries: { echo: query((_ctx, ...args) => { calls += 1; return args; }) },
  }));
  try {
    for (const args of [[], ["a"], ["a", "b"], Array.from({ length: 12 }, (_, i) => i), [[1, 2]], [{ items: [1, 2] }]]) {
      const before = calls;
      const result = await runQuery(database, auth, "echo", args);
      assert.equal(result.error, null, JSON.stringify(args));
      assert.equal(JSON.stringify(result.data), JSON.stringify(args));
      assert.equal(calls, before + 1);
    }
    const malformed = [[, "sparse"]];
    for (const key of ["extra", "01", "-1", "1d", "1\\d"]) {
      const value = ["valid"];
      Object.defineProperty(value, key, { value: true });
      malformed.push(value);
    }
    for (const value of malformed) {
      for (const args of [value, [{ nested: value }]]) {
        const before = calls;
        const known = await runQuery(database, auth, "echo", args);
        const unknown = await runQuery(database, auth, "missing", args);
        assert.equal(known.error.message, "Invalid query arguments.");
        assert.deepEqual(unknown.error, known.error);
        assert.equal(calls, before, "malformed arrays must not reach the handler");
      }
    }
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
