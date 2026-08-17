import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createControllableRuntimeClock,
  openDevDatabase,
  runCurrentUserJobWorker,
  runMutation,
} from "../dist/server-runtime-source.js";
import { job, mutation, schedule } from "../dist/server.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";

const auth = {
  userId: "user-1",
  displayName: "User One",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

async function withJobDatabase(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-time-domain-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const capsule = {
    jobs: { noop: job(() => null) },
    mutations: {
      enqueue: mutation((ctx, options) => ctx.jobs.enqueue("noop", null, options)),
      get: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  };
  let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    await run({ database, clock, capsule, file: path.join(dir, "data.db") });
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

test("Job enqueue rejects retry delays outside the durable timestamp domain", async () => {
  await withJobDatabase(async ({ database }) => {
    const result = await runMutation(database, auth, "enqueue", [{
      retry: { maxAttempts: 2, delayMs: Number.MAX_SAFE_INTEGER },
    }]);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  });
});

test("Job enqueue rejects a retry delay that cannot be represented from the runtime clock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-retry-clock-boundary-"));
  const clock = createControllableRuntimeClock("9999-12-31T23:59:59.900Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    jobs: { noop: job(() => null) },
    mutations: { enqueue: mutation((ctx) => ctx.jobs.enqueue("noop", null, { retry: { maxAttempts: 2, delayMs: 100 } })) },
  }, { clock });
  try {
    const result = await runMutation(database, auth, "enqueue", []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
  } finally {
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("Job enqueue reserves timestamp headroom for every promised retry attempt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-full-retry-horizon-"));
  const clock = createControllableRuntimeClock("9999-12-31T23:58:45.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    jobs: { noop: job(() => null) },
    mutations: {
      enqueue: mutation((ctx) => ctx.jobs.enqueue("noop", null, {
        retry: { maxAttempts: 3, delayMs: 30_000 },
      })),
    },
  }, { clock });
  try {
    const result = await runMutation(database, auth, "enqueue", []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  } finally {
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("Job enqueue rejects a retry delay outside the time domain of its first availability", async () => {
  await withJobDatabase(async ({ database }) => {
    const result = await runMutation(database, auth, "enqueue", [{
      availableAt: "9999-12-31T23:59:59.900Z",
      retry: { maxAttempts: 2, delayMs: 100 },
    }]);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
  });
});

test("Job enqueue rejects invalid, coercible, and extended-year availability with a structured error", async () => {
  await withJobDatabase(async ({ database }) => {
    for (const availableAt of [
      "not-a-date",
      "+010000-01-01T00:00:00.000Z",
      Symbol("invalid"),
      null,
      0,
      false,
      "0",
      { [Symbol.toStringTag]: "Date", valueOf() { return 0; } },
    ]) {
      const result = await runMutation(database, auth, "enqueue", [{ availableAt }]);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
    }
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  });
});

test("Job enqueue rejects unknown retry policy members", async () => {
  await withJobDatabase(async ({ database }) => {
    for (const retry of [
      { maxAttempts: 2, delayMs: 0, backoff: "exponential" },
      { maxAttempts: 2, delayMs: null },
      Object.create({ maxAttempts: 2 }),
      { maxAttempts: 2, [Symbol("backoff")]: "exponential" },
    ]) {
      const result = await runMutation(database, auth, "enqueue", [{ retry }]);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
    }
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  });
});

test("Schedule declarations reject unknown retry policy members", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-retry-members-"));
  try {
    await assert.rejects(
      openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
        jobs: { noop: job(() => null) },
        schedules: {
          invalid: schedule({
            expression: "0 0 * * *",
            job: "noop",
            retry: { maxAttempts: 2, delayMs: 0, backoff: "exponential" },
          }),
        },
      }),
      (error) => error?.code === "INVALID_JOB_OPTIONS",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Job enqueue rejects availability without enough time-domain headroom for its claim lease", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-lease-clock-boundary-"));
  const clock = createControllableRuntimeClock("9999-12-31T23:59:59.900Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    jobs: { noop: job(() => null) },
    mutations: { enqueue: mutation((ctx) => ctx.jobs.enqueue("noop", null)) },
  }, { clock });
  try {
    const result = await runMutation(database, auth, "enqueue", []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_JOB_OPTIONS");
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  } finally {
    await Promise.resolve().then(() => database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted invalid retry policy terminally fails a live attempt without stranding restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-live-retry-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const capsule = {
    jobs: { fail: job(() => { throw new Error("handler failed"); }) },
    mutations: {
      enqueue: mutation((ctx) => ctx.jobs.enqueue("fail", null, { retry: { maxAttempts: 2, delayMs: 0 } })),
      get: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    await database.init();
    const queued = await runMutation(database, auth, "enqueue", []);
    database.adapter.prepare("UPDATE sporades_jobs SET retryJson = ? WHERE id = ?")
      .run(JSON.stringify({ maxAttempts: 2, delayMs: Number.MAX_SAFE_INTEGER }), queued.data.id);

    await clock.runDueTimers();
    const failed = await runMutation(database, auth, "get", [queued.data.id]);
    assert.equal(failed.data.status, "failed");
    assert.equal(failed.data.failure.code, "JOB_RETRY_POLICY_INVALID");

    await database.close();
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    assert.equal(database.adapter.prepare("SELECT status FROM sporades_jobs WHERE id = ?").get(queued.data.id).status, "failed");
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("lease recovery terminally fails an invalid persisted retry policy without blocking startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-recovered-retry-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const capsule = { jobs: { noop: job(() => null) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory, leaseExpiresAt) VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, '[]', ?)",
    ).run(
      "invalid-retry",
      "noop",
      auth.userId,
      auth.userId,
      "null",
      clock.now().toISOString(),
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 2, delayMs: Number.MAX_SAFE_INTEGER }),
      "2029-12-31T23:59:59.000Z",
    );
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const row = database.adapter.prepare("SELECT status, failure FROM sporades_jobs WHERE id = ?").get("invalid-retry");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_RETRY_POLICY_INVALID");
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("lease recovery terminally fails an expired running Job with invalid retained availability", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-running-availability-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return true; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory, leaseExpiresAt) VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, '[]', ?)",
    ).run(
      "invalid-running-availability",
      "work",
      auth.userId,
      auth.userId,
      "null",
      "+010000-01-01T00:00:00.000Z",
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 2, delayMs: 0 }),
      "2029-12-31T23:59:59.000Z",
    );
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const row = database.adapter.prepare("SELECT status, failure FROM sporades_jobs WHERE id = ?").get("invalid-running-availability");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_AVAILABLE_AT_INVALID");
    await database.init();
    await clock.runDueTimers();
    assert.equal(executions, 0);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup terminally fails a legacy extended-year Job instead of executing it early", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-available-at-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    database.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory) VALUES (?, ?, ?, ?, ?, 'delayed', ?, 0, ?, ?, '[]')",
    ).run(
      "extended-year",
      "work",
      auth.userId,
      auth.userId,
      "null",
      "+010000-01-01T00:00:00.000Z",
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 1, delayMs: 0 }),
    );
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const row = database.adapter.prepare("SELECT status, failure FROM sporades_jobs WHERE id = ?").get("extended-year");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_AVAILABLE_AT_INVALID");
    await database.init();
    await clock.runDueTimers();
    assert.equal(executions, 0);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup terminally fails malformed retained retry state before a successful handler executes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-retained-retry-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return true; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    database.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, '[]')",
    ).run(
      "invalid-retained-retry",
      "work",
      auth.userId,
      auth.userId,
      "null",
      clock.now().toISOString(),
      clock.now().toISOString(),
      "{broken",
    );
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const row = database.adapter.prepare("SELECT status, failure FROM sporades_jobs WHERE id = ?").get("invalid-retained-retry");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_RETRY_POLICY_INVALID");
    await database.init();
    await clock.runDueTimers();
    assert.equal(executions, 0);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup terminally fails retained retry relationships that cannot execute within bounds", async () => {
  const cases = [
    {
      id: "retry-outside-domain",
      availableAt: "9999-12-31T23:59:00.000Z",
      attempts: 0,
      retry: { maxAttempts: 2, delayMs: 30_000 },
    },
    {
      id: "multi-attempt-retry-outside-domain",
      availableAt: "9999-12-31T23:58:45.000Z",
      attempts: 0,
      retry: { maxAttempts: 3, delayMs: 30_000 },
    },
    {
      id: "attempts-exhausted",
      availableAt: "2030-01-01T00:00:00.000Z",
      attempts: 1,
      retry: { maxAttempts: 1, delayMs: 0 },
    },
  ];
  for (const retained of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-job-${retained.id}-`));
    const file = path.join(dir, "data.db");
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    let executions = 0;
    const capsule = { jobs: { work: job(() => { executions += 1; return true; }) } };
    let database;
    try {
      database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
      database.adapter.prepare(
        "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
      database.adapter.prepare(
        "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory) VALUES (?, ?, ?, ?, ?, 'delayed', ?, ?, ?, ?, '[]')",
      ).run(
        retained.id,
        "work",
        auth.userId,
        auth.userId,
        "null",
        retained.availableAt,
        retained.attempts,
        clock.now().toISOString(),
        JSON.stringify(retained.retry),
      );
      await database.close();

      database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
      const row = database.adapter.prepare("SELECT status, failure, attempts FROM sporades_jobs WHERE id = ?").get(retained.id);
      assert.equal(row.status, "failed", retained.id);
      assert.equal(JSON.parse(row.failure).code, "JOB_RETRY_POLICY_INVALID", retained.id);
      assert.equal(row.attempts, retained.attempts, retained.id);
      await database.init();
      await clock.runDueTimers();
      assert.equal(executions, 0, retained.id);
    } finally {
      await Promise.resolve().then(() => database?.close()).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("concurrent workers reject retained invalid availability at the claim boundary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-claim-race-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return true; }) } };
  let first;
  let second;
  let releaseFirst = () => {};
  let releaseSecond = () => {};
  try {
    first = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    second = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    await first.init();
    await second.init();
    first.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    first.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, '[]')",
    ).run(
      "invalid-claim-race",
      "work",
      auth.userId,
      auth.userId,
      "null",
      "+010000-01-01T00:00:00.000Z",
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 1, delayMs: 0 }),
    );

    let firstReadStarted;
    let secondReadStarted;
    const firstRead = new Promise((resolve) => { firstReadStarted = resolve; });
    const secondRead = new Promise((resolve) => { secondReadStarted = resolve; });
    const firstBaseAdapter = first.adapter;
    const secondBaseAdapter = second.adapter;
    first.adapter = pauseDueJobRead(firstBaseAdapter, firstReadStarted, (release) => { releaseFirst = release; });
    second.adapter = pauseDueJobRead(secondBaseAdapter, secondReadStarted, (release) => { releaseSecond = release; });
    const firstWorker = runCurrentUserJobWorker(first);
    const secondWorker = runCurrentUserJobWorker(second);
    await Promise.all([firstRead, secondRead]);
    releaseFirst();
    releaseSecond();
    releaseFirst = () => {};
    releaseSecond = () => {};
    await Promise.all([firstWorker, secondWorker]);
    first.adapter = firstBaseAdapter;
    second.adapter = secondBaseAdapter;

    const row = first.adapter.prepare("SELECT status, failure, attempts FROM sporades_jobs WHERE id = ?").get("invalid-claim-race");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_AVAILABLE_AT_INVALID");
    assert.equal(row.attempts, 0);
    assert.equal(executions, 0);
  } finally {
    releaseFirst();
    releaseSecond();
    await Promise.all([
      Promise.resolve().then(() => first?.close()).catch(() => {}),
      Promise.resolve().then(() => second?.close()).catch(() => {}),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Postgres startup terminally fails a legacy extended-year Job", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres Job time-domain test.",
}, async () => {
  await withPostgresAdapter(async () => {});
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const serverEnv = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const config = { name: "job-time-domain-postgres", services: { database: { engine: "postgres" } } };
  const capsule = { jobs: { noop: job(() => null) } };
  let database;
  try {
    database = await openDevDatabase("unused.db", "", serverEnv, config, capsule, { serviceEnv: serverEnv, clock });
    const sql = database.adapter.dialect.sql;
    await database.adapter.prepare(sql(
      "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [payload], [status], [availableAt], [attempts], [createdAt], [retryJson], [attemptHistory]) VALUES (?, ?, ?, ?, ?, 'delayed', ?, 0, ?, ?, '[]')",
    )).run(
      "extended-year-postgres",
      "noop",
      auth.userId,
      auth.userId,
      "null",
      "+010000-01-01T00:00:00.000Z",
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 1, delayMs: 0 }),
    );
    await database.close();

    database = await openDevDatabase("unused.db", "", serverEnv, config, capsule, { serviceEnv: serverEnv, clock });
    const row = await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [status], [failure] FROM [sporades_jobs] WHERE [id] = ?",
    )).get("extended-year-postgres");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_AVAILABLE_AT_INVALID");
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
  }
});

test("Postgres claim validation wins a paused recovery race without executing invalid retained work", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Job recovery race.",
}, async () => {
  await withPostgresAdapter(async () => {});
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const serverEnv = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const config = { name: "job-time-domain-postgres-race", services: { database: { engine: "postgres" } } };
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return true; }) } };
  let workerDatabase;
  let recoveringDatabase;
  let releaseRecovery = () => {};
  try {
    workerDatabase = await openDevDatabase("worker.db", "", serverEnv, config, capsule, { serviceEnv: serverEnv, clock });
    const sql = workerDatabase.adapter.dialect.sql;
    await workerDatabase.adapter.prepare(sql(
      "INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )).run(auth.userId, clock.now().toISOString(), auth.displayName, null, null, 0, 1, auth.provider);
    await workerDatabase.adapter.prepare(sql(
      "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [payload], [status], [availableAt], [attempts], [createdAt], [retryJson], [attemptHistory]) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, '[]')",
    )).run(
      "invalid-recovery-claim-race",
      "work",
      auth.userId,
      auth.userId,
      "null",
      "+010000-01-01T00:00:00.000Z",
      clock.now().toISOString(),
      JSON.stringify({ maxAttempts: 1, delayMs: 0 }),
    );

    let recoveryScanned;
    const scanned = new Promise((resolve) => { recoveryScanned = resolve; });
    const recoveryReleased = new Promise((resolve) => { releaseRecovery = resolve; });
    const recovering = openDevDatabase("recovering.db", "", serverEnv, config, capsule, {
      serviceEnv: serverEnv,
      clock,
      jobRecoveryFault: async (point) => {
        if (point !== "after-scan") return;
        recoveryScanned();
        await recoveryReleased;
      },
    }).then((database) => { recoveringDatabase = database; return database; });
    await scanned;

    const worker = runCurrentUserJobWorker(workerDatabase);
    await worker;
    releaseRecovery();
    releaseRecovery = () => {};
    await recovering;

    const row = await workerDatabase.adapter.prepare(sql(
      "SELECT [status], [failure], [attempts] FROM [sporades_jobs] WHERE [id] = ?",
    )).get("invalid-recovery-claim-race");
    assert.equal(row.status, "failed");
    assert.equal(JSON.parse(row.failure).code, "JOB_AVAILABLE_AT_INVALID");
    assert.equal(row.attempts, 0);
    assert.equal(executions, 0);
  } finally {
    releaseRecovery();
    await Promise.all([
      Promise.resolve().then(() => recoveringDatabase?.close()).catch(() => {}),
      Promise.resolve().then(() => workerDatabase?.close()).catch(() => {}),
    ]);
  }
});

function pauseDueJobRead(adapter, onStarted, onRelease) {
  let paused = false;
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        const prepared = value.call(target, statement);
        if (paused || !/SELECT \* FROM .*sporades_jobs.*status.*queued.*availableAt/i.test(String(statement))) return prepared;
        return new Proxy(prepared, {
          get(preparedTarget, preparedProperty, preparedReceiver) {
            const method = Reflect.get(preparedTarget, preparedProperty, preparedReceiver);
            if (preparedProperty !== "get" || typeof method !== "function") return method;
            return async (...args) => {
              const result = await method.apply(preparedTarget, args);
              paused = true;
              onStarted();
              await new Promise((resolve) => onRelease(resolve));
              return result;
            };
          },
        });
      };
    },
  });
}
