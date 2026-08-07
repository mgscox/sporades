// Behavioural equivalence between the two ways the deployed Capsule server bundle can be built.
//
// `createServerBundleSource` assembles the bundle by writing out `fn.toString()` for every entry in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` next to a hand-written preamble that re-declares the runtime's
// module constants. `createServerBundleModuleSource` builds the same program with esbuild from an
// ordinary module graph. Both exist right now; the emitted-list one is still the artifact that
// ships, and this file is the evidence that the other one could be.
//
// The two bundles are not textually comparable and are not meant to be. Each carries the Capsule
// config, the Server env, the Capsule module as a base64 data URL and the runtime's own source
// text, and esbuild renames and tree-shakes on top of that. So equivalence is established by
// running both and comparing what they answer, across the surfaces a deployed Capsule actually
// exposes: HTTP, the WebSocket transport where queries, mutations and auth live, the one-shot
// inspection actions for Jobs and Schedules, file storage, and each database adapter.
//
// Values that cannot be equal between two processes — row ids, timestamps, session tokens, ports,
// temp directories — are normalized. The normalizer is deliberately narrow: it rewrites UUIDs, ISO
// timestamps, opaque 32-character tokens, the temp directory and the origin, and nothing else. A
// `Set` that arrived as an array, a number that arrived as a string, a missing field or a changed
// error code all survive it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";

import { bundleServerCapsuleModule } from "../dist/bundle-pipeline.js";
import { ensureSealedServerEnvKeyPair, sealServerEnv, sealedServerEnvPaths } from "../dist/sealed-server-env.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";
import { createServerBundleSource } from "../dist/templates/server-bundle-template.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";

const BOOT_TIMEOUT_MS = 60_000;
const SOCKET_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------------------------
// The Capsule both bundles run.
//
// Handlers reach only for globals and `ctx`. Query and mutation handlers travel to the runtime as
// source text and are re-created with `new Function`, which sees globals and nothing else, so
// `globalThis.String` rather than `String` — the bare name is the Capsule field builder here.
// ---------------------------------------------------------------------------------------------
const CAPSULE_SOURCE = `
import { Boolean, Number, String, capsule, endpoint, job, mutation, query, schedule, table } from "sporades/server";

export default capsule({
  name: "bundle-equivalence",

  schema: {
    notes: table({
      text: String(),
      ownerId: String(),
      rank: Number(),
      pinned: Boolean().default(false),
    }).acl({
      read: () => true,
      write: ({ ctx, next }) => next.ownerId === ctx.auth.userId,
    }),
  },

  queries: {
    notes: query((ctx) =>
      ctx.db.notes.orderBy("rank", "asc").all().map((note) => ({
        text: note.text,
        rank: note.rank,
        pinned: note.pinned,
        mine: note.ownerId === ctx.auth.userId,
      })),
    ),
  },

  mutations: {
    addNote: mutation((ctx, input) => {
      ctx.db.notes.insert({
        text: globalThis.String(input?.text ?? ""),
        ownerId: ctx.auth.userId,
        rank: globalThis.Number(input?.rank ?? 0),
      });
      return { total: ctx.db.notes.all().length };
    }),
    denied: mutation((ctx) => {
      ctx.db.notes.insert({ text: "denied", ownerId: "somebody-else", rank: 99 });
      return { total: ctx.db.notes.all().length };
    }),
  },

  jobs: {
    tally: job((ctx) => ({ notes: ctx.db.notes.all().length })),
  },

  schedules: {
    tally: schedule({ expression: "*/5 * * * *", job: "tally", missedRun: "skip" }),
  },

  endpoints: {
    status: endpoint({ method: "GET", path: "/probe/status" }, (ctx) => ({
      status: 202,
      body: {
        method: ctx.request.method,
        path: ctx.request.path,
        query: ctx.request.query,
        auth: {
          isGuest: ctx.auth.isGuest,
          isAuthenticated: ctx.auth.isAuthenticated,
          provider: ctx.auth.provider,
        },
        sealedValue: ctx.env.PROBE_SEALED_VALUE ?? null,
        plainValue: ctx.env.PROBE_PLAIN_VALUE ?? null,
      },
    })),

    echo: endpoint({ method: "POST", path: "/probe/echo" }, (ctx) => ({
      status: 200,
      body: {
        body: ctx.request.body,
        contentType: ctx.request.headers["content-type"] ?? null,
      },
    })),

    listNotes: endpoint({ method: "GET", path: "/probe/notes" }, async (ctx) => ({
      status: 200,
      body: {
        notes: (await ctx.db.notes.orderBy("rank", "asc").all()).map((note) => ({ text: note.text, rank: note.rank })),
      },
    })),

    addNote: endpoint({ method: "POST", path: "/probe/notes" }, async (ctx) => {
      await ctx.db.notes.insert({
        text: globalThis.String(ctx.request.body?.text ?? ""),
        ownerId: ctx.auth.userId,
        rank: globalThis.Number(ctx.request.body?.rank ?? 0),
      });
      return { status: 200, body: { total: (await ctx.db.notes.all()).length } };
    }),

    enqueueJob: endpoint({ method: "POST", path: "/probe/jobs" }, async (ctx) => ({
      status: 200,
      body: {
        enqueued: await ctx.jobs.enqueue(
          "tally",
          { via: "endpoint" },
          {
            idempotencyKey: "probe-tally",
            // Far enough out that the Job stays queued for the inspection action to find, near
            // enough that the runtime's timer for it still fits in a 32-bit delay.
            availableAt: new globalThis.Date(globalThis.Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ),
      },
    })),

    reservedJob: endpoint({ method: "POST", path: "/probe/jobs/reserved" }, async (ctx) => {
      try {
        return { status: 200, body: { enqueued: await ctx.jobs.enqueue("_sporades_not_yours", {}) } };
      } catch (error) {
        return { status: 200, body: { failed: true, message: error.message, code: error.code ?? null, hint: error.hint ?? null } };
      }
    }),

    missingFile: endpoint({ method: "POST", path: "/probe/files/missing" }, async (ctx) => ({
      status: 200,
      body: await ctx.privileged.run(
        { operation: "probe.file.url", targetResourceKind: "files" },
        (privilegedCtx) => privilegedCtx.files.url("missing-file"),
      ),
    })),

    nestedPrivileged: endpoint({ method: "POST", path: "/probe/privileged/nested" }, async (ctx) => {
      try {
        return {
          status: 200,
          body: await ctx.privileged.run({ operation: "probe.outer", targetResourceKind: "files" }, (inner) =>
            inner.privileged.run({ operation: "probe.inner", targetResourceKind: "files" }, () => "unreachable"),
          ),
        };
      } catch (error) {
        return { status: 200, body: { failed: true, message: error.message, code: error.code ?? null } };
      }
    }),

    resetLink: endpoint({ method: "POST", path: "/probe/auth/reset" }, async (ctx) => {
      try {
        return { status: 200, body: await ctx.serverAuth.createEmailPasswordResetLink(globalThis.String(ctx.request.body?.email ?? "")) };
      } catch (error) {
        return { status: 200, body: { failed: true, message: error.message, code: error.code ?? null, hint: error.hint ?? null } };
      }
    }),

    verifyReset: endpoint({ method: "POST", path: "/probe/auth/verify" }, async (ctx) => {
      try {
        return { status: 200, body: await ctx.serverAuth.verifyPasswordResetCode(globalThis.String(ctx.request.body?.code ?? "")) };
      } catch (error) {
        return { status: 200, body: { failed: true, message: error.message, code: error.code ?? null, hint: error.hint ?? null } };
      }
    }),

    boom: endpoint({ method: "GET", path: "/probe/boom" }, () => {
      throw new Error("probe endpoint failure");
    }),
  },
});
`;

const CAPSULE_PUBLIC_ORIGIN = "https://capsule.example.com";

function capsuleConfig(extra = {}) {
  return {
    name: "bundle-equivalence",
    auth: { providers: { email: { enabled: true } } },
    __sporadesPublicOrigin: CAPSULE_PUBLIC_ORIGIN,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Building the pair.
// ---------------------------------------------------------------------------------------------

let capsuleModulePromise = null;
function compiledCapsuleModule() {
  capsuleModulePromise ??= bundleServerCapsuleModule({
    serverSource: CAPSULE_SOURCE,
    serverSourcePath: path.join(process.cwd(), "server", "index.ts"),
  });
  return capsuleModulePromise;
}

// Both builders, one set of inputs. Every equivalence claim below starts here so that neither
// bundle can quietly be built from something the other did not see.
async function buildBundlePair(inputs, options = {}) {
  const serverModuleSource = inputs.serverModuleSource ?? (await compiledCapsuleModule());
  const shared = { ...inputs, serverModuleSource };
  return {
    emitted: createServerBundleSource(shared),
    graph: await createServerBundleModuleSource({ ...shared, ...options }),
  };
}

// ---------------------------------------------------------------------------------------------
// Booting a bundle the way a container does: `node server.mjs`, nothing else on the command line.
// ---------------------------------------------------------------------------------------------

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A Capsule serves its page out of the active public tree, and the WebSocket transport will not
// accept a connection without the token that page carries, so a bundle with no public tree has no
// reachable WebSocket surface at all.
async function writePublicTree(dir, html) {
  const treeName = `1-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const treesDir = path.join(dir, ".sporades", "build", ".public-trees");
  await mkdir(path.join(treesDir, treeName, "assets"), { recursive: true });
  await writeFile(path.join(treesDir, treeName, "index.html"), html);
  await writeFile(path.join(treesDir, treeName, "assets", "app.js"), "export const probe = 1;\n");
  await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: treeName })}\n`);
}

async function bootBundle({ source, dir, env = {} }) {
  const bundlePath = path.join(dir, "server.mjs");
  await writeFile(bundlePath, source);
  const port = await reserveFreePort();
  const child = spawn(process.execPath, [bundlePath], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  let exited = null;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new Error(`Bundle exited before it listened (code ${exited.code}, signal ${exited.signal}).\n${stderr}\n${stdout}`);
    }
    const reached = await fetch(`${baseUrl}/__sporades/health/runtime`, {
      headers: { "x-sporades-host-probe": "equivalence" },
    }).then(() => true, () => false);
    if (reached) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Bundle did not start listening within ${BOOT_TIMEOUT_MS}ms.\n${stderr}\n${stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    baseUrl,
    get stderr() { return stderr; },
    async stop() {
      if (exited) return;
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
// `randomBytes(24|32).toString("base64url")` — session tokens, connection tokens, reset codes.
// Thirty-two characters and no separators: long enough that no runtime message, error code or
// constant in this Capsule reaches it.
const OPAQUE_PATTERN = /[A-Za-z0-9_-]{32,}/g;

function normalizeString(value, context) {
  let next = value;
  for (const [from, to] of context.literals) next = next.split(from).join(to);
  return next
    .replace(UUID_PATTERN, "<uuid>")
    .replace(TIMESTAMP_PATTERN, "<timestamp>")
    .replace(OPAQUE_PATTERN, "<opaque>");
}

// Numbers that are a measurement of this run rather than an answer.
const VOLATILE_NUMBER_KEYS = new Set(["latencyMs", "durationMs", "elapsedMs", "uptimeMs", "port", "pid"]);

function normalize(value, context, key = null) {
  if (typeof value === "string") return normalizeString(value, context);
  if (typeof value === "number") return VOLATILE_NUMBER_KEYS.has(key) ? "<number>" : value;
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, context, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([entryKey, entryValue]) => [entryKey, normalize(entryValue, context, entryKey)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The HTTP surface.
// ---------------------------------------------------------------------------------------------

const COMPARED_HEADERS = [
  "content-type",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "vary",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
];

const HTTP_SCRIPT = [
  { name: "health with probe header", path: "/__sporades/health/runtime", headers: { "x-sporades-host-probe": "equivalence" } },
  { name: "health without probe header", path: "/__sporades/health/runtime" },
  { name: "unknown path", path: "/definitely-not-here" },
  { name: "index page", path: "/" },
  { name: "public asset", path: "/assets/app.js" },
  { name: "traversal encoded", path: "/%2e%2e/escape.js" },
  { name: "traversal encoded separator", path: "/assets%2fapp.js" },
  { name: "endpoint status", path: "/probe/status?one=1&two=a&two=b" },
  { name: "endpoint status cross-origin", path: "/probe/status", headers: { origin: "https://evil.example.com" } },
  { name: "endpoint preflight", method: "OPTIONS", path: "/probe/status", headers: { origin: "https://capsule.example.com", "access-control-request-method": "GET" } },
  { name: "endpoint echo", method: "POST", path: "/probe/echo", json: { hello: "world", nested: { list: [1, 2, 3], flag: true } } },
  { name: "endpoint echo bad json", method: "POST", path: "/probe/echo", body: "{not json", headers: { "content-type": "application/json" } },
  { name: "endpoint notes empty", path: "/probe/notes" },
  { name: "endpoint add note", method: "POST", path: "/probe/notes", json: { text: "first", rank: 2 } },
  { name: "endpoint add second note", method: "POST", path: "/probe/notes", json: { text: "second", rank: 1 } },
  { name: "endpoint notes populated", path: "/probe/notes" },
  { name: "endpoint enqueue job", method: "POST", path: "/probe/jobs", json: {} },
  { name: "endpoint enqueue job again", method: "POST", path: "/probe/jobs", json: {} },
  { name: "endpoint reserved job name", method: "POST", path: "/probe/jobs/reserved", json: {} },
  { name: "endpoint privileged missing file", method: "POST", path: "/probe/files/missing", json: {} },
  { name: "endpoint nested privileged run", method: "POST", path: "/probe/privileged/nested", json: {} },
  { name: "endpoint reset link unknown email", method: "POST", path: "/probe/auth/reset", json: { email: "nobody@example.com" } },
  { name: "endpoint reset link malformed email", method: "POST", path: "/probe/auth/reset", json: { email: "not-an-email" } },
  { name: "endpoint verify bad reset code", method: "POST", path: "/probe/auth/verify", json: { code: "not-a-real-code" } },
  { name: "endpoint throwing handler", path: "/probe/boom" },
  { name: "endpoint wrong method", method: "DELETE", path: "/probe/status" },
  { name: "oauth callback no state", path: "/__sporades/auth/google/callback" },
  { name: "oauth callback unknown state", path: "/__sporades/auth/google/callback?state=abc&code=def" },
  { name: "oauth callback unknown provider", path: "/__sporades/auth/nosuch/callback?state=abc&code=def" },
  { name: "file upload unknown token", method: "PUT", path: "/__sporades/uploads/not-a-real-upload", body: "payload" },
  { name: "private file unknown id", path: "/__sporades/files/private/not-a-real-file" },
  { name: "public file unknown id", path: "/__sporades/files/public/not-a-real-file" },
];

async function driveHttpSurface(baseUrl, context) {
  const results = [];
  for (const step of HTTP_SCRIPT) {
    const headers = { ...step.headers };
    let body;
    if (step.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(step.json);
    } else if (step.body !== undefined) {
      body = step.body;
    }
    const response = await fetch(`${baseUrl}${step.path}`, { method: step.method ?? "GET", headers, body });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    results.push({
      name: step.name,
      status: response.status,
      headers: Object.fromEntries(COMPARED_HEADERS.map((header) => [header, response.headers.get(header)])),
      body: normalize(parsed, context),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// The WebSocket surface: queries, mutations, auth, preferences and file handles.
// ---------------------------------------------------------------------------------------------

function encodeWebSocketFrame(payload) {
  const data = Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset] & 0x0f;
    const lengthByte = buffer[offset + 1] & 0x7f;
    let payloadOffset = offset + 2;
    let payloadLength = lengthByte;
    if (lengthByte === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      payloadOffset += 2;
    } else if (lengthByte === 127) {
      if (buffer.length - offset < 10) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      payloadOffset += 8;
    }
    if (buffer.length < payloadOffset + payloadLength) break;
    const payload = buffer.subarray(payloadOffset, payloadOffset + payloadLength);
    offset = payloadOffset + payloadLength;
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    if (opcode === 0x8) messages.push(null);
  }
  return { messages, rest: buffer.subarray(offset) };
}

async function readConnectionToken(baseUrl) {
  const response = await fetch(baseUrl);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, `Expected the served page to carry a connection token, got: ${html.slice(0, 200)}`);
  return match[1];
}

// The Capsule declares a public origin, so the transport requires an `Origin` it recognises: a
// handshake without one is refused outright. Sending the configured origin is what a browser on the
// Capsule's own page does.
async function openBundleSocket(baseUrl, origin = CAPSULE_PUBLIC_ORIGIN) {
  const connectionToken = await readConnectionToken(baseUrl);
  const url = new URL("/__sporades/ws", baseUrl);
  url.searchParams.set("connectionToken", connectionToken);
  const socket = connect(Number(url.port), url.hostname);
  const received = [];
  let waiters = [];
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out opening the runtime WebSocket.")), SOCKET_TIMEOUT_MS);
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const marker = buffer.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const response = buffer.subarray(0, marker).toString("utf8");
        if (!response.startsWith("HTTP/1.1 101")) {
          clearTimeout(timeout);
          reject(new Error(`Unexpected WebSocket handshake response: ${response}`));
          return;
        }
        buffer = buffer.subarray(marker + 4);
        handshakeDone = true;
        clearTimeout(timeout);
        resolve();
      }
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.rest;
      for (const raw of decoded.messages) {
        if (raw === null) continue;
        received.push(JSON.parse(raw));
      }
      for (const waiter of waiters.slice()) {
        const match = received.find(waiter.predicate);
        if (match) {
          waiters = waiters.filter((entry) => entry !== waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(match);
        }
      }
    });
    socket.on("connect", () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Origin: ${origin}`,
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
  });

  return {
    received,
    send(message) {
      socket.write(encodeWebSocketFrame(JSON.stringify(message)));
    },
    waitFor(predicate) {
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timeout: setTimeout(() => {
            waiters = waiters.filter((entry) => entry !== waiter);
            reject(new Error(`Timed out waiting for a runtime WebSocket reply. Seen: ${received.map((entry) => entry.type).join(", ")}`));
          }, SOCKET_TIMEOUT_MS),
        };
        waiters.push(waiter);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

const WEBSOCKET_SCRIPT = [
  { id: "m1", type: "auth.get" },
  { id: "m2", type: "query.subscribe", query: "notes" },
  { id: "m3", type: "mutation.run", mutation: "addNote", args: [{ text: "over the socket", rank: 5 }] },
  { id: "m4", type: "query.subscribe", query: "nosuchquery" },
  { id: "m5", type: "mutation.run", mutation: "nosuchmutation", args: [] },
  { id: "m6", type: "mutation.run", mutation: "denied", args: [] },
  { id: "m7", type: "auth.signUp", provider: "email", credentials: { email: "probe@example.com", password: "correct horse battery staple" } },
  { id: "m8", type: "auth.get" },
  { id: "m9", type: "mutation.run", mutation: "addNote", args: [{ text: "signed in", rank: 3 }] },
  { id: "m10", type: "preferences.get" },
  { id: "m11", type: "preferences.update", preferences: { theme: "dark" } },
  { id: "m12", type: "preferences.get" },
  { id: "m13", type: "file.uploadUrl", file: { name: "probe.txt", type: "text/plain", size: 11, path: "/probe.txt" } },
  { id: "m14", type: "file.url", fileReference: "not-a-real-file" },
  { id: "m15", type: "file.publicUrl.create", fileReference: "not-a-real-file" },
  { id: "m16", type: "auth.sendPasswordResetLink", email: "probe@example.com" },
  { id: "m17", type: "auth.verifyPasswordResetCode", code: "not-a-real-code" },
  { id: "m18", type: "auth.signIn", provider: "email", credentials: { email: "probe@example.com", password: "wrong password" } },
  { id: "m19", type: "auth.signIn", provider: "email", credentials: { email: "probe@example.com", password: "correct horse battery staple" } },
  { id: "m20", type: "auth.signOut" },
  { id: "m21", type: "auth.get" },
  { id: "m22", type: "query.unsubscribe", subscriptionId: "m2" },
  { id: "m23", type: "nosuch.messagetype" },
];

async function driveWebSocketSurface(baseUrl, context) {
  const socket = await openBundleSocket(baseUrl);
  const replies = [];
  try {
    for (const message of WEBSOCKET_SCRIPT) {
      socket.send(message);
      const reply = await socket.waitFor((candidate) => candidate.id === message.id && !replies.includes(candidate));
      replies.push(reply);
    }
    // Mutations rebroadcast every open subscription on a later tick. Those frames are genuinely
    // asynchronous, so they are compared as a set rather than in arrival order.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const broadcasts = socket.received
      .filter((entry) => !replies.includes(entry))
      .map((entry) => JSON.stringify(normalize(entry, context)))
      .sort();
    return {
      replies: replies.map((reply, index) => ({ step: WEBSOCKET_SCRIPT[index].type, reply: normalize(reply, context) })),
      broadcasts,
    };
  } finally {
    socket.close();
  }
}

// ---------------------------------------------------------------------------------------------
// A full run of one bundle over every surface reachable from a booted Capsule.
// ---------------------------------------------------------------------------------------------

async function observeBundle({ source, dir, env }) {
  await writePublicTree(dir, "<!doctype html><html><head><title>probe</title></head><body><div id=\"app\"></div></body></html>");
  const booted = await bootBundle({ source, dir, env });
  const context = { literals: [[dir, "<dir>"], [booted.baseUrl, "<origin>"]] };
  try {
    const http = await driveHttpSurface(booted.baseUrl, context);
    const websocket = await driveWebSocketSurface(booted.baseUrl, context);
    return { http, websocket };
  } finally {
    await booted.stop();
  }
}

// Spawned asynchronously rather than with `spawnSync`, because some of these runs read their
// database from a fake service hosted inside this process: blocking the event loop to wait for the
// child would deadlock the two against each other.
// Every specifier the bundle would ask Node to resolve: static imports and re-exports, plus dynamic
// imports written with a literal.
//
// Parsed rather than pattern-matched. A bundle carries the Capsule's own entry source as a string
// constant, and esbuild emits a long multi-line constant as a template literal, so the Capsule's
// `import ... from "sporades/server"` sits in the output at the start of a line — as data. Only a
// parser can tell that apart from an import the runtime would actually perform.
function bundleImportSpecifiers(source) {
  const parsed = ts.createSourceFile("bundle.mjs", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return specifiers;
}

function runBundleAction(bundlePath, action, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath, "--sporades-action", action], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

test("the server bundle builds from a module graph and imports nothing but Node builtins", async () => {
  const { emitted, graph } = await buildBundlePair({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: CAPSULE_SOURCE,
  });

  // A deployed Capsule is `node /app/server.mjs` in an image with no `node_modules`, and the only
  // files mounted beside it are `sporades.json` and the public tree. Whatever the bundle imports at
  // runtime has to already be in Node.
  // `data:` is the other self-contained specifier: the emitted-list bundle loads the Capsule module
  // from a literal data URL, which carries its own bytes and reaches no filesystem. Everything else
  // would be a lookup the container cannot perform.
  for (const [label, source] of [["emitted", emitted], ["module graph", graph]]) {
    const specifiers = bundleImportSpecifiers(source);
    assert.ok(specifiers.length > 0, `${label} bundle declared no imports at all`);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("data:"),
        `${label} bundle imports ${specifier.slice(0, 80)}, which a deployed Capsule cannot resolve`,
      );
    }
    assert.ok(specifiers.some((specifier) => specifier.startsWith("node:")), `${label} bundle imported no Node builtin`);
  }

  // Both carry the same per-build values, which is the whole reason the bundle is generated rather
  // than shipped.
  for (const source of [emitted, graph]) {
    assert.match(source, /bundle-equivalence/);
    assert.match(source, /data:text\/javascript;base64,/);
  }
});

test("a Capsule built from a module graph answers identically to the emitted-list bundle across HTTP and the WebSocket transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-equivalence-"));
  try {
    const config = capsuleConfig();
    const serverEnv = { PROBE_PLAIN_VALUE: "plain-env-value" };
    const { emitted, graph } = await buildBundlePair({ config, serverEnv, serverSource: CAPSULE_SOURCE });

    const emittedDir = path.join(root, "emitted");
    const graphDir = path.join(root, "graph");
    await mkdir(emittedDir, { recursive: true });
    await mkdir(graphDir, { recursive: true });

    const emittedRun = await observeBundle({ source: emitted, dir: emittedDir });
    const graphRun = await observeBundle({ source: graph, dir: graphDir });

    // Guard against a normalizer that collapsed everything into agreement: the run has to have
    // actually exercised the runtime before its agreement means anything.
    assert.equal(emittedRun.http.length, HTTP_SCRIPT.length);
    assert.equal(emittedRun.websocket.replies.length, WEBSOCKET_SCRIPT.length);
    const health = emittedRun.http.find((entry) => entry.name === "health with probe header");
    assert.equal(health.status, 200, JSON.stringify(health));
    assert.equal(health.body.data.runtime.ready, true);
    assert.equal(health.body.data.checks.sqlite.ok, true);
    assert.equal(health.body.data.checks.fileStorage.ok, true);
    const notes = emittedRun.http.find((entry) => entry.name === "endpoint notes populated");
    assert.deepEqual(notes.body.notes, [{ rank: 1, text: "second" }, { rank: 2, text: "first" }]);
    const status = emittedRun.http.find((entry) => entry.name === "endpoint status");
    assert.equal(status.status, 202);
    assert.equal(status.body.plainValue, "plain-env-value");
    const signedIn = emittedRun.websocket.replies.find((entry, index) => WEBSOCKET_SCRIPT[index].id === "m19");
    assert.equal(signedIn.reply.type, "auth.signIn.result", JSON.stringify(signedIn));

    for (const [index, step] of HTTP_SCRIPT.entries()) {
      assert.deepEqual(graphRun.http[index], emittedRun.http[index], `HTTP surface differs at "${step.name}"`);
    }
    for (const [index, step] of WEBSOCKET_SCRIPT.entries()) {
      assert.deepEqual(
        graphRun.websocket.replies[index],
        emittedRun.websocket.replies[index],
        `WebSocket surface differs at "${step.type}" (${step.id})`,
      );
    }
    assert.deepEqual(graphRun.websocket.broadcasts, emittedRun.websocket.broadcasts, "subscription broadcasts differ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both bundles unseal a sealed Server env identically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-sealed-"));
  try {
    const paths = sealedServerEnvPaths(root);
    const keyPair = await ensureSealedServerEnvKeyPair(paths);
    const envelope = sealServerEnv({ PROBE_SEALED_VALUE: "sealed-env-value" }, keyPair.publicKey);
    await writeFile(paths.envelope, JSON.stringify(envelope));

    const { emitted, graph } = await buildBundlePair({
      config: capsuleConfig(),
      serverEnv: {},
      sealedServerEnv: { enabled: true },
      serverSource: CAPSULE_SOURCE,
    });

    const observed = [];
    for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      await writePublicTree(dir, "<!doctype html><html><body></body></html>");
      const booted = await bootBundle({
        source,
        dir,
        env: {
          SPORADES_SEALED_SERVER_ENV_PATH: paths.envelope,
          SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH: paths.privateKey,
        },
      });
      try {
        const response = await fetch(`${booted.baseUrl}/probe/status`);
        observed.push({ label, status: response.status, body: await response.json() });
      } finally {
        await booted.stop();
      }
    }

    assert.equal(observed[0].body.sealedValue, "sealed-env-value", "sealed Server env did not reach the Capsule");
    assert.equal(observed[0].status, 202);
    assert.deepEqual(
      { ...observed[1], label: "emitted" },
      { ...observed[0], label: "emitted" },
      "the two bundles disagree about a sealed Server env",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both bundles answer the one-shot Job and Schedule inspection actions identically on SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-sqlite-"));
  try {
    const { emitted, graph } = await buildBundlePair({
      config: capsuleConfig(),
      serverEnv: {},
      serverSource: CAPSULE_SOURCE,
    });

    const runs = [];
    for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      await writePublicTree(dir, "<!doctype html><html><body></body></html>");
      // Boot once so the Capsule's Schedules are registered and a Job row exists, then read the
      // same state back through the one-shot action the CLI and the host helper use.
      const booted = await bootBundle({ source, dir });
      try {
        await fetch(`${booted.baseUrl}/probe/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      } finally {
        await booted.stop();
      }
      const bundlePath = path.join(dir, "server.mjs");
      const context = { literals: [[dir, "<dir>"]] };
      runs.push({
        label,
        jobs: normalize(JSON.parse((await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir })).stdout), context),
        schedules: normalize(JSON.parse((await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir })).stdout), context),
        unsupported: await runBundleAction(bundlePath, "nope.inspect", { cwd: dir }),
      });
    }

    assert.equal(runs[0].jobs.ok, true, JSON.stringify(runs[0].jobs));
    assert.equal(runs[0].jobs.data.jobs.length, 1, "expected the enqueued Job to be inspectable");
    assert.equal(runs[0].jobs.data.jobs[0].handler, "tally");
    assert.equal(runs[0].schedules.data.schedules.length, 1, "expected the declared Schedule to be inspectable");
    assert.equal(runs[0].schedules.data.schedules[0].name, "tally");

    assert.deepEqual(runs[1].jobs, runs[0].jobs, "jobs.inspect differs between the two bundles");
    assert.deepEqual(runs[1].schedules, runs[0].schedules, "schedules.inspect differs between the two bundles");
    assert.equal(runs[1].unsupported.status, runs[0].unsupported.status);
    assert.equal(runs[1].unsupported.stdout, runs[0].unsupported.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("neither bundle evaluates Capsule code on the one-shot action path", async () => {
  // ADR-0028. The emitted-list bundle keeps this true by importing the Capsule's data URL only when
  // no action was requested. The module-graph bundle has to keep it true through esbuild, which is
  // why the entry loads that URL through a variable: a literal would let esbuild resolve the module
  // at build time and pull the Capsule into the graph, where it would be evaluated on every path.
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-purity-"));
  try {
    const marker = path.join(root, "capsule-evaluated");
    const inputs = {
      config: capsuleConfig(),
      serverEnv: {},
      serverSource: "",
      serverModuleSource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes"); export default {};`,
    };
    const { emitted, graph } = await buildBundlePair(inputs);

    for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      const result = await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.deepEqual(
        JSON.parse(result.stdout),
        { ok: true, data: { capsule: { name: "bundle-equivalence" }, jobs: [] }, error: null },
        `${label} action output`,
      );
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" }, `${label} evaluated the Capsule module`);
      await assert.rejects(readFile(path.join(dir, "data", "data.db")), { code: "ENOENT" }, `${label} opened a database`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both bundles read the same Postgres state through the inspection adapter", {
  skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres adapter integration test.",
}, async () => {
  const { createPostgresDatabaseAdapter } = await import("../dist/server-runtime-source.js");
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-postgres-"));
  const adapter = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL });
  const sql = adapter.dialect.sql;
  try {
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_jobs]"));
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_schedules]"));
    await adapter.exec(sql("CREATE TABLE [sporades_jobs] ([id] TEXT, [handler] TEXT, [enqueuedByUserId] TEXT, [actorUserId] TEXT, [payload] TEXT, [status] TEXT, [availableAt] TEXT, [attempts] INTEGER, [idempotencyKey] TEXT, [result] TEXT, [failure] TEXT, [createdAt] TEXT, [startedAt] TEXT, [completedAt] TEXT, [failedAt] TEXT, [retryJson] TEXT, [attemptHistory] TEXT, [cancelRequestedAt] TEXT, [leaseExpiresAt] TEXT)"));
    await adapter.prepare(sql("INSERT INTO [sporades_jobs] VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")).run(
      "pg-equivalence", "tally", "user-1", "__privileged__", '{"secret":true}', "queued", "2026-01-01T00:00:00.000Z", 0,
      "an-idempotency-key", null, null, "2026-01-01T00:00:00.000Z", null, null, null, '{"maxAttempts":3,"delayMs":25}', "[]", null, null,
    );

    const config = capsuleConfig({ services: { database: { engine: "postgres" } } });
    const { emitted, graph } = await buildBundlePair({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });

    const env = {
      SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
      SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
    };
    const runs = [];
    for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      runs.push({
        label,
        jobs: await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir, env }),
        schedules: await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir, env }),
      });
    }

    // Both read the same rows out of the same database, so this comparison needs no normalization
    // at all: the bytes on stdout have to match.
    const emittedJobs = JSON.parse(runs[0].jobs.stdout);
    assert.equal(emittedJobs.ok, true, runs[0].jobs.stdout + runs[0].jobs.stderr);
    assert.equal(emittedJobs.data.jobs.length, 1);
    assert.equal(emittedJobs.data.jobs[0].id, "pg-equivalence");
    assert.equal(emittedJobs.data.jobs[0].actor.mode, "privileged-server-role");
    assert.equal("payload" in emittedJobs.data.jobs[0], false);

    assert.equal(runs[1].jobs.stdout, runs[0].jobs.stdout, "Postgres jobs.inspect differs between the two bundles");
    assert.equal(runs[1].jobs.status, runs[0].jobs.status);
    assert.equal(runs[1].schedules.stdout, runs[0].schedules.stdout, "Postgres schedules.inspect differs between the two bundles");
    assert.equal(runs[1].schedules.status, runs[0].schedules.status);
  } finally {
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_jobs]")).catch(() => {});
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_schedules]")).catch(() => {});
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("both bundles read the same libSQL state through the inspection adapter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-libsql-"));
  try {
    await withFakeLibsqlService(path.join(root, "remote.db"), async ({ url }) => {
      const { createLibsqlDatabaseAdapter } = await import("../dist/server-runtime-source.js");
      // Seeded so the comparison has something to disagree about: two empty results match each
      // other whatever the bundles do.
      const seed = await createLibsqlDatabaseAdapter({ url });
      try {
        await seed.exec("CREATE TABLE sporades_jobs (id TEXT, handler TEXT, enqueuedByUserId TEXT, actorUserId TEXT, payload TEXT, status TEXT, availableAt TEXT, attempts INTEGER, idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT, startedAt TEXT, completedAt TEXT, failedAt TEXT, retryJson TEXT, attemptHistory TEXT, cancelRequestedAt TEXT, leaseExpiresAt TEXT)");
        await seed.prepare("INSERT INTO sporades_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          "libsql-equivalence", "tally", "user-1", "__privileged__", '{"secret":true}', "queued", "2026-01-01T00:00:00.000Z", 0,
          "an-idempotency-key", null, null, "2026-01-01T00:00:00.000Z", null, null, null, '{"maxAttempts":3,"delayMs":25}', "[]", null, null,
        );
      } finally {
        await seed.close();
      }

      const config = capsuleConfig({ services: { database: { engine: "libsql" } } });
      const { emitted, graph } = await buildBundlePair({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });
      const env = {
        SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
        SPORADES_SERVICE_DATABASE_URL: url,
      };
      const runs = [];
      for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
        const dir = path.join(root, label);
        await mkdir(dir, { recursive: true });
        const bundlePath = path.join(dir, "server.mjs");
        await writeFile(bundlePath, source);
        runs.push({
          jobs: await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir, env }),
          schedules: await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir, env }),
        });
      }
      const emittedJobs = JSON.parse(runs[0].jobs.stdout);
      assert.equal(emittedJobs.ok, true, runs[0].jobs.stdout + runs[0].jobs.stderr);
      assert.equal(emittedJobs.data.jobs.length, 1, runs[0].jobs.stdout);
      assert.equal(emittedJobs.data.jobs[0].id, "libsql-equivalence");
      assert.equal("payload" in emittedJobs.data.jobs[0], false);
      assert.equal(runs[1].jobs.stdout, runs[0].jobs.stdout, "libSQL jobs.inspect differs between the two bundles");
      assert.equal(runs[1].schedules.stdout, runs[0].schedules.stdout, "libSQL schedules.inspect differs between the two bundles");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both bundles drive S3-compatible file storage identically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-s3-"));
  try {
    await withFakeS3CompatibleService(async ({ endpoint }) => {
      const config = capsuleConfig({ services: { storage: { kind: "storage", engine: "minio" } } });
      const { emitted, graph } = await buildBundlePair({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });
      // The credentials the fake service verifies against.
      const env = {
        SPORADES_SERVICE_STORAGE_ENGINE: "minio",
        SPORADES_SERVICE_STORAGE_ENDPOINT: endpoint,
        SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
        SPORADES_SERVICE_STORAGE_REGION: "eu-west-2",
        SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
        SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
        SPORADES_SERVICE_STORAGE_NAMESPACE: "bundle-equivalence",
      };

      const observed = [];
      for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
        const dir = path.join(root, label);
        await mkdir(dir, { recursive: true });
        await writePublicTree(dir, "<!doctype html><html><body></body></html>");
        const booted = await bootBundle({ source, dir, env });
        const context = { literals: [[dir, "<dir>"], [booted.baseUrl, "<origin>"], [endpoint, "<s3>"]] };
        try {
          const health = await fetch(`${booted.baseUrl}/__sporades/health/runtime`, {
            headers: { "x-sporades-host-probe": "equivalence" },
          });
          const socket = await openBundleSocket(booted.baseUrl);
          const uploads = [];
          try {
            for (const message of [
              { id: "s1", type: "file.uploadUrl", file: { name: "probe.txt", type: "text/plain", size: 11, path: "/probe.txt" } },
              { id: "s2", type: "file.url", fileReference: "not-a-real-file" },
            ]) {
              socket.send(message);
              uploads.push(normalize(await socket.waitFor((candidate) => candidate.id === message.id), context));
            }
          } finally {
            socket.close();
          }
          observed.push({
            status: health.status,
            health: normalize(await health.json(), context),
            uploads,
          });
        } finally {
          await booted.stop();
        }
      }

      assert.equal(observed[0].status, 200, JSON.stringify(observed[0]));
      assert.equal(observed[0].health.data.checks.fileStorage.ok, true, "the fake S3 service was not exercised");
      assert.deepEqual(observed[1], observed[0], "the two bundles disagree about S3-compatible file storage");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The constants.
//
// The emitted-list bundle re-declares each of these in a preamble, serialized from the runtime
// module's own declaration. The module-graph bundle closes over the declaration itself. Comparing
// the two by reading the generated text would prove nothing about what a Capsule executes, so both
// bundles are booted and asked what the name is actually bound to — including its type, because a
// `Set` that arrived as an array or a number that arrived as a string is exactly the silent class
// this whole effort exists to remove.
// ---------------------------------------------------------------------------------------------

const RUNTIME_SOURCE_CONSTANTS = [
  "PRIVILEGED_AUTH_USER_ID",
  "EMAIL_SIGN_IN_FAILURE_LIMIT",
  "EMAIL_SIGN_IN_THROTTLE_WINDOW_MS",
  "EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES",
  "EMAIL_SIGN_IN_THROTTLE_FIELD",
  "PASSWORD_RESET_THROTTLE_FIELD",
  "PASSWORD_RESET_DEFAULT_PATH",
  "PASSWORD_RESET_DEFAULT_TTL_MS",
  "PASSWORD_RESET_MIN_TTL_MS",
  "PASSWORD_RESET_MAX_TTL_MS",
  "PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL",
  "RESERVED_JOB_NAME_PREFIX",
  "PASSWORD_RESET_MAIL_JOB",
  "PRIVILEGED_AUDIT_SCHEMA",
  "PRIVILEGED_AUDIT_ACTOR_KINDS",
  "PRIVILEGED_AUDIT_OUTCOMES",
  "ACL_HELPER_STATE",
  "SAFE_INSPECTION_PRAGMAS",
  "SIDE_EFFECT_SQL_KEYWORDS",
  "SIDE_EFFECT_SQL_FUNCTIONS",
];
const PROBED_CONSTANTS = [...RUNTIME_SOURCE_CONSTANTS, "PUBLIC_TREE_LIMITS"];

// Identical in both bundles. Each resolves the names in its own top-level scope: the emitted-list
// bundle's preamble declarations, the module-graph bundle's imported bindings.
function constantProbeReport(outputPath) {
  return `
import { writeFileSync as __probeWriteFileSync } from "node:fs";
const __probeDescribe = (value) => {
  if (typeof value === "symbol") return { type: "symbol", description: value.description };
  if (value instanceof Set) return { type: "Set", values: [...value].map(__probeDescribe) };
  if (value instanceof Map) return { type: "Map", entries: [...value].map(([k, v]) => [k, __probeDescribe(v)]) };
  if (Array.isArray(value)) return { type: "Array", values: value.map(__probeDescribe) };
  if (value === null) return { type: "null" };
  if (typeof value === "object") return { type: "object", entries: Object.entries(value).map(([k, v]) => [k, __probeDescribe(v)]) };
  return { type: typeof value, value };
};
__probeWriteFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
${PROBED_CONSTANTS.map((name) => `  ${name}: __probeDescribe(${name}),`).join("\n")}
}, null, 2));
process.exit(0);
`;
}

test("every constant the preamble serializes carries the same value and the same type in the module-graph bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-constants-"));
  try {
    const inputs = { config: capsuleConfig(), serverEnv: {}, serverSource: CAPSULE_SOURCE };
    const emittedReport = path.join(root, "emitted.json");
    const graphReport = path.join(root, "graph.json");

    // The emitted-list bundle declares every one of these at its own top level, so the report can
    // name them directly. The module-graph bundle resolves names through imports, so its copy of
    // the same report brings the bindings in — which is the difference under test.
    const emitted = createServerBundleSource({ ...inputs, serverModuleSource: await compiledCapsuleModule() })
      + constantProbeReport(emittedReport);
    const graph = await createServerBundleModuleSource({
      ...inputs,
      serverModuleSource: await compiledCapsuleModule(),
      epilogue: [
        `import { ${RUNTIME_SOURCE_CONSTANTS.join(", ")} } from "../server-runtime-source.js";`,
        `import { PUBLIC_TREE_LIMITS } from "../public-tree-contract.js";`,
        constantProbeReport(graphReport),
      ].join("\n"),
    });

    for (const [label, source] of [["emitted", emitted], ["graph", graph]]) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      await writePublicTree(dir, "<!doctype html><html><body></body></html>");
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      const port = await reserveFreePort();
      const result = spawnSync(process.execPath, [bundlePath], {
        cwd: dir,
        env: { ...process.env, PORT: String(port) },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${label} constant probe failed: ${result.stderr}`);
    }

    const emittedConstants = JSON.parse(await readFile(emittedReport, "utf8"));
    const graphConstants = JSON.parse(await readFile(graphReport, "utf8"));

    assert.deepEqual(Object.keys(emittedConstants).sort(), [...PROBED_CONSTANTS].sort());

    // The report has to have observed real structure, or agreement between two empty objects would
    // pass for equivalence.
    assert.equal(emittedConstants.EMAIL_SIGN_IN_FAILURE_LIMIT.type, "number");
    assert.equal(emittedConstants.PRIVILEGED_AUDIT_ACTOR_KINDS.type, "Set");
    assert.equal(emittedConstants.SIDE_EFFECT_SQL_KEYWORDS.type, "Set");
    assert.ok(emittedConstants.SIDE_EFFECT_SQL_KEYWORDS.values.length > 5);
    assert.equal(emittedConstants.ACL_HELPER_STATE.type, "symbol");
    assert.equal(emittedConstants.PUBLIC_TREE_LIMITS.type, "object");

    for (const name of PROBED_CONSTANTS) {
      assert.deepEqual(graphConstants[name], emittedConstants[name], `constant ${name} differs between the two bundles`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the module-graph bundle resolves the runtime's own symbol rather than a reconstruction of it", async () => {
  // A `Symbol` has no serialization, so the emitted-list preamble rebuilds `ACL_HELPER_STATE` from
  // its description and a bundled Capsule ends up holding a different Symbol than the runtime
  // module's. That is safe there because the bundle is the only writer and the only reader of that
  // key. Building from a module graph removes the second Symbol rather than reproducing it, so this
  // records the one place where the new bundle is deliberately not a copy of the old one.
  const emitted = createServerBundleSource({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: "",
    serverModuleSource: "export default {};",
  });
  assert.match(emitted, /const ACL_HELPER_STATE = Symbol\("sporades\.aclHelperState"\);/);

  const graph = await createServerBundleModuleSource({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: "",
    serverModuleSource: "export default {};",
    epilogue: `import { ACL_HELPER_STATE as __probeAclHelperState } from "../server-runtime-source.js";\nglobalThis.__probeAclHelperState = __probeAclHelperState;`,
  });
  assert.equal(graph.includes('Symbol("sporades.aclHelperState")'), true);
});

test("the module-graph bundle is reproducible for identical inputs", async () => {
  const inputs = {
    config: capsuleConfig(),
    serverEnv: { PROBE_PLAIN_VALUE: "plain" },
    serverSource: CAPSULE_SOURCE,
    serverModuleSource: await compiledCapsuleModule(),
  };
  const first = await createServerBundleModuleSource(inputs);
  const second = await createServerBundleModuleSource(inputs);
  assert.equal(first, second, "two builds of the same inputs produced different bundles");
});

// esbuild re-prints a long multi-line string constant as a template literal, so the Capsule's own
// entry source — which the bundle carries verbatim as `sporadesServerSource` and hands to
// `openDevDatabase`, where handler bodies are extracted from it — is re-quoted on the way through
// the module-graph builder rather than passed along as written. Backticks, `${`, backslashes and
// the two Unicode line separators are exactly what a re-quoting can get wrong, and getting it wrong
// would corrupt a Capsule's handlers rather than fail a build.
const TRICKY_SERVER_SOURCE = [
  "// a backtick ` and an un-interpolation ${notAnInterpolation} and a lone $ and {",
  "const template = `nested ${\"interpolation\"} inside a template`;",
  "const quotes = \"double \\\" single ' backslash \\\\ and a \\u0000-free tail\";",
  "// unicode line separator:\u2028 paragraph separator:\u2029 end",
  "// astral: 🚀 accented: é cjk: 中文",
  "import { capsule } from \"sporades/server\";",
  "export default capsule({ name: \"tricky\", schema: {} });",
  "",
].join("\r\n");

test("both bundles carry the Capsule's entry source byte for byte", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-source-"));
  try {
    const reportPath = (label) => path.join(root, `${label}.txt`);
    const epilogue = (label) => `
import { writeFileSync as __probeWriteFileSync } from "node:fs";
__probeWriteFileSync(${JSON.stringify(reportPath(label))}, sporadesServerSource, "utf8");
process.exit(0);
`;
    const inputs = { config: capsuleConfig(), serverEnv: {}, serverSource: TRICKY_SERVER_SOURCE, serverModuleSource: "export default {};" };
    const bundles = [
      ["emitted", createServerBundleSource(inputs) + epilogue("emitted")],
      ["graph", await createServerBundleModuleSource({ ...inputs, epilogue: epilogue("graph") })],
    ];

    for (const [label, source] of bundles) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      const port = await reserveFreePort();
      const result = spawnSync(process.execPath, [bundlePath], {
        cwd: dir,
        env: { ...process.env, PORT: String(port) },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${label} source probe failed: ${result.stderr}`);
    }

    const emittedSource = await readFile(reportPath("emitted"), "utf8");
    const graphSource = await readFile(reportPath("graph"), "utf8");
    assert.equal(emittedSource, TRICKY_SERVER_SOURCE, "the emitted-list bundle altered the Capsule entry source");
    assert.equal(graphSource, TRICKY_SERVER_SOURCE, "the module-graph bundle altered the Capsule entry source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the module-graph builder refuses a bundle that would need node_modules at runtime", async () => {
  // The guard that keeps the deployment constraint true by construction. A Capsule runs with
  // `server.mjs` mounted read-only into an image that has no `node_modules`, so an unresolved bare
  // specifier has to fail the build rather than the container.
  await assert.rejects(
    createServerBundleModuleSource({
      config: capsuleConfig(),
      serverEnv: {},
      serverSource: "",
      serverModuleSource: "export default {};",
      epilogue: `import { createRequire as __probeRequire } from "definitely-not-a-real-package";\nglobalThis.__probe = __probeRequire;`,
    }),
    (error) => {
      assert.match(error.message, /Server bundle failed/);
      return true;
    },
  );
});
