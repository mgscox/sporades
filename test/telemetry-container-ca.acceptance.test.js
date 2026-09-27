import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.SPORADES_REAL_TELEMETRY_CA_CONTAINER === "1";

test("packed CLI exports through a private CA from a disposable Container", {
  skip: enabled ? false : "Set SPORADES_REAL_TELEMETRY_CA_CONTAINER=1 for disposable Docker acceptance.",
  timeout: 300_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-ca-container-"));
  const packageDir = path.join(root, "package");
  const configDir = path.join(root, "config");
  const projectDir = path.join(root, "ca-acceptance");
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
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=host.docker.internal", "-addext", "subjectAltName=DNS:host.docker.internal"], { timeout: 30_000 });
    const received = [];
    collector = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      for await (const _ of request) {}
      received.push(request.url);
      response.writeHead(200).end();
    }).listen(0, "0.0.0.0");
    await once(collector, "listening");
    const port = collector.address().port;
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: `https://host.docker.internal:${port}`, tls: { mode: "verified", caFile: cert }, metricsIntervalMs: 5000 },
    } }));
    const env = { ...process.env, SPORADES_CONFIG_DIR: configDir };
    const created = await run(process.execPath, [cli, "create", "ca-acceptance", "--template", "blank", "--no-install", "--no-git", "--json"], { cwd: root, env, timeout: 120_000 });
    assert.equal(JSON.parse(created.stdout.trim().split("\n").at(-1)).ok, true);
    await run("npm", ["install", "--ignore-scripts", "--package-lock=false"], { cwd: projectDir, timeout: 120_000 });
    const deployed = await run(process.execPath, [cli, "deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env, timeout: 120_000 });
    const result = JSON.parse(deployed.stdout.trim().split("\n").at(-1));
    assert.equal(result.ok, true, deployed.stderr);
    containerId = result.data.containerId;
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const staged = await readFile(binding.telemetryCaStagePath);
    assert.deepEqual(staged, await readFile(cert));
    const deadline = Date.now() + 20_000;
    while (!received.includes("/v1/metrics") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert(received.includes("/v1/metrics"), `No HTTPS metric export from Container: ${JSON.stringify(received)}`);
    await writeFile(cert, "malformed CA");
    await assert.rejects(
      run(process.execPath, [cli, "deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env, timeout: 120_000 }),
      error => { assert.match(`${error.stdout}${error.stderr}`, /Telemetry CA file is invalid/); return true; },
    );
    assert.equal((await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId])).stdout.trim(), "true");
    assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, containerId);
  } finally {
    if (containerId) await run("docker", ["rm", "-f", containerId]).catch(() => {});
    collector?.close();
    await rm(root, { recursive: true, force: true });
  }
});
