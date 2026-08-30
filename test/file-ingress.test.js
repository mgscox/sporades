import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, requireAuth } from "../dist/server.js";
import { openDevDatabase, routeEndpoint, runEndpoint } from "../dist/server-runtime-source.js";
import { multipartParts } from "../dist/file-ingress-runtime.js";

function multipart(boundary, headers = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain', bytes = "hello") {
  return Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n${bytes}\r\n--${boundary}--`);
}
async function* splitEvery(bytes, size) { for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size); }

test("multipart framing survives every one-byte boundary/header split and keeps boundary-like payload bytes", async () => {
  const boundary = "split-boundary"; const payload = "one\r\n--not-the-boundary\r\ntwo"; const source = multipart(boundary, undefined, payload);
  for (let split = 1; split <= source.length; split += 1) {
    const parts = []; for await (const part of multipartParts(splitEvery(source, split), boundary, 10000, 10000)) parts.push(part);
    assert.equal(parts.length, 1, `split ${split}`); assert.equal(parts[0].body.toString(), payload, `split ${split}`);
  }
});

test("multipart framing rejects malformed terminators and bounded headers/parts", async () => {
  const boundary = "limits";
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\na\r\n--${boundary}X`), 1), boundary, 1000, 1000)) {} }, { code: "INVALID_MULTIPART" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, `X: ${"a".repeat(17000)}`), 17), boundary, 20000, 20000)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, undefined, "x".repeat(20)), 1), boundary, 1000, 10)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
});

test("denied multipart admission does not advance the file-body source or create ingress state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-denied-"));
  try {
    const definition = endpoint({ method: "POST", path: "/denied", body: { multipart: { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true } } }, requireAuth(() => ({ body: { ok: true } })));
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "denied", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "denied" }));
    let reads = 0; const request = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "idempotency-key": "request" }, async *[Symbol.asyncIterator]() { reads += 1; yield multipart("x"); } };
    await assert.rejects(runEndpoint(database, { ...definition, options: definition.options }, new URL("http://localhost/denied"), request), { code: "UNAUTHENTICATED" });
    assert.equal(reads, 0); assert.equal(database.__sporadesIngressLeases, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("disconnects in every multipart parser state reject without yielding a staged part", async () => {
  const boundary = "cut";
  const cuts = [Buffer.from(`--${boundary}`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\npayload`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\npayload\r\n--${boundary}`)];
  for (const bytes of cuts) {
    const yielded = [];
    await assert.rejects(async () => { for await (const part of multipartParts(splitEvery(bytes, 1), boundary, 1000, 1000)) yielded.push(part); }, { code: "INVALID_MULTIPART" });
    assert.deepEqual(yielded, []);
  }
});

test("trusted multipart ingress leases bytes before the handler and claim atomically creates an ordinary private File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-")); let server;
  try {
    const definition = capsule({ name: "ingress", endpoints: {
      upload: endpoint({ method: "POST", path: "/upload", body: { multipart: { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true } } }, requireAuth(async (ctx) => {
        assert.equal(ctx.request.body, null); assert.equal(ctx.request.multipart.files.length, 1);
        const file = await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/a.txt" });
        return { body: file };
      })),
    } });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "ingress", files: { storagePath: path.join(dir, "files") } }, definition);
    await database.adapter.insertAuthUser({ id: "user", createdAt: new Date().toISOString(), displayName: "user", email: "u@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "session", userId: "user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    server = createServer(async (req, res) => { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const { port } = server.address();
    const boundary = "ingress-boundary"; const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: a\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const response = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": "request-a", "x-sporades-session-token": "session" }, body });
    const responseBody = await response.json();
    if (response.status !== 200) console.log(await database.log.tail(20));
    assert.equal(response.status, 200, JSON.stringify(responseBody)); const file = responseBody;
    assert.equal(file.path, "/attachments/a.txt"); assert.equal((await database.adapter.selectFileById(file.id)).status, "uploaded");
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
