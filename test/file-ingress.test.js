import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { capsule, endpoint, requireAuth, String as StringField, table } from "../dist/server.js";
import { openDevDatabase, routeEndpoint, runEndpoint } from "../dist/server-runtime-source.js";
import { createEndpointIngressApi, multipartParts, stageMultipartIngress, sweepExpiredFileIngress } from "../dist/file-ingress-runtime.js";
import { capsuleIngressAuthUserId } from "../dist/auth-runtime.js";
import { accessKeyVerifierDigest, createAccessKeySecret } from "../dist/access-keys-runtime.js";
import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";

function multipart(boundary, headers = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain', bytes = "hello") {
  return Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n${bytes}\r\n--${boundary}--`);
}
function multipartMany(boundary, parts) {
  return Buffer.from(parts.map(({ headers, body }) => `--${boundary}\r\n${headers}\r\n\r\n${body}\r\n`).join("") + `--${boundary}--`);
}
async function* splitEvery(bytes, size) { for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size); }

test("multipart framing survives every one-byte boundary/header split and keeps boundary-like payload bytes", async () => {
  const boundary = "split-boundary"; const payload = "one\r\n--not-the-boundary\r\ntwo"; const source = multipart(boundary, undefined, payload);
  for (let split = 1; split <= source.length; split += 1) {
    const parts = []; for await (const part of multipartParts(splitEvery(source, split), boundary, 10000, 10000)) parts.push(part);
    assert.equal(parts.length, 1, `split ${split}`); assert.equal(parts[0].body.toString(), payload, `split ${split}`);
  }
});

test("multipart framing retains false boundary prefixes, including binary suffixes split from the prefix", async () => {
  const boundary = "false-prefix";
  const falsePrefixes = Buffer.concat([Buffer.from("before\r\n--false-prefixXmiddle\r\n--false-prefix"), Buffer.from([0]), Buffer.from("after")]);
  const source = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="binary.bin"\r\n\r\n`), falsePrefixes, Buffer.from(`\r\n--${boundary}--`)]);
  for (let split = 1; split <= source.length; split += 1) {
    const parts = []; for await (const part of multipartParts(splitEvery(source, split), boundary, 10000, 10000)) parts.push(part);
    assert.equal(parts.length, 1, `split ${split}`); assert.deepEqual(parts[0].body, falsePrefixes, `split ${split}`);
  }
});

test("multipart policy rejects missing and non-finite or fractional limits before reading request bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-invalid-limits-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-limits" }, capsule({ name: "invalid-limits" }));
    const invalid = [undefined, NaN, Infinity, -Infinity, 1.5, "1"];
    for (const name of ["maxFiles", "maxFileBytes", "maxTotalFileBytes", "maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes"]) {
      for (const value of invalid) {
        const policy = { ...ingressPolicy(), [name]: value }; let reads = 0;
        const request = { async *[Symbol.asyncIterator]() { reads += 1; yield multipart("invalid"); } };
        await assert.rejects(stageMultipartIngress(database, { options: { method: "POST", path: "/invalid", body: { multipart: policy } } }, request, { headers: { "content-type": "multipart/form-data; boundary=invalid", "idempotency-key": "request" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" });
        assert.equal(reads, 0, `${name}=${String(value)}`);
      }
    }
    for (const [name, value] of [["maxFiles", 0], ["maxFileBytes", 0], ["maxTotalFileBytes", 0], ["maxFieldCount", -1], ["maxFieldBytes", -1], ["maxTotalFieldBytes", -1]]) {
      await assert.rejects(stageMultipartIngress(database, { options: { method: "POST", path: "/invalid", body: { multipart: { ...ingressPolicy(), [name]: value } } } }, { async *[Symbol.asyncIterator]() { throw new Error("must not read"); } }, { headers: { "content-type": "multipart/form-data; boundary=invalid", "idempotency-key": "request" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" });
    }
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule startup rejects an invalid untyped multipart declaration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-invalid-startup-"));
  try {
    const definition = capsule({ name: "invalid-startup", endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart: { ...ingressPolicy(), maxFileBytes: NaN } } }, () => ({ ok: true })) } });
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-startup" }, definition), { code: "INVALID_MULTIPART_POLICY" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("length-framed ingress keys distinguish delimiter-collision tuples", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-framed-key-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "framed-key", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "framed-key" }));
    const policy = ingressPolicy(); const make = (endpointPath, actorId, requestKey, partKey, body) => stageMultipartIngress(database, { options: { method: "POST", path: endpointPath, body: { multipart: policy } } }, { async *[Symbol.asyncIterator]() { yield multipart("framed", `Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: ${partKey}`, body); } }, { headers: { "content-type": "multipart/form-data; boundary=framed", "idempotency-key": requestKey } }, { userId: actorId });
    const first = await make("/upload", "actor", "a:b", "c", "first"); const second = await make("/upload", "actor", "a", "b:c", "second");
    assert.notEqual(first.multipart.files[0].leaseId, second.multipart.files[0].leaseId);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("multipart framing rejects malformed terminators and bounded headers/parts", async () => {
  const boundary = "limits";
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\na\r\n--${boundary}X`), 1), boundary, 1000, 1000)) {} }, { code: "INVALID_MULTIPART" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, `X: ${"a".repeat(17000)}`), 17), boundary, 20000, 20000)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, undefined, "x".repeat(20)), 1), boundary, 1000, 10)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
});

test("declared non-Content-ID part-key headers are case-insensitive and replay one stable lease", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-custom-part-key-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "custom-part-key", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "custom-part-key" }));
    const policy = { ...ingressPolicy(), partKeyHeader: "x-upload-part-key", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/custom-part-key", body: { multipart: policy } } };
    const headers = { "content-type": "multipart/form-data; boundary=custom-key", "idempotency-key": "stable-request" };
    const request = () => ({ async *[Symbol.asyncIterator]() { yield multipart("custom-key", 'Content-Disposition: form-data; name="file"; filename="custom.txt"\r\nContent-Type: text/plain\r\nX-UPLOAD-PART-KEY: <opaque>', "custom-bytes"); } });
    const first = await stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" });
    const replay = await stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" });
    assert.equal(replay.multipart.files[0].leaseId, first.multipart.files[0].leaseId);
    let receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(receipt.partKey, "<opaque>");
    const legacyEndpoint = { options: { method: "POST", path: "/legacy-content-id", body: { multipart: ingressPolicy() } } };
    const legacyHeaders = { "content-type": "multipart/form-data; boundary=legacy-key", "idempotency-key": "legacy-request" };
    const legacyRequest = { async *[Symbol.asyncIterator]() { yield multipart("legacy-key", 'Content-Disposition: form-data; name="file"; filename="legacy.txt"\r\nContent-Type: text/plain\r\nContent-ID: <legacy>', "legacy-bytes"); } };
    await stageMultipartIngress(database, legacyEndpoint, legacyRequest, { headers: legacyHeaders }, { userId: "actor" });
    receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress] WHERE [requestKey] = ?").get("legacy-request")).payload); assert.equal(receipt.partKey, "legacy");
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a later field-count failure compensates only File parts won by this local request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-local-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-cleanup-local", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-cleanup-local" }));
    const endpoint = { options: { method: "POST", path: "/request-cleanup", body: { multipart: { ...ingressPolicy(), maxFieldCount: 1 } } } };
    const headersFor = (requestKey) => ({ "content-type": "multipart/form-data; boundary=request-cleanup", "idempotency-key": requestKey });
    const file = { headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "cleanup-bytes" };
    const tag = (body) => ({ headers: 'Content-Disposition: form-data; name="tag"', body });
    const request = (parts) => ({ async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup", parts); } });
    const writes = []; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes.push(input); return await write(input); };
    await assert.rejects(stageMultipartIngress(database, endpoint, request([file, tag("a"), tag("b")]), { headers: headersFor("new-failure") }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
    await assert.rejects(access(path.join(dir, "files", writes[0].fileId, writes[0].version)));

    const prior = await stageMultipartIngress(database, endpoint, request([file]), { headers: headersFor("pre-existing") }, { userId: "actor" }); const priorWrite = writes.at(-1);
    await assert.rejects(stageMultipartIngress(database, endpoint, request([file, tag("a"), tag("b")]), { headers: headersFor("pre-existing") }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    assert.ok(prior.multipart.files[0].leaseId); await access(path.join(dir, "files", priorWrite.fileId, priorWrite.version));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a later field-count failure removes the request-owned fake-MinIO object and receipt", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-minio-")); let database; const namespace = `cleanup-${randomUUID()}`;
    try {
      const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } }; const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, config, capsule({ name: namespace }), { serviceEnv });
      const endpoint = { options: { method: "POST", path: "/request-cleanup-minio", body: { multipart: { ...ingressPolicy(), maxFieldCount: 1 } } } };
      const headers = { "content-type": "multipart/form-data; boundary=request-cleanup-minio", "idempotency-key": "minio-failure" };
      const parts = [
        { headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "cleanup-bytes" },
        { headers: 'Content-Disposition: form-data; name="tag"', body: "a" },
        { headers: 'Content-Disposition: form-data; name="tag"', body: "b" },
      ];
      const request = { async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup-minio", parts); } };
      await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
      assert.deepEqual([...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`)), []);
    } finally { await database?.close(); for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key); await rm(dir, { recursive: true, force: true }); }
  });
});

test("a parser disconnect after a completed File part compensates its request-owned staging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-disconnect-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-disconnect", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-disconnect" }));
    const endpoint = { options: { method: "POST", path: "/request-disconnect", body: { multipart: ingressPolicy() } } };
    const headers = { "content-type": "multipart/form-data; boundary=request-disconnect", "idempotency-key": "disconnect" };
    const bytes = Buffer.from('--request-disconnect\r\nContent-Disposition: form-data; name="file"; filename="disconnect.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-disconnect\r\n\r\nfile-bytes\r\n--request-disconnect\r\nContent-Disposition: form-data; name="tag"\r\n\r\ntruncated');
    const request = { async *[Symbol.asyncIterator]() { yield bytes; } };
    await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers }, { userId: "actor" }), { code: "INVALID_MULTIPART" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("request staging retains the primary parser error when compensation also fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-error-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-cleanup-error", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-cleanup-error" }));
    const endpoint = { options: { method: "POST", path: "/request-cleanup-error", body: { multipart: { ...ingressPolicy(), maxFieldCount: 0 } } } };
    const headers = { "content-type": "multipart/form-data; boundary=request-cleanup-error", "idempotency-key": "cleanup-error" };
    const parts = [{ headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "bytes" }, { headers: 'Content-Disposition: form-data; name="tag"', body: "a" }];
    const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage); database.fileStorage.deleteFileVersion = async () => { throw new Error("controlled cleanup failure"); };
    await assert.rejects(stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup-error", parts); } }, { headers }, { userId: "actor" }), (error) => error instanceof AggregateError && error.errors[0]?.code === "MULTIPART_LIMIT_EXCEEDED" && /controlled cleanup failure/.test(error.errors[1]?.message));
    database.fileStorage.deleteFileVersion = remove;
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("maxFieldCount accepts the exact text-part boundary and rejects one repeated-name part beyond it without residue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-field-count-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "field-count", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "field-count" }));
    const endpoint = { options: { method: "POST", path: "/field-count", body: { multipart: { ...ingressPolicy(), maxFieldCount: 2 } } } };
    const headers = { "content-type": "multipart/form-data; boundary=fields", "idempotency-key": "field-request" };
    const part = (body) => ({ headers: 'Content-Disposition: form-data; name="tag"', body });
    const request = (parts) => ({ async *[Symbol.asyncIterator]() { yield multipartMany("fields", parts); } });
    const exact = await stageMultipartIngress(database, endpoint, request([part("a"), part("b")]), { headers }, { userId: "actor" });
    assert.deepEqual(exact.multipart.fields, { tag: ["a", "b"] });
    await assert.rejects(stageMultipartIngress(database, endpoint, request([part("a"), part("b"), part("c")]), { headers }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
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

test("twenty concurrent identical ingress receipts stage one durable lease", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-race-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "race", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "race" }));
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/race", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=race", "idempotency-key": "same" };
    let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const partHeaders = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-a';
    const makeRequest = () => ({ async *[Symbol.asyncIterator]() { yield multipart("race", partHeaders, "same-bytes"); } });
    const results = await Promise.all(Array.from({ length: 20 }, () => stageMultipartIngress(database, endpoint, makeRequest(), { headers }, { userId: "actor" })));
    assert.equal(new Set(results.map((result) => result.multipart.files[0].leaseId)).size, 1); assert.equal(writes, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed ingress claim rolls File, receipt claim, and app row back together", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-rollback-")); let fail = true;
  try {
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const definition = capsule({ name: "rollback", schema: { effects: table({ source: StringField() }) }, endpoints: { upload: endpoint({ method: "POST", path: "/rollback", body: { multipart: policy } }, requireAuth(async (ctx) => { const file = await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/retry.txt" }); await ctx.db.effects.insert({ source: "claimed" }); if (fail) throw new Error("rollback sentinel"); return file; })) } });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "rollback", files: { storagePath: path.join(dir, "files") } }, definition);
    await database.adapter.insertAuthUser({ id: "user", createdAt: new Date().toISOString(), displayName: "user", email: "u@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" }); await database.adapter.insertAuthSession({ token: "session", userId: "user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const route = database.endpoints[0]; const headers = { "content-type": "multipart/form-data; boundary=rollback", "idempotency-key": "retry", "x-sporades-session-token": "session" }; const request = () => ({ method: "POST", headers, async *[Symbol.asyncIterator]() { yield multipart("rollback", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable', "bytes"); } });
    await assert.rejects(runEndpoint(database, route, new URL("http://capsule.test/rollback"), request()), /rollback sentinel/);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), 0); let receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(receipt.state, "leased"); assert.equal(receipt.file, undefined);
    fail = false; const result = await runEndpoint(database, route, new URL("http://capsule.test/rollback"), request()); receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), 1); assert.equal(receipt.state, "complete"); assert.equal(receipt.file.id, result.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent incompatible ingress descriptors keep one winner and stage no loser bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-conflict-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "conflict", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "conflict" }));
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/conflict", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=conflict", "idempotency-key": "same" };
    let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const request = (name, type, body) => ({ async *[Symbol.asyncIterator]() { yield multipart("conflict", `Content-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\nContent-ID: stable-a`, body); } });
    const attempts = Array.from({ length: 20 }, (_, index) => index % 2 ? stageMultipartIngress(database, endpoint, request("one.txt", "text/plain", "one"), { headers }, { userId: "actor" }) : stageMultipartIngress(database, endpoint, request("two.bin", "application/octet-stream", "two"), { headers }, { userId: "actor" }));
    const settled = await Promise.allSettled(attempts); const winners = settled.filter((result) => result.status === "fulfilled"); const losers = settled.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 10); assert.equal(losers.length, 10); assert.equal(writes, 1); assert.ok(losers.every((result) => result.reason?.code === "INGRESS_DESCRIPTOR_CONFLICT"));
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("response loss and reopen recover the same private ingress lease without another write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-reopen-"));
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "reopen", files: { storagePath: path.join(dir, "files") } }; const definition = capsule({ name: "reopen" });
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/reopen", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=reopen", "idempotency-key": "same" }; const partHeaders = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-a';
    const request = () => ({ async *[Symbol.asyncIterator]() { yield multipart("reopen", partHeaders, "persisted"); } });
    let writes = 0; let first = await openDevDatabase(dbPath, "", {}, config, definition); const write = first.fileStorage.writeFileVersion.bind(first.fileStorage); first.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    await stageMultipartIngress(first, endpoint, request(), { headers }, { userId: "actor" }); await first.close(); first = null;
    const second = await openDevDatabase(dbPath, "", {}, config, definition); const retry = await stageMultipartIngress(second, endpoint, request(), { headers }, { userId: "actor" });
    assert.equal(writes, 1); assert.equal(Number((await second.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1); const receipt = JSON.parse((await second.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(retry.multipart.files[0].leaseId, receipt.leaseId); assert.equal(await second.adapter.selectFileById(receipt.fileId), null); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pre-authority actor receipt keys recover leased and completed retries without duplicate state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-legacy-actor-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const actorId = "legacy-actor"; const endpointPath = "/legacy"; const partKey = "stable-claim"; const bytes = Buffer.from("claim-bytes");
    const oldDatabase = new DatabaseSync(dbPath);
    oldDatabase.exec("CREATE TABLE [sporades_file_ingress] ([key] TEXT PRIMARY KEY, [payload] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
    const makeReceipt = (requestKey, state, fileId, version) => {
      const key = `POST:${endpointPath}:${actorId}:${requestKey}:${partKey}`;
      const row = { key, leaseId: `lease-${requestKey}`, partId: createHash("sha256").update(key).digest("hex"), fieldName: "file", name: "claim.txt", type: "text/plain", size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), fileId, version, state, actorId, endpointMethod: "POST", endpointPath, requestKey, partKey, expiresAt: "2099-01-01T00:00:00.000Z" };
      oldDatabase.prepare("INSERT INTO [sporades_file_ingress] ([key], [payload], [updatedAt]) VALUES (?, ?, ?)").run(key, JSON.stringify(row), "2026-01-01T00:00:00.000Z"); return row;
    };
    const leased = makeReceipt("legacy-leased", "leased", "legacy-leased-file", "legacy-leased-version");
    const completed = makeReceipt("legacy-complete", "complete", "legacy-complete-file", "legacy-complete-version");
    completed.file = { id: completed.fileId, ownerId: actorId, bucketId: "legacy-bucket", bucketName: "default", path: "/attachments/legacy-complete.txt", name: completed.name, type: completed.type, size: completed.size, version: completed.version, status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    oldDatabase.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(completed), completed.key); oldDatabase.close();
    const definition = capsule({ name: "legacy-actor", endpoints: {
      upload: endpoint(
        { method: "POST", path: endpointPath, body: { multipart: ingressPolicy() } },
        requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], {
          path: ctx.request.headers["idempotency-key"] === "legacy-complete" ? "/attachments/legacy-complete.txt" : "/attachments/legacy-leased.txt",
        })),
      ),
    } });
    const config = { name: "legacy-actor", files: { storagePath: path.join(dir, "files") } };
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    await database.adapter.insertAuthUser({ id: actorId, createdAt: new Date().toISOString(), displayName: "legacy", email: "legacy@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "claim-session", userId: actorId, provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    await database.fileStorage.writeFileVersion({ fileId: leased.fileId, version: leased.version, bytes });
    await database.adapter.createFileBucket({ id: "legacy-bucket", ownerId: actorId, name: "default", createdAt: "2026-01-01T00:00:00.000Z" });
    await database.adapter.insertFileRow(completed.file); await database.close(); database = null;
    database = await openDevDatabase(dbPath, "", {}, config, definition); let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const statusApi = (requestKey) => createEndpointIngressApi(database, database.endpoints[0], { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId, ownerId: actorId } }, { auth: { userId: actorId, isAuthenticated: true, isGuest: false } });
    const leasedStatus = await statusApi("legacy-leased").status("legacy-leased", partKey); assert.equal(leasedStatus.state, "leased"); assert.equal(leasedStatus.lease.leaseId, leased.leaseId);
    const completedStatus = await statusApi("legacy-complete").status("legacy-complete", partKey); assert.equal(completedStatus.state, "complete"); assert.equal(completedStatus.file.id, completed.fileId);
    const leasedRetry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/legacy"), ingressRequest("legacy-leased"));
    const completedRetry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/legacy"), ingressRequest("legacy-complete"));
    assert.equal(leasedRetry.id, leased.fileId); assert.equal(completedRetry.id, completed.fileId); assert.equal(writes, 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 2);
    assert.equal((await database.adapter.selectIngressByLease(leased.leaseId)).key, leased.key); assert.equal((await database.adapter.selectIngressByLease(completed.leaseId)).key, completed.key);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
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

function ingressPolicy() {
  return { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
}

async function seedIngressUser(database) {
  await database.adapter.insertAuthUser({ id: "claim-user", createdAt: new Date().toISOString(), displayName: "claim user", email: "claim@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
  await database.adapter.insertAuthSession({ token: "claim-session", userId: "claim-user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
}

function ingressRequest(requestKey = "claim-request") {
  const headers = { "content-type": "multipart/form-data; boundary=claim", "idempotency-key": requestKey, "x-sporades-session-token": "claim-session" };
  return { method: "POST", headers, async *[Symbol.asyncIterator]() { yield multipart("claim", 'Content-Disposition: form-data; name="file"; filename="claim.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim', "claim-bytes"); } };
}

async function seedIngressAccessKey(database, ownerUserId = "service-owner") {
  await database.adapter.insertAuthUser({ id: ownerUserId, createdAt: new Date().toISOString(), displayName: "service owner", email: null, picture: null, isAuthenticated: 1, isGuest: 0, provider: "service" });
  const secret = createAccessKeySecret();
  assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
    id: "service-ingress-key", ownerUserId, name: "service ingress", reservedName: "service ingress",
    grantsJson: JSON.stringify(["attachments:write"]), secretVersion: 1, selector: secret.selector,
    verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier), lifecycleRevision: 1,
    createdAt: new Date().toISOString(), expiresAt: null,
  })), { status: "issued" });
  return secret.token;
}

function accessKeyIngressRequest(token, requestKey = "service-request") {
  const request = ingressRequest(requestKey);
  delete request.headers["x-sporades-session-token"];
  request.headers.authorization = `Bearer ${token}`;
  request.rawHeaders = Object.entries(request.headers).flatMap(([name, value]) => [name, value]);
  return request;
}

async function expireIngressReceipt(database, leaseId, expiresAt = "2000-01-01T00:00:00.000Z") {
  const stored = await database.adapter.selectIngressByLease(leaseId); const payload = JSON.parse(stored.payload); payload.expiresAt = expiresAt;
  await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [expiresAt] = ?, [payload] = ? WHERE [leaseId] = ?").run(expiresAt, JSON.stringify(payload), leaseId);
  return payload;
}

test("Capsule ingress owners are deterministic reserved identities with no login or access-key surface", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-reserved-owner-")); let database;
  try {
    const ownerId = capsuleIngressAuthUserId("reserved-owner");
    assert.equal(ownerId, capsuleIngressAuthUserId("reserved-owner"));
    assert.notEqual(ownerId, capsuleIngressAuthUserId("another-capsule"));
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "reserved-owner", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "reserved-owner" }));
    assert.throws(() => database.adapter.insertAuthUser({ id: ownerId, createdAt: new Date().toISOString(), displayName: "forbidden", email: null, picture: null, isAuthenticated: 1, isGuest: 0, provider: "service" }), { code: "RESERVED_AUTH_USER_ID" });
    assert.throws(() => database.adapter.insertAuthSession({ token: "forbidden", userId: ownerId, provider: "service", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" }), { code: "RESERVED_AUTH_USER_ID" });
    const secret = createAccessKeySecret();
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id: "forbidden-key", ownerUserId: ownerId, name: "forbidden", reservedName: "forbidden", grantsJson: "[]", secretVersion: 1, selector: secret.selector, verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier), lifecycleRevision: 1, createdAt: new Date().toISOString(), expiresAt: null })), { status: "owner-ineligible" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?").get(ownerId)).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a scoped service-user Access key claims a File owned by that non-session actor across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-service-owner-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "service-owner", files: { storagePath: path.join(dir, "files") }, accessKeys: { enabled: true } };
    const definition = capsule({ name: "service-owner", accessKeys: { scopes: ["attachments:write"] }, endpoints: { upload: endpoint({ method: "POST", path: "/service", body: { multipart: ingressPolicy() } }, requireAuth({ credentials: ["access-key"], scopes: ["attachments:write"] }, async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/service.txt" }))) } });
    database = await openDevDatabase(dbPath, "", {}, config, definition); const token = await seedIngressAccessKey(database);
    const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/service"), accessKeyIngressRequest(token));
    assert.equal((await database.adapter.selectFileById(first.id)).ownerId, "service-owner");
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [userId] = ?").get("service-owner")).count), 0);
    await database.close(); database = await openDevDatabase(dbPath, "", {}, config, definition);
    const retry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/service"), accessKeyIngressRequest(token));
    assert.equal(retry.id, first.id); assert.equal((await database.adapter.selectFileById(first.id)).ownerId, "service-owner");
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal claims persist a reserved owner and digest, never the raw principal key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-owner-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "principal-owner", files: { storagePath: path.join(dir, "files") } };
    const definition = capsule({ name: "principal-owner", files: { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ["application"], admit: ({ request }) => ({ allow: true, principal: { namespace: "application", key: request.headers["x-app-key"] } }) } }, endpoints: { upload: endpoint({ method: "POST", path: "/principal", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/principal.txt", authority: { kind: "capsule-principal", ...ctx.ingress.principal } })) } });
    const request = () => { const value = ingressRequest("principal-request"); delete value.headers["x-sporades-session-token"]; value.headers["x-app-key"] = "app-a-secret"; return value; };
    database = await openDevDatabase(dbPath, "", {}, config, definition); const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/principal"), request());
    const ownerId = capsuleIngressAuthUserId("principal-owner"); const receipt = await database.adapter.selectIngressByLease(JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload).leaseId);
    assert.equal((await database.adapter.selectFileById(first.id)).ownerId, ownerId); assert.equal(receipt.ownerId, ownerId); assert.equal(receipt.authorityKind, "capsule-principal"); assert.equal(receipt.principalNamespace, "application"); assert.equal(JSON.stringify(receipt).includes("app-a-secret"), false); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?").get(ownerId)).count), 0);
    await database.close(); database = await openDevDatabase(dbPath, "", {}, config, definition); const retry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/principal"), request());
    assert.equal(retry.id, first.id); assert.equal((await database.adapter.selectFileById(first.id)).ownerId, ownerId);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal status reports its leased and completed receipt while a wrong principal sees opaque missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-status-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "principal-status", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "principal-status" }));
    const endpoint = { options: { method: "POST", path: "/principal-status", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } } };
    const principalKey = "principal-status-key"; const namespace = "application";
    const authority = Object.freeze({ kind: "capsule-principal", namespace, key: principalKey, keyDigest: createHash("sha256").update(`${namespace}\0${principalKey}`, "utf8").digest("hex"), ownerId: database.capsuleIngressOwnerId });
    const request = ingressRequest("principal-status-request"); delete request.headers["x-sporades-session-token"];
    const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "" }, authority);
    const endpointRequest = { __ingressRequestKey: "principal-status-request", __ingressAuthority: authority };
    const api = createEndpointIngressApi(database, endpoint, endpointRequest, { auth: { userId: "", isAuthenticated: false, isGuest: true } });
    const leased = await api.status("principal-status-request", "stable-claim");
    assert.equal(leased.state, "leased"); assert.equal(leased.lease.leaseId, staged.multipart.files[0].leaseId);
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const consistent = JSON.parse(stored.payload); const inconsistent = { ...consistent, ownerId: "internal-wrong-owner" };
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(inconsistent), stored.key);
    assert.deepEqual(await api.status("principal-status-request", "stable-claim"), { state: "missing" });
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(consistent), stored.key);
    const file = await api.claim(staged.multipart.files[0], { path: "/attachments/principal-status.txt", authority: { kind: "capsule-principal", namespace, key: principalKey } });
    const completed = await api.status("principal-status-request", "stable-claim");
    assert.equal(completed.state, "complete"); assert.equal(completed.file.id, file.id);
    const wrongKey = "wrong-principal";
    const wrongAuthority = Object.freeze({ kind: "capsule-principal", namespace, key: wrongKey, keyDigest: createHash("sha256").update(`${namespace}\0${wrongKey}`, "utf8").digest("hex"), ownerId: database.capsuleIngressOwnerId });
    const wrongApi = createEndpointIngressApi(database, endpoint, { ...endpointRequest, __ingressAuthority: wrongAuthority }, { auth: { userId: "", isAuthenticated: false, isGuest: true } });
    assert.deepEqual(await wrongApi.status("principal-status-request", "stable-claim"), { state: "missing" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal ingress requires explicit read and delete ACL declarations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-acl-"));
  try {
    const definition = capsule({ name: "principal-acl", files: { ingress: { principalNamespaces: ["application"], admit: () => ({ allow: false }) } }, endpoints: { upload: endpoint({ method: "POST", path: "/principal-acl", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, () => null) } });
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "principal-acl", files: { storagePath: path.join(dir, "files") } }, definition), { code: "FILE_INGRESS_ACL_REQUIRED" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cross-principal and cross-Capsule claims fail with the same opaque authority denial", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-isolation-")); let first; let second; let retainedLease; let claimRetained = false;
  try {
    const files = { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ["application"], admit: ({ request }) => ({ allow: true, principal: { namespace: "application", key: request.headers["x-app-key"] } }) } };
    const makeDefinition = (name) => capsule({ name, files, endpoints: { upload: endpoint({ method: "POST", path: "/principal-isolation", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, async (ctx) => {
      if (!retainedLease) { retainedLease = ctx.request.multipart.files[0]; return retainedLease; }
      return await ctx.files.claim(claimRetained ? retainedLease : ctx.request.multipart.files[0], { path: "/attachments/isolation.txt", authority: { kind: "capsule-principal", ...ctx.ingress.principal } });
    }) } });
    const request = (key, requestKey) => { const value = ingressRequest(requestKey); delete value.headers["x-sporades-session-token"]; value.headers["x-app-key"] = key; return value; };
    first = await openDevDatabase(path.join(dir, "first.db"), "", {}, { name: "isolation-a", files: { storagePath: path.join(dir, "first-files") } }, makeDefinition("isolation-a"));
    await runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-a", "request-a")); claimRetained = true;
    let crossPrincipal; await assert.rejects(runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-b", "request-b")), (error) => { crossPrincipal = error; return error.code === "INGRESS_AUTHORITY_DENIED"; });
    second = await openDevDatabase(path.join(dir, "second.db"), "", {}, { name: "isolation-b", files: { storagePath: path.join(dir, "second-files") } }, makeDefinition("isolation-b"));
    let crossCapsule; await assert.rejects(runEndpoint(second, second.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-a", "request-c")), (error) => { crossCapsule = error; return error.code === "INGRESS_AUTHORITY_DENIED"; });
    assert.equal(crossPrincipal.message, crossCapsule.message); assert.equal(JSON.stringify(crossPrincipal).includes("app-a"), false); assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("trusted ingress has identical denial, claim, replay, restart, disconnect, and cleanup semantics on MinIO", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-minio-")); let database; const namespace = `ingress-${randomUUID()}`;
    try {
      let shouldClaim = true;
      const definition = capsule({ name: namespace, endpoints: {
        upload: endpoint({ method: "POST", path: "/minio", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => shouldClaim ? await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/minio.txt" }) : ctx.request.multipart.files[0])),
        denied: endpoint({ method: "POST", path: "/minio-denied", body: { multipart: ingressPolicy() } }, requireAuth(() => ({ body: { impossible: true } }))),
      } });
      const dbPath = path.join(dir, "data.db"); const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } };
      const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(dbPath, "", serviceEnv, config, definition, { serviceEnv }); await seedIngressUser(database);
      let deniedReads = 0; const denied = ingressRequest("minio-denied"); delete denied.headers["x-sporades-session-token"]; denied[Symbol.asyncIterator] = async function* () { deniedReads += 1; yield multipart("claim"); };
      await assert.rejects(runEndpoint(database, database.endpoints.find((route) => route.options.path === "/minio-denied"), new URL("http://capsule.test/minio-denied"), denied), { code: "UNAUTHENTICATED" }); assert.equal(deniedReads, 0); assert.equal(objects.size, 0);
      const route = database.endpoints.find((candidate) => candidate.options.path === "/minio");
      const claims = await Promise.all(Array.from({ length: 20 }, () => runEndpoint(database, route, new URL("http://capsule.test/minio"), ingressRequest("minio-claim"))));
      assert.equal(new Set(claims.map((file) => file.id)).size, 1); assert.equal(objects.size, 1); const canonicalKey = [...objects.keys()][0]; assert.ok(canonicalKey.startsWith(`capsules/${namespace}/files/`));
      await database.close(); database = await openDevDatabase(dbPath, "", serviceEnv, config, definition, { serviceEnv }); const replay = await runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), ingressRequest("minio-claim")); assert.equal(replay.id, claims[0].id); assert.deepEqual([...objects.keys()], [canonicalKey]);
      const truncated = ingressRequest("minio-truncated"); truncated[Symbol.asyncIterator] = async function* () { yield Buffer.from("--claim\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cut.txt\"\r\n\r\npartial"); };
      await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), truncated), { code: "INVALID_MULTIPART" }); assert.deepEqual([...objects.keys()], [canonicalKey]);
      shouldClaim = false; const orphan = await runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), ingressRequest("minio-orphan")); const orphanRow = await expireIngressReceipt(database, orphan.leaseId); const orphanKey = `capsules/${namespace}/files/${orphanRow.fileId}/${orphanRow.version}`; assert.equal(objects.has(orphanKey), true);
      const swept = await sweepExpiredFileIngress(database, { limit: 1 }); assert.equal(swept.cleaned.length, 1); assert.equal(objects.has(orphanKey), false); assert.deepEqual([...objects.keys()], [canonicalKey]);
    } finally {
      await database?.close();
      for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key);
      assert.equal([...objects.keys()].some((value) => value.startsWith(`capsules/${namespace}/`)), false);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("MinIO ingress accepts byte-fragmented multipart and leaves no residue for every disconnected parser state", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-minio-fragments-")); let database; const namespace = `ingress-fragments-${randomUUID()}`;
    try {
      const definition = capsule({ name: namespace, endpoints: { upload: endpoint({ method: "POST", path: "/fragments", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/fragmented.txt" }))) } });
      const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } }; const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, config, definition, { serviceEnv }); await seedIngressUser(database); const route = database.endpoints[0];
      const cuts = [
        Buffer.from("--claim"),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"'),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim\r\n\r\npartial'),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim\r\n\r\npartial\r\n--claim'),
      ];
      for (const [index, cut] of cuts.entries()) {
        const request = ingressRequest(`fragment-cut-${index}`); request[Symbol.asyncIterator] = async function* () { for (const byte of cut) yield Buffer.from([byte]); };
        await assert.rejects(runEndpoint(database, route, new URL("http://capsule.test/fragments"), request), { code: "INVALID_MULTIPART" });
        assert.deepEqual([...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`)), []);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
      }
      const source = multipart("claim", 'Content-Disposition: form-data; name="file"; filename="fragmented.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim', "fragmented-bytes"); const success = ingressRequest("fragment-success"); success[Symbol.asyncIterator] = async function* () { yield* splitEvery(source, 1); };
      const file = await runEndpoint(database, route, new URL("http://capsule.test/fragments"), success); const keys = [...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`));
      assert.deepEqual(keys, [`capsules/${namespace}/files/${file.id}/${file.version}`]); assert.equal(objects.get(keys[0]).toString(), "fragmented-bytes");
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1);
    } finally {
      await database?.close(); for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key); assert.equal([...objects.keys()].some((value) => value.startsWith(`capsules/${namespace}/`)), false); await rm(dir, { recursive: true, force: true });
    }
  });
});

test("twenty claims across two SQLite connections all recover one completed File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-two-connection-")); let first; let second;
  try {
    const definition = capsule({ name: "two-connection", endpoints: { upload: endpoint({ method: "POST", path: "/claim", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/claim.txt" }))) } });
    const dbPath = path.join(dir, "data.db"); const config = { name: "two-connection", files: { storagePath: path.join(dir, "files") } };
    first = await openDevDatabase(dbPath, "", {}, config, definition); second = await openDevDatabase(dbPath, "", {}, config, definition); await seedIngressUser(first);
    const attempts = Array.from({ length: 20 }, (_, index) => { const database = index % 2 ? first : second; return runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim"), ingressRequest()); });
    const settled = await Promise.allSettled(attempts);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 20, settled.filter((result) => result.status === "rejected").map((result) => result.reason?.message).join("\n"));
    assert.equal(new Set(settled.map((result) => result.value?.id)).size, 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_buckets]").get()).count), 1);
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed ingress retries reject a changed claim descriptor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-claim-conflict-")); let database;
  try {
    let changed = false;
    const definition = capsule({ name: "claim-conflict", endpoints: { upload: endpoint({ method: "POST", path: "/claim-conflict", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: changed ? "/attachments/changed.txt" : "/attachments/original.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "claim-conflict", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim-conflict"), ingressRequest("claim-conflict")); changed = true;
    await assert.rejects(runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim-conflict"), ingressRequest("claim-conflict")), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed ingress response-loss retry succeeds after the original lease expiry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-complete-expired-")); let database;
  try {
    const definition = capsule({ name: "complete-expired", endpoints: { upload: endpoint({ method: "POST", path: "/complete-expired", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/expired.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "complete-expired", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/complete-expired"), ingressRequest("complete-expired"));
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const payload = JSON.parse(stored.payload); payload.expiresAt = "2000-01-01T00:00:00.000Z";
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(payload), stored.key);
    const retried = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/complete-expired"), ingressRequest("complete-expired")); assert.equal(retried.id, first.id);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an expired unclaimed ingress lease is never claimable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-expired-claim-")); let database; let claim = false;
  try {
    const definition = capsule({ name: "expired-claim", endpoints: { upload: endpoint({ method: "POST", path: "/expired-claim", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => claim ? await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/expired-claim.txt" }) : ctx.request.multipart.files[0])) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "expired-claim", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    const lease = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/expired-claim"), ingressRequest("expired-claim")); await expireIngressReceipt(database, lease.leaseId); claim = true;
    await assert.rejects(runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/expired-claim"), ingressRequest("expired-claim")), { code: "INGRESS_LEASE_EXPIRED" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress sweep is bounded, deterministic, and deletes only expired staged objects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-bounded-sweep-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "bounded-sweep", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "bounded-sweep" }));
    const endpoint = { options: { method: "POST", path: "/sweep", body: { multipart: ingressPolicy() } } };
    const staged = [];
    for (const requestKey of ["c", "a", "b"]) {
      const result = await stageMultipartIngress(database, endpoint, ingressRequest(requestKey), { headers: ingressRequest(requestKey).headers }, { userId: "claim-user" }); const lease = result.multipart.files[0]; const payload = await expireIngressReceipt(database, lease.leaseId); staged.push({ requestKey, lease, payload });
    }
    const result = await sweepExpiredFileIngress(database, { now: new Date().toISOString(), limit: 2 });
    assert.deepEqual(result.cleaned.map((entry) => entry.requestKey), ["a", "b"]); assert.equal(result.scanned, 2); assert.equal(result.failures.length, 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    for (const entry of staged.filter(({ requestKey }) => requestKey !== "c")) await assert.rejects(access(path.join(dir, "files", entry.payload.fileId, entry.payload.version)));
    await access(path.join(dir, "files", staged.find(({ requestKey }) => requestKey === "c").payload.fileId, staged.find(({ requestKey }) => requestKey === "c").payload.version));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a concurrent sweep waits for an in-flight claim and never deletes its committed File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-claim-race-")); let first; let second; let releaseHandler; let handlerEntered;
  try {
    const entered = new Promise((resolve) => { handlerEntered = resolve; }); const release = new Promise((resolve) => { releaseHandler = resolve; });
    const definition = capsule({ name: "sweep-claim-race", endpoints: { upload: endpoint({ method: "POST", path: "/sweep-claim-race", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => { handlerEntered(); await release; return await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/sweep-race.txt" }); })) } });
    const dbPath = path.join(dir, "data.db"); const config = { name: "sweep-claim-race", files: { storagePath: path.join(dir, "files") } };
    first = await openDevDatabase(dbPath, "", {}, config, definition); second = await openDevDatabase(dbPath, "", {}, config, definition); await seedIngressUser(first);
    const claim = runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/sweep-claim-race"), ingressRequest("sweep-claim-race")); await entered;
    const sweep = sweepExpiredFileIngress(second, { now: "2099-01-01T00:00:00.000Z", limit: 10 }); releaseHandler(); const file = await claim; const swept = await sweep;
    assert.equal(swept.cleaned.length, 0); assert.equal((await first.adapter.selectFileById(file.id)).id, file.id); assert.equal(JSON.parse((await first.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload).state, "complete");
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("restart recovers a sweeping orphan", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-restart-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "sweep-restart", files: { storagePath: path.join(dir, "files") } }; const definition = capsule({ name: "sweep-restart" }); const endpoint = { options: { method: "POST", path: "/restart", body: { multipart: ingressPolicy() } } };
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    const staged = await stageMultipartIngress(database, endpoint, ingressRequest("restart-orphan"), { headers: ingressRequest("restart-orphan").headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0]; const payload = await expireIngressReceipt(database, lease.leaseId);
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [state] = 'sweeping' WHERE [leaseId] = ?").run(lease.leaseId); await database.close(); database = null;
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    assert.equal(await database.adapter.selectIngressByLease(lease.leaseId), null); await assert.rejects(access(path.join(dir, "files", payload.fileId, payload.version)));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress orphan cleanup failures are stable, bounded, and retryable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-failure-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "sweep-failure", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "sweep-failure" }));
    const endpoint = { options: { method: "POST", path: "/failure", body: { multipart: ingressPolicy() } } };
    const staged = await stageMultipartIngress(database, endpoint, ingressRequest("failure"), { headers: ingressRequest("failure").headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0]; await expireIngressReceipt(database, lease.leaseId);
    const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage); database.fileStorage.deleteFileVersion = async () => { throw new Error("provider-secret-detail"); };
    const failed = await sweepExpiredFileIngress(database, { limit: 1 });
    assert.deepEqual(failed.failures, [{ leaseId: lease.leaseId, code: "INGRESS_ORPHAN_CLEANUP_FAILED" }]); assert.equal(JSON.stringify(failed).includes("provider-secret-detail"), false); assert.equal((await database.adapter.selectIngressByLease(lease.leaseId)).state, "sweeping");
    database.fileStorage.deleteFileVersion = remove; const retried = await sweepExpiredFileIngress(database, { limit: 1 }); assert.equal(retried.cleaned.length, 1); assert.equal(await database.adapter.selectIngressByLease(lease.leaseId), null);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});
