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
          createdAt: now,
          expiresAt: "2026-08-03T10:00:00.000Z",
        });
        assert.equal((await adapter.readAuthSessionWithUser("session-1")).email, "libsql@example.com");

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
        "DROP TABLE IF EXISTS notes, sporades, sporades_auth_users, sporades_auth_sessions, sporades_auth_email_credentials, " +
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
        createdAt: now,
        expiresAt: "2026-08-03T10:00:00.000Z",
      });
      assert.equal((await adapter.readAuthSessionWithUser("session-1")).email, "postgres@example.com");

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
      adapter.rotateAuthSession("session-1", {
        token: "session-2",
        userId: "user-1",
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
      assert.equal(baseAdapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get("link-state"), undefined);
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
    "insertAuthUser",
    "updateAuthUserProfile",
    "linkAuthUser",
    "insertAuthSession",
    "deleteAuthSession",
    "refreshAuthSession",
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
