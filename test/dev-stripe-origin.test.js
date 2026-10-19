import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createBundle } from "../dist/bundle-pipeline.js";

const execute = promisify(execFile);
const root = path.resolve(".");
const cli = path.join(root, "bin/sporades.js");
const variable = "SPORADES_DEV_STRIPE_API_ORIGIN";
async function run(args, options = {}) {
  try {
    const execution = execute(process.execPath, [cli, ...args], {
      cwd: root, ...options,
      env: { ...process.env, SPORADES_CONFIG_DIR: path.join(root, ".scratch/issue-265-config"), ...options.env },
      timeout: 20000,
    });
    if (options.input !== undefined) execution.child.stdin.end(options.input);
    const result = await execution;
    return { ...result, code: 0 };
  } catch (error) { return error; }
}

test("loopback Stripe override refuses deploy and Host commands before external contact", async () => {
  for (const args of [["deploy"], ["deploy", "restart"], ["host", "push"], ["host", "start"], ["host", "restart"], ["host", "rollback"], ["host", "invoke"]]) {
    const result = await run([...args, "--json"], { env: { [variable]: "http://127.0.0.1:52345" } });
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "STRIPE_TEST_ORIGIN_DEV_ONLY", result.stdout);
  }
});

test("Dev origin admits only exact literal loopback origins with an explicit port", async () => {
  const { resolveDevStripeApiOrigin } = await import("../dist/cli/dev-stripe-origin.js");
  const previous = process.env[variable];
  try {
    for (const value of ["", " ", "http://127.0.0.1:52345\n", "http://localhost:52345", "http://127.1:52345", "http://127.0.0.2:52345", "http://2130706433:52345", "https://api.stripe.com:443", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:52345/", "http://127.0.0.1:52345/path", "http://127.0.0.1:52345?", "http://127.0.0.1:52345#", "http://user:secret@127.0.0.1:52345", "http://127.0.0.1:52345\\path", " http://127.0.0.1:52345", "ftp://127.0.0.1:52345"]) {
      process.env[variable] = value;
      assert.throws(() => resolveDevStripeApiOrigin(), { code: "STRIPE_API_ORIGIN_INVALID" }, value);
    }
    for (const value of ["http://127.0.0.1:52345", "https://[::1]:52345", "http://[::1]:80", "https://127.0.0.1:443"]) {
      process.env[variable] = value;
      assert.equal(resolveDevStripeApiOrigin(), value);
    }
    delete process.env[variable];
    assert.equal(resolveDevStripeApiOrigin(), undefined);
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});

test("Dev override refuses live mode and every secret outside sk_test without leaking it", async () => {
  const { validateDevStripeRuntime } = await import("../dist/cli/dev-stripe-origin.js");
  const previous = process.env[variable];
  process.env[variable] = "http://127.0.0.1:52345";
  try {
    for (const [livemode, secret] of [[true, "sk_test_fixture"], [true, "sk_live_fixture"], [false, "sk_live_fixture"], [false, "rk_live_fixture"], [false, "rk_test_fixture"], [false, undefined]]) {
      assert.throws(() => validateDevStripeRuntime({ stripe: { enabled: true, livemode, secretKeyEnv: "KEY" } }, { KEY: secret }), error => {
        assert.equal(error.code, "STRIPE_TEST_ORIGIN_LIVE_MODE");
        assert.doesNotMatch(error.message + error.hint, /fixture|52345/);
        return true;
      });
    }
    assert.equal(validateDevStripeRuntime({ stripe: { enabled: true, livemode: false, secretKeyEnv: "KEY" } }, { KEY: "sk_test_fixture" }), process.env[variable]);
    assert.equal(validateDevStripeRuntime(undefined, {}), process.env[variable]);
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});

async function fixture(t) {
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".scratch/stripe-origin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await run(["create", "billing", "--framework", "vanilla", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr);
  const project = path.join(dir, "billing");
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await symlink(root, path.join(project, "node_modules/sporades"), "dir");
  const config = JSON.parse(await readFile(path.join(project, "sporades.json"), "utf8"));
  config.dev.port = 0;
  config.auth = { providers: { anonymous: true, email: true } };
  config.payments = { stripe: { enabled: true, secretKeyEnv: "STRIPE_KEY", webhookSecretEnv: "STRIPE_WEBHOOK", publicOrigin: "https://billing.example.test", callbackPath: "/stripe/webhook", apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 1000 } };
  await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
  for (const [key, value] of [["STRIPE_KEY", "sk_test_fixture"], ["STRIPE_WEBHOOK", "whsec_fixture"]]) {
    assert.equal((await run(["env", "set", key, "--stdin", "--json"], { cwd: project, input: value + "\n" })).code, 0);
  }
  return { project, config };
}

function jsonEvent(child, predicate) {
  return new Promise((resolve, reject) => {
    let pending = "", stderr = "";
    const timer = setTimeout(() => done(new Error(`Dev event timeout: ${pending} ${stderr}`)), 20000);
    const onError = chunk => { stderr += chunk; };
    const onExit = code => done(new Error(`Dev exited ${code}: ${pending} ${stderr}`));
    const onData = chunk => {
      pending += chunk;
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (predicate(event)) return done(null, event);
        if (!event.ok) return done(new Error(JSON.stringify(event)));
      }
    };
    function done(error, result) {
      clearTimeout(timer); child.stdout.off("data", onData); child.stderr.off("data", onError); child.off("exit", onExit);
      if (error) reject(error); else resolve(result);
    }
    child.stdout.on("data", onData); child.stderr.on("data", onError); child.once("exit", onExit);
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function socketCall(socket, payload) {
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error(`Socket timeout ${payload.id}`)); }, 10000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== payload.id) return;
      clearTimeout(timer); socket.removeEventListener("message", receive); resolve(message);
    }
    socket.addEventListener("message", receive);
  });
  socket.send(JSON.stringify(payload));
  return result;
}

for (const host of ["127.0.0.1", "::1"]) {
test(`CLI Dev Checkout uses the ${host} loopback stub after start and rebuild; Bundle and doctor stay redacted`, { timeout: 60000 }, async t => {
  const { project, config } = await fixture(t);
  const warningFailure = path.join(path.dirname(project), "fail-stripe-warning");
  const warningAttempt = path.join(path.dirname(project), "stripe-warning-attempted");
  const preload = path.join(path.dirname(project), "stripe-warning-failure.cjs");
  await writeFile(preload, `const fs = require("node:fs");
const append = fs.appendFileSync;
fs.appendFileSync = function(file, data, ...args) {
  if (String(data).includes('"event":"payments.stripe.test_origin_active"') && fs.existsSync(${JSON.stringify(warningFailure)})) {
    fs.writeFileSync(${JSON.stringify(warningAttempt)}, "attempted");
    throw Object.assign(new Error("fixture warning write failed"), { code: "ENOSPC" });
  }
  return append.call(this, file, data, ...args);
};
require("node:module").syncBuiltinESMExports();
`);
  const requests = [];
  const provider = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body, authorization: request.headers.authorization });
    const params = new URLSearchParams(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `cs_test_local_${requests.length}`, object: "checkout.session", mode: "subscription", livemode: false,
      client_reference_id: params.get("client_reference_id"), expires_at: Number(params.get("expires_at")),
      url: `https://checkout.stripe.com/c/pay/cs_test_local_${requests.length}` }));
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, host, resolve); });
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const origin = `http://${host === "::1" ? "[::1]" : host}:${provider.address().port}`;
  const source = `import { capsule, mutation } from "sporades/server";
export default capsule({ name: "billing", schema: {},
  teamBilling: { checkout: { successPath: "/success", cancelPath: "/cancel" },
    catalogue: { studio: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_test_studio" }, live: { priceId: "price_live_studio" } } } },
    authorize: () => ({ allow: true }) },
  mutations: { setup: mutation(ctx => ctx.teams.create("Local test team")) }
});`;
  await writeFile(path.join(project, "server/index.ts"), source);
  const child = spawn(process.execPath, ["--require", preload, cli, "dev", "--json"], { cwd: project,
    env: { ...process.env, SPORADES_CONFIG_DIR: path.join(root, ".scratch/issue-265-config"), [variable]: origin }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stop(child));
  const started = await jsonEvent(child, event => event.data?.event === "started");
  assert.equal(started.data.payments?.stripe.providerOrigin, "loopback-test");
  assert.ok(!JSON.stringify(started).includes(origin));
  const session = JSON.parse(await readFile(path.join(project, ".sporades/dev-session.json"), "utf8"));
  const health = await (await fetch(`${started.data.url}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": session.inspectionToken } })).json();
  assert.equal(health.data.runtime.payments.stripe.providerOrigin, "loopback-test");
  const doctor = await run(["doctor", "--session", "dev", "--json"], { cwd: project });
  const providerCheck = JSON.parse(doctor.stdout).data.checks.find(check => check.id === "doctor.dev.stripe-provider");
  assert.equal(providerCheck?.details.payments.stripe.providerOrigin, "loopback-test");
  const html = await (await fetch(started.data.url, { headers: { "sec-fetch-dest": "document" } })).text();
  const connectionToken = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html)[1];
  const socketUrl = new URL("/__sporades/ws", started.data.url); socketUrl.searchParams.set("connectionToken", connectionToken);
  let socket = new WebSocket(socketUrl);
  await once(socket, "open"); t.after(() => socket.close());
  const signup = await socketCall(socket, { id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "local@example.test", password: "fixture-password-123", name: "Local" } });
  assert.equal(signup.error, null, JSON.stringify(signup));
  for (const [index, requestId] of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].entries()) {
    if (index) {
      const rebuilt = jsonEvent(child, event => event.data?.event === "rebuild" && event.data?.status === "success");
      await writeFile(warningFailure, "");
      await writeFile(path.join(project, "server/index.ts"), source + "\n// rebuild\n");
      await rebuilt;
      assert.equal(await readFile(warningAttempt, "utf8"), "attempted", "replacement warning write failure was exercised");
      socket.close();
      const nextHtml = await (await fetch(started.data.url, { headers: { "sec-fetch-dest": "document" } })).text();
      socketUrl.searchParams.set("connectionToken", /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(nextHtml)[1]);
      socket = new WebSocket(socketUrl); await once(socket, "open");
    }
    const setup = await socketCall(socket, { id: `setup-${index}`, type: "mutation.run", mutation: "setup", args: [], sessionToken: signup.data.sessionToken });
    assert.equal(setup.error, null, JSON.stringify(setup));
    const result = await socketCall(socket, { id: `checkout-${index}`, type: "teamBilling.startCheckout", sessionToken: signup.data.sessionToken, input: { teamId: setup.data.team.id, productKey: "studio", requestId } });
    assert.equal(result.error, null, JSON.stringify(result));
    const deadline = Date.now() + 5000;
    while (requests.length <= index && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(requests.length, index + 1);
    assert.equal(requests[index].url, "/v1/checkout/sessions");
    assert.equal(requests[index].authorization, "Bearer sk_test_fixture");
    let ready = result;
    while (ready.data?.state === "pending" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      ready = await socketCall(socket, { id: `ready-${index}`, type: "teamBilling.startCheckout", sessionToken: signup.data.sessionToken,
        input: { teamId: setup.data.team.id, productKey: "studio", requestId } });
    }
    assert.equal(ready.data?.state, "ready", JSON.stringify(ready));
    assert.equal(ready.data.url, `https://checkout.stripe.com/c/pay/cs_test_local_${index + 1}`);
  }
  const failedRebuild = jsonEvent(child, event => event.data?.event === "rebuild" && event.data?.status === "failed");
  await writeFile(path.join(project, "sporades.json"), JSON.stringify({ ...config, payments: { stripe: { ...config.payments.stripe, livemode: true } } }));
  assert.equal((await failedRebuild).error.code, "STRIPE_TEST_ORIGIN_LIVE_MODE");
  assert.equal((await fetch(`${started.data.url}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": session.inspectionToken } })).status, 200);
  await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
  await stop(child);
  const bundle = await readFile(path.join(project, ".sporades/build/server.mjs"), "utf8");
  assert.ok(!bundle.includes(origin)); assert.ok(!bundle.includes(variable));
  const previous = process.env[variable];
  try {
    delete process.env[variable]; const normal = await createBundle(project, config);
    process.env[variable] = origin; const overridden = await createBundle(project, config);
    assert.equal(overridden.serverBundle, normal.serverBundle);
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});
}

test("CLI refusals preserve stable origin and live-mode codes before starting Dev", async t => {
  const { project, config } = await fixture(t);
  for (const value of ["", "https://api.stripe.com:443", "http://127.0.0.1:52345/path", "http://127.0.0.1:52345?token=private", "http://user:private@127.0.0.1:52345"]) {
    const result = await run(["dev", "--json"], { cwd: project, env: { [variable]: value } });
    assert.equal(JSON.parse(result.stdout).error.code, "STRIPE_API_ORIGIN_INVALID", result.stdout);
    assert.ok(!result.stdout.includes("private"));
  }
  config.payments.stripe.livemode = true;
  await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
  const result = await run(["dev", "--json"], { cwd: project, env: { [variable]: "http://127.0.0.1:52345" } });
  assert.equal(JSON.parse(result.stdout).error.code, "STRIPE_TEST_ORIGIN_LIVE_MODE", result.stdout);
  assert.doesNotMatch(result.stdout, /sk_test_fixture|52345/);
  config.payments.stripe.livemode = false;
  await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
  for (const secret of ["sk_live_fixture", "rk_live_fixture", "rk_test_fixture"]) {
    assert.equal((await run(["env", "set", "STRIPE_KEY", "--stdin", "--json"], { cwd: project, input: secret + "\n" })).code, 0);
    const refused = await run(["dev", "--json"], { cwd: project, env: { [variable]: "http://127.0.0.1:52345" } });
    assert.equal(JSON.parse(refused.stdout).error.code, "STRIPE_TEST_ORIGIN_LIVE_MODE", refused.stdout);
    assert.ok(!refused.stdout.includes(secret));
  }
});

test("dormant Public Dev accepts the override with one redacted warning", async t => {
  const { project, config } = await fixture(t);
  config.payments.stripe = { enabled: false };
  await writeFile(path.join(project, "sporades.json"), JSON.stringify(config));
  const child = spawn(process.execPath, [cli, "dev", "--public", "--json"], { cwd: project,
    env: { ...process.env, SPORADES_CONFIG_DIR: path.join(root, ".scratch/issue-265-config"), [variable]: "http://127.0.0.1:52345" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stop(child));
  const started = await jsonEvent(child, event => event.data?.event === "started");
  assert.equal(started.data.payments.stripe.providerOrigin, "loopback-test");
  const logs = JSON.parse((await run(["logs", "--json"], { cwd: project })).stdout).data.entries;
  const warnings = logs.filter(log => log.event === "payments.stripe.test_origin_active");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warn");
  assert.match(warnings[0].message, /dormant/);
  assert.doesNotMatch(JSON.stringify(warnings), /52345/);
});


test("the supported process setting stays out of project and Server env contracts", async () => {
  const { isReservedServerEnvKeyName } = await import("../dist/bundle-pipeline.js");
  const { validatePaymentsConfig } = await import("../dist/stripe-payment-config.js");
  assert.equal(isReservedServerEnvKeyName(variable), true);
  assert.throws(() => validatePaymentsConfig({ stripe: { enabled: false, stripeApiBaseUrl: "http://127.0.0.1:52345" } }));
  for (const file of ["docs/guide/configuration.md", "docs/reference/projects-and-configuration.md", "docs/reference/operations-and-hosting.md", "docs/reference/teams.md", "src/types/stripe.d.ts"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.ok(content.includes(variable), file);
    assert.match(content, /certif(?:y|ies|ying|ication|ies)[\s\S]{0,40}nothing about live Stripe/i, file);
  }
});
