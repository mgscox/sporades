import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mutation } from "../dist/server.js";

function retryableClamavChild() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, signals: [], canExit: false });
  child.kill = function (signal) {
    this.signals.push(signal);
    if (!this.canExit) return;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  };
  return child;
}

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

test("real runtime shutdown aggregates a hook failure with mail closure failure", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-shutdown-mail-errors-"));
  const hookError = new Error("shutdown hook failed");
  const mailError = new Error("mail close failed");
  const database = await runtime.openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "close" }, {
    hooks: { shutdown() { throw hookError; } },
  });
  const originalMailClose = database.mail.close.bind(database.mail);
  try {
    await database.init();
    database.mail.close = () => { throw mailError; };
    await assert.rejects(
      database.shutdown(),
      (error) => error instanceof AggregateError
        && error.errors[0] === hookError
        && error.errors[1] === mailError,
    );
  } finally {
    database.mail.close = originalMailClose;
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("real runtime shutdown closes mail and permits retry when owned ClamAV cleanup fails", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-shutdown-clamav-retry-"));
  const database = await runtime.openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "close" }, {});
  const child = retryableClamavChild();
  const originalMailClose = database.mail.close.bind(database.mail);
  let mailCloseCalls = 0;
  try {
    await database.init();
    database.__clamavProcess = child;
    database.__clamavTest = { terminateTimeoutMs: 0 };
    database.mail.close = () => { mailCloseCalls += 1; return originalMailClose(); };

    await assert.rejects(
      database.shutdown(),
      (error) => error instanceof AggregateError
        && error.errors[0]?.code === "CLAMAV_CHILD_TERMINATION_FAILED",
    );
    assert.equal(database.__runtimeInitialized, false);
    assert.equal(database.__clamavProcess, child, "failed scanner ownership must remain available for retry");
    assert.equal(mailCloseCalls, 1);

    child.canExit = true;
    await database.shutdown();
    assert.equal(database.__clamavProcess, null);
    assert.equal(mailCloseCalls, 2);
  } finally {
    database.mail.close = originalMailClose;
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("real runtime shutdown preserves lifecycle, ClamAV, and mail failures in teardown order", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-shutdown-aggregate-"));
  const lifecycleError = new Error("shutdown hook failed");
  const mailError = new Error("mail close failed");
  const calls = [];
  const database = await runtime.openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "close" }, {
    hooks: { shutdown() { calls.push("lifecycle"); throw lifecycleError; } },
  });
  const child = retryableClamavChild();
  const originalMailClose = database.mail.close.bind(database.mail);
  let rejectMailClose = true;
  try {
    await database.init();
    database.__clamavProcess = child;
    database.__clamavTest = { terminateTimeoutMs: 0 };
    database.mail.close = () => {
      calls.push("mail");
      if (rejectMailClose) throw mailError;
      return originalMailClose();
    };

    await assert.rejects(
      database.shutdown(),
      (error) => error instanceof AggregateError
        && error.errors.length === 3
        && error.errors[0] === lifecycleError
        && error.errors[1] instanceof AggregateError
        && error.errors[1].errors[0]?.code === "CLAMAV_CHILD_TERMINATION_FAILED"
        && error.errors[2] === mailError,
    );
    assert.deepEqual(calls, ["lifecycle", "mail"]);
    assert.equal(database.__runtimeInitialized, false);
    assert.equal(database.__clamavProcess, child);

    child.canExit = true;
    rejectMailClose = false;
    await database.shutdown();
    assert.deepEqual(calls, ["lifecycle", "mail", "mail"], "a cleanup retry must not repeat the lifecycle hook");
    assert.equal(database.__clamavProcess, null);
  } finally {
    database.mail.close = originalMailClose;
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
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
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z"), setTimer: () => 1, clearTimer() {} },
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

test("runtime replacement rejects a Job activation timer failure before outgoing teardown", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-replacement-preflight-"));
  const activationError = new Error("job activation timer unavailable");
  const calls = [];
  const current = {
    async shutdown() { calls.push("current.shutdown"); },
    async close() { calls.push("current.close"); },
  };
  const candidate = await runtime.openDevDatabase(path.join(dir, "candidate.db"), "", {}, { name: "candidate" }, {
    hooks: {
      init() { calls.push("candidate.init"); },
      shutdown() { calls.push("candidate.shutdown"); },
    },
    mutations: { probe: mutation(() => ({ runtime: "candidate" })) },
  }, {
    clock: {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      setTimer() { calls.push("candidate.timer"); throw activationError; },
      clearTimer() {},
    },
  });
  const closeCandidate = candidate.close.bind(candidate);
  candidate.close = async () => { calls.push("candidate.close"); await closeCandidate(); };

  try {
    await assert.rejects(runtime.replaceRuntimeDatabase(current, candidate), (error) => error === activationError);
    assert.deepEqual(calls, [
      "candidate.init",
      "candidate.timer",
      "candidate.shutdown",
      "candidate.close",
    ]);
  } finally {
    await Promise.resolve().then(() => closeCandidate()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime replacement preserves activation preflight and candidate cleanup failures", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const activationError = new Error("job activation timer unavailable");
  const shutdownError = new Error("candidate shutdown failed");
  const closeError = new Error("candidate close failed");
  const calls = [];
  const current = {
    async shutdown() { calls.push("current.shutdown"); },
    async close() { calls.push("current.close"); },
  };
  const candidate = {
    async __deferJobExecution() { calls.push("candidate.defer"); },
    async init() { calls.push("candidate.init"); },
    __preflightJobExecutionActivation() { calls.push("candidate.preflight"); throw activationError; },
    async shutdown() { calls.push("candidate.shutdown"); throw shutdownError; },
    async close() { calls.push("candidate.close"); throw closeError; },
  };

  await assert.rejects(
    runtime.replaceRuntimeDatabase(current, candidate),
    (error) => error instanceof AggregateError
      && error.errors[0] === activationError
      && error.errors[1] instanceof AggregateError
      && error.errors[1].errors[0] === shutdownError
      && error.errors[1].errors[1] === closeError,
  );
  assert.deepEqual(calls, [
    "candidate.defer",
    "candidate.init",
    "candidate.preflight",
    "candidate.shutdown",
    "candidate.close",
  ]);
});

test("candidate preparation failure closes the candidate, removes its sidecar, preserves the old runtime, and permits retry", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const calls = [];
  const preparationError = new Error("scanner image unavailable");
  const current = {
    async shutdown() { calls.push("current.shutdown"); },
    async close() { calls.push("current.close"); },
  };
  const failedCandidate = {
    async close() { calls.push("failed.close"); },
  };
  let sidecar = { async stop() { calls.push("sidecar.stop"); } };

  await assert.rejects(
    runtime.replacePreparedRuntimeDatabase(
      current,
      failedCandidate,
      async () => { calls.push("prepare.failed"); throw preparationError; },
      async () => { const candidateSidecar = sidecar; sidecar = null; await candidateSidecar?.stop(); },
    ),
    (error) => error === preparationError,
  );
  assert.deepEqual(calls, ["prepare.failed", "sidecar.stop", "failed.close"]);

  const retryCandidate = {
    async init() { calls.push("retry.init"); },
    async shutdown() { calls.push("retry.shutdown"); },
    async close() { calls.push("retry.close"); },
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z"), setTimer: () => 1, clearTimer() {} },
  };
  const promoted = await runtime.replacePreparedRuntimeDatabase(
    current,
    retryCandidate,
    async () => { calls.push("prepare.retry"); },
    async () => {},
  );
  assert.equal(promoted, retryCandidate);
  assert.deepEqual(calls.slice(3), ["prepare.retry", "retry.init", "current.shutdown", "current.close"]);
});

test("candidate preparation failure aggregates candidate and sidecar cleanup errors", async () => {
  const runtime = await import("../dist/server-runtime-source.js");
  const preparationError = new Error("scanner startup failed");
  const sidecarError = new Error("scanner cleanup failed");
  const closeError = new Error("candidate close failed");
  await assert.rejects(
    runtime.replacePreparedRuntimeDatabase(
      {},
      { async close() { throw closeError; } },
      async () => { throw preparationError; },
      async () => { throw sidecarError; },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === preparationError
      && error.errors.includes(sidecarError)
      && error.errors.includes(closeError),
  );
});

test("runtime replacement promotes a request-capable candidate when Job activation degrades after teardown", async (t) => {
  const runtime = await import("../dist/server-runtime-source.js");
  const auth = { userId: "replacement-user", displayName: "Replacement", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
  for (const teardownFails of [false, true]) await t.test(teardownFails ? "after teardown failure" : "after orderly teardown", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-replacement-activation-degraded-"));
    const teardownError = new Error("old teardown failed");
    const activationError = new Error("job activation timer unavailable");
    const calls = [];
    let timerAttempt = 0;
    const candidate = await runtime.openDevDatabase(path.join(dir, "candidate.db"), "", {}, { name: "candidate" }, {
      mutations: { probe: mutation(() => { calls.push("candidate.request"); return { runtime: "candidate" }; }) },
    }, {
      clock: {
        now: () => new Date("2030-01-01T00:00:00.000Z"),
        setTimer() {
          timerAttempt += 1;
          calls.push(`candidate.timer.${timerAttempt}`);
          if (timerAttempt > 1) throw activationError;
          return timerAttempt;
        },
        clearTimer(timer) { calls.push(`candidate.clear.${timer}`); },
      },
    });
    candidate.log = {
      emit(event) { calls.push(`candidate.warning:${event.event}`); },
    };
    const current = {
      async shutdown() { calls.push("current.shutdown"); if (teardownFails) throw teardownError; },
      async close() { calls.push("current.close"); },
    };
    let promoted;

    try {
      promoted = await runtime.replaceRuntimeDatabase(current, candidate);
      assert.equal(promoted, candidate);
      assert.deepEqual(await runtime.runMutation(promoted, auth, "probe", []), {
        ok: true,
        data: { runtime: "candidate" },
        error: null,
      });
      assert.deepEqual(calls, [
        "candidate.timer.1",
        "candidate.clear.1",
        "current.shutdown",
        "current.close",
        "candidate.timer.2",
        "candidate.timer.3",
        "candidate.warning:dev.runtime.job_activation_degraded",
        ...(teardownFails ? ["candidate.warning:dev.runtime.previous_teardown_failed"] : []),
        "candidate.request",
      ]);
    } finally {
      await Promise.resolve(promoted ?? candidate).then((database) => database.close()).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
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
