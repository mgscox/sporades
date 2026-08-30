// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
import { ensureFileBucket, fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";
const crypto = process.getBuiltinModule("node:crypto");
const leaseTtlMs = 10 * 60 * 1000;
async function receipt(database, key) {
    const sql = database.adapter.dialect.sql("SELECT [payload] FROM [sporades_file_ingress] WHERE [key] = ?");
    const row = await database.adapter.prepare(sql).get(key);
    return row ? JSON.parse(row.payload) : null;
}
async function receiptByLease(database, leaseId) {
    const stored = await database.adapter.selectIngressByLease(leaseId);
    return stored ? JSON.parse(stored.payload) : null;
}
async function saveReceipt(database, row) {
    const sql = database.adapter.dialect.sql("UPDATE [sporades_file_ingress] SET [leaseId]=?, [state]=?, [actorId]=?, [endpointMethod]=?, [endpointPath]=?, [requestKey]=?, [partKey]=?, [payload]=?, [updatedAt]=? WHERE [key]=?");
    await database.adapter.prepare(sql).run(row.leaseId, row.state, row.actorId, row.endpointMethod, row.endpointPath, row.requestKey, row.partKey, JSON.stringify(row), new Date().toISOString(), row.key);
}
async function acquireReceipt(database, candidate) {
    // All supported adapters accept this conflict form. The unique key is the
    // serialization point; no read-then-insert window exists for two retries.
    const sql = database.adapter.dialect.sql("INSERT INTO [sporades_file_ingress] ([key], [leaseId], [state], [actorId], [endpointMethod], [endpointPath], [requestKey], [partKey], [payload], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT([key]) DO NOTHING");
    const inserted = await database.adapter.prepare(sql).run(candidate.key, candidate.leaseId, candidate.state, candidate.actorId, candidate.endpointMethod, candidate.endpointPath, candidate.requestKey, candidate.partKey, JSON.stringify(candidate), new Date().toISOString());
    if (Number(inserted?.changes ?? 0) > 0)
        return { row: candidate, winner: true };
    const row = await receipt(database, candidate.key);
    if (!row)
        throw new Error("Ingress receipt acquisition did not return a winner.");
    return { row, winner: false };
}
async function awaitCompletedStagingReceipt(database, key) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = await receipt(database, key);
        if (!row || row.state !== "staging")
            return row;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
    }
    throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
}
function header(headers, name) { return headers[String(name).toLowerCase()]; }
function safeName(value) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
function keyFor(endpoint, requestKey, partKey, actor) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }
function idempotencyConflict(message = "Ingress claim conflicts with the completed request.") { return Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" }); }
function sameFileDescriptor(left, right) {
    return left?.id === right?.id && left?.ownerId === right?.ownerId && left?.path === right?.path && left?.name === right?.name && left?.type === right?.type && Number(left?.size) === Number(right?.size) && left?.version === right?.version;
}
function isUniqueConstraintError(error) { return /unique constraint|duplicate key|constraint failed/i.test(String(error?.message ?? error)); }
// Keeps only one completed part (never the aggregate request) in memory. The storage adapter
// currently accepts complete bounded bytes; this is deliberately the narrowest streaming seam.
export async function* multipartParts(request, boundaryText, maxWireBytes, maxPartBytes) {
    const boundary = Buffer.from(`--${boundaryText}`);
    const marker = Buffer.from(`\r\n--${boundaryText}`);
    let pending = Buffer.alloc(0);
    let wire = 0;
    let state = "preamble";
    let rawHeaders = "";
    let pieces = [];
    let size = 0;
    for await (const source of request) {
        wire += source.byteLength;
        if (wire > maxWireBytes)
            throw Object.assign(new Error("Multipart body exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
        pending = Buffer.concat([pending, Buffer.from(source)]);
        while (true) {
            if (state === "preamble") {
                if (pending.length < boundary.length + 2)
                    break;
                if (!pending.subarray(0, boundary.length).equals(boundary) || pending.subarray(boundary.length, boundary.length + 2).toString() !== "\r\n")
                    throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" });
                pending = pending.subarray(boundary.length + 2);
                state = "headers";
                continue;
            }
            if (state === "headers") {
                const headerEnd = pending.indexOf("\r\n\r\n");
                if (headerEnd < 0) {
                    if (pending.length > 16384)
                        throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                    break;
                }
                rawHeaders = pending.subarray(0, headerEnd).toString("latin1");
                pending = pending.subarray(headerEnd + 4);
                pieces = [];
                size = 0;
                state = "body";
                continue;
            }
            if (state === "body") {
                const at = pending.indexOf(marker);
                if (at < 0) {
                    const take = Math.max(0, pending.length - marker.length + 1);
                    if (take) {
                        pieces.push(pending.subarray(0, take));
                        size += take;
                        if (size > maxPartBytes)
                            throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                        pending = pending.subarray(take);
                    }
                    break;
                }
                if (at) {
                    pieces.push(pending.subarray(0, at));
                    size += at;
                }
                if (size > maxPartBytes)
                    throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                pending = pending.subarray(at + marker.length);
                state = "separator";
                continue;
            }
            if (pending.length < 2)
                break;
            const separator = pending.subarray(0, 2).toString();
            if (separator !== "\r\n" && separator !== "--")
                throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" });
            pending = pending.subarray(2);
            yield { rawHeaders, body: Buffer.concat(pieces, size) };
            if (separator === "--")
                return;
            state = "headers";
        }
    }
    throw Object.assign(new Error("Truncated multipart request."), { code: "INVALID_MULTIPART" });
}
/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export async function stageMultipartIngress(database, endpoint, request, endpointRequest, actor) {
    const policy = endpoint.options.body.multipart;
    const contentType = String(endpointRequest.headers["content-type"] ?? "");
    const match = /^multipart\/form-data\s*;\s*boundary=([^;\s]+)$/i.exec(contentType);
    if (!match || match[1].length > 200)
        throw Object.assign(new Error("Invalid multipart request."), { code: "INVALID_MULTIPART" });
    const requestKey = header(endpointRequest.headers, policy.requestKeyHeader);
    if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 200)
        throw Object.assign(new Error("Missing multipart idempotency key."), { code: "INVALID_MULTIPART_REQUEST_KEY" });
    const maxBytes = Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536;
    const files = [];
    const fields = {};
    let fieldBytes = 0;
    let fileBytes = 0;
    const partKeys = new Set();
    for await (const part of multipartParts(request, match[1], maxBytes, Math.max(Number(policy.maxFileBytes), Number(policy.maxFieldBytes)))) {
        const rawHeaders = part.rawHeaders;
        const body = part.body;
        if (rawHeaders.length > 16384)
            throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
        const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders);
        if (!disposition)
            throw Object.assign(new Error("Malformed multipart part."), { code: "INVALID_MULTIPART" });
        const fieldName = disposition[1];
        const filename = disposition[2];
        if (filename === undefined) {
            fieldBytes += body.length;
            if (body.length > policy.maxFieldBytes || fieldBytes > policy.maxTotalFieldBytes)
                throw Object.assign(new Error("Multipart field exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
            (fields[fieldName] ??= []).push(body.toString("utf8"));
            continue;
        }
        fileBytes += body.length;
        if (files.length >= policy.maxFiles || body.length > policy.maxFileBytes || fileBytes > policy.maxTotalFileBytes || body.length > database.fileMaxSizeBytes)
            throw Object.assign(new Error("Multipart file exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
        const partKey = /^content-id:\s*<?([^>\r\n]+)>?\s*$/im.exec(rawHeaders)?.[1];
        if (policy.requireStablePartKeys && (!partKey || partKeys.has(partKey)))
            throw Object.assign(new Error("Multipart files require unique stable part keys."), { code: "INVALID_MULTIPART_PART_KEY" });
        if (partKey)
            partKeys.add(partKey);
        const type = safeType(/^content-type:\s*([^\r\n]+)/im.exec(rawHeaders)?.[1] ?? "");
        if (policy.allowedMimeTypes && !policy.allowedMimeTypes.map(safeType).includes(type))
            throw Object.assign(new Error("Multipart file type is not allowed."), { code: "MULTIPART_TYPE_DENIED" });
        const stablePartKey = partKey ?? crypto.createHash("sha256").update(`${fieldName}:${files.length}`).digest("hex");
        const actorId = String(actor.userId ?? "");
        const key = keyFor(endpoint, requestKey, stablePartKey, actorId);
        const digest = crypto.createHash("sha256").update(body).digest("hex");
        const now = new Date();
        const candidate = { key, leaseId: crypto.randomUUID(), partId: crypto.createHash("sha256").update(key).digest("hex"), fieldName, name: safeName(filename), type, size: body.length, digest, fileId: crypto.randomUUID(), version: crypto.randomUUID(), state: "staging", actorId, endpointMethod: String(endpoint.options.method), endpointPath: String(endpoint.options.path), requestKey, partKey: stablePartKey, expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString() };
        const acquired = await acquireReceipt(database, candidate);
        let row = acquired.row;
        if (row.digest !== digest || row.name !== candidate.name || row.type !== type || row.size !== body.length)
            throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
        if (acquired.winner) {
            await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body });
            row.state = "leased";
            await saveReceipt(database, row);
        }
        else if (row.state === "staging") {
            row = await awaitCompletedStagingReceipt(database, key);
        }
        if (!row || row.state === "staging")
            throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
        files.push(publicLease(row));
    }
    return { body: null, bodyBytes: Object.freeze({ byteLength: 0, length: 0, at() { return undefined; }, toUint8Array() { return new Uint8Array(); }, *[Symbol.iterator]() { } }), multipart: Object.freeze({ files: Object.freeze(files), fields: Object.freeze(fields) }), __ingressRequestKey: requestKey };
}
export function createEndpointIngressApi(database, endpoint, endpointRequest, context) {
    const policy = endpoint.options.body?.multipart;
    const unavailable = () => { throw Object.assign(new Error("File ingress was not declared for this endpoint."), { code: "FILE_INGRESS_UNAVAILABLE" }); };
    if (!policy)
        return { claim: unavailable, status: unavailable };
    const actorId = String(context.auth?.userId ?? "");
    const requestKey = endpointRequest.__ingressRequestKey;
    return {
        async claim(lease, options) {
            const row = await receiptByLease(database, lease?.leaseId);
            if (!row)
                throw idempotencyConflict("Ingress lease does not belong to this request.");
            const expectedLease = publicLease(row);
            if (row.actorId !== actorId || row.endpointMethod !== String(endpoint.options.method) || row.endpointPath !== String(endpoint.options.path) || row.requestKey !== requestKey ||
                expectedLease.leaseId !== lease?.leaseId || expectedLease.partId !== lease?.partId || expectedLease.fieldName !== lease?.fieldName || expectedLease.name !== lease?.name || expectedLease.type !== lease?.type || expectedLease.size !== lease?.size || expectedLease.expiresAt !== lease?.expiresAt) {
                throw idempotencyConflict("Ingress lease identity or descriptor conflicts with this request.");
            }
            const path = normalizeAbsoluteFilePath(options?.path);
            if (!policy.allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
                throw Object.assign(new Error("File path is outside the endpoint ingress policy."), { code: "INGRESS_PATH_DENIED" });
            if (!context.auth?.isAuthenticated || context.auth?.isGuest)
                throw Object.assign(new Error("A linked actor is required to claim an ingress file."), { code: "INGRESS_ACTOR_REQUIRED" });
            const name = safeName(options?.name ?? row.name);
            const type = safeType(options?.type ?? row.type);
            const expectedFile = { id: row.fileId, ownerId: actorId, path, name, type, size: row.size, version: row.version };
            if (row.state === "complete") {
                if (!sameFileDescriptor(row.file, expectedFile))
                    throw idempotencyConflict();
                return fileMetadataFromRow(row.file);
            }
            if (row.state === "expired" || Date.parse(row.expiresAt) <= Date.now())
                throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
            if (row.state !== "leased")
                throw idempotencyConflict("Ingress lease is not claimable.");
            const now = new Date().toISOString();
            const bucket = await ensureFileBucket(database, actorId, "default", now);
            const file = { id: row.fileId, ownerId: actorId, bucketId: bucket.id, bucketName: bucket.name, path, name: safeName(options?.name ?? row.name), type: safeType(options?.type ?? row.type), size: row.size, version: row.version, status: "uploaded", createdAt: now, updatedAt: now };
            // This function receives the endpoint's transaction-scoped adapter. Persisting the
            // receipt transition here means File metadata, claim state, and app writes commit or
            // roll back together; there is no post-commit in-memory publication step.
            try {
                await database.adapter.insertFileRowIfAbsent(file);
            }
            catch (error) {
                if (isUniqueConstraintError(error))
                    throw Object.assign(new Error("File path already exists."), { code: "FILE_PATH_EXISTS" });
                throw error;
            }
            const storedFile = await database.adapter.selectFileById(file.id);
            if (!storedFile || !sameFileDescriptor(storedFile, file))
                throw idempotencyConflict("Ingress File metadata conflicts with an existing row.");
            row.state = "complete";
            row.file = storedFile;
            const storedReceipt = await database.adapter.completeIngressClaim(row);
            const completed = storedReceipt ? JSON.parse(storedReceipt.payload) : null;
            if (!completed || completed.state !== "complete" || !sameFileDescriptor(completed.file, file))
                throw idempotencyConflict("Ingress receipt completion conflicted with another claim.");
            return fileMetadataFromRow(storedFile);
        },
        async status(statusRequestKey, partKey) { const row = await receipt(database, keyFor(endpoint, statusRequestKey, partKey, actorId)); if (!row)
            return { state: "missing" }; return row.state === "complete" ? { state: "complete", file: fileMetadataFromRow(row.file) } : { state: "leased", lease: publicLease(row) }; },
    };
}
/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export function finalizeEndpointIngressClaims(context, committed) {
    // Claim state is persisted in the endpoint transaction; retained for call-site compatibility.
}
//# sourceMappingURL=file-ingress-runtime.js.map