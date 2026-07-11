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

test("User journey lifecycle is declaration-gated and bound to the enabling identity over the real transport", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "journey-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "journey-island");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8")); config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const serverPath = path.join(projectDir, "server", "index.ts");
    await writeFile(serverPath, `import { capsule } from "sporades/server"; export default capsule({ name: "journey-island" });\n`);
    let child = startCli(["dev", "--json"], { cwd: projectDir });
    let socket;
    try {
      let started = await waitForJsonLine(child); socket = await openSocket(started.data.url);
      const gated = await sendAndWait(socket, { id: "gated", type: "journey.list" });
      assert.equal(gated.error.code, "JOURNEY_NOT_ENABLED");
      socket.close(); await stopDevSession(child);
      await writeFile(serverPath, `import { capsule } from "sporades/server"; export default capsule({ name: "journey-island", journey: { enabled: true, ttlSeconds: 30 } });\n`);
      child = startCli(["dev", "--json"], { cwd: projectDir }); started = await waitForJsonLine(child); socket = await openSocket(started.data.url);
      const auth = await sendAndWait(socket, { id: "auth", type: "auth.get" });
      const enabled = await sendAndWait(socket, { id: "enable", type: "journey.enable", options: {} });
      assert.equal(enabled.data.userId, auth.data.auth.userId); assert.equal(typeof enabled.data.sessionId, "string");
      const set = await sendAndWait(socket, { id: "set", type: "journey.set", state: { status: " editing ", metadata: { step: 1 }, ttlSeconds: 20 } });
      assert.deepEqual(Object.keys(set.data.journey).sort(), ["createdAt", "expiresAt", "metadata", "sessionId", "status", "updatedAt", "userId"]);
      assert.equal(set.data.journey.status, "editing"); assert.equal(set.data.journey.userId, auth.data.auth.userId);
      const listed = await sendAndWait(socket, { id: "list", type: "journey.list" });
      assert.deepEqual(listed.data.journeys, [set.data.journey]);
      const invalid = await sendAndWait(socket, { id: "invalid", type: "journey.set", state: { status: "inactive" } });
      assert.equal(invalid.error.code, "INVALID_JOURNEY_STATUS");
      assert.deepEqual((await sendAndWait(socket, { id: "unchanged", type: "journey.list" })).data.journeys, [set.data.journey]);
      assert.equal((await sendAndWait(socket, { id: "signout", type: "auth.signOut" })).error, null);
      const identityChanged = await sendAndWait(socket, { id: "identity-changed", type: "journey.set", state: { status: "editing" } });
      assert.equal(identityChanged.error.code, "JOURNEY_IDENTITY_CHANGED");
      assert.deepEqual((await sendAndWait(socket, { id: "retired", type: "journey.list" })).data.journeys, []);
      assert.deepEqual((await sendAndWait(socket, { id: "disable", type: "journey.disable" })).data, { ok: true });
      assert.deepEqual((await sendAndWait(socket, { id: "empty", type: "journey.list" })).data.journeys, []);
    } finally { socket?.close(); await stopDevSession(child); }
  });
});

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
        data: {
          preferences: { theme: "solarized" },
          changes: { theme: "solarized" },
        },
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

test("anonymous preferences move to an existing email account on sign-in", async () => {
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
      assert.equal(signUp.error, null);
      const emailUserId = signUp.data.auth.userId;

      assert.deepEqual(await sendAndWait(socket, { id: "email-prefs", type: "preferences.update", patch: { density: "cozy", theme: "light" } }), {
        id: "email-prefs",
        type: "preferences.result",
        data: { preferences: { density: "cozy", theme: "light" } },
        error: null,
      });

      assert.equal((await sendAndWait(socket, { id: "signout", type: "auth.signOut" })).error, null);
      const anonymousAuth = await sendAndWait(socket, { id: "anonymous-auth", type: "auth.get" });
      assert.equal(anonymousAuth.data.auth.provider, "anonymous");
      assert.notEqual(anonymousAuth.data.auth.userId, emailUserId);

      assert.deepEqual(await sendAndWait(socket, { id: "anonymous-prefs", type: "preferences.update", patch: { theme: "amber" } }), {
        id: "anonymous-prefs",
        type: "preferences.result",
        data: { preferences: { theme: "amber" } },
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
      assert.equal(signIn.error, null);
      assert.equal(signIn.data.auth.userId, emailUserId);

      assert.deepEqual(await sendAndWait(socket, { id: "after-signin", type: "preferences.get" }), {
        id: "after-signin",
        type: "preferences.result",
        data: { preferences: { density: "cozy", theme: "amber" } },
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
