// The Capsule runtime's file and object storage domain: the two storage engines and the S3
// signature that reaches one of them, the upload lifecycle behind `files.upload()`, the private and
// public File URLs, and the File metadata table the whole of it is bookkept in. Batch 6 of the
// migration ADR-0041 records. Apart from the eight `nodeCryptoModule.` prefixes explained below,
// every body here is byte-identical to the one that stood in `server-runtime-source.ts`.
//
// **The domain is 51 declarations and one type alias, and that was established by closing the
// reference graph rather than by matching names.** The ticket estimated ~54 from a name sweep, and
// the sweep is wrong in both directions at once: three of the functions it would collect are not
// this domain's, and two of this domain's do not appear under any file-shaped name.
//
// Three that a name sweep collects and that are *not* here, each identified by having no in-domain
// caller at all:
//
//   - `runSchemaExecIgnoringDuplicateColumn` and `isDuplicateColumnError` sit in the middle of the
//     file region and no file function calls either. The only caller is `sqliteDatabaseDialect`'s
//     `addMissingColumn`, so they are the dialect's and travel with the adapters in batch 9.
//   - `chainSchemaOperation` is the same shape: declared between two file helpers, called only by
//     `createLogIndexTables` and `backfillLogIndexSequences`. It belongs to the log index.
//
// Layout is not membership, which is the transferable half of this: all three were adjacent to the
// domain in the file and none of them is in it, and the only thing that showed that was asking who
// calls them.
//
// **What could not leave, and what holds it.** Two functions of this domain are still in the
// monolith: `handleFileHttpRoute` and `sendFileHttpResponse`. Both reach `writeNotFound` and
// `writeJsonHttpResponse`, whose other consumer is `routeRuntimeHealth` — generic HTTP response
// writers owned by the HTTP layer, which is batch 8. A migrated module may not import from the
// monolith, so they follow their blocker. The holder is a domain and not the composition core, and
// it is a domain that has not run yet rather than the last one, so batch 8 lifts those two along
// with the writers and imports the rest from here. Nothing else of this domain is held: the upload
// lifecycle, both URL paths, the S3 signature, both engines and the metadata table are all here.
//
// `fileRowForOwner` and `contentTypeForFile` are *called* only by those two and moved anyway,
// because they are storage logic rather than plumbing — ownership resolution over an id or an
// absolute File path, and the inline content-type allow-list — and leaving them would have split
// `resolveLiveFileReference` from its caller for no gain. The monolith imports both back.
//
// **Why this batch also created `maybe-promise.ts`.** Closing the graph left one more thing outside
// the domain, and it was not a later batch's: `thenIfPromise` and `chainMaybePromise`, the sync/async
// bridge six domains use and none owns. Left in the monolith they would have held
// `singleLiveFileRowByPath`, `singleActiveFileRowByPath` and `createFileStorageTables` — and through
// the first, `resolveLiveFileReference`, `createPendingFileUpload`, `getPrivateFileUrl`,
// `createPublicFileUrl`, `deletePrivateFile` and `fileRowForOwner`. That is the whole upload
// lifecycle and both URL paths held by a four-line utility, which is exactly the case
// `runtime-errors.js` was created for in batch 3. See that module's header for the argument.
//
// **What is exported and what is not.** 24 of the 51 are exported and 27 are private, against 9
// exported and 42 registered before the move. Under the emitted list every one of the 42 had to be
// an entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a `ReferenceError` in a deployed Capsule,
// so "private" was not a thing this domain could be. It is now: `s3Request`, `s3SigningKey`,
// `s3Hmac`, `s3Sha256Hex`, `s3SignedHeaders`, `s3RequestBodyBuffer`, `s3EncodedPathSegment`,
// `s3AmzDate`, `s3StorageNamespace` and `s3ObjectNotFoundError` — the whole S3 request path bar the
// three pure functions the skew probe calls — are named in no list at all.
//
// The exports are not a designed interface. They are the names something outside this file still
// resolves, in three groups:
//
//   - What the monolith calls: `createRuntimeFileStorageAdapter` (`openDevDatabase`),
//     `checkRuntimeFileStorage` (the runtime health route), `createFileStorageTables` (the shared
//     adapter method set), the five the WebSocket hub dispatches — `createPendingFileUpload`,
//     `getPrivateFileUrl`, `createPublicFileUrl`, `revokePublicFileUrl`, `deletePrivateFile` — the
//     four the privileged Server-role File API reaches (`resolvePrivilegedLiveFileReference`,
//     `fileMetadataFromRow`, `createStructuredFileError` and two of the five above), the two the
//     ACL storage helper resolves a File reference with (`normalizeAbsoluteFilePath`,
//     `isAbsoluteFilePath`), and the three the two stranded HTTP functions need
//     (`completePendingFileUpload`, `fileRowForOwner`, `contentTypeForFile`).
//   - What `test/database-adapter.test.js` imports through the re-export bridge: both engine
//     constructors and eight of the lifecycle entry points. Those are named imports, so they resolve
//     or fail to compile.
//
// **Six more were exported until ticket 05, and are private again now.** `s3Signature`,
// `s3CanonicalPath`, `s3ObjectKey`, `validatePublicUrlExpiry`, `normalizeFileName` and
// `fileMetadataFromUpload` were exported for the two-bundle skew probe and for nothing else — a
// deliberate widening at the time, because that probe was synchronous while this domain's entry
// points are `async` and take a database adapter, so without the six the only limbs it could compare
// were the two engine constructors and the AWS SigV4 signature, the File path rules and the
// public-URL expiry gate would have been carried into every deployed Capsule uncompared. The probe
// went with the emitted-list builder, so the widening had nothing left to serve and the six are back
// behind the module boundary where the domain's own header says they belong.
//
// `resolveLiveFileReference` is this module's census sentinel in
// `test/database-adapter-engine-seam.test.js`, and it is private for the sixth batch running. It is
// the function every ownership-scoped File lookup passes through — five callers here, and no honest
// edit to this domain removes it — and it is exported from nothing and registered in nothing. Under
// the emitted list it was an entry, so it was visible to those guards by being registered; finding
// it there now is the evidence that 27 newly-private storage helpers, most of the S3 request path
// among them, did not leave the census by becoming private.
//
// **Why `node:crypto` is reached through `process.getBuiltinModule` and not imported.** ADR-0042,
// for the third domain to need it. `s3Hmac` and `s3Sha256Hex` are synchronous and inside the
// signature calculation `s3Request` builds before it opens a socket, so `await import(…)` would
// change their signatures and every caller's, and neither `createHmac` nor a synchronous
// `createHash` has a Web Crypto equivalent. `randomUUID` does — mail reaches the global for exactly
// that reason — but this module already binds the namespace for the other two, and one mechanism is
// better than two in one file, so the six `randomUUID` call sites take the accessor as
// `auth-runtime.ts`'s four do. Those eight lines are the only ones here that are not byte-identical
// to the region they moved out of.
//
// The accessor is a namespace binding and not a destructuring, for the `bin/` renaming reason
// ADR-0041 and ADR-0042 both record: `bin/sporades.js` is the whole of `src/` in one esbuild scope,
// so a top-level `createHash` here would collide with `server-runtime-source.ts`'s
// `import … from "node:crypto"` and esbuild would rename one side, leaving every still-registered
// runtime function travelling into the emitted bundle as source text calling the renamed name.
// `nodeCryptoModule` collides with `auth-runtime.ts` and `jobs-runtime.ts`, which is safe and
// deliberate: a private module-scope name never leaves its module, so esbuild renames its
// declaration and its uses together.
//
// **The three `await import(…)` calls survive as themselves.** `s3Request` picks its transport with
// `await import(isHttps ? "node:https" : "node:http")`, and the local engine reaches
// `node:fs/promises` and `node:path` the same way. esbuild rewrites the conditional specifier into
// two analyzable dynamic imports and emits all of them verbatim, so the carrier's metafile check
// sees only builtins behind `kind: "dynamic-import"` — which is the one external ADR-0041 allows,
// and the route the SMTP transport has always taken.

import type { WithImplicitCoercion } from "buffer";
import type { BinaryLike, KeyObject } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { chainMaybePromise, thenIfPromise } from "./maybe-promise.js";
import { applyFileAcl } from "./acl-runtime.js";
import type { HelperError } from "./runtime-errors.js";

// Synchronous access to a Node builtin without an import — see the header. `process` is a global in
// both places this module runs: `dist/file-storage-runtime.js` loaded as an ES module, and the
// esbuild IIFE the emitted-list bundle splices into a deployed Capsule.
const nodeCryptoModule = process.getBuiltinModule("node:crypto");

// The monolith's own aliases, redeclared rather than imported: they are types, so they are erased
// before either bundle is built and there is no binding to collide with. `S3RequestResult` is this
// domain's own and was declared beside them at the top of that file rather than beside `s3Request`,
// which is the only thing that reads it.
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
type S3RequestResult = {
  statusCode: number;
  headers: IncomingHttpHeaders | LooseRecord;
  body: Buffer;
};

export async function createRuntimeFileStorageAdapter({ config = {}, databasePath, serviceEnv = {} }: { config?: RuntimeConfig; databasePath: string; serviceEnv?: RuntimeEnv }) {
  const path = await import("node:path");
  if (config.services?.storage?.engine === "minio" && serviceEnv.SPORADES_SERVICE_STORAGE_ENGINE === "minio") {
    return createS3CompatibleFileStorageAdapter({
      endpoint: serviceEnv.SPORADES_SERVICE_STORAGE_ENDPOINT ?? "",
      bucket: serviceEnv.SPORADES_SERVICE_STORAGE_BUCKET ?? "sporades",
      region: serviceEnv.SPORADES_SERVICE_STORAGE_REGION ?? "us-east-1",
      accessKey: serviceEnv.SPORADES_SERVICE_STORAGE_ACCESS_KEY ?? "",
      secretKey: serviceEnv.SPORADES_SERVICE_STORAGE_SECRET_KEY ?? "",
      namespace: serviceEnv.SPORADES_SERVICE_STORAGE_NAMESPACE ?? "capsule",
    });
  }
  return createLocalFileStorageAdapter({
    storagePath: config.files?.storagePath ?? path.join(path.dirname(databasePath), "files"),
  });
}

export function createLocalFileStorageAdapter({ storagePath }: { storagePath: string }) {
  if (typeof storagePath !== "string" || storagePath.length === 0) {
    throw new Error("Local file storage requires a storagePath.");
  }

  return {
    engine: "local",
    storagePath,
    async writeFileVersion({ fileId, version, bytes }: { fileId: string; version: string | number; bytes: Uint8Array | Buffer | string }) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(localFileStoragePath(storagePath, fileId), { recursive: true });
      await writeFile(localFileVersionPath(storagePath, fileId, version), bytes);
    },
    async readFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
      const { readFile } = await import("node:fs/promises");
      return await readFile(localFileVersionPath(storagePath, fileId, version));
    },
    async deleteFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
      const { rm } = await import("node:fs/promises");
      await rm(localFileVersionPath(storagePath, fileId, version), { force: true });
    },
    async checkHealth() {
      const { mkdir, rm, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const probeDirectory = path.join(storagePath, ".sporades-health");
      const probeFile = path.join(probeDirectory, `${nodeCryptoModule.randomUUID()}.tmp`);
      try {
        await mkdir(probeDirectory, { recursive: true });
        await writeFile(probeFile, "");
        await rm(probeFile, { force: true });
        return { ok: true };
      } catch {
        await rm(probeFile, { force: true }).catch(() => { });
        return { ok: false };
      }
    },
    close() { },
  };
}

function localFileStoragePath(storagePath: string, fileId: string) {
  return `${storagePath}/${fileId}`;
}

function localFileVersionPath(storagePath: string, fileId: string, version: string | number) {
  return `${localFileStoragePath(storagePath, fileId)}/${version}`;
}

export function createS3CompatibleFileStorageAdapter({
  endpoint,
  bucket,
  region,
  accessKey,
  secretKey,
  namespace,
}: {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  namespace: string;
}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("S3-compatible file storage requires an endpoint.");
  }
  if (typeof bucket !== "string" || bucket.length === 0) {
    throw new Error("S3-compatible file storage requires a bucket.");
  }
  if (typeof region !== "string" || region.length === 0) {
    throw new Error("S3-compatible file storage requires a region.");
  }
  if (typeof accessKey !== "string" || accessKey.length === 0 || typeof secretKey !== "string" || secretKey.length === 0) {
    throw new Error("S3-compatible file storage requires access credentials.");
  }
  const isolatedNamespace = s3StorageNamespace(namespace);

  const config = { endpoint, bucket, region, accessKey, secretKey };
  let bucketReady = false;
  const ensureBucket = async () => {
    if (bucketReady) {
      return;
    }
    const head = await s3Request(config, { method: "HEAD", key: null });
    if (head.statusCode === 404) {
      const created = await s3Request(config, { method: "PUT", key: null, body: Buffer.alloc(0) });
      if (created.statusCode < 200 || created.statusCode >= 300) {
        throw new Error(`S3-compatible file storage bucket setup failed with HTTP ${created.statusCode}.`);
      }
    } else if (head.statusCode < 200 || head.statusCode >= 300) {
      throw new Error(`S3-compatible file storage bucket check failed with HTTP ${head.statusCode}.`);
    }
    bucketReady = true;
  };

  return {
    engine: "s3-compatible",
    endpoint,
    bucket,
    region,
    namespace: isolatedNamespace,
    objectKeyPrefix: `${isolatedNamespace}/files`,
    async writeFileVersion({ fileId, version, bytes }: { fileId: string; version: string | number; bytes: Uint8Array | Buffer | string }) {
      await ensureBucket();
      const result = await s3Request(config, {
        method: "PUT",
        key: s3ObjectKey(isolatedNamespace, fileId, version),
        body: bytes,
      });
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`S3-compatible file write failed with HTTP ${result.statusCode}.`);
      }
    },
    async readFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
      const result = await s3Request(config, {
        method: "GET",
        key: s3ObjectKey(isolatedNamespace, fileId, version),
      });
      if (result.statusCode === 404) {
        throw s3ObjectNotFoundError();
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`S3-compatible file read failed with HTTP ${result.statusCode}.`);
      }
      return result.body;
    },
    async deleteFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
      const result = await s3Request(config, {
        method: "DELETE",
        key: s3ObjectKey(isolatedNamespace, fileId, version),
      });
      if (result.statusCode === 404) {
        return;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`S3-compatible file delete failed with HTTP ${result.statusCode}.`);
      }
    },
    async checkHealth() {
      try {
        await ensureBucket();
        return { ok: true, adapter: "s3-compatible" };
      } catch {
        return { ok: false, adapter: "s3-compatible" };
      }
    },
    close() { },
  };
}

function s3ObjectKey(namespace: string, fileId: string, version: string | number) {
  return `${namespace}/files/${fileId}/${version}`;
}

async function s3Request(
  config: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string },
  { method, key = null, body = null }: { method: string; key: string | null; body?: any },
): Promise<S3RequestResult> {
  const endpoint = new URL(config.endpoint);
  const isHttps = endpoint.protocol === "https:";
  const transport = await import(isHttps ? "node:https" : "node:http");
  const payload = s3RequestBodyBuffer(body);
  const amzDate = s3AmzDate(new Date());
  const date = amzDate.slice(0, 8);
  const pathname = s3CanonicalPath(endpoint.pathname, config.bucket, key);
  const payloadHash = s3Sha256Hex(payload);
  const headers = s3SignedHeaders({
    "host": endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  headers.authorization = s3Signature({
    method,
    pathname,
    query: "",
    headers,
    payloadHash,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
    date,
    amzDate,
  });

  return await new Promise<S3RequestResult>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        method,
        path: `${pathname}${endpoint.search}`,
        headers: {
          ...headers,
          "content-length": payload.length,
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: any) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    if (payload.length > 0) {
      request.write(payload);
    }
    request.end();
  });
}

function s3RequestBodyBuffer(body: WithImplicitCoercion<ArrayLike<number>> | null | undefined) {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body));
}

function s3SignedHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function s3Signature({
  method,
  pathname,
  query,
  headers,
  payloadHash,
  accessKey,
  secretKey,
  region,
  date,
  amzDate,
}: {
  method: string;
  pathname: string;
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  date: string;
  amzDate: string;
}) {
  const signedHeaders = Object.keys(headers).join(";");
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, s3Sha256Hex(canonicalRequest)].join("\n");
  const signature = s3Hmac(s3SigningKey(secretKey, date, region), stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function s3SigningKey(secretKey: any, date: any, region: any) {
  const dateKey = s3Hmac(`AWS4${secretKey}`, date);
  const dateRegionKey = s3Hmac(dateKey, region);
  const dateRegionServiceKey = s3Hmac(dateRegionKey, "s3");
  return s3Hmac(dateRegionServiceKey, "aws4_request");
}

function s3CanonicalPath(basePath: string, bucket: string, key: string | null) {
  const base = String(basePath ?? "")
    .split("/")
    .filter(Boolean);
  const parts = [...base, bucket, ...(key ? String(key).split("/") : [])].map(s3EncodedPathSegment);
  return `/${parts.join("/")}`;
}

function s3EncodedPathSegment(segment: string | number | boolean) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function s3StorageNamespace(namespace: string) {
  if (typeof namespace !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) {
    throw new Error("S3-compatible file storage requires a capsule storage namespace.");
  }
  return `capsules/${namespace}`;
}

function s3AmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function s3Hmac(key: BinaryLike | NonSharedBuffer | KeyObject, data: BinaryLike) {
  return nodeCryptoModule.createHmac("sha256", key).update(data).digest();
}

function s3Sha256Hex(data: BinaryLike | Buffer<ArrayBufferLike>) {
  return nodeCryptoModule.createHash("sha256").update(data).digest("hex");
}

function s3ObjectNotFoundError() {
  const error: HelperError = new Error("S3-compatible file object not found.");
  error.code = "ENOENT";
  return error;
}

export async function checkRuntimeFileStorage(database: LooseRecord) {
  return await database.fileStorage.checkHealth();
}

// The one definition of the File metadata storage bootstrap, for every engine. Chained rather than
// fired, and outside any transaction, for the reasons `createAnonymousAuthTables` records.
export function createFileStorageTables(sqlite: LooseRecord) {
  const sql = sqlite.dialect.sql;
  return chainMaybePromise([
    () =>
      sqlite.exec(
        sql(
          "CREATE TABLE IF NOT EXISTS [sporades_file_buckets] (" +
          "[id] TEXT PRIMARY KEY, " +
          "[ownerId] TEXT NOT NULL, " +
          "[name] TEXT NOT NULL, " +
          "[createdAt] TEXT NOT NULL, " +
          "UNIQUE([ownerId], [name])" +
          ")",
        ),
      ),
    () =>
      sqlite.exec(
        sql(
          "CREATE TABLE IF NOT EXISTS [sporades_files] (" +
          "[id] TEXT PRIMARY KEY, " +
          "[ownerId] TEXT NOT NULL, " +
          "[bucketId] TEXT NOT NULL, " +
          "[bucketName] TEXT NOT NULL, " +
          "[path] TEXT NOT NULL, " +
          "[name] TEXT NOT NULL, " +
          "[type] TEXT NOT NULL, " +
          "[size] INTEGER NOT NULL, " +
          "[version] TEXT NOT NULL, " +
          "[status] TEXT NOT NULL, " +
          "[createdAt] TEXT NOT NULL, " +
          "[updatedAt] TEXT NOT NULL, " +
          "[deletedAt] TEXT" +
          ")",
        ),
      ),
    () => sqlite.dialect.addMissingColumn(sqlite, "sporades_files", "path", "TEXT"),
    () => sqlite.exec(sql(filePathBackfillSql())),
    () => sqlite.exec(sql(activeFilePathDedupeSql())),
    () =>
      sqlite.exec(
        sql("CREATE INDEX IF NOT EXISTS [sporades_files_path_live] ON [sporades_files] ([path], [deletedAt], [status])"),
      ),
    () =>
      sqlite.exec(
        sql(
          "CREATE UNIQUE INDEX IF NOT EXISTS [sporades_files_path_active_unique] " +
          "ON [sporades_files] ([path]) WHERE [deletedAt] IS NULL AND [status] IN ('pending', 'uploaded')",
        ),
      ),
    () =>
      sqlite.exec(
        sql(
          "CREATE TABLE IF NOT EXISTS [sporades_file_uploads] (" +
          "[id] TEXT PRIMARY KEY, " +
          "[fileId] TEXT NOT NULL, " +
          "[ownerId] TEXT NOT NULL, " +
          "[bucketId] TEXT NOT NULL, " +
          "[bucketName] TEXT NOT NULL, " +
          "[path] TEXT NOT NULL, " +
          "[name] TEXT NOT NULL, " +
          "[type] TEXT NOT NULL, " +
          "[version] TEXT NOT NULL, " +
          "[expectedSize] INTEGER NOT NULL, " +
          "[createdAt] TEXT NOT NULL" +
          ")",
        ),
      ),
    () => ensureFileUploadTargetColumns(sqlite),
    () =>
      sqlite.exec(
        sql(
          "CREATE TABLE IF NOT EXISTS [sporades_file_public_urls] (" +
          "[id] TEXT PRIMARY KEY, " +
          "[fileId] TEXT NOT NULL, " +
          "[ownerId] TEXT NOT NULL, " +
          "[version] TEXT NOT NULL, " +
          "[expiresAt] TEXT, " +
          "[createdAt] TEXT NOT NULL, " +
          "[revokedAt] TEXT" +
          ")",
        ),
      ),
  ]);
}

async function readRequestBytes(request: any, maxBytes: number) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${maxBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function contentTypeForFile(type: any) {
  if (typeof type !== "string") {
    return "application/octet-stream";
  }
  const normalized = type.split(";")[0].trim().toLowerCase();
  const safeInlineTypes = new Set([
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
  ]);
  return safeInlineTypes.has(normalized) ? normalized : "application/octet-stream";
}

export async function createPendingFileUpload(database: LooseRecord, auth: LooseRecord, message: LooseRecord) {
  const input = message.file ?? {};
  const size = Number(input.size ?? 0);
  if (!Number.isFinite(size) || size < 0) {
    return {
      ok: false,
      error: createStructuredFileError("Invalid file size.", "Pass a browser File or Blob with a finite size."),
    };
  }
  if (size > database.fileMaxSizeBytes) {
    return {
      ok: false,
      error: createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${database.fileMaxSizeBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      ),
    };
  }

  return await withFileUploadPathLock("capsule", async () => {
    const now = new Date().toISOString();
    const replacing = message.replace === true;
    const replaceReference = message.fileReference ?? message.fileId;
    const resolvedReplacement: any = replacing ? await resolveLiveFileReference(database, auth.userId, replaceReference) : { ok: true, row: null };
    if (!resolvedReplacement.ok) {
      return resolvedReplacement;
    }
    const existingByReference = resolvedReplacement.row;
    if (replacing && !existingByReference) {
      return {
        ok: false,
        error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
      };
    }
    return await database.adapter.withTransaction(async (sqlite: { selectPendingFileUploadByPath: (arg0: any) => any; deleteFileUploadsForPath: (arg0: any) => any; insertFileUpload: (arg0: { id: `${string}-${string}-${string}-${string}-${string}`; fileId: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: string; version: `${string}-${string}-${string}-${string}-${string}`; expectedSize: number; createdAt: string; }) => any; }) => {
      const transactionDatabase = { ...database, sqlite, adapter: sqlite };
      let target;
      try {
        target =
          replacing && existingByReference && (input.path === undefined || input.path === null)
            ? { bucket: { id: existingByReference.bucketId, name: existingByReference.bucketName }, path: existingByReference.path }
            : await resolveFileWriteTarget(transactionDatabase, auth.userId, input, now);
      } catch (error: any) {
        return {
          ok: false,
          error: createStructuredFileError(error.message, error.hint ?? "Pass a valid absolute File path."),
        };
      }
      const existingByPath = target.path ? await singleActiveFileRowByPath(transactionDatabase, target.path) : null;
      if (existingByPath?.ambiguous) {
        return ambiguousFileReferenceError(target.path);
      }
      if (existingByPath && existingByPath.ownerId !== auth.userId) {
        return {
          ok: false,
          error: createStructuredFileError(
            "File path already exists.",
            "Choose another absolute File path or ask the owning user to delete the existing file first.",
          ),
        };
      }
      const pendingByPath =
        !existingByReference && !existingByPath && target.path
          ? await sqlite.selectPendingFileUploadByPath(target.path)
          : null;
      const existing = existingByReference ?? existingByPath;
      const fileId = existing?.id ?? (pendingByPath?.ownerId === auth.userId ? pendingByPath.fileId : null) ?? nodeCryptoModule.randomUUID();

      const uploadId = nodeCryptoModule.randomUUID();
      const version = nodeCryptoModule.randomUUID();
      const name = normalizeFileName(input.name, target.path);
      const type = String(input.type ?? "application/octet-stream");
      await sqlite.deleteFileUploadsForPath(target.path);
      try {
        await sqlite.insertFileUpload({
          id: uploadId,
          fileId,
          ownerId: auth.userId,
          bucketId: target.bucket.id,
          bucketName: target.bucket.name,
          path: target.path,
          name,
          type,
          version,
          expectedSize: size,
          createdAt: now,
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const current = await sqlite.selectPendingFileUploadByPath(target.path);
        if (!current) throw error;
        return {
          ok: true,
          data: {
            uploadUrl: `/__sporades/uploads/${current.id}`,
            method: "PUT",
            headers: {},
            file: fileMetadataFromUpload(current),
          },
          error: null as any,
        };
      }

      return {
        ok: true,
        data: {
          uploadUrl: `/__sporades/uploads/${uploadId}`,
          method: "PUT",
          headers: {},
          file: fileMetadataFromUpload({
            fileId,
            bucketName: target.bucket.name,
            path: target.path,
            name,
            type,
            expectedSize: size,
            version,
          }),
        },
        error: null,
      };
    });
  });
}

export async function completePendingFileUpload(database: LooseRecord, uploadId: string, request: any, websocketHub: any = null) {
  const upload = await database.adapter.selectFileUpload(uploadId);
  if (!upload) {
    return {
      ok: false,
      data: null,
      error: createStructuredFileError("Upload URL not found.", "Request a fresh upload URL from the Sporades client SDK."),
    };
  }

  let wroteFileVersion = false;
  const previousFile = await database.adapter.selectFileById(upload.fileId);
  try {
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.progress",
      fileId: upload.fileId,
      loaded: 0,
      total: upload.expectedSize,
    });
    const bytes = await readRequestBytes(request, database.fileMaxSizeBytes);
    await database.fileStorage.writeFileVersion({ fileId: upload.fileId, version: upload.version, bytes });
    wroteFileVersion = true;
    const now = new Date().toISOString();
    const completion = await database.adapter.withTransaction(async (sqlite: LooseRecord) => {
      const completed = await sqlite.completeFileUpload(upload, bytes.length, now);
      if (completed?.changes === 0) {
        return { ok: false, superseded: true };
      }
      await sqlite.revokePublicFileUrlsForFile(upload.fileId, now);
      return { ok: true, row: await sqlite.selectFileById(upload.fileId) };
    });
    if (!completion.ok && completion.superseded) {
      await removeFileVersionBestEffort(database, upload.fileId, upload.version);
      return {
        ok: false,
        data: null,
        error: createStructuredFileError(
          "Upload URL was superseded.",
          "Request a fresh upload URL before retrying this file upload.",
        ),
      };
    }
    if (previousFile && previousFile.deletedAt == null && previousFile.status === "uploaded" && previousFile.version !== upload.version) {
      await removeFileVersionBestEffort(database, previousFile.id, previousFile.version);
    }
    const file = fileMetadataFromRow(completion.row);
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.complete",
      file,
    });
    return { ok: true, data: { file }, error: null as any };
  } catch (error: any) {
    if (wroteFileVersion) {
      await removeFileVersionBestEffort(database, upload.fileId, upload.version);
    }
    const structuredError = isUniqueConstraintError(error)
      ? createStructuredFileError("Upload URL was superseded.", "Request a fresh upload URL before retrying this file upload.")
      : {
        message: error.message,
        hint: error.hint ?? "Request a fresh upload URL and retry.",
      };
    websocketHub?.notifyFileEvent?.(upload.ownerId, {
      type: "file.upload.failed",
      fileId: upload.fileId,
      error: structuredError,
    });
    return {
      ok: false,
      data: null,
      error: structuredError,
    };
  }
}

export async function getPrivateFileUrl(database: any, auth: LooseRecord, fileReference: any) {
  const resolved: any = await resolveAccessibleFileReference(database, auth, fileReference, "read");
  if (!resolved.ok) {
    return resolved;
  }
  const row = resolved.row;
  if (!row) {
    return {
      ok: false,
      error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
    };
  }
  return {
    ok: true,
    data: {
      url: `/__sporades/files/private/${row.id}?v=${encodeURIComponent(row.version)}`,
      file: fileMetadataFromRow(row),
    },
    error: null as any,
  };
}

export async function createPublicFileUrl(database: LooseRecord, auth: LooseRecord, fileReference: any, options: LooseRecord = {}) {
  const expiry = validatePublicUrlExpiry(options);
  if (!expiry.ok) {
    return expiry;
  }
  return await runFileMetadataTransaction(database, async (sqlite: LooseRecord) => {
    const transactionDatabase = { ...database, sqlite, adapter: sqlite };
    const resolved: any = await resolveAccessibleFileReference(transactionDatabase, auth, fileReference, "publicUrl");
    if (!resolved.ok) {
      return resolved;
    }
    const row = resolved.row;
    if (!row) {
      return {
        ok: false,
        error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
      };
    }
    const id = nodeCryptoModule.randomUUID();
    const now = new Date().toISOString();
    await sqlite.insertPublicFileUrl({
      id,
      fileId: row.id,
      // A File ACL permits the operation; it does not transfer the File or
      // create an independent public capability. Keep revocation with the
      // File owner so a collaborating Team member cannot strand a URL that
      // the owner is unable to revoke.
      ownerId: row.ownerId,
      version: row.version,
      expiresAt: expiry.expiresAt,
      createdAt: now,
    });
    return {
      ok: true,
      data: {
        publicUrl: {
          id,
          fileId: row.id,
          url: `/__sporades/files/public/${id}?v=${encodeURIComponent(row.version)}`,
          expiresAt: expiry.expiresAt,
          revokedAt: null,
        },
      },
      error: null as any,
    };
  });
}

export async function revokePublicFileUrl(database: LooseRecord, auth: LooseRecord, publicUrlId: any) {
  const now = new Date().toISOString();
  const result = await database.adapter.revokePublicFileUrl(publicUrlId, auth.userId, now);
  if (result.changes === 0) {
    return {
      ok: false,
      error: createStructuredFileError("Public file URL not found.", "Pass a public URL id owned by the current user."),
    };
  }
  return {
    ok: true,
    data: { publicUrl: { id: publicUrlId, revokedAt: now } },
    error: null as any,
  };
}

export async function deletePrivateFile(database: LooseRecord, auth: LooseRecord, fileReference: any) {
  const now = new Date().toISOString();
  const result = await runFileMetadataTransaction(database, async (sqlite: LooseRecord) => {
    const transactionDatabase = { ...database, sqlite, adapter: sqlite };
    const resolved: any = await resolveAccessibleFileReference(transactionDatabase, auth, fileReference, "delete");
    if (!resolved.ok) {
      return resolved;
    }
    const row = resolved.row;
    if (!row) {
      return {
        ok: false,
        error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
      };
    }
    await sqlite.deleteFileUploadsForFile(row.ownerId, row.id);
    await sqlite.deleteFileUploadsForPath(row.path);
    await sqlite.markFileDeleted(row.id, now);
    await sqlite.revokePublicFileUrlsForFile(row.id, now);
    return {
      ok: true,
      data: { file: fileMetadataFromRow({ ...row, deletedAt: now }) },
      error: null,
      deletedFile: row,
    };
  });
  if (!result.ok) {
    return result;
  }
  await removeFileVersionBestEffort(database, result.deletedFile.id, result.deletedFile.version);
  return {
    ok: true,
    data: result.data,
    error: null as any,
  };
}

async function runFileMetadataTransaction(database: LooseRecord, fn: (sqlite: LooseRecord) => any) {
  if (database.__transactionActive) {
    return await fn(database.adapter);
  }
  return await database.adapter.withTransaction(fn);
}

function validatePublicUrlExpiry(options: LooseRecord) {
  const choices = [options.ttlSeconds !== undefined, options.expires !== undefined, options.noExpiry === true].filter(Boolean);
  if (choices.length !== 1) {
    return {
      ok: false,
      error: createStructuredFileError(
        "Public file URLs require exactly one expiry choice.",
        "Pass exactly one of ttlSeconds, expires, or noExpiry: true.",
      ),
    };
  }
  if (options.noExpiry === true) {
    return { ok: true, expiresAt: null };
  }
  if (options.ttlSeconds !== undefined) {
    const ttlSeconds = Number(options.ttlSeconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return {
        ok: false,
        error: createStructuredFileError("Invalid public file URL TTL.", "Pass a positive ttlSeconds number."),
      };
    }
    return { ok: true, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }
  const expiresAt = new Date(options.expires);
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      ok: false,
      error: createStructuredFileError("Invalid public file URL expiry.", "Pass expires as a valid ISO date string."),
    };
  }
  return { ok: true, expiresAt: expiresAt.toISOString() };
}

export async function fileRowForOwner(database: LooseRecord, fileId: string, ownerId: any) {
  const reference = String(fileId ?? "");
  if (isAbsoluteFilePath(reference)) {
    const resolved: any = await resolveLiveFileReference(database, ownerId, reference);
    return resolved.ok ? resolved.row : null;
  }
  return await database.adapter.fileRowForOwner(reference, ownerId);
}

export async function fileRowForActor(database: LooseRecord, auth: LooseRecord, fileReference: any) {
  const resolved: any = await resolveAccessibleFileReference(database, auth, fileReference, "read");
  return resolved.ok ? resolved.row : null;
}

export function fileMetadataFromRow(row: LooseRecord) {
  return {
    id: row.id,
    bucket: row.bucketName,
    size: Number(row.size),
    type: row.type,
    name: row.name,
    path: row.path,
    version: row.version,
  };
}

function fileMetadataFromUpload(upload: LooseRecord) {
  return {
    id: upload.fileId,
    bucket: upload.bucketName,
    size: Number(upload.expectedSize),
    type: upload.type,
    name: upload.name,
    path: upload.path,
    version: upload.version,
  };
}

async function withFileUploadPathLock(path: string, fn: () => any) {
  const fileUploadPathLocks = ((globalThis as any).__sporadesFileUploadPathLocks ??= new Map());
  const key = String(path);
  const previous = fileUploadPathLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  fileUploadPathLocks.set(key, next);
  try {
    await previous.catch(() => { });
    return await fn();
  } finally {
    release?.();
    if (fileUploadPathLocks.get(key) === next) {
      fileUploadPathLocks.delete(key);
    }
  }
}

async function resolveFileWriteTarget(database: LooseRecord, ownerId: any, input: LooseRecord, now: string) {
  const explicitPath = input.path === undefined || input.path === null ? null : normalizeAbsoluteFilePath(input.path);
  const path = explicitPath ?? `/default/${normalizeFileName(input.name, null)}`;
  const firstSegment = path.split("/").filter(Boolean)[0] ?? "default";
  const existingBucket = await database.adapter.findFileBucket(ownerId, firstSegment);
  const bucket = existingBucket ?? (await ensureFileBucket(database, ownerId, "default", now));
  return { bucket, path };
}

async function ensureFileBucket(database: LooseRecord, ownerId: any, name: string, now: any) {
  const existing = await database.adapter.findFileBucket(ownerId, name);
  if (existing) return existing;
  const bucket = { id: nodeCryptoModule.randomUUID(), ownerId, name, createdAt: now };
  try {
    await database.adapter.createFileBucket(bucket);
    return bucket;
  } catch (error: any) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await database.adapter.findFileBucket(ownerId, name);
    if (raced) return raced;
    throw error;
  }
}

export function normalizeAbsoluteFilePath(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/")) {
    throw structuredFileException("Invalid File path.", "Pass an absolute Capsule-scoped File path that starts with '/'.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw structuredFileException("Invalid File path.", "Pass an absolute Capsule-scoped File path with a file name.");
  }
  return `/${segments.join("/")}`;
}

function normalizeFileName(name: any, filePath: string | null) {
  const candidate = String(name ?? "").trim();
  if (candidate) return candidate;
  const pathName = filePath?.split("/").filter(Boolean).at(-1);
  return pathName || "upload";
}

export function isAbsoluteFilePath(value: string) {
  return typeof value === "string" && value.startsWith("/");
}

async function resolveLiveFileReference(database: LooseRecord, ownerId: any, reference: string) {
  const value = String(reference ?? "");
  if (isAbsoluteFilePath(value)) {
    let path;
    try {
      path = normalizeAbsoluteFilePath(value);
    } catch {
      return { ok: true, row: null };
    }
    const resolved = await singleLiveFileRowByPath(database, path);
    if (resolved?.ambiguous) {
      return ambiguousFileReferenceError(value);
    }
    return { ok: true, row: resolved?.ownerId === ownerId ? resolved : null };
  }
  return { ok: true, row: await database.adapter.fileRowForOwner(value, ownerId) };
}

async function resolveAccessibleFileReference(database: LooseRecord, auth: LooseRecord, reference: string, operation: string) {
  const resolved: any = await resolvePrivilegedLiveFileReference(database, reference);
  if (!resolved.ok || !resolved.row) return resolved;
  if (resolved.row.ownerId === auth?.userId) return resolved;
  const allowed = await applyFileAcl(database, operation, resolved.row, auth);
  return { ok: true, row: allowed ? resolved.row : null };
}

export async function resolvePrivilegedLiveFileReference(database: LooseRecord, reference: any) {
  const value = String(reference ?? "");
  if (isAbsoluteFilePath(value)) {
    let path;
    try {
      path = normalizeAbsoluteFilePath(value);
    } catch {
      return { ok: true, row: null };
    }
    const resolved = await singleLiveFileRowByPath(database, path);
    if (resolved?.ambiguous) {
      return ambiguousFileReferenceError(value);
    }
    return { ok: true, row: resolved };
  }
  const row = await database.adapter.selectFileById(value);
  if (!row || row.deletedAt !== null || row.status !== "uploaded") {
    return { ok: true, row: null };
  }
  return { ok: true, row };
}

function singleLiveFileRowByPath(database: LooseRecord, path: string) {
  return thenIfPromise(database.adapter.selectLiveFileByPath(path), (rows: any[]) => {
    if (rows.length > 1) return { ambiguous: true };
    return rows[0] ?? null;
  });
}

function singleActiveFileRowByPath(database: LooseRecord, path: any) {
  return thenIfPromise(database.adapter.selectActiveFileByPath(path), (rows: any[]) => {
    if (rows.length > 1) return { ambiguous: true };
    return rows[0] ?? null;
  });
}

function ambiguousFileReferenceError(reference: string) {
  return {
    ok: false,
    error: createStructuredFileError(
      "File reference is ambiguous.",
      `The File reference ${reference} must resolve to exactly one live file before this operation can proceed.`,
    ),
  };
}

function structuredFileException(message: string | undefined, hint: string) {
  const error: HelperError = new Error(message);
  error.hint = hint;
  return error;
}

function isUniqueConstraintError(error: any) {
  const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
  return /unique constraint|duplicate key|constraint failed/i.test(text);
}

// Both of these answer statement text carrying identifier markers, which their caller quotes
// through the dialect before emitting.
function filePathBackfillSql() {
  return (
    "UPDATE [sporades_files] SET [path] = CASE " +
    "WHEN (SELECT COUNT(*) FROM [sporades_files] AS [matching] " +
    "WHERE [matching].[ownerId] = [sporades_files].[ownerId] " +
    "AND [matching].[bucketName] = [sporades_files].[bucketName] " +
    "AND [matching].[name] = [sporades_files].[name] " +
    "AND [matching].[deletedAt] IS NULL " +
    "AND [matching].[status] IN ('pending', 'uploaded')) = 1 " +
    "THEN '/' || [bucketName] || '/' || [name] " +
    "ELSE '/' || [bucketName] || '/' || [id] || '/' || [name] END " +
    "WHERE [path] IS NULL OR [path] = ''"
  );
}

function activeFilePathDedupeSql() {
  return (
    "UPDATE [sporades_files] SET [deletedAt] = COALESCE([deletedAt], [updatedAt]), [updatedAt] = [updatedAt] " +
    "WHERE [deletedAt] IS NULL AND [status] IN ('pending', 'uploaded') AND [id] NOT IN (" +
    "SELECT MAX([id]) FROM [sporades_files] " +
    "WHERE [deletedAt] IS NULL AND [status] IN ('pending', 'uploaded') " +
    "GROUP BY [path]" +
    ")"
  );
}

function ensureFileUploadTargetColumns(sqlite: LooseRecord) {
  const addedColumns = [
    ["bucketId", "TEXT"],
    ["bucketName", "TEXT"],
    ["path", "TEXT"],
    ["name", "TEXT"],
    ["type", "TEXT"],
  ];
  const statements = [
    "UPDATE [sporades_file_uploads] SET " +
    "[bucketId] = COALESCE([bucketId], (SELECT [bucketId] FROM [sporades_files] WHERE [sporades_files].[id] = [sporades_file_uploads].[fileId])), " +
    "[bucketName] = COALESCE([bucketName], (SELECT [bucketName] FROM [sporades_files] WHERE [sporades_files].[id] = [sporades_file_uploads].[fileId])), " +
    "[path] = COALESCE([path], (SELECT [path] FROM [sporades_files] WHERE [sporades_files].[id] = [sporades_file_uploads].[fileId])), " +
    "[name] = COALESCE([name], (SELECT [name] FROM [sporades_files] WHERE [sporades_files].[id] = [sporades_file_uploads].[fileId])), " +
    "[type] = COALESCE([type], (SELECT [type] FROM [sporades_files] WHERE [sporades_files].[id] = [sporades_file_uploads].[fileId])) " +
    "WHERE [path] IS NULL OR [path] = ''",
    "DELETE FROM [sporades_file_uploads] WHERE [id] NOT IN (" +
    "SELECT MAX([id]) FROM [sporades_file_uploads] GROUP BY [path]" +
    ")",
    "CREATE INDEX IF NOT EXISTS [sporades_file_uploads_path] ON [sporades_file_uploads] ([path])",
    "CREATE UNIQUE INDEX IF NOT EXISTS [sporades_file_uploads_path_unique] ON [sporades_file_uploads] ([path])",
  ];
  return chainMaybePromise([
    ...addedColumns.map(([name, type]) => () => sqlite.dialect.addMissingColumn(sqlite, "sporades_file_uploads", name, type)),
    ...statements.map((statement) => () => sqlite.exec(sqlite.dialect.sql(statement))),
  ]);
}

export function createStructuredFileError(message: string, hint: string) {
  return { message, hint };
}

async function removeFileVersionBestEffort(database: LooseRecord, fileId: any, version: any) {
  await database.fileStorage.deleteFileVersion({ fileId, version }).catch(() => { });
}
