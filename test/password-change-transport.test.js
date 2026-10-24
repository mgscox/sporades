import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createClientRuntimeSource } from "../dist/templates/client-runtime-template.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

async function startPasswordChangeCapsule(dir) {
  const created = await runCli(["create", "password-capsule", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr);
  const projectDir = path.join(dir, "password-capsule");
  const configPath = path.join(projectDir, "sporades.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.dev.port = 0;
  config.auth = { providers: { anonymous: true, email: true } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await installFakeReact(projectDir);
  // The todo query already scopes rows to `ctx.auth.userId`, so a replacement
  // Anonymous session must not see the account's rows. The mutation additionally
  // requires a linked (non-guest) identity, so a cached revoked Session blob
  // cannot authorize writes after the revocation.
  await writeFile(
    path.join(projectDir, "server", "index.ts"),
    `import { Boolean, capsule, mutation, query, requireUserAuth, String, table } from "sporades/server";

export default capsule({
  name: "password-capsule",
  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },
  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },
  mutations: {
    addTodo: mutation((ctx, text: string) => {
      const auth = requireUserAuth(ctx, { linked: true });
      ctx.db.todos.insert({ text, ownerId: auth.userId });
    }),
  },
});
`,
  );
  const child = startCli(["dev", "--json"], { cwd: projectDir });
  const started = await waitForJsonLine(child);
  assert.equal(started.ok, true, JSON.stringify(started.error));
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

test("a browser password change revokes the sibling connection's cached authority over the real transport", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startPasswordChangeCapsule(dir);
    let first;
    try {
      first = await openSocket(url);
      const signedUp = await sendAndWait(first, {
        id: "signup",
        type: "auth.signUp",
        provider: "email",
        credentials: { email: "owner@example.com", password: "owner-password-1", name: "Owner" },
      });
      assert.equal(signedUp.error, null, JSON.stringify(signedUp.error));
      const sessionToken = signedUp.data.sessionToken;

      // A sibling connection authenticates with the same Session and holds a
      // live subscription to the account's protected rows.
      const sibling = await openSocket(url, sessionToken);
      await sendAndWait(sibling, { id: "watch", type: "query.subscribe", query: "todos", sessionToken });

      const added = await sendAndWait(first, { id: "add-1", type: "mutation.run", mutation: "addTodo", args: ["protected note"], sessionToken });
      assert.equal(added.error, null, JSON.stringify(added.error));
      const initial = await waitForSocketMessage(
        sibling,
        (message) => message.id === "watch" && message.type === "query.result" && Array.isArray(message.data) && message.data.length === 1,
        "waiting for the sibling's protected row",
      );
      assert.equal(initial.error, null, JSON.stringify(initial.error));

      // The runtime replaces both live connections and refreshes their
      // subscriptions BEFORE the change result is sent, so listen first.
      const siblingReplace = waitForSocketMessage(sibling, (message) => message.type === "auth.session.replace", "sibling replacement");
      const firstReplace = waitForSocketMessage(first, (message) => message.type === "auth.session.replace", "initiator replacement");
      const siblingEmptied = waitForSocketMessage(
        sibling,
        (message) => message.id === "watch" && message.type === "query.result" && Array.isArray(message.data) && message.data.length === 0,
        "waiting for the sibling's refreshed empty result",
      );

      // The initiating browser changes its password.
      const changed = await sendAndWait(first, {
        id: "change",
        type: "auth.setPassword",
        email: "owner@example.com",
        currentPassword: "owner-password-1",
        newPassword: "owner-password-2",
      });
      assert.equal(changed.error, null, JSON.stringify(changed.error));
      assert.deepEqual(changed.data, { ok: true });

      await siblingReplace;
      await firstReplace;

      // The sibling's subscription refreshed without the old actor: the
      // account's protected rows stop flowing immediately.
      const afterRevocation = await siblingEmptied;
      assert.equal(afterRevocation.error, null, JSON.stringify(afterRevocation.error));
      assert.notDeepEqual(
        afterRevocation.data,
        initial.data,
        "the sibling's subscription must no longer include the account's protected rows",
      );

      // The sibling (or any socket presenting the revoked token) cannot mutate:
      // the per-message Session resolution drops the revoked blob to Anonymous.
      const staleIdentity = await sendAndWait(sibling, { id: "stale-identity", type: "auth.get", sessionToken });
      assert.equal(staleIdentity.data?.auth?.isAuthenticated, false, "the revoked token no longer authenticates");
      const rejected = await sendAndWait(sibling, { id: "sibling-mutation", type: "mutation.run", mutation: "addTodo", args: ["stale attempt"], sessionToken });
      assert.notEqual(rejected.error, null, "a revoked Session must not authorize a mutation");
      assert.equal(rejected.error.code, "UNAUTHENTICATED", JSON.stringify(rejected.error));

      // A brand-new connection presenting the revoked token gets no authority either.
      const fresh = await openSocket(url, sessionToken);
      const freshIdentity = await sendAndWait(fresh, { id: "fresh-identity", type: "auth.get", sessionToken });
      assert.equal(freshIdentity.data?.auth?.isAuthenticated, false, "a revoked token cannot open a new Session");
      fresh.close();

      // Old and new passwords have the documented sign-in outcomes.
      assert.equal(await canSignIn(first, "old-password-signin", "owner@example.com", "owner-password-1"), false, "the old password must stop signing in");
      assert.equal(await canSignIn(first, "new-password-signin", "owner@example.com", "owner-password-2"), true, "the new password must sign in fresh");
    } finally {
      first?.close();
      await stopDevSession(child);
    }
  });
});

// Separate VM globals model independent tabs while the shipped SDK uses real
// WebSockets and the generated CLI runtime. Neither sibling calls auth.get
// after retirement: the pushed replacement must contain complete provider state.
test("password change preserves provider metadata in sibling SDK subscriptions", async () => {
  await withTempDir(async (dir) => {
    const { child, url } = await startPasswordChangeCapsule(dir);
    let first;
    const siblings = [];
    try {
      first = await openSocket(url);
      const signup = await sendAndWait(first, {
        id: "sdk-signup", type: "auth.signUp", provider: "email",
        credentials: { email: "sdk@example.com", password: "sdk-password-1" },
      });
      assert.equal(signup.error, null);
      for (let index = 0; index < 2; index += 1) {
        const storage = new Map([["sporades.sessionToken", signup.data.sessionToken]]);
        const events = new Map();
        const context = {
          URL, WebSocket, TextEncoder, setTimeout, clearTimeout, console,
          localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
          },
          window: {
            location: { href: url },
            __SPORADES_CONNECTION_TOKEN: await readPageConnectionToken(url),
            addEventListener: (name, listener) => events.set(name, listener),
          },
        };
        runInNewContext(createClientRuntimeSource().replace(/^export /gm, "") + "\nglobalThis.sdk = { auth };", context);
        const states = [];
        const signedOut = Promise.withResolvers();
        const subscription = context.sdk.auth.subscribe(state => {
          states.push(JSON.parse(JSON.stringify(state)));
          if (states.some(previous => previous.auth?.isAuthenticated) && state.auth?.isAuthenticated === false) signedOut.resolve();
        });
        siblings.push({ context, events, subscription, states, signedOut });
        const initial = await context.sdk.auth.get();
        assert.equal(initial.error, null);
        assert.equal(initial.data.auth.isAuthenticated, true);
        assert.equal(Object.keys(initial.data.providers).length, 6);
        assert.equal(initial.data.providers.email.enabled, true);
        // Apple availability is origin-dependent; HTTP must never advertise it.
        assert.equal(initial.data.providers.apple.runtimeAvailable, false);
        siblings.at(-1).providers = JSON.parse(JSON.stringify(initial.data.providers));
      }
      const changed = await sendAndWait(first, {
        id: "sdk-change", type: "auth.setPassword", email: "sdk@example.com",
        currentPassword: "sdk-password-1", newPassword: "sdk-password-2",
      });
      assert.equal(changed.error, null);
      for (const sibling of siblings) {
        let timer;
        try {
          await Promise.race([sibling.signedOut.promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Sibling SDK did not publish signed-out state")), TEST_WEBSOCKET_TIMEOUT_MS);
          })]);
        } finally { clearTimeout(timer); }
        const retired = sibling.states.at(-1);
        assert.equal(retired.auth.isAuthenticated, false);
        assert.deepEqual(retired.providers, sibling.providers, "retirement retains every origin-aware provider field");
      }
    } finally {
      for (const sibling of siblings) {
        sibling.subscription.unsubscribe();
        sibling.events.get("pagehide")?.({ persisted: false });
      }
      first?.close();
      await stopDevSession(child);
    }
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-change-transport-"));
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
  const response = await fetch(new URL("/", baseUrl), { headers: { "sec-fetch-dest": "document" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, "Expected served page to include a Sporades connection token.");
  return match[1];
}

function waitForSocketMessage(socket, predicate, label = "WebSocket message") {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out ${label}.`));
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
  const pending = waitForSocketMessage(socket, (message) => message.id === payload.id, `WebSocket message ${payload.id}`);
  socket.send(JSON.stringify(payload));
  return pending;
}

async function canSignIn(socket, id, email, password) {
  const result = await sendAndWait(socket, { id, type: "auth.signIn", provider: "email", credentials: { email, password } });
  return result.error === null;
}