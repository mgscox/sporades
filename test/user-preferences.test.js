import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-user-preferences-"));
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

async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)));
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

function waitForSocketMessage(socket, predicate, timeoutMs = TEST_WEBSOCKET_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message."));
    }, timeoutMs);

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
    function onError(event) {
      cleanup();
      reject(event.error ?? new Error("WebSocket failed."));
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function sendAndWait(socket, payload) {
  const pending = waitForSocketMessage(socket, (message) => message.id === payload.id);
  socket.send(JSON.stringify(payload));
  return pending;
}

async function stopDevSession(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("current-user preferences persist through the client transport and runtime restart", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "preferences-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "preferences-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { String, capsule, query, table } from "sporades/server";

export default capsule({
  name: "preferences-island",
  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },
  queries: {
    appTables: query((ctx) => Object.keys(ctx.db).sort()),
  },
});
`,
    );
    await installFakeReact(projectDir);

    let child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    let otherSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      const authResult = await sendAndWait(socket, { id: "auth", type: "auth.get" });
      assert.equal(authResult.error, null);
      const sessionToken = authResult.data.sessionToken;
      assert.equal(typeof sessionToken, "string");

      assert.deepEqual(await sendAndWait(socket, { id: "initial", type: "preferences.get" }), {
        id: "initial",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "update-theme", type: "preferences.update", patch: { theme: "dark" } }), {
        id: "update-theme",
        type: "preferences.result",
        data: { preferences: { theme: "dark" } },
        error: null,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "update-density", type: "preferences.update", patch: { density: "compact" } }), {
        id: "update-density",
        type: "preferences.result",
        data: { preferences: { theme: "dark", density: "compact" } },
        error: null,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "bad-update", type: "preferences.update", patch: null }), {
        id: "bad-update",
        type: "error",
        data: null,
        error: {
          code: "INVALID_PREFERENCES_PATCH",
          message: "Preferences updates must be JSON objects.",
          hint: "Pass a plain JSON object to preferences.update().",
        },
      });

      otherSocket = await openSocket(started.data.url);
      assert.deepEqual(await sendAndWait(otherSocket, { id: "other-preferences", type: "preferences.get" }), {
        id: "other-preferences",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });

      const appTables = await sendAndWait(socket, { id: "app-tables", type: "query.subscribe", query: "appTables" });
      assert.deepEqual(appTables.data, ["notes"]);

      socket.close();
      otherSocket.close();
      await stopDevSession(child);

      child = startCli(["dev", "--json"], { cwd: projectDir });
      const restarted = await waitForJsonLine(child);
      assert.equal(restarted.ok, true, JSON.stringify(restarted));
      socket = await openSocket(restarted.data.url, sessionToken);

      assert.deepEqual(await sendAndWait(socket, { id: "after-restart", type: "preferences.get" }), {
        id: "after-restart",
        type: "preferences.result",
        data: { preferences: { theme: "dark", density: "compact" } },
        error: null,
      });
    } finally {
      socket?.close();
      otherSocket?.close();
      await stopDevSession(child);
    }
  });
});

test("current-user preference updates notify connected clients for the same user", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "preferences-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "preferences-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let primarySocket;
    let sameUserSocket;
    let differentUserSocket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));

      primarySocket = await openSocket(started.data.url);
      const authResult = await sendAndWait(primarySocket, { id: "auth", type: "auth.get" });
      assert.equal(authResult.error, null);

      sameUserSocket = await openSocket(started.data.url, authResult.data.sessionToken);
      differentUserSocket = await openSocket(started.data.url);
      assert.deepEqual(await sendAndWait(sameUserSocket, { id: "same-user-initial", type: "preferences.get" }), {
        id: "same-user-initial",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });

      const observedUpdate = waitForSocketMessage(
        sameUserSocket,
        (message) => message.type === "preferences.updated",
        1000,
      );
      const unexpectedDifferentUserUpdate = waitForSocketMessage(
        differentUserSocket,
        (message) => message.type === "preferences.updated",
        150,
      );
      assert.deepEqual(await sendAndWait(primarySocket, { id: "update-theme", type: "preferences.update", patch: { theme: "solarized" } }), {
        id: "update-theme",
        type: "preferences.result",
        data: { preferences: { theme: "solarized" } },
        error: null,
      });

      assert.deepEqual(await observedUpdate, {
        id: null,
        type: "preferences.updated",
        data: { preferences: { theme: "solarized" } },
        error: null,
      });
      await assert.rejects(unexpectedDifferentUserUpdate, /Timed out waiting for WebSocket message/);
      assert.deepEqual(await sendAndWait(differentUserSocket, { id: "different-user-preferences", type: "preferences.get" }), {
        id: "different-user-preferences",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });
    } finally {
      primarySocket?.close();
      sameUserSocket?.close();
      differentUserSocket?.close();
      await stopDevSession(child);
    }
  });
});

test("current-user preferences follow anonymous email linking and later sign-in", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "preferences-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "preferences-island");
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
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      const initialAuth = await sendAndWait(socket, { id: "auth-initial", type: "auth.get" });
      assert.equal(initialAuth.error, null);
      assert.equal(initialAuth.data.auth.provider, "anonymous");

      assert.deepEqual(await sendAndWait(socket, { id: "anonymous-prefs", type: "preferences.update", patch: { theme: "amber" } }), {
        id: "anonymous-prefs",
        type: "preferences.result",
        data: { preferences: { theme: "amber" } },
        error: null,
      });

      const signUp = await sendAndWait(socket, {
        id: "signup",
        type: "auth.signUp",
        provider: "email",
        credentials: {
          email: "mira@example.com",
          password: "correct horse battery staple",
          name: "Mira",
        },
      });
      assert.equal(signUp.type, "auth.signUp.result");
      assert.equal(signUp.error, null);
      assert.equal(signUp.data.auth.userId, initialAuth.data.auth.userId);
      assert.equal(signUp.data.auth.provider, "email");

      assert.deepEqual(await sendAndWait(socket, { id: "after-link", type: "preferences.get" }), {
        id: "after-link",
        type: "preferences.result",
        data: { preferences: { theme: "amber" } },
        error: null,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "signout", type: "auth.signOut" }), {
        id: "signout",
        type: "auth.signOut.result",
        data: { ok: true },
        error: null,
      });
      assert.deepEqual(await sendAndWait(socket, { id: "after-signout", type: "preferences.get" }), {
        id: "after-signout",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });

      const signIn = await sendAndWait(socket, {
        id: "signin",
        type: "auth.signIn",
        provider: "email",
        credentials: {
          email: "mira@example.com",
          password: "correct horse battery staple",
        },
      });
      assert.equal(signIn.type, "auth.signIn.result");
      assert.equal(signIn.error, null);
      assert.equal(signIn.data.auth.userId, initialAuth.data.auth.userId);

      assert.deepEqual(await sendAndWait(socket, { id: "after-signin", type: "preferences.get" }), {
        id: "after-signin",
        type: "preferences.result",
        data: { preferences: { theme: "amber" } },
        error: null,
      });
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

test("current-user preferences follow local identity simulation delivered to a connected client", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "preferences-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "preferences-island");
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
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started));
      socket = await openSocket(started.data.url);

      assert.deepEqual(await sendAndWait(socket, { id: "anonymous-prefs", type: "preferences.update", patch: { theme: "anonymous" } }), {
        id: "anonymous-prefs",
        type: "preferences.result",
        data: { preferences: { theme: "anonymous" } },
        error: null,
      });

      const deliveredToCurrent = waitForSocketMessage(socket, (message) => message.type === "auth.session.replace");
      const simulated = await runCli(
        [
          "auth",
          "as",
          "email",
          "--email",
          "local@example.com",
          "--display-name",
          "Local User",
          "--client",
          "current",
          "--json",
        ],
        { cwd: projectDir },
      );
      assert.equal(simulated.code, 0, simulated.stderr);
      const body = JSON.parse(simulated.stdout);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.delivery, {
        target: "current",
        delivered: true,
        clients: 1,
      });

      const delivery = await deliveredToCurrent;
      assert.equal(delivery.data.auth.provider, "email");
      assert.equal(delivery.data.auth.email, "local@example.com");
      assert.deepEqual(await sendAndWait(socket, { id: "simulated-initial", type: "preferences.get" }), {
        id: "simulated-initial",
        type: "preferences.result",
        data: { preferences: {} },
        error: null,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "simulated-prefs", type: "preferences.update", patch: { theme: "simulated" } }), {
        id: "simulated-prefs",
        type: "preferences.result",
        data: { preferences: { theme: "simulated" } },
        error: null,
      });
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});
