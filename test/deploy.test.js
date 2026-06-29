import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-deploy-"));
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

async function installFakeDocker(dir, containerId = "container-new", options = {}) {
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
const missingContainerActions = new Set((process.env.FAKE_DOCKER_MISSING_CONTAINER_ACTIONS ?? "").split(",").filter(Boolean));
if (missingContainerActions.has(call.args[0])) {
  process.stderr.write("Error response from daemon: No such container: " + call.args[1] + "\\n");
  process.exit(1);
}
if (call.args[0] === "run") {
  process.stdout.write(process.env.FAKE_DOCKER_CONTAINER_ID + "\\n");
}
`,
  );
  await chmod(dockerPath, 0o755);

  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_CONTAINER_ID: containerId,
      FAKE_DOCKER_MISSING_CONTAINER_ACTIONS: options.missingContainerActions?.join(",") ?? "",
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

function assertVolume(args, mount) {
  assert(args.includes(mount), `Expected docker args to include volume: ${mount}\n${args.join(" ")}`);
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
  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "container-access-token", token_type: "Bearer" }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/userinfo") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          email: "mira@example.com",
          name: "Mira",
          picture: "https://example.com/mira.png",
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
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 5000;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server bundle exited before serving ${url}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw lastError;
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await closed;
}

test("sporades deploy --json bundles and starts a container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: true,
      data: {
        url: "http://localhost:4321",
        port: 4321,
        containerId: "container-first",
      },
      error: null,
    });

    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(serverBundle, /todo-island/);
    assert.match(clientBundle, /Sporades Todos/);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.deepEqual(binding, {
      containerId: "container-first",
      containerName: "sporades-todo-island",
    });

    const [runCall] = await docker.calls();
    assert.equal(runCall.cwd, projectDir);
    assert.equal(runCall.args[0], "run");
    assert(runCall.args.includes("--detach"));
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-todo-island");
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "4321:4000");
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", "server.mjs")}:/app/server.mjs:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", "client.js")}:/app/client.js:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, "index.html")}:/app/index.html:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, "sporades.json")}:/app/sporades.json:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`);
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(projectDir, ".env.sporades.server"));
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "data")}:/app/data`);
    const imageIndex = runCall.args.indexOf("node:22-alpine");
    assert(imageIndex > -1);
    assert.deepEqual(runCall.args.slice(imageIndex), ["node:22-alpine", "node", "/app/server.mjs"]);
  });
});

test("sporades deploy writes a server bundle that serves the capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const rootResponse = await waitForHttp(`http://127.0.0.1:${port}/`, child);
      assert.match(await rootResponse.text(), /<div id="app"><\/div>/);
      const clientResponse = await waitForHttp(`http://127.0.0.1:${port}/client.js`, child);
      assert.match(await clientResponse.text(), /Sporades Todos/);
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that serves registered capsule endpoints", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
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
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/ping`, { method: "POST" });
      assert.equal(endpointResponse.status, 200);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await endpointResponse.text(), "pong");

      const missResponse = await fetch(`http://127.0.0.1:${port}/integrations/ping`);
      assert.equal(missResponse.status, 404);
      assert.equal(await missResponse.text(), "Not found");
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that applies additive table migrations on Container session startup", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const databasePath = path.join(projectDir, ".sporades", "data", "data.db");
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const firstPort = await getAvailablePort();
    const firstServer = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(firstPort),
        SPORADES_DATABASE_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let firstSocket;
    let secondSocket;
    try {
      await waitForHttp(`http://127.0.0.1:${firstPort}/`, firstServer);
      firstSocket = await openSocket(`http://127.0.0.1:${firstPort}`);
      firstSocket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(firstSocket)).data.sessionToken;
      firstSocket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(firstSocket)).data, []);
      firstSocket.send(
        JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Container keeps me"] }),
      );
      assert.equal((await readSocketMessage(firstSocket)).type, "mutation.result");
      assert.deepEqual(
        (await readSocketMessage(firstSocket)).data.map((todo) => todo.text),
        ["Container keeps me"],
      );
      firstSocket.close();
      firstSocket = null;
      await stopChild(firstServer);

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

      const redeployResult = await runCli(["deploy", "--force", "--json"], {
        cwd: projectDir,
        env: {
          ...docker.env,
          FAKE_DOCKER_CONTAINER_ID: "container-second",
          FAKE_DOCKER_MISSING_CONTAINER_ACTIONS: "stop,rm",
        },
      });
      assert.equal(redeployResult.code, 0, redeployResult.stderr);

      const secondPort = await getAvailablePort();
      const secondServer = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(secondPort),
          SPORADES_DATABASE_PATH: databasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForHttp(`http://127.0.0.1:${secondPort}/`, secondServer);
        secondSocket = await openSocket(`http://127.0.0.1:${secondPort}`, sessionToken);
        secondSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
        assert.deepEqual(
          (await readSocketMessage(secondSocket)).data.map((todo) => todo.text),
          ["Container keeps me"],
        );
        secondSocket.send(JSON.stringify({ id: "notes-before", type: "query.subscribe", query: "notes" }));
        assert.deepEqual((await readSocketMessage(secondSocket)).data, []);
        secondSocket.send(
          JSON.stringify({
            id: "add-note",
            type: "mutation.run",
            mutation: "addNote",
            args: ["Container new table works"],
          }),
        );
        assert.equal((await readSocketMessage(secondSocket)).type, "mutation.result");
        const notesAfter = await waitForSocketMessage(
          secondSocket,
          (message) =>
            message.id === "notes-before" &&
            message.type === "query.result" &&
            message.query === "notes" &&
            message.data.length === 1,
        );
        assert.equal(notesAfter.data[0].text, "Container new table works");
      } finally {
        secondSocket?.close();
        await stopChild(secondServer);
      }
    } finally {
      firstSocket?.close();
      await stopChild(firstServer);
    }
  });
});

test("sporades deploy writes a server bundle with endpoint context and structured responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=container-secret\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 202,
      headers: { "x-sporades-endpoint": ctx.env.WEBHOOK_SECRET },
      body: {
        method: ctx.request.method,
        path: ctx.request.path,
        header: ctx.request.headers["x-source"],
        query: ctx.request.query.source,
        body: ctx.request.body,
        authProvider: ctx.auth.provider,
      },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/echo?source=test-suite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "integration",
        },
        body: JSON.stringify({ hello: "container" }),
      });
      assert.equal(endpointResponse.status, 202);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(endpointResponse.headers.get("x-sporades-endpoint"), "container-secret");
      assert.deepEqual(await endpointResponse.json(), {
        method: "POST",
        path: "/integrations/echo",
        header: "integration",
        query: "test-suite",
        body: { hello: "container" },
        authProvider: "anonymous",
      });
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy endpoints resolve linked Google auth from the Sporades session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
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
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    const docker = await installFakeDocker(dir, "container-google-auth");

    await withFakeGoogleServer(async (google) => {
      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr);

      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_USERINFO_URL: google.userInfoUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;

        socket.send(JSON.stringify({ id: "signin", type: "auth.signIn", provider: "google", returnTo: `http://127.0.0.1:${port}/integrations/auth` }));
        const signIn = await readSocketMessage(socket);
        const signInUrl = new URL(signIn.data.url);
        const callbackResponse = await fetch(
          `http://127.0.0.1:${port}/__sporades/auth/google/callback?code=container-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302);

        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
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

        const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/auth`, {
          headers: { "x-sporades-session-token": anonymousAuth.data.sessionToken },
        });
        const endpointBody = await endpointResponse.json();
        assert.equal(endpointResponse.status, 200, JSON.stringify(endpointBody));
        assert.deepEqual(endpointBody, linkedAuth.data.auth);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});

test("sporades deploy skips the server env mount when the env file is absent", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"));
    const docker = await installFakeDocker(dir, "container-no-env");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const [runCall] = await docker.calls();
    assert.equal(runCall.args.includes("--env-file"), false);
    assert.equal(
      runCall.args.includes(`${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`),
      false,
    );
  });
});

test("sporades deploy replaces the existing container binding before starting a new one", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "binding.json"),
      `${JSON.stringify({ containerId: "container-old", containerName: "sporades-todo-island" }, null, 2)}\n`,
    );
    const docker = await installFakeDocker(dir, "container-replacement");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-replacement");

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["stop", "container-old"],
        ["rm", "container-old"],
        calls[2].args,
      ],
    );
    assert.equal(calls[2].args[0], "run");

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.deepEqual(binding, {
      containerId: "container-replacement",
      containerName: "sporades-todo-island",
    });
  });
});

test("sporades deploy --force ignores stale container bindings when the container was deleted manually", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "binding.json"),
      `${JSON.stringify({ containerId: "container-deleted", containerName: "sporades-todo-island" }, null, 2)}\n`,
    );
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingContainerActions: ["stop", "rm"],
    });

    const deployResult = await runCli(["deploy", "--force", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-replacement");

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["stop", "rm", "run"],
    );

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.deepEqual(binding, {
      containerId: "container-replacement",
      containerName: "sporades-todo-island",
    });
  });
});

test("sporades deploy fails on stale container bindings without --force", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "binding.json"),
      `${JSON.stringify({ containerId: "container-deleted", containerName: "sporades-todo-island" }, null, 2)}\n`,
    );
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingContainerActions: ["stop"],
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to stop the existing container session.",
        hint: "Check Docker is running. If the bound container was deleted manually, retry with `sporades deploy --force`.",
      },
    });

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["stop"],
    );
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
