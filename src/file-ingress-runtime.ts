// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
import { fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";

type RecordLike = Record<string, any>;
const crypto = process.getBuiltinModule("node:crypto");
const leaseTtlMs = 10 * 60 * 1000;

function store(database: RecordLike) {
  const root = database.__rootDatabase ?? database;
  return (root.__sporadesIngressLeases ??= new Map<string, RecordLike>());
}

function header(headers: RecordLike, name: string) { return headers[String(name).toLowerCase()]; }
function safeName(value: string) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value: string) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
function keyFor(endpoint: RecordLike, requestKey: string, partKey: string, actor: string) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row: RecordLike) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }

// Keeps only one completed part (never the aggregate request) in memory. The storage adapter
// currently accepts complete bounded bytes; this is deliberately the narrowest streaming seam.
async function* multipartParts(request: AsyncIterable<Uint8Array>, boundaryText: string, maxWireBytes: number, maxPartBytes: number) {
  const boundary = Buffer.from(`--${boundaryText}`); const marker = Buffer.from(`\r\n--${boundaryText}`);
  let pending = Buffer.alloc(0); let wire = 0; let started = false;
  const pull = async function* () { for await (const source of request) { wire += source.byteLength; if (wire > maxWireBytes) throw Object.assign(new Error("Multipart body exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = Buffer.concat([pending, Buffer.from(source)]); yield; } };
  for await (const _ of pull()) {
    while (true) {
      if (!started) { const at = pending.indexOf(boundary); if (at < 0) { if (pending.length > boundary.length) throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); break; } if (pending.length < at + boundary.length + 2) break; if (pending.subarray(at + boundary.length, at + boundary.length + 2).toString() !== "\r\n") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(at + boundary.length + 2); started = true; }
      const headerEnd = pending.indexOf("\r\n\r\n"); if (headerEnd < 0) { if (pending.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" }); break; }
      const rawHeaders = pending.subarray(0, headerEnd).toString("latin1"); pending = pending.subarray(headerEnd + 4); const pieces: Buffer[] = []; let size = 0;
      while (true) { const at = pending.indexOf(marker); if (at >= 0) { if (at) { pieces.push(pending.subarray(0, at)); size += at; } pending = pending.subarray(at + marker.length); if (pending.length < 2) { pending = Buffer.concat([Buffer.from(`\r\n--${boundaryText}`), pending]); break; } const close = pending.subarray(0, 2).toString(); if (close !== "\r\n" && close !== "--") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(2); if (size > maxPartBytes) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); yield { rawHeaders, body: Buffer.concat(pieces, size) }; if (close === "--") return; break; }
        const keep = Math.min(marker.length - 1, pending.length); const take = pending.length - keep; if (take > 0) { pieces.push(pending.subarray(0, take)); size += take; if (size > maxPartBytes) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(take); } break; }
      if (pending.indexOf("\r\n\r\n") < 0) break;
    }
  }
  throw Object.assign(new Error("Truncated multipart request."), { code: "INVALID_MULTIPART" });
}

/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export async function stageMultipartIngress(database: RecordLike, endpoint: RecordLike, request: any, endpointRequest: RecordLike, actor: RecordLike) {
  const policy = endpoint.options.body.multipart;
  const contentType = String(endpointRequest.headers["content-type"] ?? "");
  const match = /^multipart\/form-data\s*;\s*boundary=([^;\s]+)$/i.exec(contentType);
  if (!match || match[1].length > 200) throw Object.assign(new Error("Invalid multipart request."), { code: "INVALID_MULTIPART" });
  const requestKey = header(endpointRequest.headers, policy.requestKeyHeader);
  if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 200) throw Object.assign(new Error("Missing multipart idempotency key."), { code: "INVALID_MULTIPART_REQUEST_KEY" });
  const maxBytes = Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536;
  const files: any[] = []; const fields: RecordLike = {}; let fieldBytes = 0; let fileBytes = 0; const partKeys = new Set<string>();
  for await (const part of multipartParts(request, match[1], maxBytes, Math.max(Number(policy.maxFileBytes), Number(policy.maxFieldBytes)))) {
    const rawHeaders = part.rawHeaders; const body = part.body;
    if (rawHeaders.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders);
    if (!disposition) throw Object.assign(new Error("Malformed multipart part."), { code: "INVALID_MULTIPART" });
    const fieldName = disposition[1]; const filename = disposition[2];
    if (filename === undefined) { fieldBytes += body.length; if (body.length > policy.maxFieldBytes || fieldBytes > policy.maxTotalFieldBytes) throw Object.assign(new Error("Multipart field exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); (fields[fieldName] ??= []).push(body.toString("utf8")); continue; }
    fileBytes += body.length; if (files.length >= policy.maxFiles || body.length > policy.maxFileBytes || fileBytes > policy.maxTotalFileBytes || body.length > database.fileMaxSizeBytes) throw Object.assign(new Error("Multipart file exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    const partKey = /^content-id:\s*<?([^>\r\n]+)>?\s*$/im.exec(rawHeaders)?.[1];
    if (policy.requireStablePartKeys && (!partKey || partKeys.has(partKey))) throw Object.assign(new Error("Multipart files require unique stable part keys."), { code: "INVALID_MULTIPART_PART_KEY" });
    if (partKey) partKeys.add(partKey);
    const type = safeType(/^content-type:\s*([^\r\n]+)/im.exec(rawHeaders)?.[1] ?? "");
    if (policy.allowedMimeTypes && !policy.allowedMimeTypes.map(safeType).includes(type)) throw Object.assign(new Error("Multipart file type is not allowed."), { code: "MULTIPART_TYPE_DENIED" });
    const stablePartKey = partKey ?? crypto.createHash("sha256").update(`${fieldName}:${files.length}`).digest("hex"); const actorId = String(actor.userId ?? ""); const key = keyFor(endpoint, requestKey, stablePartKey, actorId); const leases = store(database); let row = leases.get(key);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (row && (row.digest !== digest || row.name !== safeName(filename) || row.type !== type)) throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
    if (!row) { const now = new Date(); row = { key, leaseId: crypto.randomUUID(), partId: crypto.createHash("sha256").update(key).digest("hex"), fieldName, name: safeName(filename), type, size: body.length, digest, fileId: crypto.randomUUID(), version: crypto.randomUUID(), state: "leased", expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString() }; await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body }); leases.set(key, row); }
    files.push(publicLease(row));
  }
  return { body: null, bodyBytes: Object.freeze({ byteLength: 0, length: 0, at() { return undefined; }, toUint8Array() { return new Uint8Array(); }, *[Symbol.iterator]() {} }), multipart: Object.freeze({ files: Object.freeze(files), fields: Object.freeze(fields) }), __ingressRequestKey: requestKey };
}

export function createEndpointIngressApi(database: RecordLike, endpoint: RecordLike, endpointRequest: RecordLike, context: RecordLike) {
  const policy = endpoint.options.body?.multipart;
  const unavailable = () => { throw Object.assign(new Error("File ingress was not declared for this endpoint."), { code: "FILE_INGRESS_UNAVAILABLE" }); };
  if (!policy) return { claim: unavailable, status: unavailable };
  const actorId = String(context.auth?.userId ?? ""); const requestKey = endpointRequest.__ingressRequestKey;
  return {
    async claim(lease: RecordLike, options: RecordLike) {
      const row = [...store(database).values()].find((candidate) => candidate.leaseId === lease?.leaseId);
      if (!row || row.state === "expired" || Date.parse(row.expiresAt) <= Date.now()) throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
      if (row.state === "complete") return fileMetadataFromRow(row.file);
      const path = normalizeAbsoluteFilePath(options?.path); if (!policy.allowedPathPrefixes.some((prefix: string) => path === prefix || path.startsWith(`${prefix}/`))) throw Object.assign(new Error("File path is outside the endpoint ingress policy."), { code: "INGRESS_PATH_DENIED" });
      if (!context.auth?.isAuthenticated || context.auth?.isGuest) throw Object.assign(new Error("A linked actor is required to claim an ingress file."), { code: "INGRESS_ACTOR_REQUIRED" });
      const existing = await database.adapter.selectLiveFileByPath(path); if (existing?.length) throw Object.assign(new Error("File path already exists."), { code: "FILE_PATH_EXISTS" });
      const now = new Date().toISOString(); const bucket = (await database.adapter.findFileBucket(actorId, "default")) ?? { id: crypto.randomUUID(), ownerId: actorId, name: "default", createdAt: now };
      if (!await database.adapter.findFileBucket(actorId, "default")) await database.adapter.createFileBucket(bucket);
      const file = { id: row.fileId, ownerId: actorId, bucketId: bucket.id, bucketName: bucket.name, path, name: safeName(options?.name ?? row.name), type: safeType(options?.type ?? row.type), size: row.size, version: row.version, status: "uploaded", createdAt: now, updatedAt: now };
      await database.adapter.insertFileRow(file); row.state = "claiming"; row.file = file; (context.__sporadesIngressClaims ??= []).push(row); return fileMetadataFromRow(file);
    },
    async status(statusRequestKey: string, partKey: string) { const row = store(database).get(keyFor(endpoint, statusRequestKey, partKey, actorId)); if (!row) return { state: "missing" as const }; return row.state === "complete" ? { state: "complete" as const, file: fileMetadataFromRow(row.file) } : { state: "leased" as const, lease: publicLease(row) }; },
  };
}

/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export function finalizeEndpointIngressClaims(context: RecordLike, committed: boolean) {
  for (const row of context?.__sporadesIngressClaims ?? []) {
    if (row.state === "claiming") row.state = committed ? "complete" : "leased";
    if (!committed) delete row.file;
  }
}
