import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

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

async function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

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
    }, 5000);

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
    }, 5000);

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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev routes registered capsule endpoints and preserves non-matching HTTP behavior", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev gives endpoint handlers request context and structured responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev returns structured errors for invalid endpoint responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "endpoint-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev streams rebuild failure events and keeps serving the last client bundle", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev restarts server runtime and accepts new WebSocket connections after rebuild", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev applies additive field migrations without losing existing Capsule data", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

      migratedSocket.send(
        JSON.stringify({
          id: "add-after",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["New field works", false, "urgent", "first note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const insertedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.length === 2,
      );
      assert.equal(insertedRows.data[0].text, "New field works");
      assert.equal(insertedRows.data[0].priority, "urgent");
      assert.equal(insertedRows.data[0].note, "first note");

      migratedSocket.send(
        JSON.stringify({
          id: "update-note",
          type: "mutation.run",
          mutation: "updateTodoNote",
          args: [insertedRows.data[0].id, "edited note"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const updatedRows = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data[0]?.note === "edited note",
      );
      assert.equal(updatedRows.data[0].priority, "urgent");

      const dumpResult = await runCli(["db", "dump", "--json"], { cwd: projectDir });
      assert.equal(dumpResult.code, 0, dumpResult.stderr);
      const tables = JSON.parse(dumpResult.stdout).data.tables;
      const todosTable = tables.find((table) => table.name === "todos");
      assert.deepEqual(todosTable.columns, ["id", "createdAt", "updatedAt", "text", "done", "ownerId", "priority", "note"]);
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
      dueAt: Date().default("2026-01-02T03:04:05.000Z"),
      reminderAt: Date(),`,
          )
          .replace(
            "queries: {",
            `endpoints: {
    dueTodos: endpoint({ method: "GET", path: "/due-todos" }, (ctx) => ({
      body: ctx.db.todos.where("dueAt", ctx.request.query.dueAt).orderBy("reminderAt", "asc").all()
    })),
  },

  queries: {`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `updateTodoDueAt: mutation((ctx, id: string, dueAt: string) => {
      ctx.db.todos.update(id, { dueAt });
    }),

    addTodo: mutation((ctx, text: string, done: boolean, dueAt: string, reminderAt: string) => {`,
          )
          .replace(
            "ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });",
            "ctx.db.todos.insert({ text, done, dueAt, reminderAt, ownerId: ctx.auth.userId });",
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

      migratedSocket.send(
        JSON.stringify({
          id: "add-first",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["First date", false, "2026-03-01T10:00:00.000Z", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "First date"),
      );

      migratedSocket.send(
        JSON.stringify({
          id: "add-second",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Second date", false, "2026-03-01T10:00:00.000Z", "2026-01-15T09:00:00.000Z"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      const rowsWithSecond = await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Second date"),
      );
      const firstDateRow = rowsWithSecond.data.find((todo) => todo.text === "First date");
      assert.equal(firstDateRow.dueAt, "2026-03-01T10:00:00.000Z");

      migratedSocket.send(
        JSON.stringify({
          id: "update-date",
          type: "mutation.run",
          mutation: "updateTodoDueAt",
          args: [firstDateRow.id, "2026-04-01T12:30:00.000Z"],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).type, "mutation.result");
      await waitForSocketMessage(
        migratedSocket,
        (message) =>
          message.id === "todos-after" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.find((todo) => todo.id === firstDateRow.id)?.dueAt === "2026-04-01T12:30:00.000Z",
      );

      migratedSocket.send(
        JSON.stringify({
          id: "invalid-date",
          type: "mutation.run",
          mutation: "addTodo",
          args: ["Bad date", false, "not-a-date", "2026-02-01T09:00:00.000Z"],
        }),
      );
      assert.deepEqual(await readSocketMessage(migratedSocket), {
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
      assert.equal(endpointRows[0].reminderAt, "2026-01-15T09:00:00.000Z");

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
        "ownerId",
        "dueAt",
        "reminderAt",
      ]);
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").dueAt, "2026-01-02T03:04:05.000Z");
      assert.equal(todosTable.rows.find((row) => row.text === "Keep me").reminderAt, null);
      assert.equal(todosTable.rows.find((row) => row.text === "First date").dueAt, "2026-04-01T12:30:00.000Z");
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

test("sporades dev preserves Json field values through endpoints and WebSocket queries", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "json-island", "--no-install", "--no-git", "--json"], {
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
      const sessionToken = (await readSocketMessage(socket)).data.sessionToken;

      const seedResponse = await fetch(`${started.data.url}/seed?sessionToken=${encodeURIComponent(sessionToken)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        const response = await fetch(`${started.data.url}/seed?sessionToken=${encodeURIComponent(sessionToken)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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
      const afterDefault = await waitForSocketMessage(
        socket,
        (message) => message.id === "notes-1" && message.type === "query.result" && message.data.length === 7,
      );
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
      migratedSocket.send(
        JSON.stringify({
          id: "update-meta",
          type: "mutation.run",
          mutation: "updateTodoMeta",
          args: [migratedRows.data[0].id, updatedMeta],
        }),
      );
      assert.equal((await readSocketMessage(migratedSocket)).error, null);
      const updatedRows = await waitForSocketMessage(
        migratedSocket,
        (message) => message.id === "todos-after" && message.data[0]?.meta?.nested?.count === 1,
      );
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
    const createResult = await runCli(["create", "library", "--no-install", "--no-git", "--json"], {
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
      socket.send(JSON.stringify({ id: "add-ada", type: "mutation.run", mutation: "addUser", args: ["Ada"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterAda = await readSocketMessage(socket);
      const adaId = usersAfterAda.data[0].id;
      assert.equal(usersAfterAda.data[0].name, "Ada");

      socket.send(JSON.stringify({ id: "posts", type: "query.subscribe", query: "posts" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(
        JSON.stringify({ id: "add-post", type: "mutation.run", mutation: "addPost", args: ["Notes on engines", adaId] }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterInsert = await waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data.length === 1,
      );
      assert.equal(postsAfterInsert.data[0].authorId, adaId);

      const byAuthorResponse = await fetch(`${started.data.url}/posts/by-author?authorId=${adaId}`);
      assert.equal(byAuthorResponse.status, 200);
      const postsByAuthor = await byAuthorResponse.json();
      assert.equal(postsByAuthor[0].text, "Notes on engines");
      assert.equal(postsByAuthor[0].authorId, adaId);

      socket.send(JSON.stringify({ id: "add-grace", type: "mutation.run", mutation: "addUser", args: ["Grace"] }));
      assert.equal((await readSocketMessage(socket)).error, null);
      const usersAfterGrace = await waitForSocketMessage(
        socket,
        (message) => message.id === "users" && message.type === "query.result" && message.data.length === 2,
      );
      const graceId = usersAfterGrace.data.find((user) => user.name === "Grace").id;

      socket.send(
        JSON.stringify({
          id: "update-author",
          type: "mutation.run",
          mutation: "updatePostAuthorId",
          args: [postsAfterInsert.data[0].id, graceId],
        }),
      );
      assert.equal((await readSocketMessage(socket)).error, null);
      const postsAfterUpdate = await waitForSocketMessage(
        socket,
        (message) => message.id === "posts" && message.type === "query.result" && message.data[0]?.authorId === graceId,
      );
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
      assert.deepEqual(postsTable.columns, ["id", "createdAt", "updatedAt", "text", "authorId", "ownerId", "editorId"]);
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

test("sporades dev rejects unsupported Capsule schema changes with a structured rebuild error", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
        hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>`.",
      },
    });
  });
});

test("Google auth callback exchanges the code server-side and links the current anonymous account", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
        assert.deepEqual(linked.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });

        socket.send(JSON.stringify({ id: "query-2", type: "query.subscribe", query: "todos" }));
        const todosAfterLink = await readSocketMessage(socket);
        assert.deepEqual(
          todosAfterLink.data.map((todo) => todo.text),
          ["Keep me"],
        );
      } finally {
        socket?.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    });
  });
});

test("sporades logs returns captured ctx.log entries from the running dev session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

      const ctxResponse = await fetch(`${started.data.url}/__sporades/debug/ctx-log`, { method: "POST" });
      assert.equal(ctxResponse.status, 200);
      assert.deepEqual(await ctxResponse.json(), {
        ok: true,
        data: { log: ["info", "warn", "error"] },
        error: null,
      });

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      assert.equal(logs.error, null);
      const ctxLog = logs.data.entries.find((entry) => entry.message === "ctx.log is available");
      assert.equal(ctxLog.level, "info");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades db list returns tables from the running dev session database", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

      const listResult = await runCli(["db", "list", "--json"], { cwd: projectDir });
      assert.equal(listResult.code, 0, listResult.stderr);
      assert.deepEqual(JSON.parse(listResult.stdout), {
        ok: true,
        data: {
          tables: ["sporades", "sporades_auth_oauth_states", "sporades_auth_sessions", "sporades_auth_users", "todos"],
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
              columns: ["token", "userId", "createdAt"],
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
            { name: "todos" },
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

test("sporades db query rejects write SQL with a structured hint", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
          hint: "Use a SELECT, WITH, or PRAGMA query for `sporades db query`.",
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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev runs Capsule pre and post mutation hooks around WebSocket mutations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "hook-island", "--no-install", "--no-git", "--json"], {
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

test("sporades dev applies Capsule context middleware to WebSocket requests and endpoints", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "middleware-island", "--no-install", "--no-git", "--json"], {
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

test("WebSocket auth.get creates a persistent anonymous session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("WebSocket todo data is isolated by anonymous session token across reconnects", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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

function openSocket(baseUrl, sessionToken = null) {
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    if (sessionToken) {
      url.searchParams.set("sessionToken", sessionToken);
    }
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

function readSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message."));
    }, 5000);

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
    }, 5000);

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

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}

function waitForSocketMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 5000);

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
    const createResult = await runCli(["create", "todo-island", "--no-install", "--no-git", "--json"], {
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
