import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ensureSealedServerEnvKeyPair, sealServerEnv, sealedServerEnvPaths, writeSealedServerEnv } from "../dist/sealed-server-env.js";

const root = path.resolve(import.meta.dirname, "..");
async function fixture(fn) {
  const dir = await mkdtemp(path.join(root, ".agent-tmp-required-env-"));
  await mkdir(path.join(dir, "server"));
  await writeFile(path.join(dir, "server/index.ts"), "export default { schema: {} };\n");
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function cli(dir, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, "bin/sporades.js"), ...args, "--json"], {
    cwd: dir, env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, "cli-config"), ...env }, encoding: "utf8",
  });
}
async function seal(dir, values) {
  const paths = sealedServerEnvPaths(dir);
  const keys = await ensureSealedServerEnvKeyPair(paths);
  await writeSealedServerEnv(paths, sealServerEnv(values, keys.publicKey));
}

test("doctor checks required Server env using sealed values before legacy or process env, with names only", async () => fixture(async (dir) => {
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "env-check", env: { required: ["INTAKE_URL", "EMPTY", "READY"] } }));
  await seal(dir, { READY: "never-print-this", EMPTY: "   " });
  await writeFile(path.join(dir, ".env.sporades.server"), "INTAKE_URL=legacy-secret\nEMPTY=legacy-secret\n");
  const result = cli(dir, ["doctor"], { INTAKE_URL: "process-secret" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const check = JSON.parse(result.stdout).data.checks.find((check) => check.id === "doctor.required-server-env");
  assert.equal(check.status, "fail");
  assert.deepEqual(check.details.missingKeys, ["EMPTY", "INTAKE_URL"]);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-this|legacy-secret|process-secret/);
  await seal(dir, { READY: "never-print-this", EMPTY: "set", INTAKE_URL: "set" });
  const healthy = cli(dir, ["doctor"]);
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
}));

test("host push refuses missing sealed required env before any Host contact and accepts the explicit override", async () => fixture(async (dir) => {
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "env-check", env: { required: ["INTAKE_URL"] } }));
  // The refusal must precede even Host-profile resolution and bundling.
  const denied = cli(dir, ["host", "push"]);
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /Missing required Server env: INTAKE_URL/);
  assert.match(denied.stdout, /--allow-missing-env/);
  const override = cli(dir, ["host", "push", "--allow-missing-env"]);
  assert.equal(override.status, 1);
  assert.doesNotMatch(override.stdout, /Missing required Server env|Unknown flag/);
  assert.match(override.stdout, /Host profile/i);
}));

test("runtime logs one names-only boot error, continues by default, and failClosed refuses before database creation", async () => fixture(async (dir) => {
  const runtimeUrl = new URL("../dist/server-runtime-source.js", import.meta.url).href;
  const databasePath = path.join(dir, "data.db");
  const program = `import { openDevDatabase, shutdownAndCloseDatabase } from ${JSON.stringify(runtimeUrl)};
    try {
      const db = await openDevDatabase(${JSON.stringify(databasePath)}, '', { READY: 'secret-value-never-log' },
        { name: 'env-boot', env: { required: ['READY', 'MISSING', 'MISSING'], failClosed: process.argv[1] === 'closed' } });
      await shutdownAndCloseDatabase(db);
      process.stdout.write('started');
    } catch (error) { process.stdout.write(error.code); process.exitCode = 1; }`;
  const run = (mode) => spawnSync(process.execPath, ["--input-type=module", "-e", program, mode], { encoding: "utf8", env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'cli-config') } });
  const closed = run("closed");
  assert.equal(closed.status, 1, closed.stdout + closed.stderr);
  assert.equal(closed.stdout, "MISSING_REQUIRED_SERVER_ENV");
  await assert.rejects(readFile(databasePath), { code: "ENOENT" });
  const permissive = run("open");
  assert.equal(permissive.status, 0, permissive.stdout + permissive.stderr);
  assert.equal(permissive.stdout, "started");
  for (const result of [closed, permissive]) {
    const events = result.stderr.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "runtime.env.missing");
    assert.equal(events[0].level, "error");
    assert.deepEqual(events[0].missingKeys, ["MISSING"]);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-value-never-log/);
  }
}));

test("doctor includes SMTP, default and custom enabled webhook, and active payment env references automatically", async () => fixture(async (dir) => {
  const config = {
    name: "implied-env",
    env: { required: ["APP_URL", "SMTP_USER"] },
    mail: {
      smtp: { vendor: "generic", host: "smtp.example.test", port: 587, tls: { mode: "required-starttls" }, auth: { method: "PLAIN", usernameEnv: "SMTP_USER", passwordEnv: "SMTP_PASS" } },
      webhooks: { mailjet: {}, postmark: { secretEnv: "CALLBACK_KEY" }, mailgun: { enabled: false } },
    },
    payments: { stripe: { enabled: true, secretKeyEnv: "PAYMENT_KEY", webhookSecretEnv: "PAYMENT_CALLBACK", publicOrigin: "https://example.test", callbackPath: "/stripe", apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 1000 } },
  };
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify(config));
  const result = cli(dir, ["doctor"]);
  const check = JSON.parse(result.stdout).data.checks.find((check) => check.id === "doctor.required-server-env");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(check.details.missingKeys, ["APP_URL", "CALLBACK_KEY", "MAILJET_WEBHOOK_SECRET", "PAYMENT_CALLBACK", "PAYMENT_KEY", "SMTP_PASS", "SMTP_USER"]);
  // Implication also works with no explicit env declaration.
  delete config.env;
  config.mail.smtp.auth = { method: "none" };
  config.mail.webhooks.mailjet.enabled = false;
  config.payments.stripe = { enabled: false };
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify(config));
  const dormant = cli(dir, ["doctor"]);
  assert.deepEqual(JSON.parse(dormant.stdout).data.checks.find((check) => check.id === "doctor.required-server-env").details.missingKeys, ["CALLBACK_KEY"]);
}));

test("malformed env declarations fail opaquely; missing sealed keys never fall back to plaintext", async () => fixture(async (dir) => {
  for (const env of [null, [], true, { required: "SECRET" }, { required: ["bad\nsecret-value"] }, { required: ["SPORADES_CONTROL"] }, { required: ["__proto__"] }, { failClosed: "true" }, { typo: "secret-value" }]) {
    await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ env }));
    const result = cli(dir, ["doctor"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Invalid required Server env configuration/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-value/);
  }
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ env: { required: ["KEY"] } }));
  await seal(dir, { KEY: "secret-value" });
  await rm(sealedServerEnvPaths(dir).privateKey);
  await writeFile(path.join(dir, ".env.sporades.server"), "KEY=secret-value\n");
  const unavailable = cli(dir, ["doctor"]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /Required Server env values are unavailable/);
  assert.doesNotMatch(unavailable.stdout, /secret-value/);
  const push = cli(dir, ["host", "push"]);
  assert.equal(push.status, 1);
  assert.match(push.stdout, /Required Server env values are unavailable/);
}));

test("generated Bundle preserves permissive boot, failClosed, implied keys, and restored-env startup", async () => fixture(async (dir) => {
  const { bundleServerCapsuleModule } = await import("../dist/bundle-pipeline.js");
  const { createServerBundleModuleSource } = await import("../dist/templates/server-bundle-module-graph.js");
  const serverSource = "export default { name: 'generated-env', schema: {} };";
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(dir, "server/index.ts") });
  for (const [failClosed, populated] of [[false, false], [true, false], [true, true]]) {
    const source = await createServerBundleModuleSource({
      config: { name: "generated-env", env: { required: ["APP_URL"], failClosed }, mail: { webhooks: { postmark: {} } } },
      serverEnv: populated ? { APP_URL: "never-print-this", POSTMARK_WEBHOOK_SECRET: "never-print-this" } : {},
      serverSource, serverModuleSource,
      epilogue: "await new Promise(resolve => server.close(resolve)); await shutdownAndCloseDatabase(database); process.stdout.write('started');",
    });
    const filename = path.join(dir, "server.mjs");
    await writeFile(filename, source);
    const result = spawnSync(process.execPath, [filename], { cwd: dir, encoding: "utf8", timeout: 10000, env: {
      ...process.env, PORT: "0", SPORADES_CONFIG_DIR: path.join(dir, "cli-config"), SPORADES_LOG_STDOUT: "0",
    } });
    assert.equal(result.status, failClosed && !populated ? 1 : 0, result.stdout + result.stderr);
    const events = result.stderr.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(events.length, populated ? 0 : 1);
    if (!populated) assert.deepEqual(events[0].missingKeys, ["APP_URL", "POSTMARK_WEBHOOK_SECRET"]);
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
    if (!failClosed || populated) assert.equal(result.stdout, "started");
  }
}));
