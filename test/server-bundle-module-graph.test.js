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
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as authRuntimeModule from "../dist/auth-runtime.js";
import { bundleServerCapsuleModule } from "../dist/bundle-pipeline.js";
import * as inspectionSqlModule from "../dist/inspection-sql.js";
import * as logIndexGuardModule from "../dist/log-index-guard.js";
import * as mailConfigModule from "../dist/mail-config.js";
import * as mailRuntimeModule from "../dist/mail-runtime.js";
import * as userPreferencesRuntimeModule from "../dist/user-preferences-runtime.js";
import * as fileStorageRuntimeModule from "../dist/file-storage-runtime.js";
import * as maybePromiseModule from "../dist/maybe-promise.js";
import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { ensureSealedServerEnvKeyPair, sealServerEnv, sealedServerEnvPaths } from "../dist/sealed-server-env.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";
import {
  MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE,
  MIGRATED_MODULE_AUTH_SKEW_PROBE,
  MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE,
  MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE,
  MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE,
  MIGRATED_MODULE_PREFERENCES_PATCH_SKEW_PROBE,
  MIGRATED_MODULE_ROW_SKEW_PROBE,
  MIGRATED_MODULE_SKEW_PROBE,
  MIGRATED_MODULE_STORAGE_ENGINE_SKEW_PROBE,
  MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE,
  MIGRATED_MODULE_STORAGE_SIGNATURE_SKEW_PROBE,
  createServerBundleSource,
  migratedRuntimeModulesBlockFrom,
} from "../dist/templates/server-bundle-template.js";
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

  // And both carry a migrated domain, by two entirely different routes: the module graph reaches
  // `mail-runtime` through `server-runtime-source`'s import of it, while the emitted-list bundle
  // gets it from the carrier splicing the compiled module in as a block. A batch that moved a domain
  // out of the emitted list and forgot the carrier leaves the graph bundle complete and the shipping
  // one missing every name — which is a `ReferenceError` in a deployed Capsule and nothing here
  // would otherwise notice, because the graph bundle is not the one that ships.
  for (const [label, source] of [["emitted", emitted], ["module graph", graph]]) {
    for (const name of ["createMailRuntime", "buildSmtpMessage", "encodeMimeHeaderValue", "validateMailConfig"]) {
      assert.match(source, new RegExp(`function ${name}\\(`), `${label} bundle is missing ${name}`);
    }
    // The domain's sockets are opened through a dynamic import of a builtin, which is the one
    // external form the carrier allows (ADR-0041). Both bundles must still be reaching for it.
    assert.match(source, /import\("node:tls"\)/, `${label} bundle lost the SMTP TLS import`);
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
    // Two successful mutations, two open subscriptions, one rebroadcast each. Asserted rather than
    // merely compared: if this ever stops being a fixed number the comparison below turns into a
    // coin toss, and a flaky equivalence proof is worse than none.
    assert.deepEqual(
      emittedRun.websocket.broadcasts.map((entry) => { const frame = JSON.parse(entry); return `${frame.id}:${frame.type}`; }),
      ["m2:query.result", "m2:query.result", "m4:query.result", "m4:query.result"],
    );

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
    await adapter.exec(sql(SCHEDULES_DDL));
    await adapter.prepare(sql(SCHEDULES_INSERT)).run(...schedulesRow("pg-schedule"));

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

    const emittedSchedules = JSON.parse(runs[0].schedules.stdout);
    assert.equal(emittedSchedules.ok, true, runs[0].schedules.stdout + runs[0].schedules.stderr);
    assert.equal(emittedSchedules.data.schedules.length, 1, runs[0].schedules.stdout);
    assert.equal(emittedSchedules.data.schedules[0].name, "pg-schedule");

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
        await seed.exec(SCHEDULES_DDL.replace(/[[\]]/g, ""));
        await seed.prepare(SCHEDULES_INSERT.replace(/[[\]]/g, "")).run(...schedulesRow("libsql-schedule"));
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
      const emittedSchedules = JSON.parse(runs[0].schedules.stdout);
      assert.equal(emittedSchedules.ok, true, runs[0].schedules.stdout + runs[0].schedules.stderr);
      assert.equal(emittedSchedules.data.schedules.length, 1, runs[0].schedules.stdout);
      assert.equal(emittedSchedules.data.schedules[0].name, "libsql-schedule");

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

    // The list above is written out by hand, and so is the preamble's. Two hand-kept lists agreeing
    // with each other proves nothing about a constant added to only one of them, and this probe's
    // own assertions cannot see that gap: a constant nobody probes is a constant nobody compares.
    //
    // Derived from the runtime module instead. The preamble can only serialize what that module
    // exports, so every exported SCREAMING_CASE binding is a candidate — and any that is not probed
    // has to be named here as a deliberate exclusion rather than quietly missed.
    const runtimeModule = await import("../dist/server-runtime-source.js");
    const NOT_A_SERIALIZED_CONSTANT = new Set(["SERVER_RUNTIME_SOURCE_FUNCTIONS"]);
    assert.deepEqual(
      Object.keys(runtimeModule).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name) && !NOT_A_SERIALIZED_CONSTANT.has(name)).sort(),
      [...RUNTIME_SOURCE_CONSTANTS].sort(),
      "the runtime module exports a constant this probe does not compare",
    );

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

// ---------------------------------------------------------------------------------------------
// The read-only inspection surface, in both bundles.
//
// This is the first region of the runtime to have left `server-runtime-source.ts`, and the two
// bundles now reach it by genuinely different routes: the module-graph bundle imports
// `inspection-sql` and lets esbuild resolve the names, while the emitted-list bundle carries that
// module's compiled text as one block and destructures its exports at the bundle's top level
// (ADR-0041). Everything else about this file compares *behaviour over a Capsule*; the inspection
// gate is not reachable that way, because `sporades db query` goes through the CLI rather than
// through HTTP or the WebSocket transport. So it is compared directly, inside each booted bundle.
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

test("both bundles answer the whole read-only inspection surface identically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-inspection-"));
  try {
    const inputs = { config: capsuleConfig(), serverEnv: {}, serverSource: "", serverModuleSource: "export default {};" };
    const reportPath = (label) => path.join(root, `${label}.json`);
    const bundles = [
      ["emitted", createServerBundleSource(inputs) + inspectionSurfaceReport(reportPath("emitted"))],
      [
        "graph",
        await createServerBundleModuleSource({
          ...inputs,
          // The module under test, imported by name. The emitted-list bundle reaches the same names
          // through the destructuring its inspection module block ends with, and that difference in
          // how the names resolve is the thing this test exists to find nothing wrong with.
          epilogue: [
            `import { readBareSqlIdentifier, readFirstSqlToken, readSqlQuotedIdentifier, readSqlTokens, containsSideEffectSqlToken, hasMultipleSqlStatements, isSafeInspectionPragma, skipSqlQuotedOrCommented, skipSqlTrivia, sqlContentFingerprint, sqlDialectEveryEngineQuotes, sqlDialectWithoutPostgresStringForms, sqlTheEnginesLexDifferently, sqlWithoutTrailingTerminator, validateReadOnlyInspectionSql } from "../inspection-sql.js";`,
            `import { isInternalLogIndexMetadataRow, readSqlTableReference, targetsInternalLogIndexTable } from "../log-index-guard.js";`,
            inspectionSurfaceReport(reportPath("graph")),
          ].join("\n"),
        }),
      ],
    ];

    for (const [label, source] of bundles) {
      const dir = path.join(root, label);
      await mkdir(dir, { recursive: true });
      const bundlePath = path.join(dir, "server.mjs");
      await writeFile(bundlePath, source);
      runInspectionProbe(label, dir, bundlePath);
    }

    const emittedReport = JSON.parse(await readFile(reportPath("emitted"), "utf8"));
    const graphReport = JSON.parse(await readFile(reportPath("graph"), "utf8"));

    // Guard the measurement before trusting it. Two reports of refusals-for-everything, or of a
    // gate that answered nothing, would compare equal and prove nothing.
    assert.equal(emittedReport.length, INSPECTION_SURFACE_CORPUS.length);
    const admitted = emittedReport.filter((entry) => entry.validate.value?.ok === true).length;
    const refused = emittedReport.filter((entry) => entry.validate.value?.ok === false).length;
    assert.ok(admitted > 20, `the corpus admits ${admitted} statements — too few to be comparing an inspection gate`);
    assert.ok(refused > 20, `the corpus refuses ${refused} statements — too few to be comparing an inspection gate`);
    assert.ok(
      new Set(emittedReport.map((entry) => entry.validate.value?.error?.message)).size >= 4,
      "the corpus does not reach every refusal limb, so a limb that changed would be invisible here",
    );

    // And the same for the log-index guard's two limbs, which are the newest thing in this report.
    // A limb the corpus reaches in one direction only compares clean for the wrong reason, which is
    // the failure ADR-0038 records the sweep corpus making three separate times.
    for (const [limb, reads] of [
      ["targetsLogIndex", (entry) => entry.targetsLogIndex.value],
      ["createTableRow", (entry) => entry.createTableRow.value],
      ["schemaQueryRow", (entry) => entry.schemaQueryRow.value],
    ]) {
      const hits = emittedReport.filter((entry) => reads(entry) === true).length;
      assert.ok(hits > 0, `the corpus never makes ${limb} answer true, so the log-index guard is compared vacuously`);
      assert.ok(hits < emittedReport.length, `the corpus never makes ${limb} answer false, so the log-index guard is compared vacuously`);
    }

    for (const [index, entry] of emittedReport.entries()) {
      assert.deepEqual(
        graphReport[index],
        entry,
        `the two bundles answer differently for ${JSON.stringify(entry.sql)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// While the CLI ships as a bundle there are two copies of every migrated module: the one esbuild
// inlined into `bin/sporades.js`, which is what `createServerBundleSource` imports, and the file
// under `dist/` on disk, which is what it builds the carried text from. A tree whose `dist/` and
// `bin/` came from different builds would put the `dist/` gate inside a Capsule while every other
// runtime function in that same Capsule came from `bin/`, and nothing in `scripts/` compares the two
// for freshness.
//
// So the builder compares them itself, and this is that check exercised against trees skewed on
// purpose. Driven through `migratedRuntimeModulesBlockFrom` against a copy of `dist/` in a temporary
// directory, rather than by editing the tree the suite is running out of.
//
// A directory rather than a string of module text, which is what this drove before the carrier
// bundled: `buildSync` accepts no plugins, so an in-memory graph cannot be handed to esbuild. It is
// also the more faithful seam — a skewed module is resolved here by the same import the shipping
// build resolves, which is what lets the last case below exist at all.
test("a carried copy of a migrated runtime module that disagrees with the running one fails the build", async () => {
  const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
  const files = ["inspection-sql.js", "log-index-guard.js", "mail-config.js", "mail-runtime.js", "runtime-errors.js", "auth-runtime.js", "jobs-runtime.js", "user-preferences-runtime.js", "maybe-promise.js", "file-storage-runtime.js"];
  const originals = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await readFile(path.join(distDir, file), "utf8")])),
  );

  const root = await mkdtemp(path.join(tmpdir(), "sporades-bundle-skew-"));
  // Writes `dist/` into a scratch directory with one file replaced, and builds the block from it.
  const blockWith = async (file, contents) => {
    const dir = path.join(root, `skew-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(files.map((name) => writeFile(path.join(dir, name), name === file ? contents : originals[name])));
    return migratedRuntimeModulesBlockFrom(dir);
  };

  try {
    // The honest copies build, or every rejection below would be meaningless. Both modules are
    // asserted present in the one block, since carrying them together is the point of the change
    // that introduced this: a private helper of the gate, and the guard's private identifier reader.
    const honest = await blockWith("inspection-sql.js", originals["inspection-sql.js"]);
    assert.match(honest, /function nestingBlockCommentEnd\(/);
    assert.match(honest, /function readSqlIdentifier\(/);
    // And the mail domain's, which arrived in batch 2. `encodeMimeHeaderValue` is private to
    // `mail-runtime`; `validateMailConfig` is the whole of `mail-config`, a file that was reaching
    // the bundle through the emitted list until this batch carried it here instead.
    assert.match(honest, /function encodeMimeHeaderValue\(/);
    assert.match(honest, /function validateMailConfig\(/);
    // The allowance the two static-import cases below are the counterweight to: the SMTP transport
    // opens its sockets with `await import("node:tls" | "node:net")`, esbuild emits a dynamic import
    // of an external verbatim rather than lowering it, and a deployed Capsule resolves a builtin
    // exactly as the bundle's own top-level imports do. Asserted on the text so that a carrier which
    // started lowering these — to `require(…)`, which this bundle cannot execute — is caught here
    // rather than at a Capsule's boot.
    assert.match(honest, /await import\("node:tls"\)/);
    assert.match(honest, /await import\("node:net"\)/);
    assert.equal(/\brequire\s*\(/.test(honest), false, "the carried block would resolve a specifier through `require`");

    // Guard the probe before trusting it. A corpus the gate admits in full cannot tell an
    // allow-everything validator from the real one, which is the case this check exists for.
    const refused = MIGRATED_MODULE_SKEW_PROBE.filter((sql) => inspectionSqlModule.validateReadOnlyInspectionSql(sql).ok === false);
    const admitted = MIGRATED_MODULE_SKEW_PROBE.filter((sql) => inspectionSqlModule.validateReadOnlyInspectionSql(sql).ok === true);
    assert.ok(refused.length >= 5, `the skew probe only refuses ${refused.length} statements — it cannot see a validator that admits everything`);
    assert.ok(admitted.length >= 5, `the skew probe only admits ${admitted.length} statements — it cannot see a validator that refuses everything`);

    // And the same, for the second module carried here: the probe must reach both of the log-index
    // guard's answers in both directions, or a skewed copy of it compares clean for the wrong reason.
    const targeted = MIGRATED_MODULE_SKEW_PROBE.filter((sql) => logIndexGuardModule.targetsInternalLogIndexTable(sql));
    assert.ok(targeted.length >= 2, `the skew probe reaches the log-index guard for ${targeted.length} statements — too few to see it go missing`);
    assert.ok(
      MIGRATED_MODULE_SKEW_PROBE.some((sql) => !logIndexGuardModule.targetsInternalLogIndexTable(sql)),
      "the skew probe cannot see a log-index guard that answers true for everything",
    );
    const flagged = MIGRATED_MODULE_ROW_SKEW_PROBE.filter(([row, sql]) => logIndexGuardModule.isInternalLogIndexMetadataRow(row, sql));
    assert.ok(flagged.length >= 3, `the row probe flags ${flagged.length} rows — too few to see the row filter go missing`);
    assert.ok(
      MIGRATED_MODULE_ROW_SKEW_PROBE.some(([row, sql]) => !logIndexGuardModule.isInternalLogIndexMetadataRow(row, sql)),
      "the row probe cannot see a row filter that flags everything",
    );

    // And for the mail domain, on the same terms. A config probe the validator accepts in full
    // cannot tell a `validateMailConfig` that returns its input from the real one, and one it
    // refuses in full cannot tell it from a validator that refuses everything — so both directions
    // are settled before any rejection below is trusted.
    const threw = (config) => {
      try {
        mailConfigModule.validateMailConfig(config);
        return false;
      } catch {
        return true;
      }
    };
    const refusedConfigs = MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE.filter(threw);
    assert.ok(refusedConfigs.length >= 4, `the mail config probe only refuses ${refusedConfigs.length} configurations — it cannot see a validator that admits everything`);
    assert.ok(
      MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE.filter((config) => !threw(config)).length >= 4,
      "the mail config probe cannot see a validator that refuses everything",
    );

    // The MIME probe's teeth are that the messages differ from each other in the limbs the private
    // helpers own. Assembling them all identically would compare a skewed copy as clean, which is
    // the "reports clean for the wrong reason" shape this whole check exists for.
    const assembled = MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE.map((message) => mailRuntimeModule.buildSmtpMessage(message));
    assert.equal(new Set(assembled).size, assembled.length, "the mail message probe assembles two identical messages — one of them proves nothing");
    assert.ok(
      assembled.some((mime) => mime.includes("=?UTF-8?B?")),
      "the mail message probe never reaches the RFC 2047 encoder, so a copy that lost it compares clean",
    );
    assert.ok(
      assembled.some((mime) => /\r\n[ \t]/.test(mime)),
      "the mail message probe never folds a header, so a copy that lost the folder compares clean",
    );

    // And the auth domain, which arrived in batch 3. Its private helpers and its credential hashing
    // are in the block, and `commandError` is in it through `runtime-errors.js` — the module auth
    // imports, which is why the block resolving imports between migrated modules matters here again.
    assert.match(honest, /function passwordResetCodeParts\(/);
    assert.match(honest, /function hashEmailPassword\(/);
    assert.match(honest, /function commandError\(/);
    // The accessor ADR-0042 records, asserted on the text: this is the only way the carried copy of
    // the auth domain reaches `scryptSync`, and a carrier that had started lowering it — or a module
    // edited back to a static `import … from "node:crypto"` — is caught here rather than at a
    // Capsule's boot. The `require` assertion above covers the second half of that.
    assert.match(honest, /process\.getBuiltinModule\("node:crypto"\)/);

    // Guard the auth probe in both directions, on the same terms as the three above. A credential
    // probe that never accepts cannot see a `verifyEmailPassword` replaced by one returning false,
    // and one that never rejects cannot see one returning true — which is the whole point of a
    // password check.
    const accepted = MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE.filter(
      ([password, salt, expected]) => authRuntimeModule.verifyEmailPassword(password, salt, expected) === true,
    );
    assert.ok(accepted.length >= 1, "the credential probe never accepts a password, so a copy that rejects everything compares clean");
    assert.ok(
      MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE.filter(
        ([password, salt, expected]) => authRuntimeModule.verifyEmailPassword(password, salt, expected) === false,
      ).length >= 3,
      "the credential probe never rejects a password, so a copy that accepts everything compares clean",
    );
    // And the pure gates, which are the domain's refusals: each named gate must both admit and
    // refuse somewhere in the probe, or a skewed copy of it compares clean for the wrong reason.
    const gateAnswer = ([name, args]) => {
      try {
        return JSON.stringify(authRuntimeModule[name](...args)) ?? "undefined";
      } catch (error) {
        return `threw:${error?.code ?? error?.message}`;
      }
    };
    for (const gate of ["normalizeReturnTo", "isOAuthLoopbackHostname", "appleOAuthOriginEligible", "normalizePasswordResetPath", "isReservedAuthUserId", "requireAuth"]) {
      const answers = new Set(MIGRATED_MODULE_AUTH_SKEW_PROBE.filter(([name]) => name === gate).map(gateAnswer));
      assert.ok(answers.size >= 2, `the auth probe makes ${gate} answer the same way every time, so a skewed copy of it compares clean`);
    }
    // `oauthProviderTestEndpoint` is deliberately not in that list, and the reason is worth stating
    // rather than leaving for the next reader to rediscover from a failing assertion. Its second
    // branch is behind `SPORADES_OAUTH_TEST_ENDPOINTS === "1"`, which is unset here, so both probe
    // inputs take the production branch and it answers the same way twice.
    //
    // It stays in the probe because the comparison is still real: the two copies read the same
    // environment, so a carried copy that had started honouring the override — the defect this gate
    // exists to prevent — returns the override while the running one returns the production URL, and
    // that is a disagreement. What the probe cannot see, with the variable unset, is a change to the
    // override-accepting branch itself. That branch is covered by `test/oauth-provider.test.js`,
    // against `dist/`, which is where it is reachable.
    assert.equal(
      new Set(MIGRATED_MODULE_AUTH_SKEW_PROBE.filter(([name]) => name === "oauthProviderTestEndpoint").map(gateAnswer)).size,
      1,
      "SPORADES_OAUTH_TEST_ENDPOINTS is set in this environment, so the comment above no longer describes what this probe reaches",
    );

    // And batch 5's domain, on the same terms as the four above. The patch probe has to admit and
    // refuse, or it cannot tell a `normalizePreferencesPatch` that returns its input from one that
    // rejects everything — and its refusals have to arrive by *both* routes, or a copy that had lost
    // the JSON check compares clean because the shape gate refused the rest.
    const patchAnswer = ([, patch]) => {
      try {
        userPreferencesRuntimeModule.normalizePreferencesPatch(patch);
        return "admitted";
      } catch (error) {
        return `threw:${error?.code ?? "no-code"}`;
      }
    };
    const patchAnswers = MIGRATED_MODULE_PREFERENCES_PATCH_SKEW_PROBE.map(patchAnswer);
    assert.ok(
      patchAnswers.filter((answer) => answer === "admitted").length >= 3,
      "the preferences patch probe never admits a patch, so a copy that refuses everything compares clean",
    );
    assert.ok(
      patchAnswers.filter((answer) => answer === "threw:INVALID_PREFERENCES_PATCH").length >= 4,
      "the preferences patch probe never reaches the shape gate's refusal, so a copy that admits everything compares clean",
    );
    assert.ok(
      patchAnswers.some((answer) => answer === "threw:no-code"),
      "the preferences patch probe never reaches assertJsonCompatible, so a copy that lost the JSON check compares clean",
    );

    // And batch 6's domain, file and object storage. Four things to settle before any storage
    // rejection below is trusted, and each is a way this probe could report clean for the wrong
    // reason rather than because the copies agree.
    //
    // The private helpers are in the block for the same reason every earlier batch's are: the module
    // is carried whole, so a helper exported from nothing travels because it is in the file.
    // `s3Hmac` is the S3 signing path's, `resolveLiveFileReference` is this module's census sentinel,
    // and `chainMaybePromise` comes from `maybe-promise.js` — the module storage imports, which is
    // why the block resolving imports between migrated modules matters here again.
    assert.match(honest, /function s3Hmac\(/);
    assert.match(honest, /function resolveLiveFileReference\(/);
    assert.match(honest, /function chainMaybePromise\(/);

    // First: the signature probe must produce four *different* signatures. A corpus that signed the
    // same canonical request four ways over would compare a copy that had lost the method, the path
    // or the region from its canonical request as clean.
    const signatures = MIGRATED_MODULE_STORAGE_SIGNATURE_SKEW_PROBE.map(([, request]) => fileStorageRuntimeModule.s3Signature(request));
    assert.equal(new Set(signatures).size, signatures.length, "the S3 signature probe signs two requests identically — one of them proves nothing");
    assert.ok(
      signatures.every((signature) => /^AWS4-HMAC-SHA256 Credential=\S+ SignedHeaders=\S+ Signature=[0-9a-f]{64}$/.test(signature)),
      "the S3 signature probe is not producing a well-formed SigV4 header, so it is not exercising the signing path",
    );

    // Second: the pure gates must both admit and refuse, on the same terms as every corpus above.
    // `normalizeAbsoluteFilePath` is the one that decides which row a `files.get("/x/y")` reads, and
    // `contentTypeForFile` is a containment — it must answer `application/octet-stream` for something
    // and echo the type back for something else, or a copy that had lost the allow-list compares
    // clean while turning a stored `text/html` into stored XSS.
    const storageAnswer = ([name, args]) => {
      try {
        return `returned:${JSON.stringify(fileStorageRuntimeModule[name](...args)) ?? "undefined"}`;
      } catch (error) {
        return `threw:${error?.message}`;
      }
    };
    for (const gate of ["normalizeAbsoluteFilePath", "validatePublicUrlExpiry", "contentTypeForFile", "isAbsoluteFilePath"]) {
      const answers = new Set(MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.filter(([name]) => name === gate).map(storageAnswer));
      assert.ok(answers.size >= 2, `the storage probe makes ${gate} answer the same way every time, so a skewed copy of it compares clean`);
    }
    assert.ok(
      MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.some(([name]) => name === "normalizeAbsoluteFilePath")
        && MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.filter(([name]) => name === "normalizeAbsoluteFilePath").map(storageAnswer).some((answer) => answer.startsWith("threw:")),
      "the storage probe never refuses a File path, so a copy that admitted everything compares clean",
    );
    assert.ok(
      MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.filter(([name]) => name === "contentTypeForFile")
        .map(storageAnswer).includes('returned:"application/octet-stream"'),
      "the storage probe never reaches the inline content-type refusal, so a copy that echoed the stored type compares clean",
    );

    // Third: the engine constructor probe must both build and refuse, or it cannot tell a
    // constructor that validates nothing from one that refuses everything.
    const engineAnswer = ([, config]) => {
      try {
        return `built:${fileStorageRuntimeModule.createS3CompatibleFileStorageAdapter(config).objectKeyPrefix}`;
      } catch (error) {
        return `threw:${error?.message}`;
      }
    };
    const engineAnswers = MIGRATED_MODULE_STORAGE_ENGINE_SKEW_PROBE.map(engineAnswer);
    assert.ok(engineAnswers.filter((answer) => answer.startsWith("built:")).length >= 2, "the storage engine probe never builds an adapter, so a copy that refuses everything compares clean");
    assert.ok(engineAnswers.filter((answer) => answer.startsWith("threw:")).length >= 5, "the storage engine probe never refuses a configuration, so a copy that validates nothing compares clean");
    assert.ok(
      new Set(engineAnswers.filter((answer) => answer.startsWith("threw:"))).size >= 2,
      "every storage engine refusal carries the same message, so a copy that collapsed them compares clean",
    );

    // Fourth: `maybe-promise.js`. Its probe has to take both arms of each function — a corpus of
    // plain values cannot see a copy that stopped recognising a thenable, which is the shape that
    // would make every adapter method on the asynchronous engines return before its statement ran.
    assert.ok(
      MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE.some(([, value]) => maybePromiseModule.isPromiseLike(value)),
      "the maybe-promise probe holds no thenable, so a copy that stopped recognising one compares clean",
    );
    assert.ok(
      MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE.some(([, value]) => !maybePromiseModule.isPromiseLike(value)),
      "the maybe-promise probe holds only thenables, so a copy that called everything a promise compares clean",
    );

    const skews = [
      // The one that was silent before this check existed: same exports, same names, a validator
      // replaced by one that admits anything.
      [
        "a validator swapped for one that admits everything",
        "inspection-sql.js",
        originals["inspection-sql.js"].replace(
          /export function validateReadOnlyInspectionSql\(sql\) \{/,
          "export function validateReadOnlyInspectionSql(sql) {\n  if (true) return { ok: true };",
        ),
        /answer the skew probe differently/,
      ],
      // A quieter body change, in the tokenizer rather than the validator: line comments stop ending
      // at a carriage return, which is the defect that put a live `TRUNCATE` through this gate.
      [
        "a tokenizer whose line comment stops ending at a carriage return",
        "inspection-sql.js",
        originals["inspection-sql.js"].replace("dialect.lineCommentEndsAtCarriageReturn ? /[\\n\\r]/ : /\\n/", "/\\n/"),
        /answer the skew probe differently/,
      ],
      // Structural skew: an export the running copy has and the carried one does not.
      [
        "a copy missing an export the running one has",
        "inspection-sql.js",
        originals["inspection-sql.js"].replace("export function sqlContentFingerprint(", "function sqlContentFingerprint("),
        /export a different set of names.*missing sqlContentFingerprint/s,
      ],
      // Truncation part-way through a function, which is what an interrupted write leaves behind.
      [
        "a copy truncated mid-function",
        "inspection-sql.js",
        originals["inspection-sql.js"].slice(0, originals["inspection-sql.js"].indexOf("export function skipSqlQuotedOrCommented(") + 200),
        /did not build|did not evaluate|export a different set of names/,
      ],
      // The second module, skewed on the limb the statement probe reaches: the log-index guard stops
      // recognising the table it exists to conceal. Same exports, same names, and before this module
      // was carried here at all there was nothing to compare it against.
      [
        "a log-index guard that no longer recognises the table it conceals",
        "log-index-guard.js",
        originals["log-index-guard.js"].replace(
          'part.toLowerCase() === "sporades_log_events"',
          'part.toLowerCase() === "sporades_log_events_renamed"',
        ),
        /answer the skew probe differently/,
      ],
      // And on the limb only the row probe reaches. This one is the reason that probe exists: the
      // guard's row filter answers no SQL question at all, so a copy that had lost it agrees with the
      // running one about every statement above.
      [
        "a log-index guard whose row filter stopped flagging metadata rows",
        "log-index-guard.js",
        originals["log-index-guard.js"].replace(
          "export function isInternalLogIndexMetadataRow(row, sql = \"\") {",
          "export function isInternalLogIndexMetadataRow(row, sql = \"\") {\n  if (true) return false;",
        ),
        /answer the skew probe differently/,
      ],
      // The skew that only a resolved graph can see: the guard imports the gate's tokenizer, so a
      // `dist/` where the gate stopped exporting it is a build failure rather than a wrong answer.
      // Under the previous carrier the two modules were converted independently and this was
      // unreachable — which is the whole hazard `require(…)` in an ES module would have been.
      [
        "a gate that stopped exporting the tokenizer the guard imports",
        "inspection-sql.js",
        originals["inspection-sql.js"].replace("export function skipSqlTrivia(", "function skipSqlTrivia("),
        /did not build.*skipSqlTrivia|export a different set of names.*missing skipSqlTrivia/s,
      ],
      // The mail domain, batch 2. This one is the reason `validateMailConfig` is worth probing at
      // all: a copy that accepts whatever it is given exports the same single name, assembles every
      // message below identically, and quietly lets a Capsule ship SMTP credentials over a hop with
      // no TLS on it.
      [
        "a mail config validator swapped for one that admits everything",
        "mail-config.js",
        originals["mail-config.js"].replace(
          "export function validateMailConfig(mail) {",
          "export function validateMailConfig(mail) {\n  if (true) return mail;",
        ),
        /answer the skew probe differently/,
      ],
      // A quieter body change in the same file, on the one limb that is a security rule rather than
      // a shape check: credentials over opportunistic or disabled TLS stop being refused.
      [
        "a mail config validator that stops refusing credentials over a plaintext hop",
        "mail-config.js",
        originals["mail-config.js"].replace('["opportunistic", "disabled"].includes(tlsMode) && authMethod !== "none"', "false"),
        /answer the skew probe differently/,
      ],
      // A private helper of `mail-runtime`, which nothing exports and no list registers. Before this
      // domain was carried whole there was no such thing as a private helper here to skew.
      [
        "a MIME encoder whose header folding stops at a different line length",
        "mail-runtime.js",
        originals["mail-runtime.js"].replace("Buffer.byteLength(text) <= 70", "Buffer.byteLength(text) <= 7000"),
        /answer the skew probe differently/,
      ],
      // And the structural case for the domain's second file, so that "carried but not compared" is
      // not reachable for it either.
      [
        "a mail runtime missing an export the running one has",
        "mail-runtime.js",
        originals["mail-runtime.js"].replace("export function createMailTransport(", "function createMailTransport("),
        /export a different set of names.*missing createMailTransport/s,
      ],
      // Self-containment, and the most likely way a later batch loses it. `mail-runtime` reaches the
      // UUID generator through the Web Crypto global rather than importing `randomUUID`, and the
      // obvious "simplification" is to import it — which `format: "iife"` lowers to
      // `__require("node:crypto")` and a Capsule then dies at boot on, with nothing in the suite
      // seeing it. Refused at build instead, and the same for an unprefixed builtin, since `crypto`
      // resolves in the container exactly as `node:crypto` does.
      //
      // These two are the counterweight to the allowance beside them: the check had to be narrowed
      // in this batch so that the mail transport's `await import("node:tls")` could travel, and
      // narrowing it is only safe while the static form is still refused. The honest build above is
      // the other half of that pair — it carries both dynamic builtin imports and is not refused.
      //
      // The import has to be *used* or esbuild tree-shakes it away and the case proves nothing, so
      // each of these rewrites one real call site to match — which is exactly the edit being
      // guarded against, rather than a synthetic stand-in for it.
      [
        "a migrated module that imports a builtin statically instead of reaching a global",
        "mail-runtime.js",
        `import { randomUUID } from "node:crypto";\n${originals["mail-runtime.js"].replace("mail_${crypto.randomUUID()}", "mail_${randomUUID()}")}`,
        /would resolve node:crypto at runtime/,
      ],
      [
        "the same written without the `node:` prefix",
        "mail-runtime.js",
        `import { randomUUID } from "crypto";\n${originals["mail-runtime.js"].replace("mail_${crypto.randomUUID()}", "mail_${randomUUID()}")}`,
        /would resolve crypto at runtime/,
      ],
      // Batch 3's domain. The first is the shape that would be silent everywhere else: a password
      // check that says yes to anything keeps every export and every other answer.
      [
        "a credential check swapped for one that accepts any password",
        "auth-runtime.js",
        originals["auth-runtime.js"].replace(
          /export function verifyEmailPassword\(password, salt, expectedHash\) \{/,
          "export function verifyEmailPassword(password, salt, expectedHash) {\n  if (true) return true;",
        ),
        /answer the skew probe differently/,
      ],
      // The length guard in front of the constant-time comparison. Dropping it is not a value
      // change for any matching pair — which is why the truncated-hash vector is in the probe: with
      // the guard gone `timingSafeEqual` throws on mismatched buffer lengths instead of returning
      // false, and the two copies disagree.
      [
        "a credential check that lost the length guard before the constant-time compare",
        "auth-runtime.js",
        originals["auth-runtime.js"].replace(
          "return actual.length === expected.length && nodeCryptoModule.timingSafeEqual(actual, expected);",
          "return nodeCryptoModule.timingSafeEqual(actual, expected);",
        ),
        /answer the skew probe differently/,
      ],
      // The open-redirect containment, which is a gate rather than a credential: a `normalizeReturnTo`
      // that stops pinning the origin hands an OAuth callback to whoever asked for it.
      [
        "a return-to normalizer that stopped pinning the origin",
        "auth-runtime.js",
        originals["auth-runtime.js"].replace("        if (url.origin !== origin) {\n            return origin;\n        }\n", ""),
        /answer the skew probe differently/,
      ],
      // A private helper of `auth-runtime`, which nothing exports and no list registers — the same
      // case batch 2 made for mail, at this domain's scale. `createAuthDenialLogData` is reached only
      // through `requireAuth`, so a probe that did not call the exported one could not see it change.
      [
        "a private auth helper whose body changed",
        "auth-runtime.js",
        originals["auth-runtime.js"].replace("            isGuest: context?.auth?.isGuest ?? null,", "            isGuest: \"skewed\","),
        /answer the skew probe differently/,
      ],
      // The export surface, on the module the rest of the domain imports. `runtime-errors` holds one
      // function and `auth-runtime` cannot resolve without it, so this is the batch-1 case — "a gate
      // that stopped exporting what its consumer imports" — reappearing one module along.
      [
        "an error module that stopped exporting what auth imports",
        "runtime-errors.js",
        originals["runtime-errors.js"].replace("export function commandError(", "function commandError("),
        /did not build|export a different set of names/,
      ],
      // And the accessor ADR-0042 turns on, written the way ADR-0041 refuses. This is the pair the
      // static-import cases above are for, asked of the module that actually needed the narrowing to
      // go the other way: auth cannot use the dynamic form, so if `process.getBuiltinModule` were
      // ever replaced by the import it reads like, the build must refuse it.
      [
        "the auth domain reaching node:crypto through a static import instead of the accessor",
        "auth-runtime.js",
        `import { scryptSync } from "node:crypto";\n${originals["auth-runtime.js"].replace("const actual = nodeCryptoModule.scryptSync(password, salt, 64);", "const actual = scryptSync(password, salt, 64);")}`,
        /would resolve node:crypto at runtime/,
      ],
      // Batch 4's domain, jobs and schedules. The first is the shape peculiar to a scheduler: an
      // occurrence calculator that is merely *late*. Every export survives, every Schedule still
      // fires, and each one fires at the wrong minute — which no export-surface check can see and
      // which is why the schedule limb of the probe compares a returned instant rather than a
      // verdict.
      [
        "an occurrence calculator that returns every Schedule one minute late",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace("return new Date(candidate);", "return new Date(candidate.getTime() + 60000);"),
        /answer the skew probe differently/,
      ],
      // A private helper of `jobs-runtime`, reached only through `nextScheduleOccurrence` — the same
      // case as the auth and mail ones above, at this domain's scale. `scheduleWallClockParts` is
      // where a Schedule's local weekday is decided, so a mis-mapped table sends every day-of-week
      // Schedule to the wrong day while every exported name still answers.
      [
        "a private schedule helper that mis-maps a weekday",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace(
          "{ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }",
          "{ Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 0 }",
        ),
        /answer the skew probe differently/,
      ],
      // The bound every Job payload, result and failure passes through. Dropping it is the shape that
      // reaches production as an oversized row rather than an error.
      [
        "a Job payload bound that stopped enforcing its byte limit",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace('if (Buffer.byteLength(serialized, "utf8") > limit)', "if (false)"),
        /answer the skew probe differently/,
      ],
      // The failure sanitizer, which is a containment rather than a calculation: it decides which
      // internal codes a Capsule author is allowed to see, so a copy that passed them through leaks.
      [
        "a Job failure sanitizer that leaks internal codes",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace(
          'const code = knownCodes.has(error?.code) ? error.code : "JOB_FAILED";',
          'const code = error?.code ?? "JOB_FAILED";',
        ),
        /answer the skew probe differently/,
      ],
      // The Schedule fingerprint decides whether a redeployed Schedule counts as changed. A copy that
      // computed it differently would re-reconcile every Schedule on every boot — a behaviour change
      // that never throws and that only a value comparison catches.
      [
        "a Schedule fingerprint computed differently",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace(
          "const fingerprint = JSON.stringify({ expression: normalizedExpression,",
          'const fingerprint = JSON.stringify({ expression: normalizedExpression + " ",',
        ),
        /answer the skew probe differently/,
      ],
      // The export surface, on the module the monolith imports twenty-four names from. `boundedJobJson`
      // is one of them, so this is the "stopped exporting what its consumer imports" case again.
      [
        "a jobs module that stopped exporting what the monolith imports",
        "jobs-runtime.js",
        originals["jobs-runtime.js"].replace("export function boundedJobJson", "function boundedJobJson"),
        /did not build|export a different set of names/,
      ],
      // And the ADR-0042 accessor written the way ADR-0041 refuses, asked of the second domain to
      // need it. `scheduledOccurrenceIdentity` is synchronous and inside a transaction, so the
      // dynamic form is not open to it either; if the accessor were ever replaced by the import it
      // reads like, the build must refuse it.
      [
        "the jobs domain reaching node:crypto through a static import instead of the accessor",
        "jobs-runtime.js",
        `import { createHash } from "node:crypto";\n${originals["jobs-runtime.js"].replace('return nodeCryptoModule.createHash("sha256")', 'return createHash("sha256")')}`,
        /would resolve node:crypto at runtime/,
      ],
      // Batch 5's domain, user preferences. The shape gate's two extra clauses are the interesting
      // half: `null` and `[]` both pass `typeof === "object"`, so a copy reduced to the `typeof`
      // check admits an array as a preferences patch and merges its indices into a user's settings.
      // Every export survives and every honest patch still works, which is why this needs a probe
      // that refuses rather than an export-surface check.
      [
        "a preferences shape gate reduced to its typeof check",
        "user-preferences-runtime.js",
        originals["user-preferences-runtime.js"].replace(
          'if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {',
          'if (typeof patch !== "object") {',
        ),
        /answer the skew probe differently/,
      ],
      // The JSON check, which is this module's only call out of itself. Dropping it is the shape that
      // reaches production as a row the runtime cannot read back rather than as an error, and the
      // shape gate goes on refusing everything it refused before — so only the two probe cases that
      // are plain objects JSON cannot carry can see it.
      [
        "a preferences validator that stopped checking JSON compatibility",
        "user-preferences-runtime.js",
        originals["user-preferences-runtime.js"].replace(
          "    assertJsonCompatible(patch);\n    return patch;",
          "    return patch;",
        ),
        /answer the skew probe differently/,
      ],
      // The private error factory, reached through nothing but the two functions above — the same
      // case as the auth, mail and jobs private helpers, at this domain's scale. A dropped `code`
      // turns every refused patch into `updateCurrentUserPreferences`'s generic failure branch
      // instead of the specific one, which is a wrong error to a Capsule author rather than a wrong
      // verdict, and `probedAnswer` compares the code for exactly this reason.
      [
        "a private preferences error factory that stopped carrying its code",
        "user-preferences-runtime.js",
        originals["user-preferences-runtime.js"].replace(
          "    return { code, message, hint };",
          "    return { message, hint };",
        ),
        /answer the skew probe differently/,
      ],
      // The table this domain creates, which no verdict-shaped probe could reach. A deployed Capsule
      // that created `[value]` nullable would accept a preferences row the read path then cannot
      // parse — silent at create time and a `JSON.parse` failure much later.
      [
        "a preferences table created with a different schema",
        "user-preferences-runtime.js",
        originals["user-preferences-runtime.js"].replace("[value] TEXT NOT NULL, ", "[value] TEXT, "),
        /answer the skew probe differently/,
      ],
      // The export surface, on the module whose probe needs a name that nothing else resolves.
      // `normalizePreferencesPatch` is exported for the probe rather than for a consumer, so this is
      // the case that proves the export-surface check still covers a name with no other caller.
      [
        "a preferences module that stopped exporting what the probe asks it",
        "user-preferences-runtime.js",
        originals["user-preferences-runtime.js"].replace("export function normalizePreferencesPatch", "function normalizePreferencesPatch"),
        /did not build|export a different set of names|do not supply/,
      ],
      // Batch 6's domain, file and object storage. The signing path first, because it is the limb
      // whose loss is loudest in production and quietest here: a carried copy that derived its
      // signing key from a different scope exports every name, builds every adapter, and then
      // authenticates against no S3-compatible endpoint at all. The region is the part of the scope
      // an operator would blame last.
      [
        "an S3 signing key derived from a different credential scope",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          'const dateRegionServiceKey = s3Hmac(dateRegionKey, "s3");',
          'const dateRegionServiceKey = s3Hmac(dateRegionKey, "s3-compatible");',
        ),
        /answer the skew probe differently/,
      ],
      // And a quieter one in the same path: the canonical request loses the payload hash. The header
      // stays well-formed and the signature stays 64 hex characters, so only a value comparison sees
      // it — and it would let a modified body be presented under a signature that never covered it.
      [
        "a canonical request that stopped covering the payload hash",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          "const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join(\"\\n\");",
          "const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders].join(\"\\n\");",
        ),
        /answer the skew probe differently/,
      ],
      // The percent-encoding of a canonical path segment. `encodeURIComponent` leaves six characters
      // alone that S3 request signing does not, so a copy reduced to it signs a path the endpoint
      // disagrees with — for exactly the File names containing a quote or a parenthesis, and no
      // others. That is a failure that looks like a corrupt file rather than a signing bug.
      [
        "a canonical path segment that stopped re-encoding what encodeURIComponent leaves alone",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          "return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);",
          "return encodeURIComponent(segment);",
        ),
        /answer the skew probe differently/,
      ],
      // The Capsule storage namespace, which is a containment rather than a calculation: it is the
      // prefix that keeps one Capsule's objects out of another's inside a shared bucket. A copy
      // reduced to a truthiness check accepts `../other` and writes outside its own prefix, and
      // every honest namespace still works.
      [
        "a storage namespace gate reduced to a truthiness check",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          'if (typeof namespace !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) {',
          "if (!namespace) {",
        ),
        /answer the skew probe differently/,
      ],
      // The inline content-type allow-list. A copy that echoed the stored type back turns a stored
      // `text/html` into stored XSS served from the Capsule's own origin, and every image upload in
      // the suite still round-trips — which is why this needs a probe that refuses rather than an
      // export-surface check.
      [
        "an inline content-type allow-list that echoes the stored type back",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          "return safeInlineTypes.has(normalized) ? normalized : \"application/octet-stream\";",
          "return normalized;",
        ),
        /answer the skew probe differently/,
      ],
      // The absolute File path rule, which decides which row `files.get("/x/y")` reads. Reduced to a
      // `startsWith` check it stops collapsing repeated separators, so `/a//b` and `/a/b` become two
      // different paths against a unique index that thinks they are one file.
      [
        "a File path normalizer that stopped collapsing empty segments",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          'return `/${segments.join("/")}`;',
          "return raw;",
        ),
        /answer the skew probe differently/,
      ],
      // The public-URL expiry gate, which is the one place a Capsule author's `noExpiry` and their
      // `ttlSeconds` are kept from being passed together. A copy that accepted any number of choices
      // would take the first branch that matched and silently ignore the rest.
      [
        "a public URL expiry gate that stopped requiring exactly one choice",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace("if (choices.length !== 1) {", "if (choices.length > 99) {"),
        /answer the skew probe differently/,
      ],
      // The File metadata DDL, which no verdict-shaped probe reaches. The unique index is the whole
      // reason two live rows cannot share a path, so a deployed Capsule that created it without the
      // `WHERE` clause would refuse to store a second *version* of any file — and one created
      // without the index at all would let two live rows share a path, which is the state
      // `activeFilePathDedupeSql` exists to clean up.
      [
        "a File metadata table created without the live-path unique index",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          '"CREATE UNIQUE INDEX IF NOT EXISTS [sporades_files_path_active_unique] " +',
          '"CREATE INDEX IF NOT EXISTS [sporades_files_path_active_unique] " +',
        ),
        /answer the skew probe differently/,
      ],
      // And the private data migration that runs beside it. `activeFilePathDedupeSql` soft-deletes
      // the duplicates `filePathBackfillSql` can produce, and both are private — reachable through
      // nothing but `createFileStorageTables`, which is why that limb exists.
      [
        "a File path backfill that stopped disambiguating duplicate names",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace(
          "\"ELSE '/' || [bucketName] || '/' || [id] || '/' || [name] END \" +",
          "\"ELSE '/' || [bucketName] || '/' || [name] END \" +",
        ),
        /answer the skew probe differently/,
      ],
      // The export surface, on the module the monolith imports sixteen names from.
      [
        "a storage module that stopped exporting what the monolith imports",
        "file-storage-runtime.js",
        originals["file-storage-runtime.js"].replace("export function createFileStorageTables", "function createFileStorageTables"),
        /did not build|export a different set of names|do not supply/,
      ],
      // And the ADR-0042 accessor written the way ADR-0041 refuses, asked of the third domain to need
      // it. `s3Hmac` and `s3Sha256Hex` are synchronous and inside the signature `s3Request` builds
      // before it opens a socket, so neither the dynamic form nor the Web Crypto global is open to
      // them; if the accessor were ever replaced by the import it reads like, the build must refuse.
      [
        "the storage domain reaching node:crypto through a static import instead of the accessor",
        "file-storage-runtime.js",
        `import { createHmac } from "node:crypto";\n${originals["file-storage-runtime.js"].replace('return nodeCryptoModule.createHmac("sha256"', 'return createHmac("sha256"')}`,
        /would resolve node:crypto at runtime/,
      ],
      // `maybe-promise.js`, the non-domain module batch 6 extracted for the reason batch 3 extracted
      // `runtime-errors.js`. A copy that stopped recognising a thenable makes every adapter method on
      // the Postgres and libSQL engines return before its statement has run — the loudest possible
      // production failure, and completely silent to an export-surface check.
      [
        "a maybe-promise bridge that stopped recognising a thenable",
        "maybe-promise.js",
        originals["maybe-promise.js"].replace(
          'return value && typeof value === "object" && typeof value.then === "function";',
          "return false;",
        ),
        /answer the skew probe differently/,
      ],
      // And the chaining arm, which the storage DDL limb reaches only in its synchronous lane. A copy
      // that ran every step eagerly instead of chaining would fire a table's statements out of order
      // against an asynchronous engine.
      [
        "a maybe-promise chain that stopped sequencing its steps",
        "maybe-promise.js",
        originals["maybe-promise.js"].replace("pending = pending.then(step);", "step();"),
        /answer the skew probe differently/,
      ],
      // The export surface, on a module whose three names the monolith all imports back.
      [
        "a maybe-promise module that stopped exporting what the monolith imports",
        "maybe-promise.js",
        originals["maybe-promise.js"].replace("export function thenIfPromise", "function thenIfPromise"),
        /did not build|export a different set of names|do not supply/,
      ],
    ];

    for (const [description, file, skewed, expected] of skews) {
      assert.notEqual(skewed, originals[file], `the ${description} case did not actually change ${file}`);
      await assert.rejects(
        async () => blockWith(file, skewed),
        (error) => {
          assert.match(error.message, expected, `wrong rejection for ${description}: ${error.message}`);
          assert.match(error.hint, /npm run build|reinstall the Sporades CLI|migrated runtime module/i, `no actionable hint for ${description}`);
          return true;
        },
        `${description} was carried into the bundle instead of failing the build`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the emitted-list bundle carries the migrated modules' private helpers, which no list registers", () => {
  // Criterion 2 of the ticket this landed under, asserted rather than described. A private helper of
  // a migrated module is exported from nothing and appears in no emitted list, and it still reaches
  // the bundle that ships — because that bundle carries the module whole rather than one registered
  // function at a time.
  //
  // Under the old mechanism this was impossible: a runtime function reached the bundle as its own
  // source text, so a helper it called and nobody registered was a `ReferenceError` the first time a
  // deployed Capsule executed that path, invisible to a green suite. Four names shipped that way.
  const bundle = createServerBundleSource({
    config: capsuleConfig(),
    serverEnv: {},
    serverSource: "",
    serverModuleSource: "export default {};",
  });

  const migratedModules = {
    ...inspectionSqlModule, ...logIndexGuardModule, ...mailConfigModule, ...mailRuntimeModule,
    ...fileStorageRuntimeModule, ...maybePromiseModule,
  };
  // `readSqlIdentifier` is the log-index guard's, and it became private in the same change that made
  // the guard a module: it was an entry in the emitted list until then, because a helper the list
  // did not carry was a `ReferenceError` rather than a compile error.
  //
  // The four MIME and provider helpers after it are the mail domain's, and they are the same story
  // at twenty-one times the scale: every one was a registered entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS`
  // until batch 2, purely because a helper the list did not carry could not be called from one it did.
  for (const helper of [
    "nestingBlockCommentEnd",
    "opensQuotedRun",
    "readSqlIdentifier",
    "encodeMimeHeaderValue",
    "foldMimeHeader",
    "normalizePostmarkProvider",
    "mailError",
    // The storage domain's, batch 6, and the same story again at twenty-seven. `s3Hmac` is the
    // whole S3 signing path's HMAC and `resolveLiveFileReference` is what every ownership-scoped
    // File lookup resolves through — both were emitted-list entries until this batch, purely
    // because a helper the list did not carry could not be called from one it did, and both are
    // now exported from nothing and named in no list.
    "s3Hmac",
    "resolveLiveFileReference",
  ]) {
    assert.equal(
      Object.keys(migratedModules).includes(helper),
      false,
      `${helper} is exported, so it is not the private helper this asserts`,
    );
    assert.equal(
      SERVER_RUNTIME_SOURCE_FUNCTIONS.some((fn) => fn.name === helper),
      false,
      `${helper} is registered in the emitted list, so it is not travelling on the module's terms`,
    );
    assert.match(bundle, new RegExp(`function ${helper}\\(`), `${helper} did not reach the emitted-list bundle`);
  }

  // And the migrated regions' own entry points are no longer in the emitted list either — each
  // travels as its module rather than as the registrations it used to need.
  for (const moved of [
    "validateReadOnlyInspectionSql",
    "skipSqlQuotedOrCommented",
    "sqlWithoutTrailingTerminator",
    "targetsInternalLogIndexTable",
    "readSqlTableReference",
    "isInternalLogIndexMetadataRow",
    "createMailRuntime",
    "createMailTransport",
    "buildSmtpMessage",
    // `validateMailConfig` is the one this batch changed rather than moved. It has lived in
    // `mail-config.ts` all along and reached the bundle by *also* being an entry in the emitted
    // list — the arrangement ADR-0041 opens by describing as the cheapest thing that works for a
    // leaf function. It is carried module text now, so the entry had to go or the bundle would
    // declare it twice.
    "validateMailConfig",
    // Batch 6's entry points, one per shape the storage domain reaches the bundle in: an engine
    // constructor, an upload-lifecycle entry point the WebSocket hub dispatches, the DDL the shared
    // adapter method set calls, and one of `maybe-promise`'s three, which nine still-registered
    // runtime functions call from their own source text.
    "createS3CompatibleFileStorageAdapter",
    "createPendingFileUpload",
    "createFileStorageTables",
    "isPromiseLike",
  ]) {
    assert.equal(
      SERVER_RUNTIME_SOURCE_FUNCTIONS.some((fn) => fn.name === moved),
      false,
      `${moved} is still registered in the emitted list as well as living in the module, which would declare it twice`,
    );
    assert.match(bundle, new RegExp(`function ${moved}\\(`), `${moved} did not reach the emitted-list bundle`);
  }

  // One copy of each, not one per module that imports it. The migrated modules are bundled into a
  // single block precisely so that carrying a module which imports the inspection gate does not put
  // a second copy of the one tokenizer into the artifact — see `migratedRuntimeModulesBlockFrom`.
  for (const shared of ["skipSqlQuotedOrCommented", "skipSqlTrivia", "readSqlQuotedIdentifier"]) {
    assert.equal(
      bundle.split(`function ${shared}(`).length - 1,
      1,
      `${shared} appears in the emitted-list bundle more than once — the migrated modules are being carried separately`,
    );
  }

  // ADR-0040: the block is spliced into an ES module, so a `require(…)` in it is not a slow path, it
  // is a Capsule that does not boot. That is exactly what `transformSync` produced for a module with
  // an import of its own, which is why the carrier bundles instead.
  assert.equal(bundle.includes("require("), false, "the emitted-list bundle would resolve a specifier at runtime");
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
