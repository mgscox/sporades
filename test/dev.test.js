import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function startCli(args, options = {}) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function installFakeDocker(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const call = { args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(call) + "\\n");
if (call.args[0] === "compose" && call.args.includes("ps")) {
  const status = process.env.FAKE_DOCKER_COMPOSE_STATUS || "healthy";
  const output = {
    Service: call.args[call.args.length - 1],
    State: status === "exited" ? "exited" : "running",
  };
  if (status !== "no-health") {
    output.Health = status;
  }
  process.stdout.write(JSON.stringify(output) + "\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("port")) {
  process.stdout.write("127.0.0.1:" + (process.env.FAKE_DOCKER_SERVICE_PORT || "49170") + "\\n");
  process.exit(0);
}
`,
  );
  await chmod(dockerPath, 0o755);

  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
    },
    async calls() {
      const raw = await readFile(logPath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

async function withFakeServiceEndpoint(fn) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}\\n');
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    return await fn({ port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function headerNames(headers) {
  return new Set([...headers.keys()].map((name) => name.toLowerCase()));
}

async function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.trim());
      if (line) {
        cleanup();
        resolve(JSON.parse(line));
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForJsonEvent(child, predicate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON event.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (predicate(event)) {
          cleanup();
          resolve(event);
          return;
        }
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before JSON event.\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForStdoutLine(child, predicate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stdout line.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before stdout line.\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
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

async function installFakePreact(projectDir) {
  await writePackage(
    projectDir,
    "preact",
    {
      ".": "./index.js",
      "./hooks": "./hooks.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function render() {}\n",
      "hooks.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('preact.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
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
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)),
  );
}

async function withFakeGoogleServer(fn) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: requestUrl.pathname });

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const body = await new Promise((resolve) => {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => resolve(new URLSearchParams(raw)));
      });
      requests.at(-1).body = Object.fromEntries(body.entries());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "server-owned-access-token", token_type: "Bearer" }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/userinfo") {
      requests.at(-1).authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          email: "mira@example.com",
          name: "Mira",
          picture: "https://example.com/mira.png",
          email_verified: true,
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  try {
    return await fn({
      tokenUrl: `http://127.0.0.1:${port}/token`,
      userInfoUrl: `http://127.0.0.1:${port}/userinfo`,
      requests,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("sporades dev bundles and serves a scaffolded React todo capsule", async () => {
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

      assert.equal(started.ok, true);
      assert.equal(started.data.event, "started");
      assert.equal(started.error, null);
      assert.equal(typeof started.data.port, "number");
      assert.match(started.data.url, /^http:\/\/localhost:\d+$/);

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /todo-island/);
      assert.match(clientBundle, /Sporades Todos/);
      assert.doesNotMatch(clientBundle, /Original client source/);
      assert.doesNotMatch(clientBundle, /import .* from "react"/);
      assert.match(clientBundle, /createRoot/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
      assert.match(await rootResponse.text(), /<script type="module" src="\/client\.js"><\/script>/);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      const servedClientBundle = await clientResponse.text();
      assert.match(servedClientBundle, /Sporades Todos/);
      assert.doesNotMatch(servedClientBundle, /Original client source/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev generates owned Compose for declared database Capsule services", async () => {
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

    await withFakeLibsqlService(path.join(dir, "dev-libsql.db"), async ({ url: serviceUrl }) => {
      const servicePort = new URL(serviceUrl).port;
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      try {
        const starting = await waitForJsonLine(child);
        assert.deepEqual(starting, {
          ok: true,
          data: {
            event: "service",
            service: "database",
            status: "starting",
            engine: "libsql",
            statePath: path.join(".sporades", "services", "database"),
          },
          error: null,
        });
        const ready = await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        assert.equal(ready.ok, true);
        assert.deepEqual(ready.data, {
          event: "service",
          service: "database",
          status: "ready",
          engine: "libsql",
          statePath: path.join(".sporades", "services", "database"),
          host: "127.0.0.1",
          port: Number(servicePort),
        });
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
        assert.match(compose, /# Sporades-owned runtime state/);
        assert.match(compose, /sporades-todo-island-database:/);
        assert.match(compose, /127\.0\.0\.1::8080/);
        assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/sqld:rw"/);
        const calls = await docker.calls();
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0].args.slice(0, 2), ["compose", "-f"]);
        assert.match(calls[0].args[2], /todo-island\/\.sporades\/compose\/capsule-services\.compose\.yml$/);
        assert.deepEqual(calls[0].args.slice(3), ["up", "--detach"]);
        assert.deepEqual(calls[1].args.slice(3), ["ps", "--format", "json", "sporades-todo-island-database"]);
        assert.deepEqual(calls[2].args.slice(3), ["port", "sporades-todo-island-database", "8080"]);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

test("sporades dev starts MinIO storage Capsule services and injects server-only storage env", async () => {
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
      storage: {
        kind: "storage",
        engine: "minio",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir);

    await withFakeServiceEndpoint(async ({ port: servicePort }) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      try {
        const starting = await waitForJsonLine(child);
        assert.deepEqual(starting.data, {
          event: "service",
          service: "storage",
          status: "starting",
          engine: "minio",
          statePath: path.join(".sporades", "services", "storage"),
        });
        const ready = await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        assert.deepEqual(ready.data, {
          event: "service",
          service: "storage",
          status: "ready",
          engine: "minio",
          statePath: path.join(".sporades", "services", "storage"),
          host: "127.0.0.1",
          port: Number(servicePort),
        });
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        const socket = await openSocket(started.data.url);
        try {
          socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "ctx.env" }));
          assert.deepEqual(await readSocketMessage(socket), {
            id: "env-1",
            type: "query.result",
            query: "ctx.env",
            data: {},
            error: null,
          });
        } finally {
          socket.close();
        }

        const clientBundle = await (await fetch(`${started.data.url}/client.js`)).text();
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);

        const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
        assert.match(compose, /sporades-todo-island-storage:/);
        assert.match(compose, /image: quay\.io\/minio\/minio:RELEASE\.2025-04-22T22-12-26Z/);
        assert.match(compose, /MINIO_ROOT_USER: "sporades"/);
        assert.match(compose, /127\.0\.0\.1::9000/);
        assert.match(compose, /todo-island\/\.sporades\/services\/storage\:\/data:rw"/);
        assert.match(compose, /com\.sporades\.capsule-service\.kind: "storage"/);

        const calls = await docker.calls();
        assert.deepEqual(calls[1].args.slice(3), ["ps", "--format", "json", "sporades-todo-island-storage"]);
        assert.deepEqual(calls[2].args.slice(3), ["port", "sporades-todo-island-storage", "9000"]);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
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

test("sporades dev injects database Capsule service connection details into server-only env and restarts services on rebuild", async () => {
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

    await withFakeLibsqlService(path.join(dir, "dev-libsql.db"), async ({ url: serviceUrl }) => {
      const servicePort = new URL(serviceUrl).port;
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(servicePort) },
      });
      let socket;
      try {
        await waitForJsonLine(child);
        await waitForJsonEvent(child, (event) => event.data?.event === "service" && event.data.status === "ready");
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        socket = await openSocket(started.data.url);
        socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "ctx.env" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "env-1",
          type: "query.result",
          query: "ctx.env",
          data: {},
          error: null,
        });

        const clientResponse = await fetch(`${started.data.url}/client.js`);
        assert.equal(clientResponse.status, 200);
        const clientBundle = await clientResponse.text();
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_DATABASE_URL/);
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_DATABASE_AUTH_TOKEN/);
        assert.doesNotMatch(clientBundle, new RegExp(String(servicePort)));

        const stateDir = path.join(projectDir, ".sporades", "services", "database");
        await writeFile(path.join(stateDir, "survives-restart.txt"), "kept\n");
        const clientPath = path.join(projectDir, "client", "index.tsx");
        const originalClient = await readFile(clientPath, "utf8");
        await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Service Todos"));

        const rebuilt = await waitForJsonEvent(child, (event) => event.data?.event === "rebuild" && event.data.status === "success");
        assert.equal(rebuilt.ok, true);
        assert.equal(await readFile(path.join(stateDir, "survives-restart.txt"), "utf8"), "kept\n");

        const calls = await docker.calls();
        assert.equal(calls.filter((call) => call.args[0] === "compose" && call.args.includes("up")).length, 2);
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

test("sporades dev bundles and serves the default blank React capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "blank-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    assert.deepEqual(JSON.parse(createResult.stdout).data.template, "blank");

    const projectDir = path.join(dir, "blank-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true);
      assert.equal(started.data.event, "started");

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /blank-island/);
      assert.match(clientBundle, /Blank Sporades Capsule/);
      assert.doesNotMatch(clientBundle, /Sporades Todos|useQuery|useMutation/);

      const html = await (await fetch(`${started.data.url}/`)).text();
      assert.match(html, /<div id="app"><\/div>/);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

test("sporades dev bundles and serves a scaffolded React photo library capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "photos-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true, JSON.stringify(started.error));
      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(serverBundle, /recordPhoto/);
      assert.match(serverBundle, /personalPhotos/);
      assert.match(clientBundle, /Photo Library/);
      assert.match(clientBundle, /upload\(/);
      assert.match(clientBundle, /Sign in with Google/);
      assert.doesNotMatch(clientBundle, /better-auth|googleapis|gapi|accounts\.google/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev bundles and serves a scaffolded Preact photo library capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--framework", "preact", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "photos-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakePreact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      assert.equal(started.ok, true, JSON.stringify(started.error));
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.match(clientBundle, /Photo Library/);
      assert.match(clientBundle, /My library/);
      assert.match(clientBundle, /Sign in with Google/);
      assert.doesNotMatch(clientBundle, /react-dom|better-auth|googleapis|gapi|accounts\.google/);

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("a scaffolded photo library stores uploads, public gallery rows, and Google-owned private library rows", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "photos-island", "--template", "photo-library", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "photos-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let anonymousSocket;
    let googleSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      async function waitForPhotoMessage(socket, label, predicate) {
        try {
          return await waitForSocketMessage(socket, predicate);
        } catch (error) {
          throw new Error(`${label}: ${error.message}`);
        }
      }

      async function uploadImage(socket, id, name, body) {
        socket.send(
          JSON.stringify({
            id: `${id}-upload-url`,
            type: "file.uploadUrl",
            file: { name, type: "image/png", size: body.length },
          }),
        );
        const uploadUrl = await waitForPhotoMessage(socket, `${id} upload URL`, (message) => message.id === `${id}-upload-url`);
        assert.equal(uploadUrl.error, null);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
          method: uploadUrl.data.method,
          body,
        });
        assert.equal(uploadResponse.status, 200);
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true);
        return uploaded.data.file;
      }

      anonymousSocket = await openSocket(started.data.url);
      anonymousSocket.send(JSON.stringify({ id: "anon-auth", type: "auth.get" }));
      const anonymousAuth = await waitForPhotoMessage(anonymousSocket, "anonymous auth", (message) => message.id === "anon-auth");
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");

      anonymousSocket.send(JSON.stringify({ id: "anon-public", type: "query.subscribe", query: "publicPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(anonymousSocket, "anonymous public initial", (message) => message.id === "anon-public")).data, []);
      anonymousSocket.send(JSON.stringify({ id: "anon-personal", type: "query.subscribe", query: "personalPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(anonymousSocket, "anonymous personal initial", (message) => message.id === "anon-personal")).data, []);

      const anonymousFile = await uploadImage(anonymousSocket, "anon", "shore.png", "anonymous-image");
      anonymousSocket.send(
        JSON.stringify({
          id: "anon-url",
          type: "file.publicUrl.create",
          fileId: anonymousFile.id,
          options: { noExpiry: true },
        }),
      );
      const anonymousPublicUrl = await waitForPhotoMessage(anonymousSocket, "anonymous public URL", (message) => message.id === "anon-url");
      assert.equal(anonymousPublicUrl.error, null);
      const anonymousGalleryPromise = waitForPhotoMessage(
        anonymousSocket,
        "anonymous gallery refresh",
        (message) => message.id === "anon-public" && message.data.length === 1,
      );
      anonymousSocket.send(
        JSON.stringify({
          id: "anon-record",
          type: "mutation.run",
          mutation: "recordPhoto",
          args: [{ title: "Shoreline", file: anonymousFile, isPublic: false, publicUrl: anonymousPublicUrl.data.publicUrl }],
        }),
      );
      assert.equal((await waitForPhotoMessage(anonymousSocket, "anonymous record", (message) => message.id === "anon-record")).error, null);
      const anonymousGallery = await anonymousGalleryPromise;
      assert.deepEqual(
        anonymousGallery.data.map((photo) => ({
          title: photo.title,
          isPublic: photo.isPublic,
          imageUrl: photo.imageUrl,
          fileId: photo.fileId,
        })),
        [
          {
            title: "Shoreline",
            isPublic: true,
            imageUrl: anonymousPublicUrl.data.publicUrl.url,
            fileId: anonymousFile.id,
          },
        ],
      );

      const simulated = await runCli(
        [
          "auth",
          "as",
          "google",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const googleToken = JSON.parse(simulated.stdout).data.localStorage.value;
      googleSocket = await openSocket(started.data.url, googleToken);
      googleSocket.send(JSON.stringify({ id: "google-auth", type: "auth.get" }));
      const googleAuth = await waitForPhotoMessage(googleSocket, "google auth", (message) => message.id === "google-auth");
      assert.equal(googleAuth.data.auth.provider, "google");

      googleSocket.send(JSON.stringify({ id: "google-public", type: "query.subscribe", query: "publicPhotos" }));
      const googleInitialGallery = await waitForPhotoMessage(googleSocket, "google gallery initial", (message) => message.id === "google-public");
      assert.deepEqual(googleInitialGallery.data.map((photo) => photo.title), ["Shoreline"]);
      googleSocket.send(JSON.stringify({ id: "google-personal", type: "query.subscribe", query: "personalPhotos" }));
      assert.deepEqual((await waitForPhotoMessage(googleSocket, "google personal initial", (message) => message.id === "google-personal")).data, []);

      const googleFile = await uploadImage(googleSocket, "google", "cove.png", "google-image");
      const privateLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google private library refresh",
        (message) => message.id === "google-personal" && message.data.length === 1,
      );
      googleSocket.send(
        JSON.stringify({
          id: "google-record",
          type: "mutation.run",
          mutation: "recordPhoto",
          args: [{ title: "Hidden cove", file: googleFile, isPublic: false, publicUrl: null }],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "google record", (message) => message.id === "google-record")).error, null);
      const privateLibrary = await privateLibraryPromise;
      const googlePhoto = privateLibrary.data[0];
      assert.equal(googlePhoto.title, "Hidden cove");
      assert.equal(googlePhoto.status, "private");
      assert.equal(googlePhoto.isPublic, false);
      assert.equal(googlePhoto.imageUrl, "");

      googleSocket.send(
        JSON.stringify({
          id: "google-url",
          type: "file.publicUrl.create",
          fileId: googleFile.id,
          options: { noExpiry: true },
        }),
      );
      const googlePublicUrl = await waitForPhotoMessage(googleSocket, "google public URL", (message) => message.id === "google-url");
      assert.equal(googlePublicUrl.error, null);
      googleSocket.send(
        JSON.stringify({
          id: "publish-url",
          type: "mutation.run",
          mutation: "updatePhotoImageUrl",
          args: [googlePhoto.id, googlePublicUrl.data.publicUrl.url],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish image URL", (message) => message.id === "publish-url")).error, null);
      googleSocket.send(
        JSON.stringify({
          id: "publish-url-id",
          type: "mutation.run",
          mutation: "updatePhotoPublicUrlId",
          args: [googlePhoto.id, googlePublicUrl.data.publicUrl.id],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish public URL id", (message) => message.id === "publish-url-id")).error, null);
      const publicLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google public library refresh",
        (message) => message.id === "google-personal" && message.data.some((photo) => photo.status === "public"),
      );
      googleSocket.send(
        JSON.stringify({
          id: "publish",
          type: "mutation.run",
          mutation: "updatePhotoIsPublic",
          args: [googlePhoto.id, true],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "publish visibility", (message) => message.id === "publish")).error, null);
      const publicLibrary = await publicLibraryPromise;
      assert.equal(publicLibrary.data[0].status, "public");
      googleSocket.send(JSON.stringify({ id: "google-public-after-publish", type: "query.subscribe", query: "publicPhotos" }));
      const expandedGallery = await waitForPhotoMessage(
        googleSocket,
        "google expanded gallery refresh",
        (message) => message.id === "google-public-after-publish",
      );
      assert.deepEqual(expandedGallery.data.map((photo) => photo.title).toSorted(), ["Hidden cove", "Shoreline"]);

      const hiddenLibraryPromise = waitForPhotoMessage(
        googleSocket,
        "google hidden library refresh",
        (message) => message.id === "google-personal" && message.data.some((photo) => photo.status === "private"),
      );
      googleSocket.send(
        JSON.stringify({
          id: "hide",
          type: "mutation.run",
          mutation: "updatePhotoIsPublic",
          args: [googlePhoto.id, false],
        }),
      );
      assert.equal((await waitForPhotoMessage(googleSocket, "hide visibility", (message) => message.id === "hide")).error, null);
      const hiddenLibrary = await hiddenLibraryPromise;
      assert.equal(hiddenLibrary.data[0].status, "private");
      googleSocket.send(JSON.stringify({ id: "google-public-after-hide", type: "query.subscribe", query: "publicPhotos" }));
      const reducedGallery = await waitForPhotoMessage(
        googleSocket,
        "google reduced gallery refresh",
        (message) => message.id === "google-public-after-hide",
      );
      assert.deepEqual(reducedGallery.data.map((photo) => photo.title), ["Shoreline"]);
    } finally {
      anonymousSocket?.close();
      googleSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev routes registered capsule endpoints and preserves non-matching HTTP behavior", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => "pong"),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/ping?source=test`, { method: "POST" });
      assert.equal(endpointResponse.status, 200);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await endpointResponse.text(), "pong");

      const methodMissResponse = await fetch(`${started.data.url}/integrations/ping`);
      assert.equal(methodMissResponse.status, 404);
      assert.equal(await methodMissResponse.text(), "Not found");

      const pathMissResponse = await fetch(`${started.data.url}/integrations/missing`, { method: "POST" });
      assert.equal(pathMissResponse.status, 404);
      assert.equal(await pathMissResponse.text(), "Not found");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev rolls back multi-write Custom endpoint app-table failures", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-rollback-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, String, table } from "sporades/server";

export default capsule({
  name: "endpoint-rollback-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  endpoints: {
    record: endpoint({ method: "POST", path: "/record" }, (ctx) => {
      ctx.db.notes.insert({ text: ctx.request.body.text + ":committed", ownerId: ctx.auth.userId });
      return { status: 200, body: { ok: true } };
    }),
    explode: endpoint({ method: "POST", path: "/explode" }, (ctx) => {
      ctx.db.notes.insert({ text: ctx.request.body.text + ":first", ownerId: ctx.auth.userId });
      ctx.db.notes.insert({ text: ctx.request.body.text + ":second", ownerId: ctx.auth.userId });
      throw new Error("Endpoint write failed.");
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const committedResponse = await fetch(`${started.data.url}/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "before" }),
      });
      assert.equal(committedResponse.status, 200);

      const failedResponse = await fetch(`${started.data.url}/explode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "rollback" }),
      });
      assert.equal(failedResponse.status, 500);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "notes").rows.map((row) => row.text),
        ["before:committed"],
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev applies default security headers and local-only CORS", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "secure-dev-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "secure-dev-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "secure-dev-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => ({ body: { ok: true } })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      assert.deepEqual(started.data.security.cors.allowedOriginPatterns, ["http://localhost:*", "http://127.0.0.1:*"]);
      assert.equal(started.data.security.cors.publicDev, false);

      const rootResponse = await fetch(`${started.data.url}/`, {
        headers: { origin: "http://localhost:5173" },
      });
      assert.equal(rootResponse.headers.get("access-control-allow-origin"), "http://localhost:5173");
      assert.equal(rootResponse.headers.get("x-content-type-options"), "nosniff");
      assert.equal(rootResponse.headers.get("referrer-policy"), "no-referrer");
      assert.equal(rootResponse.headers.get("x-frame-options"), "DENY");
      assert.equal(rootResponse.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.match(rootResponse.headers.get("permissions-policy") ?? "", /camera=\(\)/);
      assert.match(rootResponse.headers.get("content-security-policy-report-only") ?? "", /default-src 'self'/);
      assert.equal(rootResponse.headers.get("content-security-policy"), null);
      assert.equal(rootResponse.headers.get("x-powered-by"), null);
      assert.equal(rootResponse.headers.get("server"), null);

      const endpointResponse = await fetch(`${started.data.url}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://example.test" },
      });
      assert.equal(endpointResponse.status, 200);
      assert.equal(endpointResponse.headers.get("access-control-allow-origin"), null);

      const preflight = await fetch(`${started.data.url}/integrations/ping`, {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-sporades-session-token",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-sporades-session-token/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev --public makes the relaxed CORS posture visible", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "public-dev-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "public-dev-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--public", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      assert.equal(started.data.security.cors.publicDev, true);
      assert.deepEqual(started.data.security.cors.allowedOrigins, ["*"]);

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.equal(session.publicDev, true);
      assert.equal(session.security.cors.publicDev, true);
      assert.deepEqual(session.security.cors.allowedOrigins, ["*"]);

      const response = await fetch(started.data.url, {
        headers: { origin: "https://demo.example.test" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev gives endpoint handlers request context and structured responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=dev-secret\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 201,
      headers: { "x-sporades-endpoint": ctx.env.WEBHOOK_SECRET },
      body: {
        method: ctx.request.method,
        path: ctx.request.path,
        header: ctx.request.headers["x-source"],
        query: ctx.request.query.source,
        body: ctx.request.body,
        authProvider: ctx.auth.provider,
        logMethods: Object.keys(ctx.log).sort(),
      },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/echo?source=test-suite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "integration",
        },
        body: JSON.stringify({ hello: "endpoint" }),
      });
      assert.equal(endpointResponse.status, 201);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(endpointResponse.headers.get("x-sporades-endpoint"), "dev-secret");
      assert.deepEqual(await endpointResponse.json(), {
        method: "POST",
        path: "/integrations/echo",
        header: "integration",
        query: "test-suite",
        body: { hello: "endpoint" },
        authProvider: "anonymous",
        logMethods: ["error", "info", "warn"],
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev endpoint handlers can read and write Capsule data with the table API", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { Boolean, capsule, endpoint, String, table } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  endpoints: {
    addTodo: endpoint({ method: "POST", path: "/integrations/todos" }, (ctx) => {
      ctx.db.todos.insert({
        text: ctx.request.body.text,
        done: false,
        ownerId: ctx.auth.userId,
      });

      return {
        status: 200,
        body: ctx.db.todos
          .where("ownerId", ctx.auth.userId)
          .orderBy("createdAt", "desc")
          .all(),
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "From endpoint" }),
      });
      assert.equal(endpointResponse.status, 200);
      const rows = await endpointResponse.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, "From endpoint");
      assert.equal(rows[0].done, false);
      assert.equal(typeof rows[0].id, "string");
      assert.equal(typeof rows[0].createdAt, "string");
      assert.equal(typeof rows[0].updatedAt, "string");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev endpoints resolve an existing anonymous session from the Sporades session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { Boolean, capsule, endpoint, String, table } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  endpoints: {
    addTodo: endpoint({ method: "POST", path: "/integrations/todos" }, (ctx) => {
      ctx.db.todos.insert({
        text: ctx.request.body.text,
        done: false,
        ownerId: ctx.auth.userId,
      });

      return {
        status: 200,
        body: {
          auth: ctx.auth,
          rows: ctx.db.todos.where("ownerId", ctx.auth.userId).all(),
        },
      };
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
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authResult = await readSocketMessage(socket);

      const endpointResponse = await fetch(`${started.data.url}/integrations/todos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-session-token": authResult.data.sessionToken,
        },
        body: JSON.stringify({ text: "Owned by endpoint auth" }),
      });
      assert.equal(endpointResponse.status, 200);
      const result = await endpointResponse.json();
      assert.deepEqual(result.auth, authResult.data.auth);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].text, "Owned by endpoint auth");
      assert.equal(result.rows[0].ownerId, authResult.data.auth.userId);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev endpoints treat missing or invalid session tokens as a new anonymous session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: ctx.auth,
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const existingAuth = (await readSocketMessage(socket)).data.auth;

      const missingTokenResponse = await fetch(`${started.data.url}/integrations/auth`);
      assert.equal(missingTokenResponse.status, 200);
      const missingTokenAuth = await missingTokenResponse.json();
      assert.equal(missingTokenAuth.provider, "anonymous");
      assert.equal(missingTokenAuth.isGuest, true);
      assert.notEqual(missingTokenAuth.userId, existingAuth.userId);

      const invalidTokenResponse = await fetch(`${started.data.url}/integrations/auth`, {
        headers: { "x-sporades-session-token": "not-a-real-session" },
      });
      assert.equal(invalidTokenResponse.status, 200);
      const invalidTokenAuth = await invalidTokenResponse.json();
      assert.equal(invalidTokenAuth.provider, "anonymous");
      assert.equal(invalidTokenAuth.isGuest, true);
      assert.notEqual(invalidTokenAuth.userId, existingAuth.userId);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth as email returns a localStorage session payload that resolves through auth.get", async () => {
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
    let socket;
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.error, null);
      assert.equal(body.data.localStorage.key, "sporades.sessionToken");
      assert.equal(typeof body.data.localStorage.value, "string");
      assert.deepEqual(body.data.auth, {
        userId: body.data.auth.userId,
        displayName: "Mira Vale",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });
      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const storedSession = sqlite
          .prepare("SELECT expiresAt FROM sporades_auth_sessions WHERE token = ?")
          .get(body.data.localStorage.value);
        assert.match(storedSession.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(Date.parse(storedSession.expiresAt) > Date.now());
      } finally {
        sqlite.close();
      }

      socket = await openSocket(started.data.url, body.data.localStorage.value);
      socket.send(JSON.stringify({ id: "auth-after-simulation", type: "auth.get" }));
      const resolved = await readSocketMessage(socket);
      assert.deepEqual(resolved.data.auth, body.data.auth);
      assert.equal(resolved.data.sessionToken, body.data.localStorage.value);

      const expiringSqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        expiringSqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", body.data.localStorage.value);
      } finally {
        expiringSqlite.close();
      }
      socket.close();
      socket = null;

      expiredSocket = await openSocket(started.data.url, body.data.localStorage.value);
      expiredSocket.send(JSON.stringify({ id: "auth-expired-simulation", type: "auth.get" }));
      const expiredResolved = await readSocketMessage(expiredSocket);
      assert.equal(expiredResolved.data.auth.provider, "anonymous");
      assert.notEqual(expiredResolved.data.sessionToken, body.data.localStorage.value);
    } finally {
      socket?.close();
      expiredSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
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

test("sporades auth clients --json lists a connected browser client with safe metadata", async () => {
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
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      const listed = await runCli(["auth", "clients", "--json"], { cwd: projectDir });
      assert.equal(listed.code, 0, listed.stderr);
      const body = JSON.parse(listed.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.clients.length, 1);
      assert.match(body.data.clients[0].id, /^client-[a-z0-9]+$/);
      assert.equal(body.data.clients[0].auth.provider, "anonymous");
      assert.equal(body.data.clients[0].auth.isAuthenticated, false);
      assert.equal(body.data.clients[0].auth.email, null);
      assert.equal(typeof body.data.clients[0].connectedAt, "string");
      assert.equal(typeof body.data.clients[0].lastSeenAt, "string");

      const rawJson = JSON.stringify(body);
      assert.equal(rawJson.includes("sessionToken"), false);
      assert.equal(rawJson.includes("localStorage"), false);
      assert.equal(rawJson.includes("token"), false);
      assert.equal(rawJson.includes("password"), false);
      assert.equal(rawJson.includes("secret"), false);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth clients --json lists multiple clients whose ids target auth as delivery", async () => {
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
    let firstSocket;
    let secondSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      firstSocket = await openSocket(started.data.url);
      secondSocket = await openSocket(started.data.url);

      const listed = await runCli(["auth", "clients", "--json"], { cwd: projectDir });
      assert.equal(listed.code, 0, listed.stderr);
      const clients = JSON.parse(listed.stdout).data.clients;
      assert.equal(clients.length, 2);
      assert.notEqual(clients[0].id, clients[1].id);
      assert.equal(clients[0].auth.provider, "anonymous");
      assert.equal(clients[1].auth.provider, "anonymous");

      const deliveredToFirst = readSocketMessage(firstSocket);
      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--client",
          clients[0].id,
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.deepEqual(body.data.delivery, {
        target: clients[0].id,
        delivered: true,
        clients: 1,
      });
      assert.equal((await deliveredToFirst).type, "auth.session.replace");

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      const firstAuth = await waitForSocketMessage(firstSocket, (message) => message.id === "first-auth");
      const secondAuth = await waitForSocketMessage(secondSocket, (message) => message.id === "second-auth");
      assert.deepEqual(firstAuth.data.auth, body.data.auth);
      assert.equal(secondAuth.data.auth.provider, "anonymous");
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth clients returns a structured error when the dev server lacks client listing support", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "auth-island");

    const server = createServer((request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const result = await runCli(["auth", "clients", "--port", String(server.address().port), "--json"], {
        cwd: projectDir,
      });
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Dev session does not support auth client listing.",
          hint: "Start a current `sporades dev` session for this project, then retry `sporades auth clients`.",
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("sporades auth as email --client current delivers the session to the most recently connected browser client", async () => {
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
    let firstSocket;
    let currentSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      firstSocket = await openSocket(started.data.url);
      currentSocket = await openSocket(started.data.url);
      const deliveredToCurrent = readSocketMessage(currentSocket);

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--client",
          "current",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.localStorage.key, "sporades.sessionToken");
      assert.equal(typeof body.data.localStorage.value, "string");
      assert.deepEqual(body.data.delivery, {
        target: "current",
        delivered: true,
        clients: 1,
      });

      const delivery = await deliveredToCurrent;
      assert.deepEqual(delivery, {
        id: null,
        type: "auth.session.replace",
        data: {
          sessionToken: body.data.localStorage.value,
          auth: body.data.auth,
        },
        error: null,
      });

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);
      assert.equal(firstAuth.id, "first-auth");
      assert.equal(firstAuth.data.auth.provider, "anonymous");

      currentSocket.send(JSON.stringify({ id: "current-auth", type: "auth.get" }));
      const currentAuth = await readSocketMessage(currentSocket);
      assert.equal(currentAuth.id, "current-auth");
      assert.deepEqual(currentAuth.data.auth, body.data.auth);
      assert.equal(currentAuth.data.sessionToken, body.data.localStorage.value);
    } finally {
      firstSocket?.close();
      currentSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth as email --client all delivers the session to every connected browser client", async () => {
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
    let firstSocket;
    let secondSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      firstSocket = await openSocket(started.data.url);
      secondSocket = await openSocket(started.data.url);
      const deliveredToFirst = readSocketMessage(firstSocket);
      const deliveredToSecond = readSocketMessage(secondSocket);

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--client",
          "all",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.delivery, {
        target: "all",
        delivered: true,
        clients: 2,
      });

      const firstDelivery = await deliveredToFirst;
      const secondDelivery = await deliveredToSecond;
      assert.equal(firstDelivery.type, "auth.session.replace");
      assert.equal(firstDelivery.data.sessionToken, body.data.localStorage.value);
      assert.deepEqual(firstDelivery.data.auth, body.data.auth);
      assert.equal(secondDelivery.type, "auth.session.replace");
      assert.equal(secondDelivery.data.sessionToken, body.data.localStorage.value);
      assert.deepEqual(secondDelivery.data.auth, body.data.auth);
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth as email --client current reports undelivered when no browser client is connected", async () => {
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

      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira Vale",
          "--client",
          "current",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.data.localStorage.key, "sporades.sessionToken");
      assert.equal(typeof body.data.localStorage.value, "string");
      assert.deepEqual(body.data.delivery, {
        target: "current",
        delivered: false,
        clients: 0,
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

test("sporades auth as google creates a simulated provider-shaped session without OAuth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = { providers: { anonymous: true, google: { clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" } } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const result = await runCli(
        [
          "auth",
          "as",
          "google",
          "--email",
          "mira@example.com",
          "--display-name",
          "Mira",
          "--picture",
          "https://example.com/mira.png",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(result.code, 0, result.stderr);
      const simulated = JSON.parse(result.stdout);
      assert.equal(simulated.data.auth.provider, "google");
      assert.equal(simulated.data.auth.email, "mira@example.com");
      assert.equal(simulated.data.auth.displayName, "Mira");
      assert.equal(simulated.data.auth.picture, "https://example.com/mira.png");
      assert.equal(typeof simulated.data.localStorage.value, "string");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades auth as refuses servers without local identity simulation support", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "auth-island");

    const server = createServer((request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const result = await runCli(
        ["auth", "as", "email", "--email", "mira@example.com", "--port", String(server.address().port), "--json"],
        { cwd: projectDir },
      );
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Dev session does not support local identity simulation.",
          hint: "Start a current `sporades dev` session for this project, then retry `sporades auth as email`.",
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("sporades dev returns structured errors for invalid endpoint responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    invalid: endpoint({ method: "POST", path: "/integrations/invalid" }, () => ({
      status: "created",
      body: { ok: true },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/invalid`, { method: "POST" });
      assert.equal(endpointResponse.status, 500);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await endpointResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Invalid endpoint response.",
          hint: "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev returns structured endpoint errors without crashing the session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    broken: endpoint({ method: "POST", path: "/integrations/broken" }, () => {
      throw new Error("broken integration");
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const endpointResponse = await fetch(`${started.data.url}/integrations/broken`, { method: "POST" });
      assert.equal(endpointResponse.status, 500);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await endpointResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Endpoint handler failed.",
          hint: "Check the endpoint handler and retry the request.",
        },
      });

      const rootResponse = await fetch(started.data.url);
      assert.equal(rootResponse.status, 200);
      assert.match(await rootResponse.text(), /<script type="module" src="\/client\.js"><\/script>/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev streams rebuild success events and serves the rebuilt client bundle", async () => {
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
      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      const changedAt = Date.now();
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Rebuilt Todos"));

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.ok(Date.now() - changedAt >= 90);
      assert.equal(rebuilt.error, null);
      assert.equal(rebuilt.data.port, started.data.port);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /Sporades Rebuilt Todos/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev keeps existing WebSocket clients connected across client-only rebuilds", async () => {
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

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Less Disruptive Todos"));

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);
      assert.equal(rebuilt.data.port, started.data.port);

      socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(socket);
      assert.equal(authAfter.data.sessionToken, authBefore.data.sessionToken);
      assert.deepEqual(authAfter.data.auth, authBefore.data.auth);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /Sporades Less Disruptive Todos/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev generated server bundle handles client WebSocket close frames", async () => {
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

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      assert.match(serverBundle, /function drainWebSocketFrames/);
      assert.match(serverBundle, /function closeWebSocketClient/);
      assert.match(serverBundle, /function localFileStoragePath/);
      assert.match(serverBundle, /function localFileVersionPath/);

      socket = await openSocketWithHeaders(started.data.url);
      socket.sendJson({
        id: "upload-url",
        type: "file.uploadUrl",
        file: { name: "hello.txt", type: "text/plain", size: 11 },
      });
      const uploadUrl = await socket.readJson();
      assert.equal(uploadUrl.type, "file.uploadUrl.result");
      assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
      const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
        method: uploadUrl.data.method,
        body: "hello world",
      });
      assert.equal(uploadResponse.status, 200);
      const uploaded = await uploadResponse.json();
      assert.equal(uploaded.ok, true, JSON.stringify(uploaded.error));
      assert.equal(uploaded.data.file.id, uploadUrl.data.file.id);

      socket.sendCloseFrame();
      await socket.waitForClose();

      const root = await fetch(started.data.url);
      assert.equal(root.status, 200);
      assert.match(await root.text(), /client\.js/);
    } finally {
      socket?.destroy();
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

      await rm(path.join(projectDir, "client", "index.tsx"));

      const failed = await waitForJsonEvent(
        child,
        (event) => !event.ok && event.data.event === "rebuild" && event.data.status === "failed",
      );
      assert.match(failed.error.message, /Missing client entry: client\/index\.tsx/);
      assert.equal(failed.error.hint, "Run `sporades create` to scaffold a new project.");

      const afterFailureResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(afterFailureResponse.status, 200);
      assert.equal(await afterFailureResponse.text(), lastSuccessfulClient);
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
      assert.equal(failed.error.message, "Google OAuth is not fully configured.");
      assert.equal(
        failed.error.hint,
        "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
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

test("sporades dev reloads server-runtime config on rebuild and disconnects old WebSocket clients", async () => {
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
    let reconnectedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      config.auth = { providers: { anonymous: true, email: true } };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);

      reconnectedSocket = await openSocket(started.data.url);
      reconnectedSocket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(reconnectedSocket);
      assert.equal(authAfter.data.providers.email.enabled, true);

      reconnectedSocket.send(
        JSON.stringify({
          id: "email-sign-up",
          type: "auth.signUp",
          provider: "email",
          credentials: { email: "mira@example.com", password: "secret-password", name: "Mira" },
        }),
      );
      const signUp = await readSocketMessage(reconnectedSocket);
      assert.equal(signUp.error, null);
      assert.equal(signUp.data.auth.provider, "email");
    } finally {
      reconnectedSocket?.close();
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev reloads client-only config without restarting the server Runtime", async () => {
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
    await installFakePreact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const authBefore = await readSocketMessage(socket);

      config.client.framework = "preact";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const rebuilt = await waitForJsonEvent(
        child,
        (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
      );
      assert.equal(rebuilt.error, null);

      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
      const authAfter = await readSocketMessage(socket);
      assert.equal(authAfter.data.sessionToken, authBefore.data.sessionToken);
      assert.deepEqual(authAfter.data.auth, authBefore.data.auth);

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.match(await clientResponse.text(), /JSX import source: preact/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev restarts server runtime and accepts new WebSocket connections after rebuild", async () => {
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
    let reconnectedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer.replace(
          "todos: table({",
          `notes: table({
      text: String(),
    }),
    todos: table({`,
        ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);

      reconnectedSocket = await openSocket(started.data.url);
      reconnectedSocket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(await readSocketMessage(reconnectedSocket), {
        id: "query-1",
        type: "query.result",
        query: "todos",
        data: [],
        error: null,
      });

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.deepEqual(JSON.parse(listResult.stdout).data.tables, [
        "notes",
        "sporades",
        "sporades_auth_oauth_states",
        "sporades_auth_sessions",
        "sporades_auth_users",
        "sporades_file_buckets",
        "sporades_file_public_urls",
        "sporades_file_uploads",
        "sporades_files",
        "sporades_jobs",
        "sporades_user_preferences",
        "todos",
      ]);
    } finally {
      reconnectedSocket?.close();
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

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
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

test("sporades dev gives fresh and migrated Capsule schemas the same nullability and defaults", async () => {
  await withTempDir(async (dir) => {
    const baseServer = `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "nullability-island",
  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) => ctx.db.todos.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },
  mutations: {
    recordTodo: mutation((ctx, text, values = {}) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId, ...values });
    }),
  },
});
`;
    const finalServer = baseServer.replace(
      "done: Boolean().default(false),",
      `done: Boolean().default(false),
      priority: String().default("normal"),
      note: String(),
      reviewed: Boolean(),`,
    );

    async function createProject(projectName, serverSource) {
      const createResult = await runCli(["create", projectName, "--template", "todo", "--no-install", "--no-git", "--json"], {
        cwd: dir,
      });
      assert.equal(createResult.code, 0, createResult.stderr);

      const projectDir = path.join(dir, projectName);
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.dev.port = 0;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await writeFile(path.join(projectDir, "server", "index.ts"), serverSource);
      await installFakeReact(projectDir);
      return projectDir;
    }

    async function tableInfo(projectDir) {
      const result = await runCli(["db", "query", "PRAGMA table_info(todos)", "--json"], { cwd: projectDir });
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).data.rows.map((column) => ({
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }));
    }

    function rowContract(rows) {
      return rows
        .map(({ text, priority, note, reviewed }) => ({ text, priority, note, reviewed }))
        .sort((left, right) => left.text.localeCompare(right.text));
    }

    const freshProjectDir = await createProject("fresh-island", finalServer);
    const freshChild = startCli(["dev", "--json"], { cwd: freshProjectDir });
    let freshSocket;
    let freshRows;
    let freshSchemaInfo;
    try {
      const freshStarted = await waitForJsonLine(freshChild);
      assert.equal(freshStarted.ok, true, JSON.stringify(freshStarted));
      freshSocket = await openSocket(freshStarted.data.url);
      freshSocket.send(JSON.stringify({ id: "fresh-todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(
        (
          await waitForSocketMessage(
            freshSocket,
            (message) => message.id === "fresh-todos" && message.type === "query.result" && message.query === "todos",
          )
        ).data,
        [],
      );
      const freshMissingResultPromise = waitForSocketMessage(
        freshSocket,
        (message) => message.id === "fresh-missing" && message.type === "mutation.result",
      );
      const freshMissingRefreshPromise = waitForSocketMessage(
        freshSocket,
        (message) =>
          message.id === "fresh-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Fresh missing"),
      );
      freshSocket.send(
        JSON.stringify({ id: "fresh-missing", type: "mutation.run", mutation: "recordTodo", args: ["Fresh missing"] }),
      );
      assert.equal((await freshMissingResultPromise).error, null);
      await freshMissingRefreshPromise;
      const freshSuppliedResultPromise = waitForSocketMessage(
        freshSocket,
        (message) => message.id === "fresh-supplied" && message.type === "mutation.result",
      );
      const freshSuppliedRefreshPromise = waitForSocketMessage(
        freshSocket,
        (message) =>
          message.id === "fresh-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2 &&
          message.data.some((todo) => todo.text === "Fresh supplied"),
      );
      freshSocket.send(
        JSON.stringify({
          id: "fresh-supplied",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Fresh supplied", { priority: "urgent", note: "explicit", reviewed: true }],
        }),
      );
      assert.equal((await freshSuppliedResultPromise).error, null);
      freshRows = (await freshSuppliedRefreshPromise).data;
      freshSchemaInfo = await tableInfo(freshProjectDir);
    } finally {
      freshSocket?.close();
      if (freshChild.exitCode === null) {
        const exited = new Promise((resolve) => freshChild.once("exit", resolve));
        freshChild.kill("SIGTERM");
        await exited;
      }
    }

    const migratedProjectDir = await createProject("migrated-island", baseServer);
    const migratedChild = startCli(["dev", "--json"], { cwd: migratedProjectDir });
    let migratedSocket;
    let migratedRows;
    let migratedSchemaInfo;
    try {
      const migratedStarted = await waitForJsonLine(migratedChild);
      assert.equal(migratedStarted.ok, true, JSON.stringify(migratedStarted));
      migratedSocket = await openSocket(migratedStarted.data.url);
      migratedSocket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(migratedSocket)).data.sessionToken;
      migratedSocket.send(JSON.stringify({ id: "migrated-todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual(
        (
          await waitForSocketMessage(
            migratedSocket,
            (message) => message.id === "migrated-todos" && message.type === "query.result" && message.query === "todos",
          )
        ).data,
        [],
      );
      const migratedBeforeResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-before" && message.type === "mutation.result",
      );
      const migratedBeforeRefreshPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "migrated-todos" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Fresh missing"),
      );
      migratedSocket.send(
        JSON.stringify({ id: "migrated-before", type: "mutation.run", mutation: "recordTodo", args: ["Fresh missing"] }),
      );
      assert.equal((await migratedBeforeResultPromise).error, null);
      await migratedBeforeRefreshPromise;

      await writeFile(path.join(migratedProjectDir, "server", "index.ts"), finalServer);
      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          migratedChild,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(migratedSocket),
      ]);
      assert.equal(rebuilt.error, null);
      migratedSocket = await openSocket(migratedStarted.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "migrated-after", type: "query.subscribe", query: "todos" }));
      await waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-after" && message.type === "query.result" && message.query === "todos",
      );
      const migratedSuppliedResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "migrated-supplied" && message.type === "mutation.result",
      );
      const migratedSuppliedRefreshPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "migrated-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2 &&
          message.data.some((todo) => todo.text === "Fresh supplied"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "migrated-supplied",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Fresh supplied", { priority: "urgent", note: "explicit", reviewed: true }],
        }),
      );
      assert.equal((await migratedSuppliedResultPromise).error, null);
      migratedRows = (await migratedSuppliedRefreshPromise).data;
      migratedSchemaInfo = await tableInfo(migratedProjectDir);
    } finally {
      migratedSocket?.close();
      if (migratedChild.exitCode === null) {
        const exited = new Promise((resolve) => migratedChild.once("exit", resolve));
        migratedChild.kill("SIGTERM");
        await exited;
      }
    }

    assert.deepEqual(freshSchemaInfo, migratedSchemaInfo);
    assert.deepEqual(rowContract(freshRows), rowContract(migratedRows));
    assert.deepEqual(rowContract(freshRows), [
      { text: "Fresh missing", priority: "normal", note: null, reviewed: null },
      { text: "Fresh supplied", priority: "urgent", note: "explicit", reviewed: true },
    ]);
  });
});

test("sporades dev applies additive field migrations without losing existing Capsule data", async () => {
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
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      assert.deepEqual(
        (await readSocketMessage(socket)).data.map((todo) => todo.text),
        ["Keep me"],
      );

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      priority: String().default("normal"),
      note: String(),`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoNote: mutation((ctx, id: string, note: string) => {
      ctx.db.todos.update(id, { note });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, priority: string, note: string) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, priority, note, ownerId: ctx.auth.userId });",
          ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.equal(migratedRows.data.length, 1);
      assert.equal(migratedRows.data[0].text, "Keep me");
      assert.equal(migratedRows.data[0].done, false);
      assert.equal(migratedRows.data[0].priority, "normal");
      assert.equal(migratedRows.data[0].note, null);

      const insertedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2,
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-after",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["New field works", false, "urgent", "first note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const insertedRows = await insertedRowsPromise;
      assert.equal(insertedRows.data[0].text, "New field works");
      assert.equal(insertedRows.data[0].priority, "urgent");
      assert.equal(insertedRows.data[0].note, "first note");

      const updatedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.note === "edited note"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-note",
          type: "mutation.run",
          mutation: "updateTodoNote",
          args: [insertedRows.data[0].id, "edited note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const updatedTodo = (await updatedRowsPromise).data.find((todo) => todo.note === "edited note");
      assert.equal(updatedTodo.priority, "urgent");

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const todosTable = tables.find((table) => table.name === "todos");
      assert.deepEqual(todosTable.columns, ["id", "createdAt", "updatedAt", "text", "done", "priority", "note", "ownerId"]);
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").priority, "normal");
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").note, null);
      assert.equal(todosTable.rows.find((row) => row.text === "New field works").note, "edited note");
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.equal(systemRows.find((row) => row.key === "schemaVersion")?.value, "v1:additive-fields");
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"priority"/);
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

test("sporades dev supports Number fields end-to-end through migrations and runtime APIs", async () => {
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
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      assert.equal((await readSocketMessage(socket)).data[0].text, "Keep me");

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace(
            'import { Boolean, capsule, mutation, query, String, table } from "sporades/server";',
            'import { Boolean, capsule, endpoint, mutation, Number, query, String, table } from "sporades/server";',
          )
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      effort: Number().default(1.5),`,
          )
          .replace(
            "queries: {",
            `endpoints: {
    todosByEffort: endpoint({ method: "GET", path: "/todos/by-effort" }, (ctx) => ({
      body: {
        todos: ctx.db.todos
          .where("effort", globalThis.Number(ctx.request.query.effort))
          .orderBy("effort", "desc")
          .all(),
      },
    })),
  },

  queries: {`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoEffort: mutation((ctx, id: string, effort: number) => {
      ctx.db.todos.update(id, { effort });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, effort: number) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, effort, ownerId: ctx.auth.userId });",
          ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.equal(migratedRows.data.length, 1);
      assert.equal(migratedRows.data[0].text, "Keep me");
      assert.equal(migratedRows.data[0].effort, 1.5);

      migratedSocket.send(
        JSON.stringify({
          id: "add-number",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Numeric work", false, 2.25],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const insertedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Numeric work" && todo.effort === 2.25),
      );
      const insertedTodo = insertedRows.data.find((todo) => todo.text === "Numeric work");

      migratedSocket.send(
        JSON.stringify({
          id: "update-number",
          type: "mutation.run",
          mutation: "updateTodoEffort",
          args: [insertedTodo.id, 3.75],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const updatedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Numeric work" && todo.effort === 3.75),
      );
      assert.equal(typeof updatedRows.data.find((todo) => todo.text === "Numeric work").effort, "number");

      const endpointResponse = await fetch(`${started.data.url}/todos/by-effort?effort=3.75`);
      assert.equal(endpointResponse.status, 200);
      const endpointBody = await endpointResponse.json();
      assert.deepEqual(
        endpointBody.todos.map((todo) => ({ text: todo.text, effort: todo.effort })),
        [{ text: "Numeric work", effort: 3.75 }],
      );

      const storageResult = await runCli(
        ["db", "query", "SELECT effort, typeof(effort) AS kind FROM todos WHERE text = 'Numeric work'", "--json"],
        { cwd: projectDir },
      );
      assert.equal(storageResult.code, 0, storageResult.stderr);
      assert.deepEqual(JSON.parse(storageResult.stdout).data.rows, [{ effort: 3.75, kind: "real" }]);

      migratedSocket.send(
        JSON.stringify({
          id: "invalid-number",
          type: "mutation.run",
          mutation: "updateTodoEffort",
          args: [insertedTodo.id, "not numeric"],
        }),
      );
      assert.deepEqual(await readSocketMessage(migratedSocket), {
        id: "invalid-number",
        type: "mutation.result",
        mutation: "updateTodoEffort",
        data: null,
        error: {
          message: "Invalid number for field: effort",
          hint: "Pass a finite JavaScript number for Number() fields.",
        },
      });
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

test("sporades dev supports Date fields through migrations, mutations, queries, and table API filters", async () => {
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
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      assert.deepEqual(
        (await readSocketMessage(socket)).data.map((todo) => todo.text),
        ["Keep me"],
      );

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace(
            `import { Boolean, capsule, mutation, query, String, table } from "sporades/server";`,
            `import { Boolean, capsule, Date, endpoint, mutation, query, String, table } from "sporades/server";`,
          )
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      dueAt: Date().default(new globalThis.Date("2026-01-02T03:04:05.000Z")),
      reminderAt: Date(),`,
          )
          .replace(
            "queries: {",
            `endpoints: {
    dueTodos: endpoint({ method: "GET", path: "/due-todos" }, (ctx) => ({
      body: ctx.db.todos.where("dueAt", new globalThis.Date(ctx.request.query.dueAt)).orderBy("reminderAt", "asc").all()
    })),
  },

  queries: {`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `rescheduleTodo: mutation((ctx, id, dueAt) => {
      ctx.db.todos.update(id, { dueAt: new globalThis.Date(dueAt) });
    }),

    recordDatedTodo: mutation((ctx, text, dueAt, reminderAt) => {
      ctx.db.todos.insert({
        text,
        done: false,
        dueAt: new globalThis.Date(dueAt),
        reminderAt: reminderAt === null ? null : new globalThis.Date(reminderAt),
        ownerId: ctx.auth.userId,
      });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, dueAt: string, reminderAt: string | null) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, dueAt: new globalThis.Date(dueAt), reminderAt: reminderAt === null ? null : new globalThis.Date(reminderAt), ownerId: ctx.auth.userId });",
          ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.equal(migratedRows.data.length, 1);
      assert.equal(migratedRows.data[0].text, "Keep me");
      assert.equal(migratedRows.data[0].dueAt, "2026-01-02T03:04:05.000Z");
      assert.equal(migratedRows.data[0].reminderAt, null);

      const addFirstResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "add-first" && message.type === "mutation.result",
      );
      const firstDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "First date"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-first",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["First date", false, "2026-03-01T10:00:00.000Z", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.equal((await addFirstResultPromise).error, null);
      await firstDateRowsPromise;

      const addSecondResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "add-second" && message.type === "mutation.result",
      );
      const rowsWithSecondPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Second date"),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "add-second",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Second date", false, "2026-03-01T10:00:00.000Z", null],
        }),
      );
      assert.equal((await addSecondResultPromise).error, null);
      const rowsWithSecond = await rowsWithSecondPromise;
      const firstDateRow = rowsWithSecond.data.find((todo) => todo.text === "First date");
      assert.equal(firstDateRow.dueAt, "2026-03-01T10:00:00.000Z");
      assert.equal(rowsWithSecond.data.find((todo) => todo.text === "Second date").reminderAt, null);

      const updateDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "update-date" && message.type === "mutation.result",
      );
      const updatedDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.find((todo) => todo.id === firstDateRow.id)?.dueAt === "2026-04-01T12:30:00.000Z",
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-date",
          type: "mutation.run",
          mutation: "rescheduleTodo",
          args: [firstDateRow.id, "2026-04-01T12:30:00.000Z"],
        }),
      );
      assert.equal((await updateDateResultPromise).error, null);
      await updatedDateRowsPromise;

      const recordDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "record-date" && message.type === "mutation.result",
      );
      const tableApiDateRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some(
            (todo) =>
              todo.text === "Table API date" &&
              todo.dueAt === "2026-05-01T08:00:00.000Z" &&
              todo.reminderAt === "2026-04-30T18:00:00.000Z",
          ),
      );
      migratedSocket.send(
        JSON.stringify({
          id: "record-date",
          type: "mutation.run",
          mutation: "recordDatedTodo",
          args: ["Table API date", "2026-05-01T08:00:00.000Z", "2026-04-30T18:00:00.000Z"],
        }),
      );
      assert.equal((await recordDateResultPromise).error, null);
      await tableApiDateRowsPromise;

      const invalidDateResultPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "invalid-date" && message.type === "mutation.result",
      );
      migratedSocket.send(
        JSON.stringify({
          id: "invalid-date",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Bad date", false, "not-a-date", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.deepEqual(await invalidDateResultPromise, {
        id: "invalid-date",
        type: "mutation.result",
        data: null,
        error: {
          message: "Invalid date value for field: dueAt",
          hint: "Pass an ISO 8601 date string or JavaScript Date value.",
        },
        mutation: "addTodo",
      });

      const endpointResult = await fetch(`${started.data.url}/due-todos?dueAt=2026-03-01T10%3A00%3A00.000Z`);
      assert.equal(endpointResult.status, 200);
      const endpointRows = await endpointResult.json();
      assert.deepEqual(
        endpointRows.map((todo) => todo.text),
        ["Second date"],
      );
      assert.equal(endpointRows[0].reminderAt, null);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const todosTable = tables.find((table) => table.name === "todos");
      assert.deepEqual(todosTable.columns, [
        "id",
        "createdAt",
        "updatedAt",
        "text",
        "done",
        "dueAt",
        "reminderAt",
        "ownerId",
      ]);
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").dueAt, "2026-01-02T03:04:05.000Z");
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").reminderAt, null);
      assert.equal(todosTable.rows.find((row) => row.text === "First date").dueAt, "2026-04-01T12:30:00.000Z");
      assert.equal(todosTable.rows.find((row) => row.text === "Table API date").dueAt, "2026-05-01T08:00:00.000Z");
      const systemRows = tables.find((table) => table.name === "sporades").rows;
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"kind":"Date"/);
      assert.match(systemRows.find((row) => row.key === "schema")?.value ?? "", /"sqliteType":"TEXT"/);
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

test("sporades dev treats Date fields without defaults as nullable in a fresh database", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "fresh-date-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "fresh-date-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, Date, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "Fresh Dates",
  schema: {
    todos: table({
      text: String(),
      dueAt: Date(),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) => ctx.db.todos.where("ownerId", ctx.auth.userId).all()),
  },
  mutations: {
    recordTodo: mutation((ctx, text, dueAt) => {
      ctx.db.todos.insert({
        text,
        dueAt: dueAt === null ? null : new globalThis.Date(dueAt),
        ownerId: ctx.auth.userId,
      });
    }),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const recordNullDateResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "record-null-date" && message.type === "mutation.result",
      );
      const rowsWithNullDatePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.data.some((todo) => todo.text === "No date yet"),
      );
      socket.send(
        JSON.stringify({
          id: "record-null-date",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["No date yet", null],
        }),
      );
      assert.equal((await recordNullDateResultPromise).error, null);
      const rowsWithNullDate = await rowsWithNullDatePromise;
      assert.equal(rowsWithNullDate.data.find((todo) => todo.text === "No date yet").dueAt, null);

      const recordJsDateResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "record-js-date" && message.type === "mutation.result",
      );
      const rowsWithJsDatePromise = waitForSocketMessage(
        socket,
        (message) =>
          message.id === "todos" &&
          message.data.some((todo) => todo.text === "Has date" && todo.dueAt === "2026-06-01T11:12:13.000Z"),
      );
      socket.send(
        JSON.stringify({
          id: "record-js-date",
          type: "mutation.run",
          mutation: "recordTodo",
          args: ["Has date", "2026-06-01T11:12:13.000Z"],
        }),
      );
      assert.equal((await recordJsDateResultPromise).error, null);
      await rowsWithJsDatePromise;

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const todosTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "todos");
      assert.equal(todosTable.rows.find((row) => row.text === "No date yet").dueAt, null);
      assert.equal(todosTable.rows.find((row) => row.text === "Has date").dueAt, "2026-06-01T11:12:13.000Z");
    } finally {
      socket?.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
});

test("sporades dev preserves Json field values through endpoints and WebSocket queries", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "json-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "json-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, Json, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "json-island",

  schema: {
    notes: table({
      text: String(),
      meta: Json().default({ tags: [], archived: false }),
      ownerId: String(),
    }),
  },

  queries: {
    notes: query((ctx) =>
      ctx.db.notes
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addNote: mutation((ctx, text: string, meta: unknown) => {
      ctx.db.notes.insert({ text, meta, ownerId: ctx.auth.userId });
    }),
    updateNoteMeta: mutation((ctx, id: string, meta: unknown) => {
      ctx.db.notes.update(id, { meta });
    }),
  },

  endpoints: {
    seed: endpoint({ method: "POST", path: "/seed" }, (ctx) => ({
      status: 200,
      body: ctx.db.notes.insert({
        text: ctx.request.body.text,
        meta: ctx.request.body.meta,
        ownerId: ctx.auth.userId,
      }),
    })),
    query: endpoint({ method: "GET", path: "/query" }, (ctx) => ({
      status: 200,
      body: {
        userId: ctx.auth.userId,
        query: ctx.request.query,
      },
    })),
    invalid: endpoint({ method: "POST", path: "/invalid-json" }, (ctx) => {
      ctx.db.notes.insert({
        text: "bad",
        meta: () => "not JSON",
        ownerId: ctx.auth.userId,
      });
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
      const meta = {
        tags: ["agent", "json"],
        flags: { reviewed: true, score: 4.5 },
        values: [null, false, 7, "seven"],
      };
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);
      const sessionToken = auth.data.sessionToken;

      const queryOnlyResponse = await fetch(`${started.data.url}/query?sessionToken=${encodeURIComponent(sessionToken)}&keep=1`);
      assert.equal(queryOnlyResponse.status, 200);
      const queryOnly = await queryOnlyResponse.json();
      assert.notEqual(queryOnly.userId, auth.data.auth.userId);
      assert.deepEqual(queryOnly.query, { keep: "1" });

      const headerQueryResponse = await fetch(`${started.data.url}/query?sessionToken=${encodeURIComponent(sessionToken)}&keep=1`, {
        headers: { "x-sporades-session-token": sessionToken },
      });
      assert.equal(headerQueryResponse.status, 200);
      assert.deepEqual(await headerQueryResponse.json(), {
        userId: auth.data.auth.userId,
        query: { keep: "1" },
      });

      const seedResponse = await fetch(`${started.data.url}/seed`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sporades-session-token": sessionToken },
        body: JSON.stringify({ text: "Seeded", meta }),
      });
      assert.equal(seedResponse.status, 200);
      const seeded = await seedResponse.json();
      assert.deepEqual(seeded.meta, meta);
      const compatibleValues = [
        ["Array", ["top", 1, null]],
        ["Boolean", true],
        ["Number", 42.5],
        ["String", "plain text"],
        ["Null", null],
      ];
      for (const [text, value] of compatibleValues) {
        const response = await fetch(`${started.data.url}/seed`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sporades-session-token": sessionToken },
          body: JSON.stringify({ text, meta: value }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).meta, value);
      }

      socket.send(JSON.stringify({ id: "notes-1", type: "query.subscribe", query: "notes" }));
      const initial = await readSocketMessage(socket);
      assert.equal(initial.error, null);
      assert.deepEqual(initial.data.find((row) => row.text === "Seeded").meta, meta);
      for (const [text, value] of compatibleValues) {
        assert.deepEqual(initial.data.find((row) => row.text === text).meta, value);
      }

      const afterDefaultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes-1" && message.type === "query.result" && message.data.length === 7,
      );
      socket.send(
        JSON.stringify({
          id: "add-1",
          type: "mutation.run",
          mutation: "addNote",
          args: ["Defaulted"],
        }),
      );
      const addResult = await readSocketMessage(socket);
      assert.equal(addResult.type, "mutation.result");
      assert.equal(addResult.error, null);
      const afterDefault = await afterDefaultPromise;
      assert.deepEqual(afterDefault.data[0].meta, { tags: [], archived: false });

      const updatedMeta = { tags: ["edited"], nested: { ok: true }, values: [1, "two", null] };
      socket.send(
        JSON.stringify({
          id: "update-1",
          type: "mutation.run",
          mutation: "updateNoteMeta",
          args: [seeded.id, updatedMeta],
        }),
      );
      const updateResult = await readSocketMessage(socket);
      assert.equal(updateResult.type, "mutation.result");
      assert.equal(updateResult.error, null);
      socket.send(JSON.stringify({ id: "notes-2", type: "query.subscribe", query: "notes" }));
      const afterUpdate = await waitForSocketMessage(
        socket,
        (message) => message.id === "notes-2" && message.type === "query.result",
      );
      assert.deepEqual(afterUpdate.data.find((row) => row.text === "Seeded").meta, updatedMeta);

      const invalidResponse = await fetch(`${started.data.url}/invalid-json`, { method: "POST" });
      assert.equal(invalidResponse.status, 500);
      assert.deepEqual(await invalidResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Invalid JSON field value.",
          hint: "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.",
        },
      });

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const notesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "notes");
      assert.match(notesTable.rows.find((row) => row.text === "Seeded").meta, /^\{/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev applies additive Json field migrations with decoded defaults", async () => {
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
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;
      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(JSON.stringify({ id: "add-before", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      assert.equal((await readSocketMessage(socket)).data[0].text, "Keep me");

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace("import { Boolean,", "import { Boolean, Json,")
          .replace(
            "done: Boolean().default(false),",
            `done: Boolean().default(false),
      meta: Json().default({ tags: ["migrated"], archived: false }),`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoMeta: mutation((ctx, id: string, meta: unknown) => {
      ctx.db.todos.update(id, { meta });
    }),

    addTodo: mutation((ctx, text: string) => {`,
          ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
      const migratedRows = await readSocketMessage(migratedSocket);
      assert.equal(migratedRows.error, null);
      assert.deepEqual(migratedRows.data[0].meta, { tags: ["migrated"], archived: false });

      const updatedMeta = { tags: ["after"], nested: { count: 1 }, values: [true, null, "ok"] };
      const updatedRowsPromise = waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "todos-after" && message.data[0]?.meta?.nested?.count === 1,
      );
      migratedSocket.send(
        JSON.stringify({
          id: "update-meta",
          type: "mutation.run",
          mutation: "updateTodoMeta",
          args: [migratedRows.data[0].id, updatedMeta],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).error, null);
      const updatedRows = await updatedRowsPromise;
      assert.deepEqual(updatedRows.data[0].meta, updatedMeta);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const todosTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "todos");
      assert.match(todosTable.rows[0].meta, /^\{/);
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

test("sporades dev supports Reference fields end-to-end", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "library", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "library");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, mutation, query, Reference, String, table } from "sporades/server";

export default capsule({
  name: "Library",
  schema: {
    users: table({
      name: String(),
      ownerId: String(),
    }),
    posts: table({
      text: String(),
      authorId: Reference("users"),
      ownerId: String(),
    }),
  },
  queries: {
    users: query((ctx) => ctx.db.users.where("ownerId", ctx.auth.userId).all()),
    posts: query((ctx) => ctx.db.posts.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },
  mutations: {
    addUser: mutation((ctx, name: string) => {
      ctx.db.users.insert({ name, ownerId: ctx.auth.userId });
    }),
    addPost: mutation((ctx, text: string, authorId: string) => {
      ctx.db.posts.insert({ text, authorId, ownerId: ctx.auth.userId });
    }),
    updatePostAuthorId: mutation((ctx, id: string, authorId: string) => {
      ctx.db.posts.update(id, { authorId });
    }),
  },
  endpoints: {
    postsByAuthor: endpoint({ method: "GET", path: "/posts/by-author" }, (ctx) => ({
      body: ctx.db.posts.where("authorId", ctx.request.query.authorId).orderBy("authorId").all(),
    })),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let migratedSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;

      socket.send(JSON.stringify({ id: "users", type: "query.subscribe", query: "users" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      const usersAfterAdaPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "users" && message.type === "query.result" && message.data.length === 1,
      );
      socket.send(JSON.stringify({ id: "add-ada", type: "mutation.run", mutation: "addUser", args: ["Ada"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterAda = await usersAfterAdaPromise;
      const adaId = usersAfterAda.data[0].id;
      assert.equal(usersAfterAda.data[0].name, "Ada");

      socket.send(JSON.stringify({ id: "posts", type: "query.subscribe", query: "posts" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      const postsAfterInsertPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data.length === 1,
      );
      socket.send(
        JSON.stringify({ id: "add-post", type: "mutation.run", mutation: "addPost", args: ["Notes on engines", adaId] }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterInsert = await postsAfterInsertPromise;
      assert.equal(postsAfterInsert.data[0].authorId, adaId);

      const byAuthorResponse = await fetch(`${started.data.url}/posts/by-author?authorId=${adaId}`);
      assert.equal(byAuthorResponse.status, 200);
      const postsByAuthor = await byAuthorResponse.json();
      assert.equal(postsByAuthor[0].text, "Notes on engines");
      assert.equal(postsByAuthor[0].authorId, adaId);

      const usersAfterGracePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "users" && message.type === "query.result" && message.data.length === 2,
      );
      socket.send(JSON.stringify({ id: "add-grace", type: "mutation.run", mutation: "addUser", args: ["Grace"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterGrace = await usersAfterGracePromise;
      const graceId = usersAfterGrace.data.find((user) => user.name === "Grace").id;

      const postsAfterUpdatePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data[0]?.authorId === graceId,
      );
      socket.send(
        JSON.stringify({
          id: "update-author",
          type: "mutation.run",
          mutation: "updatePostAuthorId",
          args: [postsAfterInsert.data[0].id, graceId],
        }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterUpdate = await postsAfterUpdatePromise;
      assert.equal(postsAfterUpdate.data[0].text, "Notes on engines");

      socket.send(
        JSON.stringify({
          id: "bad-reference",
          type: "mutation.run",
          mutation: "addPost",
          args: ["Missing author", "missing-user-id"],
        }),
      );
      assert.deepEqual((await readSocketMessage(socket)).error, {
        message: "Invalid reference for field: authorId",
        hint: "Pass the id of an existing users row.",
      });

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer.replace(
          "authorId: Reference(\"users\"),",
          `authorId: Reference("users"),
      editorId: Reference("users").default("${graceId}"),`,
        ),
      );

      const [rebuilt] = await Promise.all([
        waitForJsonEvent(
          child,
          (event) => event.ok && event.data.event === "rebuild" && event.data.status === "success",
        ),
        waitForSocketClose(socket),
      ]);
      assert.equal(rebuilt.error, null);
      socket = null;

      migratedSocket = await openSocket(started.data.url, sessionToken);
      migratedSocket.send(JSON.stringify({ id: "posts-after-migration", type: "query.subscribe", query: "posts" }));
      const migratedPosts = await readSocketMessage(migratedSocket);
      assert.equal(migratedPosts.error, null);
      assert.equal(migratedPosts.data[0].authorId, graceId);
      assert.equal(migratedPosts.data[0].editorId, graceId);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const postsTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "posts");
      assert.deepEqual(postsTable.columns, ["id", "createdAt", "updatedAt", "text", "authorId", "editorId", "ownerId"]);
      assert.equal(postsTable.rows[0].authorId, graceId);
      assert.equal(postsTable.rows[0].editorId, graceId);
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

test("sporades dev deletes Capsule rows through ctx.db table API", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "delete-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "delete-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "delete-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    notes: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()),
  },

  mutations: {
    addNote: mutation((ctx, text: string) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })),
    deleteNote: mutation((ctx, id: string) => ctx.db.notes.delete(id)),
  },
});
`,
    );

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "notes", type: "query.subscribe", query: "notes" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const addedPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes" && message.type === "query.result" && message.data.length === 1,
      );
      const addResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "add-note" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "add-note", type: "mutation.run", mutation: "addNote", args: ["Delete me"] }));
      const addResult = await addResultPromise;
      assert.equal(addResult.error, null);
      assert.equal(addResult.data.text, "Delete me");
      const addedRows = await addedPromise;
      const noteId = addedRows.data[0].id;

      const missingDeletePromise = waitForSocketMessage(
        socket,
        (message) => message.id === "delete-missing" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "delete-missing", type: "mutation.run", mutation: "deleteNote", args: ["missing"] }));
      assert.deepEqual(await missingDeletePromise, {
        id: "delete-missing",
        type: "mutation.result",
        mutation: "deleteNote",
        data: false,
        error: null,
      });

      const deletedPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "notes" && message.type === "query.result" && message.data.length === 0,
      );
      const deleteResultPromise = waitForSocketMessage(
        socket,
        (message) => message.id === "delete-note" && message.type === "mutation.result",
      );
      socket.send(JSON.stringify({ id: "delete-note", type: "mutation.run", mutation: "deleteNote", args: [noteId] }));
      assert.deepEqual(await deleteResultPromise, {
        id: "delete-note",
        type: "mutation.result",
        mutation: "deleteNote",
        data: true,
        error: null,
      });
      assert.deepEqual((await deletedPromise).data, []);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const notesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "notes");
      assert.deepEqual(notesTable.rows, []);
    } finally {
      socket?.close();
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

test("sporades dev reports rebuild events in human-readable output", async () => {
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

    const child = startCli(["dev"], { cwd: projectDir });
    try {
      const started = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev session started at "));
      assert.match(started, /^Sporades dev session started at http:\/\/localhost:\d+$/);

      const clientPath = path.join(projectDir, "client", "index.tsx");
      const originalClient = await readFile(clientPath, "utf8");
      await writeFile(clientPath, originalClient.replace("Sporades Todos", "Sporades Human Todos"));

      const rebuilt = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev session rebuilt at "));
      assert.match(rebuilt, /^Sporades dev session rebuilt at http:\/\/localhost:\d+$/);

      await rm(clientPath);
      const failed = await waitForStdoutLine(child, (line) => line.startsWith("Sporades dev rebuild failed: "));
      assert.match(failed, /Missing client entry: client\/index\.tsx/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev loads server env into ctx.env without exposing it to the client bundle", async () => {
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "API_SECRET=server-only\nFEATURE_FLAG=enabled\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "ctx.env" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "env-1",
        type: "query.result",
        query: "ctx.env",
        data: {
          API_SECRET: "server-only",
          FEATURE_FLAG: "enabled",
        },
        error: null,
      });

      const clientResponse = await fetch(`${started.data.url}/client.js`);
      assert.equal(clientResponse.status, 200);
      assert.doesNotMatch(await clientResponse.text(), /server-only/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev handles missing server env files gracefully", async () => {
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
    await rm(path.join(projectDir, ".env.sporades.server"));
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev rejects invalid server env files with structured errors", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SPORADES_TOKEN=reserved\n");
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid server env file.",
        hint: "Remove reserved SPORADES_ keys from .env.sporades.server.",
      },
    });
  });
});

test("sporades dev rejects Google auth mode when required env values are missing", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      mode: "google",
      google: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=client-id\n");
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Google OAuth is not fully configured.",
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
      },
    });
  });
});

test("sporades dev rejects unsupported auth providers with structured JSON", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = {
      providers: {
        anonymous: true,
        mastodon: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const result = await runCli(["dev", "--json"], { cwd: projectDir });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported auth provider: mastodon",
        hint: "Use supported auth providers: anonymous, google, email.",
      },
    });
  });
});

test("WebSocket auth.get reports enabled providers from multi-provider config", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "todo-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      providers: {
        anonymous: true,
        google: {
          clientIdEnv: "GOOGLE_CLIENT_ID",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        },
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "GOOGLE_CLIENT_ID=client-id\nGOOGLE_CLIENT_SECRET=client-secret\n");
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      assert.equal(auth.id, "auth-1");
      assert.deepEqual(auth.data.providers, {
        anonymous: {
          enabled: true,
        },
        google: {
          enabled: true,
          configured: true,
        },
        email: {
          enabled: true,
        },
      });
      assert.doesNotMatch(JSON.stringify(auth.data.providers), /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|client-secret/);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("WebSocket email sign-up authenticates the current session and populates ctx.auth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "email-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "email-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      providers: {
        anonymous: true,
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";

export default capsule({
  name: "email-island",
  queries: {
    me: query((ctx) => ctx.auth),
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

      socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const anonymousAuth = await readSocketMessage(socket);
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");

      socket.send(
        JSON.stringify({
          id: "signup-1",
          type: "auth.signUp",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "correct horse battery staple",
            name: "Mira",
          },
        }),
      );
      const signUp = await readSocketMessage(socket);
      assert.equal(signUp.id, "signup-1");
      assert.equal(signUp.type, "auth.signUp.result");
      assert.equal(signUp.error, null);
      assert.equal(signUp.data.ok, true);
      assert.notEqual(signUp.data.sessionToken, anonymousAuth.data.sessionToken);
      assert.deepEqual(signUp.data.auth, {
        userId: anonymousAuth.data.auth.userId,
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });

      socket.send(JSON.stringify({ id: "me-1", type: "query.subscribe", query: "me" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "me-1",
        type: "query.result",
        query: "me",
        data: signUp.data.auth,
        error: null,
      });

      socket.send(
        JSON.stringify({
          id: "signup-duplicate",
          type: "auth.signUp",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "another good password",
          },
        }),
      );
      const duplicateSignUp = await readSocketMessage(socket);
      assert.deepEqual(duplicateSignUp, {
        id: "signup-duplicate",
        type: "error",
        data: null,
        error: {
          message: "Email is already registered.",
          hint: "Use auth.signIn(\"email\", ...) with this email address.",
        },
      });

      socket.send(JSON.stringify({ id: "auth-after-duplicate", type: "auth.get" }));
      assert.deepEqual((await readSocketMessage(socket)).data.auth, signUp.data.auth);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("WebSocket email sign-in resolves an existing email account and rejects bad credentials", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "email-signin-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "email-signin-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = {
      providers: {
        anonymous: true,
        email: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";

export default capsule({
  name: "email-signin-island",
  queries: {
    me: query((ctx) => ctx.auth),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(
        JSON.stringify({
          id: "signup-1",
          type: "auth.signUp",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "correct horse battery staple",
            name: "Mira",
          },
        }),
      );
      const signUp = await readSocketMessage(socket);
      assert.equal(signUp.type, "auth.signUp.result");
      const emailUserId = signUp.data.auth.userId;

      socket.send(JSON.stringify({ id: "signout-1", type: "auth.signOut" }));
      assert.equal((await readSocketMessage(socket)).type, "auth.signOut.result");
      socket.send(JSON.stringify({ id: "auth-anon", type: "auth.get" }));
      const anonymousAuth = await readSocketMessage(socket);
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");
      assert.notEqual(anonymousAuth.data.auth.userId, emailUserId);

      socket.send(
        JSON.stringify({
          id: "signin-bad",
          type: "auth.signIn",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "wrong password",
          },
        }),
      );
      const badSignIn = await readSocketMessage(socket);
      assert.equal(badSignIn.type, "error");
      assert.deepEqual(badSignIn.error, {
        message: "Email or password is incorrect.",
        hint: "Check the credentials and try email sign-in again.",
      });

      socket.send(JSON.stringify({ id: "auth-after-bad", type: "auth.get" }));
      const stillAnonymous = await readSocketMessage(socket);
      assert.equal(stillAnonymous.data.auth.userId, anonymousAuth.data.auth.userId);
      assert.equal(stillAnonymous.data.auth.provider, "anonymous");

      socket.send(
        JSON.stringify({
          id: "signin-good",
          type: "auth.signIn",
          provider: "email",
          credentials: {
            email: "mira@example.com",
            password: "correct horse battery staple",
          },
        }),
      );
      const goodSignIn = await readSocketMessage(socket);
      assert.equal(goodSignIn.id, "signin-good");
      assert.equal(goodSignIn.type, "auth.signIn.result");
      assert.equal(goodSignIn.error, null);
      assert.equal(goodSignIn.data.ok, true);
      assert.notEqual(goodSignIn.data.sessionToken, anonymousAuth.data.sessionToken);
      assert.deepEqual(goodSignIn.data.auth, {
        userId: emailUserId,
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
      });

      socket.send(JSON.stringify({ id: "me-1", type: "query.subscribe", query: "me" }));
      assert.deepEqual((await readSocketMessage(socket)).data, goodSignIn.data.auth);

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        sqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", goodSignIn.data.sessionToken);
      } finally {
        sqlite.close();
      }
      socket.close();
      socket = null;

      expiredSocket = await openSocket(started.data.url, goodSignIn.data.sessionToken);
      expiredSocket.send(JSON.stringify({ id: "auth-expired-linked", type: "auth.get" }));
      const expiredLinked = await readSocketMessage(expiredSocket);
      assert.equal(expiredLinked.data.auth.provider, "anonymous");
      assert.notEqual(expiredLinked.data.auth.userId, emailUserId);
      assert.notEqual(expiredLinked.data.sessionToken, goodSignIn.data.sessionToken);
    } finally {
      socket?.close();
      expiredSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("Google auth callback exchanges the code server-side and links the current anonymous account", async () => {
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
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);

    await withFakeGoogleServer(async (google) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_USERINFO_URL: google.userInfoUrl,
        },
      });
      let socket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);

        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;
        assert.equal(anonymousAuth.data.auth.isGuest, true);
        assert.equal(anonymousAuth.data.providers.google.configured, true);
        const googlePreRefreshExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const { DatabaseSync } = await import("node:sqlite");
        const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
        try {
          sqlite
            .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
            .run(googlePreRefreshExpiry, anonymousAuth.data.sessionToken);
        } finally {
          sqlite.close();
        }

        socket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);
        socket.send(JSON.stringify({ id: "todo-1", type: "mutation.run", mutation: "addTodo", args: ["Keep me"] }));
        assert.equal((await readSocketMessage(socket)).type, "mutation.result");
        assert.equal((await readSocketMessage(socket)).data[0].text, "Keep me");

        socket.send(
          JSON.stringify({
            id: "complete-1",
            type: "auth.completeGoogleSignIn",
            profile: { email: "mallory@example.com", displayName: "Mallory" },
          }),
        );
        const fakeComplete = await readSocketMessage(socket);
        assert.equal(fakeComplete.type, "error");
        assert.match(fakeComplete.error.message, /Unsupported WebSocket message/);

        socket.send(JSON.stringify({ id: "signin-1", type: "auth.signIn", provider: "google", returnTo: `${started.data.url}/notes` }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.id, "signin-1");
        assert.equal(signIn.type, "auth.redirect");
        assert.match(signIn.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        assert.doesNotMatch(signIn.data.url, /client-secret/);
        const signInUrl = new URL(signIn.data.url);
        assert.equal(signInUrl.searchParams.get("client_id"), "client-id");
        assert.equal(signInUrl.searchParams.get("response_type"), "code");
        assert.equal(signInUrl.searchParams.get("scope"), "openid email profile");
        assert.match(signInUrl.searchParams.get("redirect_uri"), /\/__sporades\/auth\/google\/callback$/);
        assert.notEqual(signInUrl.searchParams.get("state"), anonymousAuth.data.sessionToken);

        const callbackResponse = await fetch(
          `${started.data.url}/__sporades/auth/google/callback?code=server-owned-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("location"), `${started.data.url}/notes`);
        assert.deepEqual(google.requests[0], {
          method: "POST",
          path: "/token",
          body: {
            code: "server-owned-code",
            client_id: "client-id",
            client_secret: "client-secret",
            redirect_uri: `${started.data.url}/__sporades/auth/google/callback`,
            grant_type: "authorization_code",
          },
        });
        assert.deepEqual(google.requests[1], {
          method: "GET",
          path: "/userinfo",
          authorization: "Bearer server-owned-access-token",
        });

        socket.send(JSON.stringify({ id: "auth-2", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.equal(linked.type, "auth.result");
        assert.equal(linked.data.sessionToken, anonymousAuth.data.sessionToken);
        assert.deepEqual(linked.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });
        const refreshedSqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
        try {
          const refreshedSession = refreshedSqlite
            .prepare("SELECT expiresAt FROM sporades_auth_sessions WHERE token = ?")
            .get(linked.data.sessionToken);
          assert.ok(Date.parse(refreshedSession.expiresAt) > Date.parse(googlePreRefreshExpiry));
        } finally {
          refreshedSqlite.close();
        }

        socket.send(JSON.stringify({ id: "query-2", type: "query.subscribe", query: "todos" }));
        const todosAfterLink = await readSocketMessage(socket);
        assert.deepEqual(
          todosAfterLink.data.map((todo) => todo.text),
          ["Keep me"],
        );

        socket.send(JSON.stringify({ id: "signout-1", type: "auth.signOut" }));
        const signOut = await readSocketMessage(socket);
        assert.deepEqual(signOut, {
          id: "signout-1",
          type: "auth.signOut.result",
          data: { ok: true },
          error: null,
        });

        socket.send(JSON.stringify({ id: "auth-3", type: "auth.get" }));
        const signedOutAuth = await readSocketMessage(socket);
        assert.notEqual(signedOutAuth.data.sessionToken, linked.data.sessionToken);
        assert.notEqual(signedOutAuth.data.auth.userId, userId);
        assert.deepEqual(signedOutAuth.data.auth, {
          userId: signedOutAuth.data.auth.userId,
          displayName: "Anonymous",
          email: null,
          picture: null,
          isAuthenticated: false,
          isGuest: true,
          provider: "anonymous",
        });

        socket.send(JSON.stringify({ id: "query-3", type: "query.subscribe", query: "todos" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

test("Google auth sign-in uses forwarded https origin behind a proxy", async () => {
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
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocketWithHeaders(started.data.url, {
        "x-forwarded-host": "photos.example.test",
        "x-forwarded-proto": "https",
      });

      socket.sendJson({
        id: "signin",
        type: "auth.signIn",
        provider: "google",
        returnTo: "https://photos.example.test/library",
      });
      const signIn = await socket.readJson();
      assert.equal(signIn.type, "auth.redirect");
      const signInUrl = new URL(signIn.data.url);
      assert.equal(signInUrl.searchParams.get("redirect_uri"), "https://photos.example.test/__sporades/auth/google/callback");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades logs returns captured ctx.log entries from the running dev session", async () => {
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=env-secret-123\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "Todo Island",
  endpoints: {
    log: endpoint({ method: "POST", path: "/log" }, (ctx) => {
      ctx.log.info("ctx.log is available", {
        password: "plaintext-password",
        token: "token-123",
        secretValue: ctx.env.WEBHOOK_SECRET,
        authorization: "Bearer auth-123",
        cookie: "session=abc",
        clientSecret: "client-secret-123",
        safe: "visible",
        nested: { apiToken: "nested-token-123" },
        large: "x".repeat(5000),
      });
      return { status: 200, body: { ok: true, body: ctx.request.body } };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);

      const ctxResponse = await fetch(`${started.data.url}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawBodySecret: "do-not-log-request-body" }),
      });
      assert.equal(ctxResponse.status, 200);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      assert.equal(logs.error, null);
      assert.equal(logs.data.source, "sqlite");
      const ctxLog = logs.data.entries.find((entry) => entry.message === "ctx.log is available");
      const platformLog = logs.data.entries.find((entry) => entry.event === "dev.session.started");

      assert.equal(platformLog.category, "platform");
      assert.equal(platformLog.level, "info");
      assert.equal(platformLog.capsule.name, "todo-island");
      assert.equal(platformLog.release, null);
      assert.equal(ctxLog.category, "app");
      assert.equal(ctxLog.event, "ctx.log");
      assert.equal(ctxLog.level, "info");
      assert.equal(ctxLog.capsule.name, "todo-island");
      assert.equal(ctxLog.release, null);
      assert.equal(ctxLog.request.method, "POST");
      assert.equal(ctxLog.request.path, "/log");
      assert.equal(ctxLog.request.body, undefined);
      assert.equal(ctxLog.data.safe, "visible");
      assert.equal(ctxLog.data.password, "[REDACTED]");
      assert.equal(ctxLog.data.token, "[REDACTED]");
      assert.equal(ctxLog.data.secretValue, "[REDACTED]");
      assert.equal(ctxLog.data.authorization, "[REDACTED]");
      assert.equal(ctxLog.data.cookie, "[REDACTED]");
      assert.equal(ctxLog.data.clientSecret, "[REDACTED]");
      assert.equal(ctxLog.data.nested.apiToken, "[REDACTED]");
      assert.equal(JSON.stringify(ctxLog).includes("do-not-log-request-body"), false);
      assert.equal(JSON.stringify(ctxLog).includes("env-secret-123"), false);
      assert.equal(ctxLog.truncated, true);

      const tailResult = await runCli(["logs", "tail", "--json"], { cwd: projectDir });
      assert.equal(tailResult.code, 0, tailResult.stderr);
      const tailEvents = tailResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(tailEvents.some((entry) => entry.event === "ctx.log" && entry.message === "ctx.log is available"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("dev inspection routes require the per-session inspection token while CLI logs send it", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "inspect-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "inspect-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.equal(session.url, started.data.url);
      assert.match(session.inspectionToken, /^[a-f0-9]{64}$/);

      const unauthenticatedLogs = await fetch(`${started.data.url}/__sporades/debug/logs`);
      assert.equal(unauthenticatedLogs.status, 401);
      assert.deepEqual(await unauthenticatedLogs.json(), {
        ok: false,
        data: null,
        error: {
          message: "Dev inspection token is required.",
          hint: "Use Sporades CLI inspection commands for this Dev session.",
        },
      });

      const invalidLogs = await fetch(`${started.data.url}/__sporades/debug/logs`, {
        headers: { "x-sporades-inspection-token": "not-the-token" },
      });
      assert.equal(invalidLogs.status, 401);
      assert.equal((await invalidLogs.json()).data, null);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      assert.equal(logs.data.source, "sqlite");
      assert.equal(logs.data.entries.some((entry) => entry.event === "dev.session.started"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("dev inspection JSON requests reject oversized bodies with structured diagnostics", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "request-limit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "request-limit-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.http = { maxBodyBytes: 64 };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      const response = await fetch(`${started.data.url}/__sporades/debug/db/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({ sql: "SELECT 1", filler: "x".repeat(128) }),
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        ok: false,
        data: null,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
          hint: "Send a request body at or below 64 bytes, or raise http.maxBodyBytes in sporades.json.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("dev inspection token rejection protects database inspection and local identity simulation", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "guarded-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "guarded-island");
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

      const dbListResponse = await fetch(`${started.data.url}/__sporades/debug/db/list`);
      assert.equal(dbListResponse.status, 401);
      assert.equal((await dbListResponse.json()).data, null);

      const dbQueryResponse = await fetch(`${started.data.url}/__sporades/debug/db/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT name FROM sqlite_schema" }),
      });
      assert.equal(dbQueryResponse.status, 401);
      assert.equal((await dbQueryResponse.json()).data, null);

      const authResponse = await fetch(`${started.data.url}/__sporades/debug/auth/as`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": "wrong-token",
        },
        body: JSON.stringify({ provider: "email", email: "mira@example.com" }),
      });
      assert.equal(authResponse.status, 401);
      assert.equal((await authResponse.json()).data, null);

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const sessionCount = sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions").get();
        assert.equal(sessionCount.count, 0);
      } finally {
        sqlite.close();
      }

      const dbResult = await runCli(["db", "query", "SELECT COUNT(*) AS count FROM todos", "--json"], { cwd: projectDir });
      assert.equal(dbResult.code, 0, dbResult.stderr);
      assert.deepEqual(JSON.parse(dbResult.stdout).data.rows, [{ count: 0 }]);

      const authResult = await runCli(["auth", "as", "email", "--email", "mira@example.com", "--json"], { cwd: projectDir });
      assert.equal(authResult.code, 0, authResult.stderr);
      assert.equal(JSON.parse(authResult.stdout).data.auth.email, "mira@example.com");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("dev inspection token rotates across dev session restarts", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "rotation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "rotation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const firstChild = startCli(["dev", "--json"], { cwd: projectDir });
    let firstToken;
    try {
      const firstStarted = await waitForJsonLine(firstChild);
      assert.equal(firstStarted.ok, true, JSON.stringify(firstStarted.error));
      const firstSession = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      firstToken = firstSession.inspectionToken;
      assert.match(firstToken, /^[a-f0-9]{64}$/);
    } finally {
      firstChild.kill("SIGTERM");
      await new Promise((resolve) => firstChild.once("exit", resolve));
    }

    const secondChild = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const secondStarted = await waitForJsonLine(secondChild);
      assert.equal(secondStarted.ok, true, JSON.stringify(secondStarted.error));
      const secondSession = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      assert.match(secondSession.inspectionToken, /^[a-f0-9]{64}$/);
      assert.notEqual(secondSession.inspectionToken, firstToken);

      const oldTokenResponse = await fetch(`${secondStarted.data.url}/__sporades/debug/db/list`, {
        headers: { "x-sporades-inspection-token": firstToken },
      });
      assert.equal(oldTokenResponse.status, 401);
      assert.equal((await oldTokenResponse.json()).data, null);

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.equal(JSON.parse(listResult.stdout).ok, true);
    } finally {
      secondChild.kill("SIGTERM");
      await new Promise((resolve) => secondChild.once("exit", resolve));
    }
  });
});

test("sporades logs expose runtime-owned Privileged audit events without letting ctx.log forge them", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "audit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "audit-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=env-secret-123\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "Audit Island",
  endpoints: {
    forge: endpoint({ method: "POST", path: "/forge-audit" }, (ctx) => {
      ctx.log.info("forged audit", {
        category: "audit",
        event: "privileged.succeeded",
        actorKind: "privileged-server-role",
        safe: "ordinary app data",
      });
      return { status: 200, body: { ok: true } };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], {
      cwd: projectDir,
      env: { SPORADES_TEST_ENABLE_PRIVILEGED_AUDIT_DEBUG: "1" },
    });
    try {
      const started = await waitForJsonLine(child);
      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));

      const forgedResponse = await fetch(`${started.data.url}/forge-audit`, { method: "POST" });
      assert.equal(forgedResponse.status, 200);

      const auditResponse = await fetch(`${started.data.url}/__sporades/debug/privileged-audit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({
          actorKind: "privileged-server-role",
          operation: "runtime.audit.inspect",
          surface: "sporades/dev-debug",
          correlation: { id: "corr-dev-audit" },
          targetResourceKind: "log-index",
          outcome: "completed",
          source: "runtime",
          metadata: {
            visible: "safe",
            authorization: "Bearer should-not-leak",
            rawRequestBody: { secret: "raw-body-secret" },
          },
        }),
      });
      assert.equal(auditResponse.status, 200);

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);

      const auditEvents = logs.data.entries.filter((entry) => entry.category === "audit");
      assert.equal(auditEvents.length, 1);
      const [auditEvent] = auditEvents;
      assert.equal(auditEvent.event, "privileged.completed");
      assert.equal(auditEvent.data.schema, "sporades.privileged-audit.v1");
      assert.equal(auditEvent.data.actorKind, "privileged-server-role");
      assert.equal(auditEvent.data.operation, "runtime.audit.inspect");
      assert.equal(auditEvent.data.surface, "sporades/dev-debug");
      assert.deepEqual(auditEvent.correlation, { id: "corr-dev-audit" });
      assert.equal(auditEvent.data.targetResourceKind, "log-index");
      assert.equal(auditEvent.data.outcome, "completed");
      assert.equal(auditEvent.data.metadata.visible, "safe");
      assert.equal(auditEvent.data.metadata.authorization, "[REDACTED]");
      assert.equal(auditEvent.data.metadata.rawRequestBody, "[REDACTED]");
      assert.equal(JSON.stringify(auditEvent).includes("should-not-leak"), false);
      assert.equal(JSON.stringify(auditEvent).includes("raw-body-secret"), false);

      const forgedLog = logs.data.entries.find((entry) => entry.message === "forged audit");
      assert.equal(forgedLog.category, "app");
      assert.equal(forgedLog.event, "ctx.log");
      assert.equal(forgedLog.data.category, "audit");
      assert.equal(forgedLog.data.event, "privileged.succeeded");

      const tailResult = await runCli(["logs", "tail", "--json"], { cwd: projectDir });
      assert.equal(tailResult.code, 0, tailResult.stderr);
      const tailEvents = tailResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(tailEvents.some((entry) => entry.category === "audit" && entry.event === "privileged.completed"), true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades db list returns tables from the running dev session database", async () => {
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

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.deepEqual(JSON.parse(listResult.stdout), {
        ok: true,
        data: {
          tables: [
            "sporades",
            "sporades_auth_oauth_states",
            "sporades_auth_sessions",
            "sporades_auth_users",
            "sporades_file_buckets",
            "sporades_file_public_urls",
            "sporades_file_uploads",
            "sporades_files",
            "sporades_jobs",
            "sporades_user_preferences",
            "todos",
          ],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades db dump returns structured table data from the running dev session database", async () => {
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
      await waitForJsonLine(child);

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      assert.deepEqual(JSON.parse(dumpResult.stdout), {
        ok: true,
        data: {
          tables: [
            {
              name: "sporades",
              columns: ["key", "value"],
              rows: [
                { key: "schemaVersion", value: "v1:additive-fields" },
                { key: "schemaHash", value: "71a20803ea953152096eea819b23296357aa0f92317215685136640caac64904" },
                {
                  key: "schema",
                  value:
                    '{"tables":[{"name":"todos","fields":[{"name":"text","kind":"String","sqliteType":"TEXT"},{"name":"done","kind":"Boolean","sqliteType":"INTEGER","defaultValue":false},{"name":"ownerId","kind":"String","sqliteType":"TEXT"}]}]}',
                },
              ],
            },
            {
              name: "sporades_auth_oauth_states",
              columns: ["state", "sessionToken", "returnTo", "redirectUri", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_auth_sessions",
              columns: ["token", "userId", "createdAt", "expiresAt"],
              rows: [],
            },
            {
              name: "sporades_auth_users",
              columns: [
                "id",
                "createdAt",
                "displayName",
                "email",
                "picture",
                "isAuthenticated",
                "isGuest",
                "provider",
              ],
              rows: [],
            },
            {
              name: "sporades_file_buckets",
              columns: ["id", "ownerId", "name", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_file_public_urls",
              columns: ["id", "fileId", "ownerId", "version", "expiresAt", "createdAt", "revokedAt"],
              rows: [],
            },
            {
              name: "sporades_file_uploads",
              columns: ["id", "fileId", "ownerId", "bucketId", "bucketName", "path", "name", "type", "version", "expectedSize", "createdAt"],
              rows: [],
            },
            {
              name: "sporades_files",
              columns: [
                "id",
                "ownerId",
                "bucketId",
                "bucketName",
                "path",
                "name",
                "type",
                "size",
                "version",
                "status",
                "createdAt",
                "updatedAt",
                "deletedAt",
              ],
              rows: [],
            },
            {
              name: "sporades_jobs",
              columns: [
                "id",
                "handler",
                "enqueuedByUserId",
                "actorUserId",
                "payload",
                "status",
                "availableAt",
                "attempts",
                "idempotencyKey",
                "result",
                "failure",
                "createdAt",
                "startedAt",
                "completedAt",
                "failedAt",
                "retryJson",
                "attemptHistory",
                "cancelRequestedAt",
                "leaseExpiresAt",
                "scheduleName",
                "scheduledFor",
              ],
              rows: [],
            },
            {
              name: "sporades_user_preferences",
              columns: ["userId", "value", "updatedAt"],
              rows: [],
            },
            {
              name: "todos",
              columns: ["id", "createdAt", "updatedAt", "text", "done", "ownerId"],
              rows: [],
            },
          ],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades db query runs read-only SQL against the running dev session database", async () => {
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

      const queryResult = await runCli(
        ["db", "query", "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(queryResult.code, 0, queryResult.stderr);
      assert.deepEqual(JSON.parse(queryResult.stdout), {
        ok: true,
        data: {
          columns: ["name"],
          rows: [
            { name: "sporades" },
            { name: "sporades_auth_oauth_states" },
            { name: "sporades_auth_sessions" },
            { name: "sporades_auth_users" },
            { name: "sporades_file_buckets" },
            { name: "sporades_file_public_urls" },
            { name: "sporades_file_uploads" },
            { name: "sporades_files" },
            { name: "sporades_jobs" },
            { name: "sporades_user_preferences" },
            { name: "todos" },
          ],
        },
        error: null,
      });

      const internalLogQuery = await runCli(["db", "query", "SELECT * FROM sporades_log_events", "--json"], {
        cwd: projectDir,
      });
      assert.equal(internalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(internalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const qualifiedInternalLogQuery = await runCli(["db", "query", "SELECT * FROM main.sporades_log_events", "--json"], {
        cwd: projectDir,
      });
      assert.equal(qualifiedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(qualifiedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const quotedQualifiedInternalLogQuery = await runCli(
        ["db", "query", 'SELECT message, payload FROM main."sporades_log_events"', "--json"],
        { cwd: projectDir },
      );
      assert.equal(quotedQualifiedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(quotedQualifiedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const parenthesizedInternalLogQuery = await runCli(
        ["db", "query", "SELECT message, payload FROM (sporades_log_events)", "--json"],
        { cwd: projectDir },
      );
      assert.equal(parenthesizedInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(parenthesizedInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const blockCommentInternalLogQuery = await runCli(
        ["db", "query", "SELECT message FROM /* comment */ sporades_log_events", "--json"],
        { cwd: projectDir },
      );
      assert.equal(blockCommentInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(blockCommentInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const lineCommentInternalLogQuery = await runCli(
        ["db", "query", "SELECT message FROM -- comment\n sporades_log_events", "--json"],
        { cwd: projectDir },
      );
      assert.equal(lineCommentInternalLogQuery.code, 1);
      assert.deepEqual(JSON.parse(lineCommentInternalLogQuery.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Internal log index tables are not available through generic DB inspection.",
          hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
        },
      });

      const schemaSqlQuery = await runCli(
        ["db", "query", "SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(schemaSqlQuery.code, 0, schemaSqlQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(schemaSqlQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const schemaProjectionQuery = await runCli(
        ["db", "query", "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(schemaProjectionQuery.code, 0, schemaProjectionQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(schemaProjectionQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const transformedSchemaQuery = await runCli(
        ["db", "query", "SELECT quote(name) AS leaked FROM sqlite_schema WHERE type = 'table' ORDER BY name", "--json"],
        { cwd: projectDir },
      );
      assert.equal(transformedSchemaQuery.code, 0, transformedSchemaQuery.stderr);
      assert.equal(
        JSON.stringify(JSON.parse(transformedSchemaQuery.stdout).data.rows).includes("sporades_log_events"),
        false,
      );

      const literalOnlyQuery = await runCli(
        ["db", "query", "SELECT 'sporades_log_events' AS literal_only", "--json"],
        { cwd: projectDir },
      );
      assert.equal(literalOnlyQuery.code, 0, literalOnlyQuery.stderr);
      assert.deepEqual(JSON.parse(literalOnlyQuery.stdout), {
        ok: true,
        data: {
          columns: ["literal_only"],
          rows: [{ literal_only: "sporades_log_events" }],
        },
        error: null,
      });

      const session = JSON.parse(await readFile(path.join(projectDir, ".sporades", "dev-session.json"), "utf8"));
      const mutatingPragma = await fetch(new URL("/__sporades/debug/db/query", started.data.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sporades-inspection-token": session.inspectionToken,
        },
        body: JSON.stringify({ sql: "PRAGMA user_version = 7" }),
      });
      assert.equal(mutatingPragma.status, 200);
      assert.deepEqual(await mutatingPragma.json(), {
        ok: false,
        data: null,
        error: {
          message: "Only read-only SQL is allowed.",
          hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
        },
      });

      const userVersion = await runCli(["db", "query", "SELECT * FROM pragma_user_version", "--json"], {
        cwd: projectDir,
      });
      assert.equal(userVersion.code, 0, userVersion.stderr);
      assert.deepEqual(JSON.parse(userVersion.stdout), {
        ok: true,
        data: {
          columns: ["user_version"],
          rows: [{ user_version: 0 }],
        },
        error: null,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades db query rejects write SQL with a structured hint", async () => {
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
      await waitForJsonLine(child);

      const queryResult = await runCli(["db", "query", "DELETE FROM todos", "--json"], { cwd: projectDir });
      assert.equal(queryResult.code, 1);
      assert.deepEqual(JSON.parse(queryResult.stdout), {
        ok: false,
        data: null,
        error: {
          message: "Only read-only SQL is allowed.",
          hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
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
      try {
        socket.send(JSON.stringify({ id: "query-1", type: "query.subscribe", query: "todos" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "query-1",
          type: "query.result",
          query: "todos",
          data: [],
          error: null,
        });

        socket.send(JSON.stringify({ id: "mutation-1", type: "mutation.run", mutation: "addTodo", args: ["Buy milk"] }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "mutation-1",
          type: "mutation.result",
          mutation: "addTodo",
          data: null,
          error: null,
        });

        const refreshed = await readSocketMessage(socket);
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
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev runs query handlers from the bundled Capsule module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "query-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "query-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "helpers.ts"),
      `export function decorateGreeting(name: string) {
  return \`Hello, \${name}!\`;
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";
import { decorateGreeting } from "./helpers";

const salutation = "Ada";

export default capsule({
  name: "query-island",

  queries: {
    greeting: query(() => ({
      text: decorateGreeting(salutation),
      parts: ["bundled", "query"],
    })),

    broken: query(() => {
      throw new Error("Imported helper went sideways.");
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      const socket = await openSocket(started.data.url);
      try {
        socket.send(JSON.stringify({ id: "greeting-1", type: "query.subscribe", query: "greeting" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "greeting-1",
          type: "query.result",
          query: "greeting",
          data: {
            text: "Hello, Ada!",
            parts: ["bundled", "query"],
          },
          error: null,
        });

        socket.send(JSON.stringify({ id: "broken-1", type: "query.subscribe", query: "broken" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "broken-1",
          type: "query.result",
          query: "broken",
          error: {
            message: "Imported helper went sideways.",
            hint: "Check the Capsule query handler and retry the query.",
          },
        });

        const stillServing = await fetch(started.data.url);
        assert.equal(stillServing.status, 200);
      } finally {
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev awaits async Capsule query handlers before sending results", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-query-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-query-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";

export default capsule({
  name: "async-query-island",

  queries: {
    greeting: query(async () => {
      await Promise.resolve();
      return { text: "async query resolved" };
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
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "greeting", type: "query.subscribe", query: "greeting" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "greeting",
        type: "query.result",
        query: "greeting",
        data: { text: "async query resolved" },
        error: null,
      });
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("a scaffolded guestbook trims, validates, and reads shared entries over WebSocket", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "guest-island", "--template", "guestbook", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "guest-island");
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
      try {
        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const authResult = await readSocketMessage(socket);
        assert.equal(authResult.data.auth.isGuest, true);
        assert.equal(authResult.data.auth.displayName, "Anonymous");

        socket.send(JSON.stringify({ id: "entries-1", type: "query.subscribe", query: "entries" }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "entries-1",
          type: "query.result",
          query: "entries",
          data: [],
          error: null,
        });

        socket.send(JSON.stringify({ id: "empty-1", type: "mutation.run", mutation: "sign", args: ["   "] }));
        const emptyResult = await readSocketMessage(socket);
        assert.equal(emptyResult.type, "mutation.result");
        assert.equal(emptyResult.error.message, "Write a message before signing.");

        socket.send(JSON.stringify({ id: "long-1", type: "mutation.run", mutation: "sign", args: ["x".repeat(281)] }));
        const longResult = await readSocketMessage(socket);
        assert.equal(longResult.type, "mutation.result");
        assert.equal(longResult.error.message, "Guestbook messages must be 280 characters or fewer.");

        const firstRefreshPromise = waitForSocketMessage(
          socket,
          (message) =>
            message.type === "query.result" &&
            message.query === "entries" &&
            message.data.some((entry) => entry.body === "First note"),
        );
        socket.send(JSON.stringify({ id: "sign-1", type: "mutation.run", mutation: "sign", args: ["  First note  "] }));
        assert.deepEqual(await readSocketMessage(socket), {
          id: "sign-1",
          type: "mutation.result",
          mutation: "sign",
          data: null,
          error: null,
        });
        const firstRefresh = await firstRefreshPromise;
        assert.equal(firstRefresh.data.length, 1);
        assert.equal(firstRefresh.data[0].body, "First note");
        assert.equal(firstRefresh.data[0].authorId, authResult.data.auth.userId);
        assert.equal(firstRefresh.data[0].authorName, "Anonymous");
        assert.equal(firstRefresh.data[0].authorPicture, "");

        await new Promise((resolve) => setTimeout(resolve, 5));
        const secondRefreshPromise = waitForSocketMessage(
          socket,
          (message) =>
            message.type === "query.result" &&
            message.query === "entries" &&
            message.data.some((entry) => entry.body === "Second note"),
        );
        socket.send(JSON.stringify({ id: "sign-2", type: "mutation.run", mutation: "sign", args: ["Second note"] }));
        assert.equal((await readSocketMessage(socket)).error, null);
        const secondRefresh = await secondRefreshPromise;
        assert.deepEqual(
          secondRefresh.data.map((entry) => entry.body),
          ["Second note", "First note"],
        );

        const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
        assert.equal(dumpResult.code, 0, dumpResult.stderr);
        const entriesTable = JSON.parse(dumpResult.stdout).data.tables.find((table) => table.name === "entries");
        assert.deepEqual(entriesTable.columns, ["id", "createdAt", "updatedAt", "body", "authorId", "authorName", "authorPicture"]);
      } finally {
        socket.close();
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("a scaffolded guestbook stores Google-linked author metadata from ctx.auth", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "guest-island", "--template", "guestbook", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "guest-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);

    await withFakeGoogleServer(async (google) => {
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: {
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_USERINFO_URL: google.userInfoUrl,
        },
      });
      let socket;
      try {
        const started = await waitForJsonLine(child);
        assert.equal(started.ok, true, JSON.stringify(started));
        socket = await openSocket(started.data.url);

        socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;
        assert.equal(anonymousAuth.data.providers.google.configured, true);

        socket.send(JSON.stringify({ id: "signin-1", type: "auth.signIn", provider: "google", returnTo: `${started.data.url}/guestbook` }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        const signInUrl = new URL(signIn.data.url);
        const callbackResponse = await fetch(
          `${started.data.url}/__sporades/auth/google/callback?code=server-owned-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("location"), `${started.data.url}/guestbook`);

        socket.send(JSON.stringify({ id: "auth-2", type: "auth.get" }));
        const linkedAuth = await readSocketMessage(socket);
        assert.deepEqual(linkedAuth.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });

        socket.send(JSON.stringify({ id: "entries-1", type: "query.subscribe", query: "entries" }));
        assert.deepEqual((await readSocketMessage(socket)).data, []);

        socket.send(JSON.stringify({ id: "sign-1", type: "mutation.run", mutation: "sign", args: ["Signed with Google"] }));
        assert.equal((await readSocketMessage(socket)).error, null);
        const refresh = await readSocketMessage(socket);
        assert.equal(refresh.data[0].body, "Signed with Google");
        assert.equal(refresh.data[0].authorId, userId);
        assert.equal(refresh.data[0].authorName, "Mira");
        assert.equal(refresh.data[0].authorPicture, "https://example.com/mira.png");
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

test("sporades dev routes client app messages through declared Capsule handlers", async () => {
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
    typing: message((ctx, data) => ({
      handledBy: ctx.auth.userId,
      received: data,
    })),
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

      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      socket.send(
        JSON.stringify({
          id: "typing-1",
          type: "app.send",
          message: "typing",
          data: { roomId: "general", active: true },
        }),
      );

      assert.deepEqual(await readSocketMessage(socket), {
        id: "typing-1",
        type: "app.result",
        message: "typing",
        data: {
          handledBy: auth.data.auth.userId,
          received: { roomId: "general", active: true },
        },
        error: null,
      });
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev rolls back multi-write App message app-table failures", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "message-rollback-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "message-rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message, String, table } from "sporades/server";

export default capsule({
  name: "message-rollback-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  messages: {
    record: message((ctx, data) => {
      ctx.db.notes.insert({ text: data.text + ":committed", ownerId: ctx.auth.userId });
      return { ok: true };
    }),
    explode: message((ctx, data) => {
      ctx.db.notes.insert({ text: data.text + ":first", ownerId: ctx.auth.userId });
      ctx.db.notes.insert({ text: data.text + ":second", ownerId: ctx.auth.userId });
      throw new Error("Message write failed.");
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
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "record", type: "app.send", message: "record", data: { text: "before" } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "app.result",
        message: "record",
        data: { ok: true },
        error: null,
      });

      socket.send(JSON.stringify({ id: "explode", type: "app.send", message: "explode", data: { text: "rollback" } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "explode",
        type: "app.result",
        message: "explode",
        data: null,
        error: {
          message: "Message write failed.",
          hint: "Check the Capsule message handler and retry the app message.",
        },
      });

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "notes").rows.map((row) => row.text),
        ["before:committed"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev awaits async app message handlers before sending app results", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-message-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-message-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, message } from "sporades/server";

export default capsule({
  name: "async-message-island",

  messages: {
    typing: message(async (ctx, data) => {
      await Promise.resolve();
      ctx.messages.send({ type: "typing", data: { resolved: data.active } });
      return { ok: true, resolved: data.active };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let firstSocket;
    let secondSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);
      firstSocket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await readSocketMessage(firstSocket);
      secondSocket = await openSocket(started.data.url, auth.data.sessionToken);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(secondSocket)).type, "auth.result");

      const firstAppMessage = waitForSocketMessage(
        firstSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const secondAppMessage = waitForSocketMessage(
        secondSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const sendResult = waitForSocketMessage(
        firstSocket,
        (message) => message.id === "typing" && message.type === "app.result",
      );

      firstSocket.send(
        JSON.stringify({
          id: "typing",
          type: "app.send",
          message: "typing",
          data: { active: true },
        }),
      );

      assert.deepEqual(await firstAppMessage, {
        type: "app.message",
        message: "typing",
        data: { resolved: true },
      });
      assert.deepEqual(await secondAppMessage, {
        type: "app.message",
        message: "typing",
        data: { resolved: true },
      });
      assert.deepEqual(await sendResult, {
        id: "typing",
        type: "app.result",
        message: "typing",
        data: { ok: true, resolved: true },
        error: null,
      });
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("server app message handlers can send filtered app messages to the current user's clients", async () => {
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
    typing: message((ctx, data) => {
      const sentToClients = ctx.messages.send({ type: "typing", data });
      return { ok: true, sentToClients };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let firstSocket;
    let secondSocket;
    let otherUserSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);
      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);

      secondSocket = await openSocket(started.data.url, firstAuth.data.sessionToken);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(secondSocket)).type, "auth.result");
      otherUserSocket = await openSocket(started.data.url);

      const firstAppMessage = waitForSocketMessage(
        firstSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const secondAppMessage = waitForSocketMessage(
        secondSocket,
        (message) => message.type === "app.message" && message.message === "typing",
      );
      const sendResult = waitForSocketMessage(
        firstSocket,
        (message) => message.id === "typing" && message.type === "app.result",
      );

      firstSocket.send(
        JSON.stringify({
          id: "typing",
          type: "app.send",
          message: "typing",
          data: { roomId: "general", active: true },
        }),
      );

      assert.deepEqual(await firstAppMessage, {
        type: "app.message",
        message: "typing",
        data: { roomId: "general", active: true },
      });
      assert.deepEqual(await secondAppMessage, {
        type: "app.message",
        message: "typing",
        data: { roomId: "general", active: true },
      });
      assert.deepEqual(await sendResult, {
        id: "typing",
        type: "app.result",
        message: "typing",
        data: { ok: true, sentToClients: 2 },
        error: null,
      });

      otherUserSocket.send(JSON.stringify({ id: "other-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(otherUserSocket)).type, "auth.result");
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      otherUserSocket?.close();
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

test("server app message handlers can target explicit users", async () => {
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
    whisper: message((ctx, data) => {
      return {
        delivered: ctx.messages.send({
          type: "whisper",
          data: { text: data.text },
          scope: { scope: "users", userIds: data.userIds },
        }),
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let senderSocket;
    let recipientSocket;
    let otherSocket;
    try {
      const started = await waitForJsonLine(child);
      senderSocket = await openSocket(started.data.url);
      recipientSocket = await openSocket(started.data.url);
      otherSocket = await openSocket(started.data.url);

      recipientSocket.send(JSON.stringify({ id: "recipient-auth", type: "auth.get" }));
      const recipientAuth = await readSocketMessage(recipientSocket);

      const recipientMessage = waitForSocketMessage(
        recipientSocket,
        (message) => message.type === "app.message" && message.message === "whisper",
      );
      const senderResult = waitForSocketMessage(
        senderSocket,
        (message) => message.id === "whisper" && message.type === "app.result",
      );

      senderSocket.send(
        JSON.stringify({
          id: "whisper",
          type: "app.send",
          message: "whisper",
          data: { text: "psst", userIds: [recipientAuth.data.auth.userId] },
        }),
      );

      assert.deepEqual(await recipientMessage, {
        type: "app.message",
        message: "whisper",
        data: { text: "psst" },
      });
      assert.deepEqual(await senderResult, {
        id: "whisper",
        type: "app.result",
        message: "whisper",
        data: { delivered: 1 },
        error: null,
      });

      otherSocket.send(JSON.stringify({ id: "other-auth", type: "auth.get" }));
      assert.equal((await readSocketMessage(otherSocket)).type, "auth.result");
    } finally {
      senderSocket?.close();
      recipientSocket?.close();
      otherSocket?.close();
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

test("sporades dev rolls back mutation, hook, and pending ACL writes together", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "rollback-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "rollback-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "rollback-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }).acl({
      insert: async ({ next }) => {
        if (next.text === "deny-fast") {
          return false;
        }
        if (next.text === "allow-slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return next.text !== "denied-pending";
      },
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
    addThenFail: mutation((ctx) => {
      ctx.db.todos.insert({ text: "custom-partial", ownerId: ctx.auth.userId });
      throw Object.assign(new Error("Custom mutation failed."), {
        hint: "Retry the whole mutation.",
      });
    }),
  },

  hooks: {
    beforeMutation: [
      ({ args, ctx }) => {
        if (args[0] === "before-fails") {
          ctx.db.auditLogs.insert({ text: "before-pending", ownerId: ctx.auth.userId });
          throw Object.assign(new Error("Before hook failed."), {
            hint: "Fix the before hook and retry.",
          });
        }
      },
    ],
    afterMutation: [
      ({ args, ctx }) => {
        if (args[0] === "after-fails") {
          ctx.db.auditLogs.insert({ text: "after-pending", ownerId: ctx.auth.userId });
          throw Object.assign(new Error("After hook failed."), {
            hint: "Fix the after hook and retry.",
          });
        }
        if (args[0] === "denied-pending") {
          ctx.db.auditLogs.insert({ text: "denied-pending", ownerId: ctx.auth.userId });
          return;
        }
        if (args[0] === "mixed-pending") {
          ctx.db.auditLogs.insert({ text: "deny-fast", ownerId: ctx.auth.userId });
          ctx.db.auditLogs.insert({ text: "allow-slow", ownerId: ctx.auth.userId });
          return;
        }
        ctx.db.auditLogs.insert({ text: "after:" + args[0], ownerId: ctx.auth.userId });
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

      async function runMutationAndRead(id, mutation, args) {
        const result = waitForSocketMessage(socket, (message) => message.id === id && message.type === "mutation.result");
        socket.send(JSON.stringify({ id, type: "mutation.run", mutation, args }));
        return await result;
      }

      async function dumpedTexts(tableName) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
        assert.equal(dumpResult.code, 0, dumpResult.stderr);
        const tables = JSON.parse(dumpResult.stdout).data.tables;
        return tables.find((table) => table.name === tableName).rows.map((row) => row.text);
      }

      assert.deepEqual(await runMutationAndRead("custom-fail", "addThenFail", []), {
        id: "custom-fail",
        type: "mutation.result",
        mutation: "addThenFail",
        data: null,
        error: {
          message: "Custom mutation failed.",
          hint: "Retry the whole mutation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("before-fail", "addTodo", ["before-fails"]), {
        id: "before-fail",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "Before hook failed.",
          hint: "Fix the before hook and retry.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("after-fail", "addTodo", ["after-fails"]), {
        id: "after-fail",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "After hook failed.",
          hint: "Fix the after hook and retry.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("denied", "addTodo", ["denied-pending"]), {
        id: "denied",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("mixed-pending", "addTodo", ["mixed-pending"]), {
        id: "mixed-pending",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });
      assert.deepEqual(await dumpedTexts("todos"), []);
      assert.deepEqual(await dumpedTexts("auditLogs"), []);

      assert.deepEqual(await runMutationAndRead("retry", "addTodo", ["retry-ok"]), {
        id: "retry",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });
      assert.deepEqual(await dumpedTexts("todos"), ["retry-ok"]);
      assert.deepEqual(await dumpedTexts("auditLogs"), ["after:retry-ok"]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev awaits async mutation handlers and hooks before commit and subscription refresh", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "async-mutation-island",

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
        .orderBy("createdAt", "asc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      ctx.db.todos.insert({ text: text + ":before-await", ownerId: ctx.auth.userId });
      await Promise.resolve();
      ctx.db.todos.insert({ text: text + ":after-await", ownerId: ctx.auth.userId });
      return { inserted: 2 };
    }),
  },

  hooks: {
    beforeMutation: [
      async ({ ctx }) => {
        await Promise.resolve();
        ctx.db.auditLogs.insert({ text: "before-hook", ownerId: ctx.auth.userId });
      },
    ],
    afterMutation: [
      async ({ ctx, result }) => {
        await Promise.resolve();
        const todoCount = ctx.db.todos.where("ownerId", ctx.auth.userId).all().length;
        ctx.db.auditLogs.insert({
          text: "after-hook:" + result.data.inserted + ":" + todoCount,
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

      const mutationResult = waitForSocketMessage(
        socket,
        (message) => message.id === "add" && message.type === "mutation.result",
      );
      const todosRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.type === "query.result" && message.data.length === 2,
      );
      const auditsRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "audits" && message.type === "query.result" && message.data.length === 2,
      );
      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));

      assert.deepEqual(await mutationResult, {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: { inserted: 2 },
        error: null,
      });
      assert.deepEqual(
        (await todosRefresh).data.map((todo) => todo.text),
        ["ship:before-await", "ship:after-await"],
      );
      assert.deepEqual(
        (await auditsRefresh).data.map((audit) => audit.text),
        ["before-hook", "after-hook:2:2"],
      );

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      assert.deepEqual(
        tables.find((table) => table.name === "todos").rows.map((row) => row.text),
        ["ship:before-await", "ship:after-await"],
      );
      assert.deepEqual(
        tables.find((table) => table.name === "auditLogs").rows.map((row) => row.text),
        ["before-hook", "after-hook:2:2"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev processes same-socket WebSocket messages in order around async mutations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "queued-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "queued-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "queued-mutation-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      ctx.db.todos.insert({ text: text + ":before-await", ownerId: ctx.auth.userId });
      await new Promise((resolve) => setTimeout(resolve, 25));
      ctx.db.todos.insert({ text: text + ":after-await", ownerId: ctx.auth.userId });
      return { inserted: 2 };
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
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      const mutationResult = waitForSocketMessage(
        socket,
        (message) => message.id === "add" && message.type === "mutation.result",
      );
      const queryResult = waitForSocketMessage(
        socket,
        (message) => message.id === "todos-after-add" && message.type === "query.result",
      );
      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));
      socket.send(JSON.stringify({ id: "todos-after-add", type: "query.subscribe", query: "todos" }));

      assert.deepEqual(await mutationResult, {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: { inserted: 2 },
        error: null,
      });
      assert.deepEqual(
        (await queryResult).data.map((todo) => todo.text),
        ["ship:before-await", "ship:after-await"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev runs Capsule mutation handlers from the bundled module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bundled-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "bundled-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";

const TODO_PREFIX = "bundled:";

export default capsule({
  name: "bundled-mutation-island",

  schema: {
    todos: table({
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
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({
        text: TODO_PREFIX + text.trim().replace(/\\s+/g, " "),
        ownerId: ctx.auth.userId,
      });
      if (text.trim() === "rollback") {
        throw Object.assign(new Error("No rollback todos."), {
          hint: "Try calmer todo text.",
        });
      }
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
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "record", type: "mutation.run", mutation: "addTodo", args: ["  imported   helper  "] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const refreshed = await readSocketMessage(socket);
      assert.equal(refreshed.id, "todos");
      assert.equal(refreshed.type, "query.result");
      assert.equal(refreshed.error, null);
      assert.deepEqual(
        refreshed.data.map((todo) => todo.text),
        ["bundled:imported helper"],
      );

      socket.send(JSON.stringify({ id: "rollback", type: "mutation.run", mutation: "addTodo", args: ["rollback"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "rollback",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "No rollback todos.",
          hint: "Try calmer todo text.",
        },
      });

      const dumpResult = await runCli(["db", "query", "SELECT text FROM todos ORDER BY createdAt", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      assert.deepEqual(JSON.parse(dumpResult.stdout).data.rows, [{ text: "bundled:imported helper" }]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev runs imported-helper Capsule mutation handlers from the bundled module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "helper-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "helper-mutation-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "todo-text.ts"),
      `export function cleanTodoText(value: string) {
  return "helper:" + value.trim().replace(/\\s+/g, " ");
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";
import { cleanTodoText } from "./todo-text";

export default capsule({
  name: "helper-mutation-island",

  schema: {
    todos: table({
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
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({
        text: cleanTodoText(text),
        ownerId: ctx.auth.userId,
      });
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
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "record", type: "mutation.run", mutation: "addTodo", args: ["  imported   helper  "] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const refreshed = await readSocketMessage(socket);
      assert.equal(refreshed.id, "todos");
      assert.equal(refreshed.type, "query.result");
      assert.equal(refreshed.error, null);
      assert.deepEqual(
        refreshed.data.map((todo) => todo.text),
        ["helper:imported helper"],
      );
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev applies Capsule context middleware to WebSocket requests and endpoints", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "middleware-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "middleware-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "TENANT=blue\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "middleware-island",

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

  middleware: [
    (ctx) => ({
      ...ctx,
      tenant: ctx.env.TENANT,
      order: ["first"],
    }),
    (ctx) => {
      if (ctx.request?.headers["x-block"] === "yes") {
        throw Object.assign(new Error("Request blocked by context middleware."), {
          hint: "Remove x-block and retry the request.",
        });
      }
      ctx.db.auditLogs.insert({
        text: ctx.order.concat("second").join(">") + ":" + ctx.tenant + ":" + ctx.kind,
        ownerId: ctx.auth.userId,
      });
      return {
        ...ctx,
        order: ctx.order.concat("second"),
      };
    },
  ],

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
    afterMutation: [
      ({ ctx }) => {
        ctx.db.auditLogs.insert({
          text: "hook:" + ctx.tenant + ":" + ctx.order.join(">"),
          ownerId: ctx.auth.userId,
        });
      },
    ],
  },

  endpoints: {
    tenant: endpoint({ method: "GET", path: "/tenant" }, (ctx) => ({
      status: 200,
      headers: { "x-order": ctx.order.join(">") },
      body: {
        tenant: ctx.tenant,
        kind: ctx.kind,
      },
    })),
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
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const authResult = await readSocketMessage(socket);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["from middleware"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const endpointResponse = await fetch(`${started.data.url}/tenant`, {
        headers: { "x-sporades-session-token": authResult.data.sessionToken },
      });
      assert.equal(endpointResponse.status, 200);
      assert.equal(endpointResponse.headers.get("x-order"), "first>second");
      assert.deepEqual(await endpointResponse.json(), {
        tenant: "blue",
        kind: "endpoint",
      });

      const blockedResponse = await fetch(`${started.data.url}/tenant`, {
        headers: {
          "x-block": "yes",
          "x-sporades-session-token": authResult.data.sessionToken,
        },
      });
      assert.equal(blockedResponse.status, 500);
      assert.deepEqual(await blockedResponse.json(), {
        ok: false,
        data: null,
        error: {
          message: "Request blocked by context middleware.",
          hint: "Remove x-block and retry the request.",
        },
      });

      socket.send(JSON.stringify({ id: "audits", type: "query.subscribe", query: "auditLogs" }));
      const audits = await readSocketMessage(socket);
      const auditTexts = audits.data.map((row) => row.text);
      assert.ok(auditTexts.includes("first>second:blue:endpoint"));
      assert.ok(auditTexts.includes("first>second:blue:mutation"));
      assert.ok(auditTexts.includes("first>second:blue:query"));
      assert.ok(auditTexts.includes("hook:blue:first>second"));
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev awaits async endpoint handlers and context middleware before writing responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "async-endpoint-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "TENANT=green\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "async-endpoint-island",

  middleware: [
    async (ctx) => {
      await Promise.resolve();
      return { ...ctx, tenant: ctx.env.TENANT };
    },
  ],

  endpoints: {
    tenant: endpoint({ method: "GET", path: "/tenant" }, async (ctx) => {
      await Promise.resolve();
      return {
        status: 202,
        headers: { "x-tenant": ctx.tenant },
        body: {
          tenant: ctx.tenant,
          kind: ctx.kind,
        },
      };
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));

      const response = await fetch(`${started.data.url}/tenant`);
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-tenant"), "green");
      assert.deepEqual(await response.json(), {
        tenant: "green",
        kind: "endpoint",
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("WebSocket auth.get creates a persistent anonymous session token", async () => {
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
    let expiredSocket;
    try {
      const started = await waitForJsonLine(child);
      socket = await openSocket(started.data.url);

      socket.send(JSON.stringify({ id: "auth-1", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      assert.equal(auth.id, "auth-1");
      assert.equal(auth.type, "auth.result");
      assert.equal(auth.error, null);
      assert.equal(typeof auth.data.sessionToken, "string");
      assert.ok(auth.data.sessionToken.length > 20);
      assert.deepEqual(auth.data.auth, {
        userId: auth.data.auth.userId,
        displayName: "Anonymous",
        email: null,
        picture: null,
        isAuthenticated: false,
        isGuest: true,
        provider: "anonymous",
      });
      assert.equal(typeof auth.data.auth.userId, "string");

      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(path.join(projectDir, ".sporades", "data.db"));
      try {
        const storedSession = sqlite
          .prepare("SELECT token, userId, createdAt, expiresAt FROM sporades_auth_sessions WHERE token = ?")
          .get(auth.data.sessionToken);
        assert.equal(storedSession.token, auth.data.sessionToken);
        assert.equal(storedSession.userId, auth.data.auth.userId);
        assert.match(storedSession.createdAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(storedSession.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(Date.parse(storedSession.expiresAt) > Date.now());

        sqlite
          .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?")
          .run("2000-01-01T00:00:00.000Z", auth.data.sessionToken);
      } finally {
        sqlite.close();
      }

      socket.close();
      socket = null;
      expiredSocket = await openSocket(started.data.url, auth.data.sessionToken);
      expiredSocket.send(JSON.stringify({ id: "auth-expired", type: "auth.get" }));
      const refreshedAuth = await readSocketMessage(expiredSocket);
      assert.equal(refreshedAuth.type, "auth.result");
      assert.notEqual(refreshedAuth.data.sessionToken, auth.data.sessionToken);
      assert.notEqual(refreshedAuth.data.auth.userId, auth.data.auth.userId);
      assert.equal(refreshedAuth.data.auth.provider, "anonymous");
    } finally {
      socket?.close();
      expiredSocket?.close();
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

test("WebSocket todo data is isolated by anonymous session token across reconnects", async () => {
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
    let firstSocket;
    let secondSocket;
    let reloadedSocket;
    try {
      const started = await waitForJsonLine(child);
      firstSocket = await openSocket(started.data.url);

      firstSocket.send(JSON.stringify({ id: "first-auth", type: "auth.get" }));
      const firstAuth = await readSocketMessage(firstSocket);
      const firstToken = firstAuth.data.sessionToken;
      const firstUserId = firstAuth.data.auth.userId;

      firstSocket.send(JSON.stringify({ id: "first-query", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(firstSocket)).data, []);

      firstSocket.send(
        JSON.stringify({ id: "first-add", type: "mutation.run", mutation: "addTodo", args: ["First session"] }),
      );
      assert.equal((await readSocketMessage(firstSocket)).type, "mutation.result");
      const firstRefresh = await readSocketMessage(firstSocket);
      assert.deepEqual(
        firstRefresh.data.map((todo) => todo.text),
        ["First session"],
      );

      secondSocket = await openSocket(started.data.url);
      secondSocket.send(JSON.stringify({ id: "second-auth", type: "auth.get" }));
      const secondAuth = await readSocketMessage(secondSocket);
      assert.notEqual(secondAuth.data.sessionToken, firstToken);
      assert.notEqual(secondAuth.data.auth.userId, firstUserId);

      secondSocket.send(JSON.stringify({ id: "second-query", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(secondSocket)).data, []);

      secondSocket.send(
        JSON.stringify({ id: "second-add", type: "mutation.run", mutation: "addTodo", args: ["Second session"] }),
      );
      assert.equal((await readSocketMessage(secondSocket)).type, "mutation.result");
      const secondRefresh = await readSocketMessage(secondSocket);
      assert.deepEqual(
        secondRefresh.data.map((todo) => todo.text),
        ["Second session"],
      );
      firstSocket.close();
      firstSocket = null;
      reloadedSocket = await openSocket(started.data.url, firstToken);
      reloadedSocket.send(JSON.stringify({ id: "reloaded-auth", type: "auth.get" }));
      const reloadedAuth = await readSocketMessage(reloadedSocket);
      assert.equal(reloadedAuth.data.sessionToken, firstToken);
      assert.equal(reloadedAuth.data.auth.userId, firstUserId);

      reloadedSocket.send(JSON.stringify({ id: "reloaded-query", type: "query.subscribe", query: "todos" }));
      const reloadedTodos = await readSocketMessage(reloadedSocket);
      assert.deepEqual(
        reloadedTodos.data.map((todo) => todo.text),
        ["First session"],
      );
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      reloadedSocket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev persists private file uploads across dev session restarts", async () => {
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

    let child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);
      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await readSocketMessage(socket);

      socket.send(
        JSON.stringify({
          id: "upload-url",
          type: "file.uploadUrl",
          file: { name: "hello.txt", type: "text/plain", size: 11 },
        }),
      );
      const uploadUrl = await readSocketMessage(socket);
      assert.equal(uploadUrl.type, "file.uploadUrl.result");
      assert.equal(uploadUrl.error, null);
      assert.equal(uploadUrl.data.file.bucket, "default");
      assert.equal(uploadUrl.data.file.name, "hello.txt");
      assert.equal(uploadUrl.data.file.size, 11);
      assert.equal(uploadUrl.data.file.type, "text/plain");
      assert.equal(uploadUrl.data.file.path, "/default/hello.txt");
      assert.doesNotMatch(uploadUrl.data.file.path, /sessionToken/);
      assert.equal(uploadUrl.data.file.path.includes(auth.data.sessionToken), false);

      const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
        method: uploadUrl.data.method,
        body: "hello world",
      });
      assert.equal(uploadResponse.status, 200);
      const uploaded = await uploadResponse.json();
      assert.equal(uploaded.ok, true);
      assert.equal(uploaded.data.file.id, uploadUrl.data.file.id);

      socket.send(JSON.stringify({ id: "file-url", type: "file.url", fileId: uploaded.data.file.id }));
      const privateUrl = await readSocketMessage(socket);
      assert.equal(privateUrl.error, null);
      assert.match(privateUrl.data.url, /^\/__sporades\/files\/private\//);
      assert.doesNotMatch(privateUrl.data.url, /sessionToken/);
      assert.equal(privateUrl.data.url.includes(auth.data.sessionToken), false);
      assert.doesNotMatch(privateUrl.data.file.path, /sessionToken/);
      assert.equal(privateUrl.data.file.path.includes(auth.data.sessionToken), false);

      const queryTokenUrl = new URL(privateUrl.data.url, started.data.url);
      queryTokenUrl.searchParams.set("sessionToken", auth.data.sessionToken);
      const queryTokenResponse = await fetch(queryTokenUrl);
      assert.equal(queryTokenResponse.status, 404);

      const privateResponse = await fetch(new URL(privateUrl.data.url, started.data.url), {
        headers: { "x-sporades-session-token": auth.data.sessionToken },
      });
      assert.equal(privateResponse.status, 200);
      assert.equal(privateResponse.headers.get("content-type"), "text/plain");
      assert.equal(await privateResponse.text(), "hello world");

      socket.close();
      socket = null;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));

      child = startCli(["dev", "--json"], { cwd: projectDir });
      const restarted = await waitForJsonLine(child);
      const persistedResponse = await fetch(new URL(privateUrl.data.url, restarted.data.url), {
        headers: { "x-sporades-session-token": auth.data.sessionToken },
      });
      assert.equal(persistedResponse.status, 200);
      assert.equal(await persistedResponse.text(), "hello world");
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades dev applies the safe MIME allowlist to private and public file URL responses", async () => {
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
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      socket = await openSocket(started.data.url);

      async function sendAndWait(payload) {
        socket.send(JSON.stringify(payload));
        return await waitForSocketMessage(socket, (message) => message.id === payload.id);
      }

      async function uploadCase(id, file, body) {
        const uploadUrl = await sendAndWait({
          id: `${id}-upload-url`,
          type: "file.uploadUrl",
          file: { ...file, size: Buffer.byteLength(body) },
        });
        assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
          method: uploadUrl.data.method,
          body,
        });
        assert.equal(uploadResponse.status, 200);
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true, uploaded.error?.message);
        return uploaded.data.file;
      }

      const auth = await sendAndWait({ id: "auth", type: "auth.get" });
      const cases = [
        {
          id: "text",
          file: { name: "safe.txt", type: "text/plain", path: "/mime/safe.txt" },
          body: "plain text",
          expectedContentType: "text/plain",
        },
        {
          id: "png",
          file: { name: "safe.png", type: "image/png", path: "/mime/safe.png" },
          body: "png bytes",
          expectedContentType: "image/png",
        },
        {
          id: "html",
          file: { name: "page.html", type: "text/html", path: "/mime/page.html" },
          body: "<script>throw new Error('nope')</script>",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "svg",
          file: { name: "vector.svg", type: "image/svg+xml", path: "/mime/vector.svg" },
          body: "<svg><script>throw new Error('nope')</script></svg>",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "xml",
          file: { name: "feed.xml", type: "application/xml", path: "/mime/feed.xml" },
          body: "<?xml version=\"1.0\"?><feed />",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "missing",
          file: { name: "missing-type.bin", path: "/mime/missing-type.bin" },
          body: "missing type",
          expectedContentType: "application/octet-stream",
        },
        {
          id: "unknown",
          file: { name: "unknown.bin", type: "application/x-unknown", path: "/mime/unknown.bin" },
          body: "unknown type",
          expectedContentType: "application/octet-stream",
        },
      ];

      for (const testCase of cases) {
        const file = await uploadCase(testCase.id, testCase.file, testCase.body);
        const privateUrl = await sendAndWait({
          id: `${testCase.id}-private-url`,
          type: "file.url",
          fileId: file.id,
        });
        assert.equal(privateUrl.error, null);
        const privateRead = await fetch(new URL(privateUrl.data.url, started.data.url), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(privateRead.headers.get("content-type"), testCase.expectedContentType);
        assert.equal(await privateRead.text(), testCase.body);

        const publicUrl = await sendAndWait({
          id: `${testCase.id}-public-url`,
          type: "file.publicUrl.create",
          fileId: file.id,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
        assert.equal(publicRead.status, 200);
        assert.equal(publicRead.headers.get("content-type"), testCase.expectedContentType);
        assert.equal(await publicRead.text(), testCase.body);
      }
    } finally {
      socket?.close();
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

test("sporades dev preserves file lifecycle parity with MinIO-backed storage", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "file-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.services = {
      storage: {
        kind: "storage",
        engine: "minio",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, ".sporades", "services"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "services", "credentials.json"),
      `${JSON.stringify(
        {
          databaseUser: "sporades",
          databasePassword: "sporades",
          storageAccessKey: "sporades",
          storageSecretKey: "sporades-minio-local-secret",
        },
        null,
        2,
      )}\n`,
    );

    await withFakeS3CompatibleService(async ({ port, requests, objects }) => {
      const docker = await installFakeDocker(dir);
      const child = startCli(["dev", "--json"], {
        cwd: projectDir,
        env: { ...docker.env, FAKE_DOCKER_SERVICE_PORT: String(port) },
      });
      let ownerSocket;
      let otherSocket;
      try {
        await waitForJsonLine(child);
        const storageReady = await waitForJsonEvent(
          child,
          (event) => event.data?.event === "service" && event.data.service === "storage" && event.data.status === "ready",
        );
        assert.equal(storageReady.ok, true);
        assert.equal(storageReady.data.port, port);
        const started = await waitForJsonEvent(child, (event) => event.data?.event === "started");
        assert.equal(started.ok, true);

        async function sendAndWait(socket, payload) {
          socket.send(JSON.stringify(payload));
          return await waitForSocketMessage(socket, (message) => message.id === payload.id);
        }

        async function upload(socket, id, file, body) {
          const uploadUrl = await sendAndWait(socket, {
            id: `${id}-upload-url`,
            type: "file.uploadUrl",
            file: { ...file, size: Buffer.byteLength(body) },
          });
          assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
          const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, started.data.url), {
            method: uploadUrl.data.method,
            body,
          });
          assert.equal(uploadResponse.status, 200);
          const uploaded = await uploadResponse.json();
          assert.equal(uploaded.ok, true, uploaded.error?.message);
          return uploaded.data.file;
        }

        ownerSocket = await openSocket(started.data.url);
        const ownerAuth = await sendAndWait(ownerSocket, { id: "owner-auth", type: "auth.get" });
        otherSocket = await openSocket(started.data.url);
        const otherAuth = await sendAndWait(otherSocket, { id: "other-auth", type: "auth.get" });

        const explicitPath = "/docs/reports/2026/q2/proof.txt";
        const first = await upload(
          ownerSocket,
          "first",
          { name: "proof.txt", type: "text/plain", path: explicitPath },
          "minio-one",
        );
        assert.equal(first.bucket, "default");
        assert.equal(first.path, explicitPath);
        assert.equal(first.name, "proof.txt");
        assert.equal(first.type, "text/plain");
        assert.equal(first.size, 9);
        const firstObjectKey = `capsules/file-island/files/${first.id}/${first.version}`;
        assert.equal(objects.get(firstObjectKey).toString("utf8"), "minio-one");

        const byId = await sendAndWait(ownerSocket, { id: "private-by-id", type: "file.url", fileId: first.id });
        assert.equal(byId.error, null);
        const byPath = await sendAndWait(ownerSocket, { id: "private-by-path", type: "file.url", fileReference: explicitPath });
        assert.equal(byPath.error, null);
        assert.equal(byPath.data.file.id, first.id);
        assert.deepEqual(byPath.data.file, byId.data.file);

        const privateRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(privateRead.headers.get("content-type"), "text/plain");
        assert.equal(await privateRead.text(), "minio-one");

        const unauthorizedLookup = await sendAndWait(otherSocket, {
          id: "unauthorized-path",
          type: "file.url",
          fileReference: explicitPath,
        });
        assert.equal(unauthorizedLookup.type, "error");
        assert.equal(unauthorizedLookup.error.message, "File not found.");
        const unauthorizedRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": otherAuth.data.sessionToken },
        });
        assert.equal(unauthorizedRead.status, 404);

        const publicUrl = await sendAndWait(ownerSocket, {
          id: "public-url",
          type: "file.publicUrl.create",
          fileReference: explicitPath,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        assert.equal(publicUrl.data.publicUrl.fileId, first.id);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, started.data.url));
        assert.equal(publicRead.status, 200);
        assert.equal(await publicRead.text(), "minio-one");
        const stalePublicUrl = publicUrl.data.publicUrl.url;

        const overwritten = await upload(
          ownerSocket,
          "overwrite",
          { name: "proof-v2.txt", type: "text/plain", path: explicitPath },
          "minio-two",
        );
        assert.equal(overwritten.id, first.id);
        assert.notEqual(overwritten.version, first.version);
        assert.equal(overwritten.path, explicitPath);
        assert.equal(objects.has(firstObjectKey), false);
        const overwrittenObjectKey = `capsules/file-island/files/${overwritten.id}/${overwritten.version}`;
        assert.equal(objects.get(overwrittenObjectKey).toString("utf8"), "minio-two");

        const stalePrivateRead = await fetch(new URL(byPath.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(stalePrivateRead.status, 404);
        const stalePublicRead = await fetch(new URL(stalePublicUrl, started.data.url));
        assert.equal(stalePublicRead.status, 404);

        const nextPrivate = await sendAndWait(ownerSocket, { id: "next-private", type: "file.url", fileReference: explicitPath });
        assert.equal(nextPrivate.error, null);
        assert.equal(nextPrivate.data.file.version, overwritten.version);
        const nextRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(nextRead.status, 200);
        assert.equal(await nextRead.text(), "minio-two");

        const revokedPublicUrl = await sendAndWait(ownerSocket, {
          id: "public-url-next",
          type: "file.publicUrl.create",
          fileId: overwritten.id,
          options: { noExpiry: true },
        });
        assert.equal(revokedPublicUrl.error, null);
        const revoke = await sendAndWait(ownerSocket, {
          id: "revoke-public",
          type: "file.publicUrl.revoke",
          publicUrlId: revokedPublicUrl.data.publicUrl.id,
        });
        assert.equal(revoke.error, null);
        const revokedRead = await fetch(new URL(revokedPublicUrl.data.publicUrl.url, started.data.url));
        assert.equal(revokedRead.status, 404);

        const defaultNamed = await upload(ownerSocket, "default-named", { name: "readme.txt", type: "text/plain" }, "named");
        assert.equal(defaultNamed.path, "/default/readme.txt");

        const deleted = await sendAndWait(ownerSocket, { id: "delete-by-path", type: "file.delete", fileReference: explicitPath });
        assert.equal(deleted.error, null);
        assert.equal(deleted.data.file.id, overwritten.id);
        assert.equal(objects.has(overwrittenObjectKey), false);
        const deletedRead = await fetch(new URL(nextPrivate.data.url, started.data.url), {
          headers: { "x-sporades-session-token": ownerAuth.data.sessionToken },
        });
        assert.equal(deletedRead.status, 404);

        const recreated = await upload(
          ownerSocket,
          "recreated",
          { name: "proof.txt", type: "text/plain", path: explicitPath },
          "minio-new",
        );
        assert.notEqual(recreated.id, overwritten.id);
        assert.equal(recreated.path, explicitPath);

        const expiredPublicUrl = await sendAndWait(ownerSocket, {
          id: "expired-public",
          type: "file.publicUrl.create",
          fileReference: explicitPath,
          options: { expires: "2020-01-01T00:00:00.000Z" },
        });
        assert.equal(expiredPublicUrl.error, null);
        const expiredRead = await fetch(new URL(expiredPublicUrl.data.publicUrl.url, started.data.url));
        assert.equal(expiredRead.status, 404);

        const missingDirect = await fetch(new URL(`/__sporades/files/public/missing-public?v=${recreated.version}`, started.data.url));
        assert.equal(missingDirect.status, 404);
        assert(
          requests.some(
            (request) =>
              request.method === "PUT" &&
              request.url === `/sporades-files/capsules/file-island/files/${recreated.id}/${recreated.version}`,
          ),
          JSON.stringify(requests.map((request) => [request.method, request.url])),
        );

        const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
        const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
        assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENDPOINT"/);
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);
      } finally {
        ownerSocket?.close();
        otherSocket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

async function openSocket(baseUrl, sessionToken = null) {
  const connectionToken = await readPageConnectionToken(baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = new WebSocket(url);
    installSessionTokenEnvelope(socket, sessionToken);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function readPageConnectionToken(baseUrl) {
  const response = await fetch(new URL("/", baseUrl));
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, "Expected served page to include a Sporades connection token.");
  return match[1];
}

function readWebSocketUpgradeResponse(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket handshake response."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      cleanup();
      socket.destroy();
      resolve(buffer.subarray(0, marker).toString("utf8"));
    }

    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${url.pathname} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

function installSessionTokenEnvelope(socket, sessionToken) {
  if (!sessionToken) return;
  const send = socket.send.bind(socket);
  socket.send = (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage);
      if (message && typeof message === "object" && !message.sessionToken) {
        send(JSON.stringify({ ...message, sessionToken }));
        return;
      }
    } catch {
      // Fall through to the original payload for non-JSON test frames.
    }
    send(rawMessage);
  };
}

async function openSocketWithHeaders(baseUrl, headers = {}) {
  const connectionToken = await readPageConnectionToken(baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = connect(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out opening raw WebSocket."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onHandshakeData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onHandshakeData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      const response = buffer.subarray(0, marker).toString("utf8");
      if (!response.startsWith("HTTP/1.1 101")) {
        cleanup();
        socket.destroy();
        reject(new Error(`Unexpected WebSocket handshake response: ${response}`));
        return;
      }
      const remaining = buffer.subarray(marker + 4);
      buffer = remaining;
      cleanup();
      resolve({
        sendJson(payload) {
          socket.write(encodeClientWebSocketFrame(JSON.stringify(payload)));
        },
        sendCloseFrame() {
          socket.write(encodeClientWebSocketCloseFrame());
        },
        readJson() {
          return readRawWebSocketJson(socket, buffer);
        },
        waitForClose() {
          return waitForRawSocketClose(socket);
        },
        close() {
          socket.end();
        },
        destroy() {
          socket.destroy();
        },
      });
    }

    socket.on("error", onError);
    socket.on("data", onHandshakeData);
    socket.on("connect", () => {
      const requestHeaders = {
        host: url.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...headers,
      };
      socket.write(
        [`GET ${url.pathname}${url.search} HTTP/1.1`, ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`), "", ""].join(
          "\r\n",
        ),
      );
    });
  });
}

function encodeClientWebSocketFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])]);
  const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    encoded[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, encoded]);
}

function encodeClientWebSocketCloseFrame() {
  const mask = randomBytes(4);
  return Buffer.from([0x88, 0x80, ...mask]);
}

function readRawWebSocketJson(socket, initialBuffer = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buffer = initialBuffer;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raw WebSocket message."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const lengthCode = buffer[1] & 0x7f;
      let offset = 2;
      let length = lengthCode;
      if (lengthCode === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (lengthCode === 127) {
        cleanup();
        reject(new Error("Raw WebSocket helper only supports 16-bit message lengths."));
        return;
      }
      if (buffer.length < offset + length) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")));
    }

    socket.on("data", onData);
    socket.on("error", onError);
    onData(Buffer.alloc(0));
  });
}

function waitForRawSocketClose(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raw WebSocket close."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
    }
    function onClose() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function readSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }
    function onMessage(event) {
      cleanup();
      resolve(JSON.parse(event.data));
    }
    function onError(event) {
      cleanup();
      reject(event.error ?? new Error("WebSocket failed."));
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function waitForSocketClose(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    }
    function onClose() {
      cleanup();
      resolve();
    }
    function onError(event) {
      cleanup();
      reject(event.error ?? new Error("WebSocket failed."));
    }

    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function openWebSocket(url) {
  const webSocketUrl = new URL(url);
  const pageBaseUrl = new URL(url);
  pageBaseUrl.protocol = pageBaseUrl.protocol === "wss:" ? "https:" : "http:";
  pageBaseUrl.pathname = "/";
  pageBaseUrl.search = "";
  webSocketUrl.searchParams.set("connectionToken", await readPageConnectionToken(pageBaseUrl));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}

function waitForSocketMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    }
    function onError() {
      cleanup();
      reject(new Error("WebSocket error"));
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

test("sporades dev runs todo queries and mutations over WebSocket", async () => {
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
      socket = await openWebSocket(started.data.url.replace("http://", "ws://") + "/__sporades/ws");

      socket.send(JSON.stringify({ id: "q1", type: "query.subscribe", name: "todos" }));
      const emptyResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "query.result" && message.id === "q1",
      );
      assert.deepEqual(emptyResult.data.rows, []);

      socket.send(JSON.stringify({ id: "m1", type: "mutation.run", name: "addTodo", args: ["Buy milk"] }));
      const mutationResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "mutation.result" && message.id === "m1",
      );
      assert.deepEqual(mutationResult, { id: "m1", type: "mutation.result", ok: true, data: null, error: null });

      const refreshedResult = await waitForSocketMessage(
        socket,
        (message) => message.type === "query.result" && message.id === "q1" && message.data.rows.length === 1,
      );
      assert.equal(refreshedResult.data.rows[0].text, "Buy milk");
      assert.equal(refreshedResult.data.rows[0].done, false);
      assert.equal(typeof refreshedResult.data.rows[0].id, "string");
      assert.equal(typeof refreshedResult.data.rows[0].createdAt, "string");
      assert.equal(typeof refreshedResult.data.rows[0].updatedAt, "string");

      const dumpResult = await runCli(["db", "query", "SELECT text, done FROM todos", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      assert.deepEqual(JSON.parse(dumpResult.stdout).data.rows, [{ text: "Buy milk", done: 0 }]);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
