import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { telemetryAcceptancePrerequisite } from "./helpers/telemetry-acceptance.js";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.SPORADES_REAL_TELEMETRY_CA_CONTAINER === "1";
const legacyCli = process.env.SPORADES_LEGACY_CLI_PATH;

test("a real pre-descriptor Container retains its implicit telemetry after a current Dev rebuild", {
  skip: legacyCli ? false : "Set SPORADES_LEGACY_CLI_PATH to an installed pre-descriptor CLI for disposable Docker acceptance.",
  timeout: 300_000,
}, async t => {
  const missing = await telemetryAcceptancePrerequisite('legacy');
  if (missing) { t.skip(missing); return; }
  const root = await mkdtemp(path.join(tmpdir(), "sporades-legacy-container-"));
  const packageDir = path.join(root, "package");
  const configDir = path.join(root, "config");
  const capsuleName = `legacy-acceptance-${randomUUID().slice(0, 8)}`;
  const projectDir = path.join(root, capsuleName);
  let containerId;
  let collector;
  try {
    await mkdir(packageDir);
    await mkdir(configDir);
    const packed = await run("npm", ["pack", "--pack-destination", root, "--silent"], { cwd: repoRoot, timeout: 120_000 });
    await run("npm", ["install", "--prefix", packageDir, path.join(root, packed.stdout.trim()), "--ignore-scripts", "--omit=dev"], { timeout: 120_000 });
    const currentCli = path.join(packageDir, "node_modules", "sporades", "bin", "sporades.js");
    const received = [];
    collector = createHttpServer(async (request, response) => {
      for await (const _chunk of request) { /* Drain the OTLP request body. */ }
      received.push({ path: request.url, authorization: request.headers.authorization });
      response.writeHead(200).end();
    }).listen(0, "0.0.0.0");
    await once(collector, "listening");
    const port = collector.address().port;
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      old: { endpoint: `http://127.0.0.1:${port}`, tls: { mode: "loopback" }, credentialEnv: "LEGACY_TRACE_TOKEN", metricsIntervalMs: 5000 },
      next: { endpoint: `http://127.0.0.1:${port}`, tls: { mode: "loopback" }, credentialEnv: "NEXT_TRACE_TOKEN", metricsIntervalMs: 5000 },
    } }));
    const env = { ...process.env, SPORADES_CONFIG_DIR: configDir, LEGACY_TRACE_TOKEN: "original-container-token", NEXT_TRACE_TOKEN: "new-dev-token" };
    await run(process.execPath, [legacyCli, "create", capsuleName, "--template", "blank", "--no-install", "--no-git", "--json"], { cwd: root, env, timeout: 120_000 });
    await run("npm", ["install", "--ignore-scripts", "--package-lock=false"], { cwd: projectDir, timeout: 120_000 });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.telemetry = { profile: "old" };
    config.deploy = { ...config.deploy, port: await availablePort() };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const deployed = await run(process.execPath, [legacyCli, "deploy", "--json"], { cwd: projectDir, env, timeout: 120_000 });
    containerId = JSON.parse(deployed.stdout.trim().split("\n").at(-1)).data.containerId;
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.telemetryDescriptorVersion, undefined);
    const dockerEnv = JSON.parse((await run("docker", ["inspect", "--format", "{{json .Config.Env}}", containerId])).stdout);
    assert(!dockerEnv.some(value => value.startsWith("SPORADES_CONTAINER_TELEMETRY_CONFIG=")));
    await waitUntil(() => received.some(event => event.path === "/v1/metrics" && event.authorization === "Bearer original-container-token"), 20_000);
    await run(process.execPath, [legacyCli, "deploy", "stop", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    const serverPath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const originalBundle = await readFile(serverPath);
    config.telemetry = { profile: "next" };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await devBuild(currentCli, projectDir, env, []);
    assert.deepEqual(await readFile(serverPath), originalBundle);
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "false");
    const beforeRestart = received.length;
    await run(process.execPath, [currentCli, "deploy", "restart", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true");
    await waitUntil(() => received.slice(beforeRestart).some(event => event.path === "/v1/metrics" && event.authorization === "Bearer original-container-token"), 20_000);
    assert.equal(received.slice(beforeRestart).filter(event => event.path === "/v1/metrics" && event.authorization === "Bearer new-dev-token").length, 0);
  } finally {
    if (containerId) await run("docker", ["rm", "-f", containerId]).catch(() => {});
    if (collector) { collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});

test("packed CLI exports through a private CA from a disposable Container", {
  skip: enabled ? false : "Set SPORADES_REAL_TELEMETRY_CA_CONTAINER=1 for disposable Docker acceptance.",
  timeout: 300_000,
}, async t => {
  const missing = await telemetryAcceptancePrerequisite('private-ca');
  if (missing) { t.skip(missing); return; }
  const scratch = path.join(repoRoot, ".scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "sporades-ca-container-"));
  const packageDir = path.join(root, "package");
  const configDir = path.join(root, "config");
  const capsuleName = `ca-acceptance-${randomUUID().slice(0, 8)}`;
  const projectDir = path.join(root, capsuleName);
  let containerId;
  let collector;
  try {
    await mkdir(packageDir);
    await mkdir(configDir);
    const packed = await run("npm", ["pack", "--pack-destination", root, "--silent"], { cwd: repoRoot, timeout: 120_000 });
    await run("npm", ["install", "--prefix", packageDir, path.join(root, packed.stdout.trim()), "--ignore-scripts", "--omit=dev"], { timeout: 120_000 });
    const cli = path.join(packageDir, "node_modules", "sporades", "bin", "sporades.js");
    const key = path.join(root, "ca-key.pem");
    const cert = path.join(root, "ca-cert.pem");
    const collectorHost = process.env.SPORADES_ACCEPTANCE_COLLECTOR_HOST ?? "host.docker.internal";
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${collectorHost}`, "-addext", `subjectAltName=${isIP(collectorHost) ? "IP" : "DNS"}:${collectorHost}`], { timeout: 30_000 });
    const received = [];
    collector = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      if (request.url === "/__acceptance/ready") { response.writeHead(200).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const resources = (body.resourceMetrics ?? []).map(entry => Object.fromEntries(
        (entry.resource?.attributes ?? []).map(attribute => [attribute.key, attribute.value?.stringValue]),
      ));
      received.push({ path: request.url, authorization: request.headers.authorization, resources });
      response.writeHead(200).end();
    }).listen(0, "0.0.0.0");
    await once(collector, "listening");
    const port = collector.address().port;
    const { SPORADES_BASE_IMAGE } = await import("../dist/base-image.js");
    try { await run("docker", ["image", "inspect", SPORADES_BASE_IMAGE.image], { timeout: 5000 }); }
    catch { t.skip("Sporades Base image unavailable; build Dockerfile.base before private-CA Container acceptance."); return; }
    const probeName = `sporades-ca-probe-${randomUUID()}`;
    try {
      // Test Docker DNS, routing and CA trust independently of Sporades exporters.
      await run("docker", ["run", "--rm", "--name", probeName,
        "--mount", `type=bind,source=${cert},target=/ca.pem,readonly`,
        "--entrypoint", "node", SPORADES_BASE_IMAGE.image, "-e", `
          require('node:https').get(${JSON.stringify(`https://${collectorHost}:${port}/__acceptance/ready`)},
            { ca: require('node:fs').readFileSync('/ca.pem'), timeout: 5000 }, r => {
              r.resume(); if (r.statusCode !== 200) process.exitCode = 1;
            }).on('timeout', function () { this.destroy(); }).on('error', e => { console.error(e.code); process.exitCode = 1; });
        `], { timeout: 15_000 });
    } catch (error) {
      if (!error.killed && !/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET)\b/.test(error.stderr ?? '')) throw error;
      t.skip(`Docker cannot reach the disposable private-CA HTTPS collector via ${collectorHost} (DNS/routing/TLS prerequisite; ${error.killed ? "15s timeout" : String(error.stderr).trim().slice(-160)}).`);
      return;
    } finally { await run("docker", ["rm", "-f", probeName], { timeout: 5000 }).catch(() => {}); }
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: `https://${collectorHost}:${port}`, tls: { mode: "verified", caFile: cert }, credentialEnv: "TELEMETRY_ACCEPTANCE_TOKEN", metricsIntervalMs: 5000 },
    } }));
    const env = { ...process.env, SPORADES_CONFIG_DIR: configDir, TELEMETRY_ACCEPTANCE_TOKEN: "session-owned-credential" };
    const created = await run(process.execPath, [cli, "create", capsuleName, "--template", "blank", "--no-install", "--no-git", "--json"], { cwd: root, env, timeout: 120_000 });
    assert.equal(JSON.parse(created.stdout.trim().split("\n").at(-1)).ok, true);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy = { ...config.deploy, port: await availablePort() };
    await writeFile(configPath, JSON.stringify(config));
    // Acceptance must also work before the candidate version is published.
    await run("npm", ["install", "--save-dev", path.join(root, packed.stdout.trim()), "--ignore-scripts", "--package-lock=false"], { cwd: projectDir, timeout: 120_000 });
    const candidate = JSON.parse(await readFile(path.join(packageDir, "node_modules", "sporades", "package.json"), "utf8"));
    const installed = JSON.parse(await readFile(path.join(projectDir, "node_modules", "sporades", "package.json"), "utf8"));
    assert.equal(installed.version, candidate.version, "Capsule SDK must use the packed candidate");
    const deployed = await run(process.execPath, [cli, "deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env, timeout: 120_000 });
    const result = JSON.parse(deployed.stdout.trim().split("\n").at(-1));
    assert.equal(result.ok, true, deployed.stderr);
    containerId = result.data.containerId;
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const staged = await readFile(binding.telemetryCaStagePath);
    assert.deepEqual(staged, await readFile(cert));
    const deadline = Date.now() + 60_000;
    while (!received.some(event => isContainerMetric(event, capsuleName)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert(received.some(event => isContainerMetric(event, capsuleName) && event.authorization === "Bearer session-owned-credential"), "Container did not export through its original CA, credential and resource identity");
    await run(process.execPath, [cli, "deploy", "stop", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const legacyBinding = { ...binding };
    delete legacyBinding.telemetryDescriptorVersion;
    delete legacyBinding.telemetryProfile;
    delete legacyBinding.telemetryCaStagePath;
    await writeFile(bindingPath, `${JSON.stringify(legacyBinding)}\n`);
    const mountedServerBeforeDev = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"));
    await devBuild(cli, projectDir, env, []);
    assert.deepEqual(await readFile(path.join(projectDir, ".sporades", "build", "server.mjs")), mountedServerBeforeDev,
      "Dev replaced a Bundle mounted by a Container with pre-telemetry binding metadata");
    // Runtime code can mention Docker DNS without embedding an export selection.
    const serverUrl = pathToFileURL(path.join(projectDir, ".sporades", "build", "server.mjs")).href;
    const probe = await run(process.execPath, ["--input-type=module", "--eval", `
      const { sporadesConfig } = await import(${JSON.stringify(serverUrl)});
      console.log(JSON.stringify({ acceptanceConfig: sporadesConfig }));
      process.kill(process.pid, 'SIGTERM');
    `], { cwd: projectDir, env: { ...env, PORT: "0", SPORADES_DATABASE_PATH: path.join(root, "probe.db") }, timeout: 30_000 });
    const embedded = probe.stdout.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(event => event?.acceptanceConfig)?.acceptanceConfig;
    assert(embedded, "Bundle did not expose its exported configuration");
    assert.equal(embedded.__sporadesTelemetry ?? null, null, "CLI Bundle embedded a telemetry selection");
    const afterDevExit = received.length;
    await run(process.execPath, [cli, "deploy", "restart", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true");
    await waitUntil(() => received.slice(afterDevExit).some(event => isContainerMetric(event, capsuleName) && event.authorization === "Bearer session-owned-credential"), 60_000,
      () => "Restarted Container did not export with its original CA, credential and resource identity.");
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);
    const disabled = await run(process.execPath, [cli, "deploy", "--no-telemetry", "--json"], { cwd: projectDir, env, timeout: 120_000 });
    containerId = JSON.parse(disabled.stdout.trim().split("\n").at(-1)).data.containerId;
    await run(process.execPath, [cli, "deploy", "stop", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    await devBuild(cli, projectDir, env, ["--telemetry", "private"]);
    const knownDevInstances = new Set(received.flatMap(event => event.resources)
      .filter(resource => resource["deployment.environment.name"] === "dev")
      .map(resource => resource["service.instance.id"])
      .filter(id => typeof id === "string" && id.length > 0));
    const beforeDisabledRestart = received.length;
    await run(process.execPath, [cli, "deploy", "restart", "--json"], { cwd: projectDir, env, timeout: 30_000 });
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true");
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert.equal(received.slice(beforeDisabledRestart).filter(event => event.path === "/v1/metrics"
      && event.resources.some(resource => !knownDevInstances.has(resource["service.instance.id"]))).length,
    0, "disabled Container started a new metrics exporter after enabled Dev rebuilt the shared Bundle");
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true", "disabled Container stopped during the no-export observation");
    await writeFile(cert, "malformed CA");
    await assert.rejects(
      run(process.execPath, [cli, "deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env, timeout: 120_000 }),
      error => { assert.match(`${error.stdout}${error.stderr}`, /Telemetry CA file is invalid/); return true; },
    );
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true");
    assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, containerId);
  } catch (error) {
    if (containerId) {
      const state = await run("docker", ["inspect", "--format", "{{json .State}}", containerId], { timeout: 5000 }).catch(() => null);
      const logs = await run("docker", ["logs", "--tail", "30", containerId], { timeout: 5000 }).catch(() => null);
      t.diagnostic(`Disposable Container state: ${state?.stdout.trim() ?? "unavailable"}`);
      t.diagnostic(`Disposable Container logs: ${`${logs?.stdout ?? ""}${logs?.stderr ?? ""}`.slice(-8000)}`);
    }
    throw error;
  } finally {
    if (containerId) await run("docker", ["rm", "-f", containerId]).catch(() => {});
    if (collector) { collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});

function isContainerMetric(event, capsuleName) {
  return event.path === "/v1/metrics" && event.resources.some(resource =>
    resource["deployment.environment.name"] === "container" && resource["service.name"] === capsuleName
  );
}

async function devBuild(cli, projectDir, env, selection) {
  const child = spawn(process.execPath, [cli, "dev", "--port", "0", ...selection, "--json"], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let buffered = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await waitUntil(() => events.some(event => event.ok && event.data?.event === "started"), 30_000, () => stderr);
    const server = path.join(projectDir, "server", "index.ts");
    await writeFile(server, `${await readFile(server, "utf8")}\n// Trigger a Dev rebuild while the Container is stopped.\n`);
    await waitUntil(() => events.some(event => event.ok && event.data?.event === "rebuild" && event.data.status === "success"), 30_000, () => stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { await exited; } finally { clearTimeout(timer); }
      assert.notEqual(child.signalCode, "SIGKILL", "Dev did not stop within 10 seconds");
    }
  }
}

async function waitUntil(predicate, timeoutMs, diagnostics = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert(predicate(), `Timed out waiting for session event. ${diagnostics()}`);
}

async function availablePort() {
  const server = createHttpServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
