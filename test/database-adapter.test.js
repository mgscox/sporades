import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  checkRuntimeFileStorage,
  checkRuntimeSqlite,
  completePendingFileUpload,
  createPublicFileUrl,
  createLocalFileStorageAdapter,
  createLibsqlDatabaseAdapter,
  createPostgresDatabaseAdapter,
  createRuntimeFileStorageAdapter,
  createS3CompatibleFileStorageAdapter,
  createPendingFileUpload,
  deletePrivateFile,
  createSqliteDatabaseAdapter,
  dumpDatabase,
  getPrivateFileUrl,
  listDatabaseTables,
  openDevDatabase,
  resolveAnonymousSession,
  routeSporadesAuth,
  runMutation,
  runQuery,
  runReadOnlyQuery,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
  signInWithEmail,
  signUpWithEmail,
  simulateLocalIdentitySession,
  updateCurrentUserPreferences,
} from "../dist/server-runtime-source.js";
import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-database-adapter-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const createRuntimeLogSink = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "createRuntimeLogSink");
const emitPrivilegedAuditEvent = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "emitPrivilegedAuditEvent");
const extractEndpoints = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "extractEndpoints");
const linkGoogleAccount = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "linkGoogleAccount");
const runEndpoint = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runEndpoint");
const runAppMessage = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runAppMessage");

async function captureErrorCode(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

test("endpoint source extraction excludes a trailing handler argument comma", () => {
  const [endpoint] = extractEndpoints(`
    export default capsule({
      endpoints: {
        ping: endpoint(
          { method: "POST", path: "/ping" },
          (ctx) => ctx.request.path,
        ),
      },
    });
  `);

  assert.equal(endpoint.handlerSource, "(ctx) => ctx.request.path");
  assert.equal(new Function(`return (${endpoint.handlerSource});`)()({ request: { path: "/ping" } }), "/ping");
});

test("SQLite database adapter owns setup, query execution, and close lifecycle", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "nested", "data.db"));

    adapter.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    adapter.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("one", "hello");

    assert.deepEqual({ ...adapter.prepare("SELECT id, value FROM entries WHERE id = ?").get("one") }, {
      id: "one",
      value: "hello",
    });
    assert.deepEqual(adapter.prepare("SELECT id, value FROM entries ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "one", value: "hello" },
    ]);
    assert.equal(adapter.prepare("PRAGMA journal_mode").get().journal_mode, "wal");

    adapter.close();
    assert.throws(() => adapter.prepare("SELECT 1").get(), /database is not open/i);
  });
});

test("database inspection SQL rejects side-effect statements with a structured hint", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "inspection.db"));
    const database = { adapter, sqlite: adapter };
    try {
      adapter.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      adapter.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("one", "hello");

      const readResult = await runReadOnlyQuery(database, "SELECT value FROM entries");
      assert.deepEqual({ ...readResult, data: { ...readResult.data, rows: readResult.data.rows.map((row) => ({ ...row })) } }, {
        ok: true,
        data: {
          columns: ["value"],
          rows: [{ value: "hello" }],
        },
        error: null,
      });
      const pragmaResult = await runReadOnlyQuery(database, "PRAGMA table_info(entries)");
      assert.deepEqual({ ...pragmaResult, data: { ...pragmaResult.data, rows: pragmaResult.data.rows.map((row) => ({ ...row })) } }, {
        ok: true,
        data: {
          columns: ["cid", "name", "type", "notnull", "dflt_value", "pk"],
          rows: [
            { cid: 0, name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: "value", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          ],
        },
        error: null,
      });

      for (const sql of [
        "INSERT INTO entries (id, value) VALUES ('two', 'write')",
        "CREATE TABLE surprise (id TEXT)",
        "ATTACH DATABASE 'sidecar.db' AS sidecar",
        "PRAGMA user_version = 7",
        "SELECT nextval('entries_id_seq')",
        "SELECT setval('entries_id_seq', 42)",
        "SELECT set_config('search_path', 'public', true)",
        'SELECT "load_extension"(\'x\')',
        "SELECT `load_extension`('x')",
        "SELECT [load_extension]('x')",
      ]) {
        assert.deepEqual(await runReadOnlyQuery(database, sql), {
          ok: false,
          data: null,
          error: {
            message: "Only read-only SQL is allowed.",
            hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
          },
        });
      }

      assert.equal(adapter.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 1);
      assert.equal(adapter.prepare("PRAGMA user_version").get().user_version, 0);
    } finally {
      adapter.close();
    }
  });
});

test("LocalFileStorageAdapter owns local file bytes, health, and close lifecycle", async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, "files");
    const adapter = createLocalFileStorageAdapter({ storagePath });

    await adapter.writeFileVersion({
      fileId: "file-1",
      version: "version-1",
      bytes: Buffer.from("hello storage"),
    });

    assert.equal((await adapter.readFileVersion({ fileId: "file-1", version: "version-1" })).toString("utf8"), "hello storage");
    assert.equal(await readFile(path.join(storagePath, "file-1", "version-1"), "utf8"), "hello storage");
    assert.deepEqual(await adapter.checkHealth(), { ok: true });

    await adapter.deleteFileVersion({ fileId: "file-1", version: "version-1" });
    await assert.rejects(() => adapter.readFileVersion({ fileId: "file-1", version: "version-1" }), { code: "ENOENT" });
    assert.equal(adapter.close(), undefined);
  });
});

test("S3-compatible file storage adapter uses MinIO-style path URLs, SigV4 signing, bucket setup, and object lifecycle", async () => {
  await withFakeS3CompatibleService(async ({ endpoint, requests, objects }) => {
    const adapter = createS3CompatibleFileStorageAdapter({
      endpoint,
      bucket: "sporades-files",
      region: "eu-west-2",
      accessKey: "sporades",
      secretKey: "sporades-minio-local-secret",
      namespace: "todo-island",
    });

    await adapter.writeFileVersion({
      fileId: "file-1",
      version: "version-1",
      bytes: Buffer.from("hello minio"),
    });

    assert.equal((await adapter.readFileVersion({ fileId: "file-1", version: "version-1" })).toString("utf8"), "hello minio");
    assert.equal(objects.has("capsules/todo-island/files/file-1/version-1"), true);
    assert.deepEqual(await adapter.checkHealth(), { ok: true, adapter: "s3-compatible" });

    await adapter.deleteFileVersion({ fileId: "file-1", version: "version-1" });
    assert.equal(objects.has("capsules/todo-island/files/file-1/version-1"), false);
    await assert.rejects(() => adapter.readFileVersion({ fileId: "file-1", version: "version-1" }), { code: "ENOENT" });
    assert.equal(adapter.close(), undefined);

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["HEAD", "/sporades-files"],
        ["PUT", "/sporades-files"],
        ["PUT", "/sporades-files/capsules/todo-island/files/file-1/version-1"],
        ["GET", "/sporades-files/capsules/todo-island/files/file-1/version-1"],
        ["DELETE", "/sporades-files/capsules/todo-island/files/file-1/version-1"],
        ["GET", "/sporades-files/capsules/todo-island/files/file-1/version-1"],
      ],
    );
    for (const request of requests) {
      assert.match(request.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=sporades\/\d{8}\/eu-west-2\/s3\/aws4_request/);
      assert.match(request.headers.authorization ?? "", /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
      assert.match(request.headers.authorization ?? "", /Signature=[0-9a-f]{64}$/);
      assert.equal(typeof request.headers["x-amz-content-sha256"], "string");
      assert.equal(typeof request.headers["x-amz-date"], "string");
    }
  });
});

test("S3-compatible file storage adapter isolates capsules that share an object bucket", async () => {
  await withFakeS3CompatibleService(async ({ endpoint, objects }) => {
    const first = createS3CompatibleFileStorageAdapter({
      endpoint,
      bucket: "sporades-files",
      region: "eu-west-2",
      accessKey: "sporades",
      secretKey: "sporades-minio-local-secret",
      namespace: "alpha-capsule",
    });
    const second = createS3CompatibleFileStorageAdapter({
      endpoint,
      bucket: "sporades-files",
      region: "eu-west-2",
      accessKey: "sporades",
      secretKey: "sporades-minio-local-secret",
      namespace: "beta-capsule",
    });

    await first.writeFileVersion({ fileId: "same-file", version: "same-version", bytes: Buffer.from("alpha") });
    await second.writeFileVersion({ fileId: "same-file", version: "same-version", bytes: Buffer.from("beta") });

    assert.equal((await first.readFileVersion({ fileId: "same-file", version: "same-version" })).toString("utf8"), "alpha");
    assert.equal((await second.readFileVersion({ fileId: "same-file", version: "same-version" })).toString("utf8"), "beta");
    assert.equal(objects.get("capsules/alpha-capsule/files/same-file/same-version").toString("utf8"), "alpha");
    assert.equal(objects.get("capsules/beta-capsule/files/same-file/same-version").toString("utf8"), "beta");
  });
});

test("runtime selects S3-compatible file storage only when MinIO service env matches declared storage intent", async () => {
  await withFakeS3CompatibleService(async ({ endpoint }) => {
    const ambientOnly = await createRuntimeFileStorageAdapter({
      config: {},
      databasePath: "/tmp/sporades-data.db",
      serviceEnv: {
        SPORADES_SERVICE_STORAGE_ENGINE: "minio",
        SPORADES_SERVICE_STORAGE_ENDPOINT: endpoint,
        SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
        SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
        SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
        SPORADES_SERVICE_STORAGE_REGION: "eu-west-2",
        SPORADES_SERVICE_STORAGE_NAMESPACE: "todo-island",
      },
    });
    assert.equal(ambientOnly.engine, "local");

    const adapter = await createRuntimeFileStorageAdapter({
      config: { services: { storage: { kind: "storage", engine: "minio" } } },
      databasePath: "/tmp/sporades-data.db",
      serviceEnv: {
        SPORADES_SERVICE_STORAGE_ENGINE: "minio",
        SPORADES_SERVICE_STORAGE_ENDPOINT: endpoint,
        SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
        SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
        SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
        SPORADES_SERVICE_STORAGE_REGION: "eu-west-2",
        SPORADES_SERVICE_STORAGE_NAMESPACE: "todo-island",
      },
    });

    assert.equal(adapter.engine, "s3-compatible");
    assert.equal(adapter.bucket, "sporades-files");
    assert.equal(adapter.region, "eu-west-2");
    assert.equal(adapter.namespace, "capsules/todo-island");
  });
});

test("runtime file lifecycle paths use the configured file storage adapter", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true } },
    });
    const writes = [];
    const reads = [];
    const deletes = [];
    const closed = [];
    const storedBytes = new Map();
    database.fileStorage = {
      engine: "spy",
      async writeFileVersion({ fileId, version, bytes }) {
        writes.push({ fileId, version, bytes: bytes.toString("utf8") });
        storedBytes.set(`${fileId}:${version}`, Buffer.from(bytes));
      },
      async readFileVersion({ fileId, version }) {
        reads.push({ fileId, version });
        const bytes = storedBytes.get(`${fileId}:${version}`);
        if (!bytes) {
          const error = new Error("missing spy bytes");
          error.code = "ENOENT";
          throw error;
        }
        return bytes;
      },
      async deleteFileVersion({ fileId, version }) {
        deletes.push({ fileId, version });
        storedBytes.delete(`${fileId}:${version}`);
      },
      async checkHealth() {
        return { ok: true, adapter: "spy" };
      },
      close() {
        closed.push(true);
      },
    };

    try {
      const session = await resolveAnonymousSession(database, null);
      const pending = await createPendingFileUpload(database, session.auth, {
        file: { name: "proof.txt", type: "text/plain", size: 5 },
      });
      assert.equal(pending.ok, true);

      const uploadId = pending.data.uploadUrl.split("/").pop();
      const completed = await completePendingFileUpload(database, uploadId, Readable.from([Buffer.from("proof")]));
      assert.equal(completed.ok, true);
      assert.deepEqual(writes, [
        {
          fileId: pending.data.file.id,
          version: pending.data.file.version,
          bytes: "proof",
        },
      ]);
      assert.deepEqual(await checkRuntimeFileStorage(database), { ok: true, adapter: "spy" });

      await database.fileStorage.readFileVersion({ fileId: completed.data.file.id, version: completed.data.file.version });
      assert.deepEqual(reads, [{ fileId: completed.data.file.id, version: completed.data.file.version }]);

      await database.fileStorage.deleteFileVersion({ fileId: completed.data.file.id, version: completed.data.file.version });
      assert.deepEqual(deletes, [{ fileId: completed.data.file.id, version: completed.data.file.version }]);
    } finally {
      database.close();
      assert.deepEqual(closed, [true]);
    }
  });
});

test("runtime file operations accept absolute File paths and File references", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
    try {
      const uploadAndComplete = async (file, body = "bytes", uploadAuth = auth) => {
        const pending = await createPendingFileUpload(database, uploadAuth, { file });
        assert.equal(pending.ok, true, pending.error?.message);
        const uploadId = pending.data.uploadUrl.split("/").pop();
        const completed = await completePendingFileUpload(database, uploadId, Readable.from([Buffer.from(body)]));
        assert.equal(completed.ok, true, completed.error?.message);
        return completed.data.file;
      };

      const explicit = await uploadAndComplete({
        name: "avatar.png",
        type: "image/png",
        size: 5,
        path: "/images/avatars/profile.png",
      });
      assert.equal(explicit.bucket, "default");
      assert.equal(explicit.path, "/images/avatars/profile.png");

      const byId = await getPrivateFileUrl(database, auth, explicit.id);
      assert.equal(byId.ok, true);
      assert.match(byId.data.url, new RegExp(`/__sporades/files/private/${explicit.id}`));

      const byPath = await getPrivateFileUrl(database, auth, "/images/avatars/profile.png");
      assert.equal(byPath.ok, true);
      assert.equal(byPath.data.file.id, explicit.id);

      const publicByPath = await createPublicFileUrl(database, auth, "/images/avatars/profile.png", { noExpiry: true });
      assert.equal(publicByPath.ok, true);
      assert.equal(publicByPath.data.publicUrl.fileId, explicit.id);

      const otherAuth = { userId: "user-2", displayName: "Grace", isAuthenticated: false, isGuest: true, provider: "anonymous" };
      const otherByPath = await getPrivateFileUrl(database, otherAuth, "/images/avatars/profile.png");
      assert.equal(otherByPath.ok, false);
      assert.equal(otherByPath.error.message, "File not found.");

      const otherSamePath = await createPendingFileUpload(database, otherAuth, {
        file: { name: "other.png", type: "image/png", size: 5, path: "/images/avatars/profile.png" },
      });
      assert.equal(otherSamePath.ok, false);
      assert.equal(otherSamePath.error.message, "File path already exists.");
      assert.equal((await getPrivateFileUrl(database, auth, "/images/avatars/profile.png")).data.file.id, explicit.id);

      const [crossOwnerPathA, crossOwnerPathB] = await Promise.all([
        createPendingFileUpload(database, auth, {
          file: { name: "a.txt", type: "text/plain", size: 6, path: "/race/cross-owner.txt" },
        }),
        createPendingFileUpload(database, otherAuth, {
          file: { name: "b.txt", type: "text/plain", size: 6, path: "/race/cross-owner.txt" },
        }),
      ]);
      assert.equal(crossOwnerPathA.ok, true, crossOwnerPathA.error?.message);
      assert.equal(crossOwnerPathB.ok, true, crossOwnerPathB.error?.message);
      assert.notEqual(crossOwnerPathA.data.file.id, crossOwnerPathB.data.file.id);

      const crossOwnerACompleted = await completePendingFileUpload(
        database,
        crossOwnerPathA.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("ownerA")]),
      );
      const crossOwnerBCompleted = await completePendingFileUpload(
        database,
        crossOwnerPathB.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("ownerB")]),
      );
      assert.equal(crossOwnerACompleted.ok, false);
      assert.equal(crossOwnerACompleted.error.message, "Upload URL not found.");
      assert.equal(crossOwnerBCompleted.ok, true, crossOwnerBCompleted.error?.message);
      assert.equal((await database.sqlite.selectLiveFileByPath("/race/cross-owner.txt")).length, 1);
      assert.equal((await getPrivateFileUrl(database, otherAuth, "/race/cross-owner.txt")).data.file.id, crossOwnerPathB.data.file.id);
      const crossOwnerPrivate = await getPrivateFileUrl(database, auth, "/race/cross-owner.txt");
      assert.equal(crossOwnerPrivate.ok, false);
      assert.equal(crossOwnerPrivate.error.message, "File not found.");

      const firstOverlap = await createPendingFileUpload(database, auth, {
        file: { name: "first.png", type: "image/png", size: 5, path: "/images/avatars/profile.png" },
      });
      assert.equal(firstOverlap.ok, true, firstOverlap.error?.message);
      assert.equal(firstOverlap.data.file.id, explicit.id);
      assert.equal(firstOverlap.data.file.path, "/images/avatars/profile.png");
      const liveAfterAbandonedNegotiation = await getPrivateFileUrl(database, auth, explicit.id);
      assert.equal(liveAfterAbandonedNegotiation.ok, true);
      assert.equal(liveAfterAbandonedNegotiation.data.file.version, explicit.version);
      assert.equal((await getPrivateFileUrl(database, auth, "/images/avatars/profile.png")).data.file.version, explicit.version);

      const secondOverlap = await createPendingFileUpload(database, auth, {
        file: { name: "second.png", type: "image/png", size: 6, path: "/images/avatars/profile.png" },
      });
      assert.equal(secondOverlap.ok, true, secondOverlap.error?.message);
      assert.equal(secondOverlap.data.file.id, explicit.id);
      assert.equal(secondOverlap.data.file.path, "/images/avatars/profile.png");

      const firstOverlapUploadId = firstOverlap.data.uploadUrl.split("/").pop();
      const secondOverlapUploadId = secondOverlap.data.uploadUrl.split("/").pop();
      const firstOverlapCompleted = await completePendingFileUpload(
        database,
        firstOverlapUploadId,
        Readable.from([Buffer.from("first")]),
      );
      assert.equal(firstOverlapCompleted.ok, false);
      assert.equal(firstOverlapCompleted.error.message, "Upload URL not found.");
      assert.equal((await getPrivateFileUrl(database, auth, "/images/avatars/profile.png")).data.file.version, explicit.version);

      const secondOverlapCompleted = await completePendingFileUpload(
        database,
        secondOverlapUploadId,
        Readable.from([Buffer.from("second")]),
      );
      assert.equal(secondOverlapCompleted.ok, true, secondOverlapCompleted.error?.message);
      assert.equal(secondOverlapCompleted.data.file.id, explicit.id);
      assert.equal(secondOverlapCompleted.data.file.version, secondOverlap.data.file.version);
      assert.equal((await getPrivateFileUrl(database, auth, "/images/avatars/profile.png")).data.file.version, secondOverlap.data.file.version);

      const overlapRows = await database.sqlite.selectLiveFileByPath("/images/avatars/profile.png");
      assert.equal(overlapRows.length, 1);
      assert.equal(overlapRows[0].id, explicit.id);

      const [newPathA, newPathB] = await Promise.all([
        createPendingFileUpload(database, auth, {
          file: { name: "new-a.txt", type: "text/plain", size: 5, path: "/race/new.txt" },
        }),
        createPendingFileUpload(database, auth, {
          file: { name: "new-b.txt", type: "text/plain", size: 5, path: "/race/new.txt" },
        }),
      ]);
      assert.equal(newPathA.ok, true, newPathA.error?.message);
      assert.equal(newPathB.ok, true, newPathB.error?.message);
      assert.equal(newPathA.data.file.id, newPathB.data.file.id);
      assert.equal(newPathA.data.file.path, "/race/new.txt");
      assert.equal(newPathB.data.file.path, "/race/new.txt");

      const staleNewPath = await completePendingFileUpload(
        database,
        newPathA.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("stale")]),
      );
      const currentNewPath = await completePendingFileUpload(
        database,
        newPathB.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("fresh")]),
      );
      const newPathResults = [staleNewPath, currentNewPath];
      assert.equal(newPathResults.filter((result) => result.ok).length, 1);
      assert.equal(newPathResults.filter((result) => !result.ok).length, 1);
      assert.equal(newPathResults.find((result) => result.ok).data.file.id, newPathA.data.file.id);
      assert.match(newPathResults.find((result) => !result.ok).error.message, /Upload URL (not found|was superseded)/);
      assert.equal((await database.sqlite.selectLiveFileByPath("/race/new.txt")).length, 1);

      const inFlightA = await createPendingFileUpload(database, auth, {
        file: { name: "in-flight-a.png", type: "image/png", size: 8, path: "/images/avatars/profile.png" },
      });
      assert.equal(inFlightA.ok, true, inFlightA.error?.message);
      const inFlightAUploadId = inFlightA.data.uploadUrl.split("/").pop();
      let releaseInFlightA;
      const pausedBody = (async function* () {
        await new Promise((resolve) => {
          releaseInFlightA = resolve;
        });
        yield Buffer.from("older-a");
      })();
      const inFlightACompletion = completePendingFileUpload(database, inFlightAUploadId, pausedBody);
      await Promise.resolve();

      const inFlightB = await createPendingFileUpload(database, auth, {
        file: { name: "in-flight-b.png", type: "image/png", size: 8, path: "/images/avatars/profile.png" },
      });
      assert.equal(inFlightB.ok, true, inFlightB.error?.message);
      const inFlightBUploadId = inFlightB.data.uploadUrl.split("/").pop();
      const inFlightBCompleted = await completePendingFileUpload(
        database,
        inFlightBUploadId,
        Readable.from([Buffer.from("newer-b")]),
      );
      assert.equal(inFlightBCompleted.ok, true, inFlightBCompleted.error?.message);
      assert.equal(inFlightBCompleted.data.file.version, inFlightB.data.file.version);

      releaseInFlightA();
      const inFlightACompleted = await inFlightACompletion;
      assert.equal(inFlightACompleted.ok, false);
      assert.equal(inFlightACompleted.error.message, "Upload URL was superseded.");
      const liveAfterInFlightRace = await getPrivateFileUrl(database, auth, "/images/avatars/profile.png");
      assert.equal(liveAfterInFlightRace.ok, true);
      assert.equal(liveAfterInFlightRace.data.file.version, inFlightB.data.file.version);

      const overwritten = await uploadAndComplete({
        name: "replacement.png",
        type: "image/png",
        size: 7,
        path: "/images/avatars/profile.png",
      });
      assert.equal(overwritten.id, explicit.id);
      assert.notEqual(overwritten.version, explicit.version);
      assert.equal(overwritten.path, "/images/avatars/profile.png");

      const namedDefault = await uploadAndComplete({ name: "readme.txt", type: "text/plain", size: 4 });
      assert.equal(namedDefault.path, "/default/readme.txt");

      const unnamedDefault = await uploadAndComplete({ type: "application/octet-stream", size: 4 });
      assert.equal(unnamedDefault.name, "upload");
      assert.equal(unnamedDefault.path, "/default/upload");

      const freshAuth = { userId: "fresh-owner", displayName: "Fresh", isAuthenticated: false, isGuest: true, provider: "anonymous" };
      const [firstBucketA, firstBucketB] = await Promise.all([
        createPendingFileUpload(database, freshAuth, { file: { name: "first-a.txt", type: "text/plain", size: 1 } }),
        createPendingFileUpload(database, freshAuth, { file: { name: "first-b.txt", type: "text/plain", size: 1 } }),
      ]);
      assert.equal(firstBucketA.ok, true, firstBucketA.error?.message);
      assert.equal(firstBucketB.ok, true, firstBucketB.error?.message);
      assert.equal(firstBucketA.data.file.bucket, "default");
      assert.equal(firstBucketB.data.file.bucket, "default");
      assert.equal((await database.sqlite.findFileBucket(freshAuth.userId, "default")).name, "default");

      await database.sqlite.createFileBucket({
        id: "bucket-media",
        ownerId: auth.userId,
        name: "media",
        createdAt: "2026-07-04T10:00:00.000Z",
      });
      const bucketPath = await uploadAndComplete({
        name: "cat.jpg",
        type: "image/jpeg",
        size: 3,
        path: "/media/photos/cat.jpg",
      });
      assert.equal(bucketPath.bucket, "media");
      assert.equal(bucketPath.path, "/media/photos/cat.jpg");

      const pendingBeforeDelete = await createPendingFileUpload(database, auth, {
        file: { name: "zombie.png", type: "image/png", size: 6, path: "/images/avatars/profile.png" },
      });
      assert.equal(pendingBeforeDelete.ok, true, pendingBeforeDelete.error?.message);
      assert.equal(pendingBeforeDelete.data.file.id, explicit.id);
      const deleteAfterPending = await deletePrivateFile(database, auth, "/images/avatars/profile.png");
      assert.equal(deleteAfterPending.ok, true);
      assert.equal(deleteAfterPending.data.file.id, pendingBeforeDelete.data.file.id);
      const zombieCompletion = await completePendingFileUpload(
        database,
        pendingBeforeDelete.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("zombie")]),
      );
      assert.equal(zombieCompletion.ok, false);
      assert.equal(zombieCompletion.error.message, "Upload URL not found.");
      assert.equal((await getPrivateFileUrl(database, auth, pendingBeforeDelete.data.file.id)).ok, false);

      const recreated = await uploadAndComplete({
        name: "avatar.png",
        type: "image/png",
        size: 5,
        path: "/images/avatars/profile.png",
      });
      assert.notEqual(recreated.id, explicit.id);
      assert.equal(recreated.path, "/images/avatars/profile.png");

      const deleteRecreated = await deletePrivateFile(database, auth, "/images/avatars/profile.png");
      assert.equal(deleteRecreated.ok, true);
      const recreatedByOtherOwner = await uploadAndComplete(
        {
          name: "other-avatar.png",
          type: "image/png",
          size: 5,
          path: "/images/avatars/profile.png",
        },
        "other",
        otherAuth,
      );
      assert.notEqual(recreatedByOtherOwner.id, recreated.id);
      assert.equal(recreatedByOtherOwner.path, "/images/avatars/profile.png");
      assert.equal((await getPrivateFileUrl(database, otherAuth, "/images/avatars/profile.png")).data.file.id, recreatedByOtherOwner.id);

      const missing = await getPrivateFileUrl(database, auth, "/missing/file.txt");
      assert.equal(missing.ok, false);
      assert.equal(missing.error.message, "File not found.");
    } finally {
      database.close();
    }
  });
});

test("file upload completion cleans written replacement bytes when metadata completion fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
    const storedBytes = new Map();
    const deletedVersions = [];
    database.fileStorage = {
      engine: "spy",
      async writeFileVersion({ fileId, version, bytes }) {
        storedBytes.set(`${fileId}:${version}`, Buffer.from(bytes).toString("utf8"));
      },
      async readFileVersion({ fileId, version }) {
        const bytes = storedBytes.get(`${fileId}:${version}`);
        if (!bytes) {
          const error = new Error("missing spy bytes");
          error.code = "ENOENT";
          throw error;
        }
        return Buffer.from(bytes);
      },
      async deleteFileVersion({ fileId, version }) {
        deletedVersions.push({ fileId, version });
        storedBytes.delete(`${fileId}:${version}`);
      },
      async checkHealth() {
        return { ok: true, adapter: "spy" };
      },
      close() {},
    };

    const uploadAndComplete = async (file, body) => {
      const pending = await createPendingFileUpload(database, auth, { file });
      assert.equal(pending.ok, true, pending.error?.message);
      const uploadId = pending.data.uploadUrl.split("/").pop();
      const completed = await completePendingFileUpload(database, uploadId, Readable.from([Buffer.from(body)]));
      assert.equal(completed.ok, true, completed.error?.message);
      return completed.data.file;
    };

    try {
      const original = await uploadAndComplete(
        { name: "avatar.png", type: "image/png", size: 8, path: "/images/avatar.png" },
        "original",
      );
      const originalKey = `${original.id}:${original.version}`;
      assert.equal(storedBytes.get(originalKey), "original");

      const pendingReplacement = await createPendingFileUpload(database, auth, {
        file: { name: "avatar.png", type: "image/png", size: 11, path: "/images/avatar.png" },
      });
      assert.equal(pendingReplacement.ok, true, pendingReplacement.error?.message);
      const replacement = pendingReplacement.data.file;
      const replacementUploadId = pendingReplacement.data.uploadUrl.split("/").pop();
      const realRevokePublicFileUrlsForFile = database.sqlite.revokePublicFileUrlsForFile.bind(database.sqlite);
      database.sqlite.revokePublicFileUrlsForFile = async (...args) => {
        await realRevokePublicFileUrlsForFile(...args);
        throw new Error("forced public URL revocation failure");
      };

      const failed = await completePendingFileUpload(database, replacementUploadId, Readable.from([Buffer.from("replacement")]));
      assert.equal(failed.ok, false);
      assert.match(failed.error.message, /forced public URL revocation failure/);

      const live = await getPrivateFileUrl(database, auth, "/images/avatar.png");
      assert.equal(live.ok, true);
      assert.equal(live.data.file.id, original.id);
      assert.equal(live.data.file.version, original.version);
      assert.equal(storedBytes.get(originalKey), "original");
      assert.equal(storedBytes.has(`${replacement.id}:${replacement.version}`), false);
      assert.deepEqual(deletedVersions, [{ fileId: replacement.id, version: replacement.version }]);
    } finally {
      database.close();
    }
  });
});

test("pending upload creation rolls back File bucket setup when upload insertion fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
    const realInsertFileUpload = database.sqlite.insertFileUpload.bind(database.sqlite);
    database.sqlite.insertFileUpload = async (...args) => {
      await realInsertFileUpload(...args);
      throw new Error("forced pending upload insert failure");
    };

    try {
      await assert.rejects(
        createPendingFileUpload(database, auth, {
          file: { name: "proof.txt", type: "text/plain", size: 5, path: "/media/proof.txt" },
        }),
        /forced pending upload insert failure/,
      );
      assert.equal(await database.sqlite.findFileBucket(auth.userId, "default"), null);
      assert.equal(await database.sqlite.selectPendingFileUploadByPath("/media/proof.txt"), null);
    } finally {
      database.close();
    }
  });
});

test("file deletion rolls back metadata deletion when public URL revocation fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
    const uploadAndComplete = async (file, body) => {
      const pending = await createPendingFileUpload(database, auth, { file });
      assert.equal(pending.ok, true, pending.error?.message);
      const uploadId = pending.data.uploadUrl.split("/").pop();
      const completed = await completePendingFileUpload(database, uploadId, Readable.from([Buffer.from(body)]));
      assert.equal(completed.ok, true, completed.error?.message);
      return completed.data.file;
    };

    try {
      const file = await uploadAndComplete(
        { name: "avatar.png", type: "image/png", size: 8, path: "/images/avatar.png" },
        "original",
      );
      const publicUrl = await createPublicFileUrl(database, auth, file.id, { noExpiry: true });
      assert.equal(publicUrl.ok, true, publicUrl.error?.message);
      const realRevokePublicFileUrlsForFile = database.sqlite.revokePublicFileUrlsForFile.bind(database.sqlite);
      database.sqlite.revokePublicFileUrlsForFile = async (...args) => {
        await realRevokePublicFileUrlsForFile(...args);
        throw new Error("forced public URL revocation failure");
      };

      await assert.rejects(deletePrivateFile(database, auth, file.id), /forced public URL revocation failure/);

      const live = await getPrivateFileUrl(database, auth, file.id);
      assert.equal(live.ok, true);
      assert.equal(live.data.file.version, file.version);
      assert.equal((await database.sqlite.selectPublicFileRow(publicUrl.data.publicUrl.id)).revokedAt, null);
    } finally {
      database.close();
    }
  });
});

test("libSQL database adapter owns remote connection, result normalization, and transaction sessions", async () => {
  await withTempDir(async (dir) => {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url, requests }) => {
      const adapter = await createLibsqlDatabaseAdapter({ url });
      try {
        await adapter.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
        await adapter.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("one", "hello");

        assert.deepEqual(await adapter.prepare("SELECT id, value FROM entries WHERE id = ?").get("one"), {
          id: "one",
          value: "hello",
        });
        assert.deepEqual(await adapter.prepare("SELECT id, value FROM entries ORDER BY id").all(), [
          { id: "one", value: "hello" },
        ]);

        await assert.rejects(
          adapter.withTransaction(async (transaction) => {
            await transaction.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("two", "rolled back");
            throw new Error("rollback please");
          }),
          /rollback please/,
        );
        assert.equal(await adapter.prepare("SELECT value FROM entries WHERE id = ?").get("two"), null);

        const transactionRequests = requests.filter((request) =>
          request.requests?.some((candidate) => candidate.stmt?.sql === "BEGIN" || candidate.stmt?.sql === "ROLLBACK"),
        );
        assert.equal(transactionRequests.length, 2);
        assert.equal(transactionRequests[0].baton ?? null, null);
        assert.equal(typeof transactionRequests[1].baton, "string");
        assert.notEqual(transactionRequests[1].baton, "");
      } finally {
        await adapter.close();
      }
    });
  });
});

test("libSQL database adapter does not share transaction baton with non-transaction operations", async () => {
  await withTempDir(async (dir) => {
    await withFakeLibsqlService(path.join(dir, "libsql-transaction-scope.db"), async ({ url, requests }) => {
      const adapter = await createLibsqlDatabaseAdapter({ url });
      try {
        await adapter.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");

        await adapter.withTransaction(async (transaction) => {
          await transaction.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("inside", "transaction");
          await adapter.prepare("SELECT id FROM entries WHERE id = ?").get("inside");
        });

        const outsideSelect = requests.find((request) =>
          request.requests?.some((entry) => entry.stmt?.sql === "SELECT id FROM entries WHERE id = ?"),
        );
        assert(outsideSelect, JSON.stringify(requests));
        assert.equal(outsideSelect.baton, undefined);
      } finally {
        await adapter.close();
      }
    });
  });
});

test("runtime selects libSQL only when declared services provide server-only connection env", async () => {
  await withTempDir(async (dir) => {
    await withFakeLibsqlService(path.join(dir, "runtime-libsql.db"), async ({ url }) => {
      const serverSource = `
        export default capsule({
          schema: {
            notes: table({
              text: String(),
              ownerId: String()
            })
          }
        });
      `;
      const config = { services: { database: { kind: "database", engine: "libsql" } } };
      const database = await openDevDatabase(
        path.join(dir, "data.db"),
        serverSource,
        {
          VISIBLE_CAPSULE_ENV: "yes",
        },
        config,
        null,
        {
          serviceEnv: {
            SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
            SPORADES_SERVICE_DATABASE_URL: url,
          },
        },
      );
      try {
        assert.equal(database.adapter.engine, "libsql");
        assert.deepEqual(database.serverEnv, { VISIBLE_CAPSULE_ENV: "yes" });
        await database.sqlite.insertAppRow(database.schema.tables[0], {
          id: "note-1",
          createdAt: "2026-07-04T10:00:00.000Z",
          updatedAt: "2026-07-04T10:00:00.000Z",
          text: "remote database",
          ownerId: "user-1",
        });
        assert.deepEqual(await runReadOnlyQuery(database, "SELECT text FROM notes"), {
          ok: true,
          data: {
            columns: ["text"],
            rows: [{ text: "remote database" }],
          },
          error: null,
        });
      } finally {
        await database.close();
      }
    });

    const embedded = await openDevDatabase(
      path.join(dir, "embedded.db"),
      "",
      {
        SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
        SPORADES_SERVICE_DATABASE_URL: "http://127.0.0.1:1/should-not-be-used",
      },
      {},
    );
    try {
      assert.equal(embedded.adapter.engine, "sqlite");
    } finally {
      await embedded.close();
    }
  });
});

test("libSQL app schema migrations await delayed table creation failures before writing metadata", async () => {
  await withTempDir(async (dir) => {
    await withFakeLibsqlService(
      path.join(dir, "libsql-delayed-create.db"),
      {
        async beforeStatement(sql) {
          if (/CREATE TABLE IF NOT EXISTS "delayed_failure"/.test(sql)) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new Error("delayed create failed");
          }
        },
      },
      async ({ url }) => {
        const adapter = await createLibsqlDatabaseAdapter({ url });
        try {
          await adapter.ensureSystemTable();
          await assert.rejects(
            adapter.migrateAppSchema({
              tables: [
                {
                  name: "delayed_failure",
                  fields: [{ name: "text", kind: "String", sqliteType: "TEXT" }],
                },
              ],
            }),
            /delayed create failed/,
          );
          assert.equal(await adapter.readSchemaMetadata(), null);
        } finally {
          await adapter.close();
        }
      },
    );
  });
});

test("SQLite app schema migrations roll back table changes when metadata write fails", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "schema-rollback.db"));
    try {
      const notesTable = {
        name: "notes",
        fields: [{ name: "text", kind: "String", sqliteType: "TEXT" }],
      };
      const migratedNotesTable = {
        ...notesTable,
        fields: [...notesTable.fields, { name: "summary", kind: "String", sqliteType: "TEXT", defaultValue: "draft" }],
      };

      adapter.ensureSystemTable();
      adapter.migrateAppSchema({ tables: [notesTable] });
      adapter.insertAppRow(notesTable, {
        id: "note-1",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:00:00.000Z",
        text: "before",
      });

      const originalWriteSchemaMetadata = adapter.writeSchemaMetadata.bind(adapter);
      adapter.writeSchemaMetadata = () => {
        throw new Error("schema metadata write failed");
      };

      assert.throws(() => adapter.migrateAppSchema({ tables: [migratedNotesTable] }), /schema metadata write failed/);

      adapter.writeSchemaMetadata = originalWriteSchemaMetadata;
      assert.deepEqual(
        adapter.prepare("PRAGMA table_info(notes)").all().map((column) => column.name),
        ["id", "createdAt", "updatedAt", "text"],
      );
      assert.equal(adapter.readSchemaMetadata().value.includes("summary"), false);
      assert.deepEqual(adapter.selectAppRows(notesTable, { columns: ["id", "text"] }).map((row) => ({ ...row })), [
        { id: "note-1", text: "before" },
      ]);
    } finally {
      adapter.close();
    }
  });
});

test("libSQL database adapter supports runtime storage, migrations, health, and inspection paths", async () => {
  await withTempDir(async (dir) => {
    await withFakeLibsqlService(path.join(dir, "runtime-paths.db"), async ({ url }) => {
      const adapter = await createLibsqlDatabaseAdapter({ url });
      const database = { adapter, sqlite: adapter };
      try {
        const notesTable = {
          name: "notes",
          fields: [
            { name: "text", kind: "String", sqliteType: "TEXT" },
            { name: "ownerId", kind: "String", sqliteType: "TEXT" },
            { name: "done", kind: "Boolean", sqliteType: "INTEGER", defaultValue: false },
          ],
        };

        await adapter.ensureSystemTable();
        await adapter.writeSystemMetadata("adapter", "libsql");
        await adapter.migrateAppSchema({ tables: [notesTable] });
        assert.equal((await adapter.readSystemMetadata("adapter")).value, "libsql");

        const now = "2026-07-04T10:00:00.000Z";
        await adapter.insertAppRow(notesTable, {
          id: "note-1",
          createdAt: now,
          updatedAt: now,
          text: "service backed",
          ownerId: "user-1",
          done: 0,
        });
        await adapter.updateAppRow(notesTable, "note-1", { done: 1, updatedAt: "2026-07-04T10:01:00.000Z" });
        assert.deepEqual(await adapter.selectAppRows(notesTable, { columns: ["text", "done"] }), [
          { text: "service backed", done: 1 },
        ]);

        const migratedNotesTable = {
          ...notesTable,
          fields: [...notesTable.fields, { name: "summary", kind: "String", sqliteType: "TEXT", defaultValue: "draft" }],
        };
        await adapter.migrateAppSchema({ tables: [migratedNotesTable] });
        assert.deepEqual(await adapter.selectAppRows(migratedNotesTable, { columns: ["text", "summary"] }), [
          { text: "service backed", summary: "draft" },
        ]);

        await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
        await adapter.insertAuthUser({
          id: "user-1",
          createdAt: now,
          displayName: "LibSQL User",
          email: "libsql@example.com",
          picture: null,
          isAuthenticated: 1,
          isGuest: 0,
          provider: "email",
        });
        await adapter.insertAuthSession({
          token: "session-1",
          userId: "user-1",
          provider: "email",
          createdAt: now,
          expiresAt: "2026-08-03T10:00:00.000Z",
        });
        assert.equal((await adapter.readAuthSessionWithUser("session-1")).email, "libsql@example.com");
        await adapter.insertAuthIdentity({
          id: "identity-1",
          userId: "user-1",
          provider: "google",
          subject: "libsql-google-subject",
          email: null,
          displayName: "LibSQL User",
          picture: null,
          createdAt: now,
          updatedAt: now,
        });
        assert.equal((await adapter.findAuthIdentityByProviderSubject("google", "libsql-google-subject")).userId, "user-1");

        await adapter.ensureFileStorage();
        await adapter.createFileBucket({ id: "bucket-1", ownerId: "user-1", name: "default", createdAt: now });
        await adapter.insertFileRow({
          id: "file-1",
          ownerId: "user-1",
          bucketId: "bucket-1",
          bucketName: "default",
          path: "/default/proof.txt",
          name: "proof.txt",
          type: "text/plain",
          size: 5,
          version: "version-1",
          status: "uploaded",
          createdAt: now,
          updatedAt: now,
        });
        assert.equal((await adapter.fileRowForOwner("file-1", "user-1")).name, "proof.txt");

        await adapter.ensureLogStorage();
        await adapter.insertLogIndexEvent({
          timestamp: "2026-07-04T10:02:00.000Z",
          category: "app",
          event: "ctx.log",
          level: "info",
          message: "libsql log",
          capsule: { name: "libsql-adapter" },
        });
        assert.deepEqual((await adapter.readRecentLogEvents(1)).map((event) => event.message), ["libsql log"]);

        await assert.rejects(
          adapter.withTransaction(async (transaction) => {
            await transaction.insertAppRow(migratedNotesTable, {
              id: "note-rolled-back",
              createdAt: now,
              updatedAt: now,
              text: "rolled back",
              ownerId: "user-1",
              done: 0,
              summary: "draft",
            });
            throw new Error("rollback path");
          }),
          /rollback path/,
        );
        assert.equal(await adapter.selectAppRowById(migratedNotesTable, "note-rolled-back"), null);

        assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
        assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "notes"), ["notes"]);
        assert.equal((await dumpDatabase(database)).find((table) => table.name === "notes").rows.length, 1);
        assert.deepEqual(await runReadOnlyQuery(database, "SELECT text, summary FROM notes"), {
          ok: true,
          data: {
            columns: ["text", "summary"],
            rows: [{ text: "service backed", summary: "draft" }],
          },
          error: null,
        });
      } finally {
        await adapter.close();
      }
    });
  });
});

test(
  "Postgres database adapter supports runtime storage, migrations, health, and inspection paths",
  { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres adapter integration test." },
  async () => {
    const adapter = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL });
    const database = { adapter, sqlite: adapter };
    try {
      await adapter.exec(
        "DROP TABLE IF EXISTS notes, sporades, sporades_auth_users, sporades_auth_sessions, sporades_auth_identities, sporades_auth_email_credentials, " +
          "sporades_auth_oauth_states, sporades_file_buckets, sporades_files, sporades_file_uploads, sporades_file_public_urls, " +
          "sporades_log_events",
      );

      const notesTable = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
          { name: "done", kind: "Boolean", sqliteType: "INTEGER", defaultValue: false },
        ],
      };

      await adapter.ensureSystemTable();
      await adapter.writeSystemMetadata("adapter", "postgres");
      await adapter.migrateAppSchema({ tables: [notesTable] });
      assert.equal((await adapter.readSystemMetadata("adapter")).value, "postgres");

      const now = "2026-07-04T10:00:00.000Z";
      await adapter.insertAppRow(notesTable, {
        id: "note-1",
        createdAt: now,
        updatedAt: now,
        text: "postgres backed",
        ownerId: "user-1",
        done: 0,
      });
      await adapter.updateAppRow(notesTable, "note-1", { done: 1, updatedAt: "2026-07-04T10:01:00.000Z" });
      assert.deepEqual(await adapter.selectAppRows(notesTable, { columns: ["text", "done"] }), [{ text: "postgres backed", done: 1 }]);

      const migratedNotesTable = {
        ...notesTable,
        fields: [...notesTable.fields, { name: "summary", kind: "String", sqliteType: "TEXT", defaultValue: "draft" }],
      };
      await adapter.migrateAppSchema({ tables: [migratedNotesTable] });
      assert.deepEqual(await adapter.selectAppRows(migratedNotesTable, { columns: ["text", "summary"] }), [
        { text: "postgres backed", summary: "draft" },
      ]);

      await adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
      await adapter.insertAuthUser({
        id: "user-1",
        createdAt: now,
        displayName: "Postgres User",
        email: "postgres@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "email",
      });
      await adapter.insertAuthSession({
        token: "session-1",
        userId: "user-1",
        provider: "email",
        createdAt: now,
        expiresAt: "2026-08-03T10:00:00.000Z",
      });
      assert.equal((await adapter.readAuthSessionWithUser("session-1")).email, "postgres@example.com");
      await adapter.insertAuthIdentity({
        id: "identity-1",
        userId: "user-1",
        provider: "google",
        subject: "postgres-google-subject",
        email: null,
        displayName: "Postgres User",
        picture: null,
        createdAt: now,
        updatedAt: now,
      });
      assert.equal((await adapter.findAuthIdentityByProviderSubject("google", "postgres-google-subject")).userId, "user-1");

      await adapter.ensureFileStorage();
      await adapter.createFileBucket({ id: "bucket-1", ownerId: "user-1", name: "default", createdAt: now });
      await adapter.insertFileRow({
        id: "file-1",
        ownerId: "user-1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/proof.txt",
        name: "proof.txt",
        type: "text/plain",
        size: 5,
        version: "version-1",
        status: "uploaded",
        createdAt: now,
        updatedAt: now,
      });
      assert.equal((await adapter.fileRowForOwner("file-1", "user-1")).name, "proof.txt");

      await adapter.ensureLogStorage();
      await adapter.insertLogIndexEvent({
        timestamp: "2026-07-04T10:02:00.000Z",
        category: "app",
        event: "ctx.log",
        level: "info",
        message: "postgres log",
        capsule: { name: "postgres-adapter" },
      });
      assert.deepEqual((await adapter.readRecentLogEvents(1)).map((event) => event.message), ["postgres log"]);

      await assert.rejects(
        adapter.withTransaction(async (transaction) => {
          await transaction.insertAppRow(migratedNotesTable, {
            id: "note-rolled-back",
            createdAt: now,
            updatedAt: now,
            text: "rolled back",
            ownerId: "user-1",
            done: 0,
            summary: "draft",
          });
          throw new Error("rollback path");
        }),
        /rollback path/,
      );
      assert.equal(await adapter.selectAppRowById(migratedNotesTable, "note-rolled-back"), null);

      assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "notes"), ["notes"]);
      assert.equal((await dumpDatabase(database)).find((table) => table.name === "notes").rows.length, 1);
      assert.deepEqual(await runReadOnlyQuery(database, 'SELECT "text", "summary" FROM "notes"'), {
        ok: true,
        data: {
          columns: ["text", "summary"],
          rows: [{ text: "postgres backed", summary: "draft" }],
        },
        error: null,
      });
    } finally {
      await adapter.close();
    }
  },
);

test("SQLite database adapter propagates execution failures", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      assert.throws(() => adapter.exec("CREATE TABLE broken ("), /incomplete input|syntax error/i);
      assert.throws(() => adapter.prepare("SELECT * FROM missing_table").all(), /no such table/i);
    } finally {
      adapter.close();
    }
  });
});

test("runtime opens and closes SQLite through the internal adapter boundary", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {});

    assert.equal(database.adapter, database.sqlite);
    assert.equal(typeof database.sqlite.exec, "function");
    assert.equal(typeof database.sqlite.prepare, "function");
    assert.equal(typeof database.sqlite.close, "function");
    assert.deepEqual({ ...database.sqlite.prepare("SELECT value FROM sporades WHERE key = ?").get("schemaVersion") }, {
      value: "v1:additive-fields",
    });

    database.close();
    assert.throws(() => database.sqlite.prepare("SELECT 1").get(), /database is not open/i);
  });
});

test("SQLite database adapter owns app schema metadata, migrations, references, queries, and mutations", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      const usersTable = {
        name: "users",
        fields: [
          { name: "name", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      const postsTable = {
        name: "posts",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "authorId", kind: "Reference", sqliteType: "TEXT", targetTable: "users" },
          { name: "published", kind: "Boolean", sqliteType: "INTEGER", defaultValue: false },
        ],
      };

      adapter.ensureSystemTable();
      adapter.migrateAppSchema({ tables: [usersTable, postsTable] });

      const schemaMetadata = adapter.readSchemaMetadata();
      assert.match(schemaMetadata.value, /"posts"/);
      assert.deepEqual(
        adapter.prepare("PRAGMA table_info(posts)").all().map((column) => column.name),
        ["id", "createdAt", "updatedAt", "text", "authorId", "published"],
      );

      const now = "2026-07-04T10:00:00.000Z";
      adapter.insertAppRow(usersTable, {
        id: "user-1",
        createdAt: now,
        updatedAt: now,
        name: "Ada",
        ownerId: "owner-1",
      });
      assert.equal(adapter.referenceExists({ targetTable: "users" }, "user-1"), true);
      assert.equal(adapter.referenceExists({ targetTable: "users" }, "missing"), false);

      adapter.insertAppRow(postsTable, {
        id: "post-1",
        createdAt: now,
        updatedAt: now,
        text: "First",
        authorId: "user-1",
        published: 0,
      });
      adapter.updateAppRow(postsTable, "post-1", {
        text: "Updated",
        published: 1,
        updatedAt: "2026-07-04T11:00:00.000Z",
      });

      assert.deepEqual(
        adapter
          .selectAppRows(postsTable, {
            columns: ["id", "text", "published"],
            where: { fieldName: "authorId", value: "user-1" },
            orderBy: { fieldName: "createdAt", direction: "desc" },
            limit: 1,
          })
          .map((row) => ({ ...row })),
        [{ id: "post-1", text: "Updated", published: 1 }],
      );
      assert.equal(adapter.selectAppRowById(postsTable, "post-1").text, "Updated");
      assert.equal(adapter.deleteAppRow(postsTable, "missing").changes, 0);

      const migratedPostsTable = {
        ...postsTable,
        fields: [
          ...postsTable.fields,
          { name: "editorId", kind: "Reference", sqliteType: "TEXT", targetTable: "users", defaultValue: "user-1" },
          { name: "summary", kind: "String", sqliteType: "TEXT", defaultValue: "draft" },
        ],
      };
      adapter.migrateAppSchema({ tables: [usersTable, migratedPostsTable] });

      assert.deepEqual(
        adapter.prepare("PRAGMA table_info(posts)").all().map((column) => column.name),
        ["id", "createdAt", "updatedAt", "text", "authorId", "published", "editorId", "summary"],
      );
      assert.deepEqual(
        adapter
          .selectAppRows(migratedPostsTable, { columns: ["text", "editorId", "summary"] })
          .map((row) => ({ ...row })),
        [{ text: "Updated", editorId: "user-1", summary: "draft" }],
      );
      assert.equal(adapter.deleteAppRow(migratedPostsTable, "post-1").changes, 1);
      assert.deepEqual(adapter.selectAppRows(migratedPostsTable), []);

      assert.throws(
        () =>
          adapter.migrateAppSchema({
            tables: [
              usersTable,
              {
                ...migratedPostsTable,
                fields: migratedPostsTable.fields.filter((field) => field.name !== "summary"),
              },
            ],
          }),
        {
          message: "Unsupported Capsule schema change.",
          hint: "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        },
      );
      assert.throws(
        () =>
          adapter.migrateAppSchema({
            tables: [
              usersTable,
              {
                ...migratedPostsTable,
                fields: [
                  ...migratedPostsTable.fields,
                  {
                    name: "reviewerId",
                    kind: "Reference",
                    sqliteType: "TEXT",
                    targetTable: "users",
                    defaultValue: "missing",
                  },
                ],
              },
            ],
          }),
        {
          message: "Invalid reference for field: reviewerId",
          hint: "Pass the id of an existing users row.",
        },
      );
    } finally {
      adapter.close();
    }
  });
});

test("SQLite database adapter owns runtime storage for auth, files, logs, and system metadata", async () => {
  await withTempDir(async (dir) => {
    const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
    try {
      adapter.ensureSystemTable();
      adapter.writeSystemMetadata("runtimeKey", "runtime-value");
      assert.deepEqual({ ...adapter.readSystemMetadata("runtimeKey") }, { value: "runtime-value" });

      adapter.ensureAuthStorage({ providers: { email: { enabled: true } } });
      const now = "2026-07-04T10:00:00.000Z";
      adapter.insertAuthUser({
        id: "user-1",
        createdAt: now,
        displayName: "Anonymous",
        email: null,
        picture: null,
        isAuthenticated: 0,
        isGuest: 1,
        provider: "anonymous",
      });
      adapter.insertAuthSession({
        token: "session-1",
        userId: "user-1",
        provider: "anonymous",
        createdAt: now,
        expiresAt: "2026-08-03T10:00:00.000Z",
      });
      assert.equal(adapter.readAuthSessionWithUser("session-1").provider, "anonymous");

      adapter.insertEmailCredential({
        email: "mira@example.com",
        userId: "user-1",
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: now,
      });
      assert.equal(adapter.emailCredentialExists("mira@example.com"), true);
      adapter.linkAuthUser({
        id: "user-1",
        displayName: "Mira",
        email: "mira@example.com",
        picture: null,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "email",
      });
      assert.equal(adapter.findEmailCredentialWithUser("mira@example.com").displayName, "Mira");
      adapter.insertAuthIdentity({
        id: "identity-1",
        userId: "user-1",
        provider: "google",
        subject: "sqlite-google-subject",
        email: null,
        displayName: "Mira",
        picture: null,
        createdAt: now,
        updatedAt: now,
      });
      assert.equal(adapter.findAuthIdentityByProviderSubject("google", "sqlite-google-subject").userId, "user-1");
      adapter.rotateAuthSession("session-1", {
        token: "session-2",
        userId: "user-1",
        provider: "email",
        createdAt: "2026-07-04T11:00:00.000Z",
        expiresAt: "2026-08-03T11:00:00.000Z",
      });
      assert.equal(adapter.readAuthSessionWithUser("session-1"), null);
      assert.equal(adapter.readAuthSessionWithUser("session-2").token, "session-2");
      adapter.insertOAuthState({
        state: "oauth-state",
        sessionToken: "session-2",
        returnTo: "http://127.0.0.1:4000/after",
        redirectUri: "http://127.0.0.1:4000/__sporades/auth/google/callback",
        createdAt: now,
      });
      assert.equal(adapter.consumeOAuthState("oauth-state").sessionToken, "session-2");
      assert.equal(adapter.consumeOAuthState("oauth-state"), null);

      adapter.ensureFileStorage();
      adapter.createFileBucket({ id: "bucket-1", ownerId: "user-1", name: "default", createdAt: now });
      assert.equal(adapter.findFileBucket("user-1", "default").id, "bucket-1");
      adapter.insertFileRow({
        id: "file-1",
        ownerId: "user-1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/hello.txt",
        name: "hello.txt",
        type: "text/plain",
        size: 5,
        version: "version-1",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      adapter.insertFileUpload({
        id: "upload-1",
        fileId: "file-1",
        ownerId: "user-1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/hello.txt",
        name: "hello.txt",
        type: "text/plain",
        version: "version-1",
        expectedSize: 5,
        createdAt: now,
      });
      assert.equal(adapter.selectFileUpload("upload-1").fileId, "file-1");
      adapter.completeFileUpload(adapter.selectFileUpload("upload-1"), 5, "2026-07-04T10:01:00.000Z");
      adapter.deleteFileUpload("upload-1");
      assert.equal(adapter.selectFileUpload("upload-1"), null);
      assert.equal(adapter.fileRowForOwner("file-1", "user-1").status, "uploaded");
      adapter.insertPublicFileUrl({
        id: "public-1",
        fileId: "file-1",
        ownerId: "user-1",
        version: "version-1",
        expiresAt: null,
        createdAt: now,
      });
      assert.equal(adapter.selectPublicFileRow("public-1").publicVersion, "version-1");
      adapter.updatePendingFileRow({
        id: "file-1",
        bucketId: "bucket-1",
        bucketName: "default",
        path: "/default/goodbye.txt",
        name: "goodbye.txt",
        type: "text/plain",
        size: 7,
        version: "version-2",
        status: "pending",
        updatedAt: "2026-07-04T10:02:00.000Z",
      });
      adapter.revokePublicFileUrlsForFile("file-1", "2026-07-04T10:02:00.000Z");
      assert.equal(adapter.selectPublicFileRow("public-1").revokedAt, "2026-07-04T10:02:00.000Z");
      adapter.markFileDeleted("file-1", "2026-07-04T10:03:00.000Z");
      assert.equal(adapter.fileRowForOwner("file-1", "user-1"), null);

      adapter.ensureLogStorage();
      for (const index of [1, 2, 3]) {
        adapter.insertLogIndexEvent({
          timestamp: `2026-07-04T10:00:0${index}.000Z`,
          category: "app",
          event: "ctx.log",
          level: "info",
          message: `log-${index}`,
          capsule: { name: "adapter-island" },
          release: null,
          request: null,
          correlation: null,
        });
      }
      adapter.pruneLogIndex(2);
      assert.deepEqual(
        adapter.readRecentLogEvents(10).map((entry) => entry.message),
        ["log-2", "log-3"],
      );
    } finally {
      adapter.close();
    }
  });
});

test("Log index failures degrade inspection without failing the emitted workflow", async () => {
  await withTempDir(async (dir) => {
    assert.equal(typeof createRuntimeLogSink, "function");
    const database = {
      insertLogIndexEvent() {
        throw new Error("index unavailable");
      },
      pruneLogIndex() {
        throw new Error("prune unavailable");
      },
      readRecentLogEvents() {
        return [];
      },
    };
    const sink = createRuntimeLogSink({
      database,
      config: { name: "log-index-island", logs: { maxIndexEntries: 1 } },
      serverEnv: {},
      dataDir: dir,
    });

    const event = sink.emit({
      category: "app",
      event: "ctx.log",
      level: "info",
      message: "jsonl survives index failure",
    });

    assert.equal(event.message, "jsonl survives index failure");
    assert.deepEqual(sink.recent(10), []);
    assert.deepEqual(
      sink.tail(10).map((entry) => entry.message),
      ["jsonl survives index failure"],
    );
  });
});

test("Privileged audit events use the stable runtime-owned envelope and outcome vocabulary", async () => {
  await withTempDir(async (dir) => {
    assert.equal(typeof emitPrivilegedAuditEvent, "function");
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { WEBHOOK_SECRET: "env-secret-123" },
      {
        name: "audit-island",
        id: "capsule-123",
        release: { id: "release-456" },
      },
    );

    try {
      const outcomes = ["started", "completed", "errored", "finished"];
      const actorKinds = ["privileged-server-role", "captured-user", "platform", "unknown"];

      for (const [index, outcome] of outcomes.entries()) {
        const event = await emitPrivilegedAuditEvent(database, {
          actorKind: actorKinds[index % actorKinds.length],
          operation: `runtime.audit.${outcome}`,
          surface: "sporades/test-runtime",
          correlation: { id: `corr-${index}`, jobId: `job-${index}` },
          targetResourceKind: "runtime-log-index",
          outcome,
          safeErrorCode: outcome === "errored" ? "INDEX_UNAVAILABLE" : null,
          source: "runtime",
          metadata: {
            visible: `safe-${outcome}`,
          },
        });

        assert.equal(event.schema, "sporades.log.v1");
        assert.equal(event.category, "audit");
        assert.equal(event.event, `privileged.${outcome}`);
        assert.equal(event.capsule.name, "audit-island");
        assert.equal(event.capsule.id, "capsule-123");
        assert.deepEqual(event.release, { id: "release-456" });
        assert.deepEqual(event.correlation, { id: `corr-${index}`, jobId: `job-${index}` });
        assert.equal(event.data.schema, "sporades.privileged-audit.v1");
        assert.equal(event.data.actorKind, actorKinds[index % actorKinds.length]);
        assert.equal(event.data.operation, `runtime.audit.${outcome}`);
        assert.equal(event.data.surface, "sporades/test-runtime");
        assert.equal(event.data.targetResourceKind, "runtime-log-index");
        assert.equal(event.data.outcome, outcome);
        assert.equal(event.data.source, "runtime");
        assert.equal(event.data.metadata.visible, `safe-${outcome}`);
      }

      const errored = database.log.recent(10).find((entry) => entry.event === "privileged.errored");

      assert.equal(errored.level, "error");
      assert.equal(errored.data.safeErrorCode, "INDEX_UNAVAILABLE");

      const missingOutcome = await emitPrivilegedAuditEvent(database, {
        actorKind: "platform",
        operation: "runtime.audit.missing-outcome",
        surface: "sporades/test-runtime",
        targetResourceKind: "runtime-log-index",
      });
      const invalidOutcome = await emitPrivilegedAuditEvent(database, {
        actorKind: "platform",
        operation: "runtime.audit.invalid-outcome",
        surface: "sporades/test-runtime",
        targetResourceKind: "runtime-log-index",
        outcome: "succeeded",
      });
      const erroredWithoutCode = await emitPrivilegedAuditEvent(database, {
        actorKind: "platform",
        operation: "runtime.audit.errored-without-code",
        surface: "sporades/test-runtime",
        targetResourceKind: "runtime-log-index",
        outcome: "errored",
      });

      assert.equal(missingOutcome.event, "privileged.started");
      assert.equal(missingOutcome.data.outcome, "started");
      assert.equal(missingOutcome.data.safeErrorCode, null);
      assert.equal(invalidOutcome.event, "privileged.started");
      assert.equal(invalidOutcome.data.outcome, "started");
      assert.equal(erroredWithoutCode.level, "error");
      assert.equal(erroredWithoutCode.data.safeErrorCode, "UNKNOWN_ERROR");
    } finally {
      database.close();
    }
  });
});

test("Privileged audit metadata is redacted and capped before it reaches JSONL", async () => {
  await withTempDir(async (dir) => {
    assert.equal(typeof emitPrivilegedAuditEvent, "function");
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { WEBHOOK_SECRET: "env-secret-123" },
      {
        name: "redacted-audit-island",
        logs: { payloadMaxBytes: 2048 },
      },
    );

    try {
      const event = await emitPrivilegedAuditEvent(database, {
        actorKind: "privileged-server-role",
        operation: "runtime.secret.inspect",
        surface: "sporades/test-runtime",
        targetResourceKind: "server-env",
        outcome: "errored",
        error: Object.assign(new Error("raw stack should stay private"), { code: "ESECRET" }),
        source: "runtime",
        metadata: {
          safe: "visible",
          rawRequestBody: { password: "plaintext-password", bodySecret: "body-secret-123" },
          authorizedKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFULLPUBLICKEY user@example"],
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-bytes\n-----END OPENSSH PRIVATE KEY-----",
          serverEnvValue: "env-secret-123",
          sessionToken: "session-token-123",
          cookie: "session=abc",
          authorization: "Bearer auth-123",
          password: "plaintext-password",
          clientSecret: "client-secret-123",
          stack: "Error: nope\n    at runtime.js:1:2",
          large: "x".repeat(5000),
        },
      });

      const serialized = JSON.stringify(event);
      assert.equal(event.data.safeErrorCode, "ESECRET");
      assert.equal(event.data.metadata.safe, "visible");
      assert.equal(event.data.metadata.rawRequestBody, "[REDACTED]");
      assert.equal(event.data.metadata.authorizedKeys, "[REDACTED]");
      assert.equal(event.data.metadata.privateKey, "[REDACTED]");
      assert.equal(event.data.metadata.serverEnvValue, "[REDACTED]");
      assert.equal(event.data.metadata.sessionToken, "[REDACTED]");
      assert.equal(event.data.metadata.cookie, "[REDACTED]");
      assert.equal(event.data.metadata.authorization, "[REDACTED]");
      assert.equal(event.data.metadata.password, "[REDACTED]");
      assert.equal(event.data.metadata.clientSecret, "[REDACTED]");
      assert.equal(event.data.metadata.stack, "[REDACTED]");
      assert.equal(event.truncated, true);
      assert.ok(Buffer.byteLength(serialized, "utf8") <= 2048, serialized.length);
      assert.equal(serialized.includes("FULLPUBLICKEY"), false);
      assert.equal(serialized.includes("private-key-bytes"), false);
      assert.equal(serialized.includes("env-secret-123"), false);
      assert.equal(serialized.includes("session-token-123"), false);
      assert.equal(serialized.includes("plaintext-password"), false);
      assert.equal(serialized.includes("client-secret-123"), false);
      assert.equal(serialized.includes("runtime.js:1:2"), false);
    } finally {
      database.close();
    }
  });
});

test("Privileged audit JSONL emission survives Log index failures", async () => {
  await withTempDir(async (dir) => {
    assert.equal(typeof createRuntimeLogSink, "function");
    assert.equal(typeof emitPrivilegedAuditEvent, "function");
    const database = {
      insertLogIndexEvent() {
        throw new Error("index unavailable");
      },
      pruneLogIndex() {
        throw new Error("prune unavailable");
      },
      readRecentLogEvents() {
        return [];
      },
    };
    const sink = createRuntimeLogSink({
      database,
      config: { name: "audit-index-island" },
      serverEnv: {},
      dataDir: dir,
    });

    const event = emitPrivilegedAuditEvent(sink, {
      actorKind: "platform",
      operation: "runtime.log-index.write",
      surface: "sporades/test-runtime",
      targetResourceKind: "log-index",
      outcome: "errored",
      safeErrorCode: "INDEX_UNAVAILABLE",
      source: "runtime",
    });

    assert.equal(event.event, "privileged.errored");
    assert.equal(event.data.safeErrorCode, "INDEX_UNAVAILABLE");
    assert.deepEqual(sink.recent(10), []);
    assert.deepEqual(
      sink.tail(10).map((entry) => [entry.event, entry.data.outcome]),
      [["privileged.errored", "errored"]],
    );
  });
});

test("trusted server handlers can run minimal privileged callbacks with audit boundaries", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-island",
    });

    try {
      database.queries = [
        {
          name: "privilegedSummary",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.repair",
              targetResourceKind: "capsule-db",
              metadata: {
                count: 2,
                authorization: "Bearer should-not-leak",
              },
            }, (privilegedCtx) => ({
              outerUserId: ctx.auth.userId,
              privilegedUserId: privilegedCtx.auth.userId,
              privilegedContextIsDerived: privilegedCtx !== ctx,
              sameEnv: privilegedCtx.env === ctx.env,
              hasDb: Boolean(privilegedCtx.db),
            })),
        },
      ];

      const result = await runQuery(database, { userId: "user-1" }, "privilegedSummary");

      assert.deepEqual(result, {
        data: {
          outerUserId: "user-1",
          privilegedUserId: "__privileged__",
          privilegedContextIsDerived: true,
          sameEnv: true,
          hasDb: true,
        },
        error: null,
      });

      const auditEvents = database.log.recent(10).filter((entry) => entry.category === "audit");
      assert.deepEqual(
        auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
        [
          ["privileged.started", "notes.repair", "started"],
          ["privileged.completed", "notes.repair", "completed"],
          ["privileged.finished", "notes.repair", "finished"],
        ],
      );
      for (const event of auditEvents) {
        assert.equal(event.data.actorKind, "privileged-server-role");
        assert.equal(event.data.surface, "query");
        assert.equal(event.data.targetResourceKind, "capsule-db");
        assert.equal(event.data.metadata.count, 2);
        assert.equal(event.data.metadata.authorization, "[REDACTED]");
      }
      assert.equal(JSON.stringify(auditEvents).includes("should-not-leak"), false);
    } finally {
      database.close();
    }
  });
});

test("privileged table writes only use sentinel ownership when Capsule code supplies it", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-owner-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT", defaultValue: null },
        ],
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.queries = [
        {
          name: "writePrivilegedNotes",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.ownerAudit",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "implicit owner" });
              privilegedCtx.db.notes.insert({ text: "explicit owner", ownerId: privilegedCtx.auth.userId });
              return { ok: true };
            }),
        },
      ];

      const result = await runQuery(database, { userId: "user-1" }, "writePrivilegedNotes");

      assert.deepEqual(result, { data: { ok: true }, error: null });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, {
            columns: ["text", "ownerId"],
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
          .map((row) => ({ ...row })),
        [
          { text: "implicit owner", ownerId: null },
          { text: "explicit owner", ownerId: "__privileged__" },
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged table API bypasses normal ACL gates while normal ctx.db remains denied", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-acl-island",
    });

    try {
      const aclContexts = [];
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            if (!["read", "insert", "update", "delete"].includes(operation)) {
              return null;
            }
            return ({ ctx }) => {
              aclContexts.push({
                operation,
                hasDb: Object.hasOwn(ctx, "db"),
                hasPrivileged: Object.hasOwn(ctx, "privileged"),
              });
              return false;
            };
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "seed-note",
        text: "blocked seed",
        ownerId: "user-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      database.queries = [
        {
          name: "normalRead",
          handler: (ctx) => ctx.db.notes.all(),
        },
        {
          name: "normalWrite",
          handler: (ctx) => ctx.db.notes.insert({ text: "normal denied", ownerId: ctx.auth.userId }),
        },
        {
          name: "privilegedRepair",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.repairAcl",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              const before = privilegedCtx.db.notes.orderBy("createdAt", "asc").all().map((row) => row.text);
              const inserted = privilegedCtx.db.notes.insert({ text: "privileged inserted", ownerId: privilegedCtx.auth.userId });
              const after = privilegedCtx.db.notes.orderBy("createdAt", "asc").all().map((row) => row.text);
              return {
                before,
                insertedOwnerId: inserted.ownerId,
                after,
              };
            }),
        },
      ];

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "normalRead"), {
        data: [],
        error: null,
      });
      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "normalWrite"), {
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "privilegedRepair"), {
        data: {
          before: ["blocked seed"],
          insertedOwnerId: "__privileged__",
          after: ["blocked seed", "privileged inserted"],
        },
        error: null,
      });
      assert.deepEqual(
        aclContexts.map((context) => [context.operation, context.hasDb, context.hasPrivileged]),
        [
          ["read", false, false],
          ["insert", false, false],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged DB writes in failing mutations roll back while audit evidence remains durable", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-transaction-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["read", "insert", "update", "delete"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "seed-note",
        text: "seed",
        ownerId: "user-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      database.mutations = [
        {
          name: "privilegedRepairThenFail",
          handler: async (ctx) => {
            await ctx.privileged.run({
              operation: "notes.transactionRepair",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({
                text: "rolled back privileged write",
                ownerId: privilegedCtx.auth.userId,
              });
            });
            throw new Error("rollback privileged work");
          },
        },
      ];
      database.mutationHooks = { beforeMutation: [], afterMutation: [] };

      const failed = await runMutation(database, { userId: "user-1" }, "privilegedRepairThenFail", []);

      assert.deepEqual(failed, {
        ok: false,
        error: {
          message: "rollback privileged work",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, {
            columns: ["text", "ownerId"],
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
          .map((row) => ({ ...row })),
        [{ text: "seed", ownerId: "user-2" }],
      );
      assert.deepEqual(
        database.log.recent(10)
          .filter((entry) => entry.category === "audit")
          .map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
        [
          ["privileged.started", "notes.transactionRepair", "started"],
          ["privileged.completed", "notes.transactionRepair", "completed"],
          ["privileged.finished", "notes.transactionRepair", "finished"],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged DB work outside existing transactions does not add callback-wide atomicity", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-no-implicit-transaction-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["read", "insert", "update", "delete"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.queries = [
        {
          name: "privilegedRepairThenFail",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.nonTransactionalRepair",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({
                text: "kept privileged write",
                ownerId: privilegedCtx.auth.userId,
              });
              throw Object.assign(new Error("outside mutation failure"), { code: "OUTSIDE_MUTATION_FAILURE" });
            }),
        },
      ];

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "privilegedRepairThenFail"), {
        data: null,
        error: {
          code: "PRIVILEGED_RUN_FAILED",
          message: "Privileged run failed.",
          hint: "Check the privileged audit events and server logs before exposing a safe response.",
        },
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, {
            columns: ["text", "ownerId"],
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
          .map((row) => ({ ...row })),
        [{ text: "kept privileged write", ownerId: "__privileged__" }],
      );
      assert.deepEqual(
        database.log.recent(10)
          .filter((entry) => entry.category === "audit")
          .map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
        [
          ["privileged.started", "notes.nonTransactionalRepair", "started", null],
          ["privileged.errored", "notes.nonTransactionalRepair", "errored", "OUTSIDE_MUTATION_FAILURE"],
          ["privileged.finished", "notes.nonTransactionalRepair", "finished", null],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged audit rollback recovery does not duplicate already durable audit index entries", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-durable-audit-island",
    });
    const baseAdapter = database.sqlite;

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["read", "insert", "update", "delete"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.adapter = createDurableAuditTransactionAdapter(baseAdapter);
      database.mutations = [
        {
          name: "privilegedRepairThenFail",
          handler: async (ctx) => {
            await ctx.privileged.run({
              operation: "notes.durableAuditRepair",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({
                text: "adapter-scoped privileged write",
                ownerId: privilegedCtx.auth.userId,
              });
            });
            throw new Error("rollback with durable audit");
          },
        },
      ];
      database.mutationHooks = { beforeMutation: [], afterMutation: [] };

      const failed = await runMutation(database, { userId: "user-1" }, "privilegedRepairThenFail", []);

      assert.deepEqual(failed, {
        ok: false,
        error: {
          message: "rollback with durable audit",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });
      assert.deepEqual(
        database.log.recent(10)
          .filter((entry) => entry.category === "audit")
          .map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
        [
          ["privileged.started", "notes.durableAuditRepair", "started"],
          ["privileged.completed", "notes.durableAuditRepair", "completed"],
          ["privileged.finished", "notes.durableAuditRepair", "finished"],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("normal handler contexts cannot forge privileged DB ACL bypass", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-forgery-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["read", "insert", "update", "delete"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "seed-note",
        text: "forgery seed",
        ownerId: "user-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      database.queries = [
        {
          name: "forgedRead",
          handler: (ctx) => {
            ctx.__privilegedRunActive = true;
            ctx.__privilegedDbAccess = true;
            ctx.skipAcl = true;
            ctx.bypassAcl = true;
            ctx.auth = {
              ...ctx.auth,
              userId: "__privileged__",
              provider: "privileged-server-role",
            };
            return ctx.db.notes.all();
          },
        },
        {
          name: "forgedWrite",
          handler: (ctx) => {
            ctx.__privilegedRunActive = true;
            ctx.__privilegedDbAccess = true;
            ctx.skipAcl = true;
            ctx.bypassAcl = true;
            ctx.auth = {
              ...ctx.auth,
              userId: "__privileged__",
              provider: "privileged-server-role",
            };
            return ctx.db.notes.insert({ text: "forged insert", ownerId: "__privileged__" });
          },
        },
      ];

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "forgedRead"), {
        data: [],
        error: null,
      });
      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "forgedWrite"), {
        data: null,
        error: {
          code: "DENIED",
          message: "Denied.",
          hint: "The current user is not allowed to perform this operation.",
        },
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, {
            columns: ["text", "ownerId"],
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
          .map((row) => ({ ...row })),
        [{ text: "forgery seed", ownerId: "user-2" }],
      );
    } finally {
      database.close();
    }
  });
});

test("leaked privileged table APIs cannot bypass ACL after privileged run finishes", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-db-leak-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["read", "insert", "update", "delete"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "seed-note",
        text: "leak seed",
        ownerId: "user-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      database.queries = [
        {
          name: "leakedPrivilegedApis",
          handler: async (ctx) => {
            let leakedDb;
            let leakedTable;
            const inRun = await ctx.privileged.run({
              operation: "notes.leakCheck",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              leakedDb = privilegedCtx.db;
              leakedTable = privilegedCtx.db.notes;
              privilegedCtx.db.notes.insert({ text: "inside run", ownerId: privilegedCtx.auth.userId });
              return privilegedCtx.db.notes.orderBy("createdAt", "asc").all().map((row) => row.text);
            });

            const leakedDbRead = leakedDb.notes.orderBy("createdAt", "asc").all().map((row) => row.text);
            const leakedTableRead = leakedTable.orderBy("createdAt", "asc").all().map((row) => row.text);
            let leakedDbWriteCode = null;
            let leakedTableWriteCode = null;
            try {
              leakedDb.notes.insert({ text: "after run via db", ownerId: "__privileged__" });
            } catch (error) {
              leakedDbWriteCode = error.code;
            }
            try {
              leakedTable.insert({ text: "after run via table", ownerId: "__privileged__" });
            } catch (error) {
              leakedTableWriteCode = error.code;
            }

            return {
              inRun,
              leakedDbRead,
              leakedTableRead,
              leakedDbWriteCode,
              leakedTableWriteCode,
            };
          },
        },
      ];

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "leakedPrivilegedApis"), {
        data: {
          inRun: ["leak seed", "inside run"],
          leakedDbRead: [],
          leakedTableRead: [],
          leakedDbWriteCode: "DENIED",
          leakedTableWriteCode: "DENIED",
        },
        error: null,
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, {
            columns: ["text", "ownerId"],
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
          .map((row) => ({ ...row })),
        [
          { text: "leak seed", ownerId: "user-2" },
          { text: "inside run", ownerId: "__privileged__" },
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged file access can read approved Capsule files that normal access cannot", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-files-island",
      files: { storagePath: path.join(dir, "files") },
    });
    const ownerAuth = { userId: "owner-1", displayName: "Owner", isAuthenticated: true, isGuest: false, provider: "email" };
    const otherAuth = { userId: "user-2", displayName: "Other", isAuthenticated: false, isGuest: true, provider: "anonymous" };

    try {
      const pending = await createPendingFileUpload(database, ownerAuth, {
        file: { name: "report.txt", type: "text/plain", size: 11, path: "/reports/private.txt" },
      });
      assert.equal(pending.ok, true, pending.error?.message);
      const uploadId = pending.data.uploadUrl.split("/").pop();
      const completed = await completePendingFileUpload(database, uploadId, Readable.from([Buffer.from("secret data")]));
      assert.equal(completed.ok, true, completed.error?.message);

      const deniedNormalAccess = await getPrivateFileUrl(database, otherAuth, completed.data.file.id);
      assert.equal(deniedNormalAccess.ok, false);
      assert.equal(deniedNormalAccess.error.message, "File not found.");

      database.queries = [
        {
          name: "repairFile",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "files.repair",
              targetResourceKind: "files",
              metadata: { fileId: completed.data.file.id },
            }, async (privilegedCtx) => {
              const byId = await privilegedCtx.files.url(completed.data.file.id);
              const byPath = await privilegedCtx.files.url("/reports/private.txt");
              return {
                actor: privilegedCtx.auth.userId,
                byIdFileId: byId.data.file.id,
                byIdOwnerId: byId.data.file.ownerId,
                byPathFileId: byPath.data.file.id,
                byPathOwnerId: byPath.data.file.ownerId,
                url: byId.data.url,
              };
            }),
        },
      ];

      const result = await runQuery(database, otherAuth, "repairFile");

      assert.deepEqual(result, {
        data: {
          actor: "__privileged__",
          byIdFileId: completed.data.file.id,
          byIdOwnerId: "owner-1",
          byPathFileId: completed.data.file.id,
          byPathOwnerId: "owner-1",
          url: `/__sporades/files/private/${completed.data.file.id}?v=${encodeURIComponent(completed.data.file.version)}`,
        },
        error: null,
      });

      const auditEvents = database.log.recent(10).filter((entry) => entry.category === "audit");
      assert.deepEqual(
        auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.targetResourceKind]),
        [
          ["privileged.started", "files.repair", "started", "files"],
          ["privileged.completed", "files.repair", "completed", "files"],
          ["privileged.finished", "files.repair", "finished", "files"],
        ],
      );
      for (const event of auditEvents) {
        assert.equal(event.data.metadata.fileId, completed.data.file.id);
      }
    } finally {
      database.close();
    }
  });
});

test("unsupported privileged storage operations fail closed with stable errors", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-files-closed-island",
      files: { storagePath: path.join(dir, "files") },
    });

    try {
      database.queries = [
        {
          name: "unsupportedStorageAccess",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "files.rawObjectRead",
              targetResourceKind: "storage",
            }, async (privilegedCtx) => privilegedCtx.files.unsupported("rawObjectRead")),
        },
      ];

      const result = await runQuery(database, { userId: "user-1" }, "unsupportedStorageAccess");

      assert.deepEqual(result, {
        data: null,
        error: {
          code: "PRIVILEGED_RUN_FAILED",
          message: "Privileged run failed.",
          hint: "Check the privileged audit events and server logs before exposing a safe response.",
        },
      });
      const errored = database.log.recent(10).find((entry) => entry.event === "privileged.errored");
      assert.equal(errored.data.operation, "files.rawObjectRead");
      assert.equal(errored.data.safeErrorCode, "UNSUPPORTED_PRIVILEGED_FILE_OPERATION");
      assert.equal(errored.data.targetResourceKind, "storage");
    } finally {
      database.close();
    }
  });
});

test("privileged file deletion uses configured Capsule storage services", async () => {
  await withFakeS3CompatibleService(async ({ endpoint, objects }) => {
    await withTempDir(async (dir) => {
      const database = await openDevDatabase(
        path.join(dir, "data.db"),
        "",
        {},
        {
          name: "privileged-s3-files-island",
          services: { storage: { kind: "storage", engine: "minio" } },
        },
        null,
        {
          serviceEnv: {
            SPORADES_SERVICE_STORAGE_ENGINE: "minio",
            SPORADES_SERVICE_STORAGE_ENDPOINT: endpoint,
            SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
            SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
            SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
            SPORADES_SERVICE_STORAGE_REGION: "eu-west-2",
            SPORADES_SERVICE_STORAGE_NAMESPACE: "privileged-s3-files-island",
          },
        },
      );
      const ownerAuth = { userId: "owner-1", displayName: "Owner", isAuthenticated: true, isGuest: false, provider: "email" };
      const otherAuth = { userId: "user-2", displayName: "Other", isAuthenticated: false, isGuest: true, provider: "anonymous" };

      try {
        const pending = await createPendingFileUpload(database, ownerAuth, {
          file: { name: "report.txt", type: "text/plain", size: 11, path: "/reports/private.txt" },
        });
        assert.equal(pending.ok, true, pending.error?.message);
        const completed = await completePendingFileUpload(
          database,
          pending.data.uploadUrl.split("/").pop(),
          Readable.from([Buffer.from("secret data")]),
        );
        assert.equal(completed.ok, true, completed.error?.message);

        const objectKey = `capsules/privileged-s3-files-island/files/${completed.data.file.id}/${completed.data.file.version}`;
        assert.equal(objects.has(objectKey), true);
        assert.equal((await deletePrivateFile(database, otherAuth, completed.data.file.id)).ok, false);
        assert.equal(objects.has(objectKey), true);

        database.queries = [
          {
            name: "deleteFile",
            handler: (ctx) =>
              ctx.privileged.run({
                operation: "files.delete",
                targetResourceKind: "files",
                metadata: { fileId: completed.data.file.id },
              }, (privilegedCtx) => privilegedCtx.files.delete(completed.data.file.id)),
          },
        ];

        const result = await runQuery(database, otherAuth, "deleteFile");

        assert.equal(result.error, null);
        assert.equal(result.data.ok, true);
        assert.equal(result.data.data.file.id, completed.data.file.id);
        assert.equal(objects.has(objectKey), false);
        assert.equal((await getPrivateFileUrl(database, ownerAuth, completed.data.file.id)).ok, false);
      } finally {
        database.close();
      }
    });
  });
});

test("privileged file writes preserve the surrounding mutation transaction", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-file-mutation-island",
      files: { storagePath: path.join(dir, "files") },
    });
    const ownerAuth = { userId: "owner-1", displayName: "Owner", isAuthenticated: true, isGuest: false, provider: "email" };
    const otherAuth = { userId: "user-2", displayName: "Other", isAuthenticated: false, isGuest: true, provider: "anonymous" };

    try {
      const pending = await createPendingFileUpload(database, ownerAuth, {
        file: { name: "report.txt", type: "text/plain", size: 11, path: "/reports/private.txt" },
      });
      assert.equal(pending.ok, true, pending.error?.message);
      const completed = await completePendingFileUpload(
        database,
        pending.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("secret data")]),
      );
      assert.equal(completed.ok, true, completed.error?.message);

      database.mutations = [
        {
          name: "publishAndDeleteFile",
          handler: (ctx, fileId) =>
            ctx.privileged.run({
              operation: "files.publishAndDelete",
              targetResourceKind: "files",
              metadata: { fileId },
            }, async (privilegedCtx) => {
              const publicUrl = await privilegedCtx.files.createPublicUrl(fileId, { noExpiry: true });
              const deleted = await privilegedCtx.files.delete(fileId);
              return {
                publicUrlOk: publicUrl.ok,
                publicUrlFileId: publicUrl.data.publicUrl.fileId,
                deleteOk: deleted.ok,
                deletedFileId: deleted.data.file.id,
              };
            }),
        },
      ];

      const result = await runMutation(database, otherAuth, "publishAndDeleteFile", [completed.data.file.id]);

      assert.deepEqual(result, {
        ok: true,
        data: {
          publicUrlOk: true,
          publicUrlFileId: completed.data.file.id,
          deleteOk: true,
          deletedFileId: completed.data.file.id,
        },
        error: null,
      });
      assert.equal((await getPrivateFileUrl(database, ownerAuth, completed.data.file.id)).ok, false);
      assert.deepEqual(
        database.log
          .recent(10)
          .filter((entry) => entry.category === "audit")
          .map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
        [
          ["privileged.started", "files.publishAndDelete", "started"],
          ["privileged.completed", "files.publishAndDelete", "completed"],
          ["privileged.finished", "files.publishAndDelete", "finished"],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("privileged run metadata is validated before audit emission or callback execution", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-validation-island",
    });
    const calls = [];

    try {
      database.queries = [
        {
          name: "missingOperation",
          handler: (ctx) =>
            ctx.privileged.run({}, () => {
              calls.push("missingOperation");
              return { ok: true };
            }),
        },
        {
          name: "promiseMetadata",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.repair",
              targetResourceKind: "capsule-db",
              metadata: Promise.resolve({ shouldNotResolve: true }),
            }, () => {
              calls.push("promiseMetadata");
              return { ok: true };
            }),
        },
        {
          name: "missingCallback",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.repair",
              targetResourceKind: "capsule-db",
            }),
        },
      ];

      const missingOperation = await runQuery(database, { userId: "user-1" }, "missingOperation");
      assert.equal(missingOperation.error?.code, "INVALID_PRIVILEGED_RUN_METADATA");
      assert.match(missingOperation.error?.message ?? "", /operation/i);

      const promiseMetadata = await runQuery(database, { userId: "user-1" }, "promiseMetadata");
      assert.equal(promiseMetadata.error?.code, "INVALID_PRIVILEGED_RUN_METADATA");
      assert.match(promiseMetadata.error?.message ?? "", /metadata/i);

      const missingCallback = await runQuery(database, { userId: "user-1" }, "missingCallback");
      assert.equal(missingCallback.error?.code, "INVALID_PRIVILEGED_RUN_CALLBACK");
      assert.match(missingCallback.error?.message ?? "", /callback/i);

      assert.deepEqual(calls, []);
      assert.deepEqual(database.log.recent(10).filter((entry) => entry.category === "audit"), []);
    } finally {
      database.close();
    }
  });
});

test("throwing and rejecting privileged callbacks emit errored audit boundaries with opaque handler errors", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-error-island",
    });

    try {
      database.queries = [
        {
          name: "throwingPrivilegedRun",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.secretRepair",
              targetResourceKind: "capsule-db",
            }, () => {
              throw Object.assign(new Error("database password leaked"), { code: "SECRET_FAILURE" });
            }),
        },
        {
          name: "rejectingPrivilegedRun",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.secretMutation",
              targetResourceKind: "capsule-db",
            }, async () => {
              throw Object.assign(new Error("private token leaked"), { code: "TOKEN_FAILURE" });
            }),
        },
      ];

      const queryResult = await runQuery(database, { userId: "user-1" }, "throwingPrivilegedRun");
      assert.deepEqual(queryResult, {
        data: null,
        error: {
          code: "PRIVILEGED_RUN_FAILED",
          message: "Privileged run failed.",
          hint: "Check the privileged audit events and server logs before exposing a safe response.",
        },
      });

      const rejectingQueryResult = await runQuery(database, { userId: "user-1" }, "rejectingPrivilegedRun");
      assert.deepEqual(rejectingQueryResult, {
        data: null,
        error: {
          code: "PRIVILEGED_RUN_FAILED",
          message: "Privileged run failed.",
          hint: "Check the privileged audit events and server logs before exposing a safe response.",
        },
      });

      const auditEvents = database.log.recent(20).filter((entry) => entry.category === "audit");
      assert.deepEqual(
        auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
        [
          ["privileged.started", "notes.secretRepair", "started", null],
          ["privileged.errored", "notes.secretRepair", "errored", "SECRET_FAILURE"],
          ["privileged.finished", "notes.secretRepair", "finished", null],
          ["privileged.started", "notes.secretMutation", "started", null],
          ["privileged.errored", "notes.secretMutation", "errored", "TOKEN_FAILURE"],
          ["privileged.finished", "notes.secretMutation", "finished", null],
        ],
      );

      const serializedResults = JSON.stringify([queryResult, rejectingQueryResult]);
      assert.equal(serializedResults.includes("database password leaked"), false);
      assert.equal(serializedResults.includes("private token leaked"), false);
    } finally {
      database.close();
    }
  });
});

test("already-aborted privileged run signals emit audit boundaries without executing the callback", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-aborted-island",
    });
    const calls = [];

    try {
      database.queries = [
        {
          name: "alreadyAbortedPrivilegedRun",
          handler: (ctx) => {
            const controller = new AbortController();
            controller.abort(new Error("client cancellation internals"));
            return ctx.privileged.run({
              operation: "notes.cancelledRepair",
              targetResourceKind: "capsule-db",
              signal: controller.signal,
            }, () => {
              calls.push("callback");
              return { ok: true };
            });
          },
        },
      ];

      const queryResult = await runQuery(database, { userId: "user-1" }, "alreadyAbortedPrivilegedRun");
      assert.deepEqual(queryResult, {
        data: null,
        error: {
          code: "PRIVILEGED_RUN_FAILED",
          message: "Privileged run failed.",
          hint: "Check the privileged audit events and server logs before exposing a safe response.",
        },
      });

      assert.deepEqual(calls, []);
      const auditEvents = database.log.recent(10).filter((entry) => entry.category === "audit");
      assert.deepEqual(
        auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
        [
          ["privileged.started", "notes.cancelledRepair", "started", null],
          ["privileged.errored", "notes.cancelledRepair", "errored", "ABORTED"],
          ["privileged.finished", "notes.cancelledRepair", "finished", null],
        ],
      );
      assert.equal(JSON.stringify(queryResult).includes("client cancellation internals"), false);
    } finally {
      database.close();
    }
  });
});

test("privileged audit emission failures carry private callback context without default response leaks", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-audit-failure-island",
    });
    const originalEmit = database.audit.emit;
    const failures = [];

    database.audit.emit = async (details) => {
      const failure = failures.find((candidate) =>
        candidate.outcome === details.outcome && candidate.operation === details.operation
      );
      if (failure && details.outcome === failure.outcome && details.operation === failure.operation) {
        throw Object.assign(new Error(`audit sink saw ${failure.secret}`), { code: failure.code });
      }
      return originalEmit.call(database.audit, details);
    };

    try {
      database.queries = [
        {
          name: "completedAuditFails",
          handler: async (ctx) => {
            failures.push({
              operation: "notes.completedAudit",
              outcome: "completed",
              code: "COMPLETED_AUDIT_DOWN",
              secret: "returned-secret",
            });
            try {
              await ctx.privileged.run({
                operation: "notes.completedAudit",
                targetResourceKind: "capsule-db",
              }, () => ({ safe: false, token: "returned-secret" }));
            } catch (error) {
              return {
                code: error.code,
                causeCode: error.cause?.code,
                callbackResult: error.privilegedAuditContext?.callbackResult,
              };
            }
            return { missed: true };
          },
        },
        {
          name: "erroredAuditFails",
          handler: async (ctx) => {
            failures.push({
              operation: "notes.erroredAudit",
              outcome: "errored",
              code: "ERRORED_AUDIT_DOWN",
              secret: "thrown-secret",
            });
            try {
              await ctx.privileged.run({
                operation: "notes.erroredAudit",
                targetResourceKind: "capsule-db",
              }, () => {
                throw Object.assign(new Error("thrown-secret"), { code: "CALLBACK_SECRET" });
              });
            } catch (error) {
              return {
                code: error.code,
                causeCode: error.cause?.code,
                callbackErrorCode: error.privilegedAuditContext?.callbackError?.code,
                callbackErrorMessage: error.privilegedAuditContext?.callbackError?.message,
              };
            }
            return { missed: true };
          },
        },
        {
          name: "finishedAuditFails",
          handler: async (ctx) => {
            failures.push({
              operation: "notes.finishedAudit",
              outcome: "finished",
              code: "FINISHED_AUDIT_DOWN",
              secret: "finished-secret",
            });
            try {
              await ctx.privileged.run({
                operation: "notes.finishedAudit",
                targetResourceKind: "capsule-db",
              }, () => ({ id: "result-secret" }));
            } catch (error) {
              return {
                code: error.code,
                causeCode: error.cause?.code,
                callbackResult: error.privilegedAuditContext?.callbackResult,
              };
            }
            return { missed: true };
          },
        },
        {
          name: "defaultAuditFailureResponse",
          handler: (ctx) => {
            failures.push({
              operation: "notes.defaultLeakCheck",
              outcome: "completed",
              code: "DEFAULT_AUDIT_DOWN",
              secret: "default-secret",
            });
            return ctx.privileged.run({
              operation: "notes.defaultLeakCheck",
              targetResourceKind: "capsule-db",
            }, () => ({ token: "default-secret" }));
          },
        },
      ];

      const completedAuditFails = await runQuery(database, { userId: "user-1" }, "completedAuditFails");
      assert.deepEqual(completedAuditFails, {
        data: {
          code: "PRIVILEGED_AUDIT_EMISSION_FAILED",
          causeCode: "COMPLETED_AUDIT_DOWN",
          callbackResult: { safe: false, token: "returned-secret" },
        },
        error: null,
      });

      const erroredAuditFails = await runQuery(database, { userId: "user-1" }, "erroredAuditFails");
      assert.deepEqual(erroredAuditFails, {
        data: {
          code: "PRIVILEGED_AUDIT_EMISSION_FAILED",
          causeCode: "ERRORED_AUDIT_DOWN",
          callbackErrorCode: "CALLBACK_SECRET",
          callbackErrorMessage: "thrown-secret",
        },
        error: null,
      });

      const finishedAuditFails = await runQuery(database, { userId: "user-1" }, "finishedAuditFails");
      assert.deepEqual(finishedAuditFails, {
        data: {
          code: "PRIVILEGED_AUDIT_EMISSION_FAILED",
          causeCode: "FINISHED_AUDIT_DOWN",
          callbackResult: { id: "result-secret" },
        },
        error: null,
      });

      const defaultAuditFailureResponse = await runQuery(database, { userId: "user-1" }, "defaultAuditFailureResponse");
      assert.deepEqual(defaultAuditFailureResponse, {
        data: null,
        error: {
          code: "PRIVILEGED_AUDIT_EMISSION_FAILED",
          message: "Privileged audit emission failed.",
          hint: "Check the server audit log configuration before retrying the privileged operation.",
        },
      });
      assert.equal(JSON.stringify(defaultAuditFailureResponse).includes("default-secret"), false);
    } finally {
      database.close();
    }
  });
});

test("privileged runs are available across trusted server surfaces without leaking through middleware", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-surfaces-island",
      files: { storagePath: path.join(dir, "files") },
    });
    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          allowByDefault: false,
          resolve(operation) {
            return operation === "read"
              ? () => true
              : ({ ctx }) => ctx.auth.userId === "allowed-writer";
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      const fileOwnerAuth = { userId: "file-owner", displayName: "File Owner", isAuthenticated: true, isGuest: false, provider: "email" };
      const pendingFile = await createPendingFileUpload(database, fileOwnerAuth, {
        file: { name: "leak.txt", type: "text/plain", size: 11, path: "/leaks/private.txt" },
      });
      assert.equal(pendingFile.ok, true, pendingFile.error?.message);
      const completedFile = await completePendingFileUpload(
        database,
        pendingFile.data.uploadUrl.split("/").pop(),
        Readable.from([Buffer.from("secret data")]),
      );
      assert.equal(completedFile.ok, true, completedFile.error?.message);

      database.contextMiddleware = [
        async (ctx) => {
          const leaked = await ctx.privileged.run({
            operation: `notes.middleware.${ctx.kind}`,
            targetResourceKind: "capsule-db",
          }, (privilegedCtx) => {
            privilegedCtx.db.notes.insert({ text: `middleware:${ctx.kind}`, ownerId: privilegedCtx.auth.userId });
            return privilegedCtx;
          });
          return {
            ...ctx,
            leakedPrivilegedAuthUserId: leaked.auth.userId,
            leakedPrivilegedContext: leaked,
          };
        },
      ];
      database.queries = [
        {
          name: "surfaceQuery",
          handler: async (ctx) => {
            const normalInsert = await captureErrorCode(() => ctx.db.notes.insert({ text: "query:normal", ownerId: "__privileged__" }));
            const privilegedUserId = await ctx.privileged.run({
              operation: "notes.query",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "query:privileged", ownerId: privilegedCtx.auth.userId });
              return privilegedCtx.auth.userId;
            });
            const leakedInsert = await captureErrorCode(() =>
              ctx.leakedPrivilegedContext.db.notes.insert({ text: "query:leaked", ownerId: "__privileged__" }),
            );
            const leakedFileUrl = await ctx.leakedPrivilegedContext.files.url(completedFile.data.file.id);
            const leakedPublicUrl = await ctx.leakedPrivilegedContext.files.createPublicUrl(completedFile.data.file.id, { noExpiry: true });
            const leakedDelete = await ctx.leakedPrivilegedContext.files.delete(completedFile.data.file.id);
            const fileAfterLeakedOperations = await getPrivateFileUrl(database, fileOwnerAuth, completedFile.data.file.id);
            return {
              kind: ctx.kind,
              normalInsert,
              privilegedUserId,
              leakedInsert,
              leakedPrivilegedAuthUserId: ctx.leakedPrivilegedAuthUserId,
              leakedFileUrl,
              leakedPublicUrl,
              leakedDelete,
              fileStillReadable: fileAfterLeakedOperations.ok,
            };
          },
        },
      ];
      database.mutations = [
        {
          name: "surfaceMutation",
          handler: async (ctx) => {
            const normalInsert = await captureErrorCode(() => ctx.db.notes.insert({ text: "mutation:normal", ownerId: "__privileged__" }));
            const privilegedUserId = await ctx.privileged.run({
              operation: "notes.mutation",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "mutation:privileged", ownerId: privilegedCtx.auth.userId });
              return privilegedCtx.auth.userId;
            });
            return { kind: ctx.kind, normalInsert, privilegedUserId };
          },
        },
      ];
      database.endpoints = [
        {
          options: { method: "GET", path: "/surface" },
          handlerSource: `async (ctx) => {
            const privilegedUserId = await ctx.privileged.run({
              operation: "notes.endpoint",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "endpoint:privileged", ownerId: privilegedCtx.auth.userId });
              return privilegedCtx.auth.userId;
            });
            return { kind: ctx.kind, privilegedUserId, leakedPrivilegedAuthUserId: ctx.leakedPrivilegedAuthUserId };
          }`,
        },
      ];
      database.messages = [
        {
          name: "surfaceMessage",
          handlerSource: `async (ctx) => {
            const privilegedUserId = await ctx.privileged.run({
              operation: "notes.message",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "message:privileged", ownerId: privilegedCtx.auth.userId });
              return privilegedCtx.auth.userId;
            });
            return { kind: ctx.kind, privilegedUserId, leakedPrivilegedAuthUserId: ctx.leakedPrivilegedAuthUserId };
          }`,
        },
      ];
      database.mutationHooks = {
        beforeMutation: [
          async ({ ctx }) => {
            await ctx.privileged.run({
              operation: "notes.beforeMutation",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "hook:before", ownerId: privilegedCtx.auth.userId });
            });
          },
        ],
        afterMutation: [
          async ({ ctx }) => {
            await ctx.privileged.run({
              operation: "notes.afterMutation",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: "hook:after", ownerId: privilegedCtx.auth.userId });
            });
          },
        ],
      };

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "surfaceQuery"), {
        data: {
          kind: "query",
          normalInsert: "DENIED",
          privilegedUserId: "__privileged__",
          leakedInsert: "DENIED",
          leakedPrivilegedAuthUserId: "__privileged__",
          leakedFileUrl: {
            ok: false,
            error: {
              message: "Privileged file access is no longer active.",
              hint: "Start a new ctx.privileged.run callback before using privileged file operations.",
            },
          },
          leakedPublicUrl: {
            ok: false,
            error: {
              message: "Privileged file access is no longer active.",
              hint: "Start a new ctx.privileged.run callback before using privileged file operations.",
            },
          },
          leakedDelete: {
            ok: false,
            error: {
              message: "Privileged file access is no longer active.",
              hint: "Start a new ctx.privileged.run callback before using privileged file operations.",
            },
          },
          fileStillReadable: true,
        },
        error: null,
      });
      assert.deepEqual(await runMutation(database, { userId: "user-1" }, "surfaceMutation", []), {
        ok: true,
        data: {
          kind: "mutation",
          normalInsert: "DENIED",
          privilegedUserId: "__privileged__",
        },
        error: null,
      });
      assert.deepEqual(
        await runEndpoint(
          database,
          database.endpoints[0],
          new URL("http://localhost/surface"),
          Object.assign(Readable.from([]), { method: "GET", headers: {} }),
        ),
        {
          kind: "endpoint",
          privilegedUserId: "__privileged__",
          leakedPrivilegedAuthUserId: "__privileged__",
        },
      );
      assert.deepEqual(await runAppMessage(database, { userId: "user-1" }, "surfaceMessage", null), {
        data: {
          kind: "message",
          privilegedUserId: "__privileged__",
          leakedPrivilegedAuthUserId: "__privileged__",
        },
        error: null,
      });

      const rows = await database.sqlite.selectAppRows(table, { columns: ["text", "ownerId"], orderBy: { fieldName: "createdAt", direction: "asc" } });
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          { text: "middleware:query", ownerId: "__privileged__" },
          { text: "query:privileged", ownerId: "__privileged__" },
          { text: "middleware:mutation", ownerId: "__privileged__" },
          { text: "hook:before", ownerId: "__privileged__" },
          { text: "mutation:privileged", ownerId: "__privileged__" },
          { text: "hook:after", ownerId: "__privileged__" },
          { text: "middleware:endpoint", ownerId: "__privileged__" },
          { text: "endpoint:privileged", ownerId: "__privileged__" },
          { text: "middleware:message", ownerId: "__privileged__" },
          { text: "message:privileged", ownerId: "__privileged__" },
        ],
      );

      const auditOperations = database.log.recent(100)
        .filter((entry) => entry.category === "audit" && entry.event === "privileged.completed")
        .map((entry) => [entry.data.operation, entry.data.surface]);
      assert.deepEqual(auditOperations, [
        ["notes.middleware.query", "query"],
        ["notes.query", "query"],
        ["notes.middleware.mutation", "mutation"],
        ["notes.beforeMutation", "mutation"],
        ["notes.mutation", "mutation"],
        ["notes.afterMutation", "mutation"],
        ["notes.middleware.endpoint", "endpoint"],
        ["notes.endpoint", "endpoint"],
        ["notes.middleware.message", "message"],
        ["notes.message", "message"],
      ]);
    } finally {
      database.close();
    }
  });
});

test("supported lifecycle hooks emit privileged audit events for each actual hook execution", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-lifecycle-hooks-island",
    });

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
        acl: {
          resolve(operation) {
            return ["insert", "read"].includes(operation) ? () => false : null;
          },
        },
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.mutations = [
        {
          name: "writeNormalNote",
          handler: () => ({ ok: true }),
        },
      ];
      database.mutationHooks = {
        beforeMutation: [
          async ({ ctx, args }) => {
            await ctx.privileged.run({
              operation: "notes.lifecycle.beforeMutation",
              targetResourceKind: "capsule-db",
              metadata: { runId: args[0] },
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: `before:${args[0]}`, ownerId: privilegedCtx.auth.userId });
            });
          },
        ],
        afterMutation: [
          async ({ ctx, args }) => {
            await ctx.privileged.run({
              operation: "notes.lifecycle.afterMutation",
              targetResourceKind: "capsule-db",
              metadata: { runId: args[0] },
            }, (privilegedCtx) => {
              privilegedCtx.db.notes.insert({ text: `after:${args[0]}`, ownerId: privilegedCtx.auth.userId });
            });
          },
        ],
      };

      assert.deepEqual(await runMutation(database, { userId: "user-1" }, "writeNormalNote", ["first"]), {
        ok: true,
        data: { ok: true },
        error: null,
      });
      assert.deepEqual(await runMutation(database, { userId: "user-1" }, "writeNormalNote", ["second"]), {
        ok: true,
        data: { ok: true },
        error: null,
      });

      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, { columns: ["text", "ownerId"], orderBy: { fieldName: "createdAt", direction: "asc" } })
          .map((row) => ({ ...row })),
        [
          { text: "before:first", ownerId: "__privileged__" },
          { text: "after:first", ownerId: "__privileged__" },
          { text: "before:second", ownerId: "__privileged__" },
          { text: "after:second", ownerId: "__privileged__" },
        ],
      );
      assert.deepEqual(
        database.log.recent(30)
          .filter((entry) => entry.category === "audit" && entry.event === "privileged.completed")
          .map((entry) => [entry.data.operation, entry.data.surface, entry.data.metadata.runId]),
        [
          ["notes.lifecycle.beforeMutation", "mutation", "first"],
          ["notes.lifecycle.afterMutation", "mutation", "first"],
          ["notes.lifecycle.beforeMutation", "mutation", "second"],
          ["notes.lifecycle.afterMutation", "mutation", "second"],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("started audit failures and nested privileged runs do not execute protected callbacks", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-guard-island",
    });
    const originalEmit = database.audit.emit;
    const calls = [];

    database.audit.emit = async (details) => {
      if (details.operation === "notes.startedFails" && details.outcome === "started") {
        throw Object.assign(new Error("audit start secret"), { code: "START_AUDIT_DOWN" });
      }
      return originalEmit.call(database.audit, details);
    };

    try {
      database.queries = [
        {
          name: "startedAuditFails",
          handler: (ctx) =>
            ctx.privileged.run({
              operation: "notes.startedFails",
              targetResourceKind: "capsule-db",
            }, () => {
              calls.push("started-callback");
              return { ok: true };
            }),
        },
        {
          name: "nestedPrivilegedRun",
          handler: async (ctx) =>
            ctx.privileged.run({
              operation: "notes.outerRun",
              targetResourceKind: "capsule-db",
            }, async (privilegedCtx) => {
              try {
                await privilegedCtx.privileged.run({
                  operation: "notes.innerRun",
                  targetResourceKind: "capsule-db",
                }, () => {
                  calls.push("inner-callback");
                  return { ok: true };
                });
              } catch (error) {
                return { code: error.code, message: error.message };
              }
              return { missed: true };
            }),
        },
      ];

      const startedAuditFails = await runQuery(database, { userId: "user-1" }, "startedAuditFails");
      assert.deepEqual(startedAuditFails, {
        data: null,
        error: {
          code: "PRIVILEGED_AUDIT_EMISSION_FAILED",
          message: "Privileged audit emission failed.",
          hint: "Check the server audit log configuration before retrying the privileged operation.",
        },
      });
      assert.deepEqual(calls, []);

      const nestedPrivilegedRun = await runQuery(database, { userId: "user-1" }, "nestedPrivilegedRun");
      assert.deepEqual(nestedPrivilegedRun, {
        data: {
          code: "NESTED_PRIVILEGED_RUN",
          message: "Nested privileged runs are not supported.",
        },
        error: null,
      });
      assert.deepEqual(calls, []);

      const auditEvents = database.log.recent(20).filter((entry) => entry.category === "audit");
      assert.deepEqual(
        auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
        [
          ["privileged.started", "notes.outerRun", "started", null],
          ["privileged.completed", "notes.outerRun", "completed", null],
          ["privileged.finished", "notes.outerRun", "finished", null],
        ],
      );
      assert.equal(JSON.stringify(startedAuditFails).includes("audit start secret"), false);
    } finally {
      database.close();
    }
  });
});

test("privileged run signals are propagated, fresh by default, and cooperative during callback execution", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: "privileged-run-signal-island",
    });
    const observedDefaultSignals = [];

    try {
      database.queries = [
        {
          name: "suppliedSignal",
          handler: (ctx) => {
            const controller = new AbortController();
            return ctx.privileged.run({
              operation: "notes.suppliedSignal",
              targetResourceKind: "capsule-db",
              signal: controller.signal,
            }, (privilegedCtx) => ({
              sameSignal: privilegedCtx.signal === controller.signal,
              initiallyAborted: privilegedCtx.signal.aborted,
            }));
          },
        },
        {
          name: "defaultSignals",
          handler: async (ctx) => {
            const first = await ctx.privileged.run({
              operation: "notes.defaultSignalOne",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              observedDefaultSignals.push(privilegedCtx.signal);
              return {
                aborted: privilegedCtx.signal.aborted,
                hasAbortApi: typeof privilegedCtx.signal.addEventListener === "function",
              };
            });
            const second = await ctx.privileged.run({
              operation: "notes.defaultSignalTwo",
              targetResourceKind: "capsule-db",
            }, (privilegedCtx) => {
              observedDefaultSignals.push(privilegedCtx.signal);
              return {
                aborted: privilegedCtx.signal.aborted,
                hasAbortApi: typeof privilegedCtx.signal.addEventListener === "function",
              };
            });
            return {
              first,
              second,
              freshSignals: observedDefaultSignals[0] !== observedDefaultSignals[1],
            };
          },
        },
        {
          name: "abortDuringCallbackReturns",
          handler: (ctx) => {
            const controller = new AbortController();
            return ctx.privileged.run({
              operation: "notes.midRunReturn",
              targetResourceKind: "capsule-db",
              signal: controller.signal,
            }, (privilegedCtx) => {
              controller.abort(new Error("mid-run cancellation internals"));
              return {
                abortedInsideCallback: privilegedCtx.signal.aborted,
                returnedAfterAbort: true,
              };
            });
          },
        },
        {
          name: "abortDuringCallbackThrows",
          handler: async (ctx) => {
            const controller = new AbortController();
            try {
              await ctx.privileged.run({
                operation: "notes.midRunThrow",
                targetResourceKind: "capsule-db",
                signal: controller.signal,
              }, () => {
                controller.abort(new Error("mid-run throw cancellation internals"));
                throw Object.assign(new Error("callback decides failure"), { code: "CALLBACK_DECIDED" });
              });
            } catch (error) {
              return { code: error.code, causeCode: error.cause?.code };
            }
            return { missed: true };
          },
        },
      ];

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "suppliedSignal"), {
        data: {
          sameSignal: true,
          initiallyAborted: false,
        },
        error: null,
      });

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "defaultSignals"), {
        data: {
          first: { aborted: false, hasAbortApi: true },
          second: { aborted: false, hasAbortApi: true },
          freshSignals: true,
        },
        error: null,
      });

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "abortDuringCallbackReturns"), {
        data: {
          abortedInsideCallback: true,
          returnedAfterAbort: true,
        },
        error: null,
      });

      assert.deepEqual(await runQuery(database, { userId: "user-1" }, "abortDuringCallbackThrows"), {
        data: {
          code: "PRIVILEGED_RUN_FAILED",
          causeCode: "CALLBACK_DECIDED",
        },
        error: null,
      });

      const midRunAuditEvents = database.log.recent(30)
        .filter((entry) => entry.category === "audit" && entry.data.operation.startsWith("notes.midRun"));
      assert.deepEqual(
        midRunAuditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
        [
          ["privileged.started", "notes.midRunReturn", "started", null],
          ["privileged.completed", "notes.midRunReturn", "completed", null],
          ["privileged.finished", "notes.midRunReturn", "finished", null],
          ["privileged.started", "notes.midRunThrow", "started", null],
          ["privileged.errored", "notes.midRunThrow", "errored", "CALLBACK_DECIDED"],
          ["privileged.finished", "notes.midRunThrow", "finished", null],
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("SQLite database adapter owns transactions for successful and failing mutations", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    try {
      const table = {
        name: "todos",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      database.mutations = [
        {
          name: "addThenFail",
          handler: (ctx) => {
            ctx.db.todos.insert({ text: "rolled back", ownerId: ctx.auth.userId });
            throw new Error("nope");
          },
        },
      ];
      database.mutationHooks = { beforeMutation: [], afterMutation: [] };
      database.sqlite.migrateAppSchema(database.schema);

      const committed = await runMutation(database, { userId: "user-1" }, "addTodo", ["committed"]);
      assert.equal(committed.ok, true);
      assert.equal(database.sqlite.selectAppRows(table).length, 1);

      const failed = await runMutation(database, { userId: "user-1" }, "addThenFail", []);
      assert.deepEqual(failed, {
        ok: false,
        error: {
          message: "nope",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });
      assert.deepEqual(
        database.sqlite
          .selectAppRows(table, { columns: ["text"], orderBy: { fieldName: "createdAt", direction: "asc" } })
          .map((row) => ({ ...row })),
        [{ text: "committed" }],
      );
    } finally {
      database.close();
    }
  });
});

test("SQLite database adapter owns inspection and health surfaces", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      files: { storagePath: path.join(dir, "files") },
    });
    try {
      const table = {
        name: "todos",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      database.sqlite.migrateAppSchema(database.schema);
      database.sqlite.insertAppRow(table, {
        id: "todo-1",
        createdAt: "2026-07-04T10:00:00.000Z",
        updatedAt: "2026-07-04T10:00:00.000Z",
        text: "inspect me",
        ownerId: "user-1",
      });

      assert.equal(typeof database.sqlite.listInspectableTables, "function");
      assert.equal(typeof database.sqlite.dumpInspectableDatabase, "function");
      assert.equal(typeof database.sqlite.runReadOnlyInspectionQuery, "function");
      assert.equal(typeof database.sqlite.checkHealth, "function");
      assert.equal(database.adapter, database.sqlite);
      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "todos"), ["todos"]);
      const dumpedTodos = (await dumpDatabase(database)).find((dumpedTable) => dumpedTable.name === "todos");
      assert.deepEqual({ ...dumpedTodos, rows: dumpedTodos.rows.map((row) => ({ ...row })) }, {
        name: "todos",
        columns: ["id", "createdAt", "updatedAt", "text", "ownerId"],
        rows: [
          {
            id: "todo-1",
            createdAt: "2026-07-04T10:00:00.000Z",
            updatedAt: "2026-07-04T10:00:00.000Z",
            text: "inspect me",
            ownerId: "user-1",
          },
        ],
      });
      const queryResult = await runReadOnlyQuery(database, "SELECT text FROM todos");
      assert.deepEqual(
        {
          ...queryResult,
          data: {
            ...queryResult.data,
            rows: queryResult.data.rows.map((row) => ({ ...row })),
          },
        },
        {
          ok: true,
          data: {
            columns: ["text"],
            rows: [{ text: "inspect me" }],
          },
          error: null,
        },
      );
      assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
    } finally {
      database.close();
    }
  });
});

test("runtime database paths await promise-returning adapter operations", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
      files: { storagePath: path.join(dir, "files") },
    });
    const syncAdapter = database.sqlite;
    const asyncAdapter = wrapAsyncRuntimeAdapter(syncAdapter);
    database.adapter = asyncAdapter;
    database.sqlite = asyncAdapter;
    database.close = () => syncAdapter.close();

    try {
      const table = {
        name: "notes",
        fields: [
          { name: "text", kind: "String", sqliteType: "TEXT" },
          { name: "ownerId", kind: "String", sqliteType: "TEXT" },
        ],
      };
      database.schema = { tables: [table] };
      await database.sqlite.migrateAppSchema(database.schema);

      const auth = { userId: "user-1", displayName: "Ada", isAuthenticated: false, isGuest: true, provider: "anonymous" };
      const inserted = await runMutation(database, auth, "addNote", ["await me"]);
      assert.equal(inserted.ok, true);
      assert.deepEqual(
        (await database.sqlite.selectAppRows(table, { columns: ["text"] })).map((row) => ({ ...row })),
        [{ text: "await me" }],
      );

      const emptyAuth = { userId: "user-empty", displayName: "Empty", isAuthenticated: false, isGuest: true, provider: "anonymous" };
      assert.deepEqual(await runQuery(database, emptyAuth, "notes"), { rows: [], error: null });

      database.mutations = [
        {
          name: "addAsyncNote",
          handler: (ctx) => {
            ctx.db.notes.insert({ text: "visible after async write", ownerId: ctx.auth.userId });
          },
        },
        {
          name: "addThenFail",
          handler: (ctx) => {
            ctx.db.notes.insert({ text: "rolled back", ownerId: ctx.auth.userId });
            throw new Error("rollback me");
          },
        },
      ];
      const customInserted = await runMutation(database, emptyAuth, "addAsyncNote", []);
      assert.equal(customInserted.ok, true);
      const refreshedQuery = await runQuery(database, emptyAuth, "notes");
      assert.equal(refreshedQuery.error, null);
      assert.deepEqual(refreshedQuery.rows.map((row) => ({ text: row.text, ownerId: row.ownerId })), [
        { text: "visible after async write", ownerId: "user-empty" },
      ]);

      const failed = await runMutation(database, auth, "addThenFail", []);
      assert.equal(failed.ok, false);
      assert.deepEqual(
        (
          await database.sqlite.selectAppRows(table, {
            columns: ["text"],
            where: { fieldName: "ownerId", value: auth.userId },
            orderBy: { fieldName: "createdAt", direction: "asc" },
          })
        ).map((row) => ({ ...row })),
        [{ text: "await me" }],
      );

      const originalUpdateAppRow = asyncAdapter.updateAppRow.bind(asyncAdapter);
      let asyncUpdateSettled = false;
      asyncAdapter.updateAppRow = async (...args) => {
        if (args[1] === "missing-note") {
          await Promise.resolve();
          asyncUpdateSettled = true;
          throw new Error("async update exploded");
        }
        return await originalUpdateAppRow(...args);
      };
      const failedMissingUpdate = await runMutation(database, auth, "updateNoteText", ["missing-note", "should fail"]);
      assert.equal(asyncUpdateSettled, true);
      assert.deepEqual(failedMissingUpdate, {
        ok: false,
        error: {
          message: "async update exploded",
          hint: "Check the Capsule mutation hooks and retry the mutation.",
        },
      });

      const session = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, session, "email", {
        email: "ada@example.com",
        password: "correct horse",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      const upload = await createPendingFileUpload(database, signUp.auth, {
        file: { name: "proof.txt", type: "text/plain", size: 5 },
      });
      assert.equal(upload.ok, true);

      await database.log.emit({ category: "app", event: "ctx.log", level: "info", message: "async log" });
      assert.deepEqual(
        (await database.log.recent(1)).map((event) => event.message),
        ["async log"],
      );

      assert.deepEqual((await listDatabaseTables(database)).filter((name) => name === "notes"), ["notes"]);
      assert.equal((await dumpDatabase(database)).find((dumpedTable) => dumpedTable.name === "notes").rows.length, 2);
      assert.deepEqual(
        (await runReadOnlyQuery(database, "SELECT text FROM notes ORDER BY text")).data.rows.map((row) => ({ ...row })),
        [{ text: "await me" }, { text: "visible after async write" }],
      );
      assert.deepEqual(await checkRuntimeSqlite(database), { ok: true });
    } finally {
      database.close();
    }
  });
});

test("anonymous session creation rolls back the auth user when session insertion fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true } },
    });
    const baseAdapter = database.sqlite;
    database.sqlite = failRuntimeWriteAfter(baseAdapter, "insertAuthSession", new Error("insert session exploded"));
    database.adapter = database.sqlite;
    database.close = () => baseAdapter.close();

    try {
      await assert.rejects(() => resolveAnonymousSession(database, null), /insert session exploded/);
      assert.equal(
        baseAdapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users").get().count,
        0,
      );
      assert.equal(
        baseAdapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions").get().count,
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("runtime auth storage rejects the privileged sentinel as a real user", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      assert.throws(
        () =>
          database.sqlite.insertAuthUser({
            id: "__privileged__",
            createdAt: new Date().toISOString(),
            displayName: "Pretend Privileged",
            email: "privileged@example.com",
            picture: null,
            isAuthenticated: 1,
            isGuest: 0,
            provider: "email",
          }),
        /reserved/i,
      );
      assert.equal(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users WHERE id = ?").get("__privileged__").count,
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("sessions and local identity simulation cannot resolve the privileged sentinel as a user", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const now = new Date().toISOString();
      database.sqlite.prepare(
        "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("__privileged__", now, "Forged Privileged", "privileged@example.com", null, 1, 0, "email");
      database.sqlite.prepare(
        "INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
      ).run("forged-token", "__privileged__", "email", now, new Date(Date.parse(now) + 60_000).toISOString());

      const resolved = await resolveAnonymousSession(database, "forged-token");
      assert.notEqual(resolved.auth.userId, "__privileged__");
      assert.equal(resolved.auth.provider, "anonymous");

      const simulated = await simulateLocalIdentitySession(database, {
        provider: "email",
        email: "local@example.com",
        displayName: "Local User",
        userId: "__privileged__",
      });
      assert.equal(simulated.ok, true);
      assert.notEqual(simulated.data.auth.userId, "__privileged__");
      assert.equal(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_users WHERE id = ?").get("__privileged__").count,
        1,
      );
      assert.equal(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_sessions WHERE userId = ?").get("__privileged__").count,
        1,
      );
    } finally {
      database.close();
    }
  });
});

test("email sign-up rolls back credentials and linked auth state when linking fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });
    const baseAdapter = database.sqlite;

    try {
      const session = await resolveAnonymousSession(database, null);
      database.sqlite = failRuntimeWriteAfter(baseAdapter, "linkAuthUser", new Error("link user exploded"));
      database.adapter = database.sqlite;

      await assert.rejects(
        () =>
          signUpWithEmail(database, session, "email", {
            email: "ada@example.com",
            password: "correct horse battery staple",
            name: "Ada",
          }),
        /link user exploded/,
      );

      assert.equal(baseAdapter.emailCredentialExists("ada@example.com"), false);
      const preservedSession = baseAdapter.readAuthSessionWithUser(session.token);
      assert.equal(preservedSession.provider, "anonymous");
      assert.equal(preservedSession.isGuest, 1);
    } finally {
      database.close();
    }
  });
});

test("failed email sign-in rotation keeps the old Anonymous session token valid", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });
    const baseAdapter = database.sqlite;

    try {
      const signUpSession = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, signUpSession, "email", {
        email: "ada@example.com",
        password: "correct horse battery staple",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      const anonymousSession = await resolveAnonymousSession(database, null);
      database.sqlite = failRuntimeWriteAfter(baseAdapter, "rotateAuthSession", new Error("rotate session exploded"));
      database.adapter = database.sqlite;

      await assert.rejects(
        () =>
          signInWithEmail(database, anonymousSession, {
            email: "ada@example.com",
            password: "correct horse battery staple",
          }),
        /rotate session exploded/,
      );

      const preservedSession = baseAdapter.readAuthSessionWithUser(anonymousSession.token);
      assert.equal(preservedSession.provider, "anonymous");
      assert.equal(preservedSession.userId, anonymousSession.auth.userId);
    } finally {
      database.close();
    }
  });
});

test("email sign-in throttles repeated failed attempts for the same email and caller context", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const signUpSession = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, signUpSession, "email", {
        email: "ada@example.com",
        password: "correct horse battery staple",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      const callerSession = await resolveAnonymousSession(database, null);
      const credentials = { email: "ada@example.com", password: "wrong password" };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await signInWithEmail(database, callerSession, credentials);
        assert.equal(result.ok, false);
        assert.equal(result.error.message, "Email or password is incorrect.");
      }

      const throttled = await signInWithEmail(database, callerSession, credentials);
      assert.equal(throttled.ok, false);
      assert.equal(throttled.error.message, "Email or password is incorrect.");
      assert.equal(throttled.error.code, "INVALID_EMAIL_CREDENTIALS");
    } finally {
      database.close();
    }
  });
});

test("email sign-in throttling cannot be bypassed by rotating Anonymous sessions for the same email", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const signUpSession = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, signUpSession, "email", {
        email: "ada@example.com",
        password: "correct horse battery staple",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const rotatingSession = await resolveAnonymousSession(database, null);
        const result = await signInWithEmail(database, rotatingSession, {
          email: "ada@example.com",
          password: "wrong password",
        });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, undefined);
      }

      const freshSession = await resolveAnonymousSession(database, null);
      const throttled = await signInWithEmail(database, freshSession, {
        email: "ada@example.com",
        password: "correct horse battery staple",
      });
      assert.equal(throttled.ok, false);
      assert.equal(throttled.error.message, "Email or password is incorrect.");
      assert.equal(throttled.error.code, "INVALID_EMAIL_CREDENTIALS");
    } finally {
      database.close();
    }
  });
});

test("email sign-in throttling protects caller context and resets after successful non-abusive sign-in", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const emails = ["ada", "grace", "mira", "lin", "sara"].map((name) => `${name}@example.com`);
      const signUps = [];
      for (const email of emails) {
        const signUpSession = await resolveAnonymousSession(database, null);
        const signUp = await signUpWithEmail(database, signUpSession, "email", {
          email,
          password: "correct horse battery staple",
          name: email.split("@")[0],
        });
        assert.equal(signUp.ok, true);
        signUps.push(signUp);
      }
      const recoveryEmail = "recovery@example.com";
      const recoverySignUpSession = await resolveAnonymousSession(database, null);
      const recoverySignUp = await signUpWithEmail(database, recoverySignUpSession, "email", {
        email: recoveryEmail,
        password: "correct horse battery staple",
        name: "Recovery",
      });
      assert.equal(recoverySignUp.ok, true);

      const abusiveSession = await resolveAnonymousSession(database, null);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await signInWithEmail(database, abusiveSession, {
          email: emails[attempt],
          password: "wrong password",
        });
        assert.equal(result.ok, false);
      }
      const abusiveThrottled = await signInWithEmail(database, abusiveSession, {
        email: emails[0],
        password: "correct horse battery staple",
      });
      assert.equal(abusiveThrottled.ok, false);
      assert.equal(abusiveThrottled.error.message, "Email or password is incorrect.");

      const normalSession = await resolveAnonymousSession(database, null);
      const normalSignIn = await signInWithEmail(database, normalSession, {
        email: emails[0],
        password: "correct horse battery staple",
      });
      assert.equal(normalSignIn.ok, true);
      assert.equal(normalSignIn.auth.userId, signUps[0].auth.userId);

      const recoveringSession = await resolveAnonymousSession(database, null);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await signInWithEmail(database, recoveringSession, {
          email: recoveryEmail,
          password: "wrong password",
        });
        assert.equal(result.ok, false);
      }
      const recovered = await signInWithEmail(database, recoveringSession, {
        email: recoveryEmail,
        password: "correct horse battery staple",
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.auth.userId, recoverySignUp.auth.userId);
      const recoveredSession = await resolveAnonymousSession(database, recovered.sessionToken);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await signInWithEmail(database, recoveredSession, {
          email: recoveryEmail,
          password: "wrong again",
        });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, undefined);
      }
      const throttledAgain = await signInWithEmail(database, recoveredSession, {
        email: recoveryEmail,
        password: "wrong again",
      });
      assert.equal(throttledAgain.error.code, "INVALID_EMAIL_CREDENTIALS");
    } finally {
      database.close();
    }
  });
});

test("email sign-in throttling prunes expired attempts and bounds stale state", async () => {
  await withTempDir(async (dir) => {
    const originalNow = Date.now;
    let now = Date.parse("2026-07-09T12:00:00.000Z");
    Date.now = () => now;
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const rotatingSession = await resolveAnonymousSession(database, null);
        const result = await signInWithEmail(database, rotatingSession, {
          email: `attacker-${attempt}@example.com`,
          password: "wrong password",
        });
        assert.equal(result.ok, false);
      }
      assert(database.__emailSignInThrottle.size <= 256);

      now += 15 * 60 * 1000 + 1;
      const afterCooldownSession = await resolveAnonymousSession(database, null);
      await signInWithEmail(database, afterCooldownSession, {
        email: "after-cooldown@example.com",
        password: "wrong password",
      });
      assert(database.__emailSignInThrottle.size <= 2);
    } finally {
      Date.now = originalNow;
      database.close();
    }
  });
});

test("email sign-in throttling preserves a throttled account bucket under filler pressure", async () => {
  await withTempDir(async (dir) => {
    const originalNow = Date.now;
    let now = Date.parse("2026-07-09T12:00:00.000Z");
    Date.now = () => now;
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const signUpSession = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, signUpSession, "email", {
        email: "target@example.com",
        password: "correct horse battery staple",
        name: "Target",
      });
      assert.equal(signUp.ok, true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const rotatingSession = await resolveAnonymousSession(database, null);
        const result = await signInWithEmail(database, rotatingSession, {
          email: "target@example.com",
          password: "wrong password",
        });
        assert.equal(result.ok, false);
      }
      assert.equal(database.__emailSignInThrottle.get("email\0target@example.com").count, 5);

      now += 60 * 1000;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const fillerSession = await resolveAnonymousSession(database, null);
        const result = await signInWithEmail(database, fillerSession, {
          email: `filler-${attempt}@example.com`,
          password: "wrong password",
        });
        assert.equal(result.ok, false);
      }
      assert(database.__emailSignInThrottle.size <= 256);
      assert.equal(database.__emailSignInThrottle.get("email\0target@example.com").count, 5);

      const freshSession = await resolveAnonymousSession(database, null);
      const throttled = await signInWithEmail(database, freshSession, {
        email: "target@example.com",
        password: "correct horse battery staple",
      });
      assert.equal(throttled.ok, false);
      assert.equal(throttled.error.code, "INVALID_EMAIL_CREDENTIALS");
    } finally {
      Date.now = originalNow;
      database.close();
    }
  });
});

test("email sign-in throttling allows attempts again after the cooldown window", async () => {
  await withTempDir(async (dir) => {
    const originalNow = Date.now;
    let now = Date.parse("2026-07-09T12:00:00.000Z");
    Date.now = () => now;
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });

    try {
      const signUpSession = await resolveAnonymousSession(database, null);
      const signUp = await signUpWithEmail(database, signUpSession, "email", {
        email: "ada@example.com",
        password: "correct horse battery staple",
        name: "Ada",
      });
      assert.equal(signUp.ok, true);

      const callerSession = await resolveAnonymousSession(database, null);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await signInWithEmail(database, callerSession, {
          email: "ada@example.com",
          password: "wrong password",
        });
      }
      const throttled = await signInWithEmail(database, callerSession, {
        email: "ada@example.com",
        password: "wrong password",
      });
      assert.equal(throttled.error.code, "INVALID_EMAIL_CREDENTIALS");

      now += 15 * 60 * 1000 + 1;
      const afterCooldown = await signInWithEmail(database, callerSession, {
        email: "ada@example.com",
        password: "wrong password",
      });
      assert.equal(afterCooldown.ok, false);
      assert.equal(afterCooldown.error.message, "Email or password is incorrect.");
      assert.equal(afterCooldown.error.code, undefined);
    } finally {
      Date.now = originalNow;
      database.close();
    }
  });
});

test("OAuth provider linking rolls back auth state when session refresh fails", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch;
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
      {
        auth: {
          providers: {
            anonymous: true,
            google: {
              enabled: true,
              clientIdEnv: "GOOGLE_CLIENT_ID",
              clientSecretEnv: "GOOGLE_CLIENT_SECRET",
            },
          },
        },
      },
    );
    const baseAdapter = database.sqlite;

    try {
      const session = await resolveAnonymousSession(database, null);
      await baseAdapter.insertOAuthState({
        state: "link-state",
        sessionToken: session.token,
        returnTo: "http://127.0.0.1/app",
        redirectUri: "http://127.0.0.1/__sporades/auth/google/callback",
        createdAt: new Date().toISOString(),
      });
      globalThis.fetch = async (url) => {
        if (String(url).includes("token")) {
          return new Response(JSON.stringify({ access_token: "access-token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            sub: "google-subject-ada",
            email: "ada@example.com",
            name: "Ada",
            picture: "https://example.com/ada.png",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      database.sqlite = failRuntimeWriteAfter(baseAdapter, "refreshAuthSession", new Error("refresh session exploded"));
      database.adapter = database.sqlite;

      const response = createResponseRecorder();
      await routeSporadesAuth(
        database,
        { method: "GET", url: "/__sporades/auth/google/callback?state=link-state&code=good-code" },
        response,
      );

      assert.equal(response.statusCode, 500);
      const preservedSession = baseAdapter.readAuthSessionWithUser(session.token);
      assert.equal(preservedSession.provider, "anonymous");
      assert.equal(preservedSession.isGuest, 1);
      assert.equal(baseAdapter.findAuthUserByProviderEmail("google", "ada@example.com"), null);
      assert.equal(baseAdapter.findAuthIdentityByProviderSubject("google", "google-subject-ada"), null);
      assert.equal(baseAdapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get("link-state"), undefined);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
});

test("Provider identities use stable subjects and Sessions retain their own authentication provenance", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true }, google: { enabled: true } } },
    });

    try {
      const firstSession = await resolveAnonymousSession(database, null);
      await updateCurrentUserPreferences(database, firstSession.auth, { theme: "dark", density: "comfortable" });
      const first = await linkGoogleAccount(database, firstSession, {
        subject: "google-subject-1",
        email: null,
        displayName: "Ada",
        picture: null,
      });
      assert.equal(first.ok, true);
      assert.equal(first.auth.userId, firstSession.auth.userId);
      assert.equal(database.sqlite.readAuthSessionWithUser(firstSession.token).provider, "google");

      const secondSession = await resolveAnonymousSession(database, null);
      await updateCurrentUserPreferences(database, secondSession.auth, { density: "compact", locale: "en-GB" });
      const second = await linkGoogleAccount(database, secondSession, {
        subject: "google-subject-1",
        email: "ada.changed@example.com",
        displayName: "Ada Changed",
        picture: "https://example.com/ada.png",
      });
      assert.equal(second.ok, true);
      assert.equal(second.auth.userId, first.auth.userId);
      assert.equal(database.sqlite.readAuthSessionWithUser(secondSession.token).provider, "google");
      assert.deepEqual(JSON.parse(database.sqlite.readUserPreferences(first.auth.userId).value), {
        theme: "dark",
        density: "compact",
        locale: "en-GB",
      });

      const identity = database.sqlite.findAuthIdentityByProviderSubject("google", "google-subject-1");
      assert.deepEqual(
        {
          userId: identity.userId,
          email: identity.email,
          displayName: identity.displayName,
          picture: identity.picture,
        },
        {
          userId: first.auth.userId,
          email: "ada.changed@example.com",
          displayName: "Ada Changed",
          picture: "https://example.com/ada.png",
        },
      );

      const emailSession = await resolveAnonymousSession(database, null);
      const email = await signUpWithEmail(database, emailSession, "email", {
        email: "grace@example.com",
        password: "correct horse battery staple",
        name: "Grace",
      });
      assert.equal(email.ok, true);
      assert.equal(database.sqlite.readAuthSessionWithUser(email.sessionToken).provider, "email");

      const secondEmailAnonymous = await resolveAnonymousSession(database, null);
      const secondEmail = await signInWithEmail(database, secondEmailAnonymous, {
        email: "grace@example.com",
        password: "correct horse battery staple",
      });
      const secondEmailSession = await resolveAnonymousSession(database, secondEmail.sessionToken);
      const linkedSecondProvider = await linkGoogleAccount(database, secondEmailSession, {
        subject: "google-subject-grace",
        email: "grace.google@example.com",
        displayName: "Grace via Google",
        picture: null,
      });
      assert.equal(linkedSecondProvider.ok, true);
      assert.equal(linkedSecondProvider.auth.userId, email.auth.userId);
      assert.equal(database.sqlite.readAuthSessionWithUser(secondEmail.sessionToken).provider, "google");
      assert.equal(database.sqlite.readAuthSessionWithUser(email.sessionToken).provider, "email");

      const thirdEmailAnonymous = await resolveAnonymousSession(database, null);
      const thirdEmail = await signInWithEmail(database, thirdEmailAnonymous, {
        email: "grace@example.com",
        password: "correct horse battery staple",
      });
      assert.equal(thirdEmail.auth.provider, "email");
      assert.equal(database.sqlite.readAuthSessionWithUser(thirdEmail.sessionToken).provider, "email");

      const conflictSession = await resolveAnonymousSession(database, email.sessionToken);
      const conflict = await linkGoogleAccount(database, conflictSession, {
        subject: "google-subject-1",
        email: "collision@example.com",
        displayName: "Collision",
        picture: null,
      });
      assert.deepEqual(conflict, {
        ok: false,
        error: {
          code: "AUTH_IDENTITY_CONFLICT",
          message: "Google identity is already linked to another account.",
          hint: "Sign out before using this Google identity, or sign in with the account it is already linked to.",
        },
      });
      assert.equal(database.sqlite.readAuthSessionWithUser(email.sessionToken).userId, email.auth.userId);
      const preservedIdentity = database.sqlite.findAuthIdentityByProviderSubject("google", "google-subject-1");
      assert.equal(preservedIdentity.userId, first.auth.userId);
      assert.equal(preservedIdentity.email, "ada.changed@example.com");
    } finally {
      database.close();
    }
  });
});

test("one Sporades user can own multiple Provider identities while reserved and duplicate ownership stays impossible", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true } },
    });
    try {
      const session = await resolveAnonymousSession(database, null);
      const now = new Date().toISOString();
      database.sqlite.insertAuthIdentity({
        id: "identity-google",
        userId: session.auth.userId,
        provider: "google",
        subject: "subject-google",
        email: null,
        displayName: "Ada",
        picture: null,
        createdAt: now,
        updatedAt: now,
      });
      database.sqlite.insertAuthIdentity({
        id: "identity-microsoft",
        userId: session.auth.userId,
        provider: "microsoft",
        subject: "subject-microsoft",
        email: "ada@example.com",
        displayName: "Ada",
        picture: null,
        createdAt: now,
        updatedAt: now,
      });
      assert.equal(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities WHERE userId = ?").get(session.auth.userId).count,
        2,
      );
      assert.throws(
        () =>
          database.sqlite.insertAuthIdentity({
            id: "identity-google-duplicate",
            userId: session.auth.userId,
            provider: "google",
            subject: "subject-google",
            email: "changed@example.com",
            displayName: "Changed",
            picture: null,
            createdAt: now,
            updatedAt: now,
          }),
        /unique/i,
      );
      assert.throws(
        () =>
          database.sqlite.insertAuthIdentity({
            id: "identity-reserved",
            userId: "__privileged__",
            provider: "google",
            subject: "reserved-subject",
            email: null,
            displayName: null,
            picture: null,
            createdAt: now,
            updatedAt: now,
          }),
        /reserved/i,
      );
      database.sqlite.prepare(
        "INSERT INTO sporades_auth_identities " +
        "(id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "identity-forged-reserved",
        "__privileged__",
        "google",
        "reserved-subject",
        null,
        null,
        null,
        now,
        now,
      );
      assert.equal(database.sqlite.findAuthIdentityByProviderSubject("google", "reserved-subject"), null);
    } finally {
      database.close();
    }
  });
});

test("legacy Google auth storage migrates without changing existing Session tokens or Sporades user IDs", async () => {
  await withTempDir(async (dir) => {
    const databasePath = path.join(dir, "data.db");
    const legacy = await createSqliteDatabaseAdapter(databasePath);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + 60_000).toISOString();
    legacy.exec(
      "CREATE TABLE sporades_auth_users (" +
      "id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, displayName TEXT NOT NULL, email TEXT, picture TEXT, " +
      "isAuthenticated INTEGER NOT NULL, isGuest INTEGER NOT NULL, provider TEXT NOT NULL)",
    );
    legacy.exec(
      "CREATE TABLE sporades_auth_sessions (" +
      "token TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL)",
    );
    legacy.prepare(
      "INSERT INTO sporades_auth_users " +
      "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("legacy-user", now, "Legacy Ada", "legacy@example.com", null, 1, 0, "google");
    legacy.prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)").run(
      "legacy-token",
      "legacy-user",
      now,
      expiresAt,
    );
    legacy.close();

    const database = await openDevDatabase(databasePath, "", {}, {
      auth: { providers: { anonymous: true, google: { enabled: true } } },
    });
    try {
      const session = await resolveAnonymousSession(database, "legacy-token");
      assert.equal(session.token, "legacy-token");
      assert.equal(session.auth.userId, "legacy-user");
      assert.equal(session.auth.provider, "google");

      const linked = await linkGoogleAccount(database, session, {
        subject: "verified-google-subject",
        email: "legacy@example.com",
        emailVerified: true,
        displayName: "Ada Verified",
        picture: null,
      });
      assert.equal(linked.ok, true);
      assert.equal(linked.auth.userId, "legacy-user");
      assert.equal(database.sqlite.readAuthSessionWithUser("legacy-token").userId, "legacy-user");
      assert.equal(
        database.sqlite.findAuthIdentityByProviderSubject("google", "verified-google-subject").userId,
        "legacy-user",
      );
      assert.equal(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities WHERE userId = ?").get("legacy-user").count,
        1,
      );

      const freshSession = await resolveAnonymousSession(database, null);
      const subjectOnly = await linkGoogleAccount(database, freshSession, {
        subject: "verified-google-subject",
        email: "changed-unverified@example.com",
        emailVerified: false,
        displayName: "Ada Changed",
        picture: null,
      });
      assert.equal(subjectOnly.ok, true);
      assert.equal(subjectOnly.auth.userId, "legacy-user");
      assert.equal(
        database.sqlite.findAuthIdentityByProviderSubject("google", "verified-google-subject").email,
        "changed-unverified@example.com",
      );
    } finally {
      database.close();
    }
  });
});

test("legacy Google identity claiming fails closed for unverified or ambiguous matching emails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, google: { enabled: true } } },
    });
    try {
      const now = new Date().toISOString();
      for (const suffix of ["one", "two"]) {
        database.sqlite.insertAuthUser({
          id: `legacy-user-${suffix}`,
          createdAt: now,
          displayName: `Legacy ${suffix}`,
          email: "shared@example.com",
          picture: null,
          isAuthenticated: 1,
          isGuest: 0,
          provider: "google",
        });
        database.sqlite.insertAuthIdentity({
          id: `legacy-identity-${suffix}`,
          userId: `legacy-user-${suffix}`,
          provider: "google",
          subject: `legacy:legacy-user-${suffix}`,
          email: "shared@example.com",
          displayName: `Legacy ${suffix}`,
          picture: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const unverifiedSession = await resolveAnonymousSession(database, null);
      const unverified = await linkGoogleAccount(database, unverifiedSession, {
        subject: "new-google-subject",
        email: "shared@example.com",
        emailVerified: false,
        displayName: "Unverified",
        picture: null,
      });
      assert.equal(unverified.ok, false);
      assert.equal(unverified.error.code, "AUTH_LEGACY_IDENTITY_UNVERIFIED_EMAIL");

      const verifiedSession = await resolveAnonymousSession(database, null);
      const ambiguous = await linkGoogleAccount(database, verifiedSession, {
        subject: "new-google-subject",
        email: "shared@example.com",
        emailVerified: true,
        displayName: "Ambiguous",
        picture: null,
      });
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.error.code, "AUTH_LEGACY_IDENTITY_AMBIGUOUS");

      assert.equal(database.sqlite.findAuthIdentityByProviderSubject("google", "new-google-subject"), null);
      assert.deepEqual(
        database.sqlite
          .prepare("SELECT subject FROM sporades_auth_identities WHERE email = ? ORDER BY subject")
          .all("shared@example.com")
          .map((row) => row.subject),
        ["legacy:legacy-user-one", "legacy:legacy-user-two"],
      );
      assert.equal(database.sqlite.readAuthSessionWithUser(unverifiedSession.token).provider, "anonymous");
      assert.equal(database.sqlite.readAuthSessionWithUser(verifiedSession.token).provider, "anonymous");
    } finally {
      database.close();
    }
  });
});

test("Google OAuth callback preserves structured Provider identity conflicts", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch;
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
      {
        auth: {
          providers: {
            anonymous: true,
            email: { enabled: true },
            google: {
              enabled: true,
              clientIdEnv: "GOOGLE_CLIENT_ID",
              clientSecretEnv: "GOOGLE_CLIENT_SECRET",
            },
          },
        },
      },
    );
    try {
      const ownerSession = await resolveAnonymousSession(database, null);
      const owner = await linkGoogleAccount(database, ownerSession, {
        subject: "owned-google-subject",
        email: "owner@example.com",
        emailVerified: true,
        displayName: "Owner",
        picture: null,
      });
      assert.equal(owner.ok, true);

      const otherAnonymous = await resolveAnonymousSession(database, null);
      const other = await signUpWithEmail(database, otherAnonymous, "email", {
        email: "other@example.com",
        password: "correct horse battery staple",
        name: "Other",
      });
      await database.sqlite.insertOAuthState({
        state: "conflict-state",
        sessionToken: other.sessionToken,
        returnTo: "http://127.0.0.1/app",
        redirectUri: "http://127.0.0.1/__sporades/auth/google/callback",
        createdAt: new Date().toISOString(),
      });
      globalThis.fetch = async (url) => {
        if (String(url).includes("token")) {
          return new Response(JSON.stringify({ access_token: "access-token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            sub: "owned-google-subject",
            email: "owner@example.com",
            email_verified: true,
            name: "Owner",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const response = createResponseRecorder();
      await routeSporadesAuth(
        database,
        { method: "GET", url: "/__sporades/auth/google/callback?state=conflict-state&code=good-code" },
        response,
      );
      assert.equal(response.statusCode, 500);
      assert.deepEqual(JSON.parse(response.body).error, {
        code: "AUTH_IDENTITY_CONFLICT",
        message: "Google identity is already linked to another account.",
        hint: "Sign out before using this Google identity, or sign in with the account it is already linked to.",
      });
      assert.equal(database.sqlite.readAuthSessionWithUser(other.sessionToken).userId, other.auth.userId);
      assert.equal(database.sqlite.findAuthIdentityByProviderSubject("google", "owned-google-subject").userId, owner.auth.userId);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
});

test("local identity simulation rolls back the auth user when session insertion fails", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true, email: { enabled: true } } },
    });
    const baseAdapter = database.sqlite;
    database.sqlite = failRuntimeWriteAfter(baseAdapter, "insertAuthSession", new Error("insert simulated session exploded"));
    database.adapter = database.sqlite;
    database.close = () => baseAdapter.close();

    try {
      await assert.rejects(
        () =>
          simulateLocalIdentitySession(database, {
            provider: "email",
            email: "local@example.com",
            displayName: "Local User",
          }),
        /insert simulated session exploded/,
      );
      assert.equal(baseAdapter.findAuthUserByProviderEmail("email", "local@example.com"), null);
    } finally {
      database.close();
    }
  });
});

test("OAuth callback spends state when downstream code exchange fails", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch;
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" },
      {
        auth: {
          providers: {
            anonymous: true,
            google: {
              enabled: true,
              clientIdEnv: "GOOGLE_CLIENT_ID",
              clientSecretEnv: "GOOGLE_CLIENT_SECRET",
            },
          },
        },
      },
    );

    try {
      const session = await resolveAnonymousSession(database, null);
      await database.sqlite.insertOAuthState({
        state: "oauth-state",
        sessionToken: session.token,
        returnTo: "http://127.0.0.1/app",
        redirectUri: "http://127.0.0.1/__sporades/auth/google/callback",
        createdAt: new Date().toISOString(),
      });
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });

      const response = createResponseRecorder();
      const handled = await routeSporadesAuth(
        database,
        { method: "GET", url: "/__sporades/auth/google/callback?state=oauth-state&code=bad-code" },
        response,
      );

      assert.equal(handled, true);
      assert.equal(
        database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get("oauth-state"),
        undefined,
      );
      assert.equal(response.statusCode, 500);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
});

test("current-user preference updates roll back failed saves", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      auth: { providers: { anonymous: true } },
    });
    const baseAdapter = database.sqlite;

    try {
      const session = await resolveAnonymousSession(database, null);
      assert.deepEqual(await updateCurrentUserPreferences(database, session.auth, { theme: "dark" }), {
        ok: true,
        data: { preferences: { theme: "dark" } },
        changes: { theme: "dark" },
        error: null,
      });

      database.sqlite = failRuntimeWriteAfter(baseAdapter, "saveUserPreferences", new Error("save preferences exploded"));
      database.adapter = database.sqlite;
      const failed = await updateCurrentUserPreferences(database, session.auth, { density: "compact" });
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, "PREFERENCES_UPDATE_FAILED");

      assert.deepEqual(JSON.parse(baseAdapter.readUserPreferences(session.auth.userId).value), { theme: "dark" });
    } finally {
      database.close();
    }
  });
});

function wrapAsyncRuntimeAdapter(adapter) {
  const asyncMethods = new Set([
    "ensureSystemTable",
    "readSystemMetadata",
    "writeSystemMetadata",
    "readSchemaMetadata",
    "writeSchemaMetadata",
    "ensureLogStorage",
    "insertLogIndexEvent",
    "pruneLogIndex",
    "readRecentLogEvents",
    "ensureFileStorage",
    "findFileBucket",
    "createFileBucket",
    "insertFileRow",
    "updatePendingFileRow",
    "insertFileUpload",
    "selectFileById",
    "selectLiveFileByPath",
    "selectActiveFileByPath",
    "selectPendingFileUploadByPath",
    "selectFileUpload",
    "completeFileUpload",
    "deleteFileUploadsForPath",
    "deleteFileUploadsForFile",
    "deleteFileUpload",
    "selectPublicFileRow",
    "insertPublicFileUrl",
    "revokePublicFileUrl",
    "revokePublicFileUrlsForFile",
    "markFileDeleted",
    "fileRowForOwner",
    "ensureAuthStorage",
    "findAuthUserByProviderEmail",
    "findAuthIdentityByProviderSubject",
    "findLegacyAuthIdentitiesByProviderEmail",
    "insertAuthIdentity",
    "updateAuthIdentity",
    "insertAuthUser",
    "updateAuthUserProfile",
    "linkAuthUser",
    "insertAuthSession",
    "deleteAuthSession",
    "refreshAuthSession",
    "setAuthSessionProvider",
    "rotateAuthSession",
    "readAuthSessionWithUser",
    "insertOAuthState",
    "consumeOAuthState",
    "emailCredentialExists",
    "insertEmailCredential",
    "findEmailCredentialWithUser",
    "migrateAppSchema",
    "referenceExists",
    "withTransaction",
    "insertAppRow",
    "selectAppRowById",
    "updateAppRow",
    "deleteAppRow",
    "selectAppRows",
    "listInspectableTables",
    "dumpInspectableDatabase",
    "runReadOnlyInspectionQuery",
    "checkHealth",
  ]);
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !asyncMethods.has(property) || typeof value !== "function") {
        return value;
      }
      return async (...args) => await value.apply(target, args);
    },
  });
}

function createDurableAuditTransactionAdapter(adapter) {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "withTransaction") {
        return async (fn) => {
          const transactionAdapter = new Proxy(target, {
            get(currentTarget, transactionProperty, transactionReceiver) {
              if (transactionProperty === "withTransaction") {
                return async () => {
                  throw new Error("Nested database transactions are not supported.");
                };
              }
              return Reflect.get(currentTarget, transactionProperty, transactionReceiver);
            },
          });
          return await fn(transactionAdapter);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function createResponseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

function failRuntimeWriteAfter(adapter, methodName, error) {
  let armed = true;
  const wrap = (target) =>
    new Proxy(target, {
      get(currentTarget, property, receiver) {
        if (property === "withTransaction") {
          return async (fn) => {
            const withTransaction = Reflect.get(currentTarget, property, receiver);
            return await withTransaction.call(currentTarget, async (transactionAdapter) => {
              return await fn(wrap(transactionAdapter));
            });
          };
        }
        const value = Reflect.get(currentTarget, property, receiver);
        if (property !== methodName || typeof value !== "function") {
          return value;
        }
        return async (...args) => {
          const result = await value.apply(currentTarget, args);
          if (armed) {
            armed = false;
            throw error;
          }
          return result;
        };
      },
    });
  return wrap(adapter);
}
