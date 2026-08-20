import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule } from "../dist/server.js";
import { createPendingFileUpload } from "../dist/file-storage-runtime.js";
import { handleFileHttpRoute } from "../dist/http-runtime.js";
import { openDevDatabase, runClientAccessKeyOperation } from "../dist/server-runtime-source.js";

function linkedAuth(userId, email = `${userId}@example.com`) {
  return {
    userId,
    displayName: userId,
    email,
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
}

async function seedUser(database, auth, sessionToken = null) {
  await database.adapter.insertAuthUser({
    id: auth.userId,
    createdAt: "2026-08-20T12:00:00.000Z",
    displayName: auth.displayName,
    email: auth.email,
    picture: auth.picture,
    isAuthenticated: 1,
    isGuest: 0,
    provider: auth.provider,
  });
  if (sessionToken) {
    await database.adapter.insertAuthSession({
      token: sessionToken,
      userId: auth.userId,
      provider: auth.provider,
      createdAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }
}

async function startFileServer(database) {
  const server = createServer(async (request, response) => {
    try {
      if (!await handleFileHttpRoute(database, request, response)) {
        response.writeHead(404).end("Not found");
      }
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function upload(database, baseUrl, auth, pathName, body) {
  const pending = await createPendingFileUpload(database, auth, {
    file: { name: path.basename(pathName), path: pathName, type: "text/plain", size: Buffer.byteLength(body) },
  });
  assert.equal(pending.ok, true, JSON.stringify(pending));
  const response = await fetch(new URL(pending.data.uploadUrl, baseUrl), { method: "PUT", body });
  assert.equal(response.status, 200, await response.text());
  return pending.data.file;
}

async function manage(database, auth, type, fields) {
  const result = await runClientAccessKeyOperation(database, auth, { type, ...fields });
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.data;
}

test("private File Bearer admission is explicit, scoped, provenance-aware, and lifecycle-bound", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-files-"));
  const seenAclContexts = [];
  const definition = capsule({
    name: "access-key-files",
    accessKeys: { scopes: ["files:read", "other:read"] },
    files: {
      accessKeys: { read: { scopes: ["files:read"] } },
      acl: {
        read: ({ ctx }) => {
          seenAclContexts.push(ctx);
          return false;
        },
      },
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: definition.name,
    files: { storagePath: path.join(dir, "files") },
  }, definition);
  const owner = linkedAuth("file-owner");
  const other = linkedAuth("file-other");
  const sessionToken = "file-owner-session";
  let server;
  try {
    await seedUser(database, owner, sessionToken);
    await seedUser(database, other);
    server = await startFileServer(database);
    const file = await upload(database, server.baseUrl, owner, "/private/canary.txt", "private canary");
    const fileUrl = `${server.baseUrl}/__sporades/files/private/${file.id}?v=${encodeURIComponent(file.version)}`;

    const sessionResponse = await fetch(fileUrl, { headers: { "x-sporades-session-token": sessionToken } });
    assert.equal(sessionResponse.status, 200);
    assert.equal(await sessionResponse.text(), "private canary");
    assert.equal(sessionResponse.headers.get("cache-control"), "private, max-age=31536000, immutable");

    const missing = await fetch(fileUrl);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="sporades"');
    assert.equal(missing.headers.get("cache-control"), "no-store");

    const allowed = await manage(database, owner, "accessKeys.issue", {
      input: { name: "file-reader", grants: ["files:*"] },
    });
    const bearerResponse = await fetch(fileUrl, { headers: { authorization: `Bearer ${allowed.token}` } });
    assert.equal(bearerResponse.status, 200);
    assert.equal(await bearerResponse.text(), "private canary");
    assert.equal(bearerResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(bearerResponse.headers.get("pragma"), "no-cache");

    const insufficient = await manage(database, owner, "accessKeys.issue", {
      input: { name: "wrong-scope", grants: ["other:read"] },
    });
    const scopeDenied = await fetch(fileUrl, { headers: { authorization: `Bearer ${insufficient.token}` } });
    assert.equal(scopeDenied.status, 403);
    assert.equal(scopeDenied.headers.get("www-authenticate"), null);
    assert.equal(scopeDenied.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(await scopeDenied.json()).includes("files:read"), false);
    const scopeDenialLog = (await database.log.tail(20)).find((event) =>
      event.event === "auth.denied" && event.data?.requirement === "file-access-key-scopes"
    );
    assert.equal("credential" in scopeDenialLog.data, false);
    assert.equal(JSON.stringify(scopeDenialLog).includes(insufficient.accessKey.id), false);
    assert.equal(JSON.stringify(scopeDenialLog).includes(insufficient.accessKey.name), false);

    const otherKey = await manage(database, other, "accessKeys.issue", {
      input: { name: "foreign-reader", grants: ["files:read"] },
    });
    const ownerDenied = await fetch(fileUrl, { headers: { authorization: `Bearer ${otherKey.token}` } });
    assert.equal(ownerDenied.status, 404);
    assert.deepEqual(seenAclContexts.at(-1).credential, { kind: "access-key", id: otherKey.accessKey.id, name: "foreign-reader" });
    assert.equal(Object.isFrozen(seenAclContexts.at(-1).auth), true);
    assert.equal(Object.isFrozen(seenAclContexts.at(-1).credential), true);

    for (const headers of [
      { authorization: "Bearer malformed" },
      { authorization: `Bearer ${allowed.token}`, "x-sporades-session-token": sessionToken },
    ]) {
      const denied = await fetch(fileUrl, { headers });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("www-authenticate"), 'Bearer realm="sporades", error="invalid_token"');
      assert.equal(denied.headers.get("cache-control"), "no-store");
    }

    const rotated = await manage(database, owner, "accessKeys.rotate", {
      accessKeyId: allowed.accessKey.id,
      options: { lifecycleRevision: allowed.accessKey.lifecycleRevision },
    });
    assert.equal((await fetch(fileUrl, { headers: { authorization: `Bearer ${allowed.token}` } })).status, 401);
    assert.equal((await fetch(fileUrl, { headers: { authorization: `Bearer ${rotated.token}` } })).status, 200);
    const originalReadFileVersion = database.fileStorage.readFileVersion.bind(database.fileStorage);
    let admittedReadResolve;
    let releaseRead;
    const admittedRead = new Promise((resolve) => { admittedReadResolve = resolve; });
    const readRelease = new Promise((resolve) => { releaseRead = resolve; });
    database.fileStorage.readFileVersion = async (input) => {
      admittedReadResolve();
      await readRelease;
      return originalReadFileVersion(input);
    };
    const inFlightResponse = fetch(fileUrl, { headers: { authorization: `Bearer ${rotated.token}` } });
    await admittedRead;
    await manage(database, owner, "accessKeys.revoke", { accessKeyId: allowed.accessKey.id });
    releaseRead();
    const admittedBeforeRevocation = await inFlightResponse;
    assert.equal(admittedBeforeRevocation.status, 200);
    assert.equal(await admittedBeforeRevocation.text(), "private canary");
    database.fileStorage.readFileVersion = originalReadFileVersion;
    assert.equal((await fetch(fileUrl, { headers: { authorization: `Bearer ${rotated.token}` } })).status, 401);

    const expiring = await manage(database, owner, "accessKeys.issue", {
      input: { name: "expiring-reader", grants: ["files:read"], expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    const originalNow = database.clock.now;
    database.clock.now = () => new Date("2100-01-01T00:00:00.000Z");
    assert.equal((await fetch(fileUrl, { headers: { authorization: `Bearer ${expiring.token}` } })).status, 401);
    database.clock.now = originalNow;

    let rateLimited = null;
    for (let attempt = 0; attempt < 40 && !rateLimited; attempt += 1) {
      const response = await fetch(fileUrl, { headers: { authorization: "Bearer malformed" } });
      if (response.status === 429) rateLimited = response;
      else assert.equal(response.status, 401);
    }
    assert.ok(rateLimited, "repeated invalid File credentials reach the shared admission limiter");
    assert.equal(rateLimited.headers.get("cache-control"), "no-store");
    assert.equal(rateLimited.headers.get("www-authenticate"), null);

    const denialLogs = await database.log.tail(100);
    assert.equal(denialLogs.some((event) => event.event === "auth.denied" && event.data?.handler?.kind === "file"), true);
    assert.equal(JSON.stringify(denialLogs).includes(allowed.token), false);
    assert.equal(JSON.stringify(denialLogs).includes(rotated.token), false);
  } finally {
    await server?.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unconfigured private File route never interprets a Bearer-looking header", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-unconfigured-access-key-files-"));
  const definition = capsule({ name: "unconfigured-access-key-files", accessKeys: { scopes: ["files:read"] } });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: definition.name,
    files: { storagePath: path.join(dir, "files") },
  }, definition);
  const owner = linkedAuth("unconfigured-owner");
  const sessionToken = "unconfigured-owner-session";
  let server;
  try {
    await seedUser(database, owner, sessionToken);
    server = await startFileServer(database);
    const file = await upload(database, server.baseUrl, owner, "/private/unconfigured.txt", "session only");
    const key = await manage(database, owner, "accessKeys.issue", { input: { name: "ignored-bearer" } });
    const fileUrl = `${server.baseUrl}/__sporades/files/private/${file.id}?v=${encodeURIComponent(file.version)}`;
    const ignored = await fetch(fileUrl, { headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(ignored.status, 404);
    assert.equal(ignored.headers.get("www-authenticate"), null);
    const sessionResponse = await fetch(fileUrl, { headers: { "x-sporades-session-token": sessionToken } });
    assert.equal(sessionResponse.status, 200);
    assert.equal(await sessionResponse.text(), "session only");
    const legacySessionWithAppAuthorization = await fetch(fileUrl, {
      headers: { "x-sporades-session-token": sessionToken, authorization: `Bearer ${key.token}` },
    });
    assert.equal(legacySessionWithAppAuthorization.status, 200, "without the opt-in, Authorization remains uninterpreted");
  } finally {
    await server?.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unscoped File opt-in leaves authorization to ownership and File ACL policy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-unscoped-access-key-files-"));
  const definition = capsule({
    name: "unscoped-access-key-files",
    accessKeys: { scopes: ["unrelated:work"] },
    files: { accessKeys: { read: {} } },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: definition.name,
    files: { storagePath: path.join(dir, "files") },
  }, definition);
  const owner = linkedAuth("unscoped-owner");
  let server;
  try {
    await seedUser(database, owner);
    server = await startFileServer(database);
    const file = await upload(database, server.baseUrl, owner, "/private/unscoped.txt", "owner policy");
    const key = await manage(database, owner, "accessKeys.issue", {
      input: { name: "unscoped-reader", grants: ["unrelated:work"] },
    });
    const fileUrl = `${server.baseUrl}/__sporades/files/private/${file.id}?v=${encodeURIComponent(file.version)}`;
    const response = await fetch(fileUrl, { headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "owner policy");
  } finally {
    await server?.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
