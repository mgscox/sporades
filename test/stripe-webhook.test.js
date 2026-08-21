import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Stripe from "stripe";
import { createControllableRuntimeClock, inspectRuntimeJobs, listDatabaseTables, openDevDatabase, recoverExpiredJobLeases, routeEndpoint, runAtomicStripeConsequence, runCurrentUserJobWorker, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { endpoint, job, mutation, query, String as Text, stripeEvent as declareStripeEvent, table } from "../dist/server.js";
import * as publicServerApi from "../dist/server.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

const webhookSecret = "whsec_runtime_fixture";
const serverEnv = {
  STRIPE_SECRET_KEY: "sk_test_runtime_fixture",
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  MAILJET_WEBHOOK_SECRET: "mailjet-runtime-fixture",
};
const stripe = {
  enabled: true,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://payments.example.test",
  callbackPath: "/stripe/webhook",
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
};
const anonymousAuth = { userId: "stripe-test-operator", displayName: "Stripe test operator", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };

function responseCapture() {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  return {
    status: null,
    headers: null,
    body: "",
    finished,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += String(body); finish(); },
  };
}

function stripeEvent(id = "evt_runtime_1", options = {}) {
  const created = options.created ?? Math.floor(Date.now() / 1000);
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created,
    data: { object: { id: "cs_test_runtime_1", object: "checkout.session" } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: options.type ?? "checkout.session.completed",
  });
}

async function postStripe(database, body, signature = null) {
  const stripeSignature = signature === false
    ? undefined
    : signature === null
    ? Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret })
    : signature;
  const request = Object.assign(Readable.from([body]), {
    method: "POST",
    url: "/stripe/webhook",
    headers: { "content-type": "application/json", ...(stripeSignature === undefined ? {} : { "stripe-signature": stripeSignature }) },
  });
  const response = responseCapture();
  const handled = await routeEndpoint(database, request, response);
  if (handled) await response.finished;
  return { handled, response };
}

async function withDatabase(config, capsule, run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-webhook-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, config, capsule, { createStripeCallbackEndpoint, ...options });
  try { return await run(database); }
  finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
}

async function waitForJob(database, jobId, expectedStatus, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = (await inspectRuntimeJobs(database.adapter)).find((candidate) => candidate.id === jobId);
    if (state?.status === expectedStatus) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Job ${jobId} did not reach ${expectedStatus}`);
}

async function stripeJobAuditEvents(database, jobId) {
  return (await database.adapter.readRecentLogEvents(200))
    .filter((event) => event.category === "audit" && event.data?.operation === "jobs.execute" && event.data?.metadata?.jobId === jobId);
}

async function withTimeout(promise, message, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("enabled Stripe acknowledges only after admitting one durable Privileged Job", async () => {
  await withDatabase({ name: "stripe-admission", payments: { stripe } }, {}, async (database) => {
    const body = stripeEvent();
    const result = await postStripe(database, body);
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 200);
    const acknowledgement = JSON.parse(result.response.body);
    assert.equal(acknowledgement.ok, true);
    assert.match(acknowledgement.jobId, /^[0-9a-f-]{36}$/);

    const [jobState] = await inspectRuntimeJobs(database.adapter);
    assert.equal(jobState.id, acknowledgement.jobId);
    assert.equal(jobState.handler, "_sporades.stripe-event");
    assert.deepEqual(jobState.actor, { mode: "privileged-server-role" });
    assert.equal(jobState.idempotencyKeyPresent, true);
    assert.equal("payload" in jobState, false);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_users]").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_sessions]").get().count, 0);
  });
});

test("Stripe callback admission rollback cannot acknowledge or leave a Job", async () => {
  const boundaries = [];
  await withDatabase(
    { name: "stripe-rollback", payments: { stripe } },
    {},
    async (database) => {
      const result = await postStripe(database, stripeEvent("evt_runtime_rollback_1"));
      assert.equal(result.response.status, 500);
      assert.doesNotMatch(result.response.body, /injected|evt_runtime_rollback|whsec_|stripe-signature/i);
      assert.equal(boundaries.length, 1);
      assert.equal(boundaries[0].providerEventId, "evt_runtime_rollback_1");
      assert.deepEqual(await inspectRuntimeJobs(database.adapter), []);
      assert.doesNotMatch(JSON.stringify(await database.adapter.readRecentLogEvents(100)), /evt_runtime_rollback|whsec_|stripe-signature|v1=/i);
    },
    {
      stripeCallbackAdmissionFault(boundary, details) {
        assert.equal(boundary, "after-enqueue");
        boundaries.push(details);
        throw new Error("injected callback admission rollback");
      },
    },
  );
});

test("Stripe retries and concurrent duplicates acknowledge one durable Job", async () => {
  await withDatabase({ name: "stripe-duplicates", payments: { stripe } }, {}, async (database) => {
    const body = stripeEvent("evt_runtime_duplicate_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
    const results = await Promise.all([
      postStripe(database, body, signature),
      postStripe(database, body, signature),
      postStripe(database, body, signature),
    ]);
    assert.deepEqual(results.map(({ response }) => response.status), [200, 200, 200]);
    const ids = results.map(({ response }) => JSON.parse(response.body).jobId);
    assert.equal(new Set(ids).size, 1);
    assert.equal((await inspectRuntimeJobs(database.adapter)).length, 1);
  });
});

test("Stripe retries retain one durable Job after the Capsule config name changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-rename-"));
  const databasePath = path.join(dir, "data.db");
  const body = stripeEvent("evt_runtime_rename_1");
  let firstDatabase;
  let renamedDatabase;
  try {
    firstDatabase = await openDevDatabase(databasePath, "", serverEnv, {
      name: "stripe-before-rename",
      payments: { stripe },
    }, {}, { createStripeCallbackEndpoint });
    const first = await postStripe(firstDatabase, body);
    assert.equal(first.response.status, 200);
    const firstJobId = JSON.parse(first.response.body).jobId;
    await firstDatabase.close();
    firstDatabase = null;

    renamedDatabase = await openDevDatabase(databasePath, "", serverEnv, {
      name: "stripe-after-rename",
      payments: { stripe },
    }, {}, { createStripeCallbackEndpoint });
    const repeated = await postStripe(renamedDatabase, body);
    assert.equal(repeated.response.status, 200);
    assert.equal(JSON.parse(repeated.response.body).jobId, firstJobId);
    assert.equal((await inspectRuntimeJobs(renamedDatabase.adapter)).length, 1);
  } finally {
    await firstDatabase?.close();
    await renamedDatabase?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent Stripe delivery across Postgres runtimes converges on one Job", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-postgres-"));
  const config = {
    name: "stripe-postgres-duplicates",
    payments: { stripe },
    services: { database: { engine: "postgres" } },
  };
  const env = {
    ...serverEnv,
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  let firstDatabase;
  let secondDatabase;
  try {
    await withPostgresAdapter(async () => {});
    const initializer = await openDevDatabase(path.join(dir, "initializer.db"), "", env, config, {}, { createStripeCallbackEndpoint });
    await initializer.close();
    firstDatabase = await openDevDatabase(path.join(dir, "first.db"), "", env, config, {}, { createStripeCallbackEndpoint });
    secondDatabase = await openDevDatabase(path.join(dir, "second.db"), "", env, config, {}, { createStripeCallbackEndpoint });
    const body = stripeEvent("evt_runtime_postgres_duplicate_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
    const [first, second] = await Promise.all([
      postStripe(firstDatabase, body, signature),
      postStripe(secondDatabase, body, signature),
    ]);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(JSON.parse(first.response.body).jobId, JSON.parse(second.response.body).jobId);
    assert.equal((await inspectRuntimeJobs(firstDatabase.adapter)).length, 1);
  } finally {
    await Promise.all([firstDatabase?.close(), secondDatabase?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stripe callback rejection is exact-byte sensitive, opaque, and non-durable", async () => {
  await withDatabase({ name: "stripe-rejection", payments: { stripe } }, {}, async (database) => {
    const body = stripeEvent("evt_runtime_rejected_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
    for (const [candidateBody, candidateSignature] of [
      [` ${body}`, signature],
      [body, false],
      ["not-json", Stripe.webhooks.generateTestHeaderString({ payload: "not-json", secret: webhookSecret })],
    ]) {
      const result = await postStripe(database, candidateBody, candidateSignature);
      assert.equal(result.response.status, 400);
      assert.deepEqual(JSON.parse(result.response.body), { ok: false });
    }
    assert.deepEqual(await inspectRuntimeJobs(database.adapter), []);
    const logs = await database.adapter.readRecentLogEvents(100);
    assert.doesNotMatch(JSON.stringify(logs), /evt_runtime_rejected|whsec_|stripe-signature|v1=/i);
  });
});

test("disabled Stripe has no callback route and enabled provider routes cannot collide", async () => {
  await withDatabase({ name: "stripe-disabled", payments: { stripe: { enabled: false } } }, {}, async (database) => {
    assert.equal((await postStripe(database, "{}", false)).handled, false);
  });

  const collision = { endpoints: { stripe: endpoint({ method: "POST", path: "/stripe/webhook" }, () => null) } };
  await assert.rejects(
    withDatabase({ name: "stripe-collision", payments: { stripe } }, collision, async () => {}),
    (error) => error.code === "STRIPE_CALLBACK_ROUTE_CONFLICT",
  );
  await assert.rejects(
    withDatabase({
      name: "stripe-provider-collision",
      payments: { stripe },
      mail: { webhooks: { mailjet: { path: "/stripe/webhook", secretEnv: "MAILJET_WEBHOOK_SECRET" } } },
    }, {}, async () => {}),
    (error) => error.code === "STRIPE_CALLBACK_ROUTE_CONFLICT",
  );
});

test("Capsule and Privileged server code cannot forge the runtime-owned Stripe Event Job", async () => {
  const capsule = {
    endpoints: {
      forge: endpoint({ method: "POST", path: "/forge-stripe-event" }, async (ctx) => {
        if (ctx.request.query.privileged === "true") {
          return await ctx.privileged.run(
            { operation: "test.forge-stripe", targetResourceKind: "job-queue" },
            (privilegedCtx) => privilegedCtx.jobs.enqueue("_sporades.stripe-event", { providerEventId: "evt_forged" }),
          );
        }
        return await ctx.jobs.enqueue("_sporades.stripe-event", { providerEventId: "evt_forged" });
      }),
    },
  };
  await withDatabase({ name: "stripe-forgery", payments: { stripe: { enabled: false } } }, capsule, async (database) => {
    for (const url of ["/forge-stripe-event", "/forge-stripe-event?privileged=true"]) {
      const request = Object.assign(Readable.from([]), { method: "POST", url, headers: {} });
      const response = responseCapture();
      assert.equal(await routeEndpoint(database, request, response), true);
      await response.finished;
      assert.equal(response.status, 500);
    }
    assert.deepEqual(await inspectRuntimeJobs(database.adapter), []);
  });
});

test("the Stripe callback capability cannot enqueue another runtime-owned Job", async () => {
  await withDatabase(
    { name: "stripe-callback-authority", payments: { stripe } },
    {},
    async (database) => {
      const result = await postStripe(database, stripeEvent("evt_runtime_wrong_handler_1"));
      assert.equal(result.response.status, 500);
      assert.deepEqual(await inspectRuntimeJobs(database.adapter), []);
    },
    {
      createStripeCallbackEndpoint() {
        return {
          name: "__sporades_stripe_events",
          runtimeOwnedStripeCallback: true,
          method: "POST",
          path: stripe.callbackPath,
          handler: (ctx) => ctx.jobs.enqueue("_sporades.password-reset-mail", { providerEventId: "evt_forged" }),
        };
      },
    },
  );
});

test("an admitted Stripe Event is delivered once through its durable Privileged Job", async () => {
  let handlerStarted;
  let releaseHandler;
  let leakedJobs;
  let leakedTeams;
  const began = new Promise((resolve) => { handlerStarted = resolve; });
  const release = new Promise((resolve) => { releaseHandler = resolve; });
  const seen = [];
  const capsule = {
    stripeEvents: declareStripeEvent(async (ctx, event) => {
      seen.push({ auth: ctx.auth, event });
      leakedJobs = ctx.jobs;
      leakedTeams = ctx.teams;
      assert.equal(typeof ctx.request, "undefined");
      assert.equal(typeof ctx.teams.list, "undefined");
      assert.equal(Object.isFrozen(event), true);
      assert.equal(Object.isFrozen(event.raw), true);
      assert.equal(Object.isFrozen(event.raw.data), true);
      assert.equal(Object.isFrozen(event.raw.data.object), true);
      handlerStarted();
      await release;
    }),
  };

  await withDatabase({ name: "stripe-delivery", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const body = stripeEvent("evt_runtime_delivered_1");
    const expectedRaw = JSON.parse(body);
    const admission = await postStripe(database, body);
    assert.equal(admission.response.status, 200, "callback acknowledgement must not wait for Capsule consequences");
    const jobId = JSON.parse(admission.response.body).jobId;
    await withTimeout(began, "Stripe event handler did not start");
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((job) => job.id === jobId)?.status, "running");
    releaseHandler();
    const completed = await waitForJob(database, jobId, "succeeded");
    assert.equal(completed.attempts, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].auth, {
      userId: "__privileged__",
      displayName: "Privileged server role",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: false,
      provider: "privileged-server-role",
    });
    assert.deepEqual(seen[0].event, {
      provider: "stripe",
      providerEventId: expectedRaw.id,
      type: expectedRaw.type,
      occurredAt: new Date(expectedRaw.created * 1_000).toISOString(),
      livemode: false,
      objectId: expectedRaw.data.object.id,
      raw: expectedRaw,
    });
    await assert.rejects(() => leakedJobs.list(), (error) => error.code === "PRIVILEGED_JOB_ACCESS_INACTIVE");
    await assert.rejects(() => leakedTeams.countMembers("00000000-0000-4000-8000-000000000000"), (error) => error.code === "PRIVILEGED_TEAM_ACCESS_INACTIVE");

    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.equal(auditEvents.every((event) => !("providerEventId" in event.data.metadata)), true);
    const outcomes = auditEvents.map((event) => event.data.outcome);
    assert.deepEqual(outcomes, ["started", "completed", "finished"]);
  });
});

test("Stripe event handler failure retries under the same durable Job identity", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let attempts = 0;
  const capsule = {
    stripeEvents: declareStripeEvent((_ctx, event) => {
      attempts += 1;
      if (attempts === 1) throw new Error(`transient delivery failure for ${event.providerEventId}`);
    }),
  };
  await withDatabase({ name: "stripe-delivery-retry", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const admission = await postStripe(database, stripeEvent("evt_runtime_retry_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    await clock.runDueTimers();
    let [job] = await inspectRuntimeJobs(database.adapter);
    assert.equal(job.id, jobId);
    assert.equal(job.status, "delayed");
    assert.equal(job.attempts, 1);
    clock.advanceBy(1_001);
    await clock.runDueTimers();
    [job] = await inspectRuntimeJobs(database.adapter);
    assert.equal(job.id, jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 2);
    assert.equal(attempts, 2);
    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.equal(auditEvents.every((event) => !("providerEventId" in event.data.metadata)), true);
    assert.deepEqual(auditEvents.map((event) => event.data.outcome), ["started", "errored", "finished", "started", "completed", "finished"]);
  }, { clock });
});

test("Stripe event handler exhaustion becomes one bounded terminal Job failure", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let attempts = 0;
  const capsule = {
    stripeEvents: declareStripeEvent(() => {
      attempts += 1;
      throw new Error("raw-provider-marker obj_terminal_secret must stay private");
    }),
  };
  await withDatabase({ name: "stripe-delivery-terminal", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const admission = await postStripe(database, stripeEvent("evt_runtime_terminal_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    await clock.runDueTimers();
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      clock.advanceBy(1_001);
      await clock.runDueTimers();
    }
    const [job] = await inspectRuntimeJobs(database.adapter);
    assert.equal(job.id, jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 5);
    assert.equal(attempts, 5);
    assert.deepEqual(job.failure, { code: "JOB_FAILED", message: "Job handler failed." });
    assert.doesNotMatch(JSON.stringify(job), /obj_terminal_secret|raw-provider-marker/);
    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.equal(auditEvents.every((event) => !("providerEventId" in event.data.metadata)), true);
    assert.deepEqual(auditEvents.map((event) => event.data.outcome), Array.from({ length: 5 }, () => ["started", "errored", "finished"]).flat());
  }, { clock });
});

test("cancelling a running Stripe event Job aborts and revokes its Privileged handler", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let handlerStarted;
  let activeSignal;
  let leakedJobs;
  const began = new Promise((resolve) => { handlerStarted = resolve; });
  const capsule = {
    stripeEvents: declareStripeEvent(async (ctx) => {
      activeSignal = ctx.signal;
      leakedJobs = ctx.jobs;
      handlerStarted();
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => {
        const error = new Error("Stripe event Job cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    }),
    mutations: {
      cancelStripeEvent: mutation((ctx, jobId) => ctx.privileged.run(
        { operation: "stripe-events.cancel", targetResourceKind: "job-queue" },
        (privilegedCtx) => privilegedCtx.jobs.cancel(jobId),
      )),
    },
  };
  await withDatabase({ name: "stripe-delivery-cancel", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const admission = await postStripe(database, stripeEvent("evt_runtime_cancel_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    const draining = clock.runDueTimers();
    await began;
    const cancelled = await runMutation(database, anonymousAuth, "cancelStripeEvent", [jobId]);
    assert.equal(cancelled.ok, true);
    assert.equal(activeSignal.aborted, true);
    await draining;
    const [job] = await inspectRuntimeJobs(database.adapter);
    assert.equal(job.id, jobId);
    assert.equal(job.status, "cancelled");
    assert.equal(job.attempts, 1);
    await assert.rejects(() => leakedJobs.list(), (error) => error.code === "PRIVILEGED_JOB_ACCESS_INACTIVE");
    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.equal(auditEvents.every((event) => !("providerEventId" in event.data.metadata)), true);
    assert.deepEqual(auditEvents.map((event) => event.data.outcome), ["started", "errored", "finished"]);
  }, { clock });
});

test("a completed Stripe Event remains one successful processing across provider retries", async () => {
  let processed = 0;
  const capsule = { stripeEvents: declareStripeEvent(() => { processed += 1; }) };
  await withDatabase({ name: "stripe-delivery-completed-duplicate", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const body = stripeEvent("evt_runtime_completed_duplicate_1");
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
    const first = await postStripe(database, body, signature);
    const firstId = JSON.parse(first.response.body).jobId;
    await waitForJob(database, firstId, "succeeded");
    const second = await postStripe(database, body, signature);
    const secondId = JSON.parse(second.response.body).jobId;
    assert.equal(secondId, firstId);
    assert.equal(processed, 1);
    const matching = (await inspectRuntimeJobs(database.adapter)).filter((job) => job.id === firstId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].attempts, 1);
  });
});

test("Capsule Stripe policy can reject a later-arriving older provider observation", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const applied = [];
  let latestOccurredAt = null;
  const capsule = {
    stripeEvents: declareStripeEvent((_ctx, event) => {
      if (latestOccurredAt !== null && event.occurredAt <= latestOccurredAt) return;
      latestOccurredAt = event.occurredAt;
      applied.push(event.providerEventId);
    }),
  };
  await withDatabase({ name: "stripe-delivery-order", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const providerNow = Math.floor(Date.now() / 1_000);
    const newer = await postStripe(database, stripeEvent("evt_runtime_newer_1", { created: providerNow }));
    await clock.runDueTimers();
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((job) => job.id === JSON.parse(newer.response.body).jobId)?.status, "succeeded");
    const older = await postStripe(database, stripeEvent("evt_runtime_older_1", { created: providerNow - 60 }));
    await clock.runDueTimers();
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((job) => job.id === JSON.parse(older.response.body).jobId)?.status, "succeeded");
    assert.deepEqual(applied, ["evt_runtime_newer_1"]);
  }, { clock });
});

test("unknown verified Stripe event types may be ignored successfully by Capsule policy", async () => {
  const ignored = [];
  const capsule = {
    stripeEvents: declareStripeEvent((_ctx, event) => {
      switch (event.type) {
        case "checkout.session.completed":
          throw new Error("the unknown-event fixture reached the wrong branch");
        default:
          ignored.push(event.type);
      }
    }),
  };
  await withDatabase({ name: "stripe-delivery-unknown", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const admission = await postStripe(database, stripeEvent("evt_runtime_unknown_1", { type: "future.resource.changed" }));
    const job = await waitForJob(database, JSON.parse(admission.response.body).jobId, "succeeded");
    assert.equal(job.attempts, 1);
    assert.deepEqual(ignored, ["future.resource.changed"]);
  });
});

test("Stripe delivery without Capsule policy creates no automatic app persistence or raw history", async () => {
  await withDatabase({ name: "stripe-delivery-no-policy", payments: { stripe } }, {}, async (database) => {
    await database.init();
    const tablesBefore = await listDatabaseTables(database);
    const body = stripeEvent("evt_runtime_no_policy_1", { type: "future.resource.changed" });
    const admission = await postStripe(database, body);
    const job = await waitForJob(database, JSON.parse(admission.response.body).jobId, "succeeded");
    assert.deepEqual(await listDatabaseTables(database), tablesBefore);
    assert.equal("payload" in job, false);
    assert.equal(job.result, null);
    assert.doesNotMatch(JSON.stringify(job), /evt_runtime_no_policy_1|pending_webhooks|checkout\.session/);
  });
});

test("Stripe event policy writes through the ordinary Capsule Database adapter", async () => {
  const capsule = {
    schema: {
      stripeObservations: table({ providerEventId: Text(), occurredAt: Text() }),
    },
    stripeEvents: declareStripeEvent((ctx, event) => ctx.db.stripeObservations.insert({
      providerEventId: event.providerEventId,
      occurredAt: event.occurredAt,
    })),
    queries: {
      stripeObservations: query((ctx) => ctx.db.stripeObservations.all()),
    },
  };
  await withDatabase({ name: "stripe-delivery-app-state", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const body = stripeEvent("evt_runtime_app_state_1");
    const expectedOccurredAt = new Date(JSON.parse(body).created * 1_000).toISOString();
    const admission = await postStripe(database, body);
    await waitForJob(database, JSON.parse(admission.response.body).jobId, "succeeded");
    const observed = await runQuery(database, anonymousAuth, "stripeObservations");
    assert.equal(observed.error, null);
    assert.deepEqual(observed.data.map(({ providerEventId, occurredAt }) => ({ providerEventId, occurredAt })), [{
      providerEventId: "evt_runtime_app_state_1",
      occurredAt: expectedOccurredAt,
    }]);
  });
});

test("an opt-in atomic Stripe consequence commits or rolls back all app writes", async () => {
  assert.throws(
    () => declareStripeEvent({ consequence: "atomic", extra: true }, () => {}),
    (error) => error.code === "INVALID_STRIPE_EVENT_DECLARATION",
  );
  assert.throws(
    () => declareStripeEvent({ consequence: "atomic" }),
    (error) => error.code === "INVALID_STRIPE_EVENT_DECLARATION",
  );
  let shouldFail = true;
  const leakedDatabases = [];
  const leakedQueryBuilders = [];
  const leakedJobs = [];
  const definition = declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
    assert.equal(ctx.auth.userId, "__privileged__");
    assert.equal(typeof ctx.payments, "undefined");
    assert.equal(typeof ctx.mail, "undefined");
    assert.equal(typeof ctx.files, "undefined");
    assert.equal(typeof ctx.messages, "undefined");
    assert.equal(typeof ctx.serverAuth, "undefined");
    assert.equal(typeof ctx.schedules, "undefined");
    assert.equal(typeof ctx.accessKeys, "undefined");
    assert.equal(typeof ctx.privileged, "undefined");
    leakedDatabases.push(ctx.db);
    leakedQueryBuilders.push(ctx.db.stripeObservations.where("providerEventId", event.providerEventId));
    leakedJobs.push(ctx.jobs);
    await ctx.db.stripeObservations.insert({
      providerEventId: event.providerEventId,
      occurredAt: event.occurredAt,
    });
    await ctx.db.stripeConsequences.insert({ providerEventId: event.providerEventId });
    await ctx.jobs.enqueue("recordConsequence", { providerEventId: event.providerEventId }, {
      idempotencyKey: event.providerEventId,
    });
    if (shouldFail) throw new Error("injected atomic consequence failure");
  });
  assert.deepEqual(definition.options, { consequence: "atomic" });
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.options), true);

  const capsule = {
    schema: {
      stripeObservations: table({ providerEventId: Text(), occurredAt: Text() }),
      stripeConsequences: table({ providerEventId: Text() }),
    },
    stripeEvents: definition,
    jobs: {
      recordConsequence: job(() => ({ recorded: true })),
    },
    queries: {
      observations: query((ctx) => ctx.db.stripeObservations.all()),
      consequences: query((ctx) => ctx.db.stripeConsequences.all()),
    },
  };
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  await withDatabase({ name: "stripe-atomic-consequence", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const body = stripeEvent("evt_runtime_atomic_1");
    const admission = await postStripe(database, body);
    const jobId = JSON.parse(admission.response.body).jobId;
    await clock.runDueTimers();
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((job) => job.id === jobId)?.status, "delayed");
    assert.deepEqual((await runQuery(database, anonymousAuth, "observations")).data, []);
    assert.deepEqual((await runQuery(database, anonymousAuth, "consequences")).data, []);
    assert.equal((await inspectRuntimeJobs(database.adapter)).filter((jobState) => jobState.handler === "recordConsequence").length, 0);
    assert.throws(() => leakedDatabases[0].stripeObservations.all(), /no longer active/);
    assert.throws(() => leakedQueryBuilders[0].all(), /no longer active/);
    await assert.rejects(() => leakedJobs[0].enqueue("recordConsequence", {}));

    shouldFail = false;
    clock.advanceBy(1_001);
    await clock.runDueTimers();
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((job) => job.id === jobId)?.status, "succeeded");
    assert.equal((await runQuery(database, anonymousAuth, "observations")).data.length, 1);
    assert.equal((await runQuery(database, anonymousAuth, "consequences")).data.length, 1);
    assert.equal((await inspectRuntimeJobs(database.adapter)).filter((jobState) => jobState.handler === "recordConsequence").length, 1);
    assert.throws(() => leakedDatabases[1].stripeObservations.all(), /no longer active/);
    assert.throws(() => leakedQueryBuilders[1].all(), /no longer active/);
    await assert.rejects(() => leakedJobs[1].enqueue("recordConsequence", {}));
    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.deepEqual(auditEvents.map((event) => event.data.outcome), [
      "started", "errored", "finished",
      "started", "completed", "finished",
    ]);
  }, { clock });
});

test("a rejected transaction-bound log write rolls back an atomic Stripe consequence", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const capsule = {
    schema: { stripeConsequences: table({ providerEventId: Text() }) },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      await ctx.db.stripeConsequences.insert({ providerEventId: event.providerEventId });
      ctx.log.info("atomic consequence must index transactionally", { providerEventId: event.providerEventId });
    }),
    queries: { consequences: query((ctx) => ctx.db.stripeConsequences.all()) },
  };
  await withDatabase({ name: "stripe-atomic-log-rollback", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const rootAdapter = database.adapter;
    const insertLogIndexEvent = rootAdapter.insertLogIndexEvent;
    rootAdapter.insertLogIndexEvent = function (event) {
      if (this !== rootAdapter && event.category === "app") return Promise.reject(new Error("injected transaction log failure"));
      return Reflect.apply(insertLogIndexEvent, this, [event]);
    };
    const admission = await postStripe(database, stripeEvent("evt_runtime_atomic_log_failure_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    await clock.runDueTimers();
    assert.deepEqual((await runQuery(database, anonymousAuth, "consequences")).data, []);
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === jobId)?.status, "delayed");
    const auditEvents = await stripeJobAuditEvents(database, jobId);
    assert.deepEqual(auditEvents.map((event) => event.data.outcome), ["started", "errored", "finished"]);
  }, { clock });
});

test("a post-commit dispatch failure leaves an atomic consequence and its enqueued Job recoverable", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const setTimer = clock.setTimer.bind(clock);
  let failNextDispatch = false;
  let processed = 0;
  clock.setTimer = (callback, delayMs) => {
    if (failNextDispatch && delayMs === 0) {
      failNextDispatch = false;
      throw new Error("injected post-commit worker dispatch failure");
    }
    return setTimer(callback, delayMs);
  };
  const capsule = {
    schema: { stripeConsequences: table({ providerEventId: Text() }) },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      await ctx.db.stripeConsequences.insert({ providerEventId: event.providerEventId });
      await ctx.jobs.enqueue("recordConsequence", { providerEventId: event.providerEventId }, { idempotencyKey: event.providerEventId });
      failNextDispatch = true;
    }),
    jobs: { recordConsequence: job(() => { processed += 1; }) },
    queries: { consequences: query((ctx) => ctx.db.stripeConsequences.all()) },
  };
  await withDatabase({ name: "stripe-atomic-dispatch-recovery", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    await clock.runDueTimers();
    const providerEventId = "evt_runtime_atomic_dispatch_recovery_1";
    await runAtomicStripeConsequence(database, {
      auth: Object.freeze({ userId: "__privileged__", displayName: "Privileged server role", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "privileged-server-role" }),
      signal: new AbortController().signal,
      __jobEnqueuedBy: "__privileged__",
    }, {
      provider: "stripe", providerEventId, type: "customer.subscription.updated",
      occurredAt: "2030-01-01T00:00:00.000Z", livemode: false, objectId: "sub_atomic_dispatch_recovery",
      raw: { id: providerEventId, type: "customer.subscription.updated", data: { object: { id: "sub_atomic_dispatch_recovery" } } },
    }, capsule.stripeEvents);
    const jobsAfterDispatchFailure = await inspectRuntimeJobs(database.adapter);
    assert.equal(jobsAfterDispatchFailure.find((jobState) => jobState.handler === "recordConsequence")?.status, "queued");
    assert.equal((await runQuery(database, anonymousAuth, "consequences")).data.length, 1);
    assert.equal(processed, 0);

    await runCurrentUserJobWorker(database);
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.handler === "recordConsequence")?.status, "succeeded");
    assert.equal(processed, 1);
  }, { clock });
});

test("a reserved Job retries safely when settlement fails after its atomic consequence commits", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let businessChanges = 0;
  const capsule = {
    schema: { stripeConsequences: table({ providerEventId: Text() }).unique("providerEventId") },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      const existing = await ctx.db.stripeConsequences.where("providerEventId", event.providerEventId).get();
      if (existing) return;
      await ctx.db.stripeConsequences.insert({ providerEventId: event.providerEventId });
      businessChanges += 1;
    }),
    queries: { consequences: query((ctx) => ctx.db.stripeConsequences.all()) },
  };
  await withDatabase({ name: "stripe-atomic-settlement-retry", payments: { stripe } }, capsule, async (database) => {
    await database.init();
    const rootAdapter = database.adapter;
    const prepare = rootAdapter.prepare;
    let failNextSuccessSettlement = true;
    rootAdapter.prepare = function (sql) {
      const statement = Reflect.apply(prepare, this, [sql]);
      if (!failNextSuccessSettlement || !/UPDATE .*sporades_jobs.*SET .*status.*succeeded/is.test(String(sql))) return statement;
      const wrapped = Object.create(statement);
      wrapped.run = (...args) => {
        failNextSuccessSettlement = false;
        throw new Error("injected post-commit Stripe Job settlement failure");
      };
      return wrapped;
    };
    const admission = await postStripe(database, stripeEvent("evt_runtime_atomic_settlement_retry_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    await clock.runDueTimers();
    let state = (await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === jobId);
    assert.equal(state.status, "delayed");
    assert.equal(state.attempts, 1);
    assert.equal((await runQuery(database, anonymousAuth, "consequences")).data.length, 1);
    assert.equal(businessChanges, 1);

    clock.advanceBy(1_001);
    await clock.runDueTimers();
    state = (await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === jobId);
    assert.equal(state.status, "succeeded");
    assert.equal(state.attempts, 2);
    assert.equal((await runQuery(database, anonymousAuth, "consequences")).data.length, 1);
    assert.equal(businessChanges, 1);
  }, { clock });
});

test("cancelling a non-cooperative atomic Stripe handler rolls back and releases the Postgres fence", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let firstEntered;
  let releaseFirst;
  const began = new Promise((resolve) => { firstEntered = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let block = true;
  let leakedDatabase;
  const capsule = {
    schema: { stripeConsequences: table({ providerEventId: Text() }) },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      leakedDatabase = ctx.db;
      await ctx.db.stripeConsequences.insert({ providerEventId: event.providerEventId });
      if (block) {
        firstEntered();
        await firstRelease;
      }
    }),
    mutations: {
      cancelStripeEvent: mutation((ctx, jobId) => ctx.privileged.run(
        { operation: "stripe-events.cancel-atomic", targetResourceKind: "job-queue" },
        (privilegedCtx) => privilegedCtx.jobs.cancel(jobId),
      )),
    },
    queries: { consequences: query((ctx) => ctx.db.stripeConsequences.all()) },
  };
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-cancel-postgres-"));
  await withPostgresAdapter(async () => {}, { appTableNames: ["stripeConsequences"] });
  const serviceEnv = {
    ...serverEnv,
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const database = await openDevDatabase(path.join(dir, "unused.db"), "", serviceEnv, {
    name: "stripe-atomic-non-cooperative-cancel",
    payments: { stripe },
    services: { database: { engine: "postgres" } },
  }, capsule, { createStripeCallbackEndpoint, clock, serviceEnv });
  try {
    await database.init();
    const admission = await postStripe(database, stripeEvent("evt_runtime_atomic_cancel_1"));
    const firstJobId = JSON.parse(admission.response.body).jobId;
    const draining = clock.runDueTimers();
    await began;
    const cancellation = runMutation(database, anonymousAuth, "cancelStripeEvent", [firstJobId]);
    clock.advanceBy(30_001);
    await clock.runDueTimers();
    const cancellationOutcome = await Promise.race([cancellation.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500))]);
    releaseFirst();
    const cancelled = await cancellation;
    assert.equal(cancellationOutcome, "settled", "atomic Stripe cancellation did not settle while the handler ignored AbortSignal");
    assert.equal(cancelled.ok, true);
    await withTimeout(draining, "non-cooperative atomic Stripe handler retained the fence", 500);
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === firstJobId)?.status, "cancelled");
    assert.deepEqual((await runQuery(database, anonymousAuth, "consequences")).data, []);
    assert.throws(() => leakedDatabase.stripeConsequences.all(), /no longer active/);

    block = false;
    const successor = await postStripe(database, stripeEvent("evt_runtime_atomic_cancel_successor_1"));
    const successorJobId = JSON.parse(successor.response.body).jobId;
    await clock.runDueTimers();
    assert.equal((await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === successorJobId)?.status, "succeeded");
    assert.deepEqual((await runQuery(database, anonymousAuth, "consequences")).data.map((row) => row.providerEventId), ["evt_runtime_atomic_cancel_successor_1"]);
  } finally {
    releaseFirst();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the runtime rejects forged atomic Stripe-event definitions", async () => {
  assert.equal("recoverExpiredJobLeases" in publicServerApi, false, "lease recovery must remain outside sporades/server");
  for (const stripeEvents of [
    { kind: "stripeEvent", options: { consequence: "atomic" }, handler() {} },
    { kind: "stripeEvent", options: { consequence: "atomic", extra: true }, handler() {} },
    { kind: "stripeEvent", options: { consequence: "eventual" }, handler() {} },
    { kind: "stripeEvent", options: { consequence: "atomic" }, handler: null },
  ]) {
    await assert.rejects(
      withDatabase({ name: "stripe-forged-atomic", payments: { stripe } }, { stripeEvents }, async () => {}),
      (error) => error.code === "INVALID_STRIPE_EVENT_DECLARATION",
    );
  }
});

async function proveAtomicStripeConsequenceSerialization(openRuntimes, leadingRuntime = "first") {
  const firstClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const secondClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let firstEntered;
  let releaseFirst;
  let secondEntered;
  const firstBegan = new Promise((resolve) => { firstEntered = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const secondBegan = new Promise((resolve) => { secondEntered = resolve; });
  let active = 0;
  let maximumActive = 0;
  const observedPredecessors = [];
  const capsule = {
    schema: {
      stripeSequence: table({ providerEventId: Text(), predecessorCount: Text() }),
    },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        const prior = await ctx.db.stripeSequence.all();
        observedPredecessors.push({ providerEventId: event.providerEventId, count: prior.length });
        if (event.providerEventId.endsWith("_leader")) {
          firstEntered();
          await firstRelease;
        } else {
          secondEntered();
        }
        await ctx.db.stripeSequence.insert({
          providerEventId: event.providerEventId,
          predecessorCount: String(prior.length),
        });
      } finally {
        active -= 1;
      }
    }),
  };
  let runtimes;
  try {
    runtimes = await openRuntimes(capsule, firstClock, secondClock);
    const { firstDatabase, secondDatabase } = runtimes;
    await firstDatabase.init();
    await secondDatabase.init();
    const parentContext = () => ({
      auth: Object.freeze({ userId: "__privileged__", displayName: "Privileged server role", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "privileged-server-role" }),
      signal: new AbortController().signal,
      __jobEnqueuedBy: "__privileged__",
    });
    const event = (providerEventId) => ({
      provider: "stripe",
      providerEventId,
      type: "customer.subscription.updated",
      occurredAt: "2030-01-01T00:00:00.000Z",
      livemode: false,
      objectId: "sub_atomic_serialization",
      raw: { id: providerEventId, type: "customer.subscription.updated", data: { object: { id: "sub_atomic_serialization" } } },
    });

    const leadingDatabase = leadingRuntime === "second" ? secondDatabase : firstDatabase;
    const followingDatabase = leadingRuntime === "second" ? firstDatabase : secondDatabase;
    const schedule = leadingRuntime === "second" ? "reverse" : "forward";
    const leaderId = `evt_runtime_atomic_serial_${schedule}_leader`;
    const followerId = `evt_runtime_atomic_serial_${schedule}_follower`;
    const firstRun = runAtomicStripeConsequence(leadingDatabase, parentContext(), event(leaderId), capsule.stripeEvents);
    await withTimeout(firstBegan, "first atomic consequence did not enter");
    const secondRun = runAtomicStripeConsequence(followingDatabase, parentContext(), event(followerId), capsule.stripeEvents);
    await assert.rejects(withTimeout(secondBegan, "second atomic consequence remained fenced", 50), /remained fenced/);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(observedPredecessors, [
      { providerEventId: leaderId, count: 0 },
      { providerEventId: followerId, count: 1 },
    ]);
  } finally {
    releaseFirst?.();
    await Promise.all([runtimes?.firstDatabase?.close(), runtimes?.secondDatabase?.close()]);
  }
}

async function proveAtomicStripeCancellationReleasesFence(openRuntimes) {
  const firstClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const secondClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let entered;
  let release;
  let retainedBuilder;
  const began = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const observedPredecessors = [];
  const cancellation = new AbortController();
  const capsule = {
    schema: { stripeWatchdogSequence: table({ providerEventId: Text() }) },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      const prior = await ctx.db.stripeWatchdogSequence.all();
      observedPredecessors.push({ providerEventId: event.providerEventId, count: prior.length });
      retainedBuilder = ctx.db.stripeWatchdogSequence.where("providerEventId", event.providerEventId);
      await ctx.db.stripeWatchdogSequence.insert({ providerEventId: event.providerEventId });
      if (event.providerEventId.endsWith("held")) {
        entered();
        await held;
      }
    }),
  };
  let runtimes;
  try {
    runtimes = await openRuntimes(capsule, firstClock, secondClock);
    const { firstDatabase, secondDatabase } = runtimes;
    await firstDatabase.init();
    await secondDatabase.init();
    const parentContext = (signal = new AbortController().signal) => ({
      auth: Object.freeze({ userId: "__privileged__", displayName: "Privileged server role", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "privileged-server-role" }),
      signal,
      __jobEnqueuedBy: "__privileged__",
    });
    const event = (providerEventId) => ({
      provider: "stripe", providerEventId, type: "customer.subscription.updated",
      occurredAt: "2030-01-01T00:00:00.000Z", livemode: false, objectId: "sub_atomic_watchdog",
      raw: { id: providerEventId, type: "customer.subscription.updated", data: { object: { id: "sub_atomic_watchdog" } } },
    });
    const firstRun = runAtomicStripeConsequence(firstDatabase, parentContext(cancellation.signal), event("evt_runtime_atomic_watchdog_held"), capsule.stripeEvents);
    await began;
    cancellation.abort();
    await assert.rejects(firstRun, (error) => error.code === "ABORT_ERR");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => retainedBuilder.all(), /no longer active/);
    await runAtomicStripeConsequence(secondDatabase, parentContext(), event("evt_runtime_atomic_watchdog_successor"), capsule.stripeEvents);
    assert.deepEqual(observedPredecessors, [
      { providerEventId: "evt_runtime_atomic_watchdog_held", count: 0 },
      { providerEventId: "evt_runtime_atomic_watchdog_successor", count: 0 },
    ]);
  } finally {
    release?.();
    await Promise.all([runtimes?.firstDatabase?.close(), runtimes?.secondDatabase?.close()]);
  }
}

test("atomic Stripe consequences serialize across independent SQLite runtimes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-serialization-"));
  const databasePath = path.join(dir, "shared.db");
  try {
    await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
      firstDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-serialization", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: firstClock }),
      secondDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-serialization", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: secondClock }),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic Stripe consequences preserve predecessor visibility when the second SQLite runtime acquires first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-serialization-reverse-"));
  const databasePath = path.join(dir, "shared.db");
  try {
    await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
      firstDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-serialization-reverse", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: firstClock }),
      secondDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-serialization-reverse", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: secondClock }),
    }), "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic Stripe consequences serialize across independent libSQL runtimes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "shared.db"), { isolateProcess: true }, async ({ url }) => {
      const config = { name: "stripe-atomic-libsql", payments: { stripe }, services: { database: { engine: "libsql" } } };
      const serviceEnv = { ...serverEnv, SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
        firstDatabase: await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv }),
        secondDatabase: await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv }),
      }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic Stripe consequences preserve predecessor visibility when the second libSQL runtime acquires first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-libsql-reverse-"));
  try {
    await withFakeLibsqlService(path.join(dir, "shared.db"), { isolateProcess: true }, async ({ url }) => {
      const config = { name: "stripe-atomic-libsql-reverse", payments: { stripe }, services: { database: { engine: "libsql" } } };
      const serviceEnv = { ...serverEnv, SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
        firstDatabase: await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv }),
        secondDatabase: await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv }),
      }), "second");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic cancellation rolls back and releases the fence across independent SQLite runtimes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-watchdog-sqlite-"));
  const databasePath = path.join(dir, "shared.db");
  try {
    await proveAtomicStripeCancellationReleasesFence(async (capsule, firstClock, secondClock) => ({
      firstDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-watchdog-sqlite", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: firstClock }),
      secondDatabase: await openDevDatabase(databasePath, "", serverEnv, { name: "stripe-atomic-watchdog-sqlite", payments: { stripe } }, capsule, { createStripeCallbackEndpoint, clock: secondClock }),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic cancellation rolls back and releases the fence across independent libSQL runtimes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-watchdog-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "shared.db"), { isolateProcess: true }, async ({ url }) => {
      const config = { name: "stripe-atomic-watchdog-libsql", payments: { stripe }, services: { database: { engine: "libsql" } } };
      const serviceEnv = { ...serverEnv, SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveAtomicStripeCancellationReleasesFence(async (capsule, firstClock, secondClock) => ({
        firstDatabase: await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv }),
        secondDatabase: await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv }),
      }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic Stripe consequences serialize across two independent Postgres runtimes", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-postgres-"));
  const serviceEnv = {
    ...serverEnv,
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const config = { name: "stripe-atomic-postgres", payments: { stripe }, services: { database: { engine: "postgres" } } };
  try {
    await withPostgresAdapter(async () => {}, { appTableNames: ["stripeSequence"] });
    await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
      firstDatabase: await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv }),
      secondDatabase: await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv }),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic Stripe consequences preserve predecessor visibility when the second Postgres runtime acquires first", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-postgres-reverse-"));
  const serviceEnv = {
    ...serverEnv,
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const config = { name: "stripe-atomic-postgres-reverse", payments: { stripe }, services: { database: { engine: "postgres" } } };
  try {
    await withPostgresAdapter(async () => {}, { appTableNames: ["stripeSequence"] });
    await proveAtomicStripeConsequenceSerialization(async (capsule, firstClock, secondClock) => ({
      firstDatabase: await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv }),
      secondDatabase: await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv }),
    }), "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired reserved Stripe Job is recovered by a second Postgres runtime without duplicate consequence", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-atomic-postgres-lease-"));
  const firstClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const secondClock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const capsule = {
    schema: { stripeLeaseObservations: table({ providerEventId: Text() }).unique("providerEventId") },
    stripeEvents: declareStripeEvent({ consequence: "atomic" }, async (ctx, event) => {
      const existing = await ctx.db.stripeLeaseObservations.where("providerEventId", event.providerEventId).get();
      if (!existing) await ctx.db.stripeLeaseObservations.insert({ providerEventId: event.providerEventId });
    }),
    queries: { observations: query((ctx) => ctx.db.stripeLeaseObservations.all()) },
  };
  const serviceEnv = {
    ...serverEnv,
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  const config = { name: "stripe-atomic-postgres-lease", payments: { stripe }, services: { database: { engine: "postgres" } } };
  let firstDatabase;
  let secondDatabase;
  try {
    await withPostgresAdapter(async () => {}, { appTableNames: ["stripeLeaseObservations"] });
    firstDatabase = await openDevDatabase(path.join(dir, "unused-first.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: firstClock, serviceEnv });
    await firstDatabase.init();
    secondDatabase = await openDevDatabase(path.join(dir, "unused-second.db"), "", serviceEnv, config, capsule, { createStripeCallbackEndpoint, clock: secondClock, serviceEnv });
    await secondDatabase.init();
    const admission = await postStripe(firstDatabase, stripeEvent("evt_runtime_atomic_lease_recovery_1"));
    const jobId = JSON.parse(admission.response.body).jobId;
    const staleClaimToken = "stale-runtime-claim";
    const expiredAt = "2029-12-31T23:59:59.000Z";
    const seeded = await firstDatabase.adapter.prepare(firstDatabase.adapter.dialect.sql(
      "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 1, [startedAt] = ?, [leaseExpiresAt] = ?, [claimToken] = ? WHERE [id] = ? AND [status] = 'queued'",
    )).run(expiredAt, expiredAt, staleClaimToken, jobId);
    assert.equal(Number(seeded.changes), 1);
    await recoverExpiredJobLeases(secondDatabase);
    const recovered = await secondDatabase.adapter.prepare(secondDatabase.adapter.dialect.sql("SELECT [status], [attempts], [claimToken], [attemptHistory] FROM [sporades_jobs] WHERE [id] = ?")).get(jobId);
    assert.equal(recovered.status, "delayed");
    assert.equal(Number(recovered.attempts), 1);
    assert.equal(recovered.claimToken, null);
    assert.equal(JSON.parse(recovered.attemptHistory)[0].code, "JOB_LEASE_EXPIRED");
    secondClock.advanceBy(1_001);
    await runCurrentUserJobWorker(secondDatabase);
    const staleWrite = await firstDatabase.adapter.prepare(firstDatabase.adapter.dialect.sql(
      "UPDATE [sporades_jobs] SET [status] = 'failed' WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?",
    )).run(jobId, staleClaimToken);
    assert.equal(Number(staleWrite.changes), 0);
    const state = (await inspectRuntimeJobs(secondDatabase.adapter)).find((jobState) => jobState.id === jobId);
    assert.equal(state.status, "succeeded");
    assert.equal(state.attempts, 2);
    assert.deepEqual((await runQuery(secondDatabase, anonymousAuth, "observations")).data.map((row) => row.providerEventId), ["evt_runtime_atomic_lease_recovery_1"]);
  } finally {
    await Promise.all([firstDatabase?.close(), secondDatabase?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
