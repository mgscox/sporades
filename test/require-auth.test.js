import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capsule, endpoint, message, mutation, query, requireAuth, requireUserAuth } from "../dist/server.js";
import { accessKeyGrantsSatisfyScopes, scopeGrantMatches } from "../dist/auth-admission.js";
// The runtime's own `requireAuth`, which this file compares against the public one above. A named
// import since batch 3 moved it into `auth-runtime.ts`: the `SERVER_RUNTIME_SOURCE_FUNCTIONS.find`
// spelling it had returns `undefined` rather than failing when a domain leaves the emitted list, and
// every comparison below would then have been against `undefined`.
import {
  openDevDatabase,
  createFileAclContext,
  createTableAclContext,
  requireAuth as runtimeRequireAuth,
  requireUserAuth as runtimeRequireUserAuth,
  runAppMessage,
  runEndpoint,
  runMutation,
  runQuery,
} from "../dist/server-runtime-source.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

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

for (const [flavor, legacyHelper, preferredHelper] of [
  ["sporades/server module", requireAuth, requireUserAuth],
  ["capsule server runtime", runtimeRequireAuth, runtimeRequireUserAuth],
]) {
  test(`requireUserAuth is the preferred name for the unchanged inline Session check (${flavor})`, () => {
    const auth = linkedAuth();
    assert.deepEqual(preferredHelper({ auth, kind: "query" }), auth);
    assert.deepEqual(preferredHelper({ auth, kind: "query" }, { linked: true }), auth);
    assert.deepEqual(legacyHelper({ auth, kind: "query" }), preferredHelper({ auth, kind: "query" }));
    assert.throws(() => preferredHelper({ auth: anonymousAuth(), kind: "query" }), assertUnauthenticatedError);
    assert.throws(() => preferredHelper({ auth }, { scopes: ["not-inline"] }), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
    assert.throws(() => legacyHelper({ auth }, { credentials: ["session"] }), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  });
}

test("capsule registration freezes a copied scope vocabulary and declarative Auth requirements", () => {
  const scopes = ["requests:read", "requests:write"];
  const credentials = ["session"];
  const requiredScopes = ["requests:read"];
  const handler = requireAuth({ credentials, scopes: requiredScopes }, (ctx) => ctx.credential);
  const definition = capsule({
    name: "auth-declarations",
    accessKeys: { scopes },
    queries: { guarded: query(handler) },
    mutations: { guarded: mutation(handler) },
    endpoints: { guarded: endpoint({ method: "GET", path: "/guarded" }, handler) },
    messages: { guarded: message(handler) },
  });

  scopes[0] = "changed";
  credentials[0] = "access-key";
  requiredScopes[0] = "requests:write";
  assert.deepEqual(definition.accessKeys.scopes, ["requests:read", "requests:write"]);
  assert.equal(Object.isFrozen(definition.accessKeys), true);
  assert.equal(Object.isFrozen(definition.accessKeys.scopes), true);
  assert.equal(handler({ credential: { kind: "session" } }).kind, "session");
  assert.deepEqual(capsule({ name: "explicit-empty", accessKeys: { scopes: [] } }).accessKeys.scopes, []);
  assert.equal("accessKeys" in capsule({ name: "omitted-empty" }), false);
  const fileAccess = capsule({
    name: "file-access",
    accessKeys: { scopes: ["files:read"] },
    files: { accessKeys: { read: { scopes: ["files:read"] } } },
  });
  assert.deepEqual(fileAccess.files.accessKeys.read.scopes, ["files:read"]);
  assert.equal(Object.isFrozen(fileAccess.files.accessKeys.read.scopes), true);
  assert.deepEqual(capsule({ name: "unscoped-file-access", files: { accessKeys: { read: {} } } }).files.accessKeys.read, {});
});

test("capsule registration fails closed for invalid scope and guard declarations", () => {
  const plainHandler = () => null;
  for (const definition of [
    { name: "unknown-access-key-field", accessKeys: { scopes: [], extra: true } },
    { name: "wildcard-scope", accessKeys: { scopes: ["requests:*"] } },
    { name: "duplicate-scope", accessKeys: { scopes: ["requests:read", "requests:read"] } },
    { name: "oversized-scope", accessKeys: { scopes: ["x".repeat(257)] } },
    { name: "too-many-scopes", accessKeys: { scopes: Array.from({ length: 1025 }, (_, index) => `scope-${index}`) } },
    { name: "invalid-file-access-keys", files: { accessKeys: true } },
    { name: "missing-file-read", files: { accessKeys: {} } },
    { name: "unknown-file-policy", files: { accessKeys: { read: {}, write: {} } } },
    { name: "malformed-file-read", files: { accessKeys: { read: true } } },
    { name: "unknown-file-read-field", files: { accessKeys: { read: { extra: true } } } },
    { name: "empty-file-scopes", accessKeys: { scopes: ["files:read"] }, files: { accessKeys: { read: { scopes: [] } } } },
    { name: "wildcard-file-scope", accessKeys: { scopes: ["files:read"] }, files: { accessKeys: { read: { scopes: ["files:*"] } } } },
    { name: "duplicate-file-scope", accessKeys: { scopes: ["files:read"] }, files: { accessKeys: { read: { scopes: ["files:read", "files:read"] } } } },
    { name: "undeclared-file-scope", accessKeys: { scopes: ["files:read"] }, files: { accessKeys: { read: { scopes: ["files:write"] } } } },
  ]) {
    assert.throws(() => capsule(definition), (error) => ["INVALID_ACCESS_KEY_DECLARATION", "INVALID_ACCESS_KEY_SCOPE", "INVALID_FILE_ACCESS_KEY_POLICY"].includes(error.code));
  }

  assert.throws(
    () => capsule({
      name: "undeclared-required-scope",
      accessKeys: { scopes: ["requests:read"] },
      endpoints: {
        guarded: endpoint(
          { method: "GET", path: "/guarded" },
          requireAuth({ scopes: ["requests:write"] }, plainHandler),
        ),
      },
    }),
    (error) => error.code === "INVALID_AUTH_REQUIREMENTS",
  );
  assert.throws(() => requireAuth({ credentials: [] }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth({ scopes: ["requests:*"] }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth({ scopes: [] }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth({ scopes: ["requests:read", "requests:read"] }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth({ credentials: ["session", "session"] }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth({ unknown: true }, plainHandler), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
  assert.throws(() => requireAuth(requireAuth(plainHandler)), (error) => error.code === "INVALID_AUTH_REQUIREMENTS");
});

test("scope grants use case-sensitive whole-string wildcard matching", () => {
  assert.equal(scopeGrantMatches("*", "requests:read"), true);
  assert.equal(scopeGrantMatches("requests:*", "requests:read"), true);
  assert.equal(scopeGrantMatches("r*", "requests:write"), true);
  assert.equal(scopeGrantMatches("*:read", "requests:read"), true);
  assert.equal(scopeGrantMatches("*ab*ab", "ababab"), true);
  assert.equal(scopeGrantMatches("ab*ab", "ababab"), true);
  assert.equal(scopeGrantMatches("ab*ab", "zabab"), false);
  assert.equal(scopeGrantMatches("requests:*", "Requests:read"), false);
  assert.equal(scopeGrantMatches("requests:read", "requests:reader"), false);
  assert.equal(accessKeyGrantsSatisfyScopes(["requests:*", "profile:read"], ["requests:read", "profile:read"]), true);
  assert.equal(accessKeyGrantsSatisfyScopes(["requests:*"], ["requests:read", "profile:read"]), false);

  const adversarialGrant = `${"*a".repeat(24)}*b`;
  const adversarialScope = "a".repeat(48);
  const startedAt = performance.now();
  assert.equal(scopeGrantMatches(adversarialGrant, adversarialScope), false);
  assert.ok(performance.now() - startedAt < 100, "wildcard matching must remain deterministic");
});

test("declarative Auth guards run before middleware and expose immutable Session provenance", async () => {
  await withTempDir(async (dir) => {
    const observed = [];
    globalThis.__observeSessionCredential = (kind, credential, auth) => {
      observed.push({ kind, credential, auth });
    };
    const guarded = (kind) => requireAuth(
      { credentials: ["session"], scopes: ["requests:read"] },
      (ctx) => ({
        kind,
        credential: ctx.credential,
        credentialFrozen: Object.isFrozen(ctx.credential),
        authFrozen: Object.isFrozen(ctx.auth),
      }),
    );
    const definition = capsule({
      name: "declarative-session-auth",
      accessKeys: { scopes: ["requests:read"] },
      queries: {
        guarded: query(guarded("query")),
        accessKeyOnly: query(requireAuth({ credentials: ["access-key"] }, () => "wrong")),
      },
      mutations: { guarded: mutation(guarded("mutation")) },
      endpoints: { guarded: endpoint({ method: "GET", path: "/guarded" }, guarded("endpoint")) },
      messages: { guarded: message(guarded("message")) },
    });
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      {},
      { name: definition.name },
      definition,
    );
    database.contextMiddleware = [
      `(ctx) => {
        globalThis.__observeSessionCredential(ctx.kind, ctx.credential, ctx.auth);
        return ctx;
      }`,
    ];
    const auth = linkedAuth();
    try {
      assert.deepEqual((await runQuery(database, auth, "guarded")).data, {
        kind: "query",
        credential: { kind: "session" },
        credentialFrozen: true,
        authFrozen: true,
      });
      assert.deepEqual((await runMutation(database, auth, "guarded", [])).data.kind, "mutation");
      assert.deepEqual((await runAppMessage(database, auth, "guarded", null)).data.kind, "message");
      assert.equal(observed.length, 3);
      assert.equal(observed.every((entry) => entry.credential.kind === "session"), true);

      const wrongKind = await runQuery(database, auth, "accessKeyOnly");
      assert.equal(wrongKind.error.code, "FORBIDDEN");
      assert.equal(observed.length, 3, "a denied declarative guard does not run middleware");

      await assert.rejects(
        runEndpoint(
          database,
          database.endpoints.find((candidate) => candidate.path === "/guarded"),
          new URL("http://capsule.test/guarded"),
          { method: "GET", headers: {}, async *[Symbol.asyncIterator]() {} },
        ),
        (error) => error.code === "UNAUTHENTICATED",
      );
      assert.equal(observed.length, 3, "an unauthenticated endpoint guard does not run middleware");
    } finally {
      delete globalThis.__observeSessionCredential;
      await database.close();
    }
  });
});

test("context middleware cannot replace canonical Auth or Credential values", async () => {
  await withTempDir(async (dir) => {
    const definition = capsule({
      name: "auth-middleware-tampering",
      queries: { guarded: query(requireAuth((ctx) => ctx.auth.userId)) },
    });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
    try {
      database.contextMiddleware = [`(ctx) => ({ ...ctx, credential: { kind: "session" } })`];
      const credentialTamper = await runQuery(database, linkedAuth(), "guarded");
      assert.equal(credentialTamper.error.code, "INVALID_CONTEXT_MIDDLEWARE_RESULT");

      database.contextMiddleware = [`(ctx) => ({ ...ctx, auth: { ...ctx.auth } })`];
      const authTamper = await runQuery(database, linkedAuth(), "guarded");
      assert.equal(authTamper.error.code, "INVALID_CONTEXT_MIDDLEWARE_RESULT");

      database.contextMiddleware = [`(ctx) => { ctx.auth.userId = "replacement"; return ctx; }`];
      const authMutation = await runQuery(database, linkedAuth(), "guarded");
      assert.equal(authMutation.error.code, "INVALID_CONTEXT_MIDDLEWARE_RESULT");

      database.contextMiddleware = [`(ctx) => { ctx.credential.kind = "access-key"; return ctx; }`];
      const credentialMutation = await runQuery(database, linkedAuth(), "guarded");
      assert.equal(credentialMutation.error.code, "INVALID_CONTEXT_MIDDLEWARE_RESULT");

      database.contextMiddleware = [`(ctx) => {
        let authReads = 0;
        return new Proxy(ctx, {
          get(target, property) {
            if (property === "auth" && ++authReads > 1) return { ...target.auth, userId: "forged" };
            return Reflect.get(target, property);
          }
        });
      }`];
      const statefulProxy = await runQuery(database, linkedAuth(), "guarded");
      assert.notEqual(statefulProxy.data, "forged");
      assert.equal(statefulProxy.error, null);
    } finally {
      await database.close();
    }
  });
});

test("ordinary Session provenance reaches ACL contexts without leaking into non-user contexts", async () => {
  await withTempDir(async (dir) => {
    let lifecycleCredentialPresent = null;
    const definition = capsule({
      name: "credential-context-boundaries",
      queries: {
        inspect: query(async (ctx) => ({
          current: ctx.credential,
          privileged: await ctx.privileged.run(
            { operation: "auth.inspect", targetResourceKind: "capsule-db" },
            (privilegedCtx) => ({
              credentialPresent: "credential" in privilegedCtx,
              authFrozen: Object.isFrozen(privilegedCtx.auth),
            }),
          ),
        })),
      },
      hooks: {
        init: (ctx) => {
          lifecycleCredentialPresent = "credential" in ctx;
        },
      },
    });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
    try {
      await database.init();
      assert.equal(lifecycleCredentialPresent, false);
      assert.deepEqual((await runQuery(database, linkedAuth(), "inspect")).data, {
        current: { kind: "session" },
        privileged: { credentialPresent: false, authFrozen: true },
      });

      const auth = Object.freeze({ ...linkedAuth() });
      const credential = Object.freeze({ kind: "session" });
      const tableAcl = createTableAclContext({ auth, credential }, database);
      assert.equal(tableAcl.auth, auth);
      assert.equal(tableAcl.credential, credential);

      const fileAcl = createFileAclContext(auth, database);
      assert.deepEqual(fileAcl.credential, { kind: "session" });
      assert.equal(Object.isFrozen(fileAcl.auth), true);
      assert.equal(Object.isFrozen(fileAcl.credential), true);
    } finally {
      await database.close();
    }
  });
});

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
  accessKeys: { scopes: ["requests:read"] },

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
    guardedCredential: query(requireAuth({ scopes: ["requests:read"] }, (ctx) => ({
      credential: ctx.credential,
      authFrozen: Object.isFrozen(ctx.auth),
      credentialFrozen: Object.isFrozen(ctx.credential),
    }))),
    accessKeyOnly: query(requireAuth({ credentials: ["access-key"] }, () => "wrong")),
  },

  mutations: {
    createNote: mutation((ctx, text: string) => {
      const auth = requireAuth(ctx);
      ctx.db.notes.insert({ text, ownerId: auth.userId });
    }),
    guardedMutation: mutation(requireAuth((ctx) => ctx.credential)),
    issueAccessKey: mutation((ctx) => ctx.accessKeys.issue({ name: "dev-reader", grants: ["requests:read"] })),
    revokeAccessKey: mutation((ctx, id: string) => ctx.accessKeys.revoke(id)),
  },

  endpoints: {
    profile: endpoint({ method: "GET", path: "/profile" }, (ctx) => ({
      status: 200,
      body: requireAuth(ctx),
    })),
    guarded: endpoint({ method: "GET", path: "/guarded" }, requireAuth((ctx) => ({
      status: 200,
      body: ctx.credential,
    }))),
    accessKeyOnly: endpoint({ method: "GET", path: "/access-key-only" }, requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, (ctx) => ({
      status: 200,
      body: { auth: ctx.auth, credential: ctx.credential, authorizationVisible: "authorization" in ctx.request.headers },
    }))),
  },

  messages: {
    whoami: message((ctx) => ({ userId: requireAuth(ctx).userId })),
    guarded: message(requireAuth((ctx) => ctx.credential)),
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
      const anonymousKeys = await sendAndWait(socket, { id: "keys-anon", type: "accessKeys.list", options: {} });
      assert.equal(anonymousKeys.error.code, "UNAUTHENTICATED");
      assert.equal(anonymousAuthResult.data.auth.isAuthenticated, false);

      const deniedQuery = await sendAndWait(socket, { id: "notes-denied", type: "query.subscribe", query: "privateNotes" });
      assert.equal(deniedQuery.type, "query.result");
      assert.equal(deniedQuery.query, "privateNotes");
      assert.deepEqual(deniedQuery.error, expectedDenialError);
      assert.ok(!deniedQuery.data);

      const deniedLinkedQuery = await sendAndWait(socket, { id: "linked-denied", type: "query.subscribe", query: "linkedProfile" });
      assert.deepEqual(deniedLinkedQuery.error, expectedDenialError);

      const deniedGuardedQuery = await sendAndWait(socket, { id: "guarded-denied", type: "query.subscribe", query: "guardedCredential" });
      assert.deepEqual(deniedGuardedQuery.error, expectedDenialError);

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
      assert.deepEqual((await sendAndWait(socket, { id: "guarded-message-denied", type: "app.send", message: "guarded" })).error, expectedDenialError);

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

      const browserIssued = await sendAndWait(socket, {
        id: "keys-issue",
        type: "accessKeys.issue",
        input: { name: "browser-bot", grants: ["requests:read"] },
      });
      assert.equal(browserIssued.error, null, JSON.stringify(browserIssued));
      assert.match(browserIssued.data.token, /^spk_1_/);
      const browserListed = await sendAndWait(socket, { id: "keys-list", type: "accessKeys.list", options: { status: "active" } });
      assert.equal(browserListed.data.totalCount, 1);
      assert.equal(JSON.stringify(browserListed).includes(browserIssued.data.token), false);
      const browserRotated = await sendAndWait(socket, {
        id: "keys-rotate",
        type: "accessKeys.rotate",
        accessKeyId: browserIssued.data.accessKey.id,
        options: { lifecycleRevision: browserIssued.data.accessKey.lifecycleRevision },
      });
      assert.equal(browserRotated.data.accessKey.id, browserIssued.data.accessKey.id);
      assert.notEqual(browserRotated.data.token, browserIssued.data.token);
      assert.equal((await fetch(`${started.data.url}/access-key-only`, {
        headers: { authorization: `Bearer ${browserIssued.data.token}` },
      })).status, 401);
      assert.equal((await fetch(`${started.data.url}/access-key-only`, {
        headers: { authorization: `Bearer ${browserRotated.data.token}` },
      })).status, 200);
      const browserRevoked = await sendAndWait(socket, { id: "keys-revoke", type: "accessKeys.revoke", accessKeyId: browserIssued.data.accessKey.id });
      assert.equal(browserRevoked.data.accessKey.status, "revoked");
      const browserDeleted = await sendAndWait(socket, { id: "keys-delete", type: "accessKeys.delete", accessKeyId: browserIssued.data.accessKey.id });
      assert.deepEqual(browserDeleted.data, { id: browserIssued.data.accessKey.id, deleted: true });

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

      const allowedGuardedQuery = await sendAndWait(socket, { id: "guarded-allowed", type: "query.subscribe", query: "guardedCredential" });
      assert.deepEqual(allowedGuardedQuery.data, {
        credential: { kind: "session" },
        authFrozen: true,
        credentialFrozen: true,
      });
      const accessKeyOnly = await sendAndWait(socket, { id: "access-key-only", type: "query.subscribe", query: "accessKeyOnly" });
      assert.equal(accessKeyOnly.error.code, "FORBIDDEN");

      const guardedMutation = await sendAndWait(socket, { id: "guarded-mutation", type: "mutation.run", mutation: "guardedMutation", args: [] });
      assert.deepEqual(guardedMutation.data, { kind: "session" });

      const allowedEndpointResponse = await fetch(`${started.data.url}/profile`, {
        headers: { "x-sporades-session-token": signUp.data.sessionToken },
      });
      assert.equal(allowedEndpointResponse.status, 200);
      assert.deepEqual(await allowedEndpointResponse.json(), linkedAuthContext);

      const guardedEndpointResponse = await fetch(`${started.data.url}/guarded`, {
        headers: { "x-sporades-session-token": signUp.data.sessionToken },
      });
      assert.equal(guardedEndpointResponse.status, 200);
      assert.deepEqual(await guardedEndpointResponse.json(), { kind: "session" });

      const accessKeyOnlyEndpointResponse = await fetch(`${started.data.url}/access-key-only`, {
        headers: { "x-sporades-session-token": signUp.data.sessionToken },
      });
      assert.equal(accessKeyOnlyEndpointResponse.status, 403);
      assert.equal((await accessKeyOnlyEndpointResponse.json()).error.code, "FORBIDDEN");

      const issuedAccessKey = await sendAndWait(socket, {
        id: "issue-access-key",
        type: "mutation.run",
        mutation: "issueAccessKey",
        args: [],
      });
      assert.equal(issuedAccessKey.error, null, JSON.stringify(issuedAccessKey));
      assert.match(issuedAccessKey.data.token, /^spk_1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
      const bearerResponse = await fetch(`${started.data.url}/access-key-only`, {
        headers: { authorization: `Bearer ${issuedAccessKey.data.token}` },
      });
      assert.equal(bearerResponse.status, 200);
      assert.equal(bearerResponse.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await bearerResponse.json(), {
        auth: { ...linkedAuthContext, provider: "access-key" },
        credential: { kind: "access-key", id: issuedAccessKey.data.accessKey.id, name: "dev-reader" },
        authorizationVisible: false,
      });

      const revokedAccessKey = await sendAndWait(socket, {
        id: "revoke-access-key",
        type: "mutation.run",
        mutation: "revokeAccessKey",
        args: [issuedAccessKey.data.accessKey.id],
      });
      assert.equal(revokedAccessKey.error, null, JSON.stringify(revokedAccessKey));
      const revokedBearerResponse = await fetch(`${started.data.url}/access-key-only`, {
        headers: { authorization: `Bearer ${issuedAccessKey.data.token}` },
      });
      assert.equal(revokedBearerResponse.status, 401);
      assert.equal(revokedBearerResponse.headers.get("www-authenticate"), 'Bearer realm="sporades", error="invalid_token"');
      assert.equal((await revokedBearerResponse.json()).error.code, "UNAUTHENTICATED");

      assert.deepEqual(await sendAndWait(socket, { id: "whoami-allowed", type: "app.send", message: "whoami" }), {
        id: "whoami-allowed",
        type: "app.result",
        message: "whoami",
        data: { userId: linkedAuthContext.userId },
        error: null,
      });
      assert.deepEqual((await sendAndWait(socket, { id: "guarded-message-allowed", type: "app.send", message: "guarded" })).data, { kind: "session" });

      const logsResult = await runCli(["logs", "--json"], { cwd: projectDir });
      assert.equal(logsResult.code, 0, logsResult.stderr);
      const logs = JSON.parse(logsResult.stdout);
      assert.equal(logs.ok, true);
      const denials = logs.data.entries.filter((entry) => entry.event === "auth.denied");
      assert.ok(denials.length >= 5, JSON.stringify(denials));
      for (const denial of denials.filter((entry) => ["authenticated", "linked"].includes(entry.data.requirement))) {
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
      assert.ok(requirements.has("credential"));
      assert.ok(requirements.has("access-key"));
      assert.ok(denials.some((entry) => entry.data.handler.kind === "query" && entry.data.requirement === "authenticated"));
      assert.ok(denials.some((entry) => entry.data.handler.kind === "endpoint" && entry.data.requirement === "credential"));
      const accessKeyEvents = logs.data.entries.filter((entry) => entry.event.startsWith("access-key."));
      assert.ok(accessKeyEvents.some((entry) => entry.event === "access-key.issued"));
      assert.ok(accessKeyEvents.some((entry) => entry.event === "access-key.admitted"));
      assert.ok(accessKeyEvents.some((entry) => entry.event === "access-key.revoked"));
      assert.equal(JSON.stringify(logs.data.entries).includes(issuedAccessKey.data.token), false);
      assert.equal(JSON.stringify(accessKeyEvents).includes("verifierDigest"), false);
      assert.equal(JSON.stringify(accessKeyEvents).includes("selector"), false);
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
