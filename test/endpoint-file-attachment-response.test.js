import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint } from "../dist/server.js";
import { createPendingFileUpload } from "../dist/file-storage-runtime.js";
import { handleFileHttpRoute, prepareHttpSecurity } from "../dist/http-runtime.js";
import { openDevDatabase, routeEndpoint } from "../dist/server-runtime-source.js";
import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";

function actor(userId) {
  return { userId, displayName: userId, email: `${userId}@example.com`, picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
}

async function seedUser(database, auth, token) {
  await database.adapter.insertAuthUser({ id: auth.userId, displayName: auth.displayName, email: auth.email, picture: auth.picture, isAuthenticated: 1, isGuest: 0, provider: auth.provider, createdAt: "2026-09-02T00:00:00.000Z" });
  await database.adapter.insertAuthSession({ token, userId: auth.userId, provider: auth.provider, createdAt: "2026-09-02T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
}

async function start(database) {
  const server = createServer(async (request, response) => {
    if (prepareHttpSecurity(database, request, response)) return;
    if (await routeEndpoint(database, request, response)) return;
    if (await handleFileHttpRoute(database, request, response)) return;
    response.writeHead(404).end("Not found");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function upload(database, baseUrl, auth, contents) {
  const pending = await createPendingFileUpload(database, auth, { file: { name: "source.txt", path: "/attachments/source.txt", type: "text/plain", size: Buffer.byteLength(contents) } });
  assert.equal(pending.ok, true);
  const result = await fetch(new URL(pending.data.uploadUrl, baseUrl), { method: "PUT", body: contents });
  assert.equal(result.status, 200, await result.text());
  return pending.data.file;
}

test("attachment response declarations are explicit and closed", () => {
  for (const response of [{}, { fileAttachment: false }, { fileAttachment: true, extra: true }, "fileAttachment"]) {
    assert.throws(() => capsule({ name: "invalid-attachment-response", endpoints: {
      download: endpoint({ method: "GET", path: "/download", response }, () => null),
    } }), { code: "INVALID_ENDPOINT_RESPONSE_DECLARATION" });
  }
});

test("an endpoint can return only its runtime-created exact-version attachment response", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-endpoint-attachment-"));
  const holder = { file: null, forged: false, customerGrant: true, hostileName: "report\r\nX-Evil: yes/../\u202Eexe.txt" };
  const definition = capsule({ name: "endpoint-attachment", endpoints: {
    download: endpoint({ method: "GET", path: "/download", response: { fileAttachment: true } }, (ctx) => holder.forged
      ? { id: holder.file.id, version: holder.file.version, filename: holder.hostileName }
      : ctx.files.attachment({ id: holder.file.id, version: holder.file.version }, { filename: holder.hostileName })),
    customer: endpoint({ method: "GET", path: "/customer", response: { fileAttachment: true } }, (ctx) => holder.customerGrant
      ? ctx.files.attachment(holder.file, { filename: "customer.txt" })
      : { status: 404, body: "Not found" }),
    undeclared: endpoint({ method: "GET", path: "/undeclared" }, (ctx) => ctx.files.attachment(holder.file, { filename: "forbidden.txt" })),
    rollback: endpoint({ method: "GET", path: "/rollback", response: { fileAttachment: true } }, (ctx) => {
      ctx.files.attachment({ id: holder.file.id, version: holder.file.version }, { filename: "report.txt" });
      throw new Error("rollback sentinel");
    }),
  } });
  const database = await openDevDatabase(path.join(directory, "data.db"), "", {}, { name: definition.name, __sporadesSession: "public-dev", files: { storagePath: path.join(directory, "files") } }, definition);
  const auth = actor("attachment-owner");
  const token = "attachment-owner-session";
  let server;
  try {
    await seedUser(database, auth, token);
    server = await start(database);
    holder.file = await upload(database, server.baseUrl, auth, "attachment bytes");

    const response = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token, origin: "https://cross-origin.example" } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "attachment bytes");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.equal(response.headers.get("content-security-policy-report-only"), null);
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-disposition"), /^attachment; filename="/);
    assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
    assert.doesNotMatch(response.headers.get("content-disposition"), /[\r\n/\\]|X-Evil|\u202e/i);

    holder.forged = true;
    const forged = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token } });
    assert.equal(forged.status, 200);
    assert.doesNotMatch(await forged.text(), /attachment bytes/);

    holder.forged = false;
    let reads = 0;
    const originalRead = database.fileStorage.openFileVersionStream.bind(database.fileStorage);
    database.fileStorage.openFileVersionStream = async (input) => { reads += 1; return await originalRead(input); };
    const customer = await fetch(`${server.baseUrl}/customer`);
    assert.equal(customer.status, 200, "trusted domain authorization may deliberately serve a non-Sporades customer capability");
    assert.equal(await customer.text(), "attachment bytes");
    assert.equal(reads, 1);
    holder.customerGrant = false;
    const revokedCustomer = await fetch(`${server.baseUrl}/customer`);
    assert.equal(revokedCustomer.status, 404);
    assert.equal(reads, 1, "revoked app authorization prevents descriptor creation on the next request");
    reads = 0;
    for (const headers of [{}, { "x-sporades-session-token": token }]) {
      const undeclared = await fetch(`${server.baseUrl}/undeclared`, { headers });
      assert.equal(undeclared.status, 500);
    }
    assert.equal(reads, 0, "undeclared anonymous and authenticated endpoints cannot start attachment reads");
    const rolledBack = await fetch(`${server.baseUrl}/rollback`, { headers: { "x-sporades-session-token": token } });
    assert.equal(rolledBack.status, 500);
    assert.equal(reads, 0, "a descriptor made in a rolled-back endpoint never starts a File read");

    await unlink(path.join(directory, "files", holder.file.id, holder.file.version));
    const unreadable = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token, origin: "https://cross-origin.example" } });
    assert.equal(unreadable.status, 404);
    assert.equal(await unreadable.text(), "Not found");
    assert.equal(unreadable.headers.get("cache-control"), "private, no-store");
    assert.equal(unreadable.headers.get("pragma"), "no-cache");
    assert.equal(unreadable.headers.get("content-security-policy"), "sandbox");
    assert.equal(unreadable.headers.get("access-control-allow-origin"), null);
    assert.equal(reads, 1, "local storage readiness fails before response headers are committed");
    reads = 0;

    const replacement = await createPendingFileUpload(database, auth, { replace: true, fileId: holder.file.id, file: { name: "replacement.txt", type: "text/plain", size: Buffer.byteLength("replacement bytes") } });
    assert.equal(replacement.ok, true);
    const replacementUpload = await fetch(new URL(replacement.data.uploadUrl, server.baseUrl), { method: "PUT", body: "replacement bytes" });
    assert.equal(replacementUpload.status, 200);
    const stale = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token } });
    assert.equal(stale.status, 404, "an old exact version cannot fall through to its replacement");
    assert.equal(await stale.text(), "Not found");
    assert.equal(stale.headers.get("cache-control"), "private, no-store");
    assert.equal(stale.headers.get("pragma"), "no-cache");
    assert.equal(reads, 0, "stale version denial happens before storage reads");
    database.fileStorage.openFileVersionStream = originalRead;
  } finally {
    await server?.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the guarded attachment response reads the exact uploaded version from S3-compatible storage", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "sporades-endpoint-attachment-s3-"));
    const holder = { file: null };
    const definition = capsule({ name: "endpoint-attachment-s3", endpoints: {
      download: endpoint({ method: "GET", path: "/download", response: { fileAttachment: true } }, (ctx) => ctx.files.attachment(holder.file, { filename: "evidence café.txt" })),
    } });
    const serviceEnv = {
      SPORADES_SERVICE_STORAGE_ENGINE: "minio",
      SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint,
      SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
      SPORADES_SERVICE_STORAGE_REGION: "eu-west-2",
      SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
      SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
      SPORADES_SERVICE_STORAGE_NAMESPACE: "endpoint-attachments",
    };
    const database = await openDevDatabase(path.join(directory, "data.db"), "", {}, { name: definition.name, services: { storage: { kind: "storage", engine: "minio" } } }, definition, { serviceEnv });
    const auth = actor("s3-attachment-owner"); const token = "s3-attachment-session"; let server;
    try {
      await seedUser(database, auth, token);
      server = await start(database);
      holder.file = await upload(database, server.baseUrl, auth, "s3 attachment bytes");
      const response = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token } });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "s3 attachment bytes");
      assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''evidence%20caf%C3%A9.txt/);
    } finally {
      await server?.close(); await database.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a disconnected attachment stream is destroyed and a reconnect runs endpoint authorization again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-endpoint-attachment-disconnect-"));
  const holder = { file: null, authorizations: 0 };
  const definition = capsule({ name: "endpoint-attachment-disconnect", endpoints: {
    download: endpoint({ method: "GET", path: "/download", response: { fileAttachment: true } }, (ctx) => {
      holder.authorizations += 1;
      return ctx.files.attachment(holder.file, { filename: "large.txt" });
    }),
  } });
  const database = await openDevDatabase(path.join(directory, "data.db"), "", {}, { name: definition.name, files: { storagePath: path.join(directory, "files") } }, definition);
  const auth = actor("disconnect-owner"); const token = "disconnect-session"; let server;
  try {
    await seedUser(database, auth, token); server = await start(database);
    holder.file = await upload(database, server.baseUrl, auth, "x".repeat(1_000_000));
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token } });
      request.once("error", reject);
      request.on("response", (response) => {
        response.once("data", () => { request.destroy(); resolve(undefined); });
        response.once("error", reject);
      });
      request.end();
    });
    const reconnected = await fetch(`${server.baseUrl}/download`, { headers: { "x-sporades-session-token": token } });
    assert.equal(reconnected.status, 200);
    assert.equal((await reconnected.arrayBuffer()).byteLength, 1_000_000);
    assert.equal(holder.authorizations, 2, "a reconnect is a new endpoint request, not a retained download capability");
  } finally {
    await server?.close(); await database.close(); await rm(directory, { recursive: true, force: true });
  }
});
