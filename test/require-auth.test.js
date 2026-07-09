import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { requireAuth } from "../dist/server.js";
import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

const runtimeRequireAuth = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "requireAuth");

function linkedAuth() {
  return {
    userId: "user-linked",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
}

function guestAuth() {
  return {
    userId: "user-guest",
    displayName: "Guest",
    email: null,
    picture: null,
    isAuthenticated: true,
    isGuest: true,
    provider: "anonymous",
  };
}

function anonymousAuth() {
  return {
    userId: "user-anonymous",
    displayName: "Anonymous",
    email: null,
    picture: null,
    isAuthenticated: false,
    isGuest: true,
    provider: "anonymous",
  };
}

function assertUnauthenticatedError(error) {
  assert.equal(error.message, "Unauthenticated.");
  assert.equal(error.hint, "Sign in and retry the request.");
  assert.equal(error.code, "UNAUTHENTICATED");
  assert.doesNotMatch(error.message, /user-|anonymous|email|guest|linked/i);
  assert.doesNotMatch(error.hint, /user-|anonymous|email|guest|linked/i);
  return true;
}

for (const [flavor, helper] of [
  ["sporades/server module", requireAuth],
  ["capsule server runtime", runtimeRequireAuth],
]) {
  test(`requireAuth returns the AuthContext for authenticated sessions (${flavor})`, () => {
    assert.equal(typeof helper, "function");
    const auth = linkedAuth();
    assert.deepEqual(helper({ auth, kind: "query" }), auth);
    assert.deepEqual(helper({ auth, kind: "mutation" }, { linked: true }), auth);
  });

  test(`requireAuth admits authenticated guests unless linked is required (${flavor})`, () => {
    const auth = guestAuth();
    assert.deepEqual(helper({ auth, kind: "endpoint" }), auth);
    assert.throws(() => helper({ auth, kind: "endpoint" }, { linked: true }), assertUnauthenticatedError);
  });

  test(`requireAuth rejects unauthenticated sessions with an opaque structured error (${flavor})`, () => {
    const auth = anonymousAuth();
    assert.throws(() => helper({ auth, kind: "message" }), assertUnauthenticatedError);
    assert.throws(() => helper({ auth, kind: "message" }, { linked: true }), assertUnauthenticatedError);
    assert.throws(() => helper({}), assertUnauthenticatedError);
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-require-auth-"));
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

const expectedDenialError = {
  code: "UNAUTHENTICATED",
  message: "Unauthenticated.",
  hint: "Sign in and retry the request.",
};

test("requireAuth gates queries, mutations, endpoints, and app messages in a Dev session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "auth-gate-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = path.join(dir, "auth-gate-island");
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
      `import { capsule, endpoint, message, mutation, query, requireAuth, String, table } from "sporades/server";

export default capsule({
  name: "auth-gate-island",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    privateNotes: query((ctx) => {
      const auth = requireAuth(ctx);
      return ctx.db.notes.where("ownerId", auth.userId).orderBy("createdAt", "desc").all();
    }),
    linkedProfile: query((ctx) => requireAuth(ctx, { linked: true })),
  },

  mutations: {
    createNote: mutation((ctx, text: string) => {
      const auth = requireAuth(ctx);
      ctx.db.notes.insert({ text, ownerId: auth.userId });
    }),
  },

  endpoints: {
    profile: endpoint({ method: "GET", path: "/profile" }, (ctx) => ({
      status: 200,
      body: requireAuth(ctx),
    })),
  },

  messages: {
    whoami: message((ctx) => ({ userId: requireAuth(ctx).userId })),
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

      const anonymousAuthResult = await sendAndWait(socket, { id: "auth-anon", type: "auth.get" });
      assert.equal(anonymousAuthResult.data.auth.provider, "anonymous");
      assert.equal(anonymousAuthResult.data.auth.isAuthenticated, false);

      const deniedQuery = await sendAndWait(socket, { id: "notes-denied", type: "query.subscribe", query: "privateNotes" });
      assert.equal(deniedQuery.type, "query.result");
      assert.equal(deniedQuery.query, "privateNotes");
      assert.deepEqual(deniedQuery.error, expectedDenialError);
      assert.ok(!deniedQuery.data);

      const deniedLinkedQuery = await sendAndWait(socket, { id: "linked-denied", type: "query.subscribe", query: "linkedProfile" });
      assert.deepEqual(deniedLinkedQuery.error, expectedDenialError);

      assert.deepEqual(
        await sendAndWait(socket, { id: "create-denied", type: "mutation.run", mutation: "createNote", args: ["nope"] }),
        {
          id: "create-denied",
          type: "mutation.result",
          mutation: "createNote",
          data: null,
          error: expectedDenialError,
        },
      );

      const deniedEndpointResponse = await fetch(`${started.data.url}/profile`, {
        headers: { "x-sporades-session-token": anonymousAuthResult.data.sessionToken },
      });
      assert.equal(deniedEndpointResponse.status, 401);
      assert.deepEqual(await deniedEndpointResponse.json(), {
        ok: false,
        data: null,
        error: expectedDenialError,
      });

      assert.deepEqual(await sendAndWait(socket, { id: "whoami-denied", type: "app.send", message: "whoami" }), {
        id: "whoami-denied",
        type: "app.result",
        message: "whoami",
        data: null,
        error: expectedDenialError,
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
      assert.equal(signUp.data.ok, true, JSON.stringify(signUp));
      const linkedAuthContext = signUp.data.auth;
      assert.equal(linkedAuthContext.isAuthenticated, true);
      assert.equal(linkedAuthContext.isGuest, false);

      assert.deepEqual(
        await sendAndWait(socket, { id: "create-allowed", type: "mutation.run", mutation: "createNote", args: ["mine"] }),
        {
          id: "create-allowed",
          type: "mutation.result",
          mutation: "createNote",
          data: null,
          error: null,
        },
      );

      const allowedQuery = await sendAndWait(socket, { id: "notes-allowed", type: "query.subscribe", query: "privateNotes" });
      assert.equal(allowedQuery.error, null);
      assert.equal(allowedQuery.data.length, 1);
      assert.equal(allowedQuery.data[0].text, "mine");
      assert.equal(allowedQuery.data[0].ownerId, linkedAuthContext.userId);

      const allowedLinkedQuery = await sendAndWait(socket, { id: "linked-allowed", type: "query.subscribe", query: "linkedProfile" });
      assert.equal(allowedLinkedQuery.error, null);
      assert.deepEqual(allowedLinkedQuery.data, linkedAuthContext);

      const allowedEndpointResponse = await fetch(`${started.data.url}/profile`, {
        headers: { "x-sporades-session-token": signUp.data.sessionToken },
      });
      assert.equal(allowedEndpointResponse.status, 200);
      assert.deepEqual(await allowedEndpointResponse.json(), linkedAuthContext);

      assert.deepEqual(await sendAndWait(socket, { id: "whoami-allowed", type: "app.send", message: "whoami" }), {
        id: "whoami-allowed",
        type: "app.result",
        message: "whoami",
        data: { userId: linkedAuthContext.userId },
        error: null,
      });

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      const denials = logs.data.entries.filter((entry) => entry.event === "auth.denied");
      assert.ok(denials.length >= 5, JSON.stringify(denials));
      for (const denial of denials) {
        assert.equal(denial.category, "platform");
        assert.equal(denial.level, "warn");
        assert.equal(denial.data.actor.userId, anonymousAuthResult.data.auth.userId);
        assert.equal(denial.data.actor.isAuthenticated, false);
        assert.equal(denial.data.actor.isGuest, true);
        assert.equal(denial.data.actor.provider, "anonymous");
      }
      const deniedKinds = new Set(denials.map((entry) => entry.data.handler.kind));
      assert.deepEqual([...deniedKinds].sort(), ["endpoint", "message", "mutation", "query"]);
      const requirements = new Set(denials.map((entry) => entry.data.requirement));
      assert.ok(requirements.has("authenticated"));
      assert.ok(requirements.has("linked"));
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
