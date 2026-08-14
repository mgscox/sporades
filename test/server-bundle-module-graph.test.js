// What a deployed Capsule server bundle answers, driven the way a container drives it.
//
// This file was an *equivalence* harness for most of its life. Two builders existed: one assembled
// the bundle by writing out `fn.toString()` for every entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS`
// next to a hand-written preamble that re-declared the runtime's module constants, and
// `createServerBundleModuleSource` built the same program with esbuild from an ordinary module
// graph. Every test here built both, ran both, and compared what they answered — across HTTP, the
// WebSocket transport where queries, mutations and auth live, the one-shot inspection actions for
// Jobs and Schedules, file storage, and each database adapter.
//
// Ticket 05 deleted the emitted-list builder, so there is no longer a second answer to compare
// against. What survives is the half that was always the substance: booting the artifact a release
// actually ships and asserting what it answers. The comparisons are gone; the concrete assertions
// they sat next to are not, and several tests here gained assertions in the conversion, because a
// claim that used to be carried by "the other bundle said the same" now has to be written down.
//
// Values that cannot be stable between runs — row ids, timestamps, session tokens, ports, temp
// directories — are still normalized, because the recorded expectations below are compared against
// them. The normalizer is deliberately narrow: it rewrites UUIDs, ISO timestamps, opaque
// 32-character tokens, the temp directory and the origin, and nothing else. A `Set` that arrived as
// an array, a number that arrived as a string, a missing field or a changed error code all survive
// it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { bundleServerCapsuleModule } from "../dist/bundle-pipeline.js";
import { ensureSealedServerEnvKeyPair, sealServerEnv, sealedServerEnvPaths } from "../dist/sealed-server-env.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";
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

const TEAMS_CAPSULE_SOURCE = `
import { capsule, query } from "sporades/server";

export default capsule({
  name: "bundle-teams",
  schema: {},
  queries: {
    ownTeams: query((ctx) => ctx.teams.list()),
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

// One bundle, built the way `createBundle` builds the one that ships. This returned a pair while
// two builders existed; the Capsule module still defaults to the compiled fixture so that a test
// which does not care about the Capsule's own source cannot accidentally build from nothing.
async function buildBundle(inputs, options = {}) {
  const serverModuleSource = inputs.serverModuleSource ?? (await compiledCapsuleModule());
  return createServerBundleModuleSource({ ...inputs, serverModuleSource, ...options });
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
//
// Thirty-two characters and no separators. That is long enough that nothing *this* Capsule's
// responses carry reaches it, which is a narrower claim than it looks: the runtime does contain
// codes at or past that length — `UNSUPPORTED_PRIVILEGED_FILE_OPERATION` is 37 — so a script that
// provoked one would have it erased, and a difference in it would be hidden. None of the responses
// compared here contain one; a new step that might should widen the guard rather than trust this.
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
  // Both spellings. The runtime picks the header name from `security.csp.mode`, and the default is
  // `report-only` — comparing only the enforce spelling silently compared nothing at all.
  "content-security-policy",
  "content-security-policy-report-only",
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
async function openBundleSocket(baseUrl, origin = CAPSULE_PUBLIC_ORIGIN, requestHost = null) {
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
        `Host: ${requestHost ?? url.host}`,
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
  // Both subscriptions are opened before the first mutation, and neither is retired until the end.
  //
  // That ordering is what makes the rebroadcast count deterministic. A successful `mutation.run`
  // rebroadcasts every open subscription on a later tick, so a subscribe that happens *between* a
  // mutation and its deferred rebroadcast may or may not be included — the set of open
  // subscriptions is read when the tick runs, not when the mutation was sent. With a subscribe
  // interleaved among the mutations this script produced three or four frames depending on the
  // run. With every subscription open before the first mutation, each of the two successful
  // mutations rebroadcasts exactly the same two subscriptions.
  //
  // `nosuchquery` is one of them on purpose: subscribing to an unknown query still registers a
  // subscription, since the runtime does not reject the name at subscribe time, so it re-emits its
  // failure frame alongside the good one. That is worth comparing rather than avoiding.
  { id: "m2", type: "query.subscribe", query: "notes" },
  { id: "m4", type: "query.subscribe", query: "nosuchquery" },
  { id: "m3", type: "mutation.run", mutation: "addNote", args: [{ text: "over the socket", rank: 5 }] },
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

// Blocks until the socket has produced no new frame for `idleMs`, or `timeoutMs` elapses. The
// timeout is a backstop against a runtime that never goes quiet, not the normal exit: reaching it
// would mean frames were still arriving, and the comparison that follows would be reading a partial
// set — so it is deliberately far longer than any rebroadcast this script provokes.
async function drainUntilQuiet(socket, { idleMs = 1500, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = socket.received.length;
  let lastChange = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (socket.received.length !== seen) {
      seen = socket.received.length;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= idleMs) {
      return;
    }
    if (Date.now() >= deadline) return;
  }
}

async function driveWebSocketSurface(baseUrl, context) {
  const socket = await openBundleSocket(baseUrl);
  const replies = [];
  try {
    for (const message of WEBSOCKET_SCRIPT) {
      socket.send(message);
      const reply = await socket.waitFor((candidate) => candidate.id === message.id && !replies.includes(candidate));
      replies.push(reply);
    }
    // A successful `mutation.run` rebroadcasts every open subscription on a later tick, so the
    // socket keeps producing frames after the last reply has been read. Both open subscriptions
    // rebroadcast: `nosuchquery` registers a subscription like any other — the runtime does not
    // reject an unknown query name at subscribe time — so it re-emits its error frame every time
    // too, which is why the frame count is not simply "one per mutation".
    //
    // Drained to quiescence rather than for a fixed interval. A fixed window compares whichever
    // frames happened to arrive in time, and the two bundles run as separate processes with
    // independent windows, so a slow tick in one of them shows up as a difference in multiplicity
    // that has nothing to do with the bundles. Waiting for the socket to go quiet lets each side
    // reach its own complete set, which keeps the count meaningful: a genuinely missing or
    // duplicated broadcast still fails, because quiescence ends either way and the sets differ.
    await drainUntilQuiet(socket);
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

// A Schedule row the inspection path accepts, for the engines whose fixtures are seeded by hand.
// Mirrors the runtime's own DDL. `latestOutcome` and every `latest*` column stay null so the
// summary needs no matching Job row.
const SCHEDULES_DDL =
  "CREATE TABLE [sporades_schedules] ([name] TEXT PRIMARY KEY, [definitionFingerprint] TEXT NOT NULL, " +
  "[expression] TEXT NOT NULL, [effectiveTimezone] TEXT NOT NULL, [missedRunPolicy] TEXT NOT NULL, " +
  "[enabled] INTEGER NOT NULL, [nextOccurrence] TEXT, [latestScheduledFor] TEXT, [latestOutcome] TEXT, " +
  "[latestJobId] TEXT, [latestErrorCode] TEXT)";
const SCHEDULES_INSERT = "INSERT INTO [sporades_schedules] VALUES (?,?,?,?,?,?,?,?,?,?,?)";
const schedulesRow = (name) => [name, "fingerprint-1", "*/5 * * * *", "UTC", "skip", 1, "2026-01-01T00:00:00.000Z", null, null, null, null];

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
  const source = await buildBundle({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: CAPSULE_SOURCE,
  });

  // A deployed Capsule is `node /app/server.mjs` in an image with no `node_modules`, and the only
  // files mounted beside it are `sporades.json` and the public tree. Whatever the bundle imports at
  // runtime has to already be in Node.
  // `data:` is the other self-contained specifier: the bundle loads the Capsule module from a data
  // URL, which carries its own bytes and reaches no filesystem. Everything else would be a lookup
  // the container cannot perform.
  const specifiers = bundleImportSpecifiers(source);
  assert.ok(specifiers.length > 0, "bundle declared no imports at all");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:") || specifier.startsWith("data:"),
      `bundle imports ${specifier.slice(0, 80)}, which a deployed Capsule cannot resolve`,
    );
  }
  assert.ok(specifiers.some((specifier) => specifier.startsWith("node:")), "bundle imported no Node builtin");

  // The per-build values, which are the whole reason the bundle is generated rather than shipped.
  assert.match(source, /bundle-equivalence/);
  assert.match(source, /data:text\/javascript;base64,/);

  // And a migrated domain, reached through `server-runtime-source`'s import of it. This was the
  // check that a batch had not moved a domain out of the emitted list while forgetting to add it to
  // the carrier — a mistake that left this bundle complete and the shipping one missing every name.
  // There is one bundle now and that particular mistake is not available, but the assertion is kept
  // pointed at the artifact: it is also what would catch a domain dropped by tree-shaking because
  // nothing imports it any more, which is this mechanism's own version of the same silence.
  for (const name of ["createMailRuntime", "buildSmtpMessage", "encodeMimeHeaderValue", "validateMailConfig"]) {
    assert.match(source, new RegExp(`function ${name}\\(`), `bundle is missing ${name}`);
  }
  // The domain's sockets are opened through a dynamic import of a builtin (ADR-0042).
  assert.match(source, /import\("node:tls"\)/, "bundle lost the SMTP TLS import");
});

test("a Capsule built from a module graph answers the HTTP and WebSocket surfaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-surface-"));
  try {
    const config = capsuleConfig();
    const serverEnv = { PROBE_PLAIN_VALUE: "plain-env-value" };
    const source = await buildBundle({ config, serverEnv, serverSource: CAPSULE_SOURCE });

    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    const run = await observeBundle({ source, dir });

    // Every step of both scripts has to have actually run. This guarded the comparison against a
    // normalizer that had collapsed everything into agreement; with nothing to compare against it
    // guards the assertions below against a run that answered fewer steps than it was given.
    assert.equal(run.http.length, HTTP_SCRIPT.length);
    assert.equal(run.websocket.replies.length, WEBSOCKET_SCRIPT.length);
    const health = run.http.find((entry) => entry.name === "health with probe header");
    assert.equal(health.status, 200, JSON.stringify(health));
    assert.equal(health.body.data.runtime.ready, true);
    assert.equal(health.body.data.checks.sqlite.ok, true);
    assert.equal(health.body.data.checks.fileStorage.ok, true);
    const notes = run.http.find((entry) => entry.name === "endpoint notes populated");
    assert.deepEqual(notes.body.notes, [{ rank: 1, text: "second" }, { rank: 2, text: "first" }]);
    const status = run.http.find((entry) => entry.name === "endpoint status");
    assert.equal(status.status, 202);
    assert.equal(status.body.plainValue, "plain-env-value");
    const badJson = run.http.find((entry) => entry.name === "endpoint echo bad json");
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "INVALID_JSON_REQUEST");
    for (const [name, code] of [["oauth callback no state", "OAUTH_INVALID_CALLBACK"], ["oauth callback unknown state", "OAUTH_INVALID_STATE"]]) {
      const callback = run.http.find((entry) => entry.name === name);
      assert.equal(callback.status, 400, JSON.stringify(callback));
      assert.equal(callback.body.error.code, code);
    }
    const signedIn = run.websocket.replies.find((entry, index) => WEBSOCKET_SCRIPT[index].id === "m19");
    assert.equal(signedIn.reply.type, "auth.signIn.result", JSON.stringify(signedIn));
    // Two successful mutations, two open subscriptions, one rebroadcast each.
    assert.deepEqual(
      run.websocket.broadcasts.map((entry) => { const frame = JSON.parse(entry); return `${frame.id}:${frame.type}`; }),
      ["m2:query.result", "m2:query.result", "m4:query.result", "m4:query.result"],
    );

    // Which steps the runtime answers with a 5xx, pinned exactly. The pairwise comparison never made
    // this claim: a step that started failing in *both* bundles compared equal and passed, so this
    // is a property of the runtime that the equivalence harness structurally could not see.
    //
    // Only a throwing Capsule handler is honestly a 500. Malformed endpoint JSON and invalid OAuth
    // callbacks are client errors, with the provider-validation case covered in oauth-provider.test.js
    // using state that genuinely reaches provider validation.
    //
    // Pinned rather than tolerated, so the set cannot grow quietly.
    assert.deepEqual(
      HTTP_SCRIPT.filter((_step, index) => run.http[index].status >= 500).map((step) => step.name),
      [
        "endpoint throwing handler",
      ],
    );
    // And which WebSocket steps answer an error frame, pinned the same way and for the same reason.
    // Six of them do, and every one is a refusal the script asks for on purpose — a non-object
    // preferences patch, an unknown File reference, a public URL for a file that is not there, a
    // bad password-reset code, a sign-in with wrong credentials, and an unregistered message type.
    // The transport refusing exactly these and nothing else is the claim; that six error frames
    // came back at all is not, on its own, worth anything.
    assert.deepEqual(
      WEBSOCKET_SCRIPT
        .filter((_step, index) => run.websocket.replies[index].reply?.type === "error")
        .map((step) => `${step.type}:${step.id}`),
      [
        "preferences.update:m11",
        "file.url:m14",
        "file.publicUrl.create:m15",
        "auth.verifyPasswordResetCode:m17",
        "auth.signIn:m18",
        "nosuch.messagetype:m23",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a generated server bundle lazily lists the current linked user's singleton Team", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-teams-"));
  try {
    const serverModuleSource = await bundleServerCapsuleModule({
      serverSource: TEAMS_CAPSULE_SOURCE,
      serverSourcePath: path.join(root, "server", "index.ts"),
    });
    const source = await buildBundle({
      config: capsuleConfig({ name: "bundle-teams", auth: { providers: { anonymous: true, email: true } } }),
      serverEnv: {},
      serverSource: TEAMS_CAPSULE_SOURCE,
      serverModuleSource,
    });
    await writePublicTree(root, "<!doctype html><html><body><div id=\"app\"></div></body></html>");
    const booted = await bootBundle({ source, dir: root });
    const socket = await openBundleSocket(booted.baseUrl);
    try {
      socket.send({ id: "anonymous-teams", type: "teams.list" });
      const denied = await socket.waitFor((message) => message.id === "anonymous-teams");
      assert.equal(denied.type, "error");
      assert.equal(denied.error.code, "UNAUTHENTICATED");

      socket.send({ id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "bundle-teams@example.com", password: "correct horse battery staple", name: "Bundle Teams" } });
      const signedUp = await socket.waitFor((message) => message.id === "signup");
      assert.equal(signedUp.type, "auth.signUp.result");
      assert.equal(signedUp.error, null, JSON.stringify(signedUp));

      socket.send({ id: "teams-first", type: "teams.list" });
      const first = await socket.waitFor((message) => message.id === "teams-first");
      assert.equal(first.type, "teams.list.result");
      assert.equal(first.error, null, JSON.stringify(first));
      assert.equal(first.data.teams.length, 1);
      assert.equal(first.data.teams[0].role, "admin");

      socket.send({ id: "teams-create", type: "teams.create", name: "Generated Team" });
      const created = await socket.waitFor((message) => message.id === "teams-create");
      assert.equal(created.type, "teams.create.result");
      assert.equal(created.data.team.role, "admin");
      socket.send({ id: "teams-rename", type: "teams.rename", teamId: created.data.team.id, name: "Generated Renamed Team" });
      const renamed = await socket.waitFor((message) => message.id === "teams-rename");
      assert.equal(renamed.type, "teams.rename.result");
      assert.equal(renamed.data.team.name, "Generated Renamed Team");

      socket.send({ id: "teams-query", type: "query.subscribe", query: "ownTeams" });
      const trusted = await socket.waitFor((message) => message.id === "teams-query");
      assert.equal(trusted.type, "query.result");
      assert.equal(trusted.error, null, JSON.stringify(trusted));
      assert.equal(trusted.data.teams.some((team) => team.id === created.data.team.id && team.name === "Generated Renamed Team"), true);

      socket.send({ id: "teams-repeat", type: "teams.list" });
      const repeated = await socket.waitFor((message) => message.id === "teams-repeat");
      assert.equal(repeated.data.teams.some((team) => team.id === created.data.team.id && team.name === "Generated Renamed Team"), true);
    } finally {
      socket.close();
      await booted.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a generated server bundle completes an OAuth callback and immediately lists the linked user's Team", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-teams-oauth-"));
  const provider = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "bundle-facebook-token" }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v23.0/me?")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "bundle-facebook-subject", name: "Bundle Facebook", email: "bundle-facebook@example.com",
        picture: { data: { url: "https://example.com/bundle-facebook.png" } },
      }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  let booted;
  let socket;
  try {
    const serverModuleSource = await bundleServerCapsuleModule({
      serverSource: TEAMS_CAPSULE_SOURCE,
      serverSourcePath: path.join(root, "server", "index.ts"),
    });
    const source = await buildBundle({
      config: capsuleConfig({
        name: "bundle-teams-oauth",
        auth: { providers: {
          anonymous: true,
          facebook: { enabled: true, clientIdEnv: "FACEBOOK_CLIENT_ID", clientSecretEnv: "FACEBOOK_CLIENT_SECRET", graphVersion: "v23.0" },
        } },
      }),
      serverEnv: { FACEBOOK_CLIENT_ID: "bundle-facebook-id", FACEBOOK_CLIENT_SECRET: "bundle-facebook-secret" },
      serverSource: TEAMS_CAPSULE_SOURCE,
      serverModuleSource,
    });
    await writePublicTree(root, "<!doctype html><html><body><div id=\"app\"></div></body></html>");
    booted = await bootBundle({
      source,
      dir: root,
      env: {
        SPORADES_FACEBOOK_TOKEN_URL: `${providerOrigin}/token`,
        SPORADES_FACEBOOK_GRAPH_URL: `${providerOrigin}/v23.0/me`,
        SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK: "1",
      },
    });
    socket = await openBundleSocket(booted.baseUrl, CAPSULE_PUBLIC_ORIGIN, "capsule.example.com");
    socket.send({ id: "oauth-start", type: "auth.signIn", provider: "facebook", returnTo: `${CAPSULE_PUBLIC_ORIGIN}/after` });
    const started = await socket.waitFor((message) => message.id === "oauth-start");
    assert.equal(started.type, "auth.redirect", JSON.stringify(started));
    const state = new URL(started.data.url).searchParams.get("state");
    const callback = await fetch(`${booted.baseUrl}/__sporades/auth/facebook/callback?code=bundle-code&state=${state}`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${CAPSULE_PUBLIC_ORIGIN}/after`);

    socket.send({ id: "oauth-teams", type: "teams.list" });
    const teams = await socket.waitFor((message) => message.id === "oauth-teams");
    assert.equal(teams.type, "teams.list.result");
    assert.equal(teams.error, null, JSON.stringify(teams));
    assert.equal(teams.data.teams.length, 1);
    assert.equal(teams.data.teams[0].role, "admin");
  } finally {
    socket?.close();
    await booted?.stop();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle unseals a sealed Server env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-sealed-"));
  try {
    const paths = sealedServerEnvPaths(root);
    const keyPair = await ensureSealedServerEnvKeyPair(paths);
    const envelope = sealServerEnv({ PROBE_SEALED_VALUE: "sealed-env-value" }, keyPair.publicKey);
    await writeFile(paths.envelope, JSON.stringify(envelope));

    const source = await buildBundle({
      config: capsuleConfig(),
      serverEnv: {},
      sealedServerEnv: { enabled: true },
      serverSource: CAPSULE_SOURCE,
    });

    const dir = path.join(root, "graph");
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
    let observed;
    try {
      const response = await fetch(`${booted.baseUrl}/probe/status`);
      observed = { status: response.status, body: await response.json() };
    } finally {
      await booted.stop();
    }

    assert.equal(observed.body.sealedValue, "sealed-env-value", "sealed Server env did not reach the Capsule");
    assert.equal(observed.status, 202);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle answers the one-shot Job and Schedule inspection actions on SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-sqlite-"));
  try {
    const source = await buildBundle({
      config: capsuleConfig(),
      serverEnv: {},
      serverSource: CAPSULE_SOURCE,
    });

    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    await writePublicTree(dir, "<!doctype html><html><body></body></html>");
    // Boot once so the Capsule's Schedules are registered and a Job row exists, then read the same
    // state back through the one-shot action the CLI and the host helper use.
    const booted = await bootBundle({ source, dir });
    try {
      await fetch(`${booted.baseUrl}/probe/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      await booted.stop();
    }
    const bundlePath = path.join(dir, "server.mjs");
    const context = { literals: [[dir, "<dir>"]] };
    const jobs = normalize(JSON.parse((await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir })).stdout), context);
    const schedules = normalize(JSON.parse((await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir })).stdout), context);
    const unsupported = await runBundleAction(bundlePath, "nope.inspect", { cwd: dir });

    assert.equal(jobs.ok, true, JSON.stringify(jobs));
    assert.equal(jobs.data.jobs.length, 1, "expected the enqueued Job to be inspectable");
    assert.equal(jobs.data.jobs[0].handler, "tally");
    assert.equal(schedules.data.schedules.length, 1, "expected the declared Schedule to be inspectable");
    assert.equal(schedules.data.schedules[0].name, "tally");

    // An unknown action is refused rather than ignored, and refused on stdout as JSON, because the
    // CLI and the host helper parse this stream. The comparison used to carry this claim without
    // stating it; the shape is written down now.
    assert.equal(unsupported.status, 1);
    assert.deepEqual(JSON.parse(unsupported.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported Sporades runtime action.",
        hint: "Upgrade the Sporades CLI and generated Bundle together.",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle does not evaluate Capsule code on the one-shot action path", async () => {
  // ADR-0028. The deleted emitted-list bundle kept this true by importing the Capsule's data URL
  // only when no action was requested. This bundle has to keep it true through esbuild, which is
  // why the entry loads that URL through a variable: a literal would let esbuild resolve the module
  // at build time and pull the Capsule into the graph, where it would be evaluated on every path.
  // That makes this test load-bearing rather than a second opinion — the hazard it covers belongs
  // to the surviving mechanism, not the deleted one.
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-purity-"));
  try {
    const marker = path.join(root, "capsule-evaluated");
    const source = await buildBundle({
      config: capsuleConfig(),
      serverEnv: {},
      serverSource: "",
      serverModuleSource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes"); export default {};`,
    });

    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    const bundlePath = path.join(dir, "server.mjs");
    await writeFile(bundlePath, source);
    const result = await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      { ok: true, data: { capsule: { name: "bundle-equivalence" }, jobs: [] }, error: null },
    );
    await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" }, "the bundle evaluated the Capsule module");
    await assert.rejects(readFile(path.join(dir, "data", "data.db")), { code: "ENOENT" }, "the bundle opened a database");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle reads Postgres state through the inspection adapter", {
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
    await adapter.exec(sql(SCHEDULES_DDL));
    await adapter.prepare(sql(SCHEDULES_INSERT)).run(...schedulesRow("pg-schedule"));

    const config = capsuleConfig({ services: { database: { engine: "postgres" } } });
    const source = await buildBundle({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });

    const env = {
      SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
      SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
    };
    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    const bundlePath = path.join(dir, "server.mjs");
    await writeFile(bundlePath, source);
    const jobsRun = await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir, env });
    const schedulesRun = await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir, env });

    const jobs = JSON.parse(jobsRun.stdout);
    assert.equal(jobsRun.status, 0, jobsRun.stdout + jobsRun.stderr);
    assert.equal(jobs.ok, true, jobsRun.stdout + jobsRun.stderr);
    assert.equal(jobs.data.jobs.length, 1);
    assert.equal(jobs.data.jobs[0].id, "pg-equivalence");
    assert.equal(jobs.data.jobs[0].actor.mode, "privileged-server-role");
    // ADR-0028: the operator view carries no Job payload. The seeded row's payload is
    // `{"secret":true}`, so this is the assertion that a Postgres read does not leak it.
    assert.equal("payload" in jobs.data.jobs[0], false);

    const schedules = JSON.parse(schedulesRun.stdout);
    assert.equal(schedulesRun.status, 0, schedulesRun.stdout + schedulesRun.stderr);
    assert.equal(schedules.ok, true, schedulesRun.stdout + schedulesRun.stderr);
    assert.equal(schedules.data.schedules.length, 1, schedulesRun.stdout);
    assert.equal(schedules.data.schedules[0].name, "pg-schedule");
  } finally {
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_jobs]")).catch(() => {});
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_schedules]")).catch(() => {});
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle reads libSQL state through the inspection adapter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-action-libsql-"));
  try {
    await withFakeLibsqlService(path.join(root, "remote.db"), async ({ url }) => {
      const { createLibsqlDatabaseAdapter } = await import("../dist/server-runtime-source.js");
      // Seeded rather than read empty: an empty result would satisfy every assertion below without
      // the pipeline having read anything.
      const seed = await createLibsqlDatabaseAdapter({ url });
      try {
        await seed.exec("CREATE TABLE sporades_jobs (id TEXT, handler TEXT, enqueuedByUserId TEXT, actorUserId TEXT, payload TEXT, status TEXT, availableAt TEXT, attempts INTEGER, idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT, startedAt TEXT, completedAt TEXT, failedAt TEXT, retryJson TEXT, attemptHistory TEXT, cancelRequestedAt TEXT, leaseExpiresAt TEXT)");
        await seed.prepare("INSERT INTO sporades_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          "libsql-equivalence", "tally", "user-1", "__privileged__", '{"secret":true}', "queued", "2026-01-01T00:00:00.000Z", 0,
          "an-idempotency-key", null, null, "2026-01-01T00:00:00.000Z", null, null, null, '{"maxAttempts":3,"delayMs":25}', "[]", null, null,
        );
        await seed.exec(SCHEDULES_DDL.replace(/[[\]]/g, ""));
        await seed.prepare(SCHEDULES_INSERT.replace(/[[\]]/g, "")).run(...schedulesRow("libsql-schedule"));
      } finally {
        await seed.close();
      }

      const config = capsuleConfig({ services: { database: { engine: "libsql" } } });
      const source = await buildBundle({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });
      const env = {
        SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
        SPORADES_SERVICE_DATABASE_URL: url,
      };
      const dir = path.join(root, "graph");
      await mkdir(dir, { recursive: true });
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      const jobsRun = await runBundleAction(bundlePath, "jobs.inspect", { cwd: dir, env });
      const schedulesRun = await runBundleAction(bundlePath, "schedules.inspect", { cwd: dir, env });

      const jobs = JSON.parse(jobsRun.stdout);
      assert.equal(jobsRun.status, 0, jobsRun.stdout + jobsRun.stderr);
      assert.equal(jobs.ok, true, jobsRun.stdout + jobsRun.stderr);
      assert.equal(jobs.data.jobs.length, 1, jobsRun.stdout);
      assert.equal(jobs.data.jobs[0].id, "libsql-equivalence");
      // The seeded payload is `{"secret":true}` (ADR-0028, as for Postgres above).
      assert.equal("payload" in jobs.data.jobs[0], false);
      const schedules = JSON.parse(schedulesRun.stdout);
      assert.equal(schedulesRun.status, 0, schedulesRun.stdout + schedulesRun.stderr);
      assert.equal(schedules.ok, true, schedulesRun.stdout + schedulesRun.stderr);
      assert.equal(schedules.data.schedules.length, 1, schedulesRun.stdout);
      assert.equal(schedules.data.schedules[0].name, "libsql-schedule");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundle drives S3-compatible file storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-s3-"));
  try {
    await withFakeS3CompatibleService(async ({ endpoint }) => {
      const config = capsuleConfig({ services: { storage: { kind: "storage", engine: "minio" } } });
      const source = await buildBundle({ config, serverEnv: {}, serverSource: CAPSULE_SOURCE });
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

      const dir = path.join(root, "graph");
      await mkdir(dir, { recursive: true });
      await writePublicTree(dir, "<!doctype html><html><body></body></html>");
      const booted = await bootBundle({ source, dir, env });
      const context = { literals: [[dir, "<dir>"], [booted.baseUrl, "<origin>"], [endpoint, "<s3>"]] };
      let observed;
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
        observed = {
          status: health.status,
          health: normalize(await health.json(), context),
          uploads,
        };
      } finally {
        await booted.stop();
      }

      assert.equal(observed.status, 200, JSON.stringify(observed));
      assert.equal(observed.health.data.checks.fileStorage.ok, true, "the fake S3 service was not exercised");
      // The two frames the socket was driven for, which the comparison used to carry without ever
      // stating. Note what the first one actually says: the upload is offered against the runtime's
      // own `/__sporades/uploads/` route, not against a presigned S3 URL — the Capsule proxies the
      // body rather than handing the client a signed URL to the bucket. The S3 path is exercised
      // here by the health check above, which reaches the fake service.
      assert.equal(observed.uploads[0].id, "s1");
      assert.equal(observed.uploads[0].type, "file.uploadUrl.result", JSON.stringify(observed.uploads[0]));
      assert.equal(observed.uploads[0].error, null);
      assert.equal(observed.uploads[0].data.method, "PUT");
      assert.match(observed.uploads[0].data.uploadUrl, /^\/__sporades\/uploads\//);
      assert.equal(observed.uploads[0].data.file.name, "probe.txt");
      assert.equal(observed.uploads[0].data.file.size, 11);
      // And an unknown File reference is refused rather than signed.
      assert.equal(observed.uploads[1].id, "s2");
      assert.equal(observed.uploads[1].type, "error", JSON.stringify(observed.uploads[1]));
      assert.equal(observed.uploads[1].data, null);
      assert.equal(observed.uploads[1].error.message, "File not found.");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The constants.
//
// The deleted emitted-list bundle re-declared each of these in a preamble, serialized from the
// runtime module's own declaration, because a function reached that bundle as source text and a
// module binding it closed over did not follow. Seventeen constants travelled that way, several of
// them security thresholds, and a restated copy that drifted would have been silent.
//
// This bundle closes over the declaration itself, so the second copy is gone and with it the class
// of drift. What is checked here is the claim underneath: that the values a booted Capsule is
// holding are the values the runtime modules declare. Reading the generated text would prove
// nothing about what a Capsule executes, so a Capsule is booted and asked what each name is
// actually bound to — including its type, because a `Set` that arrived as an array or a number that
// arrived as a string is exactly the silent class this whole effort exists to remove.
// ---------------------------------------------------------------------------------------------

const RUNTIME_SOURCE_CONSTANTS = [
  "PRIVILEGED_AUTH_USER_ID",
  "EMAIL_SIGN_IN_FAILURE_LIMIT",
  "EMAIL_SIGN_IN_THROTTLE_WINDOW_MS",
  "EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES",
  "EMAIL_SIGN_IN_THROTTLE_FIELD",
  "PASSWORD_CHANGE_THROTTLE_FIELD",
  "PASSWORD_RESET_THROTTLE_FIELD",
  "PASSWORD_RESET_DEFAULT_PATH",
  "PASSWORD_RESET_DEFAULT_TTL_MS",
  "PASSWORD_RESET_MIN_TTL_MS",
  "PASSWORD_RESET_MAX_TTL_MS",
  "PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL",
  "RESERVED_JOB_NAME_PREFIX",
  "PASSWORD_RESET_MAIL_JOB",
  "PASSWORD_RESET_REQUEST_JOB",
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

// The same description, computed in this process against the modules `dist/` exports. The probe
// above runs the string form inside a booted Capsule; this one runs on the declarations that Capsule
// was built from, so the two can be compared.
function describeConstant(value) {
  if (typeof value === "symbol") return { type: "symbol", description: value.description };
  if (value instanceof Set) return { type: "Set", values: [...value].map(describeConstant) };
  if (value instanceof Map) return { type: "Map", entries: [...value].map(([k, v]) => [k, describeConstant(v)]) };
  if (Array.isArray(value)) return { type: "Array", values: value.map(describeConstant) };
  if (value === null) return { type: "null" };
  if (typeof value === "object") return { type: "object", entries: Object.entries(value).map(([k, v]) => [k, describeConstant(v)]) };
  return { type: typeof value, value };
}

test("every runtime constant reaches a booted Capsule with the value and the type its module declares", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-constants-"));
  try {
    const report = path.join(root, "graph.json");
    const source = await buildBundle(
      { config: capsuleConfig(), serverEnv: {}, serverSource: CAPSULE_SOURCE },
      {
        epilogue: [
          `import { ${RUNTIME_SOURCE_CONSTANTS.join(", ")} } from "../server-runtime-source.js";`,
          `import { PUBLIC_TREE_LIMITS } from "../public-tree-contract.js";`,
          constantProbeReport(report),
        ].join("\n"),
      },
    );

    const dir = path.join(root, "graph");
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
    assert.equal(result.status, 0, `constant probe failed: ${result.stderr}`);

    const bundled = JSON.parse(await readFile(report, "utf8"));
    assert.deepEqual(Object.keys(bundled).sort(), [...PROBED_CONSTANTS].sort());

    // The list above is written out by hand, and a hand-kept list cannot see a constant added to the
    // runtime and never added to it: a constant nobody probes is a constant nobody checks.
    //
    // Derived from the runtime module instead. Every exported SCREAMING_CASE binding is a candidate,
    // and any that is not probed has to be named here as a deliberate exclusion rather than quietly
    // missed.
    const runtimeModule = await import("../dist/server-runtime-source.js");
    const NOT_A_RUNTIME_CONSTANT = new Set(["SERVER_RUNTIME_SOURCE_FUNCTIONS"]);
    assert.deepEqual(
      Object.keys(runtimeModule).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name) && !NOT_A_RUNTIME_CONSTANT.has(name)).sort(),
      [...RUNTIME_SOURCE_CONSTANTS].sort(),
      "the runtime module exports a constant this probe does not check",
    );

    // The report has to have observed real structure, or a probe that wrote `{}` for everything
    // would agree with a `dist/` read that did the same.
    assert.equal(bundled.EMAIL_SIGN_IN_FAILURE_LIMIT.type, "number");
    assert.equal(bundled.PRIVILEGED_AUDIT_ACTOR_KINDS.type, "Set");
    assert.equal(bundled.SIDE_EFFECT_SQL_KEYWORDS.type, "Set");
    assert.ok(bundled.SIDE_EFFECT_SQL_KEYWORDS.values.length > 5);
    assert.equal(bundled.ACL_HELPER_STATE.type, "symbol");
    assert.equal(bundled.PUBLIC_TREE_LIMITS.type, "object");

    // This compared the two bundles to each other until ticket 05, and the comparison could only
    // ever say they agreed — not that either was right. Compared against the declarations now, which
    // is the claim that actually matters and the one ticket 05 has to make: several of these are
    // security thresholds, and what a deployed Capsule enforces has to be what the runtime source
    // says. A restated copy that drifted would resolve exactly as cleanly as a correct one.
    const publicTreeContract = await import("../dist/public-tree-contract.js");
    for (const name of PROBED_CONSTANTS) {
      const declared = name === "PUBLIC_TREE_LIMITS" ? publicTreeContract[name] : runtimeModule[name];
      assert.deepEqual(bundled[name], describeConstant(declared), `constant ${name} is not what its module declares`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The read-only inspection surface.
//
// This is the first region of the runtime to have left `server-runtime-source.ts`, and the region
// ADR-0038 records the most defects in. Everything else in this file checks *behaviour over a
// Capsule*; the inspection gate is not reachable that way, because `sporades db query` goes through
// the CLI rather than through HTTP or the WebSocket transport. So it is driven directly, inside a
// booted bundle, and compared against the module under `dist/` that the bundle was built from.
//
// The corpus is asserted to contain every shape this gate has actually shipped a defect in before
// any result from it is read. ADR-0038 records why: three separate rounds of this work reported
// clean from a corpus that could not express the class it was reporting about.
const INSPECTION_SURFACE_CORPUS = (() => {
  const pieces = ["", " ", "\n", "\r", "--x\r", "--x\n", "/*y*/", "/*/", "*/", "$$", "'", '"', "`", "[", "]", "E'", "\\", ";", "\u00a0", "\v"];
  const shapes = [
    (piece) => `SELECT 1 AS s${piece}`,
    (piece) => `SELECT 1 AS s ${piece} TRUNCATE TABLE sporades_canary`,
    (piece) => `SELECT 1 AS s ${piece}; DROP TABLE sporades_canary`,
    (piece) => `/*${piece}/* SELECT 1 */ ${piece}*/ TRUNCATE TABLE t`,
    (piece) => `SELECT $$a${piece}DROP TABLE t;$$ AS s`,
    (piece) => `SELECT 'a${piece}drop' AS s`,
    (piece) => `SELECT "a${piece}drop" AS s`,
    (piece) => `SELECT E'a${piece}DROP TABLE t;' AS s`,
    (piece) => `PRAGMA table_info(t)${piece}`,
    (piece) => `PRAGMA ${piece} journal_mode = WAL`,
    (piece) => `WITH t AS (SELECT 1 AS s${piece}) SELECT * FROM t`,
    (piece) => `SELECT * FROM sporades_log_events ${piece}`,
  ];
  const corpus = [];
  for (const shape of shapes) for (const piece of pieces) corpus.push(shape(piece));
  // Realistic queries, so a difference in what an operator would actually type is visible here too
  // and not only a difference over attack shapes.
  corpus.push(
    "SELECT 1",
    "SELECT * FROM posts;",
    "select id, title from posts where id = 3",
    "SELECT id FROM posts WHERE title = 'it''s fine'",
    "SELECT id FROM posts -- why\r\nORDER BY id",
    "SELECT /* why */ COUNT(*) AS n FROM users",
    "SELECT \"group\" FROM t",
    "PRAGMA table_list",
    "PRAGMA main.table_info(posts)",
    "WITH recent AS (SELECT * FROM posts LIMIT 5) SELECT * FROM recent",
    "SELECT comment FROM posts",
    "SELECT * FROM t WHERE s = '\u0000'",
    "SELECT $\ud800$ AS s",
  );
  return corpus;
})();

for (const [shape, matches] of [
  ["a nesting block comment", (sql) => sql.startsWith("/*/* SELECT 1 */")],
  ["a `/*/` straddle", (sql) => sql.includes("/*/")],
  ["a line comment closed by a bare CR", (sql) => /--[^\n]*\r/.test(sql)],
  ["a verb wrapped in a dollar quote", (sql) => /\$\$a.*DROP/s.test(sql)],
  ["a verb behind a CR-ended line comment inside a dollar quote", (sql) => /\$\$a--x\r/.test(sql)],
  ["an E-string with a backslash in it", (sql) => /E'a\\/.test(sql)],
  ["whitespace no engine has", (sql) => /[\u00a0\v]/.test(sql)],
  ["text the wire cannot carry", (sql) => /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sql)],
  ["a safe metadata PRAGMA", (sql) => sql.startsWith("PRAGMA table_info")],
  ["a PRAGMA assignment", (sql) => sql.includes("journal_mode = WAL")],
  ["an unterminated quoted run", (sql) => (sql.match(/"/g) ?? []).length % 2 === 1],
  ["a log-index table reference", (sql) => sql.includes("sporades_log_events")],
  ["an ordinary query a person would type", (sql) => sql === "SELECT * FROM posts;"],
]) {
  if (!INSPECTION_SURFACE_CORPUS.some(matches)) {
    throw new Error(`the inspection-surface corpus cannot emit ${shape} — this comparison would be clean for the wrong reason`);
  }
}

// Identical in both bundles. Each resolves the names in its own top-level scope: the emitted-list
// bundle's destructuring of the inspection module block, the module-graph bundle's imports.
function inspectionSurfaceReport(outputPath) {
  return `
import { writeFileSync as __probeWriteFileSync } from "node:fs";
const __probeCorpus = ${JSON.stringify(INSPECTION_SURFACE_CORPUS)};
const __probeCall = (fn, ...args) => {
  try { return { ok: true, value: fn(...args) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
};
__probeWriteFileSync(${JSON.stringify(outputPath)}, JSON.stringify(__probeCorpus.map((sql) => ({
  sql,
  validate: __probeCall(validateReadOnlyInspectionSql, sql),
  strip: __probeCall(sqlWithoutTrailingTerminator, sql),
  disagreement: __probeCall(sqlTheEnginesLexDifferently, sql),
  fingerprintCr: __probeCall(sqlContentFingerprint, sql, true),
  fingerprintLf: __probeCall(sqlContentFingerprint, sql, false),
  firstToken: __probeCall(readFirstSqlToken, sql),
  multiple: __probeCall(hasMultipleSqlStatements, sql),
  sideEffect: __probeCall(containsSideEffectSqlToken, sql),
  tokensCr: __probeCall(readSqlTokens, sql, true),
  tokensLf: __probeCall(readSqlTokens, sql, false),
  trivia: __probeCall(skipSqlTrivia, sql, 0, true),
  quotedIdentifier: __probeCall(readSqlQuotedIdentifier, sql, 0, "'\\"\`["),
  bareIdentifier: __probeCall(readBareSqlIdentifier, sql, 0),
  pragma: __probeCall(isSafeInspectionPragma, sql, 6),
  skipEveryEngine: __probeCall(skipSqlQuotedOrCommented, sql, 0, sqlDialectEveryEngineQuotes(true)),
  skipWithheld: __probeCall(skipSqlQuotedOrCommented, sql, 0, sqlDialectWithoutPostgresStringForms(true)),
  // The internal log-index guard, which is the second region to leave the monolith and the first to
  // reach these two bundles by *three* different routes: an import in the graph bundle, a name
  // destructured out of the carried block in the emitted one, and — before it moved — a stringified
  // entry in the emitted list. Its row limb is asked here too, because it reads rows rather than
  // SQL and nothing else in this report would notice it going missing.
  targetsLogIndex: __probeCall(targetsInternalLogIndexTable, sql),
  logIndexReference: __probeCall(readSqlTableReference, sql, 0),
  // Both row limbs are driven by the corpus entry rather than by a fixed row, so each answers both
  // ways across the corpus. A row that is flagged whatever the statement says — \`{ name:
  // "sporades_log_events" }\` was the first attempt — compares equal in both bundles for a reason
  // that has nothing to do with the code under test.
  createTableRow: __probeCall(isInternalLogIndexMetadataRow, { sql: "CREATE TABLE " + sql }, sql),
  schemaQueryRow: __probeCall(isInternalLogIndexMetadataRow, { note: sql }, "SELECT note FROM sqlite_schema"),
})), null, 2));
process.exit(0);
`;
}

// Boot one probe bundle and insist it exited cleanly.
//
// The retry is for `spawnSync` failing to *start* a process — `result.error` set and `result.status`
// null, which is what an `EAGAIN` under a loaded suite looks like — and for nothing else. A bundle
// that started and exited non-zero is a real answer and is never retried, because retrying a real
// failure is how a flake becomes a silence. Both branches report the whole outcome: an earlier
// version printed only `stderr`, which is `null` in exactly the case that needed explaining.
function runInspectionProbe(label, dir, bundlePath, attempt = 1) {
  const result = spawnSync(process.execPath, [bundlePath], {
    cwd: dir,
    // `PORT=0` so the kernel picks the port. Nothing here connects to these bundles — the probe
    // writes its report and exits — so a port is only something to fail on.
    env: { ...process.env, PORT: "0" },
    encoding: "utf8",
  });
  if (result.error && attempt < 3) {
    return runInspectionProbe(label, dir, bundlePath, attempt + 1);
  }
  assert.equal(
    result.status,
    0,
    [
      `${label} inspection probe did not exit cleanly on attempt ${attempt}`,
      `  status: ${result.status}`,
      `  signal: ${result.signal}`,
      `  spawn error: ${result.error ? `${result.error.code ?? ""} ${result.error.message}` : "none"}`,
      `  stdout: ${String(result.stdout ?? "").slice(-2000)}`,
      `  stderr: ${String(result.stderr ?? "").slice(-2000)}`,
    ].join("\n"),
  );
}

// The same report, computed in this process from the modules under `dist/`. The probe above runs
// the string form inside a booted Capsule; this runs the identical calls against the declarations
// that Capsule was built from. Round-tripped through JSON so the two are comparable: the probe's
// report has been through `JSON.stringify` and an `undefined` or a `Set` does not survive that.
async function inspectionSurfaceReference() {
  const sqlModule = await import("../dist/inspection-sql.js");
  const guardModule = await import("../dist/log-index-guard.js");
  const call = (fn, ...args) => {
    try { return { ok: true, value: fn(...args) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  };
  const {
    readBareSqlIdentifier, readFirstSqlToken, readSqlQuotedIdentifier, readSqlTokens,
    containsSideEffectSqlToken, hasMultipleSqlStatements, isSafeInspectionPragma,
    skipSqlQuotedOrCommented, skipSqlTrivia, sqlContentFingerprint, sqlDialectEveryEngineQuotes,
    sqlDialectWithoutPostgresStringForms, sqlTheEnginesLexDifferently, sqlWithoutTrailingTerminator,
    validateReadOnlyInspectionSql,
  } = sqlModule;
  const { isInternalLogIndexMetadataRow, readSqlTableReference, targetsInternalLogIndexTable } = guardModule;
  return JSON.parse(JSON.stringify(INSPECTION_SURFACE_CORPUS.map((sql) => ({
    sql,
    validate: call(validateReadOnlyInspectionSql, sql),
    strip: call(sqlWithoutTrailingTerminator, sql),
    disagreement: call(sqlTheEnginesLexDifferently, sql),
    fingerprintCr: call(sqlContentFingerprint, sql, true),
    fingerprintLf: call(sqlContentFingerprint, sql, false),
    firstToken: call(readFirstSqlToken, sql),
    multiple: call(hasMultipleSqlStatements, sql),
    sideEffect: call(containsSideEffectSqlToken, sql),
    tokensCr: call(readSqlTokens, sql, true),
    tokensLf: call(readSqlTokens, sql, false),
    trivia: call(skipSqlTrivia, sql, 0, true),
    quotedIdentifier: call(readSqlQuotedIdentifier, sql, 0, "'\"`["),
    bareIdentifier: call(readBareSqlIdentifier, sql, 0),
    pragma: call(isSafeInspectionPragma, sql, 6),
    skipEveryEngine: call(skipSqlQuotedOrCommented, sql, 0, sqlDialectEveryEngineQuotes(true)),
    skipWithheld: call(skipSqlQuotedOrCommented, sql, 0, sqlDialectWithoutPostgresStringForms(true)),
    targetsLogIndex: call(targetsInternalLogIndexTable, sql),
    logIndexReference: call(readSqlTableReference, sql, 0),
    createTableRow: call(isInternalLogIndexMetadataRow, { sql: "CREATE TABLE " + sql }, sql),
    schemaQueryRow: call(isInternalLogIndexMetadataRow, { note: sql }, "SELECT note FROM sqlite_schema"),
  }))));
}

test("the bundled inspection gate answers exactly what the module under dist answers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-inspection-"));
  try {
    const reportPath = path.join(root, "graph.json");
    const source = await buildBundle(
      { config: capsuleConfig(), serverEnv: {}, serverSource: "", serverModuleSource: "export default {};" },
      {
        // The modules under test, imported by name so the probe resolves them the way the runtime
        // does. Ticket 05 turned this from a bundle-to-bundle comparison into a bundle-to-source
        // one, which is the stronger claim: the old form could only report that two artifacts
        // agreed, never that either matched the module a reader would go and edit.
        epilogue: [
          `import { readBareSqlIdentifier, readFirstSqlToken, readSqlQuotedIdentifier, readSqlTokens, containsSideEffectSqlToken, hasMultipleSqlStatements, isSafeInspectionPragma, skipSqlQuotedOrCommented, skipSqlTrivia, sqlContentFingerprint, sqlDialectEveryEngineQuotes, sqlDialectWithoutPostgresStringForms, sqlTheEnginesLexDifferently, sqlWithoutTrailingTerminator, validateReadOnlyInspectionSql } from "../inspection-sql.js";`,
          `import { isInternalLogIndexMetadataRow, readSqlTableReference, targetsInternalLogIndexTable } from "../log-index-guard.js";`,
          inspectionSurfaceReport(reportPath),
        ].join("\n"),
      },
    );

    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    const bundlePath = path.join(dir, "server.mjs");
    await writeFile(bundlePath, source);
    runInspectionProbe("graph", dir, bundlePath);

    const report = JSON.parse(await readFile(reportPath, "utf8"));

    // Guard the measurement before trusting it. A report of refusals-for-everything, or of a gate
    // that answered nothing, would match a reference that did the same and prove nothing.
    assert.equal(report.length, INSPECTION_SURFACE_CORPUS.length);
    const admitted = report.filter((entry) => entry.validate.value?.ok === true).length;
    const refused = report.filter((entry) => entry.validate.value?.ok === false).length;
    assert.ok(admitted > 20, `the corpus admits ${admitted} statements — too few to be checking an inspection gate`);
    assert.ok(refused > 20, `the corpus refuses ${refused} statements — too few to be checking an inspection gate`);
    assert.ok(
      new Set(report.map((entry) => entry.validate.value?.error?.message)).size >= 4,
      "the corpus does not reach every refusal limb, so a limb that changed would be invisible here",
    );

    // And the same for the log-index guard's limbs. A limb the corpus reaches in one direction only
    // passes for the wrong reason, which is the failure ADR-0038 records the sweep corpus making
    // three separate times.
    for (const [limb, reads] of [
      ["targetsLogIndex", (entry) => entry.targetsLogIndex.value],
      ["createTableRow", (entry) => entry.createTableRow.value],
      ["schemaQueryRow", (entry) => entry.schemaQueryRow.value],
    ]) {
      const hits = report.filter((entry) => reads(entry) === true).length;
      assert.ok(hits > 0, `the corpus never makes ${limb} answer true, so the log-index guard is checked vacuously`);
      assert.ok(hits < report.length, `the corpus never makes ${limb} answer false, so the log-index guard is checked vacuously`);
    }

    const reference = await inspectionSurfaceReference();
    for (const [index, entry] of reference.entries()) {
      assert.deepEqual(
        report[index],
        entry,
        `the bundled gate and dist/ answer differently for ${JSON.stringify(entry.sql)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Two tests stood here until ticket 05, and both belonged to the deleted builder rather than to the
// runtime.
//
// The first drove the carrier's freshness check: while the CLI ships as `bin/sporades.js` there are
// two copies of every migrated module — the one esbuild inlined into the binary, which the
// emitted-list builder imported, and the file under `dist/`, which it built the carried text from —
// and it compared them on every build against a set of probe fixtures. The second asserted that the
// emitted-list bundle carried a migrated module's *private* helpers, which was that ticket's whole
// point: a helper registered nowhere still reached a deployed Capsule, where under the emitted list
// it would have been a `ReferenceError`.
//
// Both are gone with the builder they tested, and the ~1,100 lines of skew-probe fixtures in
// `server-bundle-template.ts` that fed the first went with them. The private-helper property is not
// dropped: it is what a module graph does by construction, and `dist/`-freshness is now covered only
// in the narrow sense that esbuild cannot bundle a `dist/` file that will not parse. See ADR-0041
// for what that trade actually costs.

test("the bundle mints ACL_HELPER_STATE exactly once, from the runtime's own declaration", async () => {
  // A `Symbol` has no serialization, so while `ACL_HELPER_STATE` was a monolith declaration the
  // deleted bundle's constant preamble rebuilt it from that declaration's description, and a
  // deployed Capsule held a *different* Symbol than the runtime module's. That was safe — this key
  // has exactly one writer (`createAclHelpers`) and one reader (`aclRuleTouchedAsyncHelperRead`),
  // both of which resolved the preamble's single declaration, and the frozen helper objects never
  // cross between a bundled Capsule and this process — but it was reasoned about rather than
  // checked, and it was the one place the two bundles were deliberately not copies of each other.
  //
  // Batch 7 removed the difference rather than preserving it: `ACL_HELPER_STATE` is a declaration
  // inside `acl-runtime.js`, so there is one `Symbol(…)` expression in the bundle rather than a
  // declaration and a reconstruction beside it.
  //
  // Counting rather than matching, because "at least one" is what a reconstruction alongside the
  // declaration would also satisfy — which is precisely the duplicate-declaration hazard the four
  // ACL constants had to leave the preamble in the same commit to avoid.
  const bundle = await buildBundle(
    { config: capsuleConfig(), serverEnv: {}, serverSource: "", serverModuleSource: "export default {};" },
    { epilogue: `import { ACL_HELPER_STATE as __probeAclHelperState } from "../server-runtime-source.js";\nglobalThis.__probeAclHelperState = __probeAclHelperState;` },
  );

  assert.equal(
    bundle.split('Symbol("sporades.aclHelperState")').length - 1,
    1,
    "the bundle does not mint ACL_HELPER_STATE exactly once",
  );
  assert.match(bundle, /\bACL_HELPER_STATE\b/);
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

test("the bundle carries the Capsule's entry source byte for byte", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-source-"));
  try {
    const reportPath = path.join(root, "graph.txt");
    const source = await buildBundle(
      { config: capsuleConfig(), serverEnv: {}, serverSource: TRICKY_SERVER_SOURCE, serverModuleSource: "export default {};" },
      {
        epilogue: `
import { writeFileSync as __probeWriteFileSync } from "node:fs";
__probeWriteFileSync(${JSON.stringify(reportPath)}, sporadesServerSource, "utf8");
process.exit(0);
`,
      },
    );

    const dir = path.join(root, "graph");
    await mkdir(dir, { recursive: true });
    const bundlePath = path.join(dir, "server.mjs");
    await writeFile(bundlePath, source);
    const port = await reserveFreePort();
    const result = spawnSync(process.execPath, [bundlePath], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `source probe failed: ${result.stderr}`);

    assert.equal(await readFile(reportPath, "utf8"), TRICKY_SERVER_SOURCE, "the bundle altered the Capsule entry source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function moduleGraphBundleWith(epilogue) {
  return createServerBundleModuleSource({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: "",
    serverModuleSource: "export default {};",
    epilogue,
  });
}

test("the module-graph builder rejects an import esbuild cannot resolve", async () => {
  // The resolver's own refusal, before the self-containment guard is reached. Distinct from the
  // test below, which is the one that exercises the guard.
  await assert.rejects(
    moduleGraphBundleWith(`import { createRequire as __probeRequire } from "definitely-not-a-real-package";\nglobalThis.__probe = __probeRequire;`),
    (error) => {
      assert.match(error.message, /Could not resolve "definitely-not-a-real-package"/);
      return true;
    },
  );
});

test("the self-containment guard refuses a bundle that would resolve anything at runtime", async () => {
  // The guard itself, and the reason it cannot be replaced by the resolver check above. A URL
  // specifier *resolves* — esbuild builds happily and marks it external — so nothing fails until
  // something asks what the finished bundle would still reach for. In a deployed Capsule that
  // import is a fetch from a read-only container with no network guarantee and no `node_modules`;
  // it has to be a build error.
  //
  // Asserted on the guard's own wording, because a test that only matched "Server bundle failed"
  // would pass just as well with the guard deleted.
  await assert.rejects(
    moduleGraphBundleWith(`import __probeRemote from "https://example.com/not-bundled.js";\nglobalThis.__probe = __probeRemote;`),
    (error) => {
      assert.match(error.message, /the bundle would import https:\/\/example\.com\/not-bundled\.js at runtime/);
      assert.match(error.hint, /A deployed Capsule has no node_modules/);
      return true;
    },
  );
});
