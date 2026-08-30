// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
import { fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";
const crypto = process.getBuiltinModule("node:crypto");
const leaseTtlMs = 10 * 60 * 1000;
function store(database) {
    const root = database.__rootDatabase ?? database;
    return (root.__sporadesIngressLeases ??= new Map());
}
function header(headers, name) { return headers[String(name).toLowerCase()]; }
function safeName(value) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
function keyFor(endpoint, requestKey, partKey, actor) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }
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
    const maxBytes = Math.min(Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536, Number(database.fileMaxSizeBytes ?? Infinity) + Number(policy.maxTotalFieldBytes) + 65536);
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes)
            throw Object.assign(new Error("Multipart body exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
        chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const boundary = Buffer.from(`--${match[1]}`);
    const pieces = raw.toString("latin1").split(boundary.toString("latin1")).slice(1, -1);
    if (pieces.length > Number(policy.maxFiles) + Number(policy.maxFieldCount))
        throw Object.assign(new Error("Too many multipart parts."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    const files = [];
    const fields = {};
    let fieldBytes = 0;
    let fileBytes = 0;
    const partKeys = new Set();
    for (let part of pieces) {
        if (!part.startsWith("\r\n"))
            throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" });
        part = part.slice(2);
        const split = part.indexOf("\r\n\r\n");
        if (split < 0)
            throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" });
        const rawHeaders = part.slice(0, split);
        const body = Buffer.from(part.slice(split + 4).replace(/\r\n$/, ""), "latin1");
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
        const leases = store(database);
        let row = leases.get(key);
        const digest = crypto.createHash("sha256").update(body).digest("hex");
        if (row && (row.digest !== digest || row.name !== safeName(filename) || row.type !== type))
            throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
        if (!row) {
            const now = new Date();
            row = { key, leaseId: crypto.randomUUID(), partId: crypto.createHash("sha256").update(key).digest("hex"), fieldName, name: safeName(filename), type, size: body.length, digest, fileId: crypto.randomUUID(), version: crypto.randomUUID(), state: "leased", expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString() };
            await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body });
            leases.set(key, row);
        }
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
            const row = [...store(database).values()].find((candidate) => candidate.leaseId === lease?.leaseId);
            if (!row || row.state === "expired" || Date.parse(row.expiresAt) <= Date.now())
                throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
            if (row.state === "complete")
                return fileMetadataFromRow(row.file);
            const path = normalizeAbsoluteFilePath(options?.path);
            if (!policy.allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
                throw Object.assign(new Error("File path is outside the endpoint ingress policy."), { code: "INGRESS_PATH_DENIED" });
            if (!context.auth?.isAuthenticated || context.auth?.isGuest)
                throw Object.assign(new Error("A linked actor is required to claim an ingress file."), { code: "INGRESS_ACTOR_REQUIRED" });
            const existing = await database.adapter.selectLiveFileByPath(path);
            if (existing?.length)
                throw Object.assign(new Error("File path already exists."), { code: "FILE_PATH_EXISTS" });
            const now = new Date().toISOString();
            const bucket = (await database.adapter.findFileBucket(actorId, "default")) ?? { id: crypto.randomUUID(), ownerId: actorId, name: "default", createdAt: now };
            if (!await database.adapter.findFileBucket(actorId, "default"))
                await database.adapter.createFileBucket(bucket);
            const file = { id: row.fileId, ownerId: actorId, bucketId: bucket.id, bucketName: bucket.name, path, name: safeName(options?.name ?? row.name), type: safeType(options?.type ?? row.type), size: row.size, version: row.version, status: "uploaded", createdAt: now, updatedAt: now };
            await database.adapter.insertFileRow(file);
            row.state = "claiming";
            row.file = file;
            (context.__sporadesIngressClaims ??= []).push(row);
            return fileMetadataFromRow(file);
        },
        async status(statusRequestKey, partKey) { const row = store(database).get(keyFor(endpoint, statusRequestKey, partKey, actorId)); if (!row)
            return { state: "missing" }; return row.state === "complete" ? { state: "complete", file: fileMetadataFromRow(row.file) } : { state: "leased", lease: publicLease(row) }; },
    };
}
/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export function finalizeEndpointIngressClaims(context, committed) {
    for (const row of context?.__sporadesIngressClaims ?? []) {
        if (row.state === "claiming")
            row.state = committed ? "complete" : "leased";
        if (!committed)
            delete row.file;
    }
}
//# sourceMappingURL=file-ingress-runtime.js.map