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

async function startResetCapsule(dir) {
  const created = await runCli(["create", "reset-capsule", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr);
  const projectDir = path.join(dir, "reset-capsule");
  const configPath = path.join(projectDir, "sporades.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.dev.port = 0;
  config.auth = { providers: { anonymous: true, email: true } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await installFakeReact(projectDir);
  await writeFile(
    path.join(projectDir, "server", "index.ts"),
    `import { capsule } from "sporades/server"; export default capsule({ name: "reset-capsule" });\n`,
  );
  const child = startCli(["dev", "--json"], { cwd: projectDir });
  const started = await waitForJsonLine(child);
  return { child, url: started.data.url };
}

async function stopDevSession(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, TEST_PROCESS_EVENT_TIMEOUT_MS);
    child.on("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("requesting a reset link over the transport cannot distinguish a registered account", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startResetCapsule(dir);
    let socket;
    try {
      socket = await openSocket(url);
      const signedUp = await sendAndWait(socket, {
        id: "signup",
        type: "auth.signUp",
        provider: "email",
        credentials: { email: "known@example.com", password: "password-123", name: "Known" },
      });
      assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));

      const known = await sendAndWait(socket, { id: "known", type: "auth.sendPasswordResetLink", email: "known@example.com" });
      const unknown = await sendAndWait(socket, { id: "unknown", type: "auth.sendPasswordResetLink", email: "never-registered@example.com" });

      assert.equal(known.error, null, JSON.stringify(known.error));
      assert.equal(unknown.error, null, "an unregistered email must not report an error");
      assert.equal(known.type, unknown.type, "the response type must not reveal whether the account exists");
      assert.deepEqual(known.data, unknown.data, "the response payload must not reveal whether the account exists");
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

test("completing a reset over the transport does not sign the browser in", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startResetCapsule(dir);
    let socket;
    try {
      socket = await openSocket(url);
      await sendAndWait(socket, {
        id: "signup",
        type: "auth.signUp",
        provider: "email",
        credentials: { email: "owner@example.com", password: "password-123", name: "Owner" },
      });
      await sendAndWait(socket, { id: "signout", type: "auth.signOut" });

      // The browser only ever holds the opaque code it read from the link.
      const code = await readResetCodeFromCapsule(path.join(dir, "reset-capsule"), "owner@example.com");
      const verified = await sendAndWait(socket, { id: "verify", type: "auth.verifyPasswordResetCode", code });
      assert.equal(verified.error, null, JSON.stringify(verified.error));
      assert.equal(verified.data.email, "owner@example.com");

      const confirmed = await sendAndWait(socket, { id: "confirm", type: "auth.confirmPasswordReset", code, newPassword: "replacement-123" });
      assert.equal(confirmed.error, null, JSON.stringify(confirmed.error));

      const after = await sendAndWait(socket, { id: "after", type: "auth.get" });
      assert.equal(after.data.auth.isAuthenticated, false, "a mailed code must not by itself produce a signed-in Session");

      const signedIn = await sendAndWait(socket, {
        id: "signin",
        type: "auth.signIn",
        provider: "email",
        credentials: { email: "owner@example.com", password: "replacement-123" },
      });
      assert.equal(signedIn.error, null, "the new password must work through the normal sign-in path");
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

async function signUp(socket, id, email, password) {
  const result = await sendAndWait(socket, {
    id,
    type: "auth.signUp",
    provider: "email",
    credentials: { email, password, name: email },
  });
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result;
}

async function canSignIn(socket, id, email, password) {
  const result = await sendAndWait(socket, { id, type: "auth.signIn", provider: "email", credentials: { email, password } });
  return result.error === null;
}

test("an anonymous visitor cannot set a registered account's password", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startResetCapsule(dir);
    let socket;
    try {
      socket = await openSocket(url);
      await signUp(socket, "victim-signup", "victim@example.com", "victim-password-1");
      await sendAndWait(socket, { id: "signout", type: "auth.signOut" });

      const attempt = await sendAndWait(socket, {
        id: "takeover",
        type: "auth.setPassword",
        email: "victim@example.com",
        newPassword: "attacker-chosen-1",
      });

      assert.notEqual(attempt.error, null, "an unauthenticated caller must not set a password");
      assert.equal(attempt.error.code, "UNAUTHENTICATED");
      assert.equal(
        await canSignIn(socket, "attacker-signin", "victim@example.com", "attacker-chosen-1"),
        false,
        "the victim's password must be unchanged",
      );
      assert.equal(
        await canSignIn(socket, "victim-signin", "victim@example.com", "victim-password-1"),
        true,
        "the victim's original password must still work",
      );
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

test("a signed-in user cannot set another account's password", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startResetCapsule(dir);
    let socket;
    try {
      socket = await openSocket(url);
      await signUp(socket, "target-signup", "target@example.com", "target-password-1");
      await sendAndWait(socket, { id: "target-signout", type: "auth.signOut" });
      await signUp(socket, "intruder-signup", "intruder@example.com", "intruder-password-1");

      const attempt = await sendAndWait(socket, {
        id: "cross-account",
        type: "auth.setPassword",
        email: "target@example.com",
        newPassword: "attacker-chosen-2",
      });

      assert.notEqual(attempt.error, null, "authentication alone must not authorize changing another account");
      assert.equal(
        await canSignIn(socket, "cross-signin", "target@example.com", "attacker-chosen-2"),
        false,
        "the target's password must be unchanged",
      );
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

test("a signed-in user can still set their own password", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startResetCapsule(dir);
    let socket;
    try {
      socket = await openSocket(url);
      await signUp(socket, "owner-signup", "owner@example.com", "owner-password-1");

      const changed = await sendAndWait(socket, {
        id: "own-password",
        type: "auth.setPassword",
        email: "owner@example.com",
        newPassword: "owner-password-2",
      });

      assert.equal(changed.error, null, JSON.stringify(changed.error));
      await sendAndWait(socket, { id: "owner-signout", type: "auth.signOut" });
      assert.equal(
        await canSignIn(socket, "owner-signin", "owner@example.com", "owner-password-2"),
        true,
        "the owner's new password must work",
      );
    } finally {
      socket?.close();
      await stopDevSession(child);
    }
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-reset-transport-"));
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
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)),
  );
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
    if (sessionToken) {
      const send = socket.send.bind(socket);
      socket.send = (rawMessage) => {
        try {
          const message = JSON.parse(rawMessage);
          send(JSON.stringify({ ...message, sessionToken }));
          return;
        } catch {
          send(rawMessage);
        }
      };
    }
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

function waitForSocketMessage(socket, predicate) {
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

// The Reset code is delivered by mail, which this Capsule has no transport for.
// Read it from the runtime's own storage the way a mail client would read the link.
async function readResetCodeFromCapsule(projectDir, email) {
  const { createEmailPasswordResetLink, openDevDatabase, resolveAnonymousSession } =
    await import("../dist/server-runtime-source.js");
  const databasePath = path.join(projectDir, ".sporades", "data.db");
  const database = await openDevDatabase(databasePath, "", {}, {
    name: "reset-capsule",
    auth: { providers: { email: { enabled: true } } },
  }, {});
  try {
    const session = await resolveAnonymousSession(database, null);
    const result = await createEmailPasswordResetLink(database, session, email);
    assert.equal(result.ok, true, result.error?.message);
    return new URL(result.link).searchParams.get("code");
  } finally {
    await database.close();
  }
}
