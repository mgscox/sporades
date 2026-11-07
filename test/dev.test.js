import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNpmPackJson } from "../scripts/npm-pack-json.mjs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";
import { installProjectTailwindToolchain } from "./support/project-tailwind-toolchain.js";
import { CLIENT_CAPABILITIES } from "../dist/client-capabilities.js";
import { installPrerenderFixture } from "./support/prerender-capsule.js";
import { mountLitTemplate } from "./support/lit-template-harness.js";
import { mountSvelteTemplate } from "./support/svelte-template-harness.js";
import { mountSolidTemplate } from "./support/solid-template-harness.js";
import { mountVueTemplate } from "./support/vue-template-harness.js";
import { mountInfernoTemplate } from "./support/inferno-template-harness.js";
import { createBundle } from "../dist/bundle-pipeline.js";
import { buildClientToolchain } from "../dist/client-toolchain.js";
import { cleanupPublicTrees, discardPublicTree } from "../dist/public-tree.js";

// The Dev regression suite is split across files for independent desk workers.
import {
  repoRoot,
  cliPath,
  withTempDir,
  getTestAvailablePort,
  snapshotProjectTree,
  runCliFrom,
  runCli,
  startCliFrom,
  startCli,
  packCandidateInto,
  installPackedCandidate,
  installPackedCandidateCli,
  assertGeneratedLifecycleScriptAllowlist,
  installFakeDocker,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  assertDevRefreshDelivery,
  installFakeReact,
  installVue,
  installSvelte,
  nodeText,
  sessionState,
  authStub,
  createVueCampfire,
  createSolidTemplate,
  campfireHarnessState,
  litSource,
  createLitTemplate,
  createInfernoTemplate,
  litCampfireState,
  openSocket,
  subscribeDevRefresh,
  readWebSocketUpgradeResponse,
  readSocketMessage,
  captureSocketMessages,
  waitForSocketClose,
  closeSocketGracefully,
  waitForSocketMessage
} from "./support/dev-fixture.js";



test("Inferno Vite fails closed when project-owned Inferno compiler packages are unavailable", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "inferno-vite-missing", "--framework", "inferno", "--toolchain", "vite", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "inferno-vite-missing");
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.equal(error.phase, "client"); assert.equal(error.framework, "inferno"); assert.equal(error.toolchain, "vite");
      assert.match(error.message, /node_modules.*real directory.*Capsule project/i); assert.match(error.hint, /npm install.*inferno.*inferno-create-element/i);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });
});


test("real Inferno Campfire owns consent, typing, preferences, messages, and teardown", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createInfernoTemplate(dir, "inferno-campfire-behavior", "campfire", { toolchain: "vite" });
    const calls = [], session = litSource({ auth: { userId: "athos", provider: "email", displayName: "Athos", isAuthenticated: true }, providers: {}, error: null, loading: false });
    const query = () => litSource({ data: [{ id: "m1", authorName: "Porthos", body: "All for one", createdAt: "2026-07-12T12:00:00Z", reactions: {} }], error: null, loading: false });
    const queries = { profiles: litSource({ data: null, error: null, loading: false }), messagesGeneral: query(), messagesIdeas: query(), messagesRandom: query(), messagesProtectTheCrown: query() };
    let journeyStops = 0;
    const journey = { async enable() { calls.push(["journey.enable"]); return { data: { enabled: true }, error: null }; }, async set(value) { calls.push(["journey.set", value]); return { data: null, error: null }; }, async disable() { calls.push(["journey.disable"]); return { data: null, error: null }; }, subscribe(listener) { listener({ type: "snapshot", states: [] }); return { unsubscribe() { journeyStops += 1; } }; } };
    const mutation = (name) => ({ async run(...args) { calls.push([name, ...args]); return { data: null, error: null }; } });
    const harness = await mountInfernoTemplate(projectDir, { auth: authStub(), session, queries, journey, preferences: { async get() { calls.push(["preferences.get"]); return { data: { preferences: { campfireShareActivity: false } }, error: null }; }, async update(value) { calls.push(["preferences.update", value]); return { data: { preferences: value }, error: null }; } }, mutations: { sendMessage: mutation("sendMessage"), toggleReaction: mutation("toggleReaction"), seedCampfire: mutation("seedCampfire"), registerFixture: mutation("registerFixture") } });
    try {
      const share = harness.find('input[role="switch"]'); share.checked = true; share.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await harness.settle();
      const message = harness.find("#message"); message.value = "  Protect the crown  "; message.dispatchEvent(new harness.window.Event("input", { bubbles: true })); await harness.settle();
      harness.find("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true })); await harness.settle();
      assert(calls.some(([name]) => name === "journey.enable")); assert(calls.some(([name]) => name === "preferences.update")); assert(calls.some(([name]) => name === "sendMessage")); assert(calls.some(([name, value]) => name === "journey.set" && value.status === "typing"), JSON.stringify(calls));
      const disables = calls.filter(([name]) => name === "journey.disable").length; session.publish({ auth: { userId: "porthos", provider: "email", displayName: "Porthos", isAuthenticated: true }, providers: {}, error: null, loading: false }); await harness.settle();
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, disables + 1, "auth identity replacement retires page consent");
    } finally { await harness.unmount(); }
    assert.equal(journeyStops, 1); assert(calls.some(([name]) => name === "journey.disable")); assert.equal(session.counts.stops, 1);
  });
});


for (const deferredStage of ["journey.enable", "journey.set", "preferences.update"]) test(`real Lit Campfire direct consent remains identity-safe while ${deferredStage} is pending`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, `lit-campfire-${deferredStage.replaceAll(".", "-")}`, "campfire");
    const calls = []; let currentUser = "athos-user", releaseStage, markStage; const stageStarted = new Promise((resolve) => { markStage = resolve; });
    const waitAt = async (stage) => { if (stage === deferredStage) { markStage(); await new Promise((resolve) => { releaseStage = resolve; }); } };
    const state = litCampfireState(calls, { async enable(options) { calls.push(["journey.enable", options, currentUser]); await waitAt("journey.enable"); return { data: null, error: null }; }, async set(value) { calls.push(["journey.set", value, currentUser]); await waitAt("journey.set"); return { data: null, error: null }; } });
    state.session = litSource({ ...sessionState(), loading: false, auth: { userId: currentUser, provider: "email", isGuest: false, isAuthenticated: true } });
    state.preferences.get = async () => { calls.push(["preferences.get", currentUser]); return { data: { preferences: { campfireShareActivity: false } }, error: null }; };
    state.preferences.update = async (value) => { calls.push(["preferences.update", value, currentUser]); await waitAt("preferences.update"); return { data: { preferences: value }, error: null }; };
    const harness = await mountLitTemplate(projectDir, state);
    try {
      await harness.settle(); const share = harness.find('input[type="checkbox"]'); share.checked = true; share.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await stageStarted;
      currentUser = "porthos-user"; state.session.publish({ ...sessionState(), loading: false, auth: { userId: currentUser, provider: "email", isGuest: false, isAuthenticated: true } }); await harness.settle();
      assert.equal(harness.find('input[type="checkbox"]').checked, false); assert.equal(calls.filter(([name]) => name === "journey.disable").length, 0);
      releaseStage(); await harness.settle();
      assert.equal(harness.find('input[type="checkbox"]').checked, false); assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1);
      assert.equal(calls.filter(([name, _value, owner]) => name === "journey.set" && owner === "porthos-user").length, 0);
      assert.equal(calls.filter(([name, _value, owner]) => name === "preferences.update" && owner === "porthos-user").length, 0);
      assert(calls.some(([name, owner]) => name === "preferences.get" && owner === "porthos-user"));
    } finally { await harness.unmount(); }
  });
});


for (const failureStage of ["journey.set", "preferences.update"]) test(`real Lit Campfire direct consent recovers from structured ${failureStage} failures`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createLitTemplate(dir, `lit-campfire-error-${failureStage.replaceAll(".", "-")}`, "campfire");
    const calls = []; let fail = true;
    const state = litCampfireState(calls, { async set(value) { calls.push(["journey.set", value]); return fail && failureStage === "journey.set" ? { data: null, error: new Error("Journey publication failed") } : { data: null, error: null }; } });
    state.session = litSource({ ...sessionState(), loading: false, auth: { userId: "athos", provider: "email", isGuest: false, isAuthenticated: true } });
    state.preferences.get = async () => ({ data: { preferences: { campfireShareActivity: false } }, error: null });
    state.preferences.update = async (value) => { calls.push(["preferences.update", value]); return fail && failureStage === "preferences.update" ? { data: null, error: new Error("Preference save failed") } : { data: { preferences: value }, error: null }; };
    const harness = await mountLitTemplate(projectDir, state);
    const enable = async () => { const share = harness.find('input[type="checkbox"]'); share.checked = true; share.dispatchEvent(new harness.window.Event("change", { bubbles: true })); await harness.settle(); };
    try {
      await harness.settle(); await enable(); assert.equal(harness.find('input[type="checkbox"]').checked, false); assert.match(harness.text(), failureStage === "journey.set" ? /Journey publication failed/ : /Preference save failed/); assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1); if (failureStage === "journey.set") assert.equal(calls.some(([name]) => name === "preferences.update"), false);
      fail = false; await enable(); assert.equal(harness.find('input[type="checkbox"]').checked, true, "control recovers after a structured failure"); assert.doesNotMatch(harness.text(), failureStage === "journey.set" ? /Journey publication failed/ : /Preference save failed/);
    } finally { await harness.unmount(); }
  });
});


test("sporades dev fails with structured diagnostics when a declared database Capsule service is unhealthy", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);

    const result = await runCli(["dev", "--json"], {
      cwd: projectDir,
      env: { ...docker.env, FAKE_DOCKER_COMPOSE_STATUS: "unhealthy" },
    });

    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
      ok: false,
      data: null,
      error: {
        message: "Capsule database service did not become ready.",
        hint: "Run `docker compose -f .sporades/compose/capsule-services.compose.yml ps` and inspect the service logs.",
        diagnostics: {
          service: "database",
          engine: "libsql",
          status: {
            state: "running",
            health: "unhealthy",
          },
          probe: null,
        },
      },
    });
  });
});


test("sporades dev does not treat a running database Capsule service without probe readiness as ready", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);

    const result = await runCli(["dev", "--json"], {
      cwd: projectDir,
      env: {
        ...docker.env,
        FAKE_DOCKER_COMPOSE_STATUS: "no-health",
        FAKE_DOCKER_SERVICE_PORT: "9",
        SPORADES_SERVICE_READINESS_TIMEOUT_MS: "250",
      },
    });

    assert.equal(result.code, 1);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Capsule database service did not become ready.");
    assert.deepEqual(output.error.diagnostics.status, { state: "running", health: null });
    assert.equal(output.error.diagnostics.probe.ok, false);
  });
});


test("a generated activated blank Capsule runs Checkout, Customer Portal, and signed callback delivery through durable Jobs", { timeout: 120_000 }, async () => {
  await withTempDir(async (dir) => {
    const { packed, candidate, tarballPath } = await packCandidateInto(dir);
    const candidateCli = await installPackedCandidateCli(dir, tarballPath);
    const providerRequests = [];
    const provider = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      providerRequests.push({ url: request.url, headers: request.headers, body: params });
      if (request.url === "/v1/billing_portal/sessions") {
        const customer = params.get("customer");
        assert.match(customer, /^cus_server_(?:resolved|retry|rejected)$/);
        assert.equal(params.get("return_url"), "https://payments.example.test/account/billing");
        const matchingPortalRequests = providerRequests.filter((candidate) => candidate.url === request.url && candidate.body.get("customer") === customer);
        if (customer === "cus_server_retry" && matchingPortalRequests.length === 1) {
          response.writeHead(500, { "content-type": "application/json", "request-id": "req_portal_retry" });
          response.end(JSON.stringify({ error: { message: "temporary portal failure" } }));
          return;
        }
        if (customer === "cus_server_rejected") {
          response.writeHead(400, { "content-type": "application/json", "request-id": "req_portal_rejected" });
          response.end(JSON.stringify({ error: { message: "cus_server_rejected must not escape" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json", "request-id": "req_generated_portal" });
        response.end(JSON.stringify({
          id: customer === "cus_server_retry" ? "bps_generated_portal_retry" : "bps_generated_portal",
          object: "billing_portal.session",
          customer,
          livemode: false,
          return_url: "https://payments.example.test/account/billing",
          url: customer === "cus_server_retry" ? "https://billing.stripe.com/p/session/test_generated_portal_retry" : "https://billing.stripe.com/p/session/test_generated_portal",
        }));
        return;
      }
      const priceId = params.get("line_items[0][price]");
      const mode = params.get("mode");
      if (((priceId === "price_server_owned" || priceId === "price_guest_server_owned") && mode !== "payment") || (priceId === "price_recurring_server_owned" && mode !== "subscription")) {
        response.writeHead(400, { "content-type": "application/json", "request-id": "req_price_mode_mismatch" });
        response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Price mode mismatch" } }));
        return;
      }
      const retryRequests = providerRequests.filter((candidate) => candidate.body.get("client_reference_id") === "intent-retry-1");
      if (params.get("client_reference_id") === "intent-retry-1" && retryRequests.length === 1) {
        response.writeHead(500, { "content-type": "application/json", "request-id": "req_retry_once" });
        response.end(JSON.stringify({ error: { message: "temporary provider failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "request-id": "req_generated_checkout" });
      const subscription = mode === "subscription";
      const sessionId = subscription ? "cs_test_generated_subscription" : "cs_test_generated_checkout";
      response.end(JSON.stringify({
        id: sessionId,
        object: "checkout.session",
        livemode: false,
        mode,
        url: `https://checkout.stripe.com/c/pay/${sessionId}#fixture`,
      }));
    });
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const apiBaseUrl = `http://127.0.0.1:${provider.address().port}`;

    let child;
    let socket;
    let foreignSocket;
    let runtimeStdout = "";
    let runtimeStderr = "";
    try {
      const createResult = await runCliFrom(candidateCli.cliPath, ["create", "checkout-blank", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(createResult.code, 0, createResult.stderr);
      const projectDir = path.join(dir, "checkout-blank");
      await assertGeneratedLifecycleScriptAllowlist(projectDir);
      const installedCandidate = await installPackedCandidate(projectDir, tarballPath);
      const installedCliPath = installedCandidate.cliPath;
      const installedManifest = await readFile(path.join(installedCandidate.packageRoot, "dist", "generated-source-manifest.json"), "utf8");
      assert.match(installedManifest, /dist\/stripe-payment-integration\.js/);
      assert.match(installedManifest, /dist\/stripe-webhook-runtime\.js/);
      assert.equal(candidate.files.some((file) => file.path === "bin/sporades.js"), true);
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.dev.port = 0;
      config.auth = { providers: { anonymous: true, email: true } };
      config.payments.stripe = {
        enabled: true,
        secretKeyEnv: "STRIPE_SECRET_KEY",
        webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
        publicOrigin: "https://payments.example.test",
        callbackPath: "/stripe/webhook",
        apiVersion: "2026-08-26.dahlia",
        livemode: false,
        requestTimeoutMs: 10_000,
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      for (const [name, value] of [
        ["STRIPE_SECRET_KEY", "sk_test_generated_fixture"],
        ["STRIPE_WEBHOOK_SECRET", "whsec_generated_fixture"],
      ]) {
        const sealed = await runCliFrom(installedCliPath, ["env", "set", name, "--stdin", "--json"], { cwd: projectDir, stdin: `${value}\n` });
        assert.equal(sealed.code, 0, sealed.stderr);
        assert.doesNotMatch(`${sealed.stdout}${sealed.stderr}`, /generated_fixture/);
      }

      const paymentsPath = path.join(projectDir, "server", "payments.ts");
      const paymentSource = await readFile(paymentsPath, "utf8");
      await writeFile(
        paymentsPath,
        paymentSource
          .replace("Object.freeze({})", 'Object.freeze({ starter: { mode: "payment", priceId: "price_server_owned", maxQuantity: 3 }, guest: { mode: "payment", priceId: "price_guest_server_owned", maxQuantity: 1 }, pro: { mode: "subscription", priceId: "price_recurring_server_owned", maxQuantity: 5 } })')
          .replace('export const paymentMutations = {', 'export const paymentMutations = {\n  testEnqueueAnonymousPortal: mutation((ctx) => ctx.jobs.enqueue("stripeCustomerPortal", { intentId: "intent-anonymous-direct", billingHolderKey: "personal", returnPath: "/account/billing", idempotencyKey: "test:anonymous:portal" }, { idempotencyKey: "test:anonymous:portal", retry: { maxAttempts: 1 } })),')
          .replace("  return false;", "  return true;")
          .replace('    const actor = requireAuth(ctx, { linked: true });', '    const actor = input?.productKey === "guest" ? ctx.auth : requireAuth(ctx, { linked: true });')
          .replace('export async function authorizeStripeCustomerPortal(_ctx: CapsuleContext, _input: PortalInput): Promise<boolean> {\n  return false;\n}', 'export async function authorizeStripeCustomerPortal(_ctx: CapsuleContext, input: PortalInput): Promise<boolean> {\n  return input.billingHolderKey !== "forbidden";\n}')
          .replace('export async function resolveStripeCustomerForPortal(_ctx: CapsuleContext, _input: PortalInput): Promise<string | null> {\n  return null;\n}', 'const portalResolutionCalls = new Map<string, number>();\nexport async function resolveStripeCustomerForPortal(_ctx: CapsuleContext, input: PortalInput): Promise<string | null> {\n  const calls = (portalResolutionCalls.get(input.intentId) ?? 0) + 1;\n  portalResolutionCalls.set(input.intentId, calls);\n  if (input.billingHolderKey === "revoked") return calls === 1 ? "cus_server_revoked" : null;\n  return input.billingHolderKey === "personal" ? "cus_server_resolved" : input.billingHolderKey === "retry" ? "cus_server_retry" : input.billingHolderKey === "rejected" ? "cus_server_rejected" : null;\n}')
          .replace('export const paymentStripeEvents = stripeEvent((_ctx, event) => {', 'export const paymentStripeEvents = stripeEvent((ctx, event) => {\n  ctx.log.info("generated.stripe-event", { providerEventId: event.providerEventId, type: event.type });')
          .replaceAll("signal: ctx.signal })", `signal: ctx.signal, apiBaseUrl: ${JSON.stringify(apiBaseUrl)} })`),
      );
      child = startCliFrom(installedCliPath, ["dev", "--json"], { cwd: projectDir });
      child.stdout.on("data", (chunk) => { runtimeStdout += chunk; });
      child.stderr.on("data", (chunk) => { runtimeStderr += chunk; });
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      const send = async (target, message) => {
        const response = waitForSocketMessage(target, (candidate) => candidate.id === message.id);
        target.send(JSON.stringify(message));
        return await response;
      };
      const checkoutInput = { intentId: "intent-generated-1", productKey: "starter", quantity: 2 };
      const subscriptionInput = { intentId: "intent-subscription-1", productKey: "pro", quantity: 4 };
      const anonymous = await send(socket, { id: "anonymous-checkout", type: "mutation.run", mutation: "startStripeCheckout", args: [subscriptionInput] });
      assert.ok(anonymous.error);
      const anonymousPortal = await send(socket, { id: "anonymous-portal", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: "intent-anonymous-portal", billingHolderKey: "personal" }] });
      assert.ok(anonymousPortal.error);
      const directAnonymousPortal = await send(socket, { id: "anonymous-portal-direct", type: "mutation.run", mutation: "testEnqueueAnonymousPortal", args: [] });
      assert.equal(directAnonymousPortal.error, null, JSON.stringify(directAnonymousPortal));
      const directAnonymousFailedPromise = waitForSocketMessage(socket, (message) => message.id === "anonymous-portal-direct-state" && message.data?.status === "failed");
      socket.send(JSON.stringify({ id: "anonymous-portal-direct-state", type: "query.subscribe", query: "paymentJob", args: [directAnonymousPortal.data.id] }));
      const directAnonymousFailed = await directAnonymousFailedPromise;
      assert.equal(directAnonymousFailed.data.attempts, 1);
      assert.equal(providerRequests.length, 0);

      const signup = await send(socket, {
        id: "signup",
        type: "auth.signUp",
        provider: "email",
        credentials: { email: "buyer@example.test", password: "correct horse battery staple", name: "Buyer" },
      });
      assert.equal(signup.error, null);
      assert.equal(signup.data.auth.isGuest, false);

      for (const billingHolderKey of ["forbidden", "unknown", "deleted-team"]) {
        const denied = await send(socket, { id: `portal-${billingHolderKey}`, type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: `intent-${billingHolderKey}-1`, billingHolderKey }] });
        assert.equal(denied.error?.code, "PAYMENT_PORTAL_UNAVAILABLE");
      }
      const portalInjection = await send(socket, { id: "portal-injected-customer", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: "intent-portal-injected", billingHolderKey: "personal", customerId: "cus_browser_supplied" }] });
      assert.ok(portalInjection.error);
      assert.equal(providerRequests.length, 0);

      for (const [field, value] of Object.entries({
        priceId: "price_browser_supplied",
        customerId: "cus_browser_supplied",
        mode: "payment",
        metadata: { role: "admin" },
        idempotencyKey: "browser-owned",
        successPath: "https://browser.example/success",
        cancelPath: "https://browser.example/cancel",
      })) {
        const injected = await send(socket, { id: `injected-${field}`, type: "mutation.run", mutation: "startStripeCheckout", args: [{ ...subscriptionInput, [field]: value }] });
        assert.ok(injected.error, field);
      }
      const excessiveQuantity = await send(socket, { id: "excessive-quantity", type: "mutation.run", mutation: "startStripeCheckout", args: [{ ...subscriptionInput, quantity: 6 }] });
      assert.ok(excessiveQuantity.error);
      const unknown = await send(socket, { id: "unknown", type: "mutation.run", mutation: "startStripeCheckout", args: [{ ...checkoutInput, intentId: "intent-unknown-1", productKey: "unknown" }] });
      assert.ok(unknown.error);
      assert.equal(providerRequests.length, 0);

      const startedCheckout = await send(socket, { id: "checkout", type: "mutation.run", mutation: "startStripeCheckout", args: [checkoutInput] });
      assert.equal(startedCheckout.error, null, JSON.stringify(startedCheckout));
      const jobId = startedCheckout.data.jobId;
      const succeededPromise = waitForSocketMessage(socket, (message) => message.id === "payment-state" && message.data?.status === "succeeded");
      socket.send(JSON.stringify({ id: "payment-state", type: "query.subscribe", query: "paymentJob", args: [jobId] }));
      const succeeded = await succeededPromise;
      assert.deepEqual(succeeded.data.result, {
        ok: true,
        sessionId: "cs_test_generated_checkout",
        url: "https://checkout.stripe.com/c/pay/cs_test_generated_checkout#fixture",
      });
      assert.equal(providerRequests.length, 1);
      assert.equal(providerRequests[0].headers["idempotency-key"], `sporades:checkout-blank:stripe:checkout:${signup.data.auth.userId}:intent-generated-1`);
      assert.equal(providerRequests[0].body.get("mode"), "payment");
      assert.equal(providerRequests[0].body.get("line_items[0][price]"), "price_server_owned");

      const repeated = await send(socket, { id: "checkout-repeat", type: "mutation.run", mutation: "startStripeCheckout", args: [checkoutInput] });
      assert.equal(repeated.error, null);
      assert.equal(repeated.data.jobId, jobId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(providerRequests.length, 1);

      const startedSubscription = await send(socket, { id: "subscription", type: "mutation.run", mutation: "startStripeCheckout", args: [subscriptionInput] });
      assert.equal(startedSubscription.error, null, JSON.stringify(startedSubscription));
      const subscriptionJobId = startedSubscription.data.jobId;
      const subscriptionSucceededPromise = waitForSocketMessage(socket, (message) => message.id === "subscription-state" && message.data?.status === "succeeded");
      socket.send(JSON.stringify({ id: "subscription-state", type: "query.subscribe", query: "paymentJob", args: [subscriptionJobId] }));
      const subscriptionSucceeded = await subscriptionSucceededPromise;
      assert.deepEqual(subscriptionSucceeded.data.result, {
        ok: true,
        sessionId: "cs_test_generated_subscription",
        url: "https://checkout.stripe.com/c/pay/cs_test_generated_subscription#fixture",
      });
      assert.equal(providerRequests.length, 2);
      assert.equal(providerRequests[1].headers["idempotency-key"], `sporades:checkout-blank:stripe:checkout:${signup.data.auth.userId}:intent-subscription-1`);
      assert.equal(providerRequests[1].body.get("mode"), "subscription");
      assert.equal(providerRequests[1].body.get("line_items[0][price]"), "price_recurring_server_owned");
      assert.equal(providerRequests[1].body.get("line_items[0][quantity]"), "4");

      const repeatedSubscription = await send(socket, { id: "subscription-repeat", type: "mutation.run", mutation: "startStripeCheckout", args: [subscriptionInput] });
      assert.equal(repeatedSubscription.error, null);
      assert.equal(repeatedSubscription.data.jobId, subscriptionJobId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(providerRequests.length, 2);

      const retryInput = { intentId: "intent-retry-1", productKey: "pro", quantity: 1 };
      const retryStarted = await send(socket, { id: "checkout-retry", type: "mutation.run", mutation: "startStripeCheckout", args: [retryInput] });
      assert.equal(retryStarted.error, null, JSON.stringify(retryStarted));
      const retrySucceededPromise = waitForSocketMessage(socket, (message) => message.id === "payment-retry-state" && message.data?.status === "succeeded");
      socket.send(JSON.stringify({ id: "payment-retry-state", type: "query.subscribe", query: "paymentJob", args: [retryStarted.data.jobId] }));
      const retrySucceeded = await retrySucceededPromise;
      assert.equal(retrySucceeded.data.attempts, 2);
      const retryRequests = providerRequests.filter((candidate) => candidate.body.get("client_reference_id") === "intent-retry-1");
      assert.equal(retryRequests.length, 2);
      assert.equal(retryRequests[0].headers["idempotency-key"], retryRequests[1].headers["idempotency-key"]);
      assert.match(retryRequests[0].headers["idempotency-key"], /:intent-retry-1$/);

      const portalInput = { intentId: "intent-portal-1", billingHolderKey: "personal" };
      const portalStarted = await send(socket, { id: "portal", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [portalInput] });
      assert.equal(portalStarted.error, null, JSON.stringify(portalStarted));
      const portalSucceededPromise = waitForSocketMessage(socket, (message) => message.id === "portal-state" && message.data?.status === "succeeded");
      socket.send(JSON.stringify({ id: "portal-state", type: "query.subscribe", query: "paymentJob", args: [portalStarted.data.jobId] }));
      const portalSucceeded = await portalSucceededPromise;
      assert.deepEqual(portalSucceeded.data.result, {
        ok: true,
        sessionId: "bps_generated_portal",
        url: "https://billing.stripe.com/p/session/test_generated_portal",
      });
      const portalRequests = providerRequests.filter((candidate) => candidate.url === "/v1/billing_portal/sessions");
      assert.equal(portalRequests.length, 1);
      assert.equal(portalRequests[0].headers["idempotency-key"], `sporades:checkout-blank:stripe:portal:${signup.data.auth.userId}:intent-portal-1`);
      assert.equal(portalRequests[0].body.get("customer"), "cus_server_resolved");

      const repeatedPortal = await send(socket, { id: "portal-repeat", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [portalInput] });
      assert.equal(repeatedPortal.error, null);
      assert.equal(repeatedPortal.data.jobId, portalStarted.data.jobId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(providerRequests.filter((candidate) => candidate.url === "/v1/billing_portal/sessions").length, 1);

      const portalRetryStarted = await send(socket, { id: "portal-retry", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: "intent-portal-retry", billingHolderKey: "retry" }] });
      assert.equal(portalRetryStarted.error, null, JSON.stringify(portalRetryStarted));
      const portalRetryPromise = waitForSocketMessage(socket, (message) => message.id === "portal-retry-state" && message.data?.status === "succeeded");
      socket.send(JSON.stringify({ id: "portal-retry-state", type: "query.subscribe", query: "paymentJob", args: [portalRetryStarted.data.jobId] }));
      const portalRetried = await portalRetryPromise;
      assert.equal(portalRetried.data.attempts, 2);
      const portalRetryRequests = providerRequests.filter((candidate) => candidate.body.get("customer") === "cus_server_retry");
      assert.equal(portalRetryRequests.length, 2);
      assert.equal(portalRetryRequests[0].headers["idempotency-key"], portalRetryRequests[1].headers["idempotency-key"]);

      const portalRejected = await send(socket, { id: "portal-rejected", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: "intent-portal-rejected", billingHolderKey: "rejected" }] });
      assert.equal(portalRejected.error, null, JSON.stringify(portalRejected));
      const portalRejectedPromise = waitForSocketMessage(socket, (message) => message.id === "portal-rejected-state" && message.data?.status === "failed");
      socket.send(JSON.stringify({ id: "portal-rejected-state", type: "query.subscribe", query: "paymentJob", args: [portalRejected.data.jobId] }));
      const portalFailed = await portalRejectedPromise;
      assert.equal(portalFailed.data.attempts, 1);
      assert.deepEqual(portalFailed.data.failure, { code: "STRIPE_PORTAL_REJECTED", message: "Stripe rejected the Customer Portal request." });
      assert.doesNotMatch(JSON.stringify(portalFailed), /cus_server_rejected/);

      const portalRevoked = await send(socket, { id: "portal-revoked", type: "mutation.run", mutation: "startStripeCustomerPortal", args: [{ intentId: "intent-portal-revoked", billingHolderKey: "revoked" }] });
      assert.equal(portalRevoked.error, null, JSON.stringify(portalRevoked));
      const portalRevokedPromise = waitForSocketMessage(socket, (message) => message.id === "portal-revoked-state" && message.data?.status === "failed");
      socket.send(JSON.stringify({ id: "portal-revoked-state", type: "query.subscribe", query: "paymentJob", args: [portalRevoked.data.jobId] }));
      const revokedState = await portalRevokedPromise;
      assert.equal(revokedState.data.attempts, 1);
      assert.deepEqual(revokedState.data.failure, { code: "PAYMENT_PORTAL_UNAVAILABLE", message: "Customer Portal is not available for this billing holder." });
      assert.equal(providerRequests.some((candidate) => candidate.body.get("customer") === "cus_server_revoked"), false);

      foreignSocket = await openSocket(started.data.url);
      const guestInput = { intentId: "intent-guest-1", productKey: "guest", quantity: 1 };
      const guestStarted = await send(foreignSocket, { id: "guest-checkout", type: "mutation.run", mutation: "startStripeCheckout", args: [guestInput] });
      assert.equal(guestStarted.error, null, JSON.stringify(guestStarted));
      const guestSucceededPromise = waitForSocketMessage(foreignSocket, (message) => message.id === "guest-payment-state" && message.data?.status === "succeeded");
      foreignSocket.send(JSON.stringify({ id: "guest-payment-state", type: "query.subscribe", query: "paymentJob", args: [guestStarted.data.jobId] }));
      const guestSucceeded = await guestSucceededPromise;
      assert.equal(guestSucceeded.data.result.sessionId, "cs_test_generated_checkout");
      const guestRequests = providerRequests.filter((candidate) => candidate.body.get("client_reference_id") === guestInput.intentId);
      assert.equal(guestRequests.length, 1);
      assert.equal(guestRequests[0].body.get("mode"), "payment");
      assert.equal(guestRequests[0].body.get("line_items[0][price]"), "price_guest_server_owned");
      assert.match(guestRequests[0].headers["idempotency-key"], /^sporades:checkout-blank:stripe:checkout:[^:]+:intent-guest-1$/);

      const foreign = await send(foreignSocket, { id: "foreign-state", type: "query.subscribe", query: "paymentJob", args: [subscriptionJobId] });
      assert.equal(foreign.data ?? null, null);
      assert.equal(foreign.error ?? null, null);
      const foreignPortal = await send(foreignSocket, { id: "foreign-portal-state", type: "query.subscribe", query: "paymentJob", args: [portalStarted.data.jobId] });
      assert.equal(foreignPortal.data ?? null, null);
      assert.equal(foreignPortal.error ?? null, null);

      const stripeEvent = JSON.stringify({
        id: "evt_generated_callback_1",
        object: "event",
        api_version: "2026-08-26.dahlia",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: "obj_future_1", object: "future.billing.object" } },
        livemode: false,
        pending_webhooks: 1,
        request: null,
        type: "future.billing.reconciled",
      });
      const stripeSignature = Stripe.webhooks.generateTestHeaderString({ payload: stripeEvent, secret: "whsec_generated_fixture" });
      const postStripeEvent = () => fetch(`${started.data.url}/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": stripeSignature },
        body: stripeEvent,
      });
      const firstCallback = await postStripeEvent();
      const duplicateCallback = await postStripeEvent();
      assert.equal(firstCallback.status, 200);
      assert.equal(duplicateCallback.status, 200);
      const firstAdmission = await firstCallback.json();
      const duplicateAdmission = await duplicateCallback.json();
      assert.equal(firstAdmission.jobId, duplicateAdmission.jobId);
      let admittedJobs = [];
      const deliveryDeadline = Date.now() + 5_000;
      do {
        admittedJobs = JSON.parse((await runCliFrom(installedCliPath, ["jobs"], { cwd: projectDir })).stdout).data.jobs;
        if (admittedJobs.some((candidate) => candidate.id === firstAdmission.jobId && candidate.status === "succeeded")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deliveryDeadline);
      assert.equal(admittedJobs.filter((candidate) => candidate.id === firstAdmission.jobId && candidate.handler === "_sporades.stripe-event").length, 1);
      assert.equal(admittedJobs.find((candidate) => candidate.id === firstAdmission.jobId)?.status, "succeeded");
      assert.doesNotMatch(JSON.stringify(admittedJobs), /obj_future_1|pending_webhooks|whsec_generated_fixture|stripe-signature|cs_test_generated_|test_generated_portal/i);
      const completedDuplicate = await postStripeEvent();
      assert.equal(completedDuplicate.status, 200);
      assert.equal((await completedDuplicate.json()).jobId, firstAdmission.jobId);
      const paymentLogs = JSON.parse((await runCliFrom(installedCliPath, ["logs", "--json"], { cwd: projectDir })).stdout).data.entries;
      const deliveredLogs = paymentLogs.filter((event) => event.message === "generated.stripe-event" && event.data?.providerEventId === "evt_generated_callback_1");
      assert.equal(deliveredLogs.length, 1);
      assert.equal(deliveredLogs[0].data.type, "future.billing.reconciled");
      assert.doesNotMatch(JSON.stringify(paymentLogs), /obj_future_1|pending_webhooks|whsec_generated_fixture|stripe-signature|cs_test_generated_|test_generated_portal/i);
      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      assert.doesNotMatch(serverBundle, /sk_test_generated_fixture|whsec_generated_fixture/);
      assert.doesNotMatch(serverBundle, /(?:from\s+|require\()["']stripe["']/);
      assert.match(serverBundle, /STRIPE_CHECKOUT_RESPONSE_INVALID/);
      assert.match(serverBundle, /STRIPE_PORTAL_RESPONSE_INVALID/);
      assert.match(serverBundle, /STRIPE_WEBHOOK_REJECTED/);
      const generatedPaymentSurfaces = (await Promise.all([
        readFile(configPath, "utf8"),
        readFile(paymentsPath, "utf8"),
        readFile(path.join(projectDir, "client", "payments.ts"), "utf8"),
        readFile(path.join(projectDir, "README.md"), "utf8"),
        readFile(path.join(projectDir, "AGENTS.md"), "utf8"),
      ])).join("\n");
      const redactionSurfaces = `${packed.stdout}${packed.stderr}${candidateCli.installed.stdout}${candidateCli.installed.stderr}${installedCandidate.installed.stdout}${installedCandidate.installed.stderr}${runtimeStdout}${runtimeStderr}${generatedPaymentSurfaces}${serverBundle}`;
      assert.equal(redactionSurfaces.includes(stripeSignature), false);
      assert.doesNotMatch(redactionSurfaces, /sk_test_generated_fixture|whsec_generated_fixture|obj_future_1|pending_webhooks|cs_test_generated_|test_generated_portal|Bearer sk_test_/i);
    } finally {
      await closeSocketGracefully(foreignSocket);
      await closeSocketGracefully(socket);
      child?.kill("SIGTERM");
      if (child) await new Promise((resolve) => child.once("exit", resolve));
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    }
  });
});


test("sporades dev serves a genuinely built nested esbuild asset with its MIME type", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "asset-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "asset-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const clientPath = path.join(projectDir, "client", "index.tsx");
    const clientSource = await readFile(clientPath, "utf8");
    await writeFile(path.join(projectDir, "client", "badge.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n');
    await writeFile(clientPath, `import badgeUrl from "./badge.svg";\nconsole.log(badgeUrl);\n${clientSource}`);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const clientBundle = await (await fetch(`${started.data.url}/client.js`)).text();
      const nestedAsset = /\.\/(assets\/badge-[A-Z0-9]+\.svg)/i.exec(clientBundle)?.[1];
      assert.ok(nestedAsset, "Expected client.js to reference a built nested SVG asset.");
      const asset = await fetch(`${started.data.url}/${nestedAsset}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), "image/svg+xml");
      assert.match(await asset.text(), /<circle r="4"\/>/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("React Vite loads project plugins so Tailwind utilities reach the normalized public tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "vite-tailwind-build", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-tailwind-build");
    await installFakeReact(projectDir);
    await installProjectTailwindToolchain(projectDir, repoRoot);
    await writeFile(
      path.join(projectDir, "vite.config.ts"),
      `import { defineConfig } from "vite";\nimport tailwindcss from "@tailwindcss/vite";\n\nexport default defineConfig({ plugins: [tailwindcss()] });\n`,
    );
    await writeFile(path.join(projectDir, "client", "styles.css"), `@import "tailwindcss";\n`);
    await writeFile(
      path.join(projectDir, "client", "index.tsx"),
      `import { createRoot } from "react-dom/client";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")!).render(<button className="inline-flex h-8 rounded-md px-3">Settings</button>);\n`,
    );
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const paths = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      const cssPath = paths.find((file) => /^assets\/index-[^/]+\.css$/.test(file));
      assert.ok(cssPath, JSON.stringify(paths));
      const css = await readFile(path.join(bundle.staticFiles.publicDir, cssPath), "utf8");
      assert.match(css, /\.inline-flex\b/);
      assert.match(css, /\.h-8\b/);
      assert.match(css, /\.px-3\b/);
      assert.match(css, /\.rounded-md\b|border-radius:\s*var\(--radius-md\)/);
      assert.doesNotMatch(css, /@tailwind\s+utilities/);
      const html = await readFile(path.join(bundle.staticFiles.publicDir, "index.html"), "utf8");
      assert.match(html, new RegExp(cssPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("complete Vue exemplars start through Sporades Dev with normalized Vite assets", async () => {
  await withTempDir(async (dir) => {
    for (const template of ["guestbook", "photo-library", "campfire"]) {
      const created = await runCli(["create", `vue-${template}-dev`, "--template", template, "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `vue-${template}-dev`);
      await installVue(projectDir);
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.dev.port = 0;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
      const child = startCli(["dev", "--json"], { cwd: projectDir });
      try {
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);
        const htmlResponse = await fetch(started.data.url);
        assert.equal(htmlResponse.status, 200);
        const html = await htmlResponse.text();
        const asset = html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
        assert(asset, html);
        const assetResponse = await fetch(new URL(asset, started.data.url));
        assert.equal(assetResponse.status, 200);
        assert.doesNotMatch(await assetResponse.text(), /\/@vite\/client|vite\/hmr/i);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  });
});


for (const { template, marker } of [{ template: "blank", marker: "Blank Sporades Capsule" }, { template: "todo", marker: "Sporades Todos" }, { template: "guestbook", marker: "Leave a note from this island" }, { template: "photo-library", marker: "Photo Library" }, { template: "campfire", marker: "Campfire" }]) test(`Svelte Vite compiles the ${template} component into an isolated normalized public tree`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `svelte-${template}-build`, "--template", template, "--framework", "svelte", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, `svelte-${template}-build`);
    await installSvelte(projectDir);
    await writeFile(path.join(projectDir, ".env"), "VITE_SVELTE_LEAK=browser-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}SVELTE_SERVER_ONLY=server-secret\n`);
    await writeFile(path.join(projectDir, "vite.config.ts"), 'export default { plugins: [{ name: "svelte-vite-config-loaded" }] };\n');
    await writeFile(path.join(projectDir, "postcss.config.mjs"), 'throw new Error("svelte-postcss-config-loaded");\n');
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = Object.keys(await snapshotProjectTree(bundle.staticFiles.publicDir)).filter((file) => !file.endsWith("/"));
      assert(files.some((file) => /^assets\/index-[^/]+\.js$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[^/]+\.css$/.test(file)), JSON.stringify(files));
      assert(files.some((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)), JSON.stringify(files));
      const output = (await Promise.all(files.map((file) => readFile(path.join(bundle.staticFiles.publicDir, file), "utf8")))).join("\n");
      assert.match(output, new RegExp(marker));
      assert.doesNotMatch(output, /browser-secret|server-secret|svelte-(?:vite|postcss)-config-loaded|\/@vite\/client|vite\/hmr/i);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});


test("Vue Guestbook renders query state and drives mutation loading, errors, and updates", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vue-guestbook-behavior", "--template", "guestbook", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vue-guestbook-behavior");
    await installVue(projectDir);
    let finishSign;
    const signCalls = [];
    const harness = await mountVueTemplate(projectDir, {
      session: sessionState(),
      queries: { entries: { loading: true, data: null, error: null } },
      mutations: {
        sign: { loading: false, error: null, async run(body) {
          signCalls.push(body);
          const state = globalThis.__SPORADES_VUE_TEMPLATE_HARNESS__.mutations.sign;
          state.loading = true;
          const result = await new Promise((resolve) => { finishSign = resolve; });
          state.loading = false;
          state.error = result.error;
          return result;
        } },
      },
      auth: authStub(), files: {}, journey: {}, preferences: {},
    });
    try {
      assert.match(harness.text(), /Loading/);
      harness.state.queries.entries.loading = false;
      harness.state.queries.entries.error = new Error("Guestbook unavailable");
      await harness.settle();
      assert.match(harness.text(), /Guestbook unavailable/);
      harness.state.queries.entries.error = null;
      harness.state.queries.entries.data = [{ id: "entry-1", body: "All for one", authorName: "Athos", authorPicture: "", createdAt: "2026-07-11T12:00:00.000Z" }];
      await harness.settle();
      assert.match(harness.text(), /Athos.*All for one/s);

      const textarea = harness.find((node) => node.type === "textarea");
      const form = harness.find((node) => node.type === "form");
      await harness.setValue(textarea, "  One for all  ");
      const submitting = harness.trigger(form, "submit");
      await harness.settle();
      assert.deepEqual(signCalls, ["One for all"]);
      assert.equal(harness.find((node) => node.type === "button" && /Sign guestbook/.test(nodeText(node))).props.disabled, true);
      finishSign({ error: new Error("Signing failed") });
      await submitting;
      assert.match(harness.text(), /Signing failed/);
      assert.equal(textarea.value, "  One for all  ", "failed mutation preserves the draft");

      const succeeding = harness.trigger(form, "submit");
      await harness.settle();
      finishSign({ error: null });
      await succeeding;
      assert.equal(textarea.value, "", "successful mutation clears the rendered draft");
    } finally { harness.unmount(); }
  });
});


for (const deferredStage of ["journey.enable", "journey.set", "preferences.update"]) test(`Solid Campfire direct consent is identity-safe while ${deferredStage} is pending`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createSolidTemplate(dir, `solid-campfire-direct-${deferredStage.replaceAll(".", "-")}`, "campfire");
    const calls = [];
    let releaseStage, markStageStarted;
    const stageStarted = new Promise((resolve) => { markStageStarted = resolve; });
    const waitAtStage = async (stage) => { if (stage === deferredStage) { markStageStarted(); await new Promise((resolve) => { releaseStage = resolve; }); } };
    const userId = () => globalThis.__SPORADES_SOLID_TEMPLATE_HARNESS__.controls.session.value.auth?.userId;
    const state = campfireHarnessState(calls, {
      async enable(options) { calls.push(["journey.enable", options, userId()]); await waitAtStage("journey.enable"); return { data: null, error: null }; },
      async set(value) { calls.push(["journey.set", value, userId()]); await waitAtStage("journey.set"); return { data: null, error: null }; },
    });
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false, isAuthenticated: true };
    state.preferences.get = async () => { calls.push(["preferences.get", userId()]); return { data: { preferences: { campfireShareActivity: false } }, error: null }; };
    state.preferences.update = async (value) => { calls.push(["preferences.update", value, userId()]); await waitAtStage("preferences.update"); return { data: { preferences: value }, error: null }; };
    const harness = await mountSolidTemplate(projectDir, state);
    try {
      await harness.settle();
      const share = harness.find('input[type="checkbox"]');
      share.checked = true;
      await harness.trigger(share, "change");
      await stageStarted;
      harness.setSession({ ...sessionState(), auth: { userId: "porthos-user", provider: "email", displayName: "Porthos", isGuest: false, isAuthenticated: true } });
      await harness.settle();
      assert.equal(share.checked, false, "pending consent stays hidden");
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 0, "retirement waits for the owned action");
      releaseStage();
      await harness.settle();
      assert.equal(share.checked, false);
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1);
      assert.equal(calls.filter(([name, _value, owner]) => name === "journey.set" && owner === "porthos-user").length, 0);
      assert.equal(calls.filter(([name, _value, owner]) => name === "preferences.update" && owner === "porthos-user").length, 0);
      assert(calls.some(([name, owner]) => name === "preferences.get" && owner === "porthos-user"));
    } finally { await harness.unmount(); }
  });
});


for (const failureStage of ["journey.set", "preferences.update"]) test(`Vue Campfire direct consent handles structured ${failureStage} errors`, async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createVueCampfire(dir, `vue-campfire-error-${failureStage.replaceAll(".", "-")}`);
    const calls = [];
    const state = campfireHarnessState(calls, {
      async set(value) {
        calls.push(["journey.set", value]);
        return failureStage === "journey.set" ? { data: null, error: new Error("Journey publication failed") } : { data: null, error: null };
      },
    });
    state.session.auth = { userId: "athos-user", provider: "email", displayName: "Athos", isGuest: false };
    state.preferences.update = async (value) => {
      calls.push(["preferences.update", value]);
      return failureStage === "preferences.update" ? { data: null, error: new Error("Preference save failed") } : { data: { preferences: value }, error: null };
    };
    const harness = await mountVueTemplate(projectDir, state);
    try {
      const share = harness.find((node) => node.type === "input" && node.props.type === "checkbox");
      await harness.trigger(share, "change", { checked: true });
      assert.equal(share.props.checked, false);
      assert.match(harness.text(), failureStage === "journey.set" ? /Journey publication failed/ : /Preference save failed/);
      assert.equal(calls.filter(([name]) => name === "journey.disable").length, 1, "failed consent retires its owned activity once");
      if (failureStage === "journey.set") assert.equal(calls.some(([name]) => name === "preferences.update"), false, "failed publication is never persisted");
    } finally { harness.unmount(); }
  });
});


test("Vue Vite rejects external plugin and compiler package or scope symlinks before build output", async () => {
  for (const scenario of ["plugin-package", "compiler-package", "plugin-scope", "compiler-scope"]) {
    await withTempDir(async (dir) => {
      const created = await runCli(["create", `vue-external-${scenario}`, "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = path.join(dir, `vue-external-${scenario}`);
      await installVue(projectDir);
      const plugin = scenario.startsWith("plugin");
      const scope = plugin ? "@vitejs" : "@vue";
      const packageName = plugin ? "plugin-vue" : "compiler-sfc";
      const linkPath = scenario.endsWith("scope")
        ? path.join(projectDir, "node_modules", scope)
        : path.join(projectDir, "node_modules", scope, packageName);
      const externalTarget = scenario.endsWith("scope")
        ? path.join(repoRoot, "node_modules", scope)
        : path.join(repoRoot, "node_modules", scope, packageName);
      await rm(linkPath, { recursive: true, force: true });
      await symlink(externalTarget, linkPath);

      const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.equal(error.phase, "client");
        assert.match(error.message, new RegExp(`could not resolve project-owned ${scope}/${packageName}`, "i"));
        assert.match(error.hint, /npm install/i);
        const diagnostics = JSON.stringify({ message: error.message, diagnostics: error.diagnostics });
        assert.doesNotMatch(diagnostics, new RegExp(externalTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
      await assert.rejects(access(path.join(projectDir, ".sporades")), (error) => error.code === "ENOENT");
    });
  }
});


test("sporades dev owns React Vite rebuilds, preserves last-good output, and requests full-page refresh", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "vite-dev", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-dev");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const initialHtml = await (await fetch(started.data.url)).text();
      const initialEntry = /src="(\/assets\/index-[^"]+\.js)"/.exec(initialHtml)?.[1];
      assert.ok(initialEntry, initialHtml);
      assert.doesNotMatch(initialHtml, /\/client\/index\.tsx|\/client\.js/);
      const initialEntrySource = await (await fetch(`${started.data.url}${initialEntry}`)).text();
      assert.doesNotMatch(initialEntrySource, /\/@vite\/client|react-refresh|vite\/hmr/i);

      socket = await openSocket(started.data.url);
      await subscribeDevRefresh(socket);
      const refresh = readSocketMessage(socket);
      const chunkPath = path.join(projectDir, "client", "vite-scaffold.ts");
      await writeFile(chunkPath, 'export const viteScaffoldLabel = "Sporades Vite rebuilt by its sole watcher";\n');
      const rebuilt = await waitForJsonEvent(child, (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "react", toolchain: "vite" });
      assert.deepEqual(await refresh, { id: null, type: "refresh", data: { mode: "full-page", sequence: 1 }, error: null });
      const rebuiltHtml = await (await fetch(started.data.url)).text();
      const rebuiltEntry = /src="(\/assets\/index-[^"]+\.js)"/.exec(rebuiltHtml)?.[1];
      assert.ok(rebuiltEntry, rebuiltHtml);
      const rebuiltEntrySource = await (await fetch(`${started.data.url}${rebuiltEntry}`)).text();
      const rebuiltChunkPath = /import\("(\.\/vite-scaffold-[^"]+\.js)"\)/.exec(rebuiltEntrySource)?.[1];
      assert.ok(rebuiltChunkPath, rebuiltEntrySource);
      assert.match(await (await fetch(new URL(rebuiltChunkPath, `${started.data.url}${rebuiltEntry}`))).text(), /sole watcher/);

      const withoutConnectionToken = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const lastGoodHtml = withoutConnectionToken(rebuiltHtml);
      const lastGoodEntry = rebuiltEntrySource;
      await writeFile(chunkPath, "export const = ;\n");
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "react", toolchain: "vite" });
      assert.match(failed.error.message, /Client bundle failed/);
      assert.match(failed.error.hint, /React\/Vite client source/);
      assert(JSON.stringify(failed).length < 4096, JSON.stringify(failed));
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(JSON.stringify(failed), /\/(?:private\/)?var\/folders\//);
      if (failed.error.diagnostics?.file) assert.doesNotMatch(failed.error.diagnostics.file, /^\//);
      assert.equal(withoutConnectionToken(await (await fetch(started.data.url)).text()), lastGoodHtml);
      assert.equal(await (await fetch(`${started.data.url}${rebuiltEntry}`)).text(), lastGoodEntry);

      const recoveredRefresh = readSocketMessage(socket);
      await writeFile(chunkPath, 'export const viteScaffoldLabel = "Sporades Vite recovered";\n');
      const recovered = await waitForJsonEvent(child, (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "react", toolchain: "vite" });
      assert.equal((await recoveredRefresh).type, "refresh");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades dev preserves last-good Lit ${template} output${template === "blank" ? " with omitted-toolchain Vite inference" : ""} and recovers through acknowledged refresh`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `lit-${template}-dev`, "--template", template, "--framework", "lit", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr || created.stdout);
    const projectDir = path.join(dir, `lit-${template}-dev`);
    await installProjectLitToolchain(projectDir, repoRoot);
    if (template === "photo-library") await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (template === "blank") delete config.client.toolchain;
    config.dev.port = 0; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const clientPath = path.join(projectDir, "client", "index.ts"), original = await readFile(clientPath, "utf8");
    const child = startCli(["dev", "--json"], { cwd: projectDir }), events = captureJsonEvents(child);
    let socket, messages;
    try {
      const scrub = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const started = await events.next((event) => event.ok && event.data?.event === "started");
      const initialHtml = scrub(await (await fetch(started.data.url)).text());
      socket = await openSocket(started.data.url); messages = captureSocketMessages(socket);
      socket.send(JSON.stringify({ id: "lit-dev-ready", type: "dev.refresh.subscribe" }));
      assert.deepEqual(await messages.next((message) => message.id === "lit-dev-ready"), { id: "lit-dev-ready", type: "dev.refresh.ready", data: { mode: "full-page", sequence: 0 }, error: null });
      const refresh = messages.next((message) => message.type === "refresh");
      await writeFile(clientPath, original.replace("customElements.define", 'console.info("Lit rebuilt");\ncustomElements.define'));
      assert.equal((await refresh).data.sequence, 1);
      assert.equal(events.events.some((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), false);
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: 1 }));
      const rebuilt = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "lit", toolchain: "vite" }); assertDevRefreshDelivery(rebuilt.data.refresh, 1);
      const lastGood = scrub(await (await fetch(started.data.url)).text()); assert.notEqual(lastGood, initialHtml);
      await writeFile(clientPath, "export class = ;\n");
      const failed = await events.next((event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "lit", toolchain: "vite" });
      assert.match(failed.error.hint, /Lit\/Vite client source/); assert(JSON.stringify(failed).length < 4096); assert.equal(scrub(await (await fetch(started.data.url)).text()), lastGood);
      const recoveredRefresh = messages.next((message) => message.type === "refresh"); await writeFile(clientPath, original);
      assert.equal((await recoveredRefresh).data.sequence, 2); socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: 2 }));
      const recovered = await events.next((event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assertDevRefreshDelivery(recovered.data.refresh, 2);
    } finally { messages?.dispose(); await closeSocketGracefully(socket); child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); events.dispose(); }
  });
});


for (const template of ["blank", "todo"]) test(`sporades dev preserves last-good Vue ${template} SFC output and recovers with full-page refresh`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "vue-dev", "--template", template, "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vue-dev");
    await installVue(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (template === "blank") delete config.client.toolchain;
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const appPath = path.join(projectDir, "client", "App.vue");
    const original = await readFile(appPath, "utf8");
    const sourceLabel = template === "todo" ? "Sporades Todos" : "Blank Sporades Capsule";

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      await subscribeDevRefresh(socket);
      const firstRefresh = readSocketMessage(socket);
      await writeFile(appPath, original.replace(sourceLabel, "Vue SFC rebuilt"));
      const rebuilt = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(rebuilt.data.build, { phase: "client", framework: "vue", toolchain: "vite" });
      assert.equal((await firstRefresh).type, "refresh");
      const scrub = (html) => html.replace(/window\.__SPORADES_CONNECTION_TOKEN="[^"]+"/, 'window.__SPORADES_CONNECTION_TOKEN="<token>"');
      const lastGood = scrub(await (await fetch(started.data.url)).text());

      await writeFile(appPath, '<script setup lang="ts">const broken = </script><template><div></template>\n');
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "vue", toolchain: "vite" });
      assert.match(failed.error.message, /Client bundle failed/);
      assert.match(failed.error.hint, /Vue\/Vite client source/);
      assert(JSON.stringify(failed).length < 4096);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(scrub(await (await fetch(started.data.url)).text()), lastGood);

      const recoveredRefresh = readSocketMessage(socket);
      await writeFile(appPath, original.replace(sourceLabel, "Vue SFC recovered"));
      const recovered = await waitForJsonEvent(child, (event) => event.ok && event.data?.event === "rebuild" && event.data.status === "success");
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "vue", toolchain: "vite" });
      assert.equal((await recoveredRefresh).type, "refresh");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("React Vite redacts symlink aliases and canonical project roots from missing-import diagnostics", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(
      ["create", "vite-real-root", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const realProjectDir = path.join(dir, "vite-real-root");
    const aliasProjectDir = path.join(dir, "vite-alias");
    await installFakeReact(realProjectDir);
    await symlink(realProjectDir, aliasProjectDir);
    const configPath = path.join(realProjectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const child = startCli(["dev", "--json"], { cwd: aliasProjectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      await writeFile(
        path.join(realProjectDir, "client", "index.tsx"),
        'import "./missing-through-real-root.js";\n',
      );
      const failed = await waitForJsonEvent(child, (event) => !event.ok && event.data?.event === "rebuild");
      const serialized = JSON.stringify(failed);
      assert.match(failed.error.message, /Client bundle failed/);
      assert.match(serialized, /missing-through-real-root/);
      const forbiddenRoots = [aliasProjectDir, realProjectDir, await import("node:fs/promises").then(({ realpath }) => realpath(realProjectDir))];
      for (const leakedRoot of forbiddenRoots) {
        assert.doesNotMatch(serialized, new RegExp(leakedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.doesNotMatch(serialized, /\/(?:private\/)?var\/folders\//);
      if (failed.error.diagnostics?.file) assert.doesNotMatch(failed.error.diagnostics.file, /^\//);

      await assert.rejects(createBundle(aliasProjectDir, config), (error) => {
        const directDiagnostics = JSON.stringify({ message: error.message, diagnostics: error.diagnostics, stack: error.stack });
        assert.match(directDiagnostics, /missing-through-real-root/);
        for (const leakedRoot of forbiddenRoots) {
          assert.doesNotMatch(directDiagnostics, new RegExp(leakedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        assert.doesNotMatch(directDiagnostics, /\/(?:private\/)?var\/folders\//);
        return true;
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("Dev reclaims dead owned action Bundles while preserving live, ambiguous and symlink entries", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "action-recovery", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "action-recovery");
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = await getTestAvailablePort();
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "STALE_SECRET=old-private-secret\n", { mode: 0o600 });
    const actionRoot = path.join(projectDir, ".sporades", "build", ".dev-actions");
    const first = startCli(["dev", "--json"], { cwd: projectDir });
    let second;
    try {
      await waitForJsonEvent(first, (event) => event.data?.event === "started");
      const liveId = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8")).actionBundleId;
      const liveDir = path.join(actionRoot, liveId);
      assert.match(await readFile(path.join(liveDir, "server.mjs"), "utf8"), /old-private-secret/);
      const unknownId = "a".repeat(32);
      const reusedId = "b".repeat(32);
      const ownerlessId = "d".repeat(32);
      for (const id of [unknownId, reusedId]) {
        await mkdir(path.join(actionRoot, id));
        await writeFile(path.join(actionRoot, id, "server.mjs"), "old-private-secret");
        await writeFile(path.join(actionRoot, id, "owner.json"), JSON.stringify({ id, pid: process.pid, processStart: id === unknownId ? null : "reused-pid" }));
      }
      await mkdir(path.join(actionRoot, ownerlessId));
      await writeFile(path.join(actionRoot, ownerlessId, "server.mjs"), "historical-ambiguous-secret");
      const outside = path.join(dir, "outside-action-root");
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel"), "outside-safe");
      const linkId = "c".repeat(32);
      await symlink(outside, path.join(actionRoot, linkId));
      const competing = await runCli(["dev", "--json"], { cwd: projectDir });
      assert.notEqual(competing.code, 0);
      assert.match(competing.stdout + competing.stderr, /EADDRINUSE|address already in use/i);
      await access(liveDir);
      await access(path.join(actionRoot, unknownId));
      await access(path.join(actionRoot, ownerlessId));
      await assert.rejects(access(path.join(actionRoot, reusedId)), { code: "ENOENT" });
      assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "outside-safe");
      first.kill("SIGKILL");
      if (first.exitCode === null && first.signalCode === null) await new Promise((resolve) => first.once("exit", resolve));
      assert.match(await readFile(path.join(liveDir, "server.mjs"), "utf8"), /old-private-secret/);
      const serverEntry = path.join(projectDir, "server", "index.ts");
      const serverSource = await readFile(serverEntry, "utf8");
      await writeFile(serverEntry, "export default ???");
      const failedBuild = await runCli(["dev", "--json"], { cwd: projectDir });
      assert.notEqual(failedBuild.code, 0);
      await assert.rejects(access(liveDir), { code: "ENOENT" });
      await writeFile(serverEntry, serverSource);
      second = startCli(["dev", "--json"], { cwd: projectDir });
      await waitForJsonEvent(second, (event) => event.data?.event === "started");
      await assert.rejects(access(liveDir), { code: "ENOENT" });
      await access(path.join(actionRoot, unknownId));
      await access(path.join(actionRoot, ownerlessId));
      assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "outside-safe");
    } finally {
      if (first.exitCode === null && first.signalCode === null) { first.kill("SIGKILL"); await new Promise((resolve) => first.once("exit", resolve)); }
      if (second && second.exitCode === null && second.signalCode === null) { second.kill("SIGTERM"); await new Promise((resolve) => second.once("exit", resolve)); }
    }
  });
});


test("active-reference rollback failure preserves the referenced candidate and matching legacy Bundles", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "reference-island", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "reference-island");
    await installFakeReact(projectDir);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    await createBundle(projectDir, config);

    const clientPath = path.join(projectDir, "client", "index.tsx");
    const source = await readFile(clientPath, "utf8");
    await writeFile(clientPath, source.replace("Blank Sporades Capsule", "Recoverable Candidate Capsule"));
    let failRestoreOnce = true;
    const candidate = await createBundle(projectDir, config, {
      publishLegacy: false,
      activeReferenceFault: (event) => {
        if (event === "before-active-restore" && failRestoreOnce) {
          failRestoreOnce = false;
          throw new Error("injected active-reference restore failure");
        }
      },
    });
    const rollback = await candidate.publishLegacy();
    await assert.rejects(rollback(), (error) => (
      error.message === "Active public tree recovery is incomplete."
      && error.diagnostics.candidateDiscard === "forbidden"
    ));
    const activePath = path.join(projectDir, ".sporades", "build", ".public-trees", "active.json");
    assert.equal(JSON.parse(await readFile(activePath, "utf8")).tree, path.basename(candidate.staticFiles.publicDir));
    assert.match(await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8"), /Recoverable Candidate Capsule/);
    await access(candidate.staticFiles.publicDir);
    await assert.rejects(discardPublicTree(candidate.staticFiles.publicTree), (error) => error.diagnostics.candidateDiscard === "forbidden");
    await rm(activePath);
    await mkdir(activePath);
    await assert.rejects(rollback(), (error) => error.diagnostics.candidateDiscard === "forbidden");
    await assert.rejects(cleanupPublicTrees(path.join(projectDir, ".sporades", "build")), /Public tree cleanup degraded/);
    await access(candidate.staticFiles.publicDir);
    assert.match(await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8"), /Recoverable Candidate Capsule/);
  });
});


test("sporades auth clients --json lists no connected browser clients", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = { providers: { anonymous: true, email: true } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const listed = await runCli(["auth", "clients", "--json"], { cwd: projectDir });
      assert.equal(listed.code, 0, listed.stderr);
      assert.deepEqual(JSON.parse(listed.stdout), {
        ok: true,
        data: {
          clients: [],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades auth as email returns a structured error when identity details are invalid", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const result = await runCli(["auth", "as", "email", "--json"], { cwd: projectDir });
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Simulated identity requires an email address.",
          hint: "Pass `--email <address>` to `sporades auth as email`.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev streams rebuild failure events and keeps serving the last client bundle", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      const lastSuccessfulClient = await clientResponse.text();
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      const publicTreesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
      const activeTreeName = (await readdir(publicTreesDir)).find((name) => !name.startsWith(".") && name !== "active.json");
      const activeClientPath = path.join(publicTreesDir, activeTreeName, "client.js");
      const lastSuccessfulPublic = await readFile(activeClientPath, "utf8");

      await rm(clientPath);

      const failed = await waitForJsonEvent(
        child,
        (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed",
      );
      assert.match(failed.error.message, /Missing client entry: client\/index\.tsx/);
      assert.equal(failed.error.hint, "Run `sporades create` to scaffold a new project.");
      assert.deepEqual(failed.data.build, { phase: "client", framework: "react", toolchain: "esbuild" });

      const afterFailureResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(afterFailureResponse.status, 200);
      assert.equal(await afterFailureResponse.text(), lastSuccessfulClient);
      assert.equal(await readFile(activeClientPath, "utf8"), lastSuccessfulPublic);

      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Recovered Todos"));
      const recovered = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.deepEqual(recovered.data.build, { phase: "client", framework: "react", toolchain: "esbuild" });
      assert.match(await (await fetch(`${started.data.url}/client.js`)).text(), /Sporades Recovered Todos/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev reloads sporades.json on rebuild failure and keeps the last Runtime", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authBefore = await readSocketMessage(socket);

      config.auth = {
        providers: {
          anonymous: true,
          google: {
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
        },
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const failed = await waitForJsonEvent(
        child,
        (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed",
      );
      assert.equal(failed.error.message, "Google auth is not fully configured.");
      assert.equal(
        failed.error.hint,
        "Run `sporades auth set google --client-id <id> --client-secret <secret>` or use `--client-json <path>`.",
      );

      socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(socket);
      assert.equal(authAfter.data.sessionToken, authBefore.data.sessionToken);
      assert.deepEqual(authAfter.data.auth, authBefore.data.auth);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev applies an additive table migration without losing existing Capsule data", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let migratedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;

      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "todos-before",
        type: "query.result",
        query: "todos",
        data: [],
        error: null,
      });

      socket.send(JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      assert.deepEqual(
        (await readSocketMessage(socket)).data.map((todo) => todo.text),
        ["Keep me"],
      );

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      const pendingSchemaRebuild = Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      await writeFile(
        serverPath,
        originalServer
          .replace(
            "todos: table({",
            `notes: table({
      text: String(),
      ownerId: String(),
    }),
    todos: table({`,
          )
          .replace(
            "todos: query((ctx) =>",
            `notes: query((ctx) =>
      ctx.db.notes
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),

    todos: query((ctx) =>`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `addNote: mutation((ctx, text: string) => {
      ctx.db.notes.insert({ text, ownerId: ctx.auth.userId });
    }),

    addTodo: mutation((ctx, text: string) => {`,
          ),
      );

      const [rebuilt] = await pendingSchemaRebuild;
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(
        (await readSocketMessage(migratedSocket)).data.map((todo) => todo.text),
        ["Keep me"],
      );

      migratedSocket.send(JSON.stringify({ id: "notes-before", type: "query.subscribe", query: "notes" }));
      assert.deepEqual(await readSocketMessage(migratedSocket), {
        id: "notes-before",
        type: "query.result",
        query: "notes",
        data: [],
        error: null,
      });

      migratedSocket.send(
        JSON.stringify({ id: "add-note", type: "mutation.run", mutation: "addNote", args: ["New table works"] }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const notesAfter = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "notes-before" &&
          message.type === "query.result" &&
          message.query === "notes" &&
          message.data.length === 1,
      );
      assert.equal(notesAfter.data[0].text, "New table works");
      assert.equal(typeof notesAfter.data[0].id, "string");
      assert.equal(typeof notesAfter.data[0].createdAt, "string");
      assert.equal(typeof notesAfter.data[0].updatedAt, "string");

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.ok(systemRows.find((row) => row.key === "schemaHash")?.value);
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"notes"/);
      assert.deepEqual(tables.find((table) => table.name === "notes").columns, [
        "id",
        "createdAt",
        "updatedAt",
        "text",
        "ownerId",
      ]);
    } finally {
      migratedSocket?.close();
      socket?.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("sporades dev creates app tables from imported and shared Capsule field definitions", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "composed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "composed-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    await writeFile(
      path.join(projectDir, "server", "schema.ts"),
      `import { Boolean, Date, String } from "sporades/server";

export const ownershipFields = {
  ownerId: String(),
};

export const todoFields = {
  text: String(),
  done: Boolean().default(false),
  ...ownershipFields,
  dueAt: Date().default("2026-07-03T12:00:00.000Z"),
};
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, table } from "sporades/server";
import { todoFields } from "./schema";

export default capsule({
  name: "composed-island",

  schema: {
    todos: table(todoFields),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(tables.find((table) => table.name === "todos").columns, [
        "id",
        "createdAt",
        "updatedAt",
        "text",
        "done",
        "ownerId",
        "dueAt",
      ]);
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"dueAt"/);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("sporades dev rejects unsupported Capsule schema changes with a structured rebuild error", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(serverPath, originalServer.replace("done: Boolean().default(false),", "done: String(),"));

      const failed = await waitForJsonEvent(
        child,
        (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed",
      );
      assert.deepEqual(failed, {
        ok: false,
        data: {
          event: "rebuild",
          status: "failed",
          url: failed.data.url,
          port: failed.data.port,
        },
        error: {
          message: "Unsupported Capsule schema change.",
          hint: "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        },
      });
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});


test("a scaffolded capsule can add and read todos over WebSocket", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      const socket = await openSocket(started.data.url);
      // Mutation results and query refreshes can arrive in one socket turn.
      // Keep both even while the test is asserting the first response.
      const messages = captureSocketMessages(socket);
      try {
        socket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
        assert.deepEqual(await messages.next(message => message.id === "query-1"), {
          id: "query-1",
          type: "query.result",
          query: "todos",
          data: [],
          error: null,
        });

        socket.send(JSON.stringify({ id: "mutation-1", type: "mutation.run", mutation: "addTodo", args: ["Buy milk"] }));
        assert.deepEqual(await messages.next(message => message.id === "mutation-1"), {
          id: "mutation-1",
          type: "mutation.result",
          mutation: "addTodo",
          data: null,
          error: null,
        });

        const refreshed = await messages.next(message => message.id === "query-1");
        assert.equal(refreshed.id, "query-1");
        assert.equal(refreshed.type, "query.result");
        assert.equal(refreshed.query, "todos");
        assert.equal(refreshed.error, null);
        assert.equal(refreshed.data.length, 1);
        assert.equal(refreshed.data[0].text, "Buy milk");
        assert.equal(refreshed.data[0].done, false);
        assert.equal(typeof refreshed.data[0].id, "string");
        assert.equal(typeof refreshed.data[0].createdAt, "string");
        assert.equal(typeof refreshed.data[0].updatedAt, "string");

        const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
        assert.equal(dumpResult.code, 0, dumpResult.stderr);
        const todosTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "todos");
        assert.deepEqual(todosTable.columns, ["id", "createdAt", "updatedAt", "text", "done", "ownerId"]);
        assert.equal(todosTable.rows[0].text, "Buy milk");
        assert.equal(todosTable.rows[0].done, 0);
      } finally {
        messages.dispose();
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("query unsubscribe is connection-owned, idempotent, validated, and prevents accumulated mutation refreshes", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "unsubscribe-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "unsubscribe-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let owner;
    let other;
    try {
      const started = await waitForJsonLine(child);
      owner = await openSocket(started.data.url);
      other = await openSocket(started.data.url);

      owner.send(JSON.stringify({ id: "owned", type: "query.subscribe", query: "todos" }));
      assert.equal((await readSocketMessage(owner)).id, "owned");

      other.send(JSON.stringify({ id: "foreign", type: "query.unsubscribe", subscriptionId: "owned" }));
      assert.deepEqual(await readSocketMessage(other), {
        id: "foreign",
        type: "query.unsubscribe.result",
        data: { removed: false },
        error: null,
      });

      for (let index = 0; index < 3; index += 1) {
        const subscriptionId = `cycle-${index}`;
        owner.send(JSON.stringify({ id: subscriptionId, type: "query.subscribe", query: "todos" }));
        assert.equal((await readSocketMessage(owner)).id, subscriptionId);
        owner.send(JSON.stringify({ id: `remove-${index}`, type: "query.unsubscribe", subscriptionId }));
        assert.deepEqual(await readSocketMessage(owner), {
          id: `remove-${index}`,
          type: "query.unsubscribe.result",
          data: { removed: true },
          error: null,
        });
      }

      owner.send(JSON.stringify({ id: "duplicate", type: "query.unsubscribe", subscriptionId: "cycle-0" }));
      assert.deepEqual((await readSocketMessage(owner)).data, { removed: false });
      owner.send(JSON.stringify({ id: "malformed", type: "query.unsubscribe", subscriptionId: { nope: true } }));
      assert.deepEqual(await readSocketMessage(owner), {
        id: "malformed",
        type: "error",
        data: null,
        error: {
          message: "Invalid query unsubscribe request.",
          hint: "Use the string or numeric subscription ID returned by query.subscribe.",
        },
      });

      other.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["one refresh"] }));
      assert.equal((await readSocketMessage(other)).id, "add");
      assert.equal((await readSocketMessage(owner)).id, "owned");
      await new Promise((resolve) => setTimeout(resolve, 50));
      owner.send(JSON.stringify({ id: "after-refresh", type: "auth.get" }));
      assert.equal((await readSocketMessage(owner)).id, "after-refresh", "removed subscriptions leave no queued duplicate refreshes");

      owner.send(JSON.stringify({ id: "remove-owned", type: "query.unsubscribe", subscriptionId: "owned" }));
      assert.deepEqual((await readSocketMessage(owner)).data, { removed: true });
      owner.send(JSON.stringify({ id: "remove-owned-again", type: "query.unsubscribe", subscriptionId: "owned" }));
      assert.deepEqual((await readSocketMessage(owner)).data, { removed: false });
    } finally {
      owner?.close();
      other?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("app messages reject reserved names and client-origin app-wide broadcasts", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "message-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "message-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message } from "sporades/server";

export default capsule({
  name: "message-island",

  messages: {
    broadcast: message((ctx, data) => {
      ctx.messages.send({ type: "notice", data, scope: { scope: "all" } });
    }),
    reservedOutbound: message((ctx) => {
      ctx.messages.send({ type: "query.result", data: null });
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "reserved-inbound", type: "app.send", message: "app.typing", data: null }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "reserved-inbound",
        type: "app.result",
        message: "app.typing",
        data: null,
        error: {
          message: "Reserved app message type: app.typing",
          hint: "Use an unprefixed app message type that does not start with a Sporades platform namespace.",
        },
      });

      socket.send(JSON.stringify({ id: "reserved-auth", type: "app.send", message: "auth.session.replace", data: null }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "reserved-auth",
        type: "app.result",
        message: "auth.session.replace",
        data: null,
        error: {
          message: "Reserved app message type: auth.session.replace",
          hint: "Use an unprefixed app message type that does not start with a Sporades platform namespace.",
        },
      });

      socket.send(JSON.stringify({ id: "broadcast", type: "app.send", message: "broadcast", data: { text: "hi" } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "broadcast",
        type: "app.result",
        message: "broadcast",
        data: null,
        error: {
          message: "Client-origin app messages cannot broadcast to all clients.",
          hint: "Use the default current-user scope or an explicit users scope authorized by the message handler.",
        },
      });

      socket.send(JSON.stringify({ id: "reserved-outbound", type: "app.send", message: "reservedOutbound" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "reserved-outbound",
        type: "app.result",
        message: "reservedOutbound",
        data: null,
        error: {
          message: "Reserved app message type: query.result",
          hint: "Use an unprefixed app message type that does not start with a Sporades platform namespace.",
        },
      });
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev runs Capsule pre and post mutation hooks around WebSocket mutations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "hook-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "hook-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "AUDIT_PREFIX=hooked\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "hook-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },

  hooks: {
    beforeMutation: [
      ({ name, args, ctx }) => {
        if (name === "addTodo" && args[0] === "blocked") {
          throw Object.assign(new Error("Todo text is blocked."), {
            hint: "Choose different todo text and retry the mutation.",
          });
        }
        if (!ctx.auth.userId || ctx.env.AUDIT_PREFIX !== "hooked") {
          throw new Error("Hook context was incomplete.");
        }
      },
    ],
    afterMutation: [
      ({ name, args, ctx, result }) => {
        if (args[0] === "explode") {
          throw Object.assign(new Error("Audit hook failed."), {
            hint: "Fix the audit hook and retry the mutation.",
          });
        }
        ctx.db.auditLogs.insert({
          text: ctx.env.AUDIT_PREFIX + ":" + name + ":" + args[0] + ":" + result.ok,
          ownerId: ctx.auth.userId,
        });
      },
    ],
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(JSON.stringify({ id: "audits", type: "query.subscribe", query: "auditLogs" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "blocked", type: "mutation.run", mutation: "addTodo", args: ["blocked"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "blocked",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "Todo text is blocked.",
          hint: "Choose different todo text and retry the mutation.",
        },
      });

      const allowedResult = waitForSocketMessage(
        socket,
        (message) => message.id === "allowed" && message.type === "mutation.result",
      );
      const todosRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.type === "query.result" && message.data.length === 1,
      );
      const auditRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "audits" && message.type === "query.result" && message.data.length === 1,
      );
      socket.send(JSON.stringify({ id: "allowed", type: "mutation.run", mutation: "addTodo", args: ["allowed"] }));
      assert.deepEqual(await allowedResult, {
        id: "allowed",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const todos = await todosRefresh;
      assert.equal(todos.data[0].text, "allowed");

      const auditLogs = await auditRefresh;
      assert.equal(auditLogs.data[0].text, "hooked:addTodo:allowed:true");

      socket.send(JSON.stringify({ id: "explode", type: "mutation.run", mutation: "addTodo", args: ["explode"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "explode",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "Audit hook failed.",
          hint: "Fix the audit hook and retry the mutation.",
        },
      });

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "todos").rows.map((row) => row.text),
        ["allowed"],
      );
      assert.deepEqual(
        tables.find((table) => table.name === "auditLogs").rows.map((row) => row.text),
        ["hooked:addTodo:allowed:true"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("WebSocket upgrade requires a page-bound connection token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      const response = await readWebSocketUpgradeResponse(started.data.url);
      assert.match(response, /^HTTP\/1\.1 403 Forbidden/);

      const socket = await openSocket(started.data.url);
      socket.close();
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});


test("sporades dev enforces public URL expiry choices, ownership, and replacement cache busting", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "file-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let ownerSocket;
    let otherSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      ownerSocket = await openSocket(started.data.url);
      ownerSocket.send(JSON.stringify({ id: "owner-auth", type: "auth.get" }));
      const ownerAuth = await waitForSocketMessage(ownerSocket, (message) => message.id === "owner-auth");

      ownerSocket.send(
        JSON.stringify({
          id: "upload-url",
          type: "file.uploadUrl",
          file: { name: "hello.txt", type: "text/plain", size: 5 },
        }),
      );
      const uploadUrl = await waitForSocketMessage(ownerSocket, (message) => message.id === "upload-url");
      await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
        method: uploadUrl.data.method,
        body: "hello",
      });

      ownerSocket.send(JSON.stringify({ id: "fresh-private", type: "file.url", fileId: uploadUrl.data.file.id }));
      const privateUrl = await waitForSocketMessage(ownerSocket, (message) => message.id === "fresh-private");
      assert.equal(privateUrl.error, null);
      assert.match(privateUrl.data.url, /^\/__sporades\/files\/private\//);
      assert.doesNotMatch(privateUrl.data.url, /sessionToken/);
      assert.equal(privateUrl.data.url.includes(ownerAuth.data.sessionToken), false);
      assert.doesNotMatch(privateUrl.data.file.path, /sessionToken/);
      assert.equal(privateUrl.data.file.path.includes(ownerAuth.data.sessionToken), false);

      otherSocket = await openSocket(started.data.url);
      otherSocket.send(JSON.stringify({ id: "other-auth", type: "auth.get" }));
      const otherAuth = await waitForSocketMessage(otherSocket, (message) => message.id === "other-auth");
      otherSocket.send(JSON.stringify({ id: "other-private", type: "file.url", fileId: uploadUrl.data.file.id }));
      const otherPrivate = await waitForSocketMessage(otherSocket, (message) => message.id === "other-private");
      assert.equal(otherPrivate.type, "error");
      assert.equal(otherPrivate.error.message, "File not found.");
      const unauthorizedRead = await fetch(new URL(privateUrl.data.url, started.data.url), {
        headers: { "x-sporades-session-token": otherAuth.data.sessionToken },
      });
      assert.equal(unauthorizedRead.status, 404);

      ownerSocket.send(
        JSON.stringify({
          id: "public-missing-expiry",
          type: "file.publicUrl.create",
          fileId: uploadUrl.data.file.id,
          options: {},
        }),
      );
      const missingExpiry = await waitForSocketMessage(ownerSocket, (message) => message.id === "public-missing-expiry");
      assert.equal(missingExpiry.type, "error");
      assert.equal(missingExpiry.error.message, "Public file URLs require exactly one expiry choice.");

      ownerSocket.send(
        JSON.stringify({
          id: "public-url",
          type: "file.publicUrl.create",
          fileId: uploadUrl.data.file.id,
          options: { ttlSeconds: 60 },
        }),
      );
      const publicUrl = await waitForSocketMessage(ownerSocket, (message) => message.id === "public-url");
      assert.equal(publicUrl.error, null);
      assert.match(publicUrl.data.publicUrl.url, /^\/__sporades\/files\/public\//);
      const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
      assert.equal(publicRead.status, 200);
      assert.equal(await publicRead.text(), "hello");

      ownerSocket.send(
        JSON.stringify({
          id: "replace-url",
          type: "file.uploadUrl",
          replace: true,
          fileId: uploadUrl.data.file.id,
          file: { name: "goodbye.txt", type: "text/plain", size: 7 },
        }),
      );
      const replaceUrl = await waitForSocketMessage(ownerSocket, (message) => message.id === "replace-url");
      const replaceResponse = await fetch(new URL(replaceUrl.data.uploadUrl, started.data.url), {
        method: replaceUrl.data.method,
        body: "goodbye",
      });
      assert.equal(replaceResponse.status, 200);
      const replaced = await replaceResponse.json();
      assert.equal(replaced.data.file.id, uploadUrl.data.file.id);
      assert.equal(replaced.data.file.name, "goodbye.txt");
      assert.equal(replaced.data.file.size, 7);
      assert.notEqual(replaced.data.file.version, uploadUrl.data.file.version);

      const stalePrivateRead = await fetch(new URL(privateUrl.data.url, started.data.url), {
        headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
      });
      assert.equal(stalePrivateRead.status, 404);
      const stalePublicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
      assert.equal(stalePublicRead.status, 404);

      ownerSocket.send(JSON.stringify({ id: "next-private", type: "file.url", fileId: uploadUrl.data.file.id }));
      const nextPrivate = await waitForSocketMessage(ownerSocket, (message) => message.id === "next-private");
      const nextRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
        headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
      });
      assert.equal(nextRead.status, 200);
      assert.equal(await nextRead.text(), "goodbye");

      ownerSocket.send(JSON.stringify({ id: "delete", type: "file.delete", fileId: uploadUrl.data.file.id }));
      const deleted = await waitForSocketMessage(ownerSocket, (message) => message.id === "delete");
      assert.equal(deleted.error, null);
      const deletedRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
        headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
      });
      assert.equal(deletedRead.status, 404);
    } finally {
      ownerSocket?.close();
      otherSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
