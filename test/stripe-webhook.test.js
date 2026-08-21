import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Stripe from "stripe";
import { createControllableRuntimeClock, inspectRuntimeJobs, listDatabaseTables, openDevDatabase, routeEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { endpoint, mutation, query, String as Text, stripeEvent as declareStripeEvent, table } from "../dist/server.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";

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
    assert.deepEqual(auditEvents.map((event) => event.data.metadata.providerEventId), Array(3).fill(expectedRaw.id));
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
    assert.deepEqual(auditEvents.map((event) => event.data.metadata.providerEventId), Array(6).fill("evt_runtime_retry_1"));
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
    assert.deepEqual(auditEvents.map((event) => event.data.metadata.providerEventId), Array(15).fill("evt_runtime_terminal_1"));
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
    assert.deepEqual(auditEvents.map((event) => event.data.metadata.providerEventId), Array(3).fill("evt_runtime_cancel_1"));
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
