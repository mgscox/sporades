import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
          hint: "Only adding new tables is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
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

test("Google auth links to the current anonymous account and keeps owned todos visible", async () => {
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

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
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

      socket.send(JSON.stringify({ id: "signin-1", type: "auth.signInWithGoogle" }));
      const signIn = await readSocketMessage(socket);
      assert.equal(signIn.id, "signin-1");
      assert.equal(signIn.type, "auth.redirect");
      assert.match(signIn.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
      assert.doesNotMatch(signIn.data.url, /client-secret/);

      socket.send(
        JSON.stringify({
          id: "complete-1",
          type: "auth.completeGoogleSignIn",
          profile: {
            email: "mira@example.com",
            displayName: "Mira",
            picture: "https://example.com/mira.png",
          },
        }),
      );
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
          tables: ["sporades", "sporades_auth_sessions", "sporades_auth_users", "todos"],
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
                { key: "schemaVersion", value: "v1:additive-tables" },
                { key: "schemaHash", value: "71a20803ea953152096eea819b23296357aa0f92317215685136640caac64904" },
                {
                  key: "schema",
                  value:
                    '{"tables":[{"name":"todos","fields":[{"name":"text","kind":"String","sqliteType":"TEXT"},{"name":"done","kind":"Boolean","sqliteType":"INTEGER","defaultValue":false},{"name":"ownerId","kind":"String","sqliteType":"TEXT"}]}]}',
                },
              ],
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
