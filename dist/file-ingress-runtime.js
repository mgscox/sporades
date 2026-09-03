// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
/// <reference path="./vendor-decoders.d.ts" />
import { ensureFileBucket, fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";
import { parse, tokenizer } from "acorn";
import { parser as pythonParser } from "@lezer/python";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { parse as parseShell } from "unbash";
const crypto = process.getBuiltinModule("node:crypto");
const zlib = process.getBuiltinModule("node:zlib");
const net = process.getBuiltinModule("node:net");
const fs = process.getBuiltinModule("node:fs");
const childProcess = process.getBuiltinModule("node:child_process");
const leaseTtlMs = 10 * 60 * 1000;
const ingressClaimAuditRetentionMs = 24 * 60 * 60 * 1000;
const ingressClaimAuditPruneLimit = 50;
const clamavMaximumStreamBytes = 10 * 1024 * 1024;
export function isSupportedInspectionNodeVersion(version) { const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version); if (!match)
    return false; const major = Number(match[1]); const minor = Number(match[2]); return (major === 22 && minor >= 13) || major >= 24; }
if (!isSupportedInspectionNodeVersion(process.versions.node))
    throw Object.assign(new Error("Sporades File inspection requires Node 22.13+ or Node 24+."), { code: "UNSUPPORTED_NODE_RUNTIME" });
function ingressAuditNow(database) {
    const now = database.clock?.now?.();
    return (now instanceof Date ? now : new Date()).toISOString();
}
async function receipt(database, key) {
    const sql = database.adapter.dialect.sql("SELECT [payload] FROM [sporades_file_ingress] WHERE [key] = ?");
    const row = await database.adapter.prepare(sql).get(key);
    return row ? JSON.parse(row.payload) : null;
}
async function receiptByLease(database, leaseId) {
    const stored = await database.adapter.selectIngressByLease(leaseId);
    return stored ? JSON.parse(stored.payload) : null;
}
async function publishStagedReceipt(database, row) {
    const leased = { ...row, state: "leased" };
    const now = new Date().toISOString();
    const sql = database.adapter.dialect.sql("UPDATE [sporades_file_ingress] SET [state]='leased', [payload]=?, [updatedAt]=? WHERE [key]=? AND [leaseId]=? AND [state]='staging' AND [expiresAt]>?");
    const result = await database.adapter.prepare(sql).run(JSON.stringify(leased), now, row.key, row.leaseId, now);
    return Number(result?.changes ?? 0) > 0 ? leased : null;
}
async function acquireReceipt(database, candidate) {
    // All supported adapters accept this conflict form. The unique key is the
    // serialization point; no read-then-insert window exists for two retries.
    const sql = database.adapter.dialect.sql("INSERT INTO [sporades_file_ingress] ([key], [leaseId], [state], [actorId], [authorityKind], [authorityId], [ownerId], [principalNamespace], [principalKeyDigest], [endpointMethod], [endpointPath], [requestKey], [partKey], [expiresAt], [sweepToken], [payload], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT([key]) DO NOTHING");
    const inserted = await database.adapter.prepare(sql).run(candidate.key, candidate.leaseId, candidate.state, candidate.actorId, candidate.authorityKind, candidate.authorityId, candidate.ownerId, candidate.principalNamespace ?? null, candidate.principalKeyDigest ?? null, candidate.endpointMethod, candidate.endpointPath, candidate.requestKey, candidate.partKey, candidate.expiresAt, null, JSON.stringify(candidate), new Date().toISOString());
    if (Number(inserted?.changes ?? 0) > 0)
        return { row: candidate, winner: true };
    const row = await receipt(database, candidate.key);
    if (!row)
        throw new Error("Ingress receipt acquisition did not return a winner.");
    return { row, winner: false };
}
async function awaitCompletedStagingReceipt(database, key) {
    const maximumDeadline = Date.now() + leaseTtlMs;
    for (let attempt = 0; Date.now() < maximumDeadline; attempt += 1) {
        const row = await receipt(database, key);
        if (!row || row.state !== "staging")
            return row;
        const expiry = Date.parse(row.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= Date.now())
            return row;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1, expiry - Date.now())));
    }
    throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
}
function header(headers, name) { return headers[String(name).toLowerCase()]; }
function partHeader(rawHeaders, name) {
    const normalizedName = String(name).trim().toLowerCase();
    const line = rawHeaders.split("\r\n").find((candidate) => { const separator = candidate.indexOf(":"); return separator > 0 && candidate.slice(0, separator).trim().toLowerCase() === normalizedName; });
    if (!line)
        return undefined;
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (normalizedName === "content-id")
        return /^<([^>\r\n]+)>$/.exec(value)?.[1] ?? value;
    return value;
}
function unsupportedMultipartPartEncoding(rawHeaders) {
    if (/(?:^|[^\r])\n|\r(?!\n)/.test(rawHeaders) || rawHeaders.startsWith("\r\n") || rawHeaders.endsWith("\r\n"))
        return true;
    for (const line of rawHeaders.split("\r\n")) {
        if (/^[ \t]/.test(line))
            return true;
        const separator = line.indexOf(":");
        if (separator <= 0)
            continue;
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim().toLowerCase();
        if (name === "content-transfer-encoding")
            return true;
        if (name === "content-type" && /^multipart\//.test(value))
            return true;
    }
    return false;
}
function safeName(value) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
const maximumInspectionAgeMs = 24 * 60 * 60 * 1000;
function inspectionRequiredError() { return Object.assign(new Error("File ingress inspection is not clean."), { code: "INGRESS_INSPECTION_REQUIRED" }); }
function normalizedInspectionPolicy(value) {
    if (value === undefined)
        return null;
    const invalid = () => { throw Object.assign(new Error("Invalid file ingress inspection policy."), { code: "INVALID_MULTIPART_POLICY" }); };
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.policyRevision !== "string" || value.policyRevision.length < 1 || Buffer.byteLength(value.policyRevision, "utf8") > 128 || /[\x00-\x1f\x7f]/.test(value.policyRevision))
        invalid();
    const maxVerdictAgeMs = value.maxVerdictAgeMs ?? maximumInspectionAgeMs;
    if (!Number.isInteger(maxVerdictAgeMs) || maxVerdictAgeMs < 1 || maxVerdictAgeMs > maximumInspectionAgeMs || !Array.isArray(value.requiredInspectors) || value.requiredInspectors.length < 1 || value.requiredInspectors.length > 8)
        invalid();
    const names = new Set();
    for (const inspector of value.requiredInspectors) {
        if (!["content-policy-v1", "clamav"].includes(inspector) || names.has(inspector))
            invalid();
        names.add(inspector);
    }
    return { policyRevision: value.policyRevision, maxVerdictAgeMs, requiredInspectors: value.requiredInspectors };
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
} return (crc ^ 0xffffffff) >>> 0; }
function validPng(bytes) {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return false;
    let offset = 8;
    let index = 0;
    let sawIdat = false;
    let idatEnded = false;
    let sawPlte = false;
    let colorType = -1;
    let width = 0;
    let height = 0;
    let rowBytes = 0;
    const idatChunks = [];
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        if (length > bytes.length - offset - 12)
            return false;
        const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        const storedCrc = bytes.readUInt32BE(offset + 8 + length);
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== storedCrc)
            return false;
        if (index === 0) {
            if (type !== "IHDR" || length !== 13 || data.readUInt32BE(0) === 0 || data.readUInt32BE(4) === 0 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
                return false;
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            colorType = data[9];
            if (width > 10_000 || height > 10_000 || width * height > 25_000_000)
                return false;
            const allowed = new Set(["0:1", "0:2", "0:4", "0:8", "0:16", "2:8", "2:16", "3:1", "3:2", "3:4", "3:8", "4:8", "4:16", "6:8", "6:16"]);
            if (!allowed.has(`${colorType}:${data[8]}`))
                return false;
            const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
            rowBytes = Math.ceil(width * channels * data[8] / 8);
            if ((rowBytes + 1) * height > 100_000_000)
                return false;
        }
        if (type === "PLTE") {
            if (sawIdat || sawPlte || length === 0 || length % 3 !== 0 || length > 768 || [0, 4].includes(colorType))
                return false;
            sawPlte = true;
        }
        if (type === "IDAT") {
            if (idatEnded || (colorType === 3 && !sawPlte))
                return false;
            sawIdat = true;
            idatChunks.push(data);
        }
        else if (sawIdat && type !== "IEND")
            idatEnded = true;
        if (/^[A-Z]/.test(type[0]) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))
            return false;
        if (type === "IEND") {
            if (!(length === 0 && sawIdat && offset + 12 === bytes.length))
                return false;
            try {
                const inflated = zlib.inflateSync(Buffer.concat(idatChunks), { maxOutputLength: (rowBytes + 1) * height });
                if (inflated.length !== (rowBytes + 1) * height)
                    return false;
                for (let row = 0; row < height; row += 1)
                    if (inflated[row * (rowBytes + 1)] > 4)
                        return false;
                const decoded = PNG.sync.read(bytes, { checkCRC: true });
                return decoded.width === width && decoded.height === height && decoded.data.length === width * height * 4;
            }
            catch {
                return false;
            }
        }
        if (type === "IHDR" && index !== 0)
            return false;
        offset += 12 + length;
        index += 1;
    }
    return false;
}
function validJpeg(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return false;
    let offset = 2;
    let sawFrame = false;
    let sawScan = false;
    while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff)
            return false;
        while (offset < bytes.length && bytes[offset] === 0xff)
            offset += 1;
        if (offset >= bytes.length)
            return false;
        const marker = bytes[offset++];
        if (marker === 0xd9) {
            if (!sawScan || offset !== bytes.length)
                return false;
            try {
                const decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 25, maxMemoryUsageInMB: 64 });
                return decoded.width > 0 && decoded.height > 0 && decoded.width * decoded.height <= 25_000_000 && decoded.data.length === decoded.width * decoded.height * 4;
            }
            catch {
                return false;
            }
        }
        if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
            return false;
        if (offset + 2 > bytes.length)
            return false;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length)
            return false;
        const data = bytes.subarray(offset + 2, offset + length);
        offset += length;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            if (data.length < 6 || data[0] !== 8 || data.readUInt16BE(1) === 0 || data.readUInt16BE(3) === 0 || data[5] < 1 || data.length !== 6 + data[5] * 3)
                return false;
            sawFrame = true;
        }
        if (marker === 0xda) {
            if (!sawFrame || data.length < 6 || data[0] < 1 || data.length !== 1 + data[0] * 2 + 3)
                return false;
            sawScan = true;
            while (offset < bytes.length) {
                if (bytes[offset++] !== 0xff)
                    continue;
                if (offset >= bytes.length)
                    return false;
                const next = bytes[offset];
                if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
                    offset += 1;
                    continue;
                }
                offset -= 1;
                break;
            }
        }
    }
    return false;
}
const pdfWhitespace = (byte) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const pdfDelimiter = (byte) => pdfWhitespace(byte) || [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte);
function skipPdfTrivia(bytes, offset, limit, allowBinaryComments = false) {
    while (offset < limit) {
        while (offset < limit && pdfWhitespace(bytes[offset]))
            offset += 1;
        if (offset >= limit || bytes[offset] !== 0x25)
            break;
        offset += 1;
        while (offset < limit && bytes[offset] !== 10 && bytes[offset] !== 13) {
            if (!allowBinaryComments && (bytes[offset] < 0x20 || bytes[offset] > 0x7e))
                return -1;
            offset += 1;
        }
    }
    return offset;
}
function pdfKeywordAt(bytes, offset, keyword) {
    const end = offset + keyword.length;
    return end <= bytes.length && bytes.subarray(offset, end).toString("ascii") === keyword && (end === bytes.length || pdfDelimiter(bytes[end]));
}
function pdfDictionary(bytes, offset, integerKeys, nameKeys = new Set(), integerArrayKeys = new Set(), nameListKeys = new Set()) {
    if (bytes[offset] !== 0x3c || bytes[offset + 1] !== 0x3c)
        return null;
    const values = new Map();
    const names = new Map();
    const arrays = new Map();
    const nameLists = new Map();
    let depth = 0;
    let index = offset;
    let steps = 0;
    while (index < bytes.length && ++steps <= 2_000_000) {
        const byte = bytes[index];
        if (byte === 0x25) {
            while (index < bytes.length && bytes[index] !== 10 && bytes[index] !== 13)
                index += 1;
            continue;
        }
        if (byte === 0x28) {
            let stringDepth = 1;
            index += 1;
            while (index < bytes.length && stringDepth > 0 && ++steps <= 2_000_000) {
                if (bytes[index] === 0x5c)
                    index += 2;
                else {
                    if (bytes[index] === 0x28)
                        stringDepth += 1;
                    else if (bytes[index] === 0x29)
                        stringDepth -= 1;
                    index += 1;
                }
            }
            if (stringDepth)
                return null;
            continue;
        }
        if (byte === 0x3c && bytes[index + 1] !== 0x3c) {
            index += 1;
            while (index < bytes.length && bytes[index] !== 0x3e)
                index += 1;
            if (index >= bytes.length)
                return null;
            index += 1;
            continue;
        }
        if (byte === 0x3c && bytes[index + 1] === 0x3c) {
            depth += 1;
            index += 2;
            continue;
        }
        if (byte === 0x3e && bytes[index + 1] === 0x3e) {
            depth -= 1;
            index += 2;
            if (depth === 0)
                return { end: index, values, names, arrays, nameLists };
            if (depth < 0)
                return null;
            continue;
        }
        if (byte === 0x2f) {
            const nameStart = ++index;
            while (index < bytes.length && !pdfDelimiter(bytes[index]))
                index += 1;
            const name = bytes.subarray(nameStart, index).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
            if (depth === 1 && integerKeys.has(name)) {
                let valueAt = skipPdfTrivia(bytes, index, bytes.length);
                if (valueAt < 0)
                    return null;
                const match = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20\[\]()<>\/%]|$)/.exec(bytes.subarray(valueAt, Math.min(bytes.length, valueAt + 40)).toString("latin1"));
                if (!match || values.has(name))
                    return null;
                const value = Number(match[1]);
                if (!Number.isSafeInteger(value))
                    return null;
                const after = skipPdfTrivia(bytes, valueAt + match[1].length, bytes.length);
                if (after < 0 || /^\d+[\x00\x09\x0a\x0c\x0d\x20]+R(?:[\x00\x09\x0a\x0c\x0d\x20\[\]()<>\/%]|$)/.test(bytes.subarray(after, Math.min(bytes.length, after + 40)).toString("latin1")))
                    return null;
                values.set(name, value);
            }
            else if (depth === 1 && nameKeys.has(name)) {
                let valueAt = skipPdfTrivia(bytes, index, bytes.length);
                if (valueAt < 0 || bytes[valueAt] !== 0x2f || names.has(name))
                    return null;
                const valueStart = ++valueAt;
                while (valueAt < bytes.length && !pdfDelimiter(bytes[valueAt]))
                    valueAt += 1;
                const value = bytes.subarray(valueStart, valueAt).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
                if (!value)
                    return null;
                names.set(name, value);
            }
            else if (depth === 1 && integerArrayKeys.has(name)) {
                let valueAt = skipPdfTrivia(bytes, index, bytes.length);
                if (valueAt < 0 || bytes[valueAt] !== 0x5b || arrays.has(name))
                    return null;
                const result = [];
                valueAt += 1;
                while (result.length <= 2_000) {
                    valueAt = skipPdfTrivia(bytes, valueAt, bytes.length);
                    if (valueAt < 0)
                        return null;
                    if (bytes[valueAt] === 0x5d) {
                        arrays.set(name, result);
                        break;
                    }
                    const item = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20\]])/.exec(bytes.subarray(valueAt, Math.min(bytes.length, valueAt + 40)).toString("latin1"));
                    if (!item)
                        return null;
                    const value = Number(item[1]);
                    if (!Number.isSafeInteger(value))
                        return null;
                    result.push(value);
                    valueAt += item[1].length;
                }
                if (!arrays.has(name))
                    return null;
            }
            else if (depth === 1 && nameListKeys.has(name)) {
                let valueAt = skipPdfTrivia(bytes, index, bytes.length);
                if (valueAt < 0 || nameLists.has(name))
                    return null;
                const result = [];
                const array = bytes[valueAt] === 0x5b;
                if (array)
                    valueAt += 1;
                while (result.length <= 16) {
                    valueAt = skipPdfTrivia(bytes, valueAt, bytes.length);
                    if (valueAt < 0 || bytes[valueAt] !== 0x2f)
                        return null;
                    const valueStart = ++valueAt;
                    while (valueAt < bytes.length && !pdfDelimiter(bytes[valueAt]))
                        valueAt += 1;
                    const value = bytes.subarray(valueStart, valueAt).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
                    if (!value)
                        return null;
                    result.push(value);
                    valueAt = skipPdfTrivia(bytes, valueAt, bytes.length);
                    if (valueAt < 0)
                        return null;
                    if (!array || bytes[valueAt] === 0x5d) {
                        nameLists.set(name, result);
                        break;
                    }
                }
                if (!nameLists.has(name))
                    return null;
            }
            continue;
        }
        index += 1;
    }
    return null;
}
function pdfXrefSection(bytes, offset, allowHybrid = true) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length)
        return null;
    if (pdfKeywordAt(bytes, offset, "xref")) {
        let cursor = offset + 4;
        let entryCount = 0;
        let highestObject = -1;
        const entries = new Map();
        const objectOffsets = new Set();
        while (cursor < bytes.length) {
            cursor = skipPdfTrivia(bytes, cursor, bytes.length);
            if (cursor < 0)
                return null;
            if (pdfKeywordAt(bytes, cursor, "trailer")) {
                cursor = skipPdfTrivia(bytes, cursor + 7, bytes.length);
                if (cursor < 0)
                    return null;
                const dictionary = pdfDictionary(bytes, cursor, new Set(["Prev", "Size", "XRefStm"]));
                const size = dictionary?.values.get("Size");
                if (!dictionary || size === undefined || size < 1 || size > 1_000_000 || highestObject >= size || [...entries.values()].some((entry) => entry.type === 0 && entry.nextFree >= size))
                    return null;
                const hybridOffset = dictionary.values.get("XRefStm");
                if (hybridOffset !== undefined) {
                    if (!allowHybrid)
                        return null;
                    if (hybridOffset <= 0 || hybridOffset >= offset)
                        return null;
                    const hybrid = pdfXrefSection(bytes, hybridOffset, false);
                    if (!hybrid || hybrid.kind !== "stream" || hybrid.size !== size || hybrid.prev !== undefined)
                        return null;
                    for (const [objectNumber, entry] of hybrid.entries) {
                        // PDF 32000-1 7.5.8.4 resolves a hybrid lookup through the current
                        // classic section before its XRefStm, then through Prev. Match that
                        // deterministic order after each source has rejected its own
                        // duplicate object identities.
                        if (!entries.has(objectNumber))
                            entries.set(objectNumber, entry);
                    }
                    for (const objectOffset of hybrid.objectOffsets)
                        objectOffsets.add(objectOffset);
                    if (!pdfRevisionObjectsOnly(bytes, hybrid.end, offset, objectOffsets))
                        return null;
                    highestObject = Math.max(highestObject, hybrid.maxObject);
                }
                return { kind: "classic", end: dictionary.end, prev: dictionary.values.get("Prev"), size, maxObject: highestObject, entries, objectOffsets };
            }
            const header = /^(\d{1,10})[\x00\x09\x0c\x20]+(\d{1,10})[\x00\x09\x0c\x20]*(?:\r\n|\r|\n)/.exec(bytes.subarray(cursor, Math.min(bytes.length, cursor + 80)).toString("latin1"));
            if (!header)
                return null;
            const first = Number(header[1]);
            const count = Number(header[2]);
            if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 1 || first + count > 1_000_000 || entryCount + count > 1_000_000)
                return null;
            highestObject = Math.max(highestObject, first + count - 1);
            cursor += header[0].length;
            entryCount += count;
            for (let index = 0; index < count; index += 1) {
                const entry = /^(\d{10})[\x00\x09\x0c\x20]+(\d{5})[\x00\x09\x0c\x20]+([fn])[\x00\x09\x0c\x20]*(?:\r\n|\r|\n)/.exec(bytes.subarray(cursor, Math.min(bytes.length, cursor + 40)).toString("latin1"));
                if (!entry)
                    return null;
                const objectNumber = first + index;
                const objectOffset = Number(entry[1]);
                const generation = Number(entry[2]);
                if (generation > 65_535 || entries.has(objectNumber) || (objectNumber === 0 && (entry[3] !== "f" || generation !== 65_535)))
                    return null;
                if (entry[3] === "n") {
                    if (objectOffset >= offset)
                        return null;
                    const target = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(objectOffset, Math.min(bytes.length, objectOffset + 80)).toString("latin1"));
                    if (!target || Number(target[1]) !== objectNumber || Number(target[2]) !== generation)
                        return null;
                    entries.set(objectNumber, { type: 1, offset: objectOffset, generation });
                    objectOffsets.add(objectOffset);
                }
                else
                    entries.set(objectNumber, { type: 0, nextFree: objectOffset, generation });
                cursor += entry[0].length;
            }
        }
        return null;
    }
    const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(offset, Math.min(bytes.length, offset + 80)).toString("latin1"));
    if (!head || Number(head[2]) > 65_535)
        return null;
    let cursor = skipPdfTrivia(bytes, offset + head[0].length, bytes.length);
    if (cursor < 0)
        return null;
    const dictionary = pdfDictionary(bytes, cursor, new Set(["Length", "Prev", "Size"]), new Set(["Type"]), new Set(["W", "Index"]), new Set(["Filter"]));
    const width = dictionary?.arrays.get("W");
    const size = dictionary?.values.get("Size");
    if (!dictionary || !dictionary.values.has("Length") || dictionary.names.get("Type") !== "XRef" || size === undefined || size < 1 || size > 1_000_000 || !width || width.length !== 3 || width.some((item) => item > 6) || width[1] === 0 || width[0] + width[1] + width[2] === 0)
        return null;
    const index = dictionary.arrays.get("Index") ?? [0, size];
    if (index.length === 0 || index.length % 2 !== 0)
        return null;
    let entryCount = 0;
    let previousRangeEnd = 0;
    let maxObject = -1;
    for (let at = 0; at < index.length; at += 2) {
        const first = index[at];
        const count = index[at + 1];
        if (count < 1 || first < previousRangeEnd || first + count > size)
            return null;
        previousRangeEnd = first + count;
        maxObject = Math.max(maxObject, previousRangeEnd - 1);
        entryCount += count;
    }
    const recordBytes = width[0] + width[1] + width[2];
    if (entryCount > 1_000_000 || entryCount * recordBytes > 24_000_000)
        return null;
    cursor = skipPdfTrivia(bytes, dictionary.end, bytes.length);
    if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "stream"))
        return null;
    cursor += 6;
    if (bytes[cursor] === 13 && bytes[cursor + 1] === 10)
        cursor += 2;
    else if (bytes[cursor] === 10 || bytes[cursor] === 13)
        cursor += 1;
    else
        return null;
    const streamStart = cursor;
    cursor += dictionary.values.get("Length");
    if (cursor > bytes.length)
        return null;
    let decoded;
    try {
        const filters = dictionary.nameLists.get("Filter");
        if (filters === undefined)
            decoded = bytes.subarray(streamStart, cursor);
        else if (filters.length === 1 && filters[0] === "FlateDecode")
            decoded = zlib.inflateSync(bytes.subarray(streamStart, cursor), { maxOutputLength: entryCount * recordBytes + 1 });
        else
            return null;
    }
    catch {
        return null;
    }
    if (decoded.length !== entryCount * recordBytes)
        return null;
    const readField = (at, length) => { let value = 0; for (let byte = 0; byte < length; byte += 1)
        value = value * 256 + decoded[at + byte]; return value; };
    const entries = new Map();
    const objectOffsets = new Set();
    let decodedAt = 0;
    let sawSelf = false;
    for (let range = 0; range < index.length; range += 2)
        for (let item = 0; item < index[range + 1]; item += 1) {
            const objectNumber = index[range] + item;
            const type = width[0] === 0 ? 1 : readField(decodedAt, width[0]);
            const field2 = readField(decodedAt + width[0], width[1]);
            const field3 = readField(decodedAt + width[0] + width[1], width[2]);
            decodedAt += recordBytes;
            if (((type === 0 || type === 1) && field3 > 65_535) || (objectNumber === 0 && (type !== 0 || field3 !== 65_535)))
                return null;
            if (type === 1) {
                if (field2 > offset || (objectNumber !== Number(head[1]) && field2 === offset))
                    return null;
                const target = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(field2, Math.min(bytes.length, field2 + 80)).toString("latin1"));
                if (!target || Number(target[1]) !== objectNumber || Number(target[2]) !== field3)
                    return null;
                entries.set(objectNumber, { type: 1, offset: field2, generation: field3 });
                objectOffsets.add(field2);
                if (objectNumber === Number(head[1]))
                    sawSelf = field2 === offset && field3 === Number(head[2]);
            }
            else if (type === 2) {
                if (field2 >= size)
                    return null;
                entries.set(objectNumber, { type: 2, objectStream: field2, index: field3 });
            }
            else if (type === 0) {
                if (field2 >= size)
                    return null;
                entries.set(objectNumber, { type: 0, nextFree: field2, generation: field3 });
            }
            else
                return null;
        }
    if (!sawSelf)
        return null;
    if (bytes[cursor] === 13 && bytes[cursor + 1] === 10)
        cursor += 2;
    else if (bytes[cursor] === 10 || bytes[cursor] === 13)
        cursor += 1;
    if (!pdfKeywordAt(bytes, cursor, "endstream"))
        return null;
    cursor = skipPdfTrivia(bytes, cursor + 9, bytes.length);
    if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "endobj"))
        return null;
    return { kind: "stream", end: cursor + 6, prev: dictionary.values.get("Prev"), size, maxObject, entries, objectOffsets };
}
function pdfFooterAfter(bytes, sectionEnd, limit) {
    let cursor = skipPdfTrivia(bytes, sectionEnd, limit);
    if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "startxref"))
        return null;
    const start = cursor;
    cursor = skipPdfTrivia(bytes, cursor + 9, limit);
    if (cursor < 0)
        return null;
    const pointer = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(cursor, Math.min(limit, cursor + 40)).toString("latin1"));
    if (!pointer)
        return null;
    cursor += pointer[1].length;
    while (cursor < limit && pdfWhitespace(bytes[cursor]))
        cursor += 1;
    if (cursor + 5 > limit || bytes.subarray(cursor, cursor + 5).toString("ascii") !== "%%EOF" || (cursor > 0 && bytes[cursor - 1] !== 10 && bytes[cursor - 1] !== 13))
        return null;
    const end = cursor + 5;
    if (end < limit && bytes[end] !== 10 && bytes[end] !== 13)
        return null;
    return { start, end, pointer: Number(pointer[1]) };
}
function pdfRevisionObjectsOnly(bytes, start, end, referencedOffsets, allowBinaryComments = false) {
    let cursor = skipPdfTrivia(bytes, start, end, allowBinaryComments);
    if (cursor < 0)
        return false;
    while (cursor < end) {
        if (referencedOffsets && !referencedOffsets.has(cursor))
            return false;
        const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(cursor, Math.min(end, cursor + 80)).toString("latin1"));
        if (!head || Number(head[2]) > 65_535)
            return false;
        let index = cursor + head[0].length;
        let foundEnd = false;
        let steps = 0;
        while (index < end && ++steps <= 2_000_000) {
            if (bytes[index] === 0x25) {
                while (index < end && bytes[index] !== 10 && bytes[index] !== 13)
                    index += 1;
                continue;
            }
            if (bytes[index] === 0x28) {
                let depth = 1;
                index += 1;
                while (index < end && depth > 0 && ++steps <= 2_000_000) {
                    if (bytes[index] === 0x5c)
                        index += 2;
                    else {
                        if (bytes[index] === 0x28)
                            depth += 1;
                        else if (bytes[index] === 0x29)
                            depth -= 1;
                        index += 1;
                    }
                }
                if (depth)
                    return false;
                continue;
            }
            if (bytes[index] === 0x3c && bytes[index + 1] !== 0x3c) {
                index += 1;
                while (index < end && bytes[index] !== 0x3e)
                    index += 1;
                if (index >= end)
                    return false;
                index += 1;
                continue;
            }
            if (bytes[index] === 0x3c && bytes[index + 1] === 0x3c) {
                const dictionary = pdfDictionary(bytes, index, new Set(["Length"]));
                if (!dictionary)
                    return false;
                const after = skipPdfTrivia(bytes, dictionary.end, end);
                if (after < 0)
                    return false;
                if (pdfKeywordAt(bytes, after, "stream")) {
                    const length = dictionary.values.get("Length");
                    if (length === undefined)
                        return false;
                    index = after + 6;
                    if (bytes[index] === 13 && bytes[index + 1] === 10)
                        index += 2;
                    else if (bytes[index] === 10 || bytes[index] === 13)
                        index += 1;
                    else
                        return false;
                    index += length;
                    if (index > end)
                        return false;
                    if (bytes[index] === 13 && bytes[index + 1] === 10)
                        index += 2;
                    else if (bytes[index] === 10 || bytes[index] === 13)
                        index += 1;
                    if (!pdfKeywordAt(bytes, index, "endstream"))
                        return false;
                    index += 9;
                    continue;
                }
                index = dictionary.end;
                continue;
            }
            if (pdfKeywordAt(bytes, index, "endobj")) {
                cursor = index + 6;
                foundEnd = true;
                break;
            }
            index += 1;
        }
        if (!foundEnd)
            return false;
        cursor = skipPdfTrivia(bytes, cursor, end, allowBinaryComments);
        if (cursor < 0)
            return false;
    }
    return cursor === end;
}
function pdfObjectStreamNumbers(bytes, entry) {
    const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(entry.offset, Math.min(bytes.length, entry.offset + 80)).toString("latin1"));
    if (!head || Number(head[2]) !== entry.generation)
        return null;
    let cursor = skipPdfTrivia(bytes, entry.offset + head[0].length, bytes.length);
    if (cursor < 0)
        return null;
    const dictionary = pdfDictionary(bytes, cursor, new Set(["Length", "N", "First"]), new Set(["Type"]), new Set(), new Set(["Filter"]));
    const length = dictionary?.values.get("Length");
    const count = dictionary?.values.get("N");
    const first = dictionary?.values.get("First");
    if (!dictionary || dictionary.names.get("Type") !== "ObjStm" || length === undefined || count === undefined || count < 1 || count > 100_000 || first === undefined || first > 24_000_000)
        return null;
    cursor = skipPdfTrivia(bytes, dictionary.end, bytes.length);
    if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "stream"))
        return null;
    cursor += 6;
    if (bytes[cursor] === 13 && bytes[cursor + 1] === 10)
        cursor += 2;
    else if (bytes[cursor] === 10 || bytes[cursor] === 13)
        cursor += 1;
    else
        return null;
    const streamStart = cursor;
    cursor += length;
    if (cursor > bytes.length)
        return null;
    let decoded;
    try {
        const filters = dictionary.nameLists.get("Filter");
        if (filters === undefined)
            decoded = bytes.subarray(streamStart, cursor);
        else if (filters.length === 1 && filters[0] === "FlateDecode")
            decoded = zlib.inflateSync(bytes.subarray(streamStart, cursor), { maxOutputLength: 24_000_001 });
        else
            return null;
    }
    catch {
        return null;
    }
    if (decoded.length > 24_000_000 || first > decoded.length)
        return null;
    const objectNumbers = [];
    const seen = new Set();
    let headerAt = 0;
    let previousOffset = -1;
    for (let index = 0; index < count; index += 1) {
        headerAt = skipPdfTrivia(decoded, headerAt, first);
        if (headerAt < 0)
            return null;
        const pair = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(decoded.subarray(headerAt, Math.min(first, headerAt + 80)).toString("latin1"));
        if (!pair)
            return null;
        const objectNumber = Number(pair[1]);
        const objectOffset = Number(pair[2]);
        if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || seen.has(objectNumber) || !Number.isSafeInteger(objectOffset) || objectOffset <= previousOffset || first + objectOffset >= decoded.length)
            return null;
        seen.add(objectNumber);
        objectNumbers.push(objectNumber);
        previousOffset = objectOffset;
        headerAt += pair[0].length;
    }
    if (previousOffset < 0 || skipPdfTrivia(decoded, headerAt, first) !== first)
        return null;
    if (bytes[cursor] === 13 && bytes[cursor + 1] === 10)
        cursor += 2;
    else if (bytes[cursor] === 10 || bytes[cursor] === 13)
        cursor += 1;
    if (!pdfKeywordAt(bytes, cursor, "endstream"))
        return null;
    cursor = skipPdfTrivia(bytes, cursor + 9, bytes.length);
    if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "endobj"))
        return null;
    return objectNumbers;
}
function validPdfEffectiveXref(bytes, size, entries) {
    const head = entries.get(0);
    if (!head || head.type !== 0 || head.generation !== 65_535)
        return false;
    const linkedFree = new Set();
    let freeAt = head.nextFree;
    while (freeAt !== 0) {
        if (freeAt >= size || linkedFree.has(freeAt))
            return false;
        const entry = entries.get(freeAt);
        if (!entry || entry.type !== 0)
            return false;
        linkedFree.add(freeAt);
        freeAt = entry.nextFree;
    }
    for (const [objectNumber, entry] of entries)
        if (objectNumber !== 0 && entry.type === 0 && !linkedFree.has(objectNumber))
            return false;
    const objectStreams = new Map();
    for (const [objectNumber, entry] of entries)
        if (entry.type === 2) {
            const container = entries.get(entry.objectStream);
            if (!container || container.type !== 1)
                return false;
            let objectNumbers = objectStreams.get(entry.objectStream);
            if (!objectNumbers) {
                objectNumbers = pdfObjectStreamNumbers(bytes, container) ?? undefined;
                if (!objectNumbers)
                    return false;
                objectStreams.set(entry.objectStream, objectNumbers);
            }
            if (entry.index >= objectNumbers.length || objectNumbers[entry.index] !== objectNumber)
                return false;
        }
    for (const [containerNumber, objectNumbers] of objectStreams)
        for (let index = 0; index < objectNumbers.length; index += 1) {
            const entry = entries.get(objectNumbers[index]);
            if (!entry || entry.type !== 2 || entry.objectStream !== containerNumber || entry.index !== index)
                return false;
        }
    return true;
}
function validPdfTerminalBoundary(bytes) {
    // Each accepted EOF is tied to the xref section which immediately precedes
    // its startxref footer. Following /Prev proves that the terminal section is
    // a real incremental revision rather than a forged footer over appended data.
    let terminalMarker = bytes.lastIndexOf(Buffer.from("%%EOF"));
    while (terminalMarker >= 0 && ((terminalMarker > 0 && bytes[terminalMarker - 1] !== 10 && bytes[terminalMarker - 1] !== 13) || skipPdfTrivia(bytes, terminalMarker + 5, bytes.length) !== bytes.length))
        terminalMarker = bytes.lastIndexOf(Buffer.from("%%EOF"), terminalMarker - 1);
    if (terminalMarker < 0)
        return false;
    const footerPrefix = bytes.subarray(Math.max(0, terminalMarker - 160), terminalMarker).toString("latin1");
    const footerStart = /startxref[\x00\x09\x0a\x0c\x0d\x20]+\d{1,20}[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(footerPrefix);
    if (!footerStart)
        return false;
    const absoluteFooterStart = Math.max(0, terminalMarker - 160) + footerStart.index;
    const pointerMatch = /startxref[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,20})/.exec(footerStart[0]);
    if (!pointerMatch)
        return false;
    let offset = Number(pointerMatch[1]);
    const seen = new Set();
    const chain = [];
    let revisions = 0;
    while (++revisions <= 256) {
        if (seen.has(offset))
            return false;
        seen.add(offset);
        const section = pdfXrefSection(bytes, offset);
        if (!section)
            return false;
        const footer = pdfFooterAfter(bytes, section.end, bytes.length);
        if (!footer || footer.pointer !== offset)
            return false;
        if (revisions === 1 && footer.start !== absoluteFooterStart)
            return false;
        chain.push({ offset, end: footer.end, prev: section.prev, size: section.size, maxObject: section.maxObject, entries: section.entries, objectOffsets: section.objectOffsets });
        if (section.prev === undefined) {
            const earlierFooter = /startxref[\x00\x09\x0a\x0c\x0d\x20]+\d{1,20}[\x00\x09\x0a\x0c\x0d\x20]+%%EOF/.test(bytes.subarray(0, offset).toString("latin1"));
            if (earlierFooter)
                return false;
            const header = /^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.exec(bytes.subarray(0, Math.min(offset, 32)).toString("latin1"));
            if (!header || !pdfRevisionObjectsOnly(bytes, header[0].length, offset, section.objectOffsets, true))
                return false;
            for (let index = chain.length - 2; index >= 0; index -= 1) {
                const current = chain[index];
                const previous = chain[index + 1];
                if (current.size !== Math.max(previous.size, current.maxObject + 1))
                    return false;
                if (!pdfRevisionObjectsOnly(bytes, previous.end, current.offset, current.objectOffsets))
                    return false;
            }
            if (chain.at(-1).size !== chain.at(-1).maxObject + 1)
                return false;
            const effective = new Map();
            for (const revision of chain)
                for (const [objectNumber, entry] of revision.entries)
                    if (!effective.has(objectNumber))
                        effective.set(objectNumber, entry);
            return validPdfEffectiveXref(bytes, chain[0].size, effective);
        }
        if (section.prev >= offset)
            return false;
        offset = section.prev;
    }
    return false;
}
export async function validatePdfIngress(bytes, options = {}) {
    if (bytes.length < 16 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || bytes.includes(Buffer.from("/Encrypt")) || !validPdfTerminalBoundary(bytes))
        return false;
    let task;
    let timer;
    const timeoutMs = Number.isInteger(options.timeoutMs) ? Math.max(1, Math.min(2_000, options.timeoutMs)) : 2_000;
    try {
        task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true });
        const workflow = (async () => {
            const [document, parsed] = await Promise.all([task.promise, PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false })]);
            if (document.numPages < 1 || document.numPages > 100)
                return false;
            const visitedObjects = new WeakMap();
            const visitedRefs = new Map();
            let visitedCount = 0;
            const actionBearingKeys = new Set(["/OpenAction", "/AA"]);
            const outlineItemLinkKeys = new Set(["/First", "/Last", "/Next", "/Prev"]);
            const forbiddenStructureKeys = new Set(["/JavaScript", "/EmbeddedFiles", "/EF", "/XFA"]);
            const actionSubtypes = new Set(["/GoTo", "/GoToR", "/GoToE", "/Launch", "/Thread", "/URI", "/Sound", "/Movie", "/Hide", "/Named", "/SubmitForm", "/ResetForm", "/ImportData", "/JavaScript", "/SetOCGState", "/Rendition", "/Trans", "/GoTo3DView"]);
            const semanticName = (candidate, key) => {
                let value = candidate.get(PDFName.of(key));
                if (value === undefined)
                    return undefined;
                const refs = new Set();
                for (let hop = 0; hop < 16; hop += 1) {
                    if (value instanceof PDFName)
                        return value.asString();
                    if (!(value instanceof PDFRef))
                        return null;
                    const ref = value.toString();
                    if (refs.has(ref))
                        return null;
                    refs.add(ref);
                    try {
                        value = parsed.context.lookup(value);
                    }
                    catch {
                        return null;
                    }
                    if (value === undefined)
                        return null;
                }
                return null;
            };
            const visit = (candidate, depth = 0, role = "ordinary") => {
                if (depth > 128 || ++visitedCount > 100_000)
                    return false;
                // Action ownership follows the object graph from the catalog's Pages
                // and Outlines roots. It never depends on optional annotation or
                // outline marker fields: /A is also a benign StructElem/IconFit key.
                // Reject the whole reachable value even when it is indirect, an array,
                // or a dictionary that legally omits /Type /Action and /S.
                if (role === "action")
                    return false;
                if (candidate instanceof PDFRef) {
                    const key = candidate.toString();
                    const roles = visitedRefs.get(key) ?? new Set();
                    if (roles.has(role))
                        return true;
                    roles.add(role);
                    visitedRefs.set(key, roles);
                    return visit(parsed.context.lookup(candidate), depth + 1, role);
                }
                if (!candidate || typeof candidate !== "object")
                    return true;
                const objectRoles = visitedObjects.get(candidate) ?? new Set();
                if (objectRoles.has(role))
                    return true;
                objectRoles.add(role);
                visitedObjects.set(candidate, objectRoles);
                if (candidate instanceof PDFStream)
                    return visit(candidate.dict, depth + 1, role);
                if (candidate instanceof PDFArray) {
                    for (let index = 0; index < candidate.size(); index += 1)
                        if (!visit(candidate.get(index), depth + 1, role))
                            return false;
                    return true;
                }
                if (!(candidate instanceof PDFDict))
                    return true;
                const type = semanticName(candidate, "Type");
                if (type === null || type === "/Action" || type === "/Filespec" || type === "/EmbeddedFile")
                    return false;
                const subtype = semanticName(candidate, "S");
                if (subtype === null)
                    return false;
                // /S is shared by many benign PDF structures (border styles,
                // transparency groups, and more). It is action semantics only for a
                // standardized action subtype or in an action-bearing context.
                if (subtype !== undefined && actionSubtypes.has(subtype))
                    return false;
                const ownsActivationAction = role === "annotation" || role === "outline-item";
                for (const [key, value] of candidate.entries()) {
                    const name = key.asString();
                    if (forbiddenStructureKeys.has(name) || name === "/JS")
                        return false;
                    // /Next is also the ordinary sibling pointer in outline trees. It is
                    // an action chain only after this dictionary has independently been
                    // classified as an action; those dictionaries are rejected above.
                    let childRole = actionBearingKeys.has(name) || (name === "/A" && ownsActivationAction) ? "action" : "ordinary";
                    if (candidate === parsed.catalog && name === "/Pages")
                        childRole = "page-tree";
                    else if (candidate === parsed.catalog && name === "/Outlines")
                        childRole = "outline-root";
                    else if (role === "page-tree" && name === "/Kids")
                        childRole = "page-tree";
                    else if (role === "page-tree" && name === "/Annots")
                        childRole = "annotation";
                    else if (role === "outline-root" && (name === "/First" || name === "/Last"))
                        childRole = "outline-item";
                    else if (role === "outline-item" && outlineItemLinkKeys.has(name))
                        childRole = "outline-item";
                    if (!visit(value, depth + 1, childRole))
                        return false;
                }
                return true;
            };
            if (!visit(parsed.catalog))
                return false;
            for (const [, object] of parsed.context.enumerateIndirectObjects())
                if (!visit(object))
                    return false;
            const catalogChecks = await Promise.all([document.getAttachments?.(), document.getJSActions?.(), document.getOpenAction?.()]);
            const hasEntries = (value) => Boolean(value) && (value instanceof Map || value instanceof Set ? value.size > 0 : Array.isArray(value) ? value.length > 0 : typeof value !== "object" || Object.keys(value).length > 0);
            if (catalogChecks.some(hasEntries))
                return false;
            for (let page = 1; page <= document.numPages; page += 1) {
                await options.beforeOperatorList?.(page);
                const currentPage = await document.getPage(page);
                const [operators, actions, annotations] = await Promise.all([currentPage.getOperatorList(), currentPage.getJSActions?.(), currentPage.getAnnotations?.({ intent: "display" })]);
                if (hasEntries(actions))
                    return false;
                if (Array.isArray(annotations) && annotations.some((annotation) => annotation?.action || annotation?.attachment || annotation?.file || annotation?.unsafeUrl || annotation?.annotationType === 17))
                    return false;
                void operators;
            }
            return true;
        })();
        return await Promise.race([workflow, new Promise((_, reject) => { timer = setTimeout(() => { try {
                task?.destroy?.();
            }
            catch { } reject(new Error("PDF inspection timeout")); }, timeoutMs); })]);
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
        try {
            await task?.destroy?.();
        }
        catch { }
    }
}
const maximumContentPolicyTextBytes = 1024 * 1024;
const maximumContentPolicyTokens = 100_000;
const maximumContentPolicyAstNodes = 100_000;
const maximumContentPolicyAstDepth = 256;
// Lezer adds wrapper nodes around every Python grouping. The raw structural
// budget has already capped delimiter nesting at 256, so twice that allowance
// keeps the documented raw boundary usable while retaining a hard tree bound.
const maximumPythonContentPolicyAstDepth = maximumContentPolicyAstDepth * 2;
const maximumContentPolicyParserRecursion = 256;
const recursiveJavaScriptGrammarLabels = new Set([
    "new", "=>", "?", "...", "**",
    "if", "else", "for", "while", "with", "do",
]);
const executableJavaScriptNodes = new Set([
    "ArrowFunctionExpression", "AssignmentExpression", "AwaitExpression", "CallExpression",
    "ClassDeclaration", "ClassExpression",
    "DebuggerStatement", "DoWhileStatement", "ExportAllDeclaration", "ExportDefaultDeclaration",
    "ExportNamedDeclaration", "ForInStatement", "ForOfStatement", "ForStatement",
    "FunctionDeclaration", "FunctionExpression", "IfStatement", "ImportDeclaration", "ImportExpression",
    "MemberExpression", "NewExpression",
    "SwitchStatement", "TaggedTemplateExpression", "ThrowStatement", "TryStatement",
    "UpdateExpression", "VariableDeclaration", "WhileStatement", "WithStatement",
    "YieldExpression",
]);
function isStructuredAcornSyntaxError(error) {
    const value = error;
    return error instanceof SyntaxError && Number.isInteger(value?.pos) && Number.isInteger(value?.raisedAt)
        && Number.isInteger(value?.loc?.line) && Number.isInteger(value?.loc?.column);
}
function isAcornStackExhaustion(error) {
    // This exact diagnostic is defense-in-depth for the pinned parser. The flat
    // tokenizer bounds below independently stop known recursive grammar shapes
    // before parse(), so admission does not depend on diagnostic prose alone.
    return isStructuredAcornSyntaxError(error) && String(error.message).startsWith("Not enough stack space to parse input");
}
export function isJavaScriptRawInputWithinBounds(text) {
    let depth = 0;
    for (const character of text) {
        if (character === "(" || character === "[" || character === "{") {
            depth += 1;
            if (depth > maximumContentPolicyParserRecursion)
                return false;
        }
        else if (character === ")" || character === "]" || character === "}") {
            depth = Math.max(0, depth - 1);
        }
    }
    return true;
}
function boundedJavaScriptPreparse(text) {
    if (!isJavaScriptRawInputWithinBounds(text))
        return "exhausted";
    const closingFor = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["${", "}"]]);
    const closings = [];
    let recursiveGrammarTokens = 0;
    let unmatchedConditionals = 0;
    let tokens = 0;
    try {
        const input = tokenizer(text, { ecmaVersion: "latest", sourceType: "module" });
        while (true) {
            const token = input.getToken();
            const label = token.type.label;
            tokens += 1;
            if (tokens > maximumContentPolicyTokens)
                return "exhausted";
            const type = token.type;
            const value = token.value;
            const contextualRecursion = label === "name" && (value === "await" || value === "yield");
            const unmatchedLabel = label === ":" && unmatchedConditionals === 0;
            if (label === "?")
                unmatchedConditionals += 1;
            else if (label === ":" && unmatchedConditionals > 0)
                unmatchedConditionals -= 1;
            if (type.prefix || type.binop != null || type.isAssign || contextualRecursion
                || recursiveJavaScriptGrammarLabels.has(label) || unmatchedLabel) {
                recursiveGrammarTokens += 1;
                if (recursiveGrammarTokens > maximumContentPolicyParserRecursion)
                    return "exhausted";
            }
            const closing = closingFor.get(label);
            if (closing) {
                closings.push(closing);
                if (closings.length > maximumContentPolicyParserRecursion)
                    return "exhausted";
            }
            else if (closings.at(-1) === label) {
                closings.pop();
            }
            if (label === "eof")
                return "within-bounds";
        }
    }
    catch (error) {
        return isStructuredAcornSyntaxError(error) && !isAcornStackExhaustion(error) ? "invalid" : "exhausted";
    }
}
export function isJavaScriptParserInputWithinBounds(text) {
    return boundedJavaScriptPreparse(text) !== "exhausted";
}
export function hasExecutableJavaScriptSemantics(text) {
    const preparse = boundedJavaScriptPreparse(text);
    if (preparse === "exhausted")
        return true;
    if (preparse === "invalid")
        return false;
    let root;
    try {
        root = parse(text, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    }
    catch (error) {
        return isStructuredAcornSyntaxError(error) && !isAcornStackExhaustion(error) ? false : true;
    }
    const pending = [{ node: root, depth: 0 }];
    let visited = 0;
    while (pending.length > 0) {
        const { node, depth } = pending.pop();
        visited += 1;
        if (visited > maximumContentPolicyAstNodes || depth > maximumContentPolicyAstDepth)
            return true;
        if (executableJavaScriptNodes.has(node.type))
            return true;
        if (node.type === "UnaryExpression" && node.operator === "delete")
            return true;
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const child of value)
                    if (child && typeof child === "object" && typeof child.type === "string")
                        pending.push({ node: child, depth: depth + 1 });
            }
            else if (value && typeof value === "object" && typeof value.type === "string")
                pending.push({ node: value, depth: depth + 1 });
        }
    }
    return false;
}
const executablePythonNodes = new Set([
    "AwaitExpression", "CallExpression", "ComprehensionExpression",
    "ArrayComprehensionExpression", "DictionaryComprehensionExpression", "SetComprehensionExpression",
    "LambdaExpression", "NamedExpression", "YieldExpression",
]);
export function hasExecutablePythonSemantics(text) {
    if (Buffer.byteLength(text, "utf8") > maximumContentPolicyTextBytes || !isJavaScriptRawInputWithinBounds(text))
        return true;
    let cursor;
    try {
        cursor = pythonParser.parse(text).cursor();
    }
    catch {
        return true;
    }
    let depth = 0;
    let visited = 0;
    let syntaxError = false;
    let executable = false;
    while (true) {
        visited += 1;
        if (visited > maximumContentPolicyAstNodes || depth > maximumPythonContentPolicyAstDepth)
            return true;
        const name = cursor.name;
        if (cursor.type.isError)
            syntaxError = true;
        if ((name.endsWith("Statement") && name !== "ExpressionStatement")
            || name.endsWith("Definition") || executablePythonNodes.has(name))
            executable = true;
        if (cursor.firstChild()) {
            depth += 1;
            continue;
        }
        while (!cursor.nextSibling()) {
            if (!cursor.parent())
                return !syntaxError && executable;
            depth -= 1;
        }
    }
}
function isSentenceShapedText(text) {
    const lines = text.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.length > 0 && lines.every((line) => {
        const trimmed = line.trim();
        return /^[A-Z][^;&|<>$`\\]*[.!?]$/.test(trimmed) && /\s/.test(trimmed);
    });
}
// Pinned to GNU Bash 5.2's Reference Manual lists in "Bourne Shell
// Builtins", "Bash Builtin Commands", and "Reserved Words". Keeping this
// vocabulary in-process makes classification deterministic and avoids
// spawning a shell for untrusted uploads. The independent fixture contract in
// test/fixtures/bash-5.2-command-vocabulary.txt guards omissions and drift.
export const bash52CommandVocabulary = Object.freeze([
    "!", ".", ":", "[", "[[", "]]", "alias", "bg", "bind", "break", "builtin", "caller", "case", "cd", "command", "compgen", "complete", "compopt", "continue", "coproc", "declare", "dirs", "disown", "do", "done", "echo", "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for", "function", "getopts", "hash", "help", "history", "if", "in", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly", "return", "select", "set", "shift", "shopt", "source", "suspend", "test", "then", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while", "{", "}",
]);
const bashCommandNames = new Set(bash52CommandVocabulary);
function exactShellVocabularyToken(text) {
    const trimmed = text.trim();
    if (bashCommandNames.has(trimmed))
        return trimmed;
    if (trimmed.length >= 2 && ((trimmed[0] === "'" && trimmed.at(-1) === "'") || (trimmed[0] === '"' && trimmed.at(-1) === '"'))) {
        const value = trimmed.slice(1, -1);
        if (!value.includes(trimmed[0]) && !/[\\$`]/.test(value) && bashCommandNames.has(value))
            return value;
    }
    return null;
}
function isLiteralShellWord(word) {
    if (!word || typeof word.value !== "string" || typeof word.text !== "string")
        return false;
    const literalPart = (part) => part?.type === "Literal"
        || part?.type === "SingleQuoted"
        || (part?.type === "DoubleQuoted" && Array.isArray(part.parts) && part.parts.every(literalPart));
    if (Array.isArray(word.parts) && !word.parts.every(literalPart))
        return false;
    return !/[$`*?\[\]{}~]/.test(word.text.replace(/^(['"])([\s\S]*)\1$/, "$2"));
}
function shellCommandCanRun(name) {
    if (bashCommandNames.has(name))
        return true;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(name))
        return false;
    if (name.includes("/"))
        return true;
    if (Buffer.byteLength(name, "utf8") > 255)
        return false;
    for (const entry of String(process.env.PATH ?? "").split(":").slice(0, 128)) {
        const directory = entry || process.cwd();
        if (Buffer.byteLength(directory, "utf8") > 4096)
            continue;
        try {
            fs.accessSync(`${directory.replace(/\/$/, "")}/${name}`, fs.constants.X_OK);
            return true;
        }
        catch { }
    }
    return false;
}
function isPlainShellDatum(statement) {
    const command = statement?.command;
    // Shell grammar calls every bare/quoted token a command. Preserve plain data
    // only when the complete AST is one literal, effect-free token which cannot
    // name a builtin, PATH executable, or filesystem command path here.
    return statement?.type === "Statement" && statement.background !== true
        && Array.isArray(statement.redirects) && statement.redirects.length === 0
        && command?.type === "Command" && Array.isArray(command.prefix) && command.prefix.length === 0
        && Array.isArray(command.suffix) && command.suffix.length === 0
        && Array.isArray(command.redirects) && command.redirects.length === 0
        && isLiteralShellWord(command.name) && !shellCommandCanRun(command.name.value);
}
export function hasExecutableShellSemantics(text) {
    if (Buffer.byteLength(text, "utf8") > maximumContentPolicyTextBytes || !isJavaScriptRawInputWithinBounds(text))
        return true;
    let root;
    try {
        root = parseShell(text);
    }
    catch {
        return true;
    }
    const pending = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;
    let syntaxError = false;
    let firstErrorAt = Number.POSITIVE_INFINITY;
    try {
        while (pending.length > 0) {
            const { value, depth } = pending.pop();
            if (!value || typeof value !== "object" || seen.has(value))
                continue;
            seen.add(value);
            visited += 1;
            if (visited > maximumContentPolicyAstNodes || depth > maximumPythonContentPolicyAstDepth)
                return true;
            if (Array.isArray(value.errors) && value.errors.length > 0) {
                syntaxError = true;
                for (const error of value.errors)
                    if (Number.isInteger(error?.pos) && error.pos >= 0)
                        firstErrorAt = Math.min(firstErrorAt, error.pos);
            }
            const children = Object.values(value);
            if ("parts" in value)
                children.push(value.parts);
            if ("indexParts" in value)
                children.push(value.indexParts);
            for (const child of children) {
                if (Array.isArray(child))
                    for (const item of child)
                        pending.push({ value: item, depth: depth + 1 });
                else
                    pending.push({ value: child, depth: depth + 1 });
            }
        }
    }
    catch {
        return true;
    }
    // Parse every candidate before applying either narrow plain-text allowance.
    // Bash reserved words can form recovery/error trees when isolated, so also
    // compare an exact literal token with the complete pinned vocabulary.
    if (exactShellVocabularyToken(text))
        return true;
    if (isSentenceShapedText(text))
        return false;
    if (!Array.isArray(root.commands) || root.commands.length === 0)
        return false;
    if (!syntaxError)
        return root.commands.length !== 1 || !isPlainShellDatum(root.commands[0]);
    const hasCommandBoundary = (suffix) => {
        for (let index = 0; index < suffix.length; index += 1) {
            if (suffix[index] === ";")
                return true;
            if (suffix[index] === "&" && suffix[index - 1] !== "&" && suffix[index - 1] !== "|" && suffix[index + 1] !== "&")
                return true;
            if (suffix[index] !== "\n")
                continue;
            let escapes = 0;
            for (let before = index - 1; before >= 0 && suffix[before] === "\\"; before -= 1)
                escapes += 1;
            if (escapes % 2 === 0)
                return true;
        }
        return false;
    };
    return root.commands.some((statement) => {
        if (statement?.type !== "Statement" || !statement.command || !Number.isInteger(statement.pos) || !Number.isInteger(statement.end) || statement.end <= statement.pos || statement.end > firstErrorAt)
            return false;
        return !isPlainShellDatum(statement) && (statement.background === true || hasCommandBoundary(text.slice(statement.end, firstErrorAt)));
    });
}
function safeUntrustedText(bytes) {
    if (bytes.length > maximumContentPolicyTextBytes)
        return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    try {
        text = decoder.decode(bytes);
    }
    catch {
        return false;
    }
    if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /<\s*(?:!doctype|\?xml|html\b|head\b|body\b|script\b|svg\b|[a-z][\w:-]*\s+[^>]*>)/i.test(text) || /<\s*([a-z][\w:-]*)\b[^>]*>[\s\S]*<\/\s*\1\s*>/i.test(text))
        return false;
    // Acorn parses but never executes the upload. Whole-program parsing handles
    // comments, escapes, computed or parenthesized callees, and optional chains;
    // the iterative traversal fails closed at fixed node and depth budgets.
    if (hasExecutableJavaScriptSemantics(text) || hasExecutablePythonSemantics(text) || hasExecutableShellSemantics(text))
        return false;
    return true;
}
async function contentPolicyOutcome(row, bytes) {
    const name = String(row.name).toLowerCase();
    const type = String(row.type).toLowerCase();
    if (bytes.length === 0 || /\.(zip|gz|rar|7z|tar|docx?|xlsx?|pptx?|exe|dmg|app|js|mjs|sh|bat|cmd|ps1|svg|html?|xml)$/i.test(name) || bytes.subarray(0, 2).toString("hex") === "4d5a" || bytes.subarray(0, 2).toString("hex") === "504b" || bytes.subarray(0, 6).toString("ascii") === "Rar!\x1a\x07" || bytes.subarray(0, 6).toString("ascii") === "7z\xbc\xaf\x27\x1c")
        return "rejected";
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff")
        return validJpeg(bytes) && /\.(jpg|jpeg)$/.test(name) && type === "image/jpeg" ? "clean" : "rejected";
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return validPng(bytes) && /\.png$/.test(name) && type === "image/png" ? "clean" : "rejected";
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-")
        return await validatePdfIngress(bytes) && /\.pdf$/.test(name) && type === "application/pdf" ? "clean" : "rejected";
    return safeUntrustedText(bytes) && /\.txt$/.test(name) && type === "text/plain" ? "clean" : "rejected";
}
export function isCurrentClamavSignature(signature, now = Date.now()) { const builtAt = Date.parse(signature?.updatedAt); return Boolean(signature) && typeof signature?.version === "string" && /^daily:\d{1,12}$/.test(signature.version) && Number.isFinite(builtAt) && builtAt <= now && now - builtAt <= 24 * 60 * 60 * 1000; }
export function collectBoundedToolOutput(child, timeoutMs, maximumBytes = 8192) { return new Promise((resolve) => { let settled = false; let stdout = Buffer.alloc(0); let exitCode; let stdoutEnded = !child.stdout; const finish = (ok) => { if (settled)
    return; settled = true; clearTimeout(timer); resolve({ ok, stdout: stdout.toString("utf8") }); }; const completed = () => { if (exitCode !== undefined && stdoutEnded)
    finish(exitCode === 0); }; const timer = setTimeout(() => finish(false), timeoutMs); child.stdout?.on?.("data", (chunk) => { if (stdout.length + chunk.length > maximumBytes)
    return finish(false); stdout = Buffer.concat([stdout, chunk]); }); child.stdout?.once?.("end", () => { stdoutEnded = true; completed(); }); child.once("exit", (code) => { exitCode = code; completed(); }); child.once("close", (code) => finish(code === 0)); child.once("error", () => finish(false)); }); }
async function verifiedClamavSignature(database) {
    if (database.__clamavTest?.signature)
        return database.__clamavTest.signature;
    const sidecar = database.__clamavDevSidecar;
    for (const path of ["/app/data/clamav/daily.cld", "/app/data/clamav/daily.cvd"]) {
        if (!sidecar && !fs.existsSync(path))
            continue;
        const child = sidecar
            ? childProcess.spawn("docker", ["exec", sidecar.containerName, "/usr/bin/sigtool", "--info", path], { stdio: ["ignore", "pipe", "ignore"] })
            : childProcess.spawn("/usr/bin/sigtool", ["--info", path], { stdio: ["ignore", "pipe", "ignore"] });
        const result = await collectBoundedToolOutput(child, 5_000);
        if (!result.ok) {
            await terminateChild(child);
            continue;
        }
        const version = /^Version:\s*(\d{1,12})\s*$/mi.exec(result.stdout)?.[1];
        const built = /^Build time:\s*(.{1,80})\s*$/mi.exec(result.stdout)?.[1];
        const verified = /^Verification(?:\s*:)?\s*OK\.?\s*$/mi.test(result.stdout);
        const builtAt = built ? new Date(built.replace(/ (\d{2})-(\d{2}) /, " $1:$2 ")) : null;
        if (verified && version && builtAt && Number.isFinite(builtAt.getTime()))
            return { version: `daily:${version}`, updatedAt: builtAt.toISOString() };
    }
    return null;
}
function clamavSocketCommand(database, command, maximumReplyBytes = 4096, timeoutMs = 2_000) {
    const socketPath = database.__clamavTest?.socketPath ?? database.__clamavDevSidecar?.socketPath ?? "/tmp/sporades-clamd.sock";
    return new Promise((resolve) => {
        let settled = false;
        let response = Buffer.alloc(0);
        const socket = net.createConnection({ path: socketPath });
        const finish = (value) => { if (settled)
            return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.once("connect", () => socket.write(command));
        socket.on("data", (chunk) => { if (response.length + chunk.length > maximumReplyBytes)
            return finish(null); response = Buffer.concat([response, chunk]); if (response.includes(0))
            finish(response.subarray(0, response.indexOf(0)).toString("utf8")); });
        socket.once("error", () => finish(null));
        socket.once("end", () => { if (!settled)
            finish(null); });
    });
}
async function clamavInstream(database, bytes) {
    const signature = await currentLoadedClamavSignature(database);
    if (!signature)
        return { outcome: "inconclusive", signatureVersion: "unavailable" };
    if (bytes.length > clamavMaximumStreamBytes)
        return { outcome: "inconclusive", signatureVersion: String(signature.version).slice(0, 128) };
    const socketPath = database.__clamavTest?.socketPath ?? database.__clamavDevSidecar?.socketPath ?? "/tmp/sporades-clamd.sock";
    const timeoutMs = database.__clamavTest?.timeoutMs ?? 10_000;
    return await new Promise((resolve) => {
        let settled = false;
        let response = Buffer.alloc(0);
        const socket = net.createConnection({ path: socketPath });
        const finish = (outcome) => { if (settled)
            return; settled = true; clearTimeout(timer); socket.destroy(); resolve({ outcome, signatureVersion: String(signature.version).slice(0, 128) }); };
        const timer = setTimeout(() => finish("inconclusive"), timeoutMs);
        socket.once("connect", () => { socket.write(Buffer.from("zINSTREAM\0")); for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024));
            const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            socket.write(length);
            socket.write(chunk);
        } socket.write(Buffer.alloc(4)); });
        socket.on("data", (chunk) => { if (response.length + chunk.length > 4096)
            return finish("inconclusive"); response = Buffer.concat([response, chunk]); if (response.includes(0)) {
            const text = response.subarray(0, response.indexOf(0)).toString("utf8");
            if (/^stream: OK$/.test(text))
                finish("clean");
            else if (/^stream: .+ FOUND$/.test(text))
                finish("rejected");
            else
                finish("inconclusive");
        } });
        socket.once("error", () => finish("inconclusive"));
        socket.once("end", () => { if (!settled)
            finish("inconclusive"); });
    });
}
function waitForChild(child, timeoutMs) { return new Promise((resolve) => { let settled = false; const finish = (ok) => { if (settled)
    return; settled = true; clearTimeout(timer); resolve(ok); }; const timer = setTimeout(() => finish(false), timeoutMs); child.once("exit", (code) => finish(code === 0)); child.once("error", () => finish(false)); }); }
async function terminateChild(child, timeoutMs = 5_000) {
    if (!child || clamavChildTerminated(child))
        return;
    const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
    try {
        child.kill("SIGTERM");
    }
    catch {
        return;
    }
    if (await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]))
        return;
    try {
        child.kill("SIGKILL");
    }
    catch {
        return;
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
function clamavTerminateTimeout(database) { return database.__clamavTest?.terminateTimeoutMs ?? 5_000; }
function observeClamavChild(database, child) {
    if (!child || child.__sporadesClamavObserved)
        return;
    child.__sporadesClamavObserved = true;
    const failed = () => { child.__sporadesClamavTerminated = true; database.clamavReady = false; };
    child.once?.("exit", failed);
    child.once?.("error", failed);
}
function clamavChildTerminated(child) { return Boolean(child) && (child.exitCode !== null || child.signalCode != null || child.__sporadesClamavTerminated === true); }
async function currentLoadedClamavSignature(database) {
    const signature = await verifiedClamavSignature(database);
    if (!isCurrentClamavSignature(signature))
        return null;
    if (database.__clamavTest?.loadedSignature)
        return database.__clamavTest.loadedSignature === signature.version ? signature : null;
    const versionReply = await clamavSocketCommand(database, Buffer.from("zVERSION\0"), 512, 500);
    const loadedVersion = /^ClamAV\s+[^/]{1,64}\/(\d{1,12})\//.exec(versionReply ?? "")?.[1];
    return loadedVersion && `daily:${loadedVersion}` === signature.version ? signature : null;
}
export async function initializeClamavRuntime(database) {
    const required = database.endpoints?.some((endpoint) => endpoint?.options?.body?.multipart?.inspection?.requiredInspectors?.includes("clamav"));
    database.clamavRequired = Boolean(required);
    database.clamavReady = !required;
    if (!required)
        return true;
    if (database.__clamavTest) {
        database.clamavReady = Boolean(await currentLoadedClamavSignature(database));
        return database.clamavReady;
    }
    if (database.__clamavDevSidecar) {
        observeClamavChild(database, database.__clamavDevSidecar.process);
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
            if (clamavChildTerminated(database.__clamavDevSidecar.process))
                break;
            if (fs.existsSync(database.__clamavDevSidecar.socketPath) && await currentLoadedClamavSignature(database) && await clamavSocketCommand(database, Buffer.from("zPING\0"), 16, 500) === "PONG") {
                database.clamavReady = true;
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
    }
    if (process.env.SPORADES_CLAMAV_MANAGED !== "1")
        return false;
    try {
        fs.mkdirSync("/app/data/clamav", { recursive: true });
        fs.mkdirSync("/tmp/sporades-clamav", { recursive: true });
    }
    catch {
        return false;
    }
    const update = childProcess.spawn("/usr/bin/freshclam", ["--config-file=/etc/clamav/freshclam.conf"], { stdio: "ignore" });
    database.__clamavUpdateProcess = update;
    const updateCompleted = await waitForChild(update, 120_000);
    if (!updateCompleted)
        await terminateChild(update, clamavTerminateTimeout(database));
    database.__clamavUpdateProcess = null;
    const signature = await verifiedClamavSignature(database);
    if (!isCurrentClamavSignature(signature))
        return false;
    const daemon = childProcess.spawn("/usr/sbin/clamd", ["--foreground", "--config-file=/etc/clamav/clamd.conf"], { stdio: "ignore" });
    database.__clamavProcess = daemon;
    observeClamavChild(database, daemon);
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (fs.existsSync("/tmp/sporades-clamd.sock") && await currentLoadedClamavSignature(database) && await clamavSocketCommand(database, Buffer.from("zPING\0"), 16, 500) === "PONG") {
            database.clamavReady = true;
            const updater = childProcess.spawn("/usr/bin/freshclam", ["--daemon", "--foreground=true", "--config-file=/etc/clamav/freshclam.conf"], { stdio: "ignore" });
            database.__clamavUpdateProcess = updater;
            observeClamavChild(database, updater);
            return true;
        }
        if (clamavChildTerminated(daemon))
            break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await Promise.all([terminateChild(daemon, clamavTerminateTimeout(database)), terminateChild(database.__clamavUpdateProcess, clamavTerminateTimeout(database))]);
    return false;
}
export async function shutdownClamavRuntime(database) { database.clamavReady = false; if (!database.__clamavDevSidecar?.externallyManaged)
    await Promise.all([terminateChild(database.__clamavProcess, clamavTerminateTimeout(database)), terminateChild(database.__clamavUpdateProcess, clamavTerminateTimeout(database))]); database.__clamavProcess = null; database.__clamavUpdateProcess = null; }
export async function checkClamavRuntime(database) { if (!database.clamavRequired)
    return { ok: true }; const children = [database.__clamavDevSidecar?.process, database.__clamavProcess, database.__clamavUpdateProcess]; for (const child of children)
    observeClamavChild(database, child); if (children.some(clamavChildTerminated)) {
    database.clamavReady = false;
    return { ok: false };
} const current = await currentLoadedClamavSignature(database); const pong = current ? await clamavSocketCommand(database, Buffer.from("zPING\0"), 16, 500) : null; database.clamavReady = pong === "PONG"; return { ok: database.clamavReady }; }
async function inspectIngressLease(database, policy, row, bytes) {
    if (!policy)
        return undefined;
    const verdicts = await Promise.all(policy.requiredInspectors.map(async (inspector) => { const result = inspector === "content-policy-v1" ? { outcome: await contentPolicyOutcome(row, bytes), signatureVersion: "content-policy-v1" } : await clamavInstream(database, bytes); const inspectedAt = ingressAuditNow(database); return Object.freeze({ inspector, outcome: result.outcome, leaseId: row.leaseId, size: row.size, digest: row.digest, version: row.version, policyRevision: policy.policyRevision, engine: inspector === "content-policy-v1" ? "sporades-content-policy" : "clamav", signatureVersion: result.signatureVersion, inspectedAt }); }));
    return Object.freeze({ policyRevision: policy.policyRevision, maxVerdictAgeMs: policy.maxVerdictAgeMs, verdicts: Object.freeze(verdicts) });
}
function inspectionEvidenceIsCurrent(database, row, policy) {
    if (!policy)
        return true;
    const inspection = row.inspection;
    if (!inspection || inspection.policyRevision !== policy.policyRevision || !Array.isArray(inspection.verdicts) || inspection.verdicts.length !== policy.requiredInspectors.length)
        return false;
    const now = Date.parse(ingressAuditNow(database));
    return policy.requiredInspectors.every((inspector) => {
        const verdict = inspection.verdicts.find((candidate) => candidate?.inspector === inspector);
        const inspectedAt = Date.parse(verdict?.inspectedAt);
        return verdict?.outcome === "clean" && verdict?.leaseId === row.leaseId && verdict?.size === row.size && verdict?.digest === row.digest && verdict?.version === row.version && verdict?.policyRevision === policy.policyRevision && typeof verdict?.engine === "string" && typeof verdict?.signatureVersion === "string" && Number.isFinite(inspectedAt) && inspectedAt <= now && now - inspectedAt <= policy.maxVerdictAgeMs;
    });
}
function framedIngressKey(parts) {
    const framed = parts.map((value) => { const bytes = Buffer.from(String(value), "utf8"); return `${bytes.length}:${bytes.toString("base64")}`; }).join("|");
    return `v2:${crypto.createHash("sha256").update(framed).digest("hex")}`;
}
function keyFor(endpoint, requestKey, partKey, actor) { return framedIngressKey([String(endpoint.options.method), String(endpoint.options.path), actor, requestKey, partKey]); }
function legacyDelimitedKeyFor(endpoint, requestKey, partKey, actor) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }
function idempotencyConflict(message = "Ingress claim conflicts with the completed request.") { return Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" }); }
function ingressAuthorityDenied() { return Object.assign(new Error("File ingress authority is unavailable."), { code: "INGRESS_AUTHORITY_DENIED" }); }
const ingressAuditCodes = new Set(["INVALID_MULTIPART", "MULTIPART_LIMIT_EXCEEDED", "INVALID_MULTIPART_REQUEST_KEY", "INVALID_MULTIPART_PART_KEY", "INGRESS_AUTHORITY_DENIED", "INGRESS_LEASE_EXPIRED", "INGRESS_PATH_DENIED", "INGRESS_DESCRIPTOR_CONFLICT", "INGRESS_STAGING_INCOMPLETE", "INGRESS_ORPHAN_CLEANUP_FAILED", "FILE_PATH_EXISTS"]);
async function emitIngressAudit(database, event, data) {
    try {
        await database.log?.emit?.({ category: "platform", event: `file.ingress.${event}`, level: event === "failed" || event === "cleanup-failed" ? "warn" : "info", message: "Multipart ingress lifecycle event", data: { schema: "v1", ...data } });
    }
    catch { /* Auditing must not turn a bounded ingress outcome into a transport failure. */ }
}
function safeIngressAuditCode(error) { return ingressAuditCodes.has(error?.code) ? error.code : "INGRESS_FAILED"; }
function ingressClaimAuditId(row) {
    // Receipt keys are opaque already; hash again so no private storage identity
    // can accidentally become a future audit payload field.
    return `v1:${crypto.createHash("sha256").update(String(row.key), "utf8").digest("hex")}`;
}
function sameFileDescriptor(left, right) {
    return left?.id === right?.id && left?.ownerId === right?.ownerId && left?.path === right?.path && left?.name === right?.name && left?.type === right?.type && Number(left?.size) === Number(right?.size) && left?.version === right?.version;
}
function isUniqueConstraintError(error) { return /unique constraint|duplicate key|constraint failed/i.test(String(error?.message ?? error)); }
function multipartBoundary(contentType) {
    const match = /^multipart\/form-data\s*;\s*boundary\s*=\s*(?:"([^"\\]*)"|([^;\s]+))\s*$/i.exec(contentType);
    if (!match)
        return null;
    const quoted = match[1] !== undefined;
    const value = quoted ? match[1] : match[2];
    const validBchars = /^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(value);
    const validToken = /^[0-9A-Za-z'+_.-]+$/.test(value);
    return value.length <= 70 && validBchars && (quoted || validToken) ? value : null;
}
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
    let partLimit = typeof maxPartBytes === "number" ? maxPartBytes : Math.max(maxPartBytes.file, maxPartBytes.field);
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
                if (typeof maxPartBytes !== "number") {
                    const disposition = /^content-disposition:\s*form-data;\s*name="[^"]+"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders);
                    partLimit = disposition?.[1] !== undefined ? maxPartBytes.file : maxPartBytes.field;
                }
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
                        if (size > partLimit)
                            throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                        pending = pending.subarray(take);
                    }
                    break;
                }
                if (pending.length < at + marker.length + 2) {
                    if (at) {
                        pieces.push(pending.subarray(0, at));
                        size += at;
                        if (size > partLimit)
                            throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                        pending = pending.subarray(at);
                    }
                    break;
                }
                const suffix = pending.subarray(at + marker.length, at + marker.length + 2).toString();
                if (suffix !== "\r\n" && suffix !== "--") {
                    const take = at + marker.length;
                    pieces.push(pending.subarray(0, take));
                    size += take;
                    if (size > partLimit)
                        throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                    pending = pending.subarray(take);
                    continue;
                }
                if (at) {
                    pieces.push(pending.subarray(0, at));
                    size += at;
                }
                if (size > partLimit)
                    throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                pending = pending.subarray(at + marker.length);
                state = "separator";
                continue;
            }
            if (state === "separator") {
                if (pending.length < 2)
                    break;
                const separator = pending.subarray(0, 2).toString();
                if (separator !== "\r\n" && separator !== "--")
                    throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" });
                pending = pending.subarray(2);
                yield { rawHeaders, body: Buffer.concat(pieces, size) };
                if (separator === "--") {
                    state = "closing";
                    continue;
                }
                state = "headers";
                continue;
            }
            if (pending.length === 0)
                break;
            if (pending.length === 1 && pending[0] === 13)
                break;
            if (pending.subarray(0, 2).toString() !== "\r\n")
                throw Object.assign(new Error("Malformed multipart closing delimiter."), { code: "INVALID_MULTIPART" });
            return;
        }
    }
    if (state === "closing" && pending.length === 0)
        return;
    throw Object.assign(new Error("Truncated multipart request."), { code: "INVALID_MULTIPART" });
}
/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export async function stageMultipartIngress(database, endpoint, request, endpointRequest, actor, admittedAuthority) {
    let policy;
    try {
        policy = validateMultipartIngressPolicy(endpoint.options.body.multipart);
    }
    catch (error) {
        await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(error) });
        throw error;
    }
    const contentType = String(endpointRequest.headers["content-type"] ?? "");
    const boundary = multipartBoundary(contentType);
    if (!boundary) {
        const error = Object.assign(new Error("Invalid multipart request."), { code: "INVALID_MULTIPART" });
        await emitIngressAudit(database, "failed", { outcome: "failed", code: "INVALID_MULTIPART" });
        throw error;
    }
    const requestKey = header(endpointRequest.headers, policy.requestKeyHeader);
    if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 200) {
        const error = Object.assign(new Error("Missing multipart idempotency key."), { code: "INVALID_MULTIPART_REQUEST_KEY" });
        await emitIngressAudit(database, "failed", { outcome: "failed", code: "INVALID_MULTIPART_REQUEST_KEY" });
        throw error;
    }
    await emitIngressAudit(database, "started", { outcome: "started" });
    const maxBytes = Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536;
    const files = [];
    const fields = Object.create(null);
    let fieldCount = 0;
    let fieldBytes = 0;
    let fileBytes = 0;
    const partKeys = new Set();
    const wonReceipts = [];
    const streamingFileLimit = Math.min(Number(policy.maxFileBytes), Number(database.fileMaxSizeBytes));
    try {
        for await (const part of multipartParts(request, boundary, maxBytes, { file: streamingFileLimit, field: policy.maxFieldBytes })) {
            const rawHeaders = part.rawHeaders;
            const body = part.body;
            if (rawHeaders.length > 16384)
                throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
            if (unsupportedMultipartPartEncoding(rawHeaders))
                throw Object.assign(new Error("Unsupported multipart part encoding."), { code: "INVALID_MULTIPART" });
            const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders);
            if (!disposition)
                throw Object.assign(new Error("Malformed multipart part."), { code: "INVALID_MULTIPART" });
            const fieldName = disposition[1];
            const filename = disposition[2];
            if (filename === undefined) {
                fieldCount += 1;
                fieldBytes += body.length;
                if (fieldCount > policy.maxFieldCount || body.length > policy.maxFieldBytes || fieldBytes > policy.maxTotalFieldBytes)
                    throw Object.assign(new Error("Multipart field exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
                if (!Object.prototype.hasOwnProperty.call(fields, fieldName))
                    fields[fieldName] = [];
                fields[fieldName].push(body.toString("utf8"));
                continue;
            }
            fileBytes += body.length;
            if (files.length >= policy.maxFiles || body.length > policy.maxFileBytes || fileBytes > policy.maxTotalFileBytes || body.length > database.fileMaxSizeBytes)
                throw Object.assign(new Error("Multipart file exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" });
            const partKey = partHeader(rawHeaders, policy.partKeyHeader);
            if (policy.requireStablePartKeys && (!partKey || partKeys.has(partKey)))
                throw Object.assign(new Error("Multipart files require unique stable part keys."), { code: "INVALID_MULTIPART_PART_KEY" });
            if (partKey)
                partKeys.add(partKey);
            const type = safeType(/^content-type:\s*([^\r\n]+)/im.exec(rawHeaders)?.[1] ?? "");
            if (policy.allowedMimeTypes && !policy.allowedMimeTypes.map(safeType).includes(type))
                throw Object.assign(new Error("Multipart file type is not allowed."), { code: "MULTIPART_TYPE_DENIED" });
            const stablePartKey = partKey ?? crypto.createHash("sha256").update(`${fieldName}:${files.length}`).digest("hex");
            const actorId = String(actor.userId ?? "");
            const authority = admittedAuthority ?? { kind: "actor", actorId, ownerId: actorId };
            const authorityId = authority.kind === "capsule-principal" ? `capsule:${authority.namespace}:${authority.keyDigest}` : `actor:${authority.actorId}`;
            const key = keyFor(endpoint, requestKey, stablePartKey, authorityId);
            const digest = crypto.createHash("sha256").update(body).digest("hex");
            const now = new Date();
            const candidate = { key, leaseId: crypto.randomUUID(), partId: crypto.createHash("sha256").update(key).digest("hex"), fieldName, name: safeName(filename), type, size: body.length, digest, fileId: crypto.randomUUID(), version: crypto.randomUUID(), state: "staging", actorId, authorityKind: authority.kind, authorityId, ownerId: authority.ownerId, ...(authority.kind === "capsule-principal" ? { principalNamespace: authority.namespace, principalKeyDigest: authority.keyDigest } : {}), endpointMethod: String(endpoint.options.method), endpointPath: String(endpoint.options.path), requestKey, partKey: stablePartKey, expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString() };
            const inspection = await inspectIngressLease(database, policy.inspection, candidate, body);
            if (inspection)
                Object.assign(candidate, { inspection });
            // Pre-authority receipts used the raw actor ID in their durable key. Keep that key and
            // its derived part/object identities intact: renaming only the key would strand retries,
            // while regenerating the part would duplicate staged bytes.
            const legacyAuthorityKey = legacyDelimitedKeyFor(endpoint, requestKey, stablePartKey, authorityId);
            const legacyActorKey = authority.kind === "actor" ? legacyDelimitedKeyFor(endpoint, requestKey, stablePartKey, authority.actorId) : null;
            const legacyRow = await (async () => { for (const legacyKey of [legacyAuthorityKey, legacyActorKey]) {
                if (!legacyKey || legacyKey === key)
                    continue;
                const row = await receipt(database, legacyKey);
                if (row?.endpointMethod === String(endpoint.options.method) && row?.endpointPath === String(endpoint.options.path) && row?.requestKey === requestKey && row?.partKey === stablePartKey && row?.authorityKind === authority.kind && row?.authorityId === authorityId && row?.ownerId === authority.ownerId)
                    return row;
            } return null; })();
            const acquired = legacyRow
                ? { row: legacyRow, winner: false }
                : await acquireReceipt(database, candidate);
            let row = acquired.row;
            if (row.digest !== digest || row.name !== candidate.name || row.type !== type || row.size !== body.length)
                throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
            if (acquired.winner) {
                wonReceipts.push(row);
                await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body });
                const published = await publishStagedReceipt(database, row);
                if (published)
                    row = published;
                else {
                    const current = await receipt(database, row.key);
                    if (current?.state === "complete" && current.leaseId === row.leaseId)
                        row = current;
                    else {
                        const primary = Object.assign(new Error("Multipart ingress staging lost its publication lease."), { code: "INGRESS_STAGING_INCOMPLETE" });
                        try {
                            await database.fileStorage.deleteFileVersion({ fileId: row.fileId, version: row.version });
                        }
                        catch (cleanup) {
                            throw new AggregateError([primary, cleanup], "Multipart ingress staging lost publication and object cleanup failed.");
                        }
                        throw primary;
                    }
                }
            }
            else if (row.state === "staging") {
                row = await awaitCompletedStagingReceipt(database, row.key);
            }
            if (!row || (row.state !== "leased" && row.state !== "complete"))
                throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
            files.push(publicLease(row));
        }
    }
    catch (primaryError) {
        const cleanupErrors = [];
        for (const row of wonReceipts.reverse()) {
            try {
                const deleted = await database.adapter.prepare(database.adapter.dialect.sql("DELETE FROM [sporades_file_ingress] WHERE [key] = ? AND [leaseId] = ? AND [state] IN ('staging', 'leased')")).run(row.key, row.leaseId);
                if (Number(deleted?.changes ?? 0) > 0)
                    await database.fileStorage.deleteFileVersion({ fileId: row.fileId, version: row.version });
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length) {
            await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(primaryError) });
            throw new AggregateError([primaryError, ...cleanupErrors], "Multipart ingress staging failed and cleanup was incomplete.");
        }
        await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(primaryError) });
        throw primaryError;
    }
    await emitIngressAudit(database, "completed", { outcome: "leased" });
    return { body: null, bodyBytes: Object.freeze({ byteLength: 0, length: 0, at() { return undefined; }, toUint8Array() { return new Uint8Array(); }, *[Symbol.iterator]() { } }), multipart: Object.freeze({ files: Object.freeze(files), fields: Object.freeze(fields) }), __ingressRequestKey: requestKey, __ingressAuthority: admittedAuthority ?? Object.freeze({ kind: "actor", actorId: String(actor.userId ?? ""), ownerId: String(actor.userId ?? "") }) };
}
export function validateMultipartIngressPolicy(policy) {
    const invalid = () => { throw Object.assign(new Error("Invalid multipart ingress policy."), { code: "INVALID_MULTIPART_POLICY" }); };
    const validPathPrefix = (value) => { try {
        return typeof value === "string" && normalizeAbsoluteFilePath(value) === value;
    }
    catch {
        return false;
    } };
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        invalid();
    for (const name of ["maxFiles", "maxFileBytes", "maxTotalFileBytes"])
        if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] <= 0)
            invalid();
    for (const name of ["maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes"])
        if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] < 0)
            invalid();
    const allowedKeys = new Set(["maxFiles", "maxFileBytes", "maxTotalFileBytes", "maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes", "allowedPathPrefixes", "allowedMimeTypes", "requestKeyHeader", "partKeyHeader", "requireStablePartKeys", "claimAuthorities", "inspection"]);
    if (Object.keys(policy).some((key) => !allowedKeys.has(key)))
        invalid();
    if (!Array.isArray(policy.allowedPathPrefixes) || policy.allowedPathPrefixes.length === 0 || policy.allowedPathPrefixes.some((value) => !validPathPrefix(value)))
        invalid();
    if (policy.allowedMimeTypes !== undefined && (!Array.isArray(policy.allowedMimeTypes) || policy.allowedMimeTypes.some((value) => typeof value !== "string" || safeType(value) !== value.toLowerCase())))
        invalid();
    for (const name of ["requestKeyHeader", "partKeyHeader"])
        if (typeof policy[name] !== "string" || policy[name].length > 100 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(policy[name]))
            invalid();
    if (policy.requireStablePartKeys !== undefined && typeof policy.requireStablePartKeys !== "boolean")
        invalid();
    if (policy.claimAuthorities !== undefined && (!Array.isArray(policy.claimAuthorities) || policy.claimAuthorities.length !== 1 || !["actor", "capsule-principal"].includes(policy.claimAuthorities[0])))
        invalid();
    const inspection = normalizedInspectionPolicy(policy.inspection);
    return inspection ? { ...policy, inspection } : policy;
}
export function createEndpointIngressApi(database, endpoint, endpointRequest, context) {
    // Runtime-owned provider callbacks predate Capsule endpoint options and do
    // not declare multipart ingress. Keep their ordinary endpoint context
    // available without requiring a synthetic declaration object.
    const policy = endpoint.options?.body?.multipart;
    const unavailable = () => { throw Object.assign(new Error("File ingress was not declared for this endpoint."), { code: "FILE_INGRESS_UNAVAILABLE" }); };
    if (!policy)
        return { claim: unavailable, inspection: unavailable, status: unavailable };
    const inspectionPolicy = normalizedInspectionPolicy(policy.inspection);
    const actorId = String(context.auth?.userId ?? "");
    const requestKey = endpointRequest.__ingressRequestKey;
    const admittedAuthority = endpointRequest.__ingressAuthority ?? { kind: "actor", actorId, ownerId: actorId };
    return {
        async claim(lease, options) {
            try {
                const row = await receiptByLease(database, lease?.leaseId);
                if (!row)
                    throw ingressAuthorityDenied();
                const requestedAuthority = options?.authority ?? { kind: "actor" };
                let claimAuthorityId;
                if (row.authorityKind === "capsule-principal") {
                    if (requestedAuthority?.kind !== "capsule-principal" || admittedAuthority?.kind !== "capsule-principal" || typeof requestedAuthority.namespace !== "string" || typeof requestedAuthority.key !== "string")
                        throw ingressAuthorityDenied();
                    const requestedDigest = crypto.createHash("sha256").update(`${requestedAuthority.namespace}\0${requestedAuthority.key}`, "utf8").digest("hex");
                    if (requestedAuthority.namespace !== admittedAuthority.namespace || requestedDigest !== admittedAuthority.keyDigest || row.principalNamespace !== requestedAuthority.namespace || row.principalKeyDigest !== requestedDigest || row.ownerId !== database.capsuleIngressOwnerId)
                        throw ingressAuthorityDenied();
                    claimAuthorityId = `capsule:${requestedAuthority.namespace}:${requestedDigest}`;
                }
                else {
                    if (requestedAuthority?.kind !== "actor" || admittedAuthority?.kind !== "actor" || !context.auth?.isAuthenticated || context.auth?.isGuest || admittedAuthority.actorId !== actorId || row.ownerId !== actorId)
                        throw ingressAuthorityDenied();
                    claimAuthorityId = `actor:${actorId}`;
                }
                const expectedLease = publicLease(row);
                if (row.authorityId !== claimAuthorityId || row.endpointMethod !== String(endpoint.options.method) || row.endpointPath !== String(endpoint.options.path) || row.requestKey !== requestKey ||
                    expectedLease.leaseId !== lease?.leaseId || expectedLease.partId !== lease?.partId || expectedLease.fieldName !== lease?.fieldName || expectedLease.name !== lease?.name || expectedLease.type !== lease?.type || expectedLease.size !== lease?.size || expectedLease.expiresAt !== lease?.expiresAt) {
                    throw ingressAuthorityDenied();
                }
                const path = normalizeAbsoluteFilePath(options?.path);
                if (!policy.allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
                    throw Object.assign(new Error("File path is outside the endpoint ingress policy."), { code: "INGRESS_PATH_DENIED" });
                const name = safeName(options?.name ?? row.name);
                const type = safeType(options?.type ?? row.type);
                // Inspector evidence is bound to the staged descriptor as well as its bytes.
                // An inspected claim may repeat that descriptor, but it cannot relabel the
                // ordinary File after content-policy has made a name/type-sensitive decision.
                if (inspectionPolicy && (name !== row.name || type !== row.type))
                    throw inspectionRequiredError();
                const expectedFile = { id: row.fileId, ownerId: row.ownerId, path, name, type, size: row.size, version: row.version };
                if (row.state === "complete") {
                    if (!sameFileDescriptor(row.file, expectedFile))
                        throw idempotencyConflict();
                    return fileMetadataFromRow(row.file);
                }
                if (row.state === "expired" || Date.parse(row.expiresAt) <= Date.now())
                    throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
                if (!inspectionEvidenceIsCurrent(database, row, inspectionPolicy))
                    throw inspectionRequiredError();
                if (row.state !== "leased")
                    throw idempotencyConflict("Ingress lease is not claimable.");
                const now = new Date().toISOString();
                const bucket = await ensureFileBucket(database, row.ownerId, "default", now);
                const file = { id: row.fileId, ownerId: row.ownerId, bucketId: bucket.id, bucketName: bucket.name, path, name: safeName(options?.name ?? row.name), type: safeType(options?.type ?? row.type), size: row.size, version: row.version, status: "uploaded", createdAt: now, updatedAt: now };
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
                // This transaction-scoped write is not coupled to a context object:
                // Capsule middleware may clone contexts before the handler receives one.
                await database.adapter.enqueueIngressClaimAudit({ claimId: ingressClaimAuditId(completed), createdAt: now });
                return fileMetadataFromRow(storedFile);
            }
            catch (error) {
                const code = safeIngressAuditCode(error);
                await emitIngressAudit(database, code === "INGRESS_AUTHORITY_DENIED" || code === "INGRESS_PATH_DENIED" ? "denied" : "failed", { outcome: code === "INGRESS_AUTHORITY_DENIED" || code === "INGRESS_PATH_DENIED" ? "denied" : "failed", code });
                throw error;
            }
        },
        async inspection(lease) {
            const row = await receiptByLease(database, lease?.leaseId);
            const allowed = admittedAuthority.kind === "capsule-principal"
                ? row?.authorityKind === "capsule-principal" && row.authorityId === `capsule:${admittedAuthority.namespace}:${admittedAuthority.keyDigest}` && row.ownerId === admittedAuthority.ownerId
                : row?.authorityKind === "actor" && row.ownerId === actorId;
            if (!allowed || row.endpointMethod !== String(endpoint.options.method) || row.endpointPath !== String(endpoint.options.path) || row.leaseId !== lease?.leaseId)
                throw ingressAuthorityDenied();
            if (!row.inspection)
                return null;
            return Object.freeze({ policyRevision: row.inspection.policyRevision, verdicts: Object.freeze(row.inspection.verdicts.map((verdict) => Object.freeze({ inspector: verdict.inspector, outcome: verdict.outcome, digest: verdict.digest, size: verdict.size, version: verdict.version, engine: verdict.engine, signatureVersion: verdict.signatureVersion, inspectedAt: verdict.inspectedAt }))) });
        },
        async status(statusRequestKey, partKey) {
            const capsulePrincipal = admittedAuthority.kind === "capsule-principal";
            const authorityId = capsulePrincipal ? `capsule:${admittedAuthority.namespace}:${admittedAuthority.keyDigest}` : `actor:${actorId}`;
            let row = await receipt(database, keyFor(endpoint, statusRequestKey, partKey, authorityId));
            if (!row)
                row = await receipt(database, legacyDelimitedKeyFor(endpoint, statusRequestKey, partKey, authorityId));
            if (!row && !capsulePrincipal)
                row = await receipt(database, legacyDelimitedKeyFor(endpoint, statusRequestKey, partKey, actorId));
            const authorityMatches = capsulePrincipal
                ? row?.authorityKind === "capsule-principal" && row.authorityId === authorityId && row.ownerId === admittedAuthority.ownerId && row.principalNamespace === admittedAuthority.namespace && row.principalKeyDigest === admittedAuthority.keyDigest
                : row?.authorityId === authorityId && row.ownerId === actorId;
            const tupleMatches = row?.endpointMethod === String(endpoint.options.method) && row?.endpointPath === String(endpoint.options.path) && row?.requestKey === statusRequestKey && row?.partKey === partKey;
            if (!row || !authorityMatches || !tupleMatches)
                return { state: "missing" };
            if (row.state === "complete")
                return { state: "complete", file: fileMetadataFromRow(row.file) };
            if (row.state === "leased" && Date.parse(row.expiresAt) > Date.now())
                return { state: "leased", lease: publicLease(row) };
            return { state: "failed", retryable: row.state !== "failed" ? true : row.retryable === true };
        },
    };
}
/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export function finalizeEndpointIngressClaims(context, committed) {
    // Claim state is persisted in the endpoint transaction; retained for call-site compatibility.
}
/** Reset an interrupted delivery lease at startup; ordinary drains never steal live work. */
export async function recoverIngressClaimAuditOutbox(database) {
    try {
        await database.adapter.recoverIngressClaimAudits(ingressAuditNow(database));
        return true;
    }
    catch {
        try {
            await database.log?.emit?.({ category: "platform", event: "file.ingress.audit-recovery-failed", level: "warn", message: "Multipart ingress audit recovery failed", data: { schema: "v1", outcome: "failed", code: "INGRESS_AUDIT_RECOVERY_FAILED" } });
        }
        catch { }
        return false;
    }
}
/** Emit the fixed public audit only after its transaction has committed. */
export async function drainIngressClaimAuditOutbox(database, options = {}) {
    const limit = Math.max(1, Math.min(100, Number.isInteger(options.limit) ? options.limit : 50));
    let pending;
    try {
        pending = await database.adapter.selectPendingIngressClaimAudits(limit);
    }
    catch {
        return;
    }
    for (const candidate of pending) {
        const claimId = String(candidate.claimId ?? "");
        if (!claimId)
            continue;
        const claimToken = crypto.randomUUID();
        try {
            const claimed = await database.adapter.claimIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
            if (Number(claimed?.changes ?? 0) !== 1)
                continue;
            try {
                await database.log.emit({ category: "platform", event: "file.ingress.completed", level: "info", message: "Multipart ingress lifecycle event", data: { schema: "v1", outcome: "claimed", deliveryId: claimId } });
            }
            catch {
                await releaseIngressClaimAudit(database, claimId, claimToken, "INGRESS_AUDIT_RELEASE_FAILED");
                continue;
            }
            try {
                await database.adapter.deliverIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
            }
            catch {
                // The append may already be durable, so retry is deliberately
                // duplicate-tolerant. Return only this token-fenced lease to pending;
                // a concurrent drainer cannot reset another worker's claim.
                try {
                    await releaseIngressClaimAudit(database, claimId, claimToken, "INGRESS_AUDIT_ACK_RELEASE_FAILED");
                }
                catch {
                    // Startup recovery remains the final repair path. This marker is
                    // observable without exposing the private delivery identity.
                    try {
                        await database.log.emit({ category: "platform", event: "file.ingress.audit-delivery-release-failed", level: "warn", message: "Multipart ingress audit delivery release failed", data: { schema: "v1", outcome: "failed", code: "INGRESS_AUDIT_ACK_RELEASE_FAILED" } });
                    }
                    catch { }
                }
            }
        }
        catch {
            // A failed sink or adapter operation leaves private durable work pending.
        }
    }
    try {
        const cutoff = new Date(new Date(ingressAuditNow(database)).getTime() - ingressClaimAuditRetentionMs).toISOString();
        await database.adapter.pruneDeliveredIngressClaimAudits(cutoff, ingressClaimAuditPruneLimit);
    }
    catch { /* Retention is maintenance; the next bounded drain retries. */ }
}
async function releaseIngressClaimAudit(database, claimId, claimToken, code) {
    try {
        await database.adapter.releaseIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
        return true;
    }
    catch {
        // This exact claim remains delivering, so make the root maintenance loop
        // retry recovery while the runtime stays alive.
        (database.__rootDatabase ?? database).__ingressAuditRecoveryPending = true;
        try {
            await database.log?.emit?.({ category: "platform", event: "file.ingress.audit-delivery-release-failed", level: "warn", message: "Multipart ingress audit delivery release failed", data: { schema: "v1", outcome: "failed", code } });
        }
        catch { }
        return false;
    }
}
async function armIngressSweep(database, candidate, now, sweepToken) {
    for (let attempt = 0; attempt <= 100; attempt += 1) {
        let fenceAcquired = false;
        try {
            return await database.adapter.withTransaction(async (adapter) => {
                await adapter.lockIngressReceipts([candidate.leaseId]);
                fenceAcquired = true;
                const stored = await adapter.selectIngressByLease(candidate.leaseId);
                if (!stored || stored.state === "complete")
                    return null;
                let row;
                try {
                    row = JSON.parse(stored.payload);
                }
                catch {
                    throw Object.assign(new Error("Ingress receipt payload is invalid."), { code: "INGRESS_SWEEP_INVALID_RECEIPT" });
                }
                // A File row is committed application state. Even a damaged legacy receipt must never
                // authorize its object deletion; leave it for explicit repair instead.
                if (row.fileId && await adapter.selectFileById(row.fileId))
                    return null;
                const armed = await adapter.markIngressReceiptSweeping(row, sweepToken, now);
                return Number(armed?.changes ?? 0) > 0 ? { ...row, state: "sweeping", sweepToken } : null;
            });
        }
        catch (error) {
            if (fenceAcquired || database.adapter.engine !== "sqlite" || attempt >= 100 || !String(error?.message ?? "").includes("database is locked"))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
        }
    }
    return null;
}
/** Retire one deterministic bounded batch. Object deletion precedes the token-fenced receipt delete. */
export async function sweepExpiredFileIngress(database, options = {}) {
    const now = typeof options.now === "string" && Number.isFinite(Date.parse(options.now)) ? new Date(options.now).toISOString() : new Date().toISOString();
    const requestedLimit = Number(options.limit ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
    let candidates;
    try {
        candidates = await database.adapter.selectIngressSweepCandidates(now, limit);
    }
    catch {
        return Object.freeze({ scanned: 0, cleaned: Object.freeze([]), failures: Object.freeze([{ code: "INGRESS_SWEEP_STORAGE_FAILED" }]) });
    }
    const cleaned = [];
    const failures = [];
    for (const candidate of candidates) {
        const leaseId = String(candidate.leaseId ?? "");
        const sweepToken = crypto.randomUUID();
        try {
            const armed = await armIngressSweep(database, candidate, now, sweepToken);
            if (!armed)
                continue;
            try {
                await database.fileStorage.deleteFileVersion({ fileId: armed.fileId, version: armed.version });
            }
            catch {
                failures.push(Object.freeze({ leaseId, code: "INGRESS_ORPHAN_CLEANUP_FAILED" }));
                continue;
            }
            const deleted = await database.adapter.deleteIngressSweepingReceipt(leaseId, sweepToken);
            if (Number(deleted?.changes ?? 0) > 0)
                cleaned.push(Object.freeze({ leaseId, requestKey: armed.requestKey, partKey: armed.partKey }));
        }
        catch (error) {
            failures.push(Object.freeze({ leaseId, code: error?.code === "INGRESS_SWEEP_INVALID_RECEIPT" ? "INGRESS_SWEEP_INVALID_RECEIPT" : "INGRESS_SWEEP_STORAGE_FAILED" }));
        }
    }
    if (cleaned.length > 0)
        await emitIngressAudit(database, "completed", { outcome: "cleaned" });
    if (failures.length > 0)
        await emitIngressAudit(database, "cleanup-failed", { outcome: "failed", code: failures[0].code });
    return Object.freeze({ scanned: candidates.length, cleaned: Object.freeze(cleaned), failures: Object.freeze(failures) });
}
//# sourceMappingURL=file-ingress-runtime.js.map