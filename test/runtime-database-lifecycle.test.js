import assert from "node:assert/strict";
import { test } from "node:test";

test("runtime database shutdown always attempts close and preserves lifecycle failures", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  assert.equal(typeof runtime.shutdownAndCloseDatabase, "function");

  const shutdownError = new Error("shutdown failed");
  const calls = [];
  await assert.rejects(
    runtime.shutdownAndCloseDatabase({
      async shutdown() { calls.push("shutdown"); throw shutdownError; },
      async close() { calls.push("close"); },
    }),
    (error) => error === shutdownError,
  );
  assert.deepEqual(calls, ["shutdown", "close"]);

  const closeError = new Error("close failed");
  await assert.rejects(
    runtime.shutdownAndCloseDatabase({
      async shutdown() { throw shutdownError; },
      async close() { throw closeError; },
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === shutdownError
      && error.errors[1] === closeError,
  );
});

test("runtime database replacement closes an initialized candidate when old teardown fails", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  assert.equal(typeof runtime.replaceRuntimeDatabase, "function");

  const teardownError = new Error("old teardown failed");
  const calls = [];
  const current = {
    async shutdown() { calls.push("current.shutdown"); throw teardownError; },
    async close() { calls.push("current.close"); },
  };
  const candidate = {
    async init() { calls.push("candidate.init"); },
    async shutdown() { calls.push("candidate.shutdown"); },
    async close() { calls.push("candidate.close"); },
  };

  await assert.rejects(runtime.replaceRuntimeDatabase(current, candidate), (error) => error === teardownError);
  assert.deepEqual(calls, [
    "candidate.init",
    "current.shutdown",
    "current.close",
    "candidate.shutdown",
    "candidate.close",
  ]);
});
