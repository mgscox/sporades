import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mutation } from "../dist/server.js";

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

test("runtime close attempts every resource after a synchronous closer failure", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-resource-close-"));
  const database = await runtime.openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "close" }, {});
  const baseAdapter = database.adapter;
  const mailError = new Error("mail close failed");
  const calls = [];
  database.mail = { close() { calls.push("mail"); throw mailError; } };
  database.adapter = { close() { calls.push("adapter"); baseAdapter.close(); } };
  database.fileStorage = { close() { calls.push("storage"); } };
  try {
    await assert.rejects(Promise.resolve().then(() => database.close()), (error) => error === mailError);
    assert.deepEqual(calls, ["mail", "adapter", "storage"]);
  } finally {
    await Promise.resolve().then(() => baseAdapter.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime close aggregates multiple resource failures after attempting every closer", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-resource-close-multiple-"));
  const database = await runtime.openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "close" }, {});
  const baseAdapter = database.adapter;
  const mailError = new Error("mail close failed");
  const adapterError = new Error("adapter close failed");
  const storageError = new Error("storage close failed");
  const calls = [];
  database.mail = { close() { calls.push("mail"); throw mailError; } };
  database.adapter = { close() { calls.push("adapter"); baseAdapter.close(); throw adapterError; } };
  database.fileStorage = { close() { calls.push("storage"); throw storageError; } };
  try {
    await assert.rejects(
      Promise.resolve().then(() => database.close()),
      (error) => error instanceof AggregateError
        && error.errors[0] === mailError
        && error.errors[1] === adapterError
        && error.errors[2] === storageError,
    );
    assert.deepEqual(calls, ["mail", "adapter", "storage"]);
  } finally {
    await Promise.resolve().then(() => baseAdapter.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime database replacement promotes the initialized candidate when old teardown fails", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  assert.equal(typeof runtime.replaceRuntimeDatabase, "function");

  const teardownError = new Error("old teardown failed");
  const calls = [];
  let releaseWarning;
  const pendingWarning = new Promise((resolve) => { releaseWarning = resolve; });
  const current = {
    async shutdown() { calls.push("current.shutdown"); throw teardownError; },
    async close() { calls.push("current.close"); },
  };
  const candidate = {
    async init() { calls.push("candidate.init"); },
    async shutdown() { calls.push("candidate.shutdown"); },
    async close() { calls.push("candidate.close"); },
    log: { emit() { calls.push("candidate.warning"); return pendingWarning; } },
  };

  const replacement = runtime.replaceRuntimeDatabase(current, candidate);
  const outcome = await Promise.race([
    replacement,
    new Promise((resolve) => setImmediate(() => resolve("blocked-on-warning"))),
  ]);
  releaseWarning();
  assert.equal(outcome, candidate, "warning persistence must not delay the ownership handoff");
  assert.deepEqual(calls, [
    "candidate.init",
    "current.shutdown",
    "current.close",
    "candidate.warning",
  ]);
});

test("a replacement remains request-capable after the old runtime shutdown hook fails", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-replacement-"));
  const current = await runtime.openDevDatabase(path.join(dir, "current.db"), "", {}, { name: "current" }, {
    hooks: { shutdown() { throw new Error("old shutdown failed"); } },
  });
  const candidate = await runtime.openDevDatabase(path.join(dir, "candidate.db"), "", {}, { name: "candidate" }, {
    mutations: { probe: mutation(() => ({ runtime: "candidate" })) },
  });
  const auth = { userId: "replacement-user", displayName: "Replacement", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
  let promoted = null;
  try {
    await current.init();
    promoted = await runtime.replaceRuntimeDatabase(current, candidate);
    assert.equal(promoted, candidate);
    assert.deepEqual(await runtime.runMutation(promoted, auth, "probe", []), {
      ok: true,
      data: { runtime: "candidate" },
      error: null,
    });
  } finally {
    await runtime.shutdownAndCloseDatabase(promoted ?? candidate).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP shutdown refuses new work and drains an in-flight request before runtime closure", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  assert.equal(typeof runtime.shutdownHttpServerAndRuntime, "function");
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  let releaseRequest;
  const release = new Promise((resolve) => { releaseRequest = resolve; });
  let runtimeClosed = false;
  const server = createServer(async (_request, response) => {
    requestStarted();
    await release;
    if (runtimeClosed) {
      response.writeHead(500).end("runtime closed early");
      return;
    }
    response.writeHead(200).end("completed");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const activeRequest = fetch(url);
  await started;

  const shutdown = runtime.shutdownHttpServerAndRuntime(server, async () => { runtimeClosed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fetch(url));
  assert.equal(runtimeClosed, false, "runtime resources must remain live while HTTP work drains");
  releaseRequest();
  assert.equal(await (await activeRequest).text(), "completed");
  await shutdown;
  assert.equal(runtimeClosed, true);
});

test("HTTP and runtime shutdown failures are reported together", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const serverError = new Error("server close failed");
  const runtimeError = new Error("runtime close failed");
  await assert.rejects(
    runtime.shutdownHttpServerAndRuntime(
      { close(callback) { callback(serverError); } },
      async () => { throw runtimeError; },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === serverError
      && error.errors[1] === runtimeError,
  );
});
