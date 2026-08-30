// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
import { ensureFileBucket, fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";

type RecordLike = Record<string, any>;
const crypto = process.getBuiltinModule("node:crypto");
const leaseTtlMs = 10 * 60 * 1000;

async function receipt(database: RecordLike, key: string) {
  const sql = database.adapter.dialect.sql("SELECT [payload] FROM [sporades_file_ingress] WHERE [key] = ?");
  const row = await database.adapter.prepare(sql).get(key); return row ? JSON.parse(row.payload) : null;
}
async function receiptByLease(database: RecordLike, leaseId: string) {
  const stored = await database.adapter.selectIngressByLease(leaseId);
  return stored ? JSON.parse(stored.payload) : null;
}
async function saveReceipt(database: RecordLike, row: RecordLike) {
  const sql = database.adapter.dialect.sql("UPDATE [sporades_file_ingress] SET [leaseId]=?, [state]=?, [actorId]=?, [authorityKind]=?, [authorityId]=?, [ownerId]=?, [principalNamespace]=?, [principalKeyDigest]=?, [endpointMethod]=?, [endpointPath]=?, [requestKey]=?, [partKey]=?, [expiresAt]=?, [sweepToken]=?, [payload]=?, [updatedAt]=? WHERE [key]=?");
  await database.adapter.prepare(sql).run(row.leaseId, row.state, row.actorId, row.authorityKind, row.authorityId, row.ownerId, row.principalNamespace ?? null, row.principalKeyDigest ?? null, row.endpointMethod, row.endpointPath, row.requestKey, row.partKey, row.expiresAt, row.sweepToken ?? null, JSON.stringify(row), new Date().toISOString(), row.key);
}
async function acquireReceipt(database: RecordLike, candidate: RecordLike) {
  // All supported adapters accept this conflict form. The unique key is the
  // serialization point; no read-then-insert window exists for two retries.
  const sql = database.adapter.dialect.sql("INSERT INTO [sporades_file_ingress] ([key], [leaseId], [state], [actorId], [authorityKind], [authorityId], [ownerId], [principalNamespace], [principalKeyDigest], [endpointMethod], [endpointPath], [requestKey], [partKey], [expiresAt], [sweepToken], [payload], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT([key]) DO NOTHING");
  const inserted = await database.adapter.prepare(sql).run(candidate.key, candidate.leaseId, candidate.state, candidate.actorId, candidate.authorityKind, candidate.authorityId, candidate.ownerId, candidate.principalNamespace ?? null, candidate.principalKeyDigest ?? null, candidate.endpointMethod, candidate.endpointPath, candidate.requestKey, candidate.partKey, candidate.expiresAt, null, JSON.stringify(candidate), new Date().toISOString());
  if (Number(inserted?.changes ?? 0) > 0) return { row: candidate, winner: true };
  const row = await receipt(database, candidate.key);
  if (!row) throw new Error("Ingress receipt acquisition did not return a winner.");
  return { row, winner: false };
}

async function awaitCompletedStagingReceipt(database: RecordLike, key: string) {
  const maximumDeadline = Date.now() + leaseTtlMs;
  for (let attempt = 0; Date.now() < maximumDeadline; attempt += 1) {
    const row = await receipt(database, key);
    if (!row || row.state !== "staging") return row;
    const expiry = Date.parse(row.expiresAt); if (!Number.isFinite(expiry) || expiry <= Date.now()) return row;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1, expiry - Date.now())));
  }
  throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
}

function header(headers: RecordLike, name: string) { return headers[String(name).toLowerCase()]; }
function partHeader(rawHeaders: string, name: string) {
  const normalizedName = String(name).trim().toLowerCase();
  const line = rawHeaders.split("\r\n").find((candidate) => { const separator = candidate.indexOf(":"); return separator > 0 && candidate.slice(0, separator).trim().toLowerCase() === normalizedName; });
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (normalizedName === "content-id") return /^<([^>\r\n]+)>$/.exec(value)?.[1] ?? value;
  return value;
}
function safeName(value: string) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value: string) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
function framedIngressKey(parts: string[]) {
  const framed = parts.map((value) => { const bytes = Buffer.from(String(value), "utf8"); return `${bytes.length}:${bytes.toString("base64")}`; }).join("|");
  return `v2:${crypto.createHash("sha256").update(framed).digest("hex")}`;
}
function keyFor(endpoint: RecordLike, requestKey: string, partKey: string, actor: string) { return framedIngressKey([String(endpoint.options.method), String(endpoint.options.path), actor, requestKey, partKey]); }
function legacyDelimitedKeyFor(endpoint: RecordLike, requestKey: string, partKey: string, actor: string) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row: RecordLike) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }
function idempotencyConflict(message = "Ingress claim conflicts with the completed request.") { return Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" }); }
function ingressAuthorityDenied() { return Object.assign(new Error("File ingress authority is unavailable."), { code: "INGRESS_AUTHORITY_DENIED" }); }
function sameFileDescriptor(left: RecordLike, right: RecordLike) {
  return left?.id === right?.id && left?.ownerId === right?.ownerId && left?.path === right?.path && left?.name === right?.name && left?.type === right?.type && Number(left?.size) === Number(right?.size) && left?.version === right?.version;
}
function isUniqueConstraintError(error: any) { return /unique constraint|duplicate key|constraint failed/i.test(String(error?.message ?? error)); }
function multipartBoundary(contentType: string) {
  const match = /^multipart\/form-data\s*;\s*boundary\s*=\s*(?:"([^"\\]*)"|([^;\s]+))\s*$/i.exec(contentType);
  if (!match) return null;
  const quoted = match[1] !== undefined; const value = quoted ? match[1] : match[2];
  const validBchars = /^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(value);
  const validToken = /^[0-9A-Za-z'+_.-]+$/.test(value);
  return value.length <= 70 && validBchars && (quoted || validToken) ? value : null;
}

// Keeps only one completed part (never the aggregate request) in memory. The storage adapter
// currently accepts complete bounded bytes; this is deliberately the narrowest streaming seam.
export async function* multipartParts(request: AsyncIterable<Uint8Array>, boundaryText: string, maxWireBytes: number, maxPartBytes: number | { file: number; field: number }) {
  const boundary = Buffer.from(`--${boundaryText}`); const marker = Buffer.from(`\r\n--${boundaryText}`);
  let pending = Buffer.alloc(0); let wire = 0; let state: "preamble" | "headers" | "body" | "separator" = "preamble";
  let rawHeaders = ""; let pieces: Buffer[] = []; let size = 0; let partLimit = typeof maxPartBytes === "number" ? maxPartBytes : Math.max(maxPartBytes.file, maxPartBytes.field);
  for await (const source of request) {
    wire += source.byteLength; if (wire > maxWireBytes) throw Object.assign(new Error("Multipart body exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = Buffer.concat([pending, Buffer.from(source)]);
    while (true) {
      if (state === "preamble") { if (pending.length < boundary.length + 2) break; if (!pending.subarray(0, boundary.length).equals(boundary) || pending.subarray(boundary.length, boundary.length + 2).toString() !== "\r\n") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(boundary.length + 2); state = "headers"; continue; }
      if (state === "headers") { const headerEnd = pending.indexOf("\r\n\r\n"); if (headerEnd < 0) { if (pending.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" }); break; } rawHeaders = pending.subarray(0, headerEnd).toString("latin1"); if (typeof maxPartBytes !== "number") { const disposition = /^content-disposition:\s*form-data;\s*name="[^"]+"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders); partLimit = disposition?.[1] !== undefined ? maxPartBytes.file : maxPartBytes.field; } pending = pending.subarray(headerEnd + 4); pieces = []; size = 0; state = "body"; continue; }
      if (state === "body") { const at = pending.indexOf(marker); if (at < 0) { const take = Math.max(0, pending.length - marker.length + 1); if (take) { pieces.push(pending.subarray(0, take)); size += take; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(take); } break; } if (pending.length < at + marker.length + 2) { if (at) { pieces.push(pending.subarray(0, at)); size += at; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(at); } break; } const suffix = pending.subarray(at + marker.length, at + marker.length + 2).toString(); if (suffix !== "\r\n" && suffix !== "--") { const take = at + marker.length; pieces.push(pending.subarray(0, take)); size += take; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(take); continue; } if (at) { pieces.push(pending.subarray(0, at)); size += at; } if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(at + marker.length); state = "separator"; continue; }
      if (pending.length < 2) break;
      const separator = pending.subarray(0, 2).toString(); if (separator !== "\r\n" && separator !== "--") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(2); yield { rawHeaders, body: Buffer.concat(pieces, size) }; if (separator === "--") return; state = "headers";
    }
  }
  throw Object.assign(new Error("Truncated multipart request."), { code: "INVALID_MULTIPART" });
}

/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export async function stageMultipartIngress(database: RecordLike, endpoint: RecordLike, request: any, endpointRequest: RecordLike, actor: RecordLike, admittedAuthority?: RecordLike) {
  const policy = validateMultipartIngressPolicy(endpoint.options.body.multipart);
  const contentType = String(endpointRequest.headers["content-type"] ?? "");
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw Object.assign(new Error("Invalid multipart request."), { code: "INVALID_MULTIPART" });
  const requestKey = header(endpointRequest.headers, policy.requestKeyHeader);
  if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 200) throw Object.assign(new Error("Missing multipart idempotency key."), { code: "INVALID_MULTIPART_REQUEST_KEY" });
  const maxBytes = Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536;
  const files: any[] = []; const fields: RecordLike = Object.create(null); let fieldCount = 0; let fieldBytes = 0; let fileBytes = 0; const partKeys = new Set<string>(); const wonReceipts: RecordLike[] = [];
  try { for await (const part of multipartParts(request, boundary, maxBytes, { file: policy.maxFileBytes, field: policy.maxFieldBytes })) {
    const rawHeaders = part.rawHeaders; const body = part.body;
    if (rawHeaders.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders);
    if (!disposition) throw Object.assign(new Error("Malformed multipart part."), { code: "INVALID_MULTIPART" });
    const fieldName = disposition[1]; const filename = disposition[2];
    if (filename === undefined) { fieldCount += 1; fieldBytes += body.length; if (fieldCount > policy.maxFieldCount || body.length > policy.maxFieldBytes || fieldBytes > policy.maxTotalFieldBytes) throw Object.assign(new Error("Multipart field exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) fields[fieldName] = []; fields[fieldName].push(body.toString("utf8")); continue; }
    fileBytes += body.length; if (files.length >= policy.maxFiles || body.length > policy.maxFileBytes || fileBytes > policy.maxTotalFileBytes || body.length > database.fileMaxSizeBytes) throw Object.assign(new Error("Multipart file exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    const partKey = partHeader(rawHeaders, policy.partKeyHeader);
    if (policy.requireStablePartKeys && (!partKey || partKeys.has(partKey))) throw Object.assign(new Error("Multipart files require unique stable part keys."), { code: "INVALID_MULTIPART_PART_KEY" });
    if (partKey) partKeys.add(partKey);
    const type = safeType(/^content-type:\s*([^\r\n]+)/im.exec(rawHeaders)?.[1] ?? "");
    if (policy.allowedMimeTypes && !policy.allowedMimeTypes.map(safeType).includes(type)) throw Object.assign(new Error("Multipart file type is not allowed."), { code: "MULTIPART_TYPE_DENIED" });
    const stablePartKey = partKey ?? crypto.createHash("sha256").update(`${fieldName}:${files.length}`).digest("hex"); const actorId = String(actor.userId ?? "");
    const authority = admittedAuthority ?? { kind: "actor", actorId, ownerId: actorId };
    const authorityId = authority.kind === "capsule-principal" ? `capsule:${authority.namespace}:${authority.keyDigest}` : `actor:${authority.actorId}`;
    const key = keyFor(endpoint, requestKey, stablePartKey, authorityId);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const now = new Date(); const candidate = { key, leaseId: crypto.randomUUID(), partId: crypto.createHash("sha256").update(key).digest("hex"), fieldName, name: safeName(filename), type, size: body.length, digest, fileId: crypto.randomUUID(), version: crypto.randomUUID(), state: "staging", actorId, authorityKind: authority.kind, authorityId, ownerId: authority.ownerId, ...(authority.kind === "capsule-principal" ? { principalNamespace: authority.namespace, principalKeyDigest: authority.keyDigest } : {}), endpointMethod: String(endpoint.options.method), endpointPath: String(endpoint.options.path), requestKey, partKey: stablePartKey, expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString() };
    // Pre-authority receipts used the raw actor ID in their durable key. Keep that key and
    // its derived part/object identities intact: renaming only the key would strand retries,
    // while regenerating the part would duplicate staged bytes.
    const legacyAuthorityKey = legacyDelimitedKeyFor(endpoint, requestKey, stablePartKey, authorityId);
    const legacyActorKey = authority.kind === "actor" ? legacyDelimitedKeyFor(endpoint, requestKey, stablePartKey, authority.actorId) : null;
    const legacyRow = await (async () => { for (const legacyKey of [legacyAuthorityKey, legacyActorKey]) { if (!legacyKey || legacyKey === key) continue; const row = await receipt(database, legacyKey); if (row?.endpointMethod === String(endpoint.options.method) && row?.endpointPath === String(endpoint.options.path) && row?.requestKey === requestKey && row?.partKey === stablePartKey && row?.authorityKind === authority.kind && row?.authorityId === authorityId && row?.ownerId === authority.ownerId) return row; } return null; })();
    const acquired = legacyRow
      ? { row: legacyRow, winner: false }
      : await acquireReceipt(database, candidate);
    let row = acquired.row;
    if (row.digest !== digest || row.name !== candidate.name || row.type !== type || row.size !== body.length) throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
    if (acquired.winner) {
      wonReceipts.push(row);
      await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body });
      row.state = "leased"; await saveReceipt(database, row);
    } else if (row.state === "staging") {
      row = await awaitCompletedStagingReceipt(database, row.key);
    }
    if (!row || (row.state !== "leased" && row.state !== "complete")) throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
    files.push(publicLease(row));
  } } catch (primaryError) {
    const cleanupErrors: any[] = [];
    for (const row of wonReceipts.reverse()) {
      try {
        const deleted = await database.adapter.prepare(database.adapter.dialect.sql("DELETE FROM [sporades_file_ingress] WHERE [key] = ? AND [leaseId] = ? AND [state] IN ('staging', 'leased')")).run(row.key, row.leaseId);
        if (Number(deleted?.changes ?? 0) > 0) await database.fileStorage.deleteFileVersion({ fileId: row.fileId, version: row.version });
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "Multipart ingress staging failed and cleanup was incomplete.");
    throw primaryError;
  }
  return { body: null, bodyBytes: Object.freeze({ byteLength: 0, length: 0, at() { return undefined; }, toUint8Array() { return new Uint8Array(); }, *[Symbol.iterator]() {} }), multipart: Object.freeze({ files: Object.freeze(files), fields: Object.freeze(fields) }), __ingressRequestKey: requestKey, __ingressAuthority: admittedAuthority ?? Object.freeze({ kind: "actor", actorId: String(actor.userId ?? ""), ownerId: String(actor.userId ?? "") }) };
}

export function validateMultipartIngressPolicy(policy: RecordLike) {
  const invalid = () => { throw Object.assign(new Error("Invalid multipart ingress policy."), { code: "INVALID_MULTIPART_POLICY" }); };
  const validPathPrefix = (value: any) => { try { return typeof value === "string" && normalizeAbsoluteFilePath(value) === value; } catch { return false; } };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) invalid();
  for (const name of ["maxFiles", "maxFileBytes", "maxTotalFileBytes"]) if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] <= 0) invalid();
  for (const name of ["maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes"]) if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] < 0) invalid();
  const allowedKeys = new Set(["maxFiles", "maxFileBytes", "maxTotalFileBytes", "maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes", "allowedPathPrefixes", "allowedMimeTypes", "requestKeyHeader", "partKeyHeader", "requireStablePartKeys", "claimAuthorities"]);
  if (Object.keys(policy).some((key) => !allowedKeys.has(key))) invalid();
  if (!Array.isArray(policy.allowedPathPrefixes) || policy.allowedPathPrefixes.length === 0 || policy.allowedPathPrefixes.some((value: any) => !validPathPrefix(value))) invalid();
  if (policy.allowedMimeTypes !== undefined && (!Array.isArray(policy.allowedMimeTypes) || policy.allowedMimeTypes.some((value: any) => typeof value !== "string" || safeType(value) !== value.toLowerCase()))) invalid();
  for (const name of ["requestKeyHeader", "partKeyHeader"]) if (typeof policy[name] !== "string" || policy[name].length > 100 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(policy[name])) invalid();
  if (typeof policy.requireStablePartKeys !== "boolean") invalid();
  if (policy.claimAuthorities !== undefined && (!Array.isArray(policy.claimAuthorities) || policy.claimAuthorities.length !== 1 || !["actor", "capsule-principal"].includes(policy.claimAuthorities[0]))) invalid();
  return policy;
}

export function createEndpointIngressApi(database: RecordLike, endpoint: RecordLike, endpointRequest: RecordLike, context: RecordLike) {
  // Runtime-owned provider callbacks predate Capsule endpoint options and do
  // not declare multipart ingress. Keep their ordinary endpoint context
  // available without requiring a synthetic declaration object.
  const policy = endpoint.options?.body?.multipart;
  const unavailable = () => { throw Object.assign(new Error("File ingress was not declared for this endpoint."), { code: "FILE_INGRESS_UNAVAILABLE" }); };
  if (!policy) return { claim: unavailable, status: unavailable };
  const actorId = String(context.auth?.userId ?? ""); const requestKey = endpointRequest.__ingressRequestKey; const admittedAuthority = endpointRequest.__ingressAuthority ?? { kind: "actor", actorId, ownerId: actorId };
  return {
    async claim(lease: RecordLike, options: RecordLike) {
      const row = await receiptByLease(database, lease?.leaseId);
      if (!row) throw ingressAuthorityDenied();
      const requestedAuthority = options?.authority ?? { kind: "actor" };
      let claimAuthorityId: string;
      if (row.authorityKind === "capsule-principal") {
        if (requestedAuthority?.kind !== "capsule-principal" || admittedAuthority?.kind !== "capsule-principal" || typeof requestedAuthority.namespace !== "string" || typeof requestedAuthority.key !== "string") throw ingressAuthorityDenied();
        const requestedDigest = crypto.createHash("sha256").update(`${requestedAuthority.namespace}\0${requestedAuthority.key}`, "utf8").digest("hex");
        if (requestedAuthority.namespace !== admittedAuthority.namespace || requestedDigest !== admittedAuthority.keyDigest || row.principalNamespace !== requestedAuthority.namespace || row.principalKeyDigest !== requestedDigest || row.ownerId !== database.capsuleIngressOwnerId) throw ingressAuthorityDenied();
        claimAuthorityId = `capsule:${requestedAuthority.namespace}:${requestedDigest}`;
      } else {
        if (requestedAuthority?.kind !== "actor" || admittedAuthority?.kind !== "actor" || !context.auth?.isAuthenticated || context.auth?.isGuest || admittedAuthority.actorId !== actorId || row.ownerId !== actorId) throw ingressAuthorityDenied();
        claimAuthorityId = `actor:${actorId}`;
      }
      const expectedLease = publicLease(row);
      if (row.authorityId !== claimAuthorityId || row.endpointMethod !== String(endpoint.options.method) || row.endpointPath !== String(endpoint.options.path) || row.requestKey !== requestKey ||
          expectedLease.leaseId !== lease?.leaseId || expectedLease.partId !== lease?.partId || expectedLease.fieldName !== lease?.fieldName || expectedLease.name !== lease?.name || expectedLease.type !== lease?.type || expectedLease.size !== lease?.size || expectedLease.expiresAt !== lease?.expiresAt) {
        throw ingressAuthorityDenied();
      }
      const path = normalizeAbsoluteFilePath(options?.path); if (!policy.allowedPathPrefixes.some((prefix: string) => path === prefix || path.startsWith(`${prefix}/`))) throw Object.assign(new Error("File path is outside the endpoint ingress policy."), { code: "INGRESS_PATH_DENIED" });
      const name = safeName(options?.name ?? row.name); const type = safeType(options?.type ?? row.type);
      const expectedFile = { id: row.fileId, ownerId: row.ownerId, path, name, type, size: row.size, version: row.version };
      if (row.state === "complete") {
        if (!sameFileDescriptor(row.file, expectedFile)) throw idempotencyConflict();
        return fileMetadataFromRow(row.file);
      }
      if (row.state === "expired" || Date.parse(row.expiresAt) <= Date.now()) throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
      if (row.state !== "leased") throw idempotencyConflict("Ingress lease is not claimable.");
      const now = new Date().toISOString(); const bucket = await ensureFileBucket(database, row.ownerId, "default", now);
      const file = { id: row.fileId, ownerId: row.ownerId, bucketId: bucket.id, bucketName: bucket.name, path, name: safeName(options?.name ?? row.name), type: safeType(options?.type ?? row.type), size: row.size, version: row.version, status: "uploaded", createdAt: now, updatedAt: now };
      // This function receives the endpoint's transaction-scoped adapter. Persisting the
      // receipt transition here means File metadata, claim state, and app writes commit or
      // roll back together; there is no post-commit in-memory publication step.
      try { await database.adapter.insertFileRowIfAbsent(file); }
      catch (error: any) { if (isUniqueConstraintError(error)) throw Object.assign(new Error("File path already exists."), { code: "FILE_PATH_EXISTS" }); throw error; }
      const storedFile = await database.adapter.selectFileById(file.id);
      if (!storedFile || !sameFileDescriptor(storedFile, file)) throw idempotencyConflict("Ingress File metadata conflicts with an existing row.");
      row.state = "complete"; row.file = storedFile;
      const storedReceipt = await database.adapter.completeIngressClaim(row); const completed = storedReceipt ? JSON.parse(storedReceipt.payload) : null;
      if (!completed || completed.state !== "complete" || !sameFileDescriptor(completed.file, file)) throw idempotencyConflict("Ingress receipt completion conflicted with another claim.");
      return fileMetadataFromRow(storedFile);
    },
    async status(statusRequestKey: string, partKey: string) {
      const capsulePrincipal = admittedAuthority.kind === "capsule-principal";
      const authorityId = capsulePrincipal ? `capsule:${admittedAuthority.namespace}:${admittedAuthority.keyDigest}` : `actor:${actorId}`;
      let row = await receipt(database, keyFor(endpoint, statusRequestKey, partKey, authorityId));
      if (!row) row = await receipt(database, legacyDelimitedKeyFor(endpoint, statusRequestKey, partKey, authorityId));
      if (!row && !capsulePrincipal) row = await receipt(database, legacyDelimitedKeyFor(endpoint, statusRequestKey, partKey, actorId));
      const authorityMatches = capsulePrincipal
        ? row?.authorityKind === "capsule-principal" && row.authorityId === authorityId && row.ownerId === admittedAuthority.ownerId && row.principalNamespace === admittedAuthority.namespace && row.principalKeyDigest === admittedAuthority.keyDigest
        : row?.authorityId === authorityId && row.ownerId === actorId;
      const tupleMatches = row?.endpointMethod === String(endpoint.options.method) && row?.endpointPath === String(endpoint.options.path) && row?.requestKey === statusRequestKey && row?.partKey === partKey;
      if (!row || !authorityMatches || !tupleMatches) return { state: "missing" as const };
      if (row.state === "complete") return { state: "complete" as const, file: fileMetadataFromRow(row.file) };
      if (row.state === "leased" && Date.parse(row.expiresAt) > Date.now()) return { state: "leased" as const, lease: publicLease(row) };
      return { state: "failed" as const, retryable: row.state !== "failed" ? true : row.retryable === true };
    },
  };
}

/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export function finalizeEndpointIngressClaims(context: RecordLike, committed: boolean) {
  // Claim state is persisted in the endpoint transaction; retained for call-site compatibility.
}

async function armIngressSweep(database: RecordLike, candidate: RecordLike, now: string, sweepToken: string) {
  for (let attempt = 0; attempt <= 100; attempt += 1) {
    let fenceAcquired = false;
    try {
      return await database.adapter.withTransaction(async (adapter: RecordLike) => {
        await adapter.lockIngressReceipts([candidate.leaseId]); fenceAcquired = true;
        const stored = await adapter.selectIngressByLease(candidate.leaseId);
        if (!stored || stored.state === "complete") return null;
        let row: RecordLike;
        try { row = JSON.parse(stored.payload); }
        catch { throw Object.assign(new Error("Ingress receipt payload is invalid."), { code: "INGRESS_SWEEP_INVALID_RECEIPT" }); }
        // A File row is committed application state. Even a damaged legacy receipt must never
        // authorize its object deletion; leave it for explicit repair instead.
        if (row.fileId && await adapter.selectFileById(row.fileId)) return null;
        const armed = await adapter.markIngressReceiptSweeping(row, sweepToken, now);
        return Number(armed?.changes ?? 0) > 0 ? { ...row, state: "sweeping", sweepToken } : null;
      });
    } catch (error: any) {
      if (fenceAcquired || database.adapter.engine !== "sqlite" || attempt >= 100 || !String(error?.message ?? "").includes("database is locked")) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
    }
  }
  return null;
}

/** Retire one deterministic bounded batch. Object deletion precedes the token-fenced receipt delete. */
export async function sweepExpiredFileIngress(database: RecordLike, options: RecordLike = {}) {
  const now = typeof options.now === "string" && Number.isFinite(Date.parse(options.now)) ? new Date(options.now).toISOString() : new Date().toISOString();
  const requestedLimit = Number(options.limit ?? 50); const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
  let candidates: RecordLike[];
  try { candidates = await database.adapter.selectIngressSweepCandidates(now, limit); }
  catch { return Object.freeze({ scanned: 0, cleaned: Object.freeze([]), failures: Object.freeze([{ code: "INGRESS_SWEEP_STORAGE_FAILED" }]) }); }
  const cleaned: RecordLike[] = []; const failures: RecordLike[] = [];
  for (const candidate of candidates) {
    const leaseId = String(candidate.leaseId ?? ""); const sweepToken = crypto.randomUUID();
    try {
      const armed = await armIngressSweep(database, candidate, now, sweepToken);
      if (!armed) continue;
      try { await database.fileStorage.deleteFileVersion({ fileId: armed.fileId, version: armed.version }); }
      catch { failures.push(Object.freeze({ leaseId, code: "INGRESS_ORPHAN_CLEANUP_FAILED" })); continue; }
      const deleted = await database.adapter.deleteIngressSweepingReceipt(leaseId, sweepToken);
      if (Number(deleted?.changes ?? 0) > 0) cleaned.push(Object.freeze({ leaseId, requestKey: armed.requestKey, partKey: armed.partKey }));
    } catch (error: any) {
      failures.push(Object.freeze({ leaseId, code: error?.code === "INGRESS_SWEEP_INVALID_RECEIPT" ? "INGRESS_SWEEP_INVALID_RECEIPT" : "INGRESS_SWEEP_STORAGE_FAILED" }));
    }
  }
  return Object.freeze({ scanned: candidates.length, cleaned: Object.freeze(cleaned), failures: Object.freeze(failures) });
}
