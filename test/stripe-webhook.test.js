import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Stripe from "stripe";
import { inspectRuntimeJobs, openDevDatabase, routeEndpoint } from "../dist/server-runtime-source.js";
import { endpoint } from "../dist/server.js";
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

function stripeEvent(id = "evt_runtime_1") {
  const created = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created,
    data: { object: { id: "cs_test_runtime_1", object: "checkout.session" } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
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
