import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { capsule, mutation, job, schedule } from "../dist/server.js";
import { openDevDatabase, runMutation, createControllableRuntimeClock } from "../dist/server-runtime-source.js";
import { createPendingFileUpload, completePendingFileUpload } from "../dist/file-storage-runtime.js";

const guest = { userId: "guest", isGuest: true, isAuthenticated: false, provider: "anonymous" };
const member = { userId: "member", isGuest: false, isAuthenticated: true, provider: "email" };
async function fixture(definition, config, run, runtimeOptions = {}) {
  const dir = await mkdtemp(path.resolve(".scratch/file-policy-"));
  let db;
  try {
    db = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "file-policy", files: { storagePath: path.join(dir, "files"), ...config } }, capsule({ name: "file-policy", ...definition }), runtimeOptions);
    await run(db);
  } finally { await db?.close(); await rm(dir, { recursive: true, force: true }); }
}
const upload = (db, auth = guest, overrides = {}) => createPendingFileUpload(db, auth, { file: { name: "hello.txt", type: "text/plain", size: 5, ...overrides } });

test("upload ACL denies guests before creating an upload and receives bounded metadata", async () => {
  const seen = [];
  await fixture({ files: { acl: { upload: async (ctx, meta) => {
    seen.push(meta);
    assert.equal(ctx.db, undefined);
    assert.equal(ctx.privileged, undefined);
    return ctx.auth.isAuthenticated;
  } } } }, {}, async db => {
    const denied = await upload(db);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "FILE_UPLOAD_DENIED");
    const allowed = await upload(db, member);
    assert.equal(allowed.ok, true);
    assert.deepEqual(seen, [{ sizeBytes: 5, mimeType: "text/plain", name: "hello.txt" }, { sizeBytes: 5, mimeType: "text/plain", name: "hello.txt" }]);
  });
});

test("global MIME policy rejects unlisted types and forged signatures before publication", async () => {
  await fixture({}, { allowedMimeTypes: ["image/png", "text/plain"] }, async db => {
    const denied = await upload(db, guest, { type: "application/pdf" });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "FILE_MIME_TYPE_NOT_ALLOWED");
    const pending = await upload(db, guest, { type: "image/png" });
    assert.equal(pending.ok, true);
    const completed = await completePendingFileUpload(db, pending.data.uploadUrl.split("/").pop(), Readable.from([Buffer.from("hello")]));
    assert.equal(completed.ok, false);
    assert.equal(completed.error.code, "FILE_MIME_TYPE_MISMATCH");
    const text = await upload(db, guest, { name: "valid.txt" });
    const accepted = await completePendingFileUpload(db, text.data.uploadUrl.split("/").pop(), Readable.from([Buffer.from("hello")]));
    assert.equal(accepted.ok, true);
  });
});

async function storedFile(db, auth, name) {
  const pending = await upload(db, auth, { name });
  assert.equal(pending.ok, true);
  const completed = await completePendingFileUpload(db, pending.data.uploadUrl.split("/").pop(), Readable.from([Buffer.from("hello")]));
  assert.equal(completed.ok, true);
  return completed.data.file;
}

test("privileged sweep deletes only old unreferenced files and leaked listing loses authority", async () => {
  let leaked;
  const referenced = new Set();
  const definition = { mutations: {
    sweep: mutation((ctx, cutoff) => ctx.privileged.run({ operation: "files.sweep", targetResourceKind: "file" }, async p => {
      leaked = p.files;
      const deleted = [];
      let cursor;
      do {
        const page = await p.files.list({ createdBefore: cutoff, cursor });
        assert.equal(page.ok, true, page.error?.message);
        for (const file of page.data.files) {
          if (!referenced.has(file.id)) {
            const result = await p.files.delete(file.id);
            assert.equal(result.ok, true);
            deleted.push(file.id);
          }
        }
        cursor = page.data.cursor;
      } while (cursor);
      return deleted;
    })),
    ordinary: mutation(ctx => typeof ctx.files.list),
  } };
  await fixture(definition, {}, async db => {
    const keep = await storedFile(db, member, "referenced.txt");
    referenced.add(keep.id);
    const orphan = await storedFile(db, guest, "orphan.txt");
    await new Promise(resolve => setTimeout(resolve, 5));
    const cutoff = new Date().toISOString();
    const recent = await storedFile(db, guest, "recent.txt");
    const result = await runMutation(db, member, "sweep", [cutoff]);
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.data, [orphan.id]);
    assert.equal((await leaked.list()).ok, false);
    assert.equal((await runMutation(db, guest, "ordinary", [])).data, "undefined");
    // Verify storage visibility through the ordinary File URL seam.
    const { getPrivateFileUrl } = await import("../dist/file-storage-runtime.js");
    assert.equal((await getPrivateFileUrl(db, member, keep.id)).ok, true);
    assert.equal((await getPrivateFileUrl(db, guest, recent.id)).ok, true);
    assert.equal((await getPrivateFileUrl(db, guest, orphan.id)).ok, false);
  });
});

test("upload ACL metadata size cannot be bypassed by a larger PUT", async () => {
  await fixture({ files: { acl: { upload: (_ctx, meta) => meta.sizeBytes <= 1 } } }, {}, async db => {
    const pending = await upload(db, guest, { size: 1 });
    assert.equal(pending.ok, true);
    const result = await completePendingFileUpload(db, pending.data.uploadUrl.split("/").pop(), Readable.from([Buffer.from("hello")]));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "FILE_UPLOAD_SIZE_MISMATCH");
  });
});

test("MIME config rejects malformed allowlists and empty lists deny all uploads", async () => {
  for (const allowedMimeTypes of [null, "image/png", ["image/*"], [123], ["Text/Plain"]]) {
    await assert.rejects(fixture({}, { allowedMimeTypes }, () => {}), { code: "INVALID_FILE_CONFIG" });
  }
  await fixture({}, { allowedMimeTypes: [] }, async db => {
    assert.equal((await upload(db)).error.code, "FILE_MIME_TYPE_NOT_ALLOWED");
  });
});

test("upload hook exceptions deny opaquely and absent policies preserve guest uploads", async () => {
  await fixture({ files: { acl: { upload: () => { throw new Error("private policy detail"); } } } }, {}, async db => {
    const result = await upload(db);
    assert.equal(result.error.code, "FILE_UPLOAD_DENIED");
    assert.doesNotMatch(JSON.stringify(result), /private policy detail/);
  });
  await fixture({}, {}, async db => assert.equal((await upload(db, guest, { type: "custom/anything" })).ok, true));
});

test("privileged listing paginates across deletions with a fixed cutoff and validates cursors", async () => {
  const seen = [];
  await fixture({ mutations: {
    page: mutation((ctx, options) => ctx.privileged.run({ operation: "files.page", targetResourceKind: "file" }, p => p.files.list(options))),
    remove: mutation((ctx, id) => ctx.privileged.run({ operation: "files.remove", targetResourceKind: "file" }, p => p.files.delete(id))),
  } }, {}, async db => {
    for (let i = 0; i < 102; i++) seen.push((await storedFile(db, guest, `page-${i}.txt`)).id);
    const first = (await runMutation(db, member, "page", [{}])).data;
    assert.equal(first.ok, true);
    assert.equal(first.data.files.length, 100);
    assert.equal(typeof first.data.files[0].createdAt, "string");
    assert.equal(first.data.files[0].ownerId, guest.userId);
    const last = first.data.files.at(-1);
    // Deleting the row anchoring the cursor must not skip later candidates.
    assert.equal((await runMutation(db, member, "remove", [last.id])).data.ok, true);
    const second = (await runMutation(db, member, "page", [{ cursor: first.data.cursor }])).data;
    assert.equal(second.data.cursor, null);
    assert.deepEqual(new Set([...first.data.files, ...second.data.files].map(f => f.id)), new Set(seen));
    for (const options of [{ cursor: "bad" }, { createdBefore: "bad" }, { cursor: first.data.cursor, createdBefore: "2000-01-01" }]) {
      const invalid = (await runMutation(db, member, "page", [options])).data;
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, "INVALID_FILE_LIST_OPTIONS");
    }
  });
});

test("global MIME policy narrows multipart ingress even without an endpoint allowlist", async () => {
  const { stageMultipartIngress } = await import("../dist/file-ingress-runtime.js");
  const policy = { maxFiles: 1, maxFileBytes: 1024, maxTotalFileBytes: 1024, maxFieldCount: 1, maxFieldBytes: 1024, maxTotalFieldBytes: 1024, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id" };
  await fixture({}, { allowedMimeTypes: ["image/png"] }, async db => {
    const body = '--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--boundary--';
    await assert.rejects(stageMultipartIngress(db, { options: { method: "POST", path: "/ingress", body: { multipart: policy } } }, Readable.from([Buffer.from(body)]), { headers: { "content-type": "multipart/form-data; boundary=boundary", "idempotency-key": "request" } }, guest), { code: "FILE_MIME_TYPE_NOT_ALLOWED" });
  });
});

test("MIME signature policy accepts a real PNG and preserves the previous version on a rejected replacement", async () => {
  const { getPrivateFileUrl } = await import("../dist/file-storage-runtime.js");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  await fixture({}, { allowedMimeTypes: ["image/png"] }, async db => {
    const pending = await upload(db, guest, { name: "pixel.png", type: "image/png", size: png.length });
    const stored = await completePendingFileUpload(db, pending.data.uploadUrl.split("/").pop(), Readable.from([png]));
    assert.equal(stored.ok, true);
    const replacement = await createPendingFileUpload(db, guest, { replace: true, fileId: stored.data.file.id, file: { name: "pixel.png", type: "image/png", size: 5 } });
    assert.equal(replacement.ok, true);
    const rejected = await completePendingFileUpload(db, replacement.data.uploadUrl.split("/").pop(), Readable.from([Buffer.from("hello")]));
    assert.equal(rejected.error.code, "FILE_MIME_TYPE_MISMATCH");
    const retained = await getPrivateFileUrl(db, guest, stored.data.file.id);
    assert.equal(retained.ok, true);
    assert.equal(retained.data.file.version, stored.data.file.version);
    assert.equal(retained.data.file.size, png.length);
  });
});

test("schedule-owned Jobs receive privileged File listing directly", async () => {
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const pages = [];
  await fixture({
    jobs: { scanFiles: job(async ctx => { pages.push(await ctx.files.list()); return null; }) },
    schedules: { scan: schedule({ expression: "* * * * *", timezone: "UTC", job: "scanFiles", payload: {} }) },
  }, {}, async db => {
    await db.init();
    const file = await storedFile(db, guest, "scheduled.txt");
    clock.advanceBy(60_001);
    await clock.runDueTimers();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].ok, true);
    assert.deepEqual(pages[0].data.files.map(item => item.id), [file.id]);
  }, { clock });
});
