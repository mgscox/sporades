import assert from "node:assert/strict";

// The File metadata storage surface of the Database adapter conformance specification (ADR-0035).
//
// One defect on this surface already shipped: completing an Upload call for a file with no
// existing row branched on an unresolved sibling-method result, took the update path, and so
// reported success without ever writing the File metadata row. Nothing threw. The methods either
// side of it have the same exposure and had only ever been verified on SQLite, so this surface
// brings the whole of File bucket, File metadata, pending upload and Public file URL storage
// under the specification.
//
// Every assertion here compares an observed value against an expected value, and every predicate
// is exercised on both sides: an owner-scoped lookup is run for the owner and for someone else, a
// revocation for a URL that is open and one already revoked, a deletion for a row that exists and
// one that does not. A guard that never fires and a count that always answers zero each satisfy a
// single positive assertion, which is exactly how the shipped defects survived review.
//
// The surface owns its own fixtures rather than sharing a module with its sibling surfaces, and
// runs against its own adapter with its own prepared storage, so no case here can perturb one
// there.

const OWNER_ID = "owner-primary";
const OTHER_OWNER_ID = "owner-secondary";
const BUCKET_ID = "bucket-media";
const BUCKET_NAME = "media";

const NOW = "2026-07-11T09:00:00.000Z";
const LATER = "2026-07-11T09:30:00.000Z";
const LATEST = "2026-07-11T10:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function fileRow(overrides) {
  return {
    ownerId: OWNER_ID,
    bucketId: BUCKET_ID,
    bucketName: BUCKET_NAME,
    type: "text/plain",
    size: 3,
    version: "version-1",
    status: "uploaded",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function pendingUpload(overrides) {
  return {
    ownerId: OWNER_ID,
    bucketId: BUCKET_ID,
    bucketName: BUCKET_NAME,
    type: "text/plain",
    version: "version-1",
    expectedSize: 3,
    createdAt: NOW,
    ...overrides,
  };
}

function fileIdsOf(rows) {
  return rows.map((row) => row.id);
}

async function prepareFileMetadataStorage(adapter) {
  await adapter.ensureFileStorage();
  await adapter.createFileBucket({ id: BUCKET_ID, ownerId: OWNER_ID, name: BUCKET_NAME, createdAt: NOW });
}

const FILE_METADATA_CONFORMANCE_CASES = [
  {
    name: "findFileBucket answers for a stored bucket and an absent one, and createFileBucket makes one findable",
    async run(adapter) {
      const seeded = await adapter.findFileBucket(OWNER_ID, BUCKET_NAME);
      assert.deepEqual(
        { id: seeded?.id, ownerId: seeded?.ownerId, name: seeded?.name, createdAt: seeded?.createdAt },
        { id: BUCKET_ID, ownerId: OWNER_ID, name: BUCKET_NAME, createdAt: NOW },
      );

      // A bucket is scoped to its owner and its name, so both halves of the lookup must miss.
      assert.equal(await adapter.findFileBucket(OWNER_ID, "absent-bucket"), null);
      assert.equal(await adapter.findFileBucket(OTHER_OWNER_ID, BUCKET_NAME), null);

      const created = await adapter.createFileBucket({
        id: "bucket-archive",
        ownerId: OTHER_OWNER_ID,
        name: "archive",
        createdAt: LATER,
      });
      assert.equal(created.changes, 1);

      const found = await adapter.findFileBucket(OTHER_OWNER_ID, "archive");
      assert.deepEqual(
        { id: found?.id, ownerId: found?.ownerId, name: found?.name, createdAt: found?.createdAt },
        { id: "bucket-archive", ownerId: OTHER_OWNER_ID, name: "archive", createdAt: LATER },
      );
      assert.equal(await adapter.findFileBucket(OWNER_ID, "archive"), null);
    },
  },
  {
    name: "insertFileRow stores File metadata that selectFileById returns, and updatePendingFileRow replaces it",
    async run(adapter) {
      assert.equal(await adapter.selectFileById("file-insert"), null);

      const inserted = await adapter.insertFileRow(
        fileRow({ id: "file-insert", path: "/media/insert.txt", name: "insert.txt", size: 5, status: "pending" }),
      );
      assert.equal(inserted.changes, 1);

      const stored = await adapter.selectFileById("file-insert");
      assert.deepEqual(
        {
          id: stored?.id,
          ownerId: stored?.ownerId,
          bucketId: stored?.bucketId,
          bucketName: stored?.bucketName,
          path: stored?.path,
          name: stored?.name,
          type: stored?.type,
          size: stored?.size,
          version: stored?.version,
          status: stored?.status,
          createdAt: stored?.createdAt,
          updatedAt: stored?.updatedAt,
          deletedAt: stored?.deletedAt,
        },
        {
          id: "file-insert",
          ownerId: OWNER_ID,
          bucketId: BUCKET_ID,
          bucketName: BUCKET_NAME,
          path: "/media/insert.txt",
          name: "insert.txt",
          type: "text/plain",
          size: 5,
          version: "version-1",
          status: "pending",
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
        },
      );
      assert.equal(await adapter.selectFileById("file-never-inserted"), null);

      const updated = await adapter.updatePendingFileRow({
        id: "file-insert",
        bucketId: BUCKET_ID,
        bucketName: BUCKET_NAME,
        path: "/media/insert-renamed.txt",
        name: "insert-renamed.txt",
        type: "text/markdown",
        size: 11,
        version: "version-2",
        status: "uploaded",
        updatedAt: LATER,
      });
      assert.equal(updated.changes, 1);

      const replaced = await adapter.selectFileById("file-insert");
      assert.deepEqual(
        {
          path: replaced?.path,
          name: replaced?.name,
          type: replaced?.type,
          size: replaced?.size,
          version: replaced?.version,
          status: replaced?.status,
          createdAt: replaced?.createdAt,
          updatedAt: replaced?.updatedAt,
        },
        {
          path: "/media/insert-renamed.txt",
          name: "insert-renamed.txt",
          type: "text/markdown",
          size: 11,
          version: "version-2",
          status: "uploaded",
          createdAt: NOW,
          updatedAt: LATER,
        },
      );

      const missed = await adapter.updatePendingFileRow({
        id: "file-never-inserted",
        bucketId: BUCKET_ID,
        bucketName: BUCKET_NAME,
        path: "/media/nowhere.txt",
        name: "nowhere.txt",
        type: "text/plain",
        size: 1,
        version: "version-1",
        status: "uploaded",
        updatedAt: LATER,
      });
      assert.equal(missed.changes, 0);
    },
  },
  {
    name: "selectLiveFileByPath and selectActiveFileByPath separate uploaded, pending and deleted rows",
    async run(adapter) {
      await adapter.insertFileRow(fileRow({ id: "file-path-live", path: "/media/path-live.txt", name: "path-live.txt" }));
      await adapter.insertFileRow(
        fileRow({ id: "file-path-pending", path: "/media/path-pending.txt", name: "path-pending.txt", status: "pending" }),
      );

      // An uploaded row is both live and active; a pending row is active but not live.
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/path-live.txt")), ["file-path-live"]);
      assert.deepEqual(fileIdsOf(await adapter.selectActiveFileByPath("/media/path-live.txt")), ["file-path-live"]);
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/path-pending.txt")), []);
      assert.deepEqual(fileIdsOf(await adapter.selectActiveFileByPath("/media/path-pending.txt")), ["file-path-pending"]);

      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/path-absent.txt")), []);
      assert.deepEqual(fileIdsOf(await adapter.selectActiveFileByPath("/media/path-absent.txt")), []);

      // Deletion removes a row from both lookups even though the row itself is still stored.
      await adapter.markFileDeleted("file-path-live", LATER);
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/path-live.txt")), []);
      assert.deepEqual(fileIdsOf(await adapter.selectActiveFileByPath("/media/path-live.txt")), []);
      assert.equal((await adapter.selectFileById("file-path-live")).deletedAt, LATER);
    },
  },
  {
    name: "fileRowForOwner returns a live uploaded row to its owner and nothing to anyone else",
    async run(adapter) {
      await adapter.insertFileRow(fileRow({ id: "file-owned", path: "/media/owned.txt", name: "owned.txt", size: 7 }));
      await adapter.insertFileRow(
        fileRow({ id: "file-owned-pending", path: "/media/owned-pending.txt", name: "owned-pending.txt", status: "pending" }),
      );
      await adapter.insertFileRow(
        fileRow({ id: "file-owned-deleted", path: "/media/owned-deleted.txt", name: "owned-deleted.txt" }),
      );
      await adapter.markFileDeleted("file-owned-deleted", LATER);

      const owned = await adapter.fileRowForOwner("file-owned", OWNER_ID);
      assert.deepEqual(
        { id: owned?.id, ownerId: owned?.ownerId, path: owned?.path, size: owned?.size, status: owned?.status },
        { id: "file-owned", ownerId: OWNER_ID, path: "/media/owned.txt", size: 7, status: "uploaded" },
      );

      // The lookup is scoped by owner, by status and by deletion, so each exclusion is checked.
      assert.equal(await adapter.fileRowForOwner("file-owned", OTHER_OWNER_ID), null);
      assert.equal(await adapter.fileRowForOwner("file-owned-pending", OWNER_ID), null);
      assert.equal(await adapter.fileRowForOwner("file-owned-deleted", OWNER_ID), null);
      assert.equal(await adapter.fileRowForOwner("file-never-inserted", OWNER_ID), null);
    },
  },
  {
    name: "the pending upload lifecycle stores, finds by path and identifier, and deletes by identifier, path and file",
    async run(adapter) {
      assert.equal(await adapter.selectFileUpload("upload-single"), null);
      assert.equal(await adapter.selectPendingFileUploadByPath("/media/up-single.txt"), null);

      const stored = await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-single",
          fileId: "file-up-single",
          path: "/media/up-single.txt",
          name: "up-single.txt",
          expectedSize: 4,
        }),
      );
      assert.equal(stored.changes, 1);

      const byId = await adapter.selectFileUpload("upload-single");
      assert.deepEqual(
        {
          id: byId?.id,
          fileId: byId?.fileId,
          ownerId: byId?.ownerId,
          bucketId: byId?.bucketId,
          bucketName: byId?.bucketName,
          path: byId?.path,
          name: byId?.name,
          type: byId?.type,
          version: byId?.version,
          expectedSize: byId?.expectedSize,
          createdAt: byId?.createdAt,
        },
        {
          id: "upload-single",
          fileId: "file-up-single",
          ownerId: OWNER_ID,
          bucketId: BUCKET_ID,
          bucketName: BUCKET_NAME,
          path: "/media/up-single.txt",
          name: "up-single.txt",
          type: "text/plain",
          version: "version-1",
          expectedSize: 4,
          createdAt: NOW,
        },
      );
      assert.equal((await adapter.selectPendingFileUploadByPath("/media/up-single.txt"))?.id, "upload-single");

      const removed = await adapter.deleteFileUpload("upload-single");
      assert.equal(removed.changes, 1);
      assert.equal(await adapter.selectFileUpload("upload-single"), null);
      assert.equal(await adapter.selectPendingFileUploadByPath("/media/up-single.txt"), null);
      assert.equal((await adapter.deleteFileUpload("upload-single")).changes, 0);

      // Deletion by path is scoped to that path, so a neighbouring upload must survive it. Only
      // one upload can hold a path at a time, which is what the unique path index enforces.
      await adapter.insertFileUpload(
        pendingUpload({ id: "upload-path-target", fileId: "file-up-path", path: "/media/up-path.txt", name: "up-path.txt" }),
      );
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-path-neighbour",
          fileId: "file-up-path-neighbour",
          path: "/media/up-path-neighbour.txt",
          name: "up-path-neighbour.txt",
          createdAt: LATER,
        }),
      );

      const clearedPath = await adapter.deleteFileUploadsForPath("/media/up-path.txt");
      assert.equal(clearedPath.changes, 1);
      assert.equal(await adapter.selectPendingFileUploadByPath("/media/up-path.txt"), null);
      assert.equal(await adapter.selectFileUpload("upload-path-target"), null);
      assert.equal((await adapter.selectPendingFileUploadByPath("/media/up-path-neighbour.txt"))?.id, "upload-path-neighbour");
      assert.equal((await adapter.deleteFileUploadsForPath("/media/up-path.txt")).changes, 0);

      // Deletion by file is scoped to the owner, so another owner's upload for the same file stays.
      await adapter.insertFileUpload(
        pendingUpload({ id: "upload-file-mine", fileId: "file-up-shared", path: "/media/up-mine.txt", name: "up-mine.txt" }),
      );
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-file-theirs",
          fileId: "file-up-shared",
          ownerId: OTHER_OWNER_ID,
          path: "/media/up-theirs.txt",
          name: "up-theirs.txt",
        }),
      );

      const clearedFile = await adapter.deleteFileUploadsForFile(OWNER_ID, "file-up-shared");
      assert.equal(clearedFile.changes, 1);
      assert.equal(await adapter.selectFileUpload("upload-file-mine"), null);
      assert.equal((await adapter.selectFileUpload("upload-file-theirs"))?.id, "upload-file-theirs");
      assert.equal((await adapter.deleteFileUploadsForFile(OWNER_ID, "file-up-shared")).changes, 0);
    },
  },
  {
    // Defect: completion branched on an unresolved sibling-method result, always took the update
    // path, and so wrote nothing at all for a file with no row yet. Its three outcomes are
    // indistinguishable from outside unless all three are exercised, so all three are here.
    name: "completeFileUpload inserts a missing row, updates a live row, and leaves a deleted row deleted",
    async run(adapter) {
      // Outcome one: no row yet, so completion must insert it.
      assert.equal(await adapter.selectFileById("file-complete-new"), null);
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-complete-new",
          fileId: "file-complete-new",
          path: "/media/complete-new.txt",
          name: "complete-new.txt",
          expectedSize: 6,
        }),
      );

      const insertion = await adapter.completeFileUpload(await adapter.selectFileUpload("upload-complete-new"), 6, LATER);
      assert.equal(insertion.changes, 1);

      const created = await adapter.selectFileById("file-complete-new");
      assert.deepEqual(
        {
          id: created?.id,
          ownerId: created?.ownerId,
          path: created?.path,
          name: created?.name,
          size: created?.size,
          version: created?.version,
          status: created?.status,
          createdAt: created?.createdAt,
          updatedAt: created?.updatedAt,
          deletedAt: created?.deletedAt,
        },
        {
          id: "file-complete-new",
          ownerId: OWNER_ID,
          path: "/media/complete-new.txt",
          name: "complete-new.txt",
          size: 6,
          version: "version-1",
          status: "uploaded",
          createdAt: NOW,
          updatedAt: LATER,
          deletedAt: null,
        },
      );
      assert.equal(await adapter.selectFileUpload("upload-complete-new"), null);

      // Outcome two: a live row exists, so completion must update it in place. The stored
      // createdAt is what separates an update from an insert, so it is asserted rather than the
      // upload's own createdAt.
      await adapter.insertFileRow(
        fileRow({ id: "file-complete-live", path: "/media/complete-live.txt", name: "complete-live.txt", status: "pending" }),
      );
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-complete-live",
          fileId: "file-complete-live",
          path: "/media/complete-live.txt",
          name: "complete-live.txt",
          version: "version-2",
          expectedSize: 9,
          createdAt: LATER,
        }),
      );

      const update = await adapter.completeFileUpload(await adapter.selectFileUpload("upload-complete-live"), 9, LATEST);
      assert.equal(update.changes, 1);

      const updated = await adapter.selectFileById("file-complete-live");
      assert.deepEqual(
        {
          size: updated?.size,
          version: updated?.version,
          status: updated?.status,
          createdAt: updated?.createdAt,
          updatedAt: updated?.updatedAt,
          deletedAt: updated?.deletedAt,
        },
        { size: 9, version: "version-2", status: "uploaded", createdAt: NOW, updatedAt: LATEST, deletedAt: null },
      );

      // Outcome three: the row has been deleted, so completion must not resurrect it. The upload
      // is still consumed, but nothing about the stored row may change.
      await adapter.insertFileRow(
        fileRow({ id: "file-complete-deleted", path: "/media/complete-deleted.txt", name: "complete-deleted.txt", size: 2 }),
      );
      await adapter.markFileDeleted("file-complete-deleted", LATER);
      await adapter.insertFileUpload(
        pendingUpload({
          id: "upload-complete-deleted",
          fileId: "file-complete-deleted",
          path: "/media/complete-revived.txt",
          name: "complete-revived.txt",
          version: "version-3",
          expectedSize: 42,
        }),
      );

      const refused = await adapter.completeFileUpload(await adapter.selectFileUpload("upload-complete-deleted"), 42, LATEST);
      assert.equal(refused.changes, 0);

      const untouched = await adapter.selectFileById("file-complete-deleted");
      assert.deepEqual(
        {
          path: untouched?.path,
          name: untouched?.name,
          size: untouched?.size,
          version: untouched?.version,
          updatedAt: untouched?.updatedAt,
          deletedAt: untouched?.deletedAt,
        },
        {
          path: "/media/complete-deleted.txt",
          name: "complete-deleted.txt",
          size: 2,
          version: "version-1",
          updatedAt: LATER,
          deletedAt: LATER,
        },
      );
      assert.equal(await adapter.selectFileUpload("upload-complete-deleted"), null);
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/complete-revived.txt")), []);
    },
  },
  {
    name: "public file URLs are created, looked up, revoked one at a time and revoked for a whole file",
    async run(adapter) {
      assert.equal(await adapter.selectPublicFileRow("purl-never-created"), null);

      await adapter.insertFileRow(fileRow({ id: "file-public", path: "/media/public.txt", name: "public.txt", size: 8 }));
      await adapter.insertFileRow(
        fileRow({ id: "file-public-other", path: "/media/public-other.txt", name: "public-other.txt", size: 8 }),
      );

      const created = await adapter.insertPublicFileUrl({
        id: "purl-first",
        fileId: "file-public",
        ownerId: OWNER_ID,
        version: "version-1",
        expiresAt: FAR_FUTURE,
        createdAt: NOW,
      });
      assert.equal(created.changes, 1);

      // The lookup joins the Public file URL to its File metadata, so both halves are asserted.
      const joined = await adapter.selectPublicFileRow("purl-first");
      assert.deepEqual(
        {
          publicUrlId: joined?.publicUrlId,
          fileId: joined?.fileId,
          publicVersion: joined?.publicVersion,
          expiresAt: joined?.expiresAt,
          revokedAt: joined?.revokedAt,
          id: joined?.id,
          ownerId: joined?.ownerId,
          path: joined?.path,
          name: joined?.name,
          size: joined?.size,
          status: joined?.status,
        },
        {
          publicUrlId: "purl-first",
          fileId: "file-public",
          publicVersion: "version-1",
          expiresAt: FAR_FUTURE,
          revokedAt: null,
          id: "file-public",
          ownerId: OWNER_ID,
          path: "/media/public.txt",
          name: "public.txt",
          size: 8,
          status: "uploaded",
        },
      );

      // Revocation is owner-scoped and applies only to a URL that is still open, so a stranger's
      // attempt and a repeat attempt must both change nothing.
      const strangerRevoke = await adapter.revokePublicFileUrl("purl-first", OTHER_OWNER_ID, LATER);
      assert.equal(strangerRevoke.changes, 0);
      assert.equal((await adapter.selectPublicFileRow("purl-first")).revokedAt, null);

      const ownerRevoke = await adapter.revokePublicFileUrl("purl-first", OWNER_ID, LATER);
      assert.equal(ownerRevoke.changes, 1);
      assert.equal((await adapter.selectPublicFileRow("purl-first")).revokedAt, LATER);

      const repeatRevoke = await adapter.revokePublicFileUrl("purl-first", OWNER_ID, LATEST);
      assert.equal(repeatRevoke.changes, 0);
      assert.equal((await adapter.selectPublicFileRow("purl-first")).revokedAt, LATER);

      for (const id of ["purl-second", "purl-third"]) {
        await adapter.insertPublicFileUrl({
          id,
          fileId: "file-public",
          ownerId: OWNER_ID,
          version: "version-1",
          expiresAt: null,
          createdAt: NOW,
        });
      }
      await adapter.insertPublicFileUrl({
        id: "purl-elsewhere",
        fileId: "file-public-other",
        ownerId: OWNER_ID,
        version: "version-1",
        expiresAt: null,
        createdAt: NOW,
      });

      // Revoking every URL on a file skips the one already revoked and spares another file's.
      const revokedAll = await adapter.revokePublicFileUrlsForFile("file-public", LATEST);
      assert.equal(revokedAll.changes, 2);
      assert.equal((await adapter.selectPublicFileRow("purl-second")).revokedAt, LATEST);
      assert.equal((await adapter.selectPublicFileRow("purl-third")).revokedAt, LATEST);
      assert.equal((await adapter.selectPublicFileRow("purl-first")).revokedAt, LATER);
      assert.equal((await adapter.selectPublicFileRow("purl-elsewhere")).revokedAt, null);

      assert.equal((await adapter.revokePublicFileUrlsForFile("file-public", LATEST)).changes, 0);
    },
  },
  {
    name: "markFileDeleted removes one owner's File metadata from live lookups and leaves another owner's row alone",
    async run(adapter) {
      await adapter.insertFileRow(fileRow({ id: "file-delete-mine", path: "/media/delete-mine.txt", name: "delete-mine.txt" }));
      await adapter.insertFileRow(
        fileRow({
          id: "file-delete-theirs",
          ownerId: OTHER_OWNER_ID,
          path: "/media/delete-theirs.txt",
          name: "delete-theirs.txt",
        }),
      );

      const deleted = await adapter.markFileDeleted("file-delete-mine", LATER);
      assert.equal(deleted.changes, 1);

      const mine = await adapter.selectFileById("file-delete-mine");
      assert.deepEqual({ deletedAt: mine?.deletedAt, updatedAt: mine?.updatedAt }, { deletedAt: LATER, updatedAt: LATER });
      assert.equal(await adapter.fileRowForOwner("file-delete-mine", OWNER_ID), null);
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/delete-mine.txt")), []);

      // Deletion targets one row by identity, so the other owner's row is untouched by it.
      const theirs = await adapter.selectFileById("file-delete-theirs");
      assert.deepEqual({ deletedAt: theirs?.deletedAt, updatedAt: theirs?.updatedAt }, { deletedAt: null, updatedAt: NOW });
      assert.equal((await adapter.fileRowForOwner("file-delete-theirs", OTHER_OWNER_ID))?.id, "file-delete-theirs");
      assert.deepEqual(fileIdsOf(await adapter.selectLiveFileByPath("/media/delete-theirs.txt")), ["file-delete-theirs"]);

      assert.equal((await adapter.markFileDeleted("file-never-inserted", LATER)).changes, 0);
    },
  },
  {
    name: "ingress receipt locks, completion, lookup, and File insert-if-absent agree across adapters",
    async run(adapter) {
      const file = fileRow({ id: "file-ingress-conformance", path: "/media/ingress-conformance.txt", name: "ingress-conformance.txt" });
      assert.equal((await adapter.insertFileRowIfAbsent(file)).changes, 1);
      assert.equal((await adapter.insertFileRowIfAbsent({ ...file, name: "must-not-replace.txt" })).changes, 0);
      assert.equal((await adapter.selectFileById(file.id)).name, "ingress-conformance.txt");

      const leased = { key: "POST:/upload:owner:request:part", leaseId: "lease-conformance", state: "leased", actorId: OWNER_ID, endpointMethod: "POST", endpointPath: "/upload", requestKey: "request", partKey: "part", fileId: file.id, expiresAt: LATER };
      await adapter.prepare(adapter.dialect.sql("INSERT INTO [sporades_file_ingress] ([key], [leaseId], [state], [actorId], [endpointMethod], [endpointPath], [requestKey], [partKey], [expiresAt], [sweepToken], [payload], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")).run(leased.key, leased.leaseId, leased.state, leased.actorId, leased.endpointMethod, leased.endpointPath, leased.requestKey, leased.partKey, leased.expiresAt, JSON.stringify(leased), NOW);
      await adapter.lockIngressReceipts([leased.leaseId]);
      assert.deepEqual(
        (({ leaseId, state, actorId, endpointMethod, endpointPath, requestKey, partKey }) => ({ leaseId, state, actorId, endpointMethod, endpointPath, requestKey, partKey }))(await adapter.selectIngressByLease(leased.leaseId)),
        { leaseId: leased.leaseId, state: "leased", actorId: OWNER_ID, endpointMethod: "POST", endpointPath: "/upload", requestKey: "request", partKey: "part" },
      );
      const completed = await adapter.completeIngressClaim({ ...leased, state: "complete", file });
      assert.equal(completed.state, "complete");
      assert.equal(JSON.parse(completed.payload).file.id, file.id);
      assert.equal((await adapter.completeIngressClaim({ ...leased, state: "complete", file })).state, "complete");
      assert.equal(await adapter.selectIngressByLease("missing-lease"), null);

      const expired = { ...leased, key: "POST:/upload:owner:expired:part", leaseId: "lease-expired-conformance", requestKey: "expired", fileId: "uncommitted-file", expiresAt: NOW };
      await adapter.prepare(adapter.dialect.sql("INSERT INTO [sporades_file_ingress] ([key], [leaseId], [state], [actorId], [endpointMethod], [endpointPath], [requestKey], [partKey], [expiresAt], [sweepToken], [payload], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")).run(expired.key, expired.leaseId, expired.state, expired.actorId, expired.endpointMethod, expired.endpointPath, expired.requestKey, expired.partKey, expired.expiresAt, JSON.stringify(expired), NOW);
      assert.deepEqual((await adapter.selectIngressSweepCandidates(LATEST, 10)).map((row) => row.leaseId), [expired.leaseId]);
      assert.equal((await adapter.markIngressReceiptSweeping(expired, "sweep-token", LATEST)).changes, 1);
      assert.equal((await adapter.selectIngressByLease(expired.leaseId)).state, "sweeping");
      assert.equal((await adapter.deleteIngressSweepingReceipt(expired.leaseId, "wrong-token")).changes, 0);
      assert.equal((await adapter.deleteIngressSweepingReceipt(expired.leaseId, "sweep-token")).changes, 1);
      assert.equal(await adapter.selectIngressByLease(expired.leaseId), null);
    },
  },
  {
    // `ensureFileStorage` is a DDL method, and the engines emit different statement text for it —
    // which ADR-0034 permits. What they may not differ on is the answer, and its answer is the
    // storage a Capsule boot finds afterwards: the tables exist, they are writable, and running it
    // again over a populated store keeps what is already there. Every Capsule start re-runs it.
    name: "ensureFileStorage creates writable File metadata storage and keeps stored rows when run again",
    async run(adapter) {
      assert.equal((await adapter.selectFileById("file-delete-theirs")).id, "file-delete-theirs");
      assert.equal((await adapter.findFileBucket(OWNER_ID, BUCKET_NAME)).id, BUCKET_ID);

      // A pending upload is seeded here rather than relied on from an earlier case, because every
      // upload those cases created was consumed or deleted by the time they finished. Without a
      // stored upload row crossing the call below, a DDL path that recreated the uploads table
      // would satisfy every other assertion in this case while destroying every in-flight Upload
      // call on each Capsule restart.
      await adapter.insertFileUpload(
        pendingUpload({ id: "upload-across-ensure", fileId: "file-across-ensure", path: "/media/across-ensure.txt", name: "across-ensure.txt" }),
      );
      assert.equal((await adapter.selectFileUpload("upload-across-ensure")).fileId, "file-across-ensure");

      await adapter.ensureFileStorage();

      // Nothing the earlier cases stored is disturbed by the second run, and neither is the
      // pending upload — one assertion per table the method creates.
      assert.equal((await adapter.selectFileById("file-delete-theirs")).id, "file-delete-theirs");
      assert.equal((await adapter.selectFileById("file-delete-mine")).deletedAt, LATER);
      assert.equal((await adapter.findFileBucket(OWNER_ID, BUCKET_NAME)).id, BUCKET_ID);
      assert.equal((await adapter.selectPublicFileRow("purl-elsewhere")).revokedAt, null);
      assert.deepEqual(
        {
          fileId: (await adapter.selectFileUpload("upload-across-ensure"))?.fileId,
          path: (await adapter.selectPendingFileUploadByPath("/media/across-ensure.txt"))?.path,
        },
        { fileId: "file-across-ensure", path: "/media/across-ensure.txt" },
      );

      // And the storage is still writable across every table the method creates.
      assert.equal((await adapter.createFileBucket({ id: "bucket-after-ensure", ownerId: OWNER_ID, name: "after", createdAt: LATEST })).changes, 1);
      assert.equal(
        (await adapter.insertFileRow(fileRow({ id: "file-after-ensure", path: "/media/after-ensure.txt", name: "after-ensure.txt" }))).changes,
        1,
      );
      assert.equal(
        (await adapter.insertFileUpload(pendingUpload({ id: "upload-after-ensure", fileId: "file-after-ensure", path: "/media/after-ensure.txt", name: "after-ensure.txt" }))).changes,
        1,
      );
      assert.equal((await adapter.selectFileUpload("upload-after-ensure")).fileId, "file-after-ensure");
    },
  },
];

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (File metadata storage)",
  appTableNames: [],
  prepareStorage: prepareFileMetadataStorage,
  cases: FILE_METADATA_CONFORMANCE_CASES,
};
