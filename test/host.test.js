import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openDevDatabase, routeRuntimeHealth } from "../src/server-runtime-source.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const hostHelperPath = path.join(repoRoot, "bin", "sporades-host-helper.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-host-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withHttpServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "::1", resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function reserveUnusedPort() {
  let port;
  await withHttpServer((request, response) => {
    response.writeHead(500);
    response.end();
  }, async (reservedPort) => {
    port = reservedPort;
  });
  return port;
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runHostHelper(input, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hostHelperPath], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function hostEnv(configDir) {
  return { SPORADES_CONFIG_DIR: configDir };
}

async function writeHostProfileConfig(configDir, config) {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "hosts.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function installFakeSsh(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "ssh-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(42);
`,
  );
  await chmod(sshPath, 0o755);

  return {
    fakeBinDir,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
    },
    async assertNotCalled() {
      await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
    },
  };
}

async function installContractFakeSsh(dir, scriptBody) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const fakeRemoteDir = path.join(dir, "fake-remote", "bin");
  const logPath = path.join(dir, "ssh-contract-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  const helperPath = path.join(fakeRemoteDir, "sporades-host-helper");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(fakeRemoteDir, { recursive: true });
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  ${scriptBody}
});
`,
  );
  await chmod(helperPath, 0o755);
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  const result = spawnSync(process.env.FAKE_REMOTE_HELPER, {
    input: stdin,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) {
    process.stderr.write(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
});
`,
  );
  await chmod(sshPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
      FAKE_REMOTE_HELPER: helperPath,
    },
  };
}

async function installFakeScp(dir) {
  const fakeBinDir = path.join(dir, "fake-scp-bin");
  const logPath = path.join(dir, "scp-calls.jsonl");
  const uploadDir = path.join(dir, "fake-uploads");
  const scpPath = path.join(fakeBinDir, "scp");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });
  await writeFile(
    scpPath,
    `#!/usr/bin/env node
const { appendFileSync, copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const source = args[0];
const target = args[1];
mkdirSync(process.env.FAKE_SCP_UPLOAD_DIR, { recursive: true });
const copiedTo = path.join(process.env.FAKE_SCP_UPLOAD_DIR, path.basename(source));
copyFileSync(source, copiedTo);
appendFileSync(process.env.FAKE_SCP_LOG, JSON.stringify({ args, source, target, copiedTo, cwd: process.cwd() }) + "\\n");
process.exit(0);
`,
  );
  await chmod(scpPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    uploadDir,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SCP_LOG: logPath,
      FAKE_SCP_UPLOAD_DIR: uploadDir,
    },
  };
}

async function installFakeDocker(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-docker-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const caddyLogPath = path.join(dir, "caddy-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  const caddyPath = path.join(fakeBinDir, "caddy");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "run") {
  process.stdout.write(process.env.FAKE_DOCKER_CONTAINER_ID || "hosted-container-1");
  process.exit(Number(process.env.FAKE_DOCKER_RUN_STATUS || "0"));
}
if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
  process.stdout.write(process.env.FAKE_DOCKER_RUNNING || "true");
  process.exit(Number(process.env.FAKE_DOCKER_RUNNING_STATUS || "0"));
}
if (args[0] === "inspect" && args.includes("{{json .}}")) {
  process.stdout.write(process.env.FAKE_DOCKER_INSPECT_JSON || "{}");
  process.exit(Number(process.env.FAKE_DOCKER_INSPECT_STATUS || "0"));
}
if (args[0] === "inspect" && args.some((arg) => arg.includes("NetworkSettings.Ports"))) {
  process.stdout.write(process.env.FAKE_DOCKER_PUBLISHED_PORT || "127.0.0.1:49153");
  process.exit(Number(process.env.FAKE_DOCKER_PUBLISHED_PORT_STATUS || "0"));
}
if (args[0] === "stats") {
  process.stdout.write(process.env.FAKE_DOCKER_STATS_JSON || "{}");
  process.exit(Number(process.env.FAKE_DOCKER_STATS_STATUS || "0"));
}
if (args[0] === "logs") {
  process.stdout.write(process.env.FAKE_DOCKER_LOGS_STDOUT || "");
  process.stderr.write(process.env.FAKE_DOCKER_LOGS_STDERR || "");
  process.exit(Number(process.env.FAKE_DOCKER_LOGS_STATUS || "0"));
}
if (args[0] === "ps") {
  process.stdout.write(process.env.FAKE_DOCKER_PS_JSONL || "");
  process.exit(Number(process.env.FAKE_DOCKER_PS_STATUS || "0"));
}
if (args[0] === "network" && args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_INSPECT_STATUS || "0"));
}
if (args[0] === "network" && args[1] === "create") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_CREATE_STATUS || "0"));
}
process.exit(0);
`,
  );
  await chmod(dockerPath, 0o755);
  await writeFile(
    caddyPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_CADDY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
let status = args[0] === "validate"
  ? process.env.FAKE_DOCKER_CADDY_VALIDATE_STATUS
  : (process.env.FAKE_DOCKER_CADDY_RELOAD_STATUS || process.env.FAKE_DOCKER_CADDY_STATUS);
if (args[0] === "reload" && process.env.FAKE_DOCKER_CADDY_RELOAD_STATUSES) {
  const statePath = process.env.FAKE_DOCKER_CADDY_STATE;
  const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  const statuses = process.env.FAKE_DOCKER_CADDY_RELOAD_STATUSES.split(",");
  status = statuses[Math.min(count, statuses.length - 1)];
  if (statePath) writeFileSync(statePath, String(count + 1));
}
process.exit(Number(status || "0"));
`,
  );
  await chmod(caddyPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    caddyLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_CADDY_LOG: caddyLogPath,
      FAKE_DOCKER_CADDY_STATE: path.join(dir, "caddy-state.txt"),
      ...options.env,
    },
    calls: () => readJsonl(logPath),
    caddyCalls: () => readJsonl(caddyLogPath),
  };
}

async function installFakeCaddy(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-caddy-bin");
  const logPath = path.join(dir, "caddy-calls.jsonl");
  const caddyPath = path.join(fakeBinDir, "caddy");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    caddyPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
let status = args[0] === "validate"
  ? process.env.FAKE_CADDY_VALIDATE_STATUS
  : process.env.FAKE_CADDY_RELOAD_STATUS;
if (args[0] === "reload" && process.env.FAKE_CADDY_RELOAD_STATUSES) {
  const statePath = process.env.FAKE_CADDY_STATE;
  const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  const statuses = process.env.FAKE_CADDY_RELOAD_STATUSES.split(",");
  status = statuses[Math.min(count, statuses.length - 1)];
  if (statePath) writeFileSync(statePath, String(count + 1));
}
process.exit(Number(status || process.env.FAKE_CADDY_STATUS || "0"));
`,
  );
  await chmod(caddyPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CADDY_LOG: logPath,
      FAKE_CADDY_STATE: path.join(dir, "caddy-state.txt"),
      ...options.env,
    },
    calls: () => readJsonl(logPath),
  };
}

async function installFakeJournalctl(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-journalctl-bin");
  const logPath = path.join(dir, "journalctl-calls.jsonl");
  const journalctlPath = path.join(fakeBinDir, "journalctl");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    journalctlPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_JOURNALCTL_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
process.stdout.write(process.env.FAKE_JOURNALCTL_STDOUT || "");
process.stderr.write(process.env.FAKE_JOURNALCTL_STDERR || "");
process.exit(Number(process.env.FAKE_JOURNALCTL_STATUS || "0"));
`,
  );
  await chmod(journalctlPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_JOURNALCTL_LOG: logPath,
      ...options.env,
    },
    calls: () => readJsonl(logPath),
  };
}

async function installFakeCaddyUserCommands(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-caddy-user-bin");
  const idLogPath = path.join(dir, "id-calls.jsonl");
  const chownLogPath = path.join(dir, "chown-calls.jsonl");
  const idPath = path.join(fakeBinDir, "id");
  const chownPath = path.join(fakeBinDir, "chown");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    idPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_USER_ID_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "-u" && args[1] === "caddy") {
  process.stdout.write(process.env.FAKE_CADDY_UID || "123");
  process.exit(Number(process.env.FAKE_CADDY_ID_STATUS || "0"));
}
if (args[0] === "-g" && args[1] === "caddy") {
  process.stdout.write(process.env.FAKE_CADDY_GID || "456");
  process.exit(Number(process.env.FAKE_CADDY_ID_STATUS || "0"));
}
process.exit(1);
`,
  );
  await writeFile(
    chownPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_USER_CHOWN_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
process.exit(Number(process.env.FAKE_CADDY_CHOWN_STATUS || "0"));
`,
  );
  await chmod(idPath, 0o755);
  await chmod(chownPath, 0o755);

  return {
    fakeBinDir,
    idLogPath,
    chownLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CADDY_USER_ID_LOG: idLogPath,
      FAKE_CADDY_USER_CHOWN_LOG: chownLogPath,
      ...options.env,
    },
    idCalls: () => readJsonl(idLogPath),
    chownCalls: () => readJsonl(chownLogPath),
  };
}

async function readJsonl(filePath) {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeHostedCapsuleRollbackFixture(dir, options = {}) {
  const remoteRoot = path.join(dir, "remote-root");
  const domain = "capsules.example.dev";
  const subname = "team-notes";
  const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const releasesDir = path.join(capsuleDir, "releases");
  const dataDir = path.join(capsuleDir, "data");
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`);
  const currentReleaseId = Object.hasOwn(options, "currentReleaseId") ? options.currentReleaseId : "20260630T221500Z-feedface";
  const rollbackReleaseId = Object.hasOwn(options, "rollbackReleaseId") ? options.rollbackReleaseId : "20260629T120000Z-deadbeef";
  const releaseIds = options.releaseIds ?? [currentReleaseId, rollbackReleaseId];
  const missingFiles = new Set(options.missingFiles ?? []);
  await mkdir(path.join(dataDir, "uploads"), { recursive: true });
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  for (const releaseId of releaseIds) {
    const releaseDir = path.join(releasesDir, releaseId);
    await mkdir(releaseDir, { recursive: true });
    const files = {
      "server.mjs": `export default ${JSON.stringify(releaseId)};\n`,
      "client.js": "console.log('client bundle');\n",
      "index.html": "<div id=\"root\"></div>\n",
      "sporades.json": "{\"name\":\"team-notes\"}\n",
    };
    for (const [file, contents] of Object.entries(files)) {
      if (!missingFiles.has(`${releaseId}/${file}`) && !missingFiles.has(file)) {
        await writeFile(path.join(releaseDir, file), contents);
      }
    }
  }
  if (currentReleaseId) {
    await symlink(path.join(releasesDir, currentReleaseId), path.join(capsuleDir, "current"));
  }
  await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
  await writeFile(path.join(dataDir, "uploads", "photo.bin"), "uploaded bytes\n");

  const releases = options.noReleaseHistory
    ? []
    : releaseIds.map((releaseId) => ({
        id: releaseId,
        createdAt: releaseId === currentReleaseId ? "2026-06-30T22:15:00.000Z" : "2026-06-29T12:00:00.000Z",
        uploadedAt: releaseId === currentReleaseId ? "2026-06-30T22:15:00.000Z" : "2026-06-29T12:00:00.000Z",
        state: releaseId === currentReleaseId ? "started" : "verified",
        current: releaseId === currentReleaseId,
        source: {
          hostedUrl: `https://${subname}.${domain}`,
          remoteCapsuleId: `${domain}/${subname}`,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
        },
        startAttempts: releaseId === currentReleaseId ? [{ startedAt: "2026-06-30T22:16:00.000Z" }] : [],
        verificationAttempts: releaseId === currentReleaseId ? [] : [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
        failure: null,
      }));
  await writeFile(
    registryRecordPath,
    `${JSON.stringify({
      subname,
      domain,
      remoteCapsuleId: `${domain}/${subname}`,
      hostedUrl: `https://${subname}.${domain}`,
      status: options.status ?? "running",
      currentRelease: currentReleaseId ? { id: currentReleaseId } : null,
      releases,
    })}\n`,
  );
  return {
    remoteRoot,
    domain,
    subname,
    capsuleDir,
    releasesDir,
    dataDir,
    registryRecordPath,
    currentReleaseId,
    rollbackReleaseId,
    rollbackReleaseDir: path.join(releasesDir, rollbackReleaseId),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readHostBootstrapSmokeEnv() {
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const server = values.SPORADES_HOST_SMOKE_SSH_TARGET;
  const domain = values.SPORADES_HOST_SMOKE_DOMAIN;
  const remoteRoot = values.SPORADES_HOST_SMOKE_REMOTE_ROOT;
  if (!server || !domain || !remoteRoot) {
    return null;
  }
  return {
    alias: values.SPORADES_HOST_SMOKE_ALIAS || "smoke",
    server,
    domain,
    remoteRoot,
    tls: values.SPORADES_HOST_SMOKE_TLS || "automatic",
  };
}

async function readHostRegisterSmokeEnv() {
  const smoke = await readHostBootstrapSmokeEnv();
  if (!smoke) {
    return null;
  }
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const subname = values.SPORADES_HOST_SMOKE_SUBNAME;
  const template = values.SPORADES_HOST_SMOKE_TEMPLATE || "todo";
  if (!subname) {
    return null;
  }
  if (template !== "todo" && template !== "guestbook") {
    throw new Error("SPORADES_HOST_SMOKE_TEMPLATE must be todo or guestbook.");
  }
  return { ...smoke, subname, template };
}

async function readHostPushRoutingSmokeEnv() {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    return null;
  }
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const publicUrl = values.SPORADES_HOST_SMOKE_PUBLIC_URL;
  const expectedText = values.SPORADES_HOST_SMOKE_EXPECTED_TEXT;
  if (!publicUrl || !expectedText) {
    return null;
  }
  return { ...smoke, publicUrl, expectedText };
}

async function readHostLogsSmokeEnv() {
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const server = values.SPORADES_HOST_LOGS_SMOKE_SSH_TARGET;
  const domain = values.SPORADES_HOST_LOGS_SMOKE_DOMAIN;
  const remoteRoot = values.SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT;
  const subname = values.SPORADES_HOST_LOGS_SMOKE_SUBNAME;
  if (!server || !domain || !remoteRoot || !subname) {
    return null;
  }
  return {
    alias: values.SPORADES_HOST_LOGS_SMOKE_ALIAS || "logs-smoke",
    server,
    domain,
    remoteRoot,
    subname,
    tls: values.SPORADES_HOST_LOGS_SMOKE_TLS || "automatic",
    lines: Number.parseInt(values.SPORADES_HOST_LOGS_SMOKE_LINES || "200", 10),
  };
}

async function readDotEnv(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function listArchiveEntries(archivePath, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-tzf", archivePath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}

function withCacheBust(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("sporades-smoke", String(Date.now()));
  return parsed.toString();
}

async function createTarGz(archivePath, sourceDir, entries) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-czf", archivePath, "-C", sourceDir, ...entries], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stderr);
}

async function writeHostedCapsuleInstallFixture(dir, options = {}) {
  const remoteRoot = path.join(dir, options.rootName ?? "remote-root");
  const domain = options.domain ?? "capsules.example.dev";
  const subname = options.subname ?? "team-notes";
  const releaseId = options.releaseId ?? "20260630T221500Z-feedface";
  const previousReleaseId = options.previousReleaseId ?? "20260629T120000Z-deadbeef";
  const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const incomingDir = path.join(remoteRoot, "incoming");
  const runtimeDir = path.join(dir, `${options.rootName ?? "remote-root"}-runtime-files`);
  const archivePath = path.join(incomingDir, `${releaseId}.tar.gz`);
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`);
  await mkdir(incomingDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
  await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
  await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
  await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
  await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);
  await writeFile(
    registryRecordPath,
    `${JSON.stringify({
      subname,
      domain,
      remoteCapsuleId: `${domain}/${subname}`,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      status: "running",
      currentRelease: previousReleaseId ? { id: previousReleaseId } : null,
      releases: previousReleaseId
        ? [
            {
              id: previousReleaseId,
              createdAt: "2026-06-29T12:00:00.000Z",
              uploadedAt: "2026-06-29T12:00:00.000Z",
              state: "verified",
              current: true,
              verificationAttempts: [{ verifiedAt: "2026-06-29T12:01:00.000Z" }],
              failure: null,
            },
          ]
        : [],
    })}\n`,
  );
  return {
    remoteRoot,
    domain,
    subname,
    releaseId,
    previousReleaseId,
    capsuleDir,
    archivePath,
    registryRecordPath,
    release: {
      id: releaseId,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      remoteCapsuleId: `${domain}/${subname}`,
      remoteArchive: archivePath,
      restart: true,
      serverEnvIncluded: false,
      files: ["server.mjs", "client.js", "index.html", "sporades.json"],
      directories: {
        capsule: capsuleDir,
        releases: path.join(capsuleDir, "releases"),
        release: path.join(capsuleDir, "releases", releaseId),
        data: path.join(capsuleDir, "data"),
      },
      currentLink: path.join(capsuleDir, "current"),
    },
    lifecycle: {
      domain,
      subname,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      remoteCapsuleId: `${domain}/${subname}`,
      currentLink: path.join(capsuleDir, "current"),
      directories: {
        capsule: capsuleDir,
        releases: path.join(capsuleDir, "releases"),
        release: path.join(capsuleDir, "releases", releaseId),
        data: path.join(capsuleDir, "data"),
      },
      mounts: {
        files: [
          { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
          { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
          { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
          { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
        ],
        data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
      },
      container: { name: `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}` },
      routes: {
        running: {
          hostname: `${subname}.${domain}`,
          target: "container",
          containerName: `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`,
          port: 4000,
          routeFile: path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`),
          tls: { mode: "automatic" },
        },
        unavailable: {
          hostname: `${subname}.${domain}`,
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile: path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`),
          tls: { mode: "automatic" },
        },
      },
    },
  };
}

async function installFakeReact(projectDir) {
  await writePackage(
    projectDir,
    "react",
    {
      ".": "./index.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
  await writePackage(
    projectDir,
    "react-dom",
    {
      "./client": "./client.js",
    },
    {
      "client.js": "export function createRoot() { return { render() {} }; }\n",
    },
  );
}

async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)));
}

test("sporades host stores Host profiles outside projects and resolves the current profile", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addPersonal = await runCli(
      ["host", "add", "personal", "--server", "root@168.119.161.21", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addPersonal.code, 0, addPersonal.stderr);
    assert.deepEqual(JSON.parse(addPersonal.stdout), {
      ok: true,
      data: {
        alias: "personal",
        profile: {
          server: "root@168.119.161.21",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
          tls: { mode: "automatic" },
        },
      },
      error: null,
    });

    const addWork = await runCli(
      ["host", "add", "work", "--server", "deploy@ssh.other.example", "--domain", "islands.other.test", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addWork.code, 0, addWork.stderr);

    const usePersonal = await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(usePersonal.code, 0, usePersonal.stderr);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout).data.alias, "personal");
    assert.equal(JSON.parse(current.stdout).data.profile.domain, "capsules.example.dev");

    const override = await runCli(["host", "current", "--host", "work", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(override.code, 0, override.stderr);
    assert.equal(JSON.parse(override.stdout).data.alias, "work");
    assert.equal(JSON.parse(override.stdout).data.profile.server, "deploy@ssh.other.example");
    assert.equal(JSON.parse(override.stdout).data.profile.domain, "islands.other.test");

    const hostConfig = JSON.parse(await readFile(path.join(configDir, "hosts.json"), "utf8"));
    assert.equal(hostConfig.currentHostAlias, "personal");
    assert.deepEqual(hostConfig.profiles.work, {
      server: "deploy@ssh.other.example",
      domain: "islands.other.test",
      scheme: "https",
      remoteRoot: "/srv/sporades",
      tls: { mode: "automatic" },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "hosts.json"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host bind is a local-only project remote binding helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@203.0.113.10", "--domain", "capsules.example.dev", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(["host", "add", "work", "--server", "deployer@198.51.100.40", "--domain", "apps.work.test", "--json"], {
          cwd: projectDir,
          env: { ...hostEnv(configDir), ...fakeSsh.env },
        })
      ).code,
      0,
    );
    assert.equal(
      (await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } })).code,
      0,
    );

    const bind = await runCli(["host", "bind", "notes", "--host", "work", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bind.code, 0, bind.stderr);
    const bindData = JSON.parse(bind.stdout).data;
    assert.equal(bindData.localOnly, true);
    assert.equal(bindData.authoritative, false);
    assert.deepEqual(bindData.binding, {
      hostAlias: "work",
      domain: "apps.work.test",
      scheme: "https",
      subname: "notes",
      hostedUrl: "https://notes.apps.work.test",
      remoteCapsuleId: "apps.work.test/notes",
    });

    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), bindData.binding);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.deepEqual(JSON.parse(current.stdout).data.binding, bindData.binding);

    const plainBind = await runCli(["host", "bind", "draft", "--host", "work"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plainBind.code, 0, plainBind.stderr);
    assert.match(plainBind.stdout, /Local remote binding written/);
    assert.match(plainBind.stdout, /does not register or create a Hosted Capsule/);

    await assert.rejects(readFile(path.join(configDir, "remote-binding.json"), "utf8"), { code: "ENOENT" });
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host invoke sends a JSON remote helper request over SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `process.stdout.write(JSON.stringify({
  ok: true,
  data: { received: JSON.parse(stdin), helper: "fake" },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const invoke = await runCli(["host", "invoke", "contract.echo", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invoke.code, 0, invoke.stderr);

    const output = JSON.parse(invoke.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.received, {
      action: "contract.echo",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), output.data.received);
  });
});

test("sporades host invoke reports remote helper envelopes separately from SSH transport failures", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
        { cwd: projectDir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
      return result;
    };

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule is not registered.",
    hint: "Run \`sporades host register team-notes\` first."
  }
}) + "\\n");
process.exit(0);
`,
    );
    await addHost(helperFailureSsh.env);
    const helperFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes` first.",
      },
    });

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const commandFailureSsh = await installContractFakeSsh(
      path.join(dir, "command-failure"),
      `process.stderr.write("sporades-host-helper: command not found\\n");
process.exit(127);
`,
    );
    const commandFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...commandFailureSsh.env },
    });
    assert.equal(commandFailure.code, 1);
    assert.deepEqual(JSON.parse(commandFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Remote Host helper command failed.",
        hint: "Check the Host server helper installation and retry the command.",
      },
    });
  });
});

test("sporades host health checks the selected Host profile and reports safe JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health");
      assert.match(request.headers.host, /^host\.localhost:\d+$/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });

      const health = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          response: { ok: true },
        },
        error: null,
      });

      const explicitHealth = await runCli(["host", "health", "--host", "personal", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
      assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));
    });
  });
});

test("sporades host health checks a Hosted Capsule runtime through the remote helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.health") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.health." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.health.hostedUrl,
      remoteCapsuleId: request.health.remoteCapsuleId,
      registered: true
    },
    release: { id: "20260703T120000Z-abc12345", current: true },
    container: { name: request.health.container.name, running: true },
    route: { url: request.health.runtimeHealthUrl, responding: true },
    runtime: {
      ready: true,
      checks: {
        sqlite: { ok: true },
        fileStorage: { ok: true }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });

    const health = await runCli(["host", "health", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(health.code, 0, health.stderr);
    assert.deepEqual(JSON.parse(health.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          registered: true,
        },
        release: { id: "20260703T120000Z-abc12345", current: true },
        container: { name: "sporades-capsules-example-dev-team-notes", running: true },
        route: {
          url: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
          responding: true,
        },
        runtime: {
          ready: true,
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
          },
        },
      },
      error: null,
    });

    const explicitHealth = await runCli(["host", "health", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
    assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));

    const [sshCall, explicitSshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.health",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      health: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        runtimeHealthUrl: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
    assert.deepEqual(JSON.parse(explicitSshCall.stdin), JSON.parse(sshCall.stdin));
  });
});

test("sporades host health distinguishes unreachable, HTTP failure, and unexpected response shape", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const unreachablePort = await reserveUnusedPort();

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: `localhost:${unreachablePort}`,
          scheme: "http",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });
    const unreachable = await runCli(["host", "health", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(unreachable.code, 1);
    assert.deepEqual(JSON.parse(unreachable.stdout), {
      ok: false,
      data: {
        alias: "personal",
        healthUrl: `http://host.localhost:${unreachablePort}/__sporades/health`,
        failure: "unreachable",
      },
      error: {
        message: "Host server is unreachable.",
        hint: "Check DNS for the Host server health name, network connectivity, and whether the Host server is running.",
      },
    });

    await withHttpServer((request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"ok":false}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      const httpFailure = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(httpFailure.code, 1);
      assert.deepEqual(JSON.parse(httpFailure.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "tls-http",
          statusCode: 503,
        },
        error: {
          message: "Host server health returned an HTTP failure.",
          hint: "Check TLS mode, certificate configuration, Caddy, and the Host server health route.",
        },
      });
    });

    await withHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"version":"0.0.0"}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      const unexpectedShape = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(unexpectedShape.code, 1);
      assert.deepEqual(JSON.parse(unexpectedShape.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "unexpected-response",
          statusCode: 200,
        },
        error: {
          message: "Host server health response had an unexpected shape.",
          hint: "Run `sporades host bootstrap --host personal` and check the generated Host server health route.",
        },
      });
    });
  });
});

test("sporades host bootstrap enables one Hosted domain through the remote helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.bootstrap") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.bootstrap." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    bootstrapped: true,
    domain: request.host.domain,
    remoteRoot: request.host.remoteRoot,
    network: request.bootstrap.network,
    packages: request.bootstrap.substrate.packages,
    directories: request.bootstrap.directories,
    tls: request.bootstrap.tls,
    caddy: {
      managedInclude: request.bootstrap.caddy.managedInclude,
      globalConfigReplaced: false
    },
    preservedCapsules: true
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 0, bootstrap.stderr);

    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.tls, {
      mode: "automatic",
      directory: "/opt/sporades/hosts/capsules.example.dev/tls",
      certificate: null,
      key: null,
    });
    assert.equal(output.data.caddy.managedInclude, "/opt/sporades/caddy/sporades-hosted-domains.caddy");
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.packages, ["docker", "caddy"]);
    assert.deepEqual(output.data.directories, {
      remoteRoot: "/opt/sporades",
      bin: "/opt/sporades/bin",
      incoming: "/opt/sporades/incoming",
      caddy: "/opt/sporades/caddy",
      caddyHosts: "/opt/sporades/caddy/hosts",
      hosts: "/opt/sporades/hosts",
      domain: "/opt/sporades/hosts/capsules.example.dev",
      tls: "/opt/sporades/hosts/capsules.example.dev/tls",
      registry: "/opt/sporades/hosts/capsules.example.dev/registry",
      capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
    });
    assert.equal(output.data.preservedCapsules, true);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot: "/opt/sporades",
          bin: "/opt/sporades/bin",
          incoming: "/opt/sporades/incoming",
          caddy: "/opt/sporades/caddy",
          caddyHosts: "/opt/sporades/caddy/hosts",
          hosts: "/opt/sporades/hosts",
          domain: "/opt/sporades/hosts/capsules.example.dev",
          tls: "/opt/sporades/hosts/capsules.example.dev/tls",
          registry: "/opt/sporades/hosts/capsules.example.dev/registry",
          capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
        },
        domainDirectory: "/opt/sporades/hosts/capsules.example.dev",
        tls: {
          mode: "automatic",
          directory: "/opt/sporades/hosts/capsules.example.dev/tls",
          certificate: null,
          key: null,
        },
        caddy: {
          managedInclude: "/opt/sporades/caddy/sporades-hosted-domains.caddy",
          domainInclude: "/opt/sporades/caddy/hosts/capsules.example.dev.caddy",
        },
      },
    });
  });
});

test("sporades host bootstrap reports missing Cloudflare origin certificate material with an actionable hint", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Cloudflare origin certificate material is missing or unusable.",
    hint: "Install readable Cloudflare origin certificate and key files at " + request.bootstrap.tls.certificate + " and " + request.bootstrap.tls.key + ", then rerun \`sporades host bootstrap --host " + request.host.alias + "\`."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 1);
    assert.deepEqual(JSON.parse(bootstrap.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: "Install readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key, then rerun `sporades host bootstrap --host personal`.",
      },
    });
  });
});

test("sporades host bootstrap can run against an opt-in real SSH Host server", async (t) => {
  const smoke = await readHostBootstrapSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, and SPORADES_HOST_SMOKE_REMOTE_ROOT to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const addArgs = [
      "host",
      "add",
      smoke.alias,
      "--server",
      smoke.server,
      "--domain",
      smoke.domain,
      "--remote-root",
      smoke.remoteRoot,
      "--tls",
      smoke.tls,
      "--json",
    ];
    const addHost = await runCli(addArgs, { cwd: dir, env: hostEnv(configDir) });
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(bootstrap.code, 0, `${bootstrap.stderr}\n${bootstrap.stdout}`);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.domain, smoke.domain);
    assert.equal(output.data.remoteRoot, smoke.remoteRoot);
    assert.equal(output.data.tls.mode, smoke.tls);
    assert.equal(output.data.preservedCapsules, true);
  });
});

test("sporades host register can run against an opt-in real SSH Host server and returns the unavailable response", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });

    assert.equal(register.code, 0, `${register.stderr}\n${register.stdout}`);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsule.subname, smoke.subname);
    assert.equal(output.data.capsule.domain, smoke.domain);
    assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(output.data.binding.hostedUrl, output.data.capsule.hostedUrl);

    const response = await fetch(output.data.capsule.hostedUrl);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Hosted Capsule unavailable/);
  });
});

test("sporades host logs can read a real Host server after requesting an opt-in Capsule route", async (t) => {
  const smoke = await readHostLogsSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_HOST_LOGS_SMOKE_SSH_TARGET, SPORADES_HOST_LOGS_SMOKE_DOMAIN, SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT, and SPORADES_HOST_LOGS_SMOKE_SUBNAME to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const marker = `sporades-log-smoke-${Date.now()}`;
    const routeUrl = `https://${smoke.subname}.${smoke.domain}/?${marker}`;
    const response = await fetch(routeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    assert(response.status >= 100, `Expected ${routeUrl} to return an HTTP response`);

    const logs = await runCli(["host", "logs", "--host", smoke.alias, "--lines", String(smoke.lines), "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(logs.code, 0, `${logs.stderr}\n${logs.stdout}`);
    const output = JSON.parse(logs.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.lineCount, smoke.lines);
    assert(Array.isArray(output.data.entries));
    const joinedEntries = output.data.entries.join("\n");
    assert(
      joinedEntries.includes(marker) || joinedEntries.includes(`${smoke.subname}.${smoke.domain}`),
      "Expected recent Caddy log entries to include the triggered Capsule route or marker",
    );
  });
});

test("sporades host list can run against an opt-in real SSH Host server after disposable registration", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-list-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    let registeredThisRun = false;
    if (register.code === 0) {
      registeredThisRun = true;
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");
    }

    const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.host.domain, smoke.domain);
    const capsule = output.data.capsules.find((candidate) => candidate.subname === smoke.subname);
    assert.ok(capsule, `Expected ${smoke.subname} to appear in host list output.`);
    assert.equal(capsule.domain, smoke.domain);
    assert.equal(capsule.hostedUrl, `https://${smoke.subname}.${smoke.domain}`);
    assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(typeof capsule.registry.status, "string");
    if (registeredThisRun) {
      assert.equal(capsule.currentRelease, null);
    }
  });
});

test("sporades host push can restart a real Hosted Capsule and serve it through the public route", async (t) => {
  const smoke = await readHostPushRoutingSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, SPORADES_HOST_SMOKE_SUBNAME, SPORADES_HOST_SMOKE_PUBLIC_URL, and SPORADES_HOST_SMOKE_EXPECTED_TEXT to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-push-routing-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    if (register.code === 0) {
      const output = JSON.parse(register.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.capsule.subname, smoke.subname);
      assert.equal(output.data.capsule.domain, smoke.domain);
      assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

      const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
        cwd: projectDir,
        env: hostEnv(configDir),
      });
      assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
      const capsule = JSON.parse(list.stdout).data.capsules.find((candidate) => candidate.subname === smoke.subname);
      assert.ok(capsule, `Expected existing Hosted Capsule ${smoke.subname} to be listed for ${smoke.domain}.`);
      assert.equal(capsule.domain, smoke.domain);
      assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    }

    const push = await runCli(["host", "push", "--host", smoke.alias, "--subname", smoke.subname, "--restart", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const pushOutput = JSON.parse(push.stdout);
    assert.equal(pushOutput.ok, true);
    assert.equal(pushOutput.error, null);
    assert.equal(pushOutput.data.installed, true);
    assert.equal(pushOutput.data.restartRequested, true);
    assert.equal(pushOutput.data.restarted, true);
    assert.equal(pushOutput.data.capsule.subname, smoke.subname);
    assert.equal(pushOutput.data.capsule.domain, smoke.domain);

    const response = await fetch(withCacheBust(smoke.publicUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, new RegExp(escapeRegExp(smoke.expectedText)));
  });
});

test("sporades host helper bootstraps a Hosted domain idempotently without deleting Capsule state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const preservedCapsuleFile = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data", "data.db");
    await mkdir(path.dirname(preservedCapsuleFile), { recursive: true });
    await writeFile(preservedCapsuleFile, "existing capsule data\n");
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "unrelated.example.dev {\n  respond \"still here\"\n}\n");
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        domainDirectory: path.join(remoteRoot, "hosts", "capsules.example.dev"),
        tls: {
          mode: "automatic",
          directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          certificate: null,
          key: null,
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const bootstrap = await runHostHelper(request, { cwd: dir, env });

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.bootstrapped, true);
    assert.equal(output.data.preservedCapsules, true);
    assert.deepEqual(output.data.network, {
      name: "sporades-hosted-capsules",
      created: true,
    });
    assert.equal(output.data.caddy.managedInclude, path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"));
    assert.equal(output.data.caddy.domainInclude, path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"));
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.caddy.accessLog, {
      file: path.join(remoteRoot, "caddy", "logs", "access.log"),
      directory: path.join(remoteRoot, "caddy", "logs"),
      owner: "caddy",
      writableByService: true,
    });

    assert.equal(await readFile(preservedCapsuleFile, "utf8"), "existing capsule data\n");
    assert.equal((await stat(path.join(remoteRoot, "bin"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "incoming"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "caddy", "logs"))).isDirectory(), true);
    assert.equal(await readFile(path.join(remoteRoot, "caddy", "logs", "access.log"), "utf8"), "");
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"))).isDirectory(), true);
    const caddyfile = await readFile(path.join(remoteRoot, "caddy", "Caddyfile"), "utf8");
    assert.match(caddyfile, /unrelated\.example\.dev \{\n  respond "still here"\n\}/);
    assert.match(caddyfile, new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"))}`));
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "*.caddy"))}`),
    );
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "*.caddy"))}`),
    );
    const healthRoute = await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "host.caddy"), "utf8");
    assert.match(healthRoute, /host\.capsules\.example\.dev \{/);
    assert.match(healthRoute, /respond \/__sporades\/health "\{\\"ok\\":true\}" 200/);
    assert.doesNotMatch(healthRoute, /container|registry|\/srv|remote-root|version|metrics|secret/i);

    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["network", "inspect", "sporades-hosted-capsules"],
        ["network", "create", "sporades-hosted-capsules"],
      ],
    );
    assert.deepEqual(
      (await caddyUser.chownCalls()).map((call) => call.args),
      [["123:456", path.join(remoteRoot, "caddy", "logs"), path.join(remoteRoot, "caddy", "logs", "access.log")]],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["validate", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper reads configurable production defaults from remoteRoot JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(
      path.join(remoteRoot, "sporades-host-helper.json"),
      `${JSON.stringify(
        {
          hostedCapsule: {
            dockerNetwork: "sporades-custom-network",
          },
          logs: {
            defaultLines: 2,
            maxLines: 50,
          },
        },
        null,
        2,
      )}\n`,
    );

    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const bootstrap = await runHostHelper(
      {
        action: "host.bootstrap",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env },
    );

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.deepEqual(JSON.parse(bootstrap.stdout).data.network, {
      name: "sporades-custom-network",
      created: true,
    });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args).slice(0, 2),
      [
        ["network", "inspect", "sporades-custom-network"],
        ["network", "create", "sporades-custom-network"],
      ],
    );

    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await writeFile(accessLog, ["old", "one", "two"].join("\n") + "\n");
    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["one", "two"],
      },
      error: null,
    });

    const explicitLogs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 1 },
      },
      { cwd: dir },
    );

    assert.equal(explicitLogs.code, 0, explicitLogs.stderr);
    assert.deepEqual(JSON.parse(explicitLogs.stdout), {
      ok: true,
      data: {
        lineCount: 1,
        source: "http",
        entries: ["two"],
      },
      error: null,
    });
  });
});

test("sporades host helper returns a structured error for invalid config JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(path.join(remoteRoot, "sporades-host-helper.json"), "{ nope\n");

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host helper config is invalid JSON.",
        hint: `Fix ${path.join(remoteRoot, "sporades-host-helper.json")}, then retry the Host helper command.`,
      },
    });
  });
});

test("sporades host helper requires readable Cloudflare origin certificate files only for cloudflare-origin TLS", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const tlsDirectory = path.join(remoteRoot, "hosts", "capsules.example.dev", "tls");
    const docker = await installFakeDocker(dir);
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: tlsDirectory,
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        tls: {
          mode: "cloudflare-origin",
          directory: tlsDirectory,
          certificate: path.join(tlsDirectory, "origin.crt"),
          key: path.join(tlsDirectory, "origin.key"),
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir, env });

    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: `Install readable Cloudflare origin certificate and key files at ${path.join(tlsDirectory, "origin.crt")} and ${path.join(tlsDirectory, "origin.key")}, then rerun \`sporades host bootstrap --host personal\`.`,
      },
    });
    await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });

    await writeFile(path.join(tlsDirectory, "origin.crt"), "certificate\n");
    await writeFile(path.join(tlsDirectory, "origin.key"), "key\n");
    const present = await runHostHelper(request, { cwd: dir, env });
    assert.equal(present.code, 0, present.stderr);
    const output = JSON.parse(present.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.tls.mode, "cloudflare-origin");
    assert.equal(output.data.tls.certificate, path.join(tlsDirectory, "origin.crt"));
    assert.equal(output.data.tls.key, path.join(tlsDirectory, "origin.key"));
  });
});

test("sporades host helper reports Docker and Caddy bootstrap substrate failures as JSON errors", async () => {
  await withTempDir(async (dir) => {
    const dockerFailureRoot = path.join(dir, "docker-failure-root");
    const docker = await installFakeDocker(path.join(dir, "docker-failure"), {
      env: {
        FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1",
        FAKE_DOCKER_NETWORK_CREATE_STATUS: "1",
      },
    });
    const baseRequest = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: dockerFailureRoot,
      },
      capsule: null,
      bootstrap: {
        tls: { mode: "automatic", directory: path.join(dockerFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        network: "sporades-hosted-capsules",
      },
    };

    const dockerFailure = await runHostHelper(baseRequest, { cwd: dir, env: docker.env });

    assert.equal(dockerFailure.code, 0, dockerFailure.stderr);
    const dockerFailureOutput = JSON.parse(dockerFailure.stdout);
    assert.equal(dockerFailureOutput.ok, false);
    assert.equal(dockerFailureOutput.error.message, "Failed to create the Hosted Capsule Docker network.");
    assert.match(dockerFailureOutput.error.hint, /Check Docker on the Host server/);

    const caddyFailureRoot = path.join(dir, "caddy-failure-root");
    const caddy = await installFakeDocker(path.join(dir, "caddy-failure"), {
      env: {
        FAKE_DOCKER_CADDY_VALIDATE_STATUS: "1",
      },
    });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-failure-user"));
    const caddyFailureEnv = {
      ...caddy.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const caddyFailure = await runHostHelper(
      {
        ...baseRequest,
        host: { ...baseRequest.host, remoteRoot: caddyFailureRoot },
        bootstrap: {
          tls: { mode: "automatic", directory: path.join(caddyFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
          network: "sporades-hosted-capsules",
        },
      },
      { cwd: dir, env: caddyFailureEnv },
    );

    assert.equal(caddyFailure.code, 0, caddyFailure.stderr);
    const caddyFailureOutput = JSON.parse(caddyFailure.stdout);
    assert.equal(caddyFailureOutput.ok, false);
    assert.equal(caddyFailureOutput.error.message, "Failed to validate the Sporades Caddy bootstrap configuration.");
    assert.match(caddyFailureOutput.error.hint, /Check Caddy on the Host server/);
  });
});

test("sporades host helper registers Hosted Capsules with registry state and unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const request = {
      action: "capsule.register",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: {
        subname: "team-notes",
      },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
          logs: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 418,
          routeFile: path.join(dir, "caller-controlled", "team-notes.caddy"),
          tls: {
            mode: "cloudflare-origin",
            directory: path.join(dir, "caller-controlled", "tls"),
            certificate: path.join(dir, "caller-controlled", "tls", "origin.crt"),
            key: path.join(dir, "caller-controlled", "tls", "origin.key"),
          },
        },
      },
    };
    const expectedRoute = {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy"),
      tls: {
        mode: "automatic",
        directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
        certificate: null,
        key: null,
      },
      log: { file: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log") },
    };

    const register = await runHostHelper(request, { cwd: dir, env: caddy.env });

    assert.equal(register.code, 0, register.stderr);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.registered, true);
    assert.equal(output.data.authoritative, true);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.registryRecord, request.registration.registryRecord);
    assert.deepEqual(output.data.directories, request.registration.directories);
    assert.deepEqual(output.data.route, expectedRoute);

    const record = JSON.parse(await readFile(request.registration.registryRecord, "utf8"));
    assert.equal(record.subname, "team-notes");
    assert.equal(record.domain, "capsules.example.dev");
    assert.equal(record.remoteCapsuleId, "capsules.example.dev/team-notes");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.status, "registered");
    assert.equal(record.currentRelease, null);
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.updatedAt, record.createdAt);
    assert.equal((await stat(request.registration.directories.releases)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.data)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.logs)).isDirectory(), true);
    const routeContents = await readFile(expectedRoute.routeFile, "utf8");
    assert.match(routeContents, /team-notes\.capsules\.example\.dev/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.match(routeContents, /hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log/);
    assert.doesNotMatch(routeContents, /418|caller-controlled|tls /);
    await assert.rejects(readFile(request.registration.route.routeFile, "utf8"), { code: "ENOENT" });
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${expectedRoute.routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );

    const duplicate = await runHostHelper(request, { cwd: dir, env: caddy.env });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.deepEqual(JSON.parse(duplicate.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });

    const otherDomainRoot = path.join(dir, "other-domain-root");
    await mkdir(path.join(otherDomainRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(otherDomainRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test.caddy"), "import ./apps.work.test/*.caddy\n");
    const otherDomainRequest = {
      ...request,
      host: {
        ...request.host,
        domain: "apps.work.test",
        remoteRoot: otherDomainRoot,
      },
      registration: {
        ...request.registration,
        domain: "apps.work.test",
        hostedUrl: "https://team-notes.apps.work.test",
        remoteCapsuleId: "apps.work.test/team-notes",
        registryRecord: path.join(otherDomainRoot, "hosts", "apps.work.test", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes"),
          releases: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "releases"),
          data: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "data"),
        },
        route: {
          ...request.registration.route,
          hostname: "team-notes.apps.work.test",
          routeFile: path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test", "team-notes.caddy"),
          tls: {
            mode: "automatic",
            directory: path.join(otherDomainRoot, "hosts", "apps.work.test", "tls"),
            certificate: null,
            key: null,
          },
        },
      },
    };

    const sameSubnameOtherDomain = await runHostHelper(otherDomainRequest, { cwd: dir, env: caddy.env });
    assert.equal(sameSubnameOtherDomain.code, 0, sameSubnameOtherDomain.stderr);
    assert.equal(JSON.parse(sameSubnameOtherDomain.stdout).data.capsule.remoteCapsuleId, "apps.work.test/team-notes");
  });
});

test("sporades host helper does not commit registration when the unavailable route cannot be applied", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const failingCaddy = await installFakeCaddy(path.join(dir, "failing-caddy"), { env: { FAKE_CADDY_RELOAD_STATUS: "1" } });
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecord = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const request = {
      action: "capsule.register",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord,
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile,
          tls: { mode: "automatic", directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        },
      },
    };

    const failed = await runHostHelper(request, { cwd: dir, env: failingCaddy.env });
    assert.equal(failed.code, 0, failed.stderr);
    const failedOutput = JSON.parse(failed.stdout);
    assert.equal(failedOutput.ok, false);
    assert.equal(failedOutput.data, null);
    assert.match(failedOutput.error.message, /^Failed to apply Hosted Capsule route/);
    await assert.rejects(readFile(registryRecord, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });

    const repairedCaddy = await installFakeCaddy(path.join(dir, "repaired-caddy"));
    const repaired = await runHostHelper(request, { cwd: dir, env: repairedCaddy.env });
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).ok, true);
    assert.equal(JSON.parse(await readFile(registryRecord, "utf8")).status, "registered");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host register creates authoritative remote state and then writes local binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.register") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.register." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId
    },
    registryRecord: request.registration.registryRecord,
    directories: request.registration.directories,
    route: request.registration.route
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 0, register.stderr);

    const output = JSON.parse(register.stdout);
    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    const expectedBinding = {
      hostAlias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      subname: "team-notes",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    };
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.registered, true);
    assert.equal(output.data.authoritative, true);
    assert.equal(output.data.localBinding, true);
    assert.match(output.data.bindingPath, /\.sporades\/remote-binding\.json$/);
    assert.deepEqual(output.data.binding, expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(output.data.bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(output.data.route, {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
      tls: {
        mode: "automatic",
        directory: "/opt/sporades/hosts/capsules.example.dev/tls",
        certificate: null,
        key: null,
      },
      log: {
        file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.register",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
          log: {
            file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
          },
        },
        bootstrap: {
          command: "sporades host bootstrap --host personal",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
        },
      },
    });
  });
});

test("sporades host push uploads a runtime-only release archive and installs it without restart by default", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      archive: request.release.remoteArchive,
      directory: request.release.directories.release,
      currentLink: request.release.currentLink,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\nPUBLIC_LABEL=not-client\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(bind.code, 0, bind.stderr);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);

    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, true);
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.release.directory, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(output.data.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      ".env.sporades.server",
    ]);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.match(scpCall.source, /\.sporades\/host-push\/.+\.tar\.gz$/);
    assert.equal(scpCall.target, `root@example.test:/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    const uploadedArchives = await readdir(fakeScp.uploadDir);
    assert.deepEqual(uploadedArchives, [`${output.data.release.id}.tar.gz`]);
    const entries = await listArchiveEntries(path.join(fakeScp.uploadDir, uploadedArchives[0]), projectDir);
    assert.deepEqual(entries, [
      ".env.sporades.server",
      "client.js",
      "index.html",
      "server.mjs",
      "sporades.json",
    ]);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.capsule.subname, "team-notes");
    assert.equal(request.release.restart, false);
    assert.equal(request.release.remoteArchive, `/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    assert.equal(request.release.directories.data, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data");
    assert.equal(request.release.directories.release, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(request.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
  });
});

test("sporades host push packages Host-profile re-encrypted Sealed Server env without plaintext values", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded,
      sealedServerEnvIncluded: request.release.sealedServerEnvIncluded
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "sealed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "sealed-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\nPUBLIC_LABEL=not-client\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir, env })).code, 0);
    const reencrypted = await runCli(["env", "reencrypt", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(reencrypted.code, 0, reencrypted.stderr);
    assert.doesNotMatch(reencrypted.stdout, /swordfish|not-client|PRIVATE KEY/);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.doesNotMatch(push.stdout, /swordfish|not-client|PRIVATE KEY/);
    const output = JSON.parse(push.stdout);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      ".sporades/sealed-server-env/server-env.sealed.json",
      "client.js",
      "index.html",
      "server.mjs",
      "sporades.json",
    ]);
    const archiveEnvelope = await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xOzf", scpCall.copiedTo, ".sporades/sealed-server-env/server-env.sealed.json"], {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    assert.doesNotMatch(archiveEnvelope, /swordfish|not-client|PRIVATE KEY/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.release.sealedServerEnvIncluded, true);
    assert.equal(typeof request.release.sealedServerEnv.privateKey, "string");
    assert.match(request.release.sealedServerEnv.privateKey, /PRIVATE KEY/);
    assert.doesNotMatch(JSON.stringify(request.release).replace(request.release.sealedServerEnv.privateKey, ""), /swordfish|not-client/);
  });
});

test("sporades host push can target an explicit Hosted Capsule and request restart", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: request.release.restart,
    restarted: false,
    release: {
      id: request.release.id,
      serverEnvIncluded: request.release.serverEnvIncluded,
      files: request.release.files
    },
    capsule: {
      subname: request.capsule.subname,
      hostedUrl: request.release.hostedUrl
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const push = await runCli(["host", "push", "--host", "work", "--subname", "field-notes", "--restart", "--json"], {
      cwd: projectDir,
      env,
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.deepEqual(output.data.release.files, ["server.mjs", "client.js", "index.html", "sporades.json"]);
    assert.equal(output.data.capsule.hostedUrl, "https://field-notes.apps.work.test");
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });

    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.equal(scpCall.target, `deploy@example.test:/srv/sporades/incoming/${output.data.release.id}.tar.gz`);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, ["client.js", "index.html", "server.mjs", "sporades.json"]);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.host.alias, "work");
    assert.equal(request.host.domain, "apps.work.test");
    assert.equal(request.capsule.subname, "field-notes");
    assert.equal(request.release.restart, true);
  });
});

test("sporades host push --verify requests Hosted Capsule restart and release verification", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install" || request.release.restart !== true || !request.verification) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected verification request.", hint: "Use capsule.release.install with verification." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: true,
    restarted: true,
    verified: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      current: true
    },
    previousCurrentRelease: { id: "20260629T120000Z-deadbeef" },
    currentAttemptedRelease: { id: request.release.id },
    verification: {
      state: "verified",
      health: {
        route: { responding: true },
        runtime: {
          ready: true,
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } }
        }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(bind.code, 0, bind.stderr);

    const push = await runCli(["host", "push", "--verify", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.verification.state, "verified");
    assert.equal(output.data.verification.health.runtime.ready, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.previousCurrentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.currentAttemptedRelease.id, output.data.release.id);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.release.restart, true);
    assert.equal(request.verification.enabled, true);
    assert.equal(request.verification.health.runtimeHealthUrl, "https://team-notes.capsules.example.dev/__sporades/health/runtime");
    assert.equal(request.lifecycle.container.name, "sporades-capsules-example-dev-team-notes");
  });
});

test("sporades host start stop and restart invoke the Hosted Capsule lifecycle helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    action: request.action,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.lifecycle.hostedUrl
    },
    container: request.lifecycle.container,
    route: request.lifecycle.routes[request.action === "capsule.stop" ? "unavailable" : "running"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const start = await runCli(["host", "start", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(start.code, 0, start.stderr);
    const startOutput = JSON.parse(start.stdout);
    assert.equal(startOutput.data.action, "capsule.start");
    assert.equal(startOutput.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.managed"], "true");
    assert.equal(startOutput.data.container.labels["com.sporades.hosted-domain"], "capsules.example.dev");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-subname"], "team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-id"], "capsules.example.dev/team-notes");
    assert.equal(startOutput.data.route.target, "container");

    const stop = await runCli(["host", "stop", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.action, "capsule.stop");
    assert.equal(JSON.parse(stop.stdout).data.route.target, "hosted-capsule-unavailable");

    const restart = await runCli(["host", "restart", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(restart.code, 0, restart.stderr);
    assert.equal(JSON.parse(restart.stdout).data.action, "capsule.restart");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(
      calls.map((call) => JSON.parse(call.stdin).action),
      ["capsule.start", "capsule.stop", "capsule.restart"],
    );
    const startRequest = JSON.parse(calls[0].stdin);
    assert.equal(startRequest.lifecycle.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(startRequest.lifecycle.mounts.files, [
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/client.js", container: "/app/client.js", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/index.html", container: "/app/index.html", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server",
        container: "/app/.env.sporades.server",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
        container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
        container: "/app/.sporades/sealed-server-env/server-env.private.pem",
        mode: "ro",
        optional: true,
      },
    ]);
    assert.deepEqual(startRequest.lifecycle.mounts.data, {
      host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
      container: "/app/data",
      mode: "rw",
    });
  });
});

test("sporades host helper installs a release atomically and updates the current pointer", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      ".env.sporades.server",
    ]);
    const previousReleaseDir = path.join(capsuleDir, "releases", "20260629T120000Z-deadbeef");
    await mkdir(previousReleaseDir, { recursive: true });
    await symlink(previousReleaseDir, path.join(capsuleDir, "current"));
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        releases: { malformed: true },
      })}\n`,
    );

    const request = {
      action: "capsule.release.install",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: {
        subname: "team-notes",
      },
      release: {
        id: "20260630T221500Z-feedface",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteArchive: archivePath,
        restart: false,
        serverEnvIncluded: true,
        files: ["server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"],
        directories: {
          capsule: capsuleDir,
          releases: path.join(capsuleDir, "releases"),
          release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          data: path.join(capsuleDir, "data"),
        },
        currentLink: path.join(capsuleDir, "current"),
      },
    };

    const install = await runHostHelper(request, { cwd: dir });
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: true,
      data: {
        installed: true,
        restartRequested: false,
        restarted: false,
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
        },
        release: {
          id: "20260630T221500Z-feedface",
          directory: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          currentLink: path.join(capsuleDir, "current"),
          files: ["server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"],
          serverEnvIncluded: true,
        },
      },
      error: null,
    });

    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    const currentTarget = await readFile(path.join(capsuleDir, "current"), "utf8").catch(() => null);
    assert.equal(currentTarget, null);
    const symlinkTarget = await readlink(path.join(capsuleDir, "current"));
    assert.equal(symlinkTarget, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server", "index.ts"), "utf8"), {
      code: "ENOENT",
    });
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "uploaded");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].source.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.releases[0].source.serverEnvIncluded, true);
    assert.deepEqual(record.releases[0].source.files, ["server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"]);
    assert.match(record.releases[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].uploadedAt, record.releases[0].createdAt);
  });
});

test("sporades host helper rejects non-canonical Sealed Server env private key paths", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const escapedPrivateKeyPath = path.join(dir, "escaped-private.pem");
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "{\"version\":1,\"valueAlgorithm\":\"aes-256-gcm\",\"entries\":{}}\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            privateKey: "-----BEGIN PRIVATE KEY-----\\nnot-real\\n-----END PRIVATE KEY-----\\n",
            privateKeyPath: escapedPrivateKeyPath,
          },
          files: ["server.mjs", "client.js", "index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Sealed Server env private key path.",
        hint: "Update the Sporades CLI and retry `sporades host push`.",
      },
    });
    await assert.rejects(readFile(escapedPrivateKeyPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(capsuleDir, "current"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host helper marks previous releases non-current and records start attempts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
        ],
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260629T120000Z-deadbeef", state: "uploaded", current: false },
        { id: "20260630T221500Z-feedface", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
    assert.match(record.releases[1].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("sporades host helper starts the current release in Docker and routes through a loopback-published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await writeFile(path.join(releaseDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          currentLink: path.join(capsuleDir, "current"),
          directories: { capsule: capsuleDir, releases: path.join(capsuleDir, "releases"), data: path.join(capsuleDir, "data") },
          mounts: {
            files: [
              { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
              { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
              { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
              { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
              { host: path.join(capsuleDir, "current", ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
            ],
            data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
          },
          container: {
            name: "sporades-capsules-example-dev-team-notes",
            labels: {
              "com.sporades.managed": "true",
              "com.sporades.hosted-domain": "capsules.example.dev",
              "com.sporades.capsule-subname": "team-notes",
              "com.sporades.capsule-id": "capsules.example.dev/team-notes",
            },
          },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
            },
            unavailable: {
              hostname: "team-notes.capsules.example.dev",
              target: "hosted-capsule-unavailable",
              statusCode: 503,
              routeFile,
            },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(start.code, 0, start.stderr);
    const output = JSON.parse(start.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.started, true);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.equal(output.data.container.publishedPort.hostIp, "127.0.0.1");
    assert.equal(output.data.container.publishedPort.hostPort, 49153);
    assert.equal(output.data.route.target, "loopback");
    assert.equal(output.data.route.upstream, "127.0.0.1:49153");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["stop", "rm", "run", "inspect", "inspect"]);
    const runCall = calls[2];
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-capsules-example-dev-team-notes");
    assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-hosted-capsules");
    assert(runCall.args.includes("--read-only"));
    assert.equal(runCall.args[runCall.args.indexOf("--tmpfs") + 1], "/tmp:rw,nosuid,nodev,noexec");
    assert.equal(runCall.args[runCall.args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(runCall.args[runCall.args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.equal(runCall.args[runCall.args.indexOf("--log-driver") + 1], "json-file");
    assert(runCall.args.includes("max-size=10m"));
    assert(runCall.args.includes("max-file=5"));
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert(runCall.args.includes("--label"));
    assert(runCall.args.includes("com.sporades.release-id=20260630T221500Z-feedface"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".env.sporades.server")}:/app/.env.sporades.server:ro`));
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(capsuleDir, "current", ".env.sporades.server"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "data")}:/app/data:rw`));
    assert.deepEqual(runCall.args.slice(runCall.args.indexOf("node:22-alpine")), ["node:22-alpine", "node", "/app/server.mjs"]);
    assert.match(calls[4].args.join(" "), /NetworkSettings\.Ports/);
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_size 10MiB/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /header x-sporades-host-probe [a-f0-9]{64}/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /reverse_proxy 127\.0\.0\.1:49153/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.runtimeProbe.header, "x-sporades-host-probe");
    assert.match(record.runtimeProbe.token, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(output).includes(record.runtimeProbe.token), false);
    assert.equal(JSON.stringify(output).includes("SECRET_TOKEN"), false);
  });
});

test("sporades host helper checks Hosted Capsule runtime health with a Host-owned probe credential", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );

      const health = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          capsule: {
            subname: "team-notes",
            domain,
            hostedUrl,
            remoteCapsuleId: `${domain}/team-notes`,
            registered: true,
          },
          release: { id: "20260630T221500Z-feedface", current: true },
          container: { name: "sporades-capsules-example-dev-team-notes", running: true },
          route: {
            url: `${hostedUrl}/__sporades/health/runtime`,
            responding: true,
          },
          runtime: {
            ready: true,
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
        },
        error: null,
      });
      assert.equal(health.stdout.includes("probe-secret"), false);
    });
  });
});

test("sporades host helper does not send the runtime probe credential to caller-supplied URLs", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);
    let maliciousRequests = 0;

    await withHttpServer((request, response) => {
      assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (validPort) => {
      await withHttpServer((_request, response) => {
        maliciousRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: {}, error: null }));
      }, async (maliciousPort) => {
        const domain = `localhost:${validPort}`;
        const hostedUrl = `http://team-notes.localhost:${validPort}`;
        const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
        await mkdir(path.dirname(registryRecordPath), { recursive: true });
        await writeFile(
          registryRecordPath,
          `${JSON.stringify({
            subname: "team-notes",
            domain,
            remoteCapsuleId: `${domain}/team-notes`,
            hostedUrl,
            status: "running",
            currentRelease: { id: "20260630T221500Z-feedface" },
            runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
          })}\n`,
        );

        const health = await runHostHelper(
          {
            action: "capsule.health",
            host: { alias: "personal", domain, scheme: "http", remoteRoot },
            capsule: { subname: "team-notes" },
            health: {
              runtimeHealthUrl: `http://localhost:${maliciousPort}/__sporades/health/runtime`,
              hostedUrl: `http://localhost:${maliciousPort}`,
              remoteCapsuleId: `localhost:${maliciousPort}/team-notes`,
              container: { name: "sporades-capsules-example-dev-team-notes" },
            },
          },
          { cwd: dir, env: docker.env },
        );

        assert.equal(health.code, 0, health.stderr);
        assert.equal(JSON.parse(health.stdout).ok, true);
        assert.equal(maliciousRequests, 0);
        assert.equal(health.stdout.includes("probe-secret"), false);
      });
    });
  });
});

test("Sporades runtime health rejects unauthenticated probes and returns safe readiness checks", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {});
    const server = createServer(async (request, response) => {
      if (await routeRuntimeHealth(database, request, response)) {
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = server.address().port;
      const unauthenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`);
      assert.equal(unauthenticated.status, 404);
      assert.equal(await unauthenticated.text(), "Not found");

      const authenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "probe-secret" },
      });
      assert.equal(authenticated.status, 200);
      const body = await authenticated.json();
      assert.deepEqual(body, {
        ok: true,
        data: {
          runtime: { ready: true },
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
          },
        },
        error: null,
      });
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(dir), false);
      assert.equal(raw.includes("probe-secret"), false);
      assert.equal(raw.includes("SPORADES"), false);
    } finally {
      database.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("sporades host helper reports structured Hosted Capsule runtime health failures", async () => {
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "remote-root");

    async function writeHealthRecord(root, overrides = {}) {
      const domain = overrides.domain ?? "capsules.example.dev";
      const { scheme = "https", ...recordOverrides } = overrides;
      const registryRecordPath = path.join(root, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `${scheme}://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
          ...recordOverrides,
        })}\n`,
      );
    }

    async function runHealth(root, env = {}, host = {}) {
      const domain = host.domain ?? "capsules.example.dev";
      const scheme = host.scheme ?? "https";
      return runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme, remoteRoot: root },
          capsule: { subname: "team-notes" },
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env },
      );
    }

    const missingRoot = path.join(baseRoot, "missing");
    const missingDocker = await installFakeDocker(path.join(dir, "missing-docker"));
    const missing = await runHealth(missingRoot, missingDocker.env);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).data.failure, "unregistered-capsule");

    const noReleaseRoot = path.join(baseRoot, "no-release");
    await writeHealthRecord(noReleaseRoot, { currentRelease: null });
    const noReleaseDocker = await installFakeDocker(path.join(dir, "no-release-docker"));
    const noRelease = await runHealth(noReleaseRoot, noReleaseDocker.env);
    assert.equal(noRelease.code, 0, noRelease.stderr);
    assert.equal(JSON.parse(noRelease.stdout).data.failure, "no-current-release");

    const stoppedRoot = path.join(baseRoot, "stopped");
    await writeHealthRecord(stoppedRoot);
    const stoppedDocker = await installFakeDocker(path.join(dir, "stopped-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHealth(stoppedRoot, stoppedDocker.env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).data.failure, "stopped-container");

    const routeRoot = path.join(baseRoot, "route");
    const routeDocker = await installFakeDocker(path.join(dir, "route-docker"));
    const routePort = await reserveUnusedPort();
    const routeDomain = `localhost:${routePort}`;
    await writeHealthRecord(routeRoot, {
      domain: routeDomain,
      scheme: "http",
      hostedUrl: `http://team-notes.localhost:${routePort}`,
      remoteCapsuleId: `${routeDomain}/team-notes`,
    });
    const route = await runHealth(routeRoot, routeDocker.env, { domain: routeDomain, scheme: "http" });
    assert.equal(route.code, 0, route.stderr);
    assert.equal(JSON.parse(route.stdout).data.failure, "route-failure");

    const responseCases = [
      {
        failure: "runtime-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "sqlite-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: false }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "file-storage-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: false } } }, error: null },
      },
    ];

    for (const responseCase of responseCases) {
      const root = path.join(baseRoot, responseCase.failure);
      const docker = await installFakeDocker(path.join(dir, `${responseCase.failure}-docker`));
      await withHttpServer((request, response) => {
        assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseCase.body));
      }, async (port) => {
        const domain = `localhost:${port}`;
        await writeHealthRecord(root, {
          domain,
          scheme: "http",
          hostedUrl: `http://team-notes.localhost:${port}`,
          remoteCapsuleId: `${domain}/team-notes`,
        });
        const result = await runHealth(root, docker.env, { domain, scheme: "http" });
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.data.failure, responseCase.failure);
        assert.equal(result.stdout.includes("probe-secret"), false);
        assert.equal(result.stdout.includes(baseRoot), false);
      });
    }
  });
});

test("sporades host helper stops containers and routes Hosted Capsules to unavailable", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.stopped, true);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_keep 5/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "stopped");
  });
});

test("sporades host helper unregisters Hosted Capsules with tombstone TTL and route removal", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
    await writeFile(path.join(capsuleDir, "data", "guestbook.json"), "[]\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-06-30T22:15:00.000Z",
        updatedAt: "2026-06-30T22:16:00.000Z",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123",
          Names: "sporades-capsules-example-dev-team-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 minutes",
          Labels:
            "com.sporades.managed=true,com.sporades.hosted-domain=capsules.example.dev,com.sporades.capsule-subname=team-notes",
        })}\n`,
      },
    });
    const request = {
      action: "capsule.unregister",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      unregister: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "caller-controlled-name" },
        routes: {
          removed: { hostname: "team-notes.capsules.example.dev", target: "removed", routeFile: path.join(dir, "caller-route.caddy") },
        },
      },
    };

    const before = Date.now();
    const unregister = await runHostHelper(request, { cwd: dir, env: docker.env });
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.route.routeFile, routeFile);
    assert.equal(output.data.route.removed, true);
    const deleteAfterMs = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfterMs >= before + 89 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfterMs <= after + 91 * 24 * 60 * 60 * 1000);
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });
    assert.equal((await stat(path.join(capsuleDir, "releases"))).isDirectory(), true);
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    assert.equal(await readFile(path.join(capsuleDir, "data", "guestbook.json"), "utf8"), "[]\n");

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.match(record.unregisteredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"]],
    );

    const duplicate = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );

    const list = await runHostHelper(
      { action: "capsule.list", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot } },
      { cwd: dir, env: docker.env },
    );
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).data.capsules, []);

    const missing = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "missing" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(missing.code, 0, missing.stderr);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.ok, false);
    assert.equal(missingOutput.error.message, "Hosted Capsule is not registered.");
    assert.match(missingOutput.error.hint, /sporades host register missing/);
  });
});

test("sporades host helper reports normalized Docker no-stream stats with raw passthrough", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260101T000000Z-abcdef12" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({
          State: {
            Running: true,
            Status: "running",
            StartedAt: "2026-01-01T00:00:00.000Z",
          },
          RestartCount: 2,
        })}\n`,
        FAKE_DOCKER_STATS_JSON: `${JSON.stringify({
          Container: "abc123",
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "12.34%",
          MemUsage: "128MiB / 1GiB",
          MemPerc: "12.50%",
          NetIO: "1.5MB / 240kB",
          BlockIO: "8.19kB / 16.4MB",
          PIDs: "11",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "capsule.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        stats: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          container: { name: "sporades-capsules-example-dev-team-notes" },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.stats, {
      cpuPercent: 12.34,
      memoryUsageBytes: 134217728,
      memoryLimitBytes: 1073741824,
      memoryPercent: 12.5,
      networkInputBytes: 1500000,
      networkOutputBytes: 240000,
      blockInputBytes: 8190,
      blockOutputBytes: 16400000,
      pids: 11,
    });
    assert.equal(output.data.raw.CPUPerc, "12.34%");
    assert.equal(output.data.raw.MemUsage, "128MiB / 1GiB");
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.lifecycle.registered, true);
    assert.equal(output.data.lifecycle.registryStatus, "running");
    assert.equal(output.data.lifecycle.running, true);
    assert.equal(output.data.lifecycle.restartCount, 2);
    assert.equal(output.data.lifecycle.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(typeof output.data.lifecycle.uptimeSeconds, "number");
    assert.equal(output.data.lifecycle.currentReleaseId, "20260101T000000Z-abcdef12");
    assert.equal(output.data.lifecycle.routeTarget, "container");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args), [
      ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
      ["stats", "--no-stream", "--format", "json", "sporades-capsules-example-dev-team-notes"],
      ["inspect", "--format", "{{json .}}", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});

test("sporades host helper lists an empty Hosted Capsule registry", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    await mkdir(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"), { recursive: true });

    const list = await runHostHelper({
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
    });

    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [],
      },
      error: null,
    });
  });
});

test("sporades host helper lists registry records enriched with Docker container state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentRelease: null,
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        currentRelease: {
          id: "20260103T000000Z-abcdef12",
          createdAt: "2026-01-03T00:00:00.000Z",
          bundleHash: "sha256:abc123",
        },
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "archive.json"),
      `${JSON.stringify({
        subname: "archive",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/archive",
        hostedUrl: "https://archive.capsules.example.dev",
        status: "stopped",
        createdAt: "2026-01-04T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
        currentRelease: { id: "20260105T000000Z-fedcba98" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: [
          JSON.stringify({
            ID: "abc123def456",
            Names: "sporades-capsules-example-dev-notes",
            Image: "node:22-alpine",
            State: "running",
            Status: "Up 2 hours",
          }),
          JSON.stringify({
            ID: "fedcba654321",
            Names: "sporades-capsules-example-dev-archive",
            Image: "node:22-alpine",
            State: "exited",
            Status: "Exited (0) 3 minutes ago",
          }),
        ].join("\n") + "\n",
      },
    });

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [
          {
            subname: "archive",
            domain: "capsules.example.dev",
            hostedUrl: "https://archive.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/archive",
              createdAt: "2026-01-04T00:00:00.000Z",
              updatedAt: "2026-01-05T00:00:00.000Z",
              status: "stopped",
            },
            currentRelease: { id: "20260105T000000Z-fedcba98" },
            docker: {
              containerId: "fedcba654321",
              containerName: "sporades-capsules-example-dev-archive",
              image: "node:22-alpine",
              state: "exited",
              status: "Exited (0) 3 minutes ago",
              running: false,
            },
          },
          {
            subname: "drafts",
            domain: "capsules.example.dev",
            hostedUrl: "https://drafts.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/drafts",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              status: "registered",
            },
            currentRelease: null,
            docker: null,
          },
          {
            subname: "notes",
            domain: "capsules.example.dev",
            hostedUrl: "https://notes.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/notes",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
              status: "running",
            },
            currentRelease: {
              id: "20260103T000000Z-abcdef12",
              createdAt: "2026-01-03T00:00:00.000Z",
              bundleHash: "sha256:abc123",
            },
            docker: {
              containerId: "abc123def456",
              containerName: "sporades-capsules-example-dev-notes",
              image: "node:22-alpine",
              state: "running",
              status: "Up 2 hours",
              running: true,
            },
          },
        ],
      },
      error: null,
    });

    const dockerCalls = await readJsonl(docker.logPath);
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=archive",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
  });
});

test("sporades host helper keeps listing registry records when Docker lookup fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PS_STATUS: "1" } });

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsules[0].subname, "notes");
    assert.equal(output.data.capsules[0].docker, null);
  });
});

test("sporades host helper lists Hosted Capsule releases in deterministic order", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "team-notes.json"),
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: true,
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          { id: "", state: "nonsense" },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: false,
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs"] },
          },
        ],
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );
    assert.deepEqual(output.data.releases[0].startAttempts, [{ startedAt: "2026-06-30T22:16:00.000Z" }]);
    assert.deepEqual(output.data.releases[1].verificationAttempts, [{ verifiedAt: "2026-06-29T12:02:00.000Z" }]);
  });
});

test("sporades host helper lists legacy current release metadata without release history", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "team-notes.json"),
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface", createdAt: "2026-06-30T22:15:00.000Z" },
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.deepEqual(
      output.data.releases.map((release) => ({
        id: release.id,
        createdAt: release.createdAt,
        state: release.state,
        current: release.current,
        legacy: release.legacy,
      })),
      [
        {
          id: "20260630T221500Z-feedface",
          createdAt: "2026-06-30T22:15:00.000Z",
          state: "uploaded",
          current: true,
          legacy: true,
        },
      ],
    );
  });
});

test("sporades host helper reports missing and stopped Hosted Capsules for stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const request = {
      action: "capsule.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      stats: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "sporades-capsules-example-dev-team-notes" },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir });
    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before reading stats.",
      },
    });

    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(path.join(dir, "stopped"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no running container.",
        hint: "Run `sporades host start team-notes --host personal`, then retry stats.",
      },
    });

    const dockerInspectUnavailable = await installFakeDocker(path.join(dir, "docker-inspect-unavailable"), {
      env: { FAKE_DOCKER_RUNNING_STATUS: "1" },
    });
    const inspectUnavailable = await runHostHelper(request, { cwd: dir, env: dockerInspectUnavailable.env });
    assert.equal(inspectUnavailable.code, 0, inspectUnavailable.stderr);
    assert.deepEqual(JSON.parse(inspectUnavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });

    const dockerUnavailable = await installFakeDocker(path.join(dir, "docker-unavailable"), { env: { FAKE_DOCKER_STATS_STATUS: "1" } });
    const unavailable = await runHostHelper(request, { cwd: dir, env: dockerUnavailable.env });
    assert.equal(unavailable.code, 0, unavailable.stderr);
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});

test("sporades host helper reports Host server resource and Hosted Capsule counts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260103T000000Z-abcdef12" },
      })}\n`,
    );

    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123def456",
          Names: "sporades-capsules-example-dev-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 hours",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "host.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.host, {
      alias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      remoteRoot,
    });
    assert.equal(output.data.resources.disk.path, remoteRoot);
    assert.equal(typeof output.data.resources.disk.totalBytes, "number");
    assert.equal(typeof output.data.resources.memory.totalBytes, "number");
    assert.deepEqual(Object.keys(output.data.resources.load), ["oneMinute", "fiveMinutes", "fifteenMinutes"]);
    assert.deepEqual(output.data.services, {
      docker: { available: true },
      caddy: { available: true },
    });
    assert.deepEqual(output.data.capsules, {
      total: 2,
      registered: 1,
      running: 1,
      stopped: 0,
      unavailable: 1,
    });

    const dockerCalls = await docker.calls();
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      ["version", "--format", "{{.Server.Version}}"],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
    const caddyCalls = await docker.caddyCalls();
    assert.deepEqual(caddyCalls.map((call) => call.args), [["version"]]);
  });
});

test("sporades host helper reports malformed registry state for Host server stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    const recordPath = path.join(registryDir, "broken.json");
    await writeFile(recordPath, "{not-json}\n");

    const stats = await runHostHelper({
      action: "host.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
    });

    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule registry record is invalid.",
        hint: `Repair the Host server registry record at ${recordPath}, then retry \`sporades host stats --host personal\`.`,
      },
    });
  });
});

test("sporades host helper reads recent Caddy access log entries from the managed log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await mkdir(path.dirname(accessLog), { recursive: true });
    await writeFile(
      accessLog,
      [
        "2026/01/01 00:00:01 GET /old",
        "2026/01/01 00:00:02 GET /one",
        "2026/01/01 00:00:03 GET /two",
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["2026/01/01 00:00:02 GET /one", "2026/01/01 00:00:03 GET /two"],
      },
      error: null,
    });
  });
});

test("sporades host helper reads capsule-scoped HTTP logs from the Hosted Capsule log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleLog = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log");
    await mkdir(path.dirname(capsuleLog), { recursive: true });
    await writeFile(
      capsuleLog,
      [
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/old"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        logs: { source: "http", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: [
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
        ],
      },
      error: null,
    });
  });
});

test("sporades host helper falls back to Caddy journald logs when the managed log file is absent", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STDOUT: "caddy service started\nhandled request for team-notes.capsules.example.dev\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 50 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 50,
        source: "http",
        entries: ["caddy service started", "handled request for team-notes.capsules.example.dev"],
      },
      error: null,
    });
    assert.deepEqual((await journalctl.calls()).map((call) => call.args), [
      ["-u", "caddy", "-n", "50", "--no-pager", "-o", "cat"],
    ]);
  });
});

test("sporades host helper reads Hosted Capsule stdout and stderr from Docker logs", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: {
        FAKE_DOCKER_LOGS_STDOUT: "stdout old\nstdout one\nstdout two\n",
        FAKE_DOCKER_LOGS_STDERR: "stderr old\nstderr one\nstderr two\n",
      },
    });

    const stdout = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stdout", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stdout",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stdout one", "stdout two"],
      },
      error: null,
    });

    const stderr = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stderr", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stderr",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stderr one", "stderr two"],
      },
      error: null,
    });

    assert.deepEqual((await docker.calls()).map((call) => call.args), [
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});

test("sporades host helper reports unavailable Caddy logs as a structured error", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STATUS: "1",
        FAKE_JOURNALCTL_STDERR: "No journal files were found.\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 100 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});

test("sporades host helper reloads Caddy after lifecycle route changes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"));
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const start = await runHostHelper({ ...request, action: "capsule.start" }, { cwd: dir, env });
    assert.equal(start.code, 0, start.stderr);
    const stop = await runHostHelper({ ...request, action: "capsule.stop" }, { cwd: dir, env });
    assert.equal(stop.code, 0, stop.stderr);

    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper writes explicit Cloudflare origin TLS routes when requested", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"));
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
              tls: {
                mode: "cloudflare-origin",
                certificate: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.crt"),
                key: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.key"),
              },
            },
          },
        },
      },
      { cwd: dir, env },
    );
    assert.equal(start.code, 0, start.stderr);
    assert.match(
      await readFile(routeFile, "utf8"),
      /tls .*hosts\/capsules\.example\.dev\/tls\/origin\.crt .*hosts\/capsules\.example\.dev\/tls\/origin\.key/,
    );
  });
});

test("sporades host helper preserves previous route when Caddy validation fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_VALIDATE_STATUS: "1" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to validate Hosted Capsule route.",
        hint: "Check the generated Caddy route for this Hosted Capsule, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual((await caddy.calls()).map((call) => call.args), [["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"]]);
  });
});

test("sporades host helper reloads the restored route after candidate reload failure", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,0" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to apply Hosted Capsule route.",
        hint: "Check the Host server Caddy configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper reports candidate and rollback reload failures", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,1" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to apply Hosted Capsule route and failed to reload the restored Caddy config.",
        hint: "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper returns a standard JSON error when the Hosted domain registry is locked", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const lockDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", ".lock");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(lockDir, { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", status: "running" })}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: { ...docker.env, SPORADES_REGISTRY_LOCK_TIMEOUT_MS: "30" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain registry is locked.",
        hint: "Wait for the other Host server operation to finish, then retry the command.",
      },
    });
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
  });
});

test("sporades host helper keeps the authoritative registry JSON when an atomic write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const originalRecord = { subname: "team-notes", domain: "capsules.example.dev", status: "running" };
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify(originalRecord)}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: { ...docker.env, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to write Hosted Capsule registry record.",
        hint: "Check Host server disk permissions and free space, then retry the command.",
      },
    });
    assert.deepEqual(JSON.parse(await readFile(registryRecordPath, "utf8")), originalRecord);
    assert.deepEqual((await readdir(path.dirname(registryRecordPath))).sort(), ["team-notes.json"]);
  });
});

test("sporades host helper reports no release and failed starts with unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });
    const request = {
      action: "capsule.start",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const noRelease = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.deepEqual(JSON.parse(noRelease.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No Hosted Capsule release has been pushed.",
        hint: "Run `sporades host push --host personal --subname team-notes` before starting the Hosted Capsule.",
      },
    });

    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    await mkdir(releaseDir, { recursive: true });
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const failedStart = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(failedStart.stdout).ok, false);
    assert.equal(JSON.parse(failedStart.stdout).error.message, "Hosted Capsule container did not stay running.");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].startAttempts.length, 1);
    assert.match(record.releases[0].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].failure.message, "Hosted Capsule container did not stay running.");
    assert.match(record.releases[0].failure.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("sporades host helper fails start when Docker does not report a usable loopback published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PUBLISHED_PORT: "0.0.0.0:49153" } });

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    assert.deepEqual(JSON.parse(start.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Docker did not report a loopback published port for Hosted Capsule.",
        hint: "Ensure Docker published container port 4000 on 127.0.0.1, then retry `sporades host start team-notes --host personal`.",
      },
    });
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].failure.message, "Docker did not report a loopback published port for Hosted Capsule.");
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
        ["run", "--detach", "--name", "sporades-capsules-example-dev-team-notes", "--network", "sporades-hosted-capsules", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=5", "--label", "com.sporades.managed=true", "--label", "com.sporades.hosted-domain=capsules.example.dev", "--label", "com.sporades.capsule-subname=team-notes", "--label", "com.sporades.capsule-id=capsules.example.dev/team-notes", "--label", "com.sporades.release-id=20260630T221500Z-feedface", "--volume", `${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`, "--volume", `${path.join(capsuleDir, "current", "client.js")}:/app/client.js:ro`, "--volume", `${path.join(capsuleDir, "current", "index.html")}:/app/index.html:ro`, "--volume", `${path.join(capsuleDir, "current", "sporades.json")}:/app/sporades.json:ro`, "--volume", `${path.join(capsuleDir, "data")}:/app/data:rw`, "--workdir", "/app", "--env", "PORT=4000", "--publish", "127.0.0.1::4000", "node:22-alpine", "node", "/app/server.mjs"],
        ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
        ["inspect", "-f", "{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostIp}}:{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostPort}}", "sporades-capsules-example-dev-team-notes"],
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
  });
});

test("sporades host helper refuses to install a release for an unregistered Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before pushing a release.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});

test("sporades host helper unregisters a Hosted Capsule without deleting release or data storage", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import capsules.example.dev/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "running",
          createdAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:30:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const before = Date.now();
    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.preserved.releases, releaseDir);
    assert.equal(output.data.preserved.data, dataDir);
    assert.equal(output.data.route.removed, true);
    assert.equal(output.data.container.removed, true);
    const deleteAfter = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfter >= before + 90 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfter <= after + 90 * 24 * 60 * 60 * 1000 + 1000);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.unregistered, true);
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);

    const duplicate = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);

    const reactivate = await runHostHelper(
      {
        action: "capsule.register",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(reactivate.code, 0, reactivate.stderr);
    const reactivateOutput = JSON.parse(reactivate.stdout);
    assert.equal(reactivateOutput.ok, true);
    assert.equal(reactivateOutput.data.registered, true);
    assert.equal(reactivateOutput.data.reactivated, true);
    const reactivatedRecord = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(reactivatedRecord.status, "registered");
    assert.equal(reactivatedRecord.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(reactivatedRecord.deleteAfter, undefined);
    assert.equal(reactivatedRecord.unregisteredAt, undefined);
    assert.equal(reactivatedRecord.unregistered, undefined);
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host helper deletes unregistered Hosted Capsule storage only", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const otherCapsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "other-notes");
    const otherDomainCapsuleDir = path.join(remoteRoot, "hosts", "other.example.dev", "capsules", "team-notes");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(otherCapsuleDir, { recursive: true });
    await mkdir(otherDomainCapsuleDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(path.join(otherCapsuleDir, "keep.txt"), "same domain, different Capsule\n");
    await writeFile(path.join(otherDomainCapsuleDir, "keep.txt"), "same subname, different domain\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  respond \"removed\" 410\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "unregistered",
          unregistered: true,
          unregisteredAt: "2026-07-01T12:00:00.000Z",
          deleteAfter: "2026-09-29T12:00:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.registryRecord.path, registryRecordPath);
    assert.equal(output.data.registryRecord.removed, true);
    assert.equal(output.data.directories.capsule.path, capsuleDir);
    assert.equal(output.data.directories.capsule.removed, true);
    assert.equal(output.data.directories.releases.path, path.join(capsuleDir, "releases"));
    assert.equal(output.data.directories.releases.removed, true);
    assert.equal(output.data.directories.data.path, dataDir);
    assert.equal(output.data.directories.data.removed, true);
    assert.equal(output.data.route.path, routeFile);
    assert.equal(output.data.route.removed, true);
    await assert.rejects(stat(registryRecordPath), { code: "ENOENT" });
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.equal(await readFile(path.join(otherCapsuleDir, "keep.txt"), "utf8"), "same domain, different Capsule\n");
    assert.equal(await readFile(path.join(otherDomainCapsuleDir, "keep.txt"), "utf8"), "same subname, different domain\n");
    await assert.rejects(stat(docker.logPath), { code: "ENOENT" });
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);
  });
});

test("sporades host helper refuses to delete active Hosted Capsule registry states", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });

    for (const status of ["registered", "running", "stopped", "released"]) {
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status,
        })}\n`,
      );
      const deleted = await runHostHelper(
        {
          action: "capsule.delete",
          host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir },
      );
      assert.equal(deleted.code, 0, deleted.stderr);
      const output = JSON.parse(deleted.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
      assert.match(output.error.hint, /sporades host unregister team-notes/);
      assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, status);
      assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    }
  });
});

test("sporades host helper delete recovers partial cleanup and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const dataDir = path.join(capsuleDir, "data");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(dataDir, "leftover.db"), "partial cleanup leftover\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "unregistered",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const partial = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(partial.code, 0, partial.stderr);
    const partialOutput = JSON.parse(partial.stdout);
    assert.equal(partialOutput.ok, true);
    assert.equal(partialOutput.data.idempotent, false);
    assert.equal(partialOutput.data.registryRecord.removed, true);
    assert.equal(partialOutput.data.registryRecord.alreadyAbsent, false);
    assert.equal(partialOutput.data.directories.capsule.removed, true);
    assert.equal(partialOutput.data.route.removed, false);
    assert.equal(partialOutput.data.route.alreadyAbsent, true);
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });

    const retry = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(retry.code, 0, retry.stderr);
    const retryOutput = JSON.parse(retry.stdout);
    assert.equal(retryOutput.ok, true);
    assert.equal(retryOutput.data.idempotent, true);
    assert.equal(retryOutput.data.registryRecord.alreadyAbsent, true);
    assert.equal(retryOutput.data.directories.capsule.alreadyAbsent, true);
    assert.equal(retryOutput.data.route.alreadyAbsent, true);
  });
});

test("sporades host helper delete refuses missing tombstone when storage remains", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await writeFile(path.join(capsuleDir, "data", "live.db"), "must not delete without tombstone proof\n");

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
    assert.match(output.error.hint, /sporades host unregister team-notes/);
    assert.equal(await readFile(path.join(capsuleDir, "data", "live.db"), "utf8"), "must not delete without tombstone proof\n");
  });
});

test("sporades host helper restores the route when unregister tombstone write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    const originalRoute = "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n";
    await writeFile(routeFile, originalRoute);
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } });

    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Failed to write Hosted Capsule registry record.");
    assert.equal(await readFile(routeFile, "utf8"), originalRoute);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper fails unregister for a missing Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    assert.deepEqual(JSON.parse(unregister.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before unregistering the Hosted Capsule.",
      },
    });
  });
});

test("sporades host helper omits unregistered Capsules from list output", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "active.json"),
      `${JSON.stringify({
        subname: "active",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/active",
        hostedUrl: "https://active.capsules.example.dev",
        status: "registered",
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "old.json"),
      `${JSON.stringify({
        subname: "old",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/old",
        hostedUrl: "https://old.capsules.example.dev",
        status: "unregistered",
        unregistered: true,
        deleteAfter: "2026-09-29T12:00:00.000Z",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(
      output.data.capsules.map((capsule) => capsule.subname),
      ["active"],
    );
  });
});

test("sporades host helper derives install paths from Host state instead of request-supplied directories", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const outsideDir = path.join(dir, "outside-target");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: outsideDir,
            releases: path.join(outsideDir, "releases"),
            release: path.join(outsideDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(outsideDir, "data"),
          },
          currentLink: path.join(outsideDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.release.directory, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    assert.equal(output.data.release.currentLink, path.join(capsuleDir, "current"));
    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readlink(path.join(capsuleDir, "current")), path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(stat(path.join(outsideDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(outsideDir, "current")), { code: "ENOENT" });
  });
});

test("sporades host helper discards known macOS archive metadata during release install", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(path.join(runtimeDir, "__MACOSX"), { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, "._server.mjs"), "appledouble metadata\n");
    await writeFile(path.join(runtimeDir, "__MACOSX", "._server.mjs"), "appledouble metadata\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      "._server.mjs",
      "__MACOSX",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.deepEqual((await readdir(releaseDir)).toSorted(), ["client.js", "index.html", "server.mjs", "sporades.json"]);
  });
});

test("sporades host helper rejects unsafe or unexpected release archive entries before extraction", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await symlink("server.mjs", path.join(runtimeDir, "linked-server.mjs"));
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "client.js",
      "index.html",
      "sporades.json",
      "source.ts",
      "linked-server.mjs",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unsafe entries.",
        hint: "Push again so Sporades can package regular runtime files only.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects archives with unexpected or missing runtime files", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "source.ts"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unexpected files.",
        hint: "Push again so Sporades can package only runtime files.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects release archives with parent-relative paths", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(dir, "outside.txt"), "must not extract outside release\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json", "../outside.txt"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unsafe paths.",
        hint: "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper restarts the current release after install when requested", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args[0]),
      ["stop", "rm", "stop", "rm", "run", "inspect", "inspect"],
    );
    const runCall = (await docker.calls())[4];
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert.equal(output.data.lifecycle.container.publishedPort.hostPort, 49153);
    assert.equal(output.data.lifecycle.route.upstream, "127.0.0.1:49153");
  });
});

test("sporades host helper verifies a pushed Hosted Capsule release after restart", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verified",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verified-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: {
            enabled: true,
            health: { runtimeHealthUrl: `http://malicious.localhost:${port}/__sporades/health/runtime` },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 0, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.installed, true);
      assert.equal(output.data.restarted, true);
      assert.equal(output.data.verified, true);
      assert.equal(output.data.release.id, fixture.releaseId);
      assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
      assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
      assert.equal(output.data.verification.state, "verified");
      assert.equal(output.data.verification.health.route.responding, true);
      assert.equal(output.data.verification.health.runtime.ready, true);
      assert.equal(install.stdout.includes(probeToken), false);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "running");
      assert.equal(release.state, "verified");
      assert.equal(release.current, true);
      assert.equal(release.verificationAttempts.length, 1);
      assert.match(release.verificationAttempts[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(release.failure, null);
    });
  });
});

test("sporades host helper marks verified push failed when the Capsule route does not become healthy", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-route-failure",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const docker = await installFakeDocker(path.join(dir, "verify-route-failure-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          healthTimeoutMs: 25,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.release.id, fixture.releaseId);
    assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
    assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
    assert.equal(output.data.verified, false);
    assert.equal(output.data.verification.state, "failed");
    assert.equal(output.data.verification.health.failure, "route-failure");
    assert.equal(output.data.rollbackGuidance.command, `sporades host rollback team-notes ${fixture.previousReleaseId} --host personal`);
    assert.equal(output.error.message, "Hosted Capsule release verification failed.");
    assert.match(output.error.hint, /sporades host rollback team-notes 20260629T120000Z-deadbeef --host personal/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
    assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const release = record.releases.find((entry) => entry.id === fixture.releaseId);
    assert.equal(record.currentRelease.id, fixture.releaseId);
    assert.equal(record.status, "failed");
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Hosted Capsule route did not respond to runtime health.");
    assert.equal(release.verificationAttempts.length, 1);
    assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule route did not respond to runtime health.");
  });
});

test("sporades host helper marks verified push failed when runtime health checks fail", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          data: {
            runtime: { ready: false },
            checks: {
              sqlite: { ok: false },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verify-runtime-failure",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verify-runtime-failure-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: { enabled: true },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 1, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(install.stdout.includes(probeToken), false);
      assert.equal(output.ok, false);
      assert.equal(output.data.verification.health.failure, "sqlite-failure");
      assert.equal(output.data.verification.health.runtime.checks.sqlite.ok, false);
      assert.equal(output.data.rollbackGuidance.previousReleaseId, fixture.previousReleaseId);
      assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
      assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "failed");
      assert.equal(release.state, "failed");
      assert.equal(release.failure.message, "Hosted Capsule SQLite health check failed.");
      assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule SQLite health check failed.");
    });
  });
});

test("sporades host helper reports push restart failure after installing the release", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: {
        installed: true,
        restartRequested: true,
        restarted: false,
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
        },
        release: {
          id: "20260630T221500Z-feedface",
          directory: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          currentLink: path.join(capsuleDir, "current"),
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          serverEnvIncluded: false,
        },
      },
      error: {
        message: "Hosted Capsule restart failed.",
        hint: "Check Docker logs for sporades-capsules-example-dev-team-notes; the route has been returned to the Hosted Capsule unavailable response.",
      },
    });
    assert.equal(await readlink(path.join(capsuleDir, "current")), path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
  });
});

test("sporades host helper preserves install metadata when push restart route reload fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(runtimeDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "client.js", "index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "client.js", "index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    assert.equal(await readlink(path.join(capsuleDir, "current")), path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].startAttempts.length, 1);
    assert.equal(record.releases[0].failure.message, "Failed to apply Hosted Capsule route.");
    assert.match(record.releases[0].failure.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("sporades host helper rolls back to a recorded release and preserves persistent Capsule data", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releasesDir = path.join(capsuleDir, "releases");
    const currentReleaseDir = path.join(releasesDir, "20260630T221500Z-feedface");
    const rollbackReleaseDir = path.join(releasesDir, "20260629T120000Z-deadbeef");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(currentReleaseDir, { recursive: true });
    await mkdir(rollbackReleaseDir, { recursive: true });
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    for (const releaseDir of [currentReleaseDir, rollbackReleaseDir]) {
      await writeFile(path.join(releaseDir, "server.mjs"), `export default ${JSON.stringify(path.basename(releaseDir))};\n`);
      await writeFile(path.join(releaseDir, "client.js"), "console.log('client bundle');\n");
      await writeFile(path.join(releaseDir, "index.html"), "<div id=\"root\"></div>\n");
      await writeFile(path.join(releaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    }
    await symlink(currentReleaseDir, path.join(capsuleDir, "current"));
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "photo.bin"), "uploaded bytes\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "client.js", "index.html", "sporades.json"] },
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
          },
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: false,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "client.js", "index.html", "sporades.json"] },
            startAttempts: [],
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
          },
        ],
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        rollback: { releaseId: "20260629T120000Z-deadbeef" },
        lifecycle: {
          remoteRoot,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rolledBack, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260629T120000Z-deadbeef");
    assert.equal(await readlink(path.join(capsuleDir, "current")), rollbackReleaseDir);
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "sqlite bytes\n");
    assert.equal(await readFile(path.join(dataDir, "uploads", "photo.bin"), "utf8"), "uploaded bytes\n");
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.ok(runCall);
    assert.ok(runCall.args.includes(`${dataDir}:/app/data:rw`));
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: false },
        { id: "20260629T120000Z-deadbeef", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
  });
});

test("sporades host helper rejects rollback to an unknown release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: "20260628T120000Z-cafebabe" },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    assert.deepEqual(JSON.parse(rollback.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release is not recorded.",
        hint: "Run `sporades host releases team-notes --host personal --json` and choose a recorded release ID.",
      },
    });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});

test("sporades host helper rejects rollback when selected release files are missing", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      missingFiles: ["20260629T120000Z-deadbeef/server.mjs"],
    });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule release files are missing.");
    assert.match(output.error.hint, /recorded release cannot be started/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});

test("sporades host helper starts a stopped Capsule during rollback", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { status: "stopped" });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.release.id, fixture.rollbackReleaseId);
    assert.ok((await docker.calls()).some((call) => call.args[0] === "run"));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
  });
});

test("sporades host helper rejects rollback for unregistered Capsules and empty release history", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { noReleaseHistory: true, currentReleaseId: null, releaseIds: [] });
    const missing = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "missing" },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register missing --host personal` before managing the Hosted Capsule lifecycle.",
      },
    });

    const noHistory = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(noHistory.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no release history.",
        hint: "Push a release before running `sporades host rollback team-notes <release-id> --host personal`.",
      },
    });
  });
});

test("sporades host helper records failed rollback starts and leaves the route unavailable", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Hosted Capsule rollback start failed.");
    assert.match(output.error.hint, new RegExp(`Previous current release was ${fixture.currentReleaseId}`));
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), fixture.rollbackReleaseDir);
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.startAttempts.length, 1);
    assert.equal(release.failure.message, "Hosted Capsule container did not stay running.");
  });
});

test("sporades host helper returns rollback route reload failures to the unavailable route", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Failed to apply Hosted Capsule route.");
  });
});

test("sporades host register leaves local binding untouched when authoritative registration fails", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule subname is already registered for this Hosted domain.",
    hint: "Choose a different Capsule subname for " + request.host.domain + "."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host register relies on the Host server for domain-scoped uniqueness", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(stdin);
const statePath = process.env.FAKE_REGISTER_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const key = request.host.domain + "/" + request.capsule.subname;
if (state[key]) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: {
      message: "Hosted Capsule subname is already registered for this Hosted domain.",
      hint: "Choose a different Capsule subname for " + request.host.domain + "."
    }
  }) + "\\n");
  process.exit(0);
}
state[key] = true;
writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId
    },
    route: request.registration.route
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    const env = { ...hostEnv(configDir), ...fakeSsh.env, FAKE_REGISTER_STATE: path.join(dir, "register-state.json") };

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(
          ["host", "add", "work", "--server", "root@example.test", "--domain", "apps.work.test", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );

    const first = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(first.code, 0, first.stderr);

    const duplicate = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(duplicate.code, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

    const sameSubnameDifferentDomain = await runCli(["host", "register", "notes", "--host", "work", "--json"], { cwd: projectDir, env });
    assert.equal(sameSubnameDifferentDomain.code, 0, sameSubnameDifferentDomain.stderr);
    assert.equal(JSON.parse(sameSubnameDifferentDomain.stdout).data.binding.remoteCapsuleId, "apps.work.test/notes");
  });
});

test("sporades host register reports bootstrap-required failures with TLS file hints", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted domain has not been bootstrapped.",
    hint: "Run \`" + request.registration.bootstrap.command + "\` after installing readable Cloudflare origin certificate and key files at " + request.registration.bootstrap.tls.certificate + " and " + request.registration.bootstrap.tls.key + "."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    const addHost = await runCli(
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain has not been bootstrapped.",
        hint: "Run `sporades host bootstrap --host personal` after installing readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key.",
      },
    });
  });
});

test("sporades host register validates lowercase DNS-safe non-reserved Capsule subnames before SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "register", "Team_Notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Capsule subname.",
        hint: "Use a lowercase DNS-safe label such as `notes` or `team-notes`.",
      },
    });

    const reserved = await runCli(["host", "register", "www", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(reserved.code, 1);
    assert.deepEqual(JSON.parse(reserved.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Reserved Capsule subname.",
        hint: "Choose a Capsule subname other than www, api, admin, root, or host.",
      },
    });

    await fakeSsh.assertNotCalled();
  });
});

test("sporades host unregister invokes the Hosted Capsule unregister helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.unregister") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.unregister." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    unregistered: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.unregister.hostedUrl,
      remoteCapsuleId: request.unregister.remoteCapsuleId
    },
    deleteAfter: "2026-09-29T12:00:00.000Z",
    route: request.unregister.routes.removed,
    container: request.unregister.container
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const unregister = await runCli(["host", "unregister", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.deleteAfter, "2026-09-29T12:00:00.000Z");

    const plain = await runCli(["host", "unregister", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule unregistered: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.unregister",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      unregister: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
        routes: {
          removed: {
            hostname: "team-notes.capsules.example.dev",
            target: "removed",
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          },
        },
      },
    });
  });
});

test("sporades host delete invokes the Hosted Capsule delete helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.delete") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.delete." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    deleted: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.delete.hostedUrl,
      remoteCapsuleId: request.delete.remoteCapsuleId
    },
    registryRecord: {
      path: request.delete.registryRecord,
      removed: true,
      alreadyAbsent: false
    },
    directories: {
      capsule: { path: request.delete.directories.capsule, removed: true, alreadyAbsent: false },
      releases: { path: request.delete.directories.releases, removed: true, alreadyAbsent: false },
      data: { path: request.delete.directories.data, removed: true, alreadyAbsent: false }
    },
    route: {
      path: request.delete.routes.removed.routeFile,
      removed: true,
      alreadyAbsent: false
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const deleted = await runCli(["host", "delete", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");

    const plain = await runCli(["host", "delete", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule storage deleted: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.delete",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      delete: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
        },
        routes: {
          removed: {
            hostname: "team-notes.capsules.example.dev",
            target: "removed",
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          },
        },
      },
    });
  });
});

test("sporades host list works from outside a project and reports an empty registry", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: []
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const list = await runCli(["host", "list", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        capsules: [],
      },
      error: null,
    });

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "No Hosted Capsules registered for capsules.example.dev.\n");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host releases lists release history for one Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    currentRelease: { id: "20260630T221500Z-feedface" },
    releases: [
      {
        id: "20260630T221500Z-feedface",
        createdAt: "2026-06-30T22:15:00.000Z",
        uploadedAt: "2026-06-30T22:15:00.000Z",
        state: "started",
        current: true,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
        verificationAttempts: [],
        failure: null
      },
      {
        id: "20260629T120000Z-deadbeef",
        createdAt: "2026-06-29T12:00:00.000Z",
        uploadedAt: "2026-06-29T12:00:00.000Z",
        state: "verified",
        current: false,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-29T12:01:00.000Z" }],
        verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
        failure: null
      }
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const releases = await runCli(["host", "releases", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });
  });
});

test("sporades host rollback invokes the Hosted Capsule rollback helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.rollback") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.rollback." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    rolledBack: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    previousCurrentRelease: { id: "20260630T221500Z-feedface" },
    currentRelease: { id: request.rollback.releaseId },
    lifecycle: {
      started: true,
      restarted: true,
      release: { id: request.rollback.releaseId },
      container: { name: "sporades-capsules-example-dev-team-notes", running: true }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const rollback = await runCli(
      ["host", "rollback", "team-notes", "20260629T120000Z-deadbeef", "--host", "personal", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.rollback",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      rollback: {
        releaseId: "20260629T120000Z-deadbeef",
      },
      lifecycle: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        currentLink: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        mounts: {
          files: [
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/client.js", container: "/app/client.js", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/index.html", container: "/app/index.html", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server", container: "/app/.env.sporades.server", mode: "ro", optional: true },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
              container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
              mode: "ro",
              optional: true,
            },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
              container: "/app/.sporades/sealed-server-env/server-env.private.pem",
              mode: "ro",
              optional: true,
            },
          ],
          data: {
            host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
            container: "/app/data",
            mode: "rw",
          },
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          labels: {
            "com.sporades.managed": "true",
            "com.sporades.hosted-domain": "capsules.example.dev",
            "com.sporades.capsule-subname": "team-notes",
            "com.sporades.capsule-id": "capsules.example.dev/team-notes",
          },
        },
        routes: {
          running: {
            hostname: "team-notes.capsules.example.dev",
            target: "container",
            containerName: "sporades-capsules-example-dev-team-notes",
            port: 4000,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
          },
          unavailable: {
            hostname: "team-notes.capsules.example.dev",
            target: "hosted-capsule-unavailable",
            statusCode: 503,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
            log: { file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log" },
          },
        },
      },
    });
  });
});

test("sporades host list combines registry release metadata and fake Docker state", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [
      {
        subname: "drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/drafts",
          registeredAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "registered"
        },
        currentRelease: null,
        docker: null
      },
      {
        subname: "notes",
        hostedUrl: "https://notes.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/notes",
          registeredAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          status: "released"
        },
        currentRelease: {
          id: "20260104T000000Z",
          createdAt: "2026-01-04T00:00:00.000Z",
          bundleHash: "sha256:abc123"
        },
        docker: {
          containerId: "abc123def456",
          containerName: "sporades-capsules-example-dev-notes",
          state: "running",
          status: "Up 2 hours",
          running: true,
          image: "node:22-alpine"
        }
      },
      {
        subname: "archive",
        hostedUrl: "https://archive.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/archive",
          registeredAt: "2026-01-05T00:00:00.000Z",
          updatedAt: "2026-01-06T00:00:00.000Z",
          status: "stopped"
        },
        currentRelease: {
          id: "20260106T000000Z",
          createdAt: "2026-01-06T00:00:00.000Z"
        },
        docker: {
          containerId: "fedcba654321",
          containerName: "sporades-capsules-example-dev-archive",
          state: "exited",
          status: "Exited (0) 3 minutes ago",
          running: false,
          image: "node:22-alpine"
        }
      }
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const data = JSON.parse(list.stdout).data;
    assert.equal(data.capsules.length, 3);
    assert.equal(data.capsules[0].subname, "drafts");
    assert.equal(data.capsules[0].currentRelease, null);
    assert.equal(data.capsules[0].docker, null);
    assert.equal(data.capsules[1].currentRelease.bundleHash, "sha256:abc123");
    assert.equal(data.capsules[1].docker.running, true);
    assert.equal(data.capsules[2].docker.running, false);

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /SUBNAME\s+URL\s+REGISTRY\s+RELEASE\s+DOCKER/);
    assert.match(plain.stdout, /drafts\s+https:\/\/drafts\.capsules\.example\.dev\s+registered\s+none\s+unavailable/);
    assert.match(plain.stdout, /notes\s+https:\/\/notes\.capsules\.example\.dev\s+released\s+20260104T000000Z\s+running \(Up 2 hours\)/);
    assert.match(plain.stdout, /archive\s+https:\/\/archive\.capsules\.example\.dev\s+stopped\s+20260106T000000Z\s+stopped \(Exited \(0\) 3 minutes ago\)/);
  });
});

test("sporades host list trusts the Host server registry over a local project binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [{
      subname: "registry-notes",
      hostedUrl: "https://registry-notes.capsules.example.dev",
      registry: {
        remoteCapsuleId: "capsules.example.dev/registry-notes",
        registeredAt: "2026-01-01T00:00:00.000Z",
        status: "registered"
      },
      currentRelease: null,
      docker: null
    }]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "remote-binding.json"),
      `${JSON.stringify({
        hostAlias: "personal",
        domain: "wrong.example.dev",
        scheme: "https",
        subname: "local-notes",
        hostedUrl: "https://local-notes.wrong.example.dev",
        remoteCapsuleId: "wrong.example.dev/local-notes",
      })}\n`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.data.capsules[0].subname, "registry-notes");
    assert.doesNotMatch(list.stdout, /local-notes/);
    assert.doesNotMatch(list.stdout, /wrong\.example\.dev/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host stats resolves a Hosted Capsule and returns normalized Docker stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.stats") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.stats." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.stats.hostedUrl,
      remoteCapsuleId: request.stats.remoteCapsuleId
    },
    container: {
      name: request.stats.container.name,
      running: true
    },
    stats: {
      cpuPercent: 3.14,
      memoryUsageBytes: 104857600,
      memoryLimitBytes: 536870912,
      memoryPercent: 19.53,
      networkInputBytes: 2048,
      networkOutputBytes: 4096,
      blockInputBytes: 8192,
      blockOutputBytes: 16384,
      pids: 7
    },
    lifecycle: {
      registered: true,
      registryStatus: "running",
      running: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSeconds: 7200,
      restartCount: 1,
      currentReleaseId: "20260101T000000Z-abcdef12",
      routeTarget: "container"
    },
    raw: {
      Name: "sporades-capsules-example-dev-team-notes",
      CPUPerc: "3.14%",
      MemUsage: "100MiB / 512MiB",
      MemPerc: "19.53%",
      NetIO: "2kB / 4kB",
      BlockIO: "8kB / 16kB",
      PIDs: "7"
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          running: true,
        },
        stats: {
          cpuPercent: 3.14,
          memoryUsageBytes: 104857600,
          memoryLimitBytes: 536870912,
          memoryPercent: 19.53,
          networkInputBytes: 2048,
          networkOutputBytes: 4096,
          blockInputBytes: 8192,
          blockOutputBytes: 16384,
          pids: 7,
        },
        lifecycle: {
          registered: true,
          registryStatus: "running",
          running: true,
          startedAt: "2026-01-01T00:00:00.000Z",
          uptimeSeconds: 7200,
          restartCount: 1,
          currentReleaseId: "20260101T000000Z-abcdef12",
          routeTarget: "container",
        },
        raw: {
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "3.14%",
          MemUsage: "100MiB / 512MiB",
          MemPerc: "19.53%",
          NetIO: "2kB / 4kB",
          BlockIO: "8kB / 16kB",
          PIDs: "7",
        },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: { subname: "team-notes" },
      stats: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
  });
});

test("sporades host stats without a subname resolves the selected Host profile and returns Host server stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.stats" || request.capsule !== null) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.stats without a Capsule." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    resources: {
      disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
      memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
      load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 }
    },
    services: { docker: { available: true }, caddy: { available: true } },
    capsules: { total: 2, registered: 1, running: 1, stopped: 0 }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        resources: {
          disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
          memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
          load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 },
        },
        services: { docker: { available: true }, caddy: { available: true } },
        capsules: { total: 2, registered: 1, running: 1, stopped: 0 },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host current reports effective Hosted security policy without contacting the Host server", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });
    await writeFile(
      path.join(dir, "sporades.json"),
      `${JSON.stringify(
        {
          name: "hosted-security-island",
          client: { framework: "react" },
          security: {
            cors: { allowedOrigins: ["https://dashboard.example.test"] },
            csp: { mode: "enforce" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const fakeSsh = await installFakeSsh(dir);

    const current = await runCli(["host", "current", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(current.code, 0, current.stderr);
    const body = JSON.parse(current.stdout);
    assert.equal(body.data.alias, "personal");
    assert.equal(body.data.security.csp.header, "content-security-policy");
    assert.deepEqual(body.data.security.cors.allowedOrigins, ["https://dashboard.example.test"]);
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host stats without a Host profile reports a structured JSON failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(stats.code, 1);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No current Host profile selected.",
        hint: "Run `sporades host use <alias>` or pass `--host <alias>`.",
      },
    });
  });
});

test("sporades host stats help text shows the optional Capsule subname form", async () => {
  await withTempDir(async (dir) => {
    const stats = await runCli(["host", "stats", "one", "two", "--json"], { cwd: dir });

    assert.equal(stats.code, 1);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Too many positional arguments.",
        hint: "Use `sporades host stats [subname] --host <alias>`.",
      },
    });
  });
});

test("sporades host stats handles SSH failure and remote helper failure as structured JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
        { cwd: dir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
    };

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    await addHost(transportFailureSsh.env);
    const transportFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Failed to read Hosted Capsule Docker stats.",
    hint: "Check Docker on the Host server and retry \`sporades host stats team-notes --host personal\`."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});

test("sporades host logs retrieves default HTTP log lines as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.logs" || request.logs?.source !== "http") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected log request.", hint: "Use host.logs for Caddy combined logs." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines ?? 200,
    source: request.logs.source,
    entries: ["203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] \\"GET / HTTP/1.1\\" 200 12"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) })).code, 0);

    const logs = await runCli(["host", "logs", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 200,
        source: "http",
        entries: ['203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] "GET / HTTP/1.1" 200 12'],
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.logs",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      logs: {
        source: "http",
      },
    });
  });
});

test("sporades host logs prints only recent HTTP log lines in plain output", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    entries: [
      "198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] \\"GET /one HTTP/1.1\\" 200 10",
      "198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] \\"GET /two HTTP/1.1\\" 404 0"
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "work", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const logs = await runCli(["host", "logs", "http", "--host", "work", "-n", "2"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.equal(
      logs.stdout,
      '198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] "GET /one HTTP/1.1" 200 10\n198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] "GET /two HTTP/1.1" 404 0\n',
    );

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.lines, 2);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
  });
});

test("sporades host logs can request HTTP logs for one Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    source: request.logs.source,
    entries: [request.capsule.subname + " http"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const logs = await runCli(["host", "logs", "http", "--host", "personal", "--subname", "team-notes", "-n", "4", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout).data, {
      lineCount: 4,
      source: "http",
      entries: ["team-notes http"],
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
    assert.equal(JSON.parse(sshCall.stdin).capsule.subname, "team-notes");
  });
});

test("sporades host logs requests capsule stdout and stderr using a Hosted Capsule binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    source: request.logs.source,
    container: "sporades-capsules-example-dev-team-notes",
    entries: [request.logs.source + " one", request.capsule.subname]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(bind.code, 0, bind.stderr);

    const stdout = await runCli(["host", "logs", "stdout", "-n", "7", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout).data, {
      lineCount: 7,
      source: "stdout",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stdout one", "team-notes"],
    });

    const stderr = await runCli(["host", "logs", "stderr", "--host", "personal", "--subname", "team-notes", "--lines", "3", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout).data, {
      lineCount: 3,
      source: "stderr",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stderr one", "team-notes"],
    });

    const calls = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(calls[0].stdin).logs.source, "stdout");
    assert.equal(JSON.parse(calls[0].stdin).capsule.subname, "team-notes");
    assert.equal(JSON.parse(calls[1].stdin).logs.source, "stderr");
    assert.equal(JSON.parse(calls[1].stdin).capsule.subname, "team-notes");
  });
});

test("sporades host logs validates invalid line counts without calling SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "logs", "--lines", "0", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host log line count.",
        hint: "Pass `--lines <n>` with a whole number between 1 and 10000.",
      },
    });
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host logs handles empty logs, SSH failure, and remote helper failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
        { cwd: projectDir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
    };

    const emptyLogsSsh = await installContractFakeSsh(
      path.join(dir, "empty-logs"),
      `process.stdout.write(JSON.stringify({ ok: true, data: { lineCount: JSON.parse(stdin).logs.lines, entries: [] }, error: null }) + "\\n");
process.exit(0);
`,
    );
    await addHost(emptyLogsSsh.env);
    const emptyLogs = await runCli(["host", "logs", "--host", "personal"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...emptyLogsSsh.env },
    });
    assert.equal(emptyLogs.code, 0, emptyLogs.stderr);
    assert.equal(emptyLogs.stdout, "");

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Host server Caddy combined logs are unavailable.",
    hint: "Run \`sporades host bootstrap --host personal\` and check Caddy on the Host server."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});

test("sporades host github workflow write dry-runs an inspectable autodeploy workflow", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.file, ".github/workflows/sporades-autodeploy.yml");
    assert.equal(output.data.written, false);
    assert.match(output.data.workflow, /branches: \["main"\]/);
    assert.match(output.data.workflow, /node-version: 22/);
    assert.match(output.data.workflow, /npm ci/);
    assert.match(output.data.workflow, /npm install/);
    assert.match(output.data.workflow, /npm test/);
    assert.match(output.data.workflow, /SPORADES_HOST_ALIAS: personal/);
    assert.match(output.data.workflow, /SPORADES_HOST_SUBNAME: team-notes/);
    assert.match(output.data.workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.match(output.data.workflow, /vars\.SPORADES_HOST_SERVER/);
    assert.match(output.data.workflow, /npx sporades host current --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host health --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host push --host "\$SPORADES_HOST_ALIAS" --subname "\$SPORADES_HOST_SUBNAME" --verify --json/);
    assert.deepEqual(output.data.github.secrets, ["SPORADES_HOST_SSH_PRIVATE_KEY"]);
    assert.deepEqual(output.data.github.variables, [
      "SPORADES_HOST_SERVER",
      "SPORADES_HOST_DOMAIN",
      "SPORADES_HOST_REMOTE_ROOT",
    ]);
    await assert.rejects(readFile(path.join(dir, ".github", "workflows", "sporades-autodeploy.yml"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host github workflow reports successful deploys to GitHub summaries", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY: \$\{\{ runner\.temp \}\}\/sporades-autodeploy-summary\.md/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /Hosted Capsule/);
    assert.match(workflow, /Release ID/);
    assert.match(workflow, /Verification/);
    assert.match(workflow, /data\.capsule\?\.hostedUrl/);
    assert.match(workflow, /data\.release\?\.id/);
    assert.match(workflow, /verification\?\.state/);
  });
});

test("sporades host github workflow reports verification failures without automatic rollback", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Verification failed/);
    assert.match(workflow, /rollbackGuidance\?\.command/);
    assert.match(workflow, /previousCurrentRelease\?\.id/);
    assert.match(workflow, /sporades host rollback/);
    assert.match(workflow, /Sporades did not roll back automatically/);
    assert.doesNotMatch(workflow, /npx sporades host rollback/);
  });
});

test("sporades host github workflow reports command failures without exposing sensitive values", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Command failed/);
    assert.match(workflow, /No structured Sporades deploy output was available/);
    assert.match(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.doesNotMatch(workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*>>/);
    assert.doesNotMatch(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*GITHUB_STEP_SUMMARY/);
    assert.doesNotMatch(workflow, /session token/i);
    assert.doesNotMatch(workflow, /Server env values/);
  });
});

test("sporades host github workflow associates pull request deploy results", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /pull_request:\n    branches: \["main"\]/);
    assert.match(workflow, /pull-requests: write/);
    assert.match(workflow, /if: always\(\) && github\.event_name == 'pull_request'/);
    assert.match(workflow, /actions\/github-script@v7/);
    assert.match(workflow, /github\.rest\.pulls\.createReview/);
    assert.match(workflow, /pull_number: context\.payload\.pull_request\.number/);
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY/);
  });
});

test("sporades host github workflow associates branch push deploy results with the workflow run summary", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "release/stable", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /push:\n    branches: \["release\/stable"\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /fs\.appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /fs\.writeFileSync\(process\.env\.SPORADES_AUTODEPLOY_SUMMARY/);
  });
});

test("sporades host github workflow write writes a workflow and refuses accidental overwrite", async () => {
  await withTempDir(async (dir) => {
    const file = ".github/workflows/custom-sporades.yml";
    const first = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "feat,main", "--file", file, "--json"],
      { cwd: dir },
    );

    assert.equal(first.code, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout);
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.data.file, file);
    assert.equal(firstOutput.data.written, true);

    const workflowPath = path.join(dir, file);
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /branches: \["feat,main"\]/);
    assert.match(workflow, /SPORADES_HOST_ALIAS: work/);
    assert.match(workflow, /SPORADES_HOST_SUBNAME: field-notes/);

    const second = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "release/stable", "--file", file, "--json"],
      { cwd: dir },
    );
    assert.equal(second.code, 1);
    assert.deepEqual(JSON.parse(second.stdout), {
      ok: false,
      data: null,
      error: {
        message: "GitHub Actions workflow already exists.",
        hint: "Pass `--force` to overwrite it, or choose another path with `--file <path>`.",
      },
    });

    const forced = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "main", "--file", file, "--force", "--json"],
      { cwd: dir },
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(workflowPath, "utf8"), /branches: \["main"\]/);

    const outsideProject = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--file", "../outside.yml", "--json"],
      { cwd: dir },
    );
    assert.equal(outsideProject.code, 1);
    assert.deepEqual(JSON.parse(outsideProject.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid GitHub workflow file path.",
        hint: "Pass a relative path inside the project, such as `.github/workflows/sporades-autodeploy.yml`.",
      },
    });
  });
});

test("sporades host validation returns standard JSON errors", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await mkdir(configDir, { recursive: true });

    const missingAlias = await runCli(["host", "add", "--server", "root@example.com", "--domain", "example.com", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(missingAlias.code, 1);
    assert.deepEqual(JSON.parse(missingAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Missing Host profile alias.",
        hint: "Use `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>`.",
      },
    });

    const invalidDomain = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "bad_domain", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidDomain.code, 1);
    assert.deepEqual(JSON.parse(invalidDomain.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Hosted domain.",
        hint: "Pass a DNS domain such as `example.com` without a scheme, path, or wildcard.",
      },
    });

    const invalidRemoteRoot = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "example.com", "--remote-root", "relative/path", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidRemoteRoot.code, 1);
    assert.deepEqual(JSON.parse(invalidRemoteRoot.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host remote root.",
        hint: "Pass an absolute POSIX path such as `/srv/sporades`.",
      },
    });

    const unknownAlias = await runCli(["host", "use", "missing", "--json"], { cwd: dir, env: hostEnv(configDir) });
    assert.equal(unknownAlias.code, 1);
    assert.deepEqual(JSON.parse(unknownAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unknown Host profile alias: missing",
        hint: "Add it with `sporades host add missing --server <ssh-target> --domain <hosted-domain>`.",
      },
    });
  });
});

test("host profile implementation does not hard-code the first Hosted domain", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /mattgscox\.co\.uk/);
});
