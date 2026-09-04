// Runtime-owned endpoint multipart ingress. Leases deliberately have no File row, URL or ACL
// visibility: only claim() creates an ordinary File in the handler transaction.
/// <reference path="./vendor-decoders.d.ts" />
import { ensureFileBucket, fileMetadataFromRow, normalizeAbsoluteFilePath } from "./file-storage-runtime.js";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";
import { parse, tokenizer } from "acorn";
import { parser as pythonParser } from "@lezer/python";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { parse as parseShell } from "unbash";

type RecordLike = Record<string, any>;
const crypto = process.getBuiltinModule("node:crypto");
const zlib = process.getBuiltinModule("node:zlib");
const net = process.getBuiltinModule("node:net");
const fs = process.getBuiltinModule("node:fs");
const pathRuntime = process.getBuiltinModule("node:path");
const childProcess = process.getBuiltinModule("node:child_process");
const leaseTtlMs = 10 * 60 * 1000;
const ingressClaimAuditRetentionMs = 24 * 60 * 60 * 1000;
const ingressClaimAuditPruneLimit = 50;
const clamavMaximumStreamBytes = 10 * 1024 * 1024;
export function isSupportedInspectionNodeVersion(version: string) { const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version); if (!match) return false; const major = Number(match[1]); const minor = Number(match[2]); return (major === 22 && minor >= 13) || major >= 24; }
if (!isSupportedInspectionNodeVersion(process.versions.node)) throw Object.assign(new Error("Sporades File inspection requires Node 22.13+ or Node 24+."), { code: "UNSUPPORTED_NODE_RUNTIME" });

function ingressAuditNow(database: RecordLike) {
  const now = database.clock?.now?.();
  return (now instanceof Date ? now : new Date()).toISOString();
}

async function receipt(database: RecordLike, key: string) {
  const sql = database.adapter.dialect.sql("SELECT [payload] FROM [sporades_file_ingress] WHERE [key] = ?");
  const row = await database.adapter.prepare(sql).get(key); return row ? JSON.parse(row.payload) : null;
}
async function receiptByLease(database: RecordLike, leaseId: string) {
  const stored = await database.adapter.selectIngressByLease(leaseId);
  return stored ? JSON.parse(stored.payload) : null;
}
async function publishStagedReceipt(database: RecordLike, row: RecordLike) {
  const leased = { ...row, state: "leased" }; const now = new Date().toISOString();
  const sql = database.adapter.dialect.sql("UPDATE [sporades_file_ingress] SET [state]='leased', [payload]=?, [updatedAt]=? WHERE [key]=? AND [leaseId]=? AND [state]='staging' AND [expiresAt]>?");
  const result = await database.adapter.prepare(sql).run(JSON.stringify(leased), now, row.key, row.leaseId, now);
  return Number(result?.changes ?? 0) > 0 ? leased : null;
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

function sameIngressRetryDescriptor(left: RecordLike, right: RecordLike) {
  return left?.fieldName === right?.fieldName && left?.name === right?.name && left?.type === right?.type && Number(left?.size) === Number(right?.size) && left?.digest === right?.digest &&
    left?.authorityKind === right?.authorityKind && (left?.authorityKind === "capsule-principal" || left?.actorId === right?.actorId) && left?.authorityId === right?.authorityId && left?.ownerId === right?.ownerId &&
    (left?.principalNamespace ?? null) === (right?.principalNamespace ?? null) && (left?.principalKeyDigest ?? null) === (right?.principalKeyDigest ?? null) &&
    left?.endpointMethod === right?.endpointMethod && left?.endpointPath === right?.endpointPath && left?.requestKey === right?.requestKey && left?.partKey === right?.partKey;
}

async function refreshReceiptInspection(database: RecordLike, row: RecordLike, inspection: RecordLike) {
  const refreshed = { ...row, inspection }; const updatedAt = new Date().toISOString();
  const sql = database.adapter.dialect.sql("UPDATE [sporades_file_ingress] SET [payload] = ?, [updatedAt] = ? WHERE [key] = ? AND [leaseId] = ? AND [state] = ? AND [payload] = ?");
  const updated = await database.adapter.prepare(sql).run(JSON.stringify(refreshed), updatedAt, row.key, row.leaseId, row.state, JSON.stringify(row));
  if (Number(updated?.changes ?? 0) > 0) return refreshed;
  const current = await receipt(database, row.key);
  if (!current || !sameIngressRetryDescriptor(current, row) || current.leaseId !== row.leaseId || !["leased", "complete"].includes(current.state)) throw idempotencyConflict("Ingress receipt changed while inspection evidence was refreshed.");
  return current;
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
function unsupportedMultipartPartEncoding(rawHeaders: string) {
  if (/(?:^|[^\r])\n|\r(?!\n)/.test(rawHeaders) || rawHeaders.startsWith("\r\n") || rawHeaders.endsWith("\r\n")) return true;
  for (const line of rawHeaders.split("\r\n")) {
    if (/^[ \t]/.test(line)) return true;
    const separator = line.indexOf(":"); if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim().toLowerCase();
    if (name === "content-transfer-encoding") return true;
    if (name === "content-type" && /^multipart\//.test(value)) return true;
  }
  return false;
}
function safeName(value: string) { return String(value ?? "upload").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 255) || "upload"; }
function safeType(value: string) { const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"; }
const maximumInspectionAgeMs = 24 * 60 * 60 * 1000;
function inspectionRequiredError() { return Object.assign(new Error("File ingress inspection is not clean."), { code: "INGRESS_INSPECTION_REQUIRED" }); }
function normalizedInspectionPolicy(value: any) {
  if (value === undefined) return null;
  const invalid = () => { throw Object.assign(new Error("Invalid file ingress inspection policy."), { code: "INVALID_MULTIPART_POLICY" }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.policyRevision !== "string" || value.policyRevision.length < 1 || Buffer.byteLength(value.policyRevision, "utf8") > 128 || /[\x00-\x1f\x7f]/.test(value.policyRevision)) invalid();
  const maxVerdictAgeMs = value.maxVerdictAgeMs ?? maximumInspectionAgeMs;
  if (!Number.isInteger(maxVerdictAgeMs) || maxVerdictAgeMs < 1 || maxVerdictAgeMs > maximumInspectionAgeMs || !Array.isArray(value.requiredInspectors) || value.requiredInspectors.length < 1 || value.requiredInspectors.length > 8) invalid();
  const names = new Set<string>();
  for (const inspector of value.requiredInspectors) {
    if (!["content-policy-v1", "clamav"].includes(inspector) || names.has(inspector)) invalid();
    names.add(inspector);
  }
  return { policyRevision: value.policyRevision, maxVerdictAgeMs, requiredInspectors: value.requiredInspectors };
}
function crc32(bytes: Buffer) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function validPng(bytes: Buffer) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
  let offset = 8; let index = 0; let sawIdat = false; let idatEnded = false; let sawPlte = false; let colorType = -1; let width = 0; let height = 0; let rowBytes = 0; const idatChunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); if (length > bytes.length - offset - 12) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii"); const data = bytes.subarray(offset + 8, offset + 8 + length); const storedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== storedCrc) return false;
    if (index === 0) { if (type !== "IHDR" || length !== 13 || data.readUInt32BE(0) === 0 || data.readUInt32BE(4) === 0 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return false; width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; if (width > 10_000 || height > 10_000 || width * height > 25_000_000) return false; const allowed = new Set(["0:1","0:2","0:4","0:8","0:16","2:8","2:16","3:1","3:2","3:4","3:8","4:8","4:16","6:8","6:16"]); if (!allowed.has(`${colorType}:${data[8]}`)) return false; const channels = ({0:1,2:3,3:1,4:2,6:4} as Record<number, number>)[colorType]; rowBytes = Math.ceil(width * channels * data[8] / 8); if ((rowBytes + 1) * height > 100_000_000) return false; }
    if (type === "PLTE") { if (sawIdat || sawPlte || length === 0 || length % 3 !== 0 || length > 768 || [0,4].includes(colorType)) return false; sawPlte = true; }
    if (type === "IDAT") { if (idatEnded || (colorType === 3 && !sawPlte)) return false; sawIdat = true; idatChunks.push(data); }
    else if (sawIdat && type !== "IEND") idatEnded = true;
    if (/^[A-Z]/.test(type[0]) && !["IHDR","PLTE","IDAT","IEND"].includes(type)) return false;
    if (type === "IEND") { if (!(length === 0 && sawIdat && offset + 12 === bytes.length)) return false; try { const inflated = zlib.inflateSync(Buffer.concat(idatChunks), { maxOutputLength: (rowBytes + 1) * height }); if (inflated.length !== (rowBytes + 1) * height) return false; for (let row = 0; row < height; row += 1) if (inflated[row * (rowBytes + 1)] > 4) return false; const decoded = PNG.sync.read(bytes, { checkCRC: true }); return decoded.width === width && decoded.height === height && decoded.data.length === width * height * 4; } catch { return false; } }
    if (type === "IHDR" && index !== 0) return false;
    offset += 12 + length; index += 1;
  }
  return false;
}
function validJpeg(bytes: Buffer) {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false; let offset = 2; let sawFrame = false; let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false; while (offset < bytes.length && bytes[offset] === 0xff) offset += 1; if (offset >= bytes.length) return false; const marker = bytes[offset++];
    if (marker === 0xd9) { if (!sawScan || offset !== bytes.length) return false; try { const decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 25, maxMemoryUsageInMB: 64 }); return decoded.width > 0 && decoded.height > 0 && decoded.width * decoded.height <= 25_000_000 && decoded.data.length === decoded.width * decoded.height * 4; } catch { return false; } }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > bytes.length) return false; const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) return false; const data = bytes.subarray(offset + 2, offset + length); offset += length;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) { if (data.length < 6 || data[0] !== 8 || data.readUInt16BE(1) === 0 || data.readUInt16BE(3) === 0 || data[5] < 1 || data.length !== 6 + data[5] * 3) return false; sawFrame = true; }
    if (marker === 0xda) { if (!sawFrame || data.length < 6 || data[0] < 1 || data.length !== 1 + data[0] * 2 + 3) return false; sawScan = true; while (offset < bytes.length) { if (bytes[offset++] !== 0xff) continue; if (offset >= bytes.length) return false; const next = bytes[offset]; if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 1; continue; } offset -= 1; break; } }
  }
  return false;
}
const pdfWhitespace = (byte: number) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const pdfDelimiter = (byte: number) => pdfWhitespace(byte) || [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte);
type PdfDeadlineGuard = (stage: string) => boolean;
function skipPdfTrivia(bytes: Buffer, offset: number, limit: number, allowBinaryComments = false, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("trivia")) return -1;
  let steps = 0;
  while (offset < limit) {
    while (offset < limit && pdfWhitespace(bytes[offset])) { if ((steps++ & 255) === 0 && deadlineExpired?.("trivia")) return -1; offset += 1; }
    if (offset >= limit || bytes[offset] !== 0x25) break;
    offset += 1;
    while (offset < limit && bytes[offset] !== 10 && bytes[offset] !== 13) {
      if ((steps++ & 255) === 0 && deadlineExpired?.("trivia")) return -1;
      if (!allowBinaryComments && (bytes[offset] < 0x20 || bytes[offset] > 0x7e)) return -1;
      offset += 1;
    }
  }
  return offset;
}
function pdfKeywordAt(bytes: Buffer, offset: number, keyword: string) {
  const end = offset + keyword.length;
  return end <= bytes.length && bytes.subarray(offset, end).toString("ascii") === keyword && (end === bytes.length || pdfDelimiter(bytes[end]));
}
function pdfObjectEnd(bytes: Buffer, offset: number, limit: number, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("object")) return -1;
  offset = skipPdfTrivia(bytes, offset, limit, false, deadlineExpired); if (offset < 0 || offset >= limit) return -1;
  if (bytes[offset] === 0x2f) { let steps = 0; offset += 1; while (offset < limit && !pdfDelimiter(bytes[offset])) { if ((steps++ & 255) === 0 && deadlineExpired?.("object")) return -1; offset += 1; } return offset; }
  if (bytes[offset] === 0x28) { let depth = 1; let steps = 0; offset += 1; while (offset < limit && depth > 0) { if ((steps++ & 255) === 0 && deadlineExpired?.("object")) return -1; if (bytes[offset] === 0x5c) offset += 2; else { if (bytes[offset] === 0x28) depth += 1; else if (bytes[offset] === 0x29) depth -= 1; offset += 1; } } return depth === 0 ? offset : -1; }
  if (bytes[offset] === 0x3c && bytes[offset + 1] !== 0x3c) { let steps = 0; offset += 1; while (offset < limit && bytes[offset] !== 0x3e) { if ((steps++ & 255) === 0 && deadlineExpired?.("object")) return -1; offset += 1; } return offset < limit ? offset + 1 : -1; }
  if (bytes[offset] === 0x5b || (bytes[offset] === 0x3c && bytes[offset + 1] === 0x3c)) {
    const stack = [bytes[offset] === 0x5b ? 0x5d : 0x3e]; offset += bytes[offset] === 0x5b ? 1 : 2; let steps = 0;
    while (offset < limit && stack.length && ++steps <= 2_000_000) {
      if ((steps & 255) === 0 && deadlineExpired?.("object")) return -1;
      if (bytes[offset] === 0x25) { while (offset < limit && bytes[offset] !== 10 && bytes[offset] !== 13) { if ((steps++ & 255) === 0 && deadlineExpired?.("object")) return -1; offset += 1; } continue; }
      if (bytes[offset] === 0x28) { const end = pdfObjectEnd(bytes, offset, limit, deadlineExpired); if (end < 0) return -1; offset = end; continue; }
      if (bytes[offset] === 0x3c && bytes[offset + 1] !== 0x3c) { const end = pdfObjectEnd(bytes, offset, limit, deadlineExpired); if (end < 0) return -1; offset = end; continue; }
      if (bytes[offset] === 0x5b) { stack.push(0x5d); offset += 1; continue; }
      if (bytes[offset] === 0x3c && bytes[offset + 1] === 0x3c) { stack.push(0x3e); offset += 2; continue; }
      if (bytes[offset] === stack.at(-1) && (stack.at(-1) !== 0x3e || bytes[offset + 1] === 0x3e)) { offset += stack.pop() === 0x3e ? 2 : 1; continue; }
      offset += 1;
    }
    return stack.length === 0 ? offset : -1;
  }
  let end = offset; let tokenSteps = 0; let numeric = true; let digit = false; let dot = false;
  if (bytes[end] === 0x2b || bytes[end] === 0x2d) end += 1;
  while (end < limit && !pdfDelimiter(bytes[end])) {
    if ((tokenSteps++ & 255) === 0 && deadlineExpired?.("object-token")) return -1;
    const byte = bytes[end];
    if (byte >= 0x30 && byte <= 0x39) digit = true;
    else if (byte === 0x2e && !dot) dot = true;
    else numeric = false;
    end += 1;
  }
  if (end === offset) return -1;
  if (numeric && digit) {
    if (deadlineExpired?.("object-reference")) return -1;
    const after = skipPdfTrivia(bytes, end, limit, false, deadlineExpired);
    if (after < 0) return -1;
    let referenceAt = after; let generationDigits = 0;
    while (referenceAt < limit && bytes[referenceAt] >= 0x30 && bytes[referenceAt] <= 0x39 && generationDigits <= 10) { generationDigits += 1; referenceAt += 1; }
    if (generationDigits >= 1 && generationDigits <= 10) {
      const whitespaceAt = referenceAt; let whitespaceSteps = 0;
      while (referenceAt < limit && pdfWhitespace(bytes[referenceAt])) { if ((whitespaceSteps++ & 255) === 0 && deadlineExpired?.("object-reference")) return -1; referenceAt += 1; }
      if (referenceAt > whitespaceAt && bytes[referenceAt] === 0x52 && (referenceAt + 1 === limit || pdfDelimiter(bytes[referenceAt + 1]))) end = referenceAt + 1;
    }
  }
  return end;
}
function pdfDictionaryHasTopLevelKey(bytes: Buffer, offset: number, key: string, deadlineExpired?: PdfDeadlineGuard) {
  if (bytes[offset] !== 0x3c || bytes[offset + 1] !== 0x3c) return false; let cursor = offset + 2; let pairs = 0;
  while (++pairs <= 100_000) {
    if (deadlineExpired?.("dictionary")) return false;
    cursor = skipPdfTrivia(bytes, cursor, bytes.length, false, deadlineExpired); if (cursor < 0) return false;
    if (bytes[cursor] === 0x3e && bytes[cursor + 1] === 0x3e) return false;
    if (bytes[cursor] !== 0x2f) return false; const start = ++cursor; let nameSteps = 0; while (cursor < bytes.length && !pdfDelimiter(bytes[cursor])) { if ((nameSteps++ & 255) === 0 && deadlineExpired?.("dictionary")) return false; cursor += 1; }
    if (cursor - start > 256) return false;
    const name = bytes.subarray(start, cursor).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (name === key) return true;
    cursor = pdfObjectEnd(bytes, cursor, bytes.length, deadlineExpired); if (cursor < 0) return false;
  }
  return false;
}
type PdfReference = { objectNumber: number; generation: number };
function pdfDictionary(bytes: Buffer, offset: number, integerKeys: Set<string>, nameKeys = new Set<string>(), integerArrayKeys = new Set<string>(), nameListKeys = new Set<string>(), referenceKeys = new Set<string>(), presenceKeys = new Set<string>(), deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("dictionary")) return null;
  if (bytes[offset] !== 0x3c || bytes[offset + 1] !== 0x3c) return null;
  const values = new Map<string, number>(); const names = new Map<string, string>(); const arrays = new Map<string, number[]>(); const nameLists = new Map<string, string[]>(); const references = new Map<string, PdfReference>(); const present = new Set([...presenceKeys].filter((key) => pdfDictionaryHasTopLevelKey(bytes, offset, key, deadlineExpired))); let depth = 0; let index = offset; let steps = 0;
  if (deadlineExpired?.("dictionary")) return null;
  while (index < bytes.length && ++steps <= 2_000_000) {
    if ((steps & 255) === 0 && deadlineExpired?.("dictionary")) return null;
    const byte = bytes[index];
    if (byte === 0x25) { while (index < bytes.length && bytes[index] !== 10 && bytes[index] !== 13) { if ((steps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; index += 1; } continue; }
    if (byte === 0x28) { let stringDepth = 1; index += 1; while (index < bytes.length && stringDepth > 0 && ++steps <= 2_000_000) { if ((steps & 255) === 0 && deadlineExpired?.("dictionary")) return null; if (bytes[index] === 0x5c) index += 2; else { if (bytes[index] === 0x28) stringDepth += 1; else if (bytes[index] === 0x29) stringDepth -= 1; index += 1; } } if (stringDepth) return null; continue; }
    if (byte === 0x3c && bytes[index + 1] !== 0x3c) { index += 1; while (index < bytes.length && bytes[index] !== 0x3e) { if ((steps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; index += 1; } if (index >= bytes.length) return null; index += 1; continue; }
    if (byte === 0x3c && bytes[index + 1] === 0x3c) { depth += 1; index += 2; continue; }
    if (byte === 0x3e && bytes[index + 1] === 0x3e) { depth -= 1; index += 2; if (depth === 0) return { end: index, values, names, arrays, nameLists, references, present }; if (depth < 0) return null; continue; }
    if (byte === 0x2f) {
      const nameStart = ++index; while (index < bytes.length && !pdfDelimiter(bytes[index])) { if ((steps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; index += 1; }
      if (index - nameStart > 256) return null;
      const name = bytes.subarray(nameStart, index).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (depth === 1 && (integerKeys.has(name) || referenceKeys.has(name))) {
        let valueAt = skipPdfTrivia(bytes, index, bytes.length, false, deadlineExpired); if (valueAt < 0) return null;
        const match = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20\[\]()<>\/%]|$)/.exec(bytes.subarray(valueAt, Math.min(bytes.length, valueAt + 80)).toString("latin1"));
        if (!match || values.has(name) || references.has(name)) return null;
        const first = Number(match[1]); if (!Number.isSafeInteger(first)) return null;
        const after = skipPdfTrivia(bytes, valueAt + match[1].length, bytes.length, false, deadlineExpired); if (after < 0) return null;
        const reference = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+R(?:[\x00\x09\x0a\x0c\x0d\x20\[\]()<>\/%]|$)/.exec(bytes.subarray(after, Math.min(bytes.length, after + 80)).toString("latin1"));
        if (reference) {
          const generation = Number(reference[1]);
          if (!referenceKeys.has(name) || first > 999_999 || generation > 65_535) return null;
          references.set(name, { objectNumber: first, generation });
        } else {
          if (!integerKeys.has(name)) return null;
          values.set(name, first);
        }
      } else if (depth === 1 && nameKeys.has(name)) {
        let valueAt = skipPdfTrivia(bytes, index, bytes.length, false, deadlineExpired); if (valueAt < 0 || bytes[valueAt] !== 0x2f || names.has(name)) return null;
        const valueStart = ++valueAt; while (valueAt < bytes.length && !pdfDelimiter(bytes[valueAt])) { if ((steps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; valueAt += 1; }
        if (valueAt - valueStart > 256) return null;
        const value = bytes.subarray(valueStart, valueAt).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
        if (!value) return null; names.set(name, value);
      } else if (depth === 1 && integerArrayKeys.has(name)) {
        let valueAt = skipPdfTrivia(bytes, index, bytes.length, false, deadlineExpired); if (valueAt < 0 || bytes[valueAt] !== 0x5b || arrays.has(name)) return null;
        const result: number[] = []; valueAt += 1;
        while (result.length <= 2_000) {
          if (deadlineExpired?.("dictionary")) return null;
          valueAt = skipPdfTrivia(bytes, valueAt, bytes.length, false, deadlineExpired); if (valueAt < 0) return null;
          if (bytes[valueAt] === 0x5d) { arrays.set(name, result); break; }
          const item = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20\]])/.exec(bytes.subarray(valueAt, Math.min(bytes.length, valueAt + 40)).toString("latin1"));
          if (!item) return null;
          const value = Number(item[1]); if (!Number.isSafeInteger(value)) return null;
          result.push(value); valueAt += item[1].length;
        }
        if (!arrays.has(name)) return null;
      } else if (depth === 1 && nameListKeys.has(name)) {
        let valueAt = skipPdfTrivia(bytes, index, bytes.length, false, deadlineExpired); if (valueAt < 0 || nameLists.has(name)) return null;
        const result: string[] = []; const array = bytes[valueAt] === 0x5b; if (array) valueAt += 1;
        while (result.length <= 16) {
          if (deadlineExpired?.("dictionary")) return null;
          valueAt = skipPdfTrivia(bytes, valueAt, bytes.length, false, deadlineExpired); if (valueAt < 0 || bytes[valueAt] !== 0x2f) return null;
          const valueStart = ++valueAt; while (valueAt < bytes.length && !pdfDelimiter(bytes[valueAt])) { if ((steps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; valueAt += 1; }
          if (valueAt - valueStart > 256) return null;
          const value = bytes.subarray(valueStart, valueAt).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
          if (!value) return null; result.push(value); valueAt = skipPdfTrivia(bytes, valueAt, bytes.length, false, deadlineExpired); if (valueAt < 0) return null;
          if (!array || bytes[valueAt] === 0x5d) { nameLists.set(name, result); break; }
        }
        if (!nameLists.has(name)) return null;
      }
      continue;
    }
    index += 1;
  }
  return null;
}
type PdfXrefEntry =
  | { type: 0; nextFree: number; generation: number }
  | { type: 1; offset: number; generation: number }
  | { type: 2; objectStream: number; index: number };
type PdfIndirectLength = { reference: PdfReference; value: number };
type ParsedPdfXrefSection = { kind: "classic" | "stream"; end: number; prev?: number; size: number; maxObject: number; entries: Map<number, PdfXrefEntry>; objectOffsets: Set<number>; indirectLengths: PdfIndirectLength[] };
function pdfIndirectInteger(bytes: Buffer, reference: PdfReference, entries: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("object")) return null;
  const entry = entries.get(reference.objectNumber); if (!entry || entry.type !== 1 || entry.generation !== reference.generation) return null;
  const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(entry.offset, Math.min(bytes.length, entry.offset + 80)).toString("latin1"));
  if (!head || Number(head[1]) !== reference.objectNumber || Number(head[2]) !== reference.generation) return null;
  let cursor = skipPdfTrivia(bytes, entry.offset + head[0].length, bytes.length, false, deadlineExpired); if (cursor < 0) return null;
  const integer = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(cursor, Math.min(bytes.length, cursor + 40)).toString("latin1"));
  if (!integer) return null; const value = Number(integer[1]); if (!Number.isSafeInteger(value) || value > 24_000_000) return null;
  cursor = skipPdfTrivia(bytes, cursor + integer[1].length, bytes.length, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "endobj")) return null;
  return value;
}
function pdfStreamLength(bytes: Buffer, dictionary: ReturnType<typeof pdfDictionary> & {}, entries: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard) {
  const direct = dictionary.values.get("Length"); if (direct !== undefined) return direct <= 24_000_000 ? direct : null;
  const reference = dictionary.references.get("Length"); return reference ? pdfIndirectInteger(bytes, reference, entries, deadlineExpired) : null;
}
function locatePdfIndirectInteger(bytes: Buffer, reference: PdfReference, limit: number, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("object")) return null;
  const objectNumber = String(reference.objectNumber); const generation = String(reference.generation); let found: { offset: number; value: number } | null = null;
  const matches = (at: number, text: string) => at + text.length <= limit && bytes.subarray(at, at + text.length).toString("ascii") === text;
  const skipWhitespace = (at: number) => { let steps = 0; while (at < limit && pdfWhitespace(bytes[at])) { if ((steps++ & 255) === 0 && deadlineExpired?.("object")) return -1; at += 1; } return at; };
  for (let cursor = 0; cursor < limit; cursor += 1) {
    if ((cursor & 255) === 0 && deadlineExpired?.("object")) return null;
    if ((cursor > 0 && !pdfWhitespace(bytes[cursor - 1])) || !matches(cursor, objectNumber)) continue;
    let at = cursor + objectNumber.length; if (at >= limit || !pdfWhitespace(bytes[at])) continue;
    at = skipWhitespace(at); if (at < 0) return null;
    if (!matches(at, generation)) continue; at += generation.length;
    if (at >= limit || !pdfWhitespace(bytes[at])) continue; at = skipWhitespace(at); if (at < 0) return null;
    if (!matches(at, "obj")) continue; at += 3;
    if (at >= limit || !pdfWhitespace(bytes[at])) continue; at = skipWhitespace(at); if (at < 0) return null;
    const valueStart = at; while (at < limit && bytes[at] >= 0x30 && bytes[at] <= 0x39 && at - valueStart <= 20) at += 1;
    if (at === valueStart || at - valueStart > 20 || at >= limit || !pdfWhitespace(bytes[at])) continue;
    const value = Number(bytes.subarray(valueStart, at).toString("ascii")); at = skipWhitespace(at); if (at < 0) return null;
    if (!matches(at, "endobj") || (at + 6 < limit && !pdfDelimiter(bytes[at + 6]))) continue;
    if (!Number.isSafeInteger(value) || value > 24_000_000 || found) return null; found = { offset: cursor, value };
  }
  return found;
}
function pdfTopLevelValueOffset(bytes: Buffer, dictionaryOffset: number, dictionaryEnd: number, wanted: string, deadlineExpired?: PdfDeadlineGuard): number | undefined | null {
  let cursor = dictionaryOffset + 2; let found: number | undefined; let pairs = 0;
  while (++pairs <= 100_000) {
    if (deadlineExpired?.("dictionary")) return null;
    cursor = skipPdfTrivia(bytes, cursor, dictionaryEnd, false, deadlineExpired); if (cursor < 0) return null;
    if (bytes[cursor] === 0x3e && bytes[cursor + 1] === 0x3e) return found;
    if (bytes[cursor] !== 0x2f) return null;
    const nameStart = ++cursor; let nameSteps = 0; while (cursor < dictionaryEnd && !pdfDelimiter(bytes[cursor])) { if ((nameSteps++ & 255) === 0 && deadlineExpired?.("dictionary")) return null; cursor += 1; }
    if (cursor - nameStart > 256) return null;
    const name = bytes.subarray(nameStart, cursor).toString("ascii").replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    const valueAt = skipPdfTrivia(bytes, cursor, dictionaryEnd, false, deadlineExpired); if (valueAt < 0) return null;
    if (name === wanted) { if (found !== undefined) return null; found = valueAt; }
    cursor = pdfObjectEnd(bytes, valueAt, dictionaryEnd, deadlineExpired); if (cursor < 0) return null;
  }
  return null;
}
type PdfPredictorParameters = { predictor: number; colors: number; bits: number; columns: number };
function pdfPredictorParameters(bytes: Buffer, dictionaryOffset: number, dictionaryEnd: number, filterIsArray: boolean, deadlineExpired?: PdfDeadlineGuard): PdfPredictorParameters | null {
  const parameterAt = pdfTopLevelValueOffset(bytes, dictionaryOffset, dictionaryEnd, "DecodeParms", deadlineExpired);
  if (parameterAt === null) return null;
  if (parameterAt === undefined) return { predictor: 1, colors: 1, bits: 8, columns: 1 };
  let at = parameterAt; let array = false;
  if (bytes[at] === 0x5b) { if (!filterIsArray) return null; array = true; at = skipPdfTrivia(bytes, at + 1, dictionaryEnd, false, deadlineExpired); if (at < 0) return null; }
  if (pdfKeywordAt(bytes, at, "null")) {
    at = skipPdfTrivia(bytes, at + 4, dictionaryEnd, false, deadlineExpired); if (at < 0 || (array && bytes[at] !== 0x5d)) return null;
    return { predictor: 1, colors: 1, bits: 8, columns: 1 };
  }
  const parameters = pdfDictionary(bytes, at, new Set(["Predictor", "Colors", "BitsPerComponent", "BPC", "Columns"]), new Set(), new Set(), new Set(), new Set(), new Set(), deadlineExpired);
  if (!parameters || parameters.end > dictionaryEnd || (parameters.values.has("BitsPerComponent") && parameters.values.has("BPC"))) return null;
  let end = skipPdfTrivia(bytes, parameters.end, dictionaryEnd, false, deadlineExpired); if (end < 0 || (array && bytes[end] !== 0x5d)) return null;
  const predictor = parameters.values.get("Predictor") ?? 1; const colors = parameters.values.get("Colors") ?? 1; const bits = parameters.values.get("BitsPerComponent") ?? parameters.values.get("BPC") ?? 8; const columns = parameters.values.get("Columns") ?? 1;
  return { predictor, colors, bits, columns };
}
function pdfPredictorLayout(parameters: PdfPredictorParameters, entryCount: number, recordBytes: number) {
  const { predictor, colors, bits, columns } = parameters;
  if (!Number.isSafeInteger(predictor) || !Number.isSafeInteger(colors) || colors < 1 || colors > 32 || ![1, 2, 4, 8, 16].includes(bits) || !Number.isSafeInteger(columns) || columns < 1) return null;
  const decodedLength = BigInt(entryCount) * BigInt(recordBytes);
  if (predictor === 1) return { encodedLength: Number(decodedLength), decodedLength: Number(decodedLength), rowBytes: recordBytes, rowCount: entryCount };
  if (predictor !== 2 && (predictor < 10 || predictor > 15)) return null;
  const rowBytes = (BigInt(colors) * BigInt(bits) * BigInt(columns) + 7n) / 8n;
  if (rowBytes < 1n || decodedLength % rowBytes !== 0n) return null;
  const rowCount = decodedLength / rowBytes; const encodedLength = decodedLength + (predictor >= 10 ? rowCount : 0n);
  return encodedLength <= 25_000_000n ? { encodedLength: Number(encodedLength), decodedLength: Number(decodedLength), rowBytes: Number(rowBytes), rowCount: Number(rowCount) } : null;
}
function decodePdfPredictor(encoded: Buffer, parameters: PdfPredictorParameters, entryCount: number, recordBytes: number, deadlineExpired?: PdfDeadlineGuard) {
  const { predictor, colors, bits, columns } = parameters;
  const layout = pdfPredictorLayout(parameters, entryCount, recordBytes);
  if (!layout || encoded.length !== layout.encodedLength || layout.decodedLength > 24_000_000 || deadlineExpired?.("predictor-start")) return null;
  if (predictor <= 1) return encoded;
  const { decodedLength, rowBytes, rowCount } = layout; const decoded = Buffer.alloc(decodedLength); if (deadlineExpired?.("predictor-start")) return null;
  const pixelBytes = Math.ceil(colors * bits / 8); let encodedAt = 0;
  for (let row = 0; row < rowCount; row += 1) {
    if (deadlineExpired?.("predictor-row")) return null;
    const outputAt = row * rowBytes; const previousAt = outputAt - rowBytes;
    if (predictor >= 10) {
      const filter = encoded[encodedAt++]; if (filter > 4) return null;
      for (let column = 0; column < rowBytes; column += 1) {
        if ((column & 255) === 0 && deadlineExpired?.("predictor-work")) return null;
        const raw = encoded[encodedAt++]; const left = column >= pixelBytes ? decoded[outputAt + column - pixelBytes] : 0; const up = row > 0 ? decoded[previousAt + column] : 0; const upLeft = row > 0 && column >= pixelBytes ? decoded[previousAt + column - pixelBytes] : 0;
        if (filter === 0) decoded[outputAt + column] = raw;
        else if (filter === 1) decoded[outputAt + column] = raw + left;
        else if (filter === 2) decoded[outputAt + column] = raw + up;
        else if (filter === 3) decoded[outputAt + column] = raw + Math.floor((left + up) / 2);
        else { const p = left + up - upLeft; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft); decoded[outputAt + column] = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft); }
      }
      continue;
    }
    const raw = encoded.subarray(encodedAt, encodedAt + rowBytes); encodedAt += rowBytes;
    if (bits === 1 && colors === 1) {
      let carry = 0; for (let column = 0; column < rowBytes; column += 1) { if ((column & 255) === 0 && deadlineExpired?.("predictor-work")) return null; let value = raw[column] ^ carry; value ^= value >> 1; value ^= value >> 2; value ^= value >> 4; carry = (value & 1) << 7; decoded[outputAt + column] = value; }
    } else if (bits === 8) {
      for (let column = 0; column < rowBytes; column += 1) { if ((column & 255) === 0 && deadlineExpired?.("predictor-work")) return null; decoded[outputAt + column] = column < colors ? raw[column] : raw[column] + decoded[outputAt + column - colors]; }
    } else if (bits === 16) {
      const pixel = colors * 2; for (let column = 0; column < rowBytes; column += 2) { if ((column & 255) === 0 && deadlineExpired?.("predictor-work")) return null; if (column < pixel) { decoded[outputAt + column] = raw[column]; decoded[outputAt + column + 1] = raw[column + 1]; } else { const value = (raw[column] << 8) + raw[column + 1] + (decoded[outputAt + column - pixel] << 8) + decoded[outputAt + column - pixel + 1]; decoded[outputAt + column] = value >> 8; decoded[outputAt + column + 1] = value; } }
    } else {
      const components = new Uint8Array(colors + 1); const mask = (1 << bits) - 1; let input = 0; let inputBits = 0; let inputBuffer = 0; let outputBits = 0; let outputBuffer = 0; let output = outputAt;
      for (let column = 0; column < columns; column += 1) for (let color = 0; color < colors; color += 1) { if (((column * colors + color) & 255) === 0 && deadlineExpired?.("predictor-work")) return null; if (inputBits < bits) { inputBuffer = inputBuffer << 8 | raw[input++]; inputBits += 8; } components[color] = components[color] + (inputBuffer >> (inputBits - bits)) & mask; inputBits -= bits; outputBuffer = outputBuffer << bits | components[color]; outputBits += bits; if (outputBits >= 8) { decoded[output++] = outputBuffer >> (outputBits - 8); outputBits -= 8; } }
      if (outputBits > 0) decoded[output] = (outputBuffer << (8 - outputBits)) + (inputBuffer & ((1 << (8 - outputBits)) - 1));
    }
  }
  return decoded;
}
function pdfXrefSection(bytes: Buffer, offset: number, allowHybrid = true, bootstrapEntries?: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard): ParsedPdfXrefSection | null {
  if (deadlineExpired?.("xref")) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return null;
  if (pdfKeywordAt(bytes, offset, "xref")) {
    let cursor = offset + 4; let entryCount = 0; let highestObject = -1; const entries = new Map<number, PdfXrefEntry>(); const objectOffsets = new Set<number>();
    while (cursor < bytes.length) {
      if (deadlineExpired?.("xref")) return null;
      cursor = skipPdfTrivia(bytes, cursor, bytes.length, false, deadlineExpired); if (cursor < 0) return null;
      if (pdfKeywordAt(bytes, cursor, "trailer")) {
        cursor = skipPdfTrivia(bytes, cursor + 7, bytes.length, false, deadlineExpired); if (cursor < 0) return null;
        const dictionary = pdfDictionary(bytes, cursor, new Set(["Prev", "Size", "XRefStm"]), new Set(), new Set(), new Set(), new Set(), new Set(["Encrypt"]), deadlineExpired); const size = dictionary?.values.get("Size");
        if (!dictionary || dictionary.present.has("Encrypt") || size === undefined || size < 1 || size > 1_000_000 || highestObject >= size) return null;
        for (const entry of entries.values()) { if (deadlineExpired?.("xref") || (entry.type === 0 && entry.nextFree >= size)) return null; }
        const indirectLengths: PdfIndirectLength[] = [];
        const hybridOffset = dictionary.values.get("XRefStm");
        if (hybridOffset !== undefined) {
          if (!allowHybrid) return null;
          if (hybridOffset <= 0 || hybridOffset >= offset) return null;
          const hybrid = pdfXrefSection(bytes, hybridOffset, false, entries, deadlineExpired);
          if (!hybrid || hybrid.kind !== "stream" || hybrid.size !== size || hybrid.prev !== undefined) return null;
          for (const [objectNumber, entry] of hybrid.entries) {
            if (deadlineExpired?.("xref")) return null;
            // PDF 32000-1 7.5.8.4 resolves a hybrid lookup through the current
            // classic section before its XRefStm, then through Prev. Match that
            // deterministic order after each source has rejected its own
            // duplicate object identities.
            if (!entries.has(objectNumber)) entries.set(objectNumber, entry);
          }
          for (const objectOffset of hybrid.objectOffsets) { if (deadlineExpired?.("xref")) return null; objectOffsets.add(objectOffset); }
          indirectLengths.push(...hybrid.indirectLengths);
          if (!pdfRevisionObjectsOnly(bytes, hybrid.end, offset, objectOffsets, false, undefined, deadlineExpired)) return null;
          highestObject = Math.max(highestObject, hybrid.maxObject);
        }
        return { kind: "classic" as const, end: dictionary.end, prev: dictionary.values.get("Prev"), size, maxObject: highestObject, entries, objectOffsets, indirectLengths };
      }
      const header = /^(\d{1,10})[\x00\x09\x0c\x20]+(\d{1,10})[\x00\x09\x0c\x20]*(?:\r\n|\r|\n)/.exec(bytes.subarray(cursor, Math.min(bytes.length, cursor + 80)).toString("latin1"));
      if (!header) return null;
      const first = Number(header[1]); const count = Number(header[2]); if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 1 || first + count > 1_000_000 || entryCount + count > 1_000_000) return null;
      highestObject = Math.max(highestObject, first + count - 1);
      cursor += header[0].length; entryCount += count;
      for (let index = 0; index < count; index += 1) {
        if (deadlineExpired?.("xref")) return null;
        const entry = /^(\d{10})[\x00\x09\x0c\x20]+(\d{5})[\x00\x09\x0c\x20]+([fn])[\x00\x09\x0c\x20]*(?:\r\n|\r|\n)/.exec(bytes.subarray(cursor, Math.min(bytes.length, cursor + 40)).toString("latin1"));
        if (!entry) return null;
        const objectNumber = first + index; const objectOffset = Number(entry[1]); const generation = Number(entry[2]); if (generation > 65_535 || entries.has(objectNumber) || (objectNumber === 0 && (entry[3] !== "f" || generation !== 65_535))) return null;
        if (entry[3] === "n") {
          if (objectOffset >= offset) return null;
          const target = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(objectOffset, Math.min(bytes.length, objectOffset + 80)).toString("latin1"));
          if (!target || Number(target[1]) !== objectNumber || Number(target[2]) !== generation) return null;
          entries.set(objectNumber, { type: 1, offset: objectOffset, generation }); objectOffsets.add(objectOffset);
        } else entries.set(objectNumber, { type: 0, nextFree: objectOffset, generation });
        cursor += entry[0].length;
      }
    }
    return null;
  }
  const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(offset, Math.min(bytes.length, offset + 80)).toString("latin1"));
  if (!head || Number(head[2]) > 65_535) return null;
  let cursor = skipPdfTrivia(bytes, offset + head[0].length, bytes.length, false, deadlineExpired); if (cursor < 0) return null;
  const dictionaryOffset = cursor; const dictionary = pdfDictionary(bytes, cursor, new Set(["Length", "Prev", "Size"]), new Set(["Type"]), new Set(["W", "Index"]), new Set(["Filter"]), new Set(["Length"]), new Set(["Encrypt"]), deadlineExpired);
  const width = dictionary?.arrays.get("W"); const size = dictionary?.values.get("Size");
  if (!dictionary || dictionary.present.has("Encrypt") || (!dictionary.values.has("Length") && !dictionary.references.has("Length")) || dictionary.names.get("Type") !== "XRef" || size === undefined || size < 1 || size > 1_000_000 || !width || width.length !== 3 || width.some((item) => item > 6) || width[1] === 0 || width[0] + width[1] + width[2] === 0) return null;
  const index = dictionary.arrays.get("Index") ?? [0, size];
  if (index.length === 0 || index.length % 2 !== 0) return null;
  let entryCount = 0; let previousRangeEnd = 0; let maxObject = -1;
  for (let at = 0; at < index.length; at += 2) { if (deadlineExpired?.("xref")) return null; const first = index[at]; const count = index[at + 1]; if (count < 1 || first < previousRangeEnd || first + count > size) return null; previousRangeEnd = first + count; maxObject = Math.max(maxObject, previousRangeEnd - 1); entryCount += count; }
  const recordBytes = width[0] + width[1] + width[2]; if (entryCount > 1_000_000 || entryCount * recordBytes > 24_000_000) return null;
  const filterOffset = pdfTopLevelValueOffset(bytes, dictionaryOffset, dictionary.end, "Filter", deadlineExpired); if (filterOffset === null) return null;
  const filters = dictionary.nameLists.get("Filter"); const predictorParameters = pdfPredictorParameters(bytes, dictionaryOffset, dictionary.end, filterOffset !== undefined && bytes[filterOffset] === 0x5b, deadlineExpired);
  const predictorLayout = predictorParameters ? pdfPredictorLayout(predictorParameters, entryCount, recordBytes) : null; if (!predictorLayout || (filters === undefined && predictorParameters!.predictor !== 1)) return null;
  const lengthReference = dictionary.references.get("Length"); const locatedLength = lengthReference ? locatePdfIndirectInteger(bytes, lengthReference, offset, deadlineExpired) : null;
  const streamLength = dictionary.values.get("Length") ?? (lengthReference && bootstrapEntries ? pdfIndirectInteger(bytes, lengthReference, bootstrapEntries, deadlineExpired) : null) ?? locatedLength?.value;
  if (streamLength === undefined || streamLength > 24_000_000) return null;
  cursor = skipPdfTrivia(bytes, dictionary.end, bytes.length, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "stream")) return null;
  cursor += 6; if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2; else if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor += 1; else return null;
  const streamStart = cursor; cursor += streamLength; if (cursor > bytes.length) return null;
  let decoded: Buffer;
  try {
    if (filters === undefined) decoded = bytes.subarray(streamStart, cursor);
    else if (filters.length === 1 && filters[0] === "FlateDecode") { if (deadlineExpired?.("inflate-before")) return null; decoded = zlib.inflateSync(bytes.subarray(streamStart, cursor), { maxOutputLength: predictorLayout.encodedLength + 1 }); if (deadlineExpired?.("inflate-after")) return null; }
    else return null;
  } catch { return null; }
  const predicted = decodePdfPredictor(decoded, predictorParameters!, entryCount, recordBytes, deadlineExpired); if (!predicted) return null; decoded = predicted;
  const readField = (at: number, length: number) => { let value = 0; for (let byte = 0; byte < length; byte += 1) value = value * 256 + decoded[at + byte]; return value; };
  const entries = new Map<number, PdfXrefEntry>(); const objectOffsets = new Set<number>(); let decodedAt = 0; let sawSelf = false;
  for (let range = 0; range < index.length; range += 2) for (let item = 0; item < index[range + 1]; item += 1) {
    if (deadlineExpired?.("xref")) return null;
    const objectNumber = index[range] + item; const type = width[0] === 0 ? 1 : readField(decodedAt, width[0]); const field2 = readField(decodedAt + width[0], width[1]); const field3 = readField(decodedAt + width[0] + width[1], width[2]); decodedAt += recordBytes;
    if (((type === 0 || type === 1) && field3 > 65_535) || (objectNumber === 0 && (type !== 0 || field3 !== 65_535))) return null;
    if (type === 1) {
      if (field2 > offset || (objectNumber !== Number(head[1]) && field2 === offset)) return null;
      const target = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(field2, Math.min(bytes.length, field2 + 80)).toString("latin1"));
      if (!target || Number(target[1]) !== objectNumber || Number(target[2]) !== field3) return null;
      entries.set(objectNumber, { type: 1, offset: field2, generation: field3 }); objectOffsets.add(field2); if (objectNumber === Number(head[1])) sawSelf = field2 === offset && field3 === Number(head[2]);
    }
    else if (type === 2) { if (field2 >= size) return null; entries.set(objectNumber, { type: 2, objectStream: field2, index: field3 }); }
    else if (type === 0) { if (field2 >= size) return null; entries.set(objectNumber, { type: 0, nextFree: field2, generation: field3 }); }
    else return null;
  }
  if (!sawSelf) return null;
  if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2; else if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor += 1;
  if (!pdfKeywordAt(bytes, cursor, "endstream")) return null;
  cursor = skipPdfTrivia(bytes, cursor + 9, bytes.length, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "endobj")) return null;
  return { kind: "stream" as const, end: cursor + 6, prev: dictionary.values.get("Prev"), size, maxObject, entries, objectOffsets, indirectLengths: lengthReference ? [{ reference: lengthReference, value: streamLength }] : [] };
}
function pdfFooterAfter(bytes: Buffer, sectionEnd: number, limit: number, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("revision")) return null;
  let cursor = skipPdfTrivia(bytes, sectionEnd, limit, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "startxref")) return null;
  const start = cursor; cursor = skipPdfTrivia(bytes, cursor + 9, limit, false, deadlineExpired); if (cursor < 0) return null;
  const pointer = /^(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(cursor, Math.min(limit, cursor + 40)).toString("latin1"));
  if (!pointer) return null;
  cursor += pointer[1].length; let whitespaceSteps = 0; while (cursor < limit && pdfWhitespace(bytes[cursor])) { if ((whitespaceSteps++ & 255) === 0 && deadlineExpired?.("revision")) return null; cursor += 1; }
  if (cursor + 5 > limit || bytes.subarray(cursor, cursor + 5).toString("ascii") !== "%%EOF" || (cursor > 0 && bytes[cursor - 1] !== 10 && bytes[cursor - 1] !== 13)) return null;
  const end = cursor + 5; if (end < limit && bytes[end] !== 10 && bytes[end] !== 13) return null;
  return { start, end, pointer: Number(pointer[1]) };
}
function pdfRevisionObjectsOnly(bytes: Buffer, start: number, end: number, referencedOffsets?: Set<number>, allowBinaryComments = false, entries?: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard) {
  let cursor = skipPdfTrivia(bytes, start, end, allowBinaryComments, deadlineExpired); if (cursor < 0) return false;
  while (cursor < end) {
    if (deadlineExpired?.("objects")) return false;
    if (referencedOffsets && !referencedOffsets.has(cursor)) return false;
    const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(cursor, Math.min(end, cursor + 80)).toString("latin1"));
    if (!head || Number(head[2]) > 65_535) return false;
    let index = cursor + head[0].length; let foundEnd = false; let steps = 0;
    while (index < end && ++steps <= 2_000_000) {
      if ((steps & 255) === 0 && deadlineExpired?.("objects")) return false;
      if (bytes[index] === 0x25) { while (index < end && bytes[index] !== 10 && bytes[index] !== 13) { if ((steps++ & 255) === 0 && deadlineExpired?.("objects")) return false; index += 1; } continue; }
      if (bytes[index] === 0x28) { let depth = 1; index += 1; while (index < end && depth > 0 && ++steps <= 2_000_000) { if ((steps & 255) === 0 && deadlineExpired?.("objects")) return false; if (bytes[index] === 0x5c) index += 2; else { if (bytes[index] === 0x28) depth += 1; else if (bytes[index] === 0x29) depth -= 1; index += 1; } } if (depth) return false; continue; }
      if (bytes[index] === 0x3c && bytes[index + 1] !== 0x3c) { index += 1; while (index < end && bytes[index] !== 0x3e) { if ((steps++ & 255) === 0 && deadlineExpired?.("objects")) return false; index += 1; } if (index >= end) return false; index += 1; continue; }
      if (bytes[index] === 0x3c && bytes[index + 1] === 0x3c) {
        const dictionary = pdfDictionary(bytes, index, new Set(["Length"]), new Set(), new Set(), new Set(), new Set(["Length"]), new Set(), deadlineExpired); if (!dictionary) return false;
        const after = skipPdfTrivia(bytes, dictionary.end, end, false, deadlineExpired); if (after < 0) return false;
        if (pdfKeywordAt(bytes, after, "stream")) {
          const length = entries ? pdfStreamLength(bytes, dictionary, entries, deadlineExpired) : dictionary.values.get("Length"); if (length === undefined || length === null) return false;
          index = after + 6; if (bytes[index] === 13 && bytes[index + 1] === 10) index += 2; else if (bytes[index] === 10 || bytes[index] === 13) index += 1; else return false;
          index += length; if (index > end) return false;
          if (bytes[index] === 13 && bytes[index + 1] === 10) index += 2; else if (bytes[index] === 10 || bytes[index] === 13) index += 1;
          if (!pdfKeywordAt(bytes, index, "endstream")) return false;
          index += 9; continue;
        }
        index = dictionary.end; continue;
      }
      if (pdfKeywordAt(bytes, index, "endobj")) { cursor = index + 6; foundEnd = true; break; }
      index += 1;
    }
    if (!foundEnd) return false;
    cursor = skipPdfTrivia(bytes, cursor, end, allowBinaryComments, deadlineExpired); if (cursor < 0) return false;
  }
  return cursor === end;
}
function pdfObjectStreamNumbers(bytes: Buffer, entry: Extract<PdfXrefEntry, { type: 1 }>, entries: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard) {
  if (deadlineExpired?.("objects")) return null;
  const head = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(bytes.subarray(entry.offset, Math.min(bytes.length, entry.offset + 80)).toString("latin1"));
  if (!head || Number(head[2]) !== entry.generation) return null;
  let cursor = skipPdfTrivia(bytes, entry.offset + head[0].length, bytes.length, false, deadlineExpired); if (cursor < 0) return null;
  const dictionary = pdfDictionary(bytes, cursor, new Set(["Length", "N", "First"]), new Set(["Type"]), new Set(), new Set(["Filter"]), new Set(["Length"]), new Set(), deadlineExpired);
  const length = dictionary ? pdfStreamLength(bytes, dictionary, entries, deadlineExpired) : null; const count = dictionary?.values.get("N"); const first = dictionary?.values.get("First");
  if (!dictionary || dictionary.names.get("Type") !== "ObjStm" || length === null || count === undefined || count < 1 || count > 100_000 || first === undefined || first > 24_000_000) return null;
  cursor = skipPdfTrivia(bytes, dictionary.end, bytes.length, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "stream")) return null;
  cursor += 6; if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2; else if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor += 1; else return null;
  const streamStart = cursor; cursor += length; if (cursor > bytes.length) return null;
  let decoded: Buffer;
  try {
    const filters = dictionary.nameLists.get("Filter");
    if (filters === undefined) decoded = bytes.subarray(streamStart, cursor);
    else if (filters.length === 1 && filters[0] === "FlateDecode") { if (deadlineExpired?.("inflate-before")) return null; decoded = zlib.inflateSync(bytes.subarray(streamStart, cursor), { maxOutputLength: 24_000_001 }); if (deadlineExpired?.("inflate-after")) return null; }
    else return null;
  } catch { return null; }
  if (decoded.length > 24_000_000 || first > decoded.length) return null;
  const objectNumbers: number[] = []; const seen = new Set<number>(); let headerAt = 0; let previousOffset = -1;
  for (let index = 0; index < count; index += 1) {
    if (deadlineExpired?.("objects")) return null;
    headerAt = skipPdfTrivia(decoded, headerAt, first, false, deadlineExpired); if (headerAt < 0) return null;
    const pair = /^(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,20})(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(decoded.subarray(headerAt, Math.min(first, headerAt + 80)).toString("latin1"));
    if (!pair) return null;
    const objectNumber = Number(pair[1]); const objectOffset = Number(pair[2]);
    if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || seen.has(objectNumber) || !Number.isSafeInteger(objectOffset) || objectOffset <= previousOffset || first + objectOffset >= decoded.length) return null;
    seen.add(objectNumber); objectNumbers.push(objectNumber); previousOffset = objectOffset; headerAt += pair[0].length;
  }
  if (previousOffset < 0 || skipPdfTrivia(decoded, headerAt, first, false, deadlineExpired) !== first) return null;
  if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2; else if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor += 1;
  if (!pdfKeywordAt(bytes, cursor, "endstream")) return null;
  cursor = skipPdfTrivia(bytes, cursor + 9, bytes.length, false, deadlineExpired); if (cursor < 0 || !pdfKeywordAt(bytes, cursor, "endobj")) return null;
  return objectNumbers;
}
function validPdfEffectiveXref(bytes: Buffer, size: number, entries: Map<number, PdfXrefEntry>, deadlineExpired?: PdfDeadlineGuard) {
  const head = entries.get(0); if (!head || head.type !== 0 || head.generation !== 65_535) return false;
  const linkedFree = new Set<number>(); let freeAt = head.nextFree;
  while (freeAt !== 0) {
    if (deadlineExpired?.("xref")) return false;
    if (freeAt >= size || linkedFree.has(freeAt)) return false;
    const entry = entries.get(freeAt); if (!entry || entry.type !== 0) return false;
    linkedFree.add(freeAt); freeAt = entry.nextFree;
  }
  for (const [objectNumber, entry] of entries) { if (deadlineExpired?.("xref")) return false; if (objectNumber !== 0 && entry.type === 0 && !linkedFree.has(objectNumber)) return false; }
  const objectStreams = new Map<number, number[]>();
  for (const [objectNumber, entry] of entries) if (entry.type === 2) {
    if (deadlineExpired?.("objects")) return false;
    const container = entries.get(entry.objectStream); if (!container || container.type !== 1) return false;
    let objectNumbers = objectStreams.get(entry.objectStream);
    if (!objectNumbers) { objectNumbers = pdfObjectStreamNumbers(bytes, container, entries, deadlineExpired) ?? undefined; if (!objectNumbers) return false; objectStreams.set(entry.objectStream, objectNumbers); }
    if (entry.index >= objectNumbers.length || objectNumbers[entry.index] !== objectNumber) return false;
  }
  return true;
}
function hasPdfFooterBefore(bytes: Buffer, limit: number, deadlineExpired: PdfDeadlineGuard) {
  const startxref = Buffer.from("startxref"); const eof = Buffer.from("%%EOF");
  const skipWhitespace = (at: number) => { let steps = 0; while (at < limit && pdfWhitespace(bytes[at])) { if ((steps++ & 255) === 0 && deadlineExpired("revision")) return -1; at += 1; } return at; };
  for (let cursor = 0; cursor + startxref.length < limit; cursor += 1) {
    if ((cursor & 255) === 0 && deadlineExpired("revision")) return true;
    if (!bytes.subarray(cursor, cursor + startxref.length).equals(startxref)) continue;
    let at = cursor + startxref.length; if (!pdfWhitespace(bytes[at])) continue;
    at = skipWhitespace(at); if (at < 0) return true;
    const pointerStart = at; while (at < limit && bytes[at] >= 0x30 && bytes[at] <= 0x39 && at - pointerStart <= 20) at += 1;
    if (at === pointerStart || at - pointerStart > 20 || at >= limit || !pdfWhitespace(bytes[at])) continue;
    at = skipWhitespace(at); if (at < 0) return true;
    if (at + eof.length <= limit && bytes.subarray(at, at + eof.length).equals(eof)) return true;
  }
  return false;
}
function validPdfTerminalBoundary(bytes: Buffer, deadlineExpired: PdfDeadlineGuard) {
  // Each accepted EOF is tied to the xref section which immediately precedes
  // its startxref footer. Following /Prev proves that the terminal section is
  // a real incremental revision rather than a forged footer over appended data.
  if (deadlineExpired("terminal")) return false;
  let terminalMarker = bytes.lastIndexOf(Buffer.from("%%EOF"));
  if (deadlineExpired("terminal")) return false;
  while (terminalMarker >= 0 && ((terminalMarker > 0 && bytes[terminalMarker - 1] !== 10 && bytes[terminalMarker - 1] !== 13) || skipPdfTrivia(bytes, terminalMarker + 5, bytes.length, false, deadlineExpired) !== bytes.length)) { if (deadlineExpired("terminal")) return false; terminalMarker = bytes.lastIndexOf(Buffer.from("%%EOF"), terminalMarker - 1); }
  if (terminalMarker < 0) return false;
  const footerPrefix = bytes.subarray(Math.max(0, terminalMarker - 160), terminalMarker).toString("latin1");
  const footerStart = /startxref[\x00\x09\x0a\x0c\x0d\x20]+\d{1,20}[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(footerPrefix);
  if (!footerStart) return false;
  const absoluteFooterStart = Math.max(0, terminalMarker - 160) + footerStart.index;
  const pointerMatch = /startxref[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,20})/.exec(footerStart[0]);
  if (!pointerMatch) return false;
  let offset = Number(pointerMatch[1]); const seen = new Set<number>(); const chain: Array<{ offset: number; end: number; prev?: number; size: number; maxObject: number; entries: Map<number, PdfXrefEntry>; objectOffsets: Set<number>; indirectLengths: PdfIndirectLength[] }> = []; let revisions = 0;
  while (++revisions <= 256) {
    if (deadlineExpired("revision")) return false;
    if (seen.has(offset)) return false; seen.add(offset);
    const section = pdfXrefSection(bytes, offset, true, undefined, deadlineExpired); if (!section) return false;
    const footer = pdfFooterAfter(bytes, section.end, bytes.length, deadlineExpired); if (!footer || footer.pointer !== offset) return false;
    if (revisions === 1 && footer.start !== absoluteFooterStart) return false;
    chain.push({ offset, end: footer.end, prev: section.prev, size: section.size, maxObject: section.maxObject, entries: section.entries, objectOffsets: section.objectOffsets, indirectLengths: section.indirectLengths });
    if (section.prev === undefined) {
      const earlierFooter = hasPdfFooterBefore(bytes, offset, deadlineExpired);
      if (deadlineExpired("revision")) return false;
      if (earlierFooter) return false;
      const header = /^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.exec(bytes.subarray(0, Math.min(offset, 32)).toString("latin1"));
      if (!header) return false;
      for (let index = chain.length - 2; index >= 0; index -= 1) {
        if (deadlineExpired("revision")) return false;
        const current = chain[index]; const previous = chain[index + 1];
        if (current.size !== Math.max(previous.size, current.maxObject + 1)) return false;
      }
      if (chain.at(-1)!.size !== chain.at(-1)!.maxObject + 1) return false;
      const effective = new Map<number, PdfXrefEntry>();
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (deadlineExpired("revision")) return false;
        const revision = chain[index];
        for (const [objectNumber, entry] of revision.entries) { if (deadlineExpired("xref")) return false; effective.set(objectNumber, entry); }
        const bodyStart = index === chain.length - 1 ? header[0].length : chain[index + 1].end;
        if (!pdfRevisionObjectsOnly(bytes, bodyStart, revision.offset, revision.objectOffsets, index === chain.length - 1, effective, deadlineExpired)) return false;
        for (const indirect of revision.indirectLengths) { if (deadlineExpired("object")) return false; if (pdfIndirectInteger(bytes, indirect.reference, effective, deadlineExpired) !== indirect.value) return false; }
        if (!validPdfEffectiveXref(bytes, revision.size, effective, deadlineExpired)) return false;
      }
      return true;
    }
    if (section.prev >= offset) return false;
    offset = section.prev;
  }
  return false;
}
let pdfJsModulePromise: Promise<RecordLike> | undefined;
function loadPdfJsModule() {
  if (!pdfJsModulePromise) {
    const pending = import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfJsModulePromise = pending;
    void pending.catch(() => { if (pdfJsModulePromise === pending) pdfJsModulePromise = undefined; });
  }
  return pdfJsModulePromise;
}
export async function validatePdfIngress(bytes: Buffer, options: RecordLike = {}) {
  let task: any; let timer: any; let expired = false; const timeoutMs = Number.isInteger(options.timeoutMs) ? Math.max(1, Math.min(2_000, options.timeoutMs)) : 2_000; const monotonicNow = typeof options.monotonicNow === "function" ? options.monotonicNow : () => process.hrtime.bigint(); const deadline = monotonicNow() + BigInt(timeoutMs) * 1_000_000n; const deadlineExpired = (stage = "pdfjs") => { options.pdfPreflightCheckpoint?.(stage); return expired || monotonicNow() >= deadline; };
  if (deadlineExpired("header") || bytes.length < 16 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || !validPdfTerminalBoundary(bytes, deadlineExpired) || deadlineExpired("preflight-complete")) return false;
  try {
    const workflow = (async () => {
      options.beforePdfJsImport?.();
      const { getDocument } = await loadPdfJsModule();
      if (deadlineExpired()) return false;
      task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true });
      const [document, parsed] = await Promise.all([task.promise, PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false })]);
      if (deadlineExpired() || (document as any).numPages < 1 || (document as any).numPages > 100) return false;
      type PdfGraphRole = "ordinary" | "page-tree" | "annotation" | "outline-root" | "outline-item" | "action";
      const visitedObjects = new WeakMap<object, Set<PdfGraphRole>>(); const visitedRefs = new Map<string, Set<PdfGraphRole>>(); let visitedCount = 0;
      const actionBearingKeys = new Set(["/OpenAction", "/AA"]);
      const outlineItemLinkKeys = new Set(["/First", "/Last", "/Next", "/Prev"]);
      const forbiddenStructureKeys = new Set(["/JavaScript", "/EmbeddedFiles", "/EF", "/XFA"]);
      const actionSubtypes = new Set(["/GoTo", "/GoToR", "/GoToE", "/Launch", "/Thread", "/URI", "/Sound", "/Movie", "/Hide", "/Named", "/SubmitForm", "/ResetForm", "/ImportData", "/JavaScript", "/SetOCGState", "/Rendition", "/Trans", "/GoTo3DView"]);
      const semanticName = (candidate: PDFDict, key: string): string | undefined | null => {
        let value = candidate.get(PDFName.of(key));
        if (value === undefined) return undefined;
        const refs = new Set<string>();
        for (let hop = 0; hop < 16; hop += 1) {
          if (deadlineExpired()) return null;
          if (value instanceof PDFName) return value.asString();
          if (!(value instanceof PDFRef)) return null;
          const ref = value.toString();
          if (refs.has(ref)) return null;
          refs.add(ref);
          try { value = parsed.context.lookup(value); } catch { return null; }
          if (value === undefined) return null;
        }
        return null;
      };
      const visit = (candidate: any, depth = 0, role: PdfGraphRole = "ordinary"): boolean => {
        if (deadlineExpired() || depth > 128 || ++visitedCount > 100_000) return false;
        // Action ownership follows the object graph from the catalog's Pages
        // and Outlines roots. It never depends on optional annotation or
        // outline marker fields: /A is also a benign StructElem/IconFit key.
        // Reject the whole reachable value even when it is indirect, an array,
        // or a dictionary that legally omits /Type /Action and /S.
        if (role === "action") return false;
        if (candidate instanceof PDFRef) { const key = candidate.toString(); const roles = visitedRefs.get(key) ?? new Set<PdfGraphRole>(); if (roles.has(role)) return true; roles.add(role); visitedRefs.set(key, roles); return visit(parsed.context.lookup(candidate), depth + 1, role); }
        if (!candidate || typeof candidate !== "object") return true;
        const objectRoles = visitedObjects.get(candidate) ?? new Set<PdfGraphRole>(); if (objectRoles.has(role)) return true; objectRoles.add(role); visitedObjects.set(candidate, objectRoles);
        if (candidate instanceof PDFStream) return visit(candidate.dict, depth + 1, role);
        if (candidate instanceof PDFArray) { for (let index = 0; index < candidate.size(); index += 1) if (!visit(candidate.get(index), depth + 1, role)) return false; return true; }
        if (!(candidate instanceof PDFDict)) return true;
        const type = semanticName(candidate, "Type");
        if (type === null || type === "/Action" || type === "/Filespec" || type === "/EmbeddedFile") return false;
        const subtype = semanticName(candidate, "S");
        if (subtype === null) return false;
        // /S is shared by many benign PDF structures (border styles,
        // transparency groups, and more). It is action semantics only for a
        // standardized action subtype or in an action-bearing context.
        if (subtype !== undefined && actionSubtypes.has(subtype)) return false;
        const ownsActivationAction = role === "annotation" || role === "outline-item";
        for (const [key, value] of candidate.entries()) {
          const name = key.asString();
          if (forbiddenStructureKeys.has(name) || name === "/JS") return false;
          // /Next is also the ordinary sibling pointer in outline trees. It is
          // an action chain only after this dictionary has independently been
          // classified as an action; those dictionaries are rejected above.
          let childRole: PdfGraphRole = actionBearingKeys.has(name) || (name === "/A" && ownsActivationAction) ? "action" : "ordinary";
          if (candidate === parsed.catalog && name === "/Pages") childRole = "page-tree";
          else if (candidate === parsed.catalog && name === "/Outlines") childRole = "outline-root";
          else if (role === "page-tree" && name === "/Kids") childRole = "page-tree";
          else if (role === "page-tree" && name === "/Annots") childRole = "annotation";
          else if (role === "outline-root" && (name === "/First" || name === "/Last")) childRole = "outline-item";
          else if (role === "outline-item" && outlineItemLinkKeys.has(name)) childRole = "outline-item";
          if (!visit(value, depth + 1, childRole)) return false;
        }
        return true;
      };
      if (!visit(parsed.catalog)) return false;
      for (const [, object] of parsed.context.enumerateIndirectObjects()) if (deadlineExpired() || !visit(object)) return false;
      const catalogChecks = await Promise.all([(document as any).getAttachments?.(), (document as any).getJSActions?.(), (document as any).getOpenAction?.()]);
      if (deadlineExpired()) return false;
      const hasEntries = (value: any) => Boolean(value) && (value instanceof Map || value instanceof Set ? value.size > 0 : Array.isArray(value) ? value.length > 0 : typeof value !== "object" || Object.keys(value).length > 0);
      if (catalogChecks.some(hasEntries)) return false;
      for (let page = 1; page <= (document as any).numPages; page += 1) { if (deadlineExpired()) return false; await options.beforeOperatorList?.(page); if (deadlineExpired()) return false; const currentPage = await (document as any).getPage(page); if (deadlineExpired()) return false; const [operators, actions, annotations] = await Promise.all([currentPage.getOperatorList(), currentPage.getJSActions?.(), currentPage.getAnnotations?.({ intent: "display" })]); if (deadlineExpired() || hasEntries(actions)) return false; if (Array.isArray(annotations) && annotations.some((annotation: RecordLike) => annotation?.action || annotation?.attachment || annotation?.file || annotation?.unsafeUrl || annotation?.annotationType === 17)) return false; void operators; }
      return !deadlineExpired();
    })();
    return await Promise.race([workflow, new Promise<boolean>((resolve) => { const remaining = deadline - monotonicNow(); timer = setTimeout(() => { expired = true; try { task?.destroy?.(); } catch {} resolve(false); }, remaining > 0n ? Number(remaining) / 1_000_000 : 0); })]);
  } catch { return false; } finally { expired = true; clearTimeout(timer); try { await task?.destroy?.(); } catch {} }
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
function isStructuredAcornSyntaxError(error: unknown) {
  const value = error as RecordLike;
  return error instanceof SyntaxError && Number.isInteger(value?.pos) && Number.isInteger(value?.raisedAt)
    && Number.isInteger(value?.loc?.line) && Number.isInteger(value?.loc?.column);
}
function isAcornStackExhaustion(error: unknown) {
  // This exact diagnostic is defense-in-depth for the pinned parser. The flat
  // tokenizer bounds below independently stop known recursive grammar shapes
  // before parse(), so admission does not depend on diagnostic prose alone.
  return isStructuredAcornSyntaxError(error) && String((error as Error).message).startsWith("Not enough stack space to parse input");
}
export function isJavaScriptRawInputWithinBounds(text: string) {
  let depth = 0;
  for (const character of text) {
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      if (depth > maximumContentPolicyParserRecursion) return false;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return true;
}
function boundedJavaScriptPreparse(text: string) {
  if (!isJavaScriptRawInputWithinBounds(text)) return "exhausted";
  const closingFor = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["${", "}"]]);
  const closings: string[] = []; let recursiveGrammarTokens = 0; let unmatchedConditionals = 0; let tokens = 0;
  try {
    const input = tokenizer(text, { ecmaVersion: "latest", sourceType: "module" });
    while (true) {
      const token = input.getToken(); const label = token.type.label;
      tokens += 1;
      if (tokens > maximumContentPolicyTokens) return "exhausted";
      const type = token.type as RecordLike;
      const value = (token as unknown as RecordLike).value;
      const contextualRecursion = label === "name" && (value === "await" || value === "yield");
      const unmatchedLabel = label === ":" && unmatchedConditionals === 0;
      if (label === "?") unmatchedConditionals += 1;
      else if (label === ":" && unmatchedConditionals > 0) unmatchedConditionals -= 1;
      if (type.prefix || type.binop != null || type.isAssign || contextualRecursion
        || recursiveJavaScriptGrammarLabels.has(label) || unmatchedLabel) {
        recursiveGrammarTokens += 1;
        if (recursiveGrammarTokens > maximumContentPolicyParserRecursion) return "exhausted";
      }
      const closing = closingFor.get(label);
      if (closing) {
        closings.push(closing);
        if (closings.length > maximumContentPolicyParserRecursion) return "exhausted";
      } else if (closings.at(-1) === label) {
        closings.pop();
      }
      if (label === "eof") return "within-bounds";
    }
  } catch (error) {
    return isStructuredAcornSyntaxError(error) && !isAcornStackExhaustion(error) ? "invalid" : "exhausted";
  }
}
export function isJavaScriptParserInputWithinBounds(text: string) {
  return boundedJavaScriptPreparse(text) !== "exhausted";
}
export function hasExecutableJavaScriptSemantics(text: string) {
  const preparse = boundedJavaScriptPreparse(text);
  if (preparse === "exhausted") return true;
  if (preparse === "invalid") return false;
  let root: RecordLike;
  try {
    root = parse(text, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }) as RecordLike;
  } catch (error) {
    return isStructuredAcornSyntaxError(error) && !isAcornStackExhaustion(error) ? false : true;
  }
  const pending = [{ node: root, depth: 0 }]; let visited = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    visited += 1;
    if (visited > maximumContentPolicyAstNodes || depth > maximumContentPolicyAstDepth) return true;
    if (executableJavaScriptNodes.has(node.type)) return true;
    if (node.type === "UnaryExpression" && node.operator === "delete") return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && typeof child.type === "string") pending.push({ node: child, depth: depth + 1 });
      } else if (value && typeof value === "object" && typeof value.type === "string") pending.push({ node: value, depth: depth + 1 });
    }
  }
  return false;
}
const executablePythonNodes = new Set([
  "AwaitExpression", "CallExpression", "ComprehensionExpression",
  "ArrayComprehensionExpression", "DictionaryComprehensionExpression", "SetComprehensionExpression",
  "LambdaExpression", "NamedExpression", "YieldExpression",
]);
export function hasExecutablePythonSemantics(text: string) {
  if (Buffer.byteLength(text, "utf8") > maximumContentPolicyTextBytes || !isJavaScriptRawInputWithinBounds(text)) return true;
  let cursor;
  try { cursor = pythonParser.parse(text).cursor(); }
  catch { return true; }
  let depth = 0; let visited = 0; let syntaxError = false; let executable = false;
  while (true) {
    visited += 1;
    if (visited > maximumContentPolicyAstNodes || depth > maximumPythonContentPolicyAstDepth) return true;
    const name = cursor.name;
    if (cursor.type.isError) syntaxError = true;
    if ((name.endsWith("Statement") && name !== "ExpressionStatement")
      || name.endsWith("Definition") || executablePythonNodes.has(name)) executable = true;
    if (cursor.firstChild()) { depth += 1; continue; }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return !syntaxError && executable;
      depth -= 1;
    }
  }
}
function isSentenceShapedText(text: string) {
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
function exactShellVocabularyToken(text: string) {
  const trimmed = text.trim();
  if (bashCommandNames.has(trimmed)) return trimmed;
  if (trimmed.length >= 2 && ((trimmed[0] === "'" && trimmed.at(-1) === "'") || (trimmed[0] === '"' && trimmed.at(-1) === '"'))) {
    const value = trimmed.slice(1, -1);
    if (!value.includes(trimmed[0]) && !/[\\$`]/.test(value) && bashCommandNames.has(value)) return value;
  }
  return null;
}
function isStaticShellWord(word: RecordLike) {
  if (!word || typeof word.value !== "string" || typeof word.text !== "string") return false;
  const literalPart = (part: RecordLike): boolean => part?.type === "Literal"
    || part?.type === "SingleQuoted"
    || (part?.type === "DoubleQuoted" && Array.isArray(part.parts) && part.parts.every(literalPart));
  if (Array.isArray(word.parts) && !word.parts.every(literalPart)) return false;
  return true;
}
function isLiteralShellWord(word: RecordLike) {
  if (!isStaticShellWord(word)) return false;
  return !/[$`*?\[\]{}~]/.test(word.text.replace(/^(['"])([\s\S]*)\1$/, "$2"));
}
function isRegularExecutableShellPath(candidate: string) {
  if (Buffer.byteLength(candidate, "utf8") > 4096) return false;
  try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
}
function shellCommandCanRun(name: string) {
  if (bashCommandNames.has(name)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(name)) return false;
  if (name.includes("/")) return isRegularExecutableShellPath(name);
  if (Buffer.byteLength(name, "utf8") > 255) return false;
  const pathEntries = String(process.env.PATH ?? "").split(":");
  for (const entry of pathEntries.slice(0, 128)) {
    const directory = entry || process.cwd();
    if (Buffer.byteLength(directory, "utf8") > 4096) return true;
    if (isRegularExecutableShellPath(`${directory.replace(/\/$/, "")}/${name}`)) return true;
  }
  return pathEntries.length > 128;
}
function braceSequenceAlternatives(body: string): string[] | null | undefined {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  const alphabetic = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (!numeric && !alphabetic) return undefined;
  const stepText = (numeric ?? alphabetic)?.[3]; const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isSafeInteger(step) || step === 0) return undefined;
  const start = numeric ? Number(numeric[1]) : alphabetic![1].charCodeAt(0); const end = numeric ? Number(numeric[2]) : alphabetic![2].charCodeAt(0);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  const increment = (start <= end ? 1 : -1) * Math.abs(step); const count = Math.floor(Math.abs(end - start) / Math.abs(increment)) + 1;
  if (count > 64) return null;
  const width = numeric && (/^-?0\d/.test(numeric[1]) || /^-?0\d/.test(numeric[2])) ? Math.max(numeric[1].length, numeric[2].length) : 0;
  const format = (value: number) => alphabetic ? String.fromCharCode(value) : width > 0
    ? value < 0 ? `-${String(Math.abs(value)).padStart(width - 1, "0")}` : String(value).padStart(width, "0")
    : String(value);
  return Array.from({ length: count }, (_, index) => format(start + index * increment));
}
function braceBodyIsExpandable(body: string) {
  return body.includes(",") || braceSequenceAlternatives(body) !== undefined;
}
function shellWordHasPathExpansion(word: RecordLike) {
  const raw = String(word?.text ?? ""); let quote = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\" && quote !== "'") { index += 1; continue; }
    if (character === "'" || character === '"') { if (!quote) quote = character; else if (quote === character) quote = ""; continue; }
    if (quote) continue;
    if ((index === 0 && character === "~") || character === "*" || character === "?" || character === "[") return true;
    if (character === "{") { const close = raw.indexOf("}", index + 1); if (close > index + 1 && braceBodyIsExpandable(raw.slice(index + 1, close))) return true; }
  }
  return false;
}
function boundedBraceExpansion(pattern: string) {
  let patterns = [pattern];
  for (let depth = 0; depth < 8; depth += 1) {
    let expanded = false; const next: string[] = [];
    for (const candidate of patterns) {
      const matches = [...candidate.matchAll(/\{([^{}]*)\}/g)]; const match = matches.find((entry) => braceBodyIsExpandable(entry[1]));
      const alternatives = !match ? undefined : match[1].includes(",") ? match[1].split(",") : braceSequenceAlternatives(match[1]);
      if (!match || alternatives === undefined) { next.push(candidate); continue; }
      if (alternatives === null) return null;
      expanded = true;
      for (const alternative of alternatives) {
        next.push(candidate.slice(0, match.index) + alternative + candidate.slice(match.index + match[0].length));
        if (next.length > 64) return null;
      }
    }
    patterns = next;
    if (!expanded) return patterns;
  }
  return null;
}
const posixBracketClassNames = new Set(["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "word", "xdigit"]);
function shellGlobSegment(segment: string): RegExp | null | false {
  let source = "^"; let active = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "*") { source += "[^/]*"; active = true; continue; }
    if (character === "?") { source += "[^/]"; active = true; continue; }
    if (character === "[") {
      let close = index + 1; let body = ""; let localeDependent = false; let unsupported = false;
      while (close < segment.length) {
        if (segment[close] === "[" && [":", ".", "="].includes(segment[close + 1])) {
          const marker = segment[close + 1]; const innerClose = segment.indexOf(`${marker}]`, close + 2); if (innerClose < 0) break;
          const token = segment.slice(close + 2, innerClose); localeDependent ||= marker === ":" && posixBracketClassNames.has(token); unsupported ||= marker !== ":" || !posixBracketClassNames.has(token);
          body += "A"; close = innerClose + 2; continue;
        }
        if (segment[close] === "]" && close > index + 1) break;
        const literal = segment[close]; body += literal === "\\" || literal === "]" ? `\\${literal}` : literal; close += 1;
      }
      if (close < segment.length && segment[close] === "]") {
        if (close - index > 128) return false;
        if (localeDependent || unsupported) return false;
        body = body.replace(/^!/, "^"); source += `[${body}]`; active = true; index = close; continue;
      }
    }
    source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  if (!active) return null;
  try { return new RegExp(`${source}$`); } catch { return null; }
}
function expandedShellCommandCanRun(pattern: string) {
  if (Buffer.byteLength(pattern, "utf8") > 4096) return true;
  const braces = boundedBraceExpansion(pattern); if (!braces) return true;
  let visited = 0;
  for (let candidate of braces) {
    let roots: string[]; let segments: string[]; let pathQualified = candidate.includes("/");
    if (candidate.startsWith("~")) {
      const slash = candidate.indexOf("/"); const user = candidate.slice(1, slash < 0 ? undefined : slash); const home = String(process.env.HOME ?? "");
      if (user || !home || !pathRuntime.isAbsolute(home) || Buffer.byteLength(home, "utf8") > 4096) return true;
      const prefixLength = slash < 0 ? candidate.length : slash + 1;
      roots = [home]; segments = candidate.length < prefixLength ? [] : candidate.slice(prefixLength).split("/"); pathQualified = true;
    } else {
      const absolute = candidate.startsWith("/"); roots = [absolute ? "/" : process.cwd()]; segments = candidate.split("/").filter((segment, index) => !(absolute && index === 0));
    }
    if (segments.length > 128) return true;
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { roots = roots.map((root: string) => pathRuntime.dirname(root)); continue; }
      const matcher = shellGlobSegment(segment); if (matcher === false) return true; const next: string[] = [];
      for (const root of roots) {
        if (!matcher) next.push(pathRuntime.join(root, segment));
        else {
          let names: string[]; try { names = fs.readdirSync(root); } catch { continue; }
          if (names.length > 1024) return true;
          for (const name of names) {
            visited += 1; if (visited > 4096) return true;
            if ((!segment.startsWith(".") && name.startsWith(".")) || !matcher.test(name)) continue;
            next.push(pathRuntime.join(root, name)); if (next.length > 64) return true;
          }
        }
      }
      roots = next; if (roots.length === 0) break;
    }
    if (pathQualified ? roots.some(isRegularExecutableShellPath) : roots.some((root: string) => shellCommandCanRun(pathRuntime.basename(root)))) return true;
    if (!pathQualified && roots.length === 0 && shellCommandCanRun(candidate)) return true;
  }
  return false;
}
function isPlainShellDatum(statement: RecordLike) {
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
function parsedShellCommandCanRun(command: RecordLike) {
  return command?.type === "Command" && ((isStaticShellWord(command.name) && !shellWordHasPathExpansion(command.name) && shellCommandCanRun(command.name.value))
    || (shellWordHasPathExpansion(command.name) && expandedShellCommandCanRun(command.name.value)));
}
function hasRunnableParsedShellCommand(statement: RecordLike) {
  return statement?.type === "Statement" && parsedShellCommandCanRun(statement.command);
}
function parsedShellNodeHasRunnableCommand(root: RecordLike) {
  const pending = [root]; const seen = new WeakSet<object>(); let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop(); if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value); visited += 1; if (visited > maximumContentPolicyAstNodes) return true;
    if (parsedShellCommandCanRun(value)) return true;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const item of child) pending.push(item);
      else pending.push(child);
    }
  }
  return false;
}
function parsedShellStatementCompletedBeforeError(statement: RecordLike, firstErrorAt: number) {
  if (statement?.type !== "Statement" || !Number.isInteger(statement.pos) || !Number.isInteger(statement.end)
    || statement.end <= statement.pos || statement.end >= firstErrorAt) return false;
  const pending = [statement]; const seen = new WeakSet<object>(); let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop(); if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value); visited += 1; if (visited > maximumContentPolicyAstNodes) return false;
    if ((Number.isInteger(value.pos) && value.pos < statement.pos) || (Number.isInteger(value.end) && value.end > statement.end)) return false;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const item of child) pending.push(item);
      else pending.push(child);
    }
  }
  return true;
}
function hasCompletedShellLineBoundary(suffix: string) {
  for (let index = 0; index < suffix.length; index += 1) {
    if (suffix[index] !== "\n") continue;
    let escapes = 0; for (let before = index - 1; before >= 0 && suffix[before] === "\\"; before -= 1) escapes += 1;
    if (escapes % 2 === 0) return true;
  }
  return false;
}
function isNonRunnablePathSentence(text: string, root: RecordLike) {
  if (!Array.isArray(root?.commands) || root.commands.length !== 1) return false;
  const statement = root.commands[0]; const command = statement?.command; const trimmed = text.trim(); const prose = trimmed.replace(/\\([*?\[\]{}~])/g, "$1");
  return statement?.type === "Statement" && statement.background !== true
    && Array.isArray(statement.redirects) && statement.redirects.length === 0
    && command?.type === "Command" && Array.isArray(command.prefix) && command.prefix.length === 0
    && Array.isArray(command.redirects) && command.redirects.length === 0
    && typeof command.name?.value === "string" && command.name.value.includes("/")
    && Array.isArray(command.suffix) && command.suffix.length > 0 && command.suffix.every(isLiteralShellWord)
    && /^[^;&|<>$`\\]*[.!?]$/.test(prose) && /\s/.test(prose);
}
export function hasExecutableShellSemantics(text: string) {
  if (Buffer.byteLength(text, "utf8") > maximumContentPolicyTextBytes || !isJavaScriptRawInputWithinBounds(text)) return true;
  let root: RecordLike;
  try { root = parseShell(text) as RecordLike; }
  catch { return true; }
  const pending = [{ value: root, depth: 0 }]; const seen = new WeakSet<object>(); let visited = 0; let syntaxError = false; let firstErrorAt = Number.POSITIVE_INFINITY;
  try {
    while (pending.length > 0) {
      const { value, depth } = pending.pop()!;
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value); visited += 1;
      if (visited > maximumContentPolicyAstNodes || depth > maximumPythonContentPolicyAstDepth) return true;
      if (Array.isArray(value.errors) && value.errors.length > 0) {
        syntaxError = true;
        for (const error of value.errors) if (Number.isInteger(error?.pos) && error.pos >= 0) firstErrorAt = Math.min(firstErrorAt, error.pos);
      }
      const children = Object.values(value);
      if ("parts" in value) children.push(value.parts);
      if ("indexParts" in value) children.push(value.indexParts);
      for (const child of children) {
        if (Array.isArray(child)) for (const item of child) pending.push({ value: item, depth: depth + 1 });
        else pending.push({ value: child, depth: depth + 1 });
      }
    }
  } catch { return true; }
  // Parse every candidate before applying either narrow plain-text allowance.
  // Bash reserved words can form recovery/error trees when isolated, so also
  // compare an exact literal token with the complete pinned vocabulary.
  if (exactShellVocabularyToken(text)) return true;
  // Sentence punctuation does not make a parsed command inert. Resolve the
  // command word first while leaving slash-bearing arguments and URLs as prose.
  if (!syntaxError && Array.isArray(root.commands) && root.commands.some(hasRunnableParsedShellCommand)) return true;
  if (syntaxError && Array.isArray(root.commands) && root.commands.some((statement: RecordLike) => parsedShellStatementCompletedBeforeError(statement, firstErrorAt)
    && hasCompletedShellLineBoundary(text.slice(statement.end, firstErrorAt)) && parsedShellNodeHasRunnableCommand(statement))) return true;
  if (isSentenceShapedText(text) || (!syntaxError && isNonRunnablePathSentence(text, root))) return false;
  if (!Array.isArray(root.commands) || root.commands.length === 0) return false;
  if (!syntaxError) return root.commands.length !== 1 || !isPlainShellDatum(root.commands[0]);
  const hasRecoveredCommandBoundary = (suffix: string) => {
    for (let index = 0; index < suffix.length; index += 1) {
      if (suffix[index] === ";") return true;
      if (suffix[index] === "&" && suffix[index - 1] !== "&" && suffix[index - 1] !== "|" && suffix[index + 1] !== "&") return true;
    }
    return hasCompletedShellLineBoundary(suffix);
  };
  return root.commands.some((statement: RecordLike) => {
    if (!statement?.command || !parsedShellStatementCompletedBeforeError(statement, firstErrorAt)) return false;
    return !isPlainShellDatum(statement) && (statement.background === true || hasRecoveredCommandBoundary(text.slice(statement.end, firstErrorAt)));
  });
}
function safeUntrustedText(bytes: Buffer) {
  if (bytes.length > maximumContentPolicyTextBytes) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true }); let text = ""; try { text = decoder.decode(bytes); } catch { return false; }
  if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /<\s*(?:!doctype|\?xml|html\b|head\b|body\b|script\b|svg\b|[a-z][\w:-]*\s+[^>]*>)/i.test(text) || /<\s*([a-z][\w:-]*)\b[^>]*>[\s\S]*<\/\s*\1\s*>/i.test(text)) return false;
  // Acorn parses but never executes the upload. Whole-program parsing handles
  // comments, escapes, computed or parenthesized callees, and optional chains;
  // the iterative traversal fails closed at fixed node and depth budgets.
  if (hasExecutableJavaScriptSemantics(text) || hasExecutablePythonSemantics(text) || hasExecutableShellSemantics(text)) return false;
  return true;
}
async function contentPolicyOutcome(row: RecordLike, bytes: Buffer) {
  const name = String(row.name).toLowerCase(); const type = String(row.type).toLowerCase();
  if (bytes.length === 0 || /\.(zip|gz|rar|7z|tar|docx?|xlsx?|pptx?|exe|dmg|app|js|mjs|sh|bat|cmd|ps1|svg|html?|xml)$/i.test(name) || bytes.subarray(0, 2).toString("hex") === "4d5a" || bytes.subarray(0, 2).toString("hex") === "504b" || bytes.subarray(0, 6).toString("ascii") === "Rar!\x1a\x07" || bytes.subarray(0, 6).toString("ascii") === "7z\xbc\xaf\x27\x1c") return "rejected";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return validJpeg(bytes) && /\.(jpg|jpeg)$/.test(name) && type === "image/jpeg" ? "clean" : "rejected";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return validPng(bytes) && /\.png$/.test(name) && type === "image/png" ? "clean" : "rejected";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return await validatePdfIngress(bytes) && /\.pdf$/.test(name) && type === "application/pdf" ? "clean" : "rejected";
  return safeUntrustedText(bytes) && /\.txt$/.test(name) && type === "text/plain" ? "clean" : "rejected";
}
export function isCurrentClamavSignature(signature: RecordLike | null, now = Date.now()) { const builtAt = Date.parse(signature?.updatedAt); return Boolean(signature) && typeof signature?.version === "string" && /^daily:\d{1,12}$/.test(signature.version) && Number.isFinite(builtAt) && builtAt <= now && now - builtAt <= 24 * 60 * 60 * 1000; }
export function collectBoundedToolOutput(child: any, timeoutMs: number, maximumBytes = 8192) { return new Promise<{ ok: boolean; stdout: string }>((resolve) => { let settled = false; let stdout = Buffer.alloc(0); let exitCode: number | null | undefined; let stdoutEnded = !child.stdout; const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, stdout: stdout.toString("utf8") }); }; const completed = () => { if (exitCode !== undefined && stdoutEnded) finish(exitCode === 0); }; const timer = setTimeout(() => finish(false), timeoutMs); child.stdout?.on?.("data", (chunk: Buffer) => { if (stdout.length + chunk.length > maximumBytes) return finish(false); stdout = Buffer.concat([stdout, chunk]); }); child.stdout?.once?.("end", () => { stdoutEnded = true; completed(); }); child.once("exit", (code: number | null) => { exitCode = code; completed(); }); child.once("close", (code: number | null) => finish(code === 0)); child.once("error", () => finish(false)); }); }
function clamavNow(database: RecordLike) { return database.__clamavTest?.now?.() ?? Date.now(); }
function clamavDelay(database: RecordLike, timeoutMs: number) { return database.__clamavTest?.delay?.(timeoutMs) ?? new Promise((resolve) => setTimeout(resolve, timeoutMs)); }
function clamavRemaining(database: RecordLike, deadline: number) { return Math.max(0, deadline - clamavNow(database)); }
async function verifiedClamavSignature(database: RecordLike, deadline = Number.POSITIVE_INFINITY) {
  if (database.__clamavTest?.signature) return database.__clamavTest.signature;
  const sidecar = database.__clamavDevSidecar;
  for (const path of ["/app/data/clamav/daily.cld", "/app/data/clamav/daily.cvd"]) {
    if (!sidecar && !fs.existsSync(path)) continue;
    const remaining = clamavRemaining(database, deadline); if (remaining <= 0) return null;
    const child = sidecar
      ? childProcess.spawn("docker", ["exec", sidecar.containerName, "/usr/bin/sigtool", "--info", path], { stdio: ["ignore", "pipe", "ignore"] })
      : childProcess.spawn("/usr/bin/sigtool", ["--info", path], { stdio: ["ignore", "pipe", "ignore"] });
    const result = await collectBoundedToolOutput(child, Math.min(5_000, remaining)); if (!result.ok) { await terminateChild(child, Math.min(clamavTerminateTimeout(database), clamavRemaining(database, deadline)), database); continue; }
    const version = /^Version:\s*(\d{1,12})\s*$/mi.exec(result.stdout)?.[1]; const built = /^Build time:\s*(.{1,80})\s*$/mi.exec(result.stdout)?.[1]; const verified = /^Verification(?:\s*:)?\s*OK\.?\s*$/mi.test(result.stdout); const builtAt = built ? new Date(built.replace(/ (\d{2})-(\d{2}) /, " $1:$2 ")) : null;
    if (verified && version && builtAt && Number.isFinite(builtAt.getTime())) return { version: `daily:${version}`, updatedAt: builtAt.toISOString() };
  }
  return null;
}
function clamavSocketCommand(database: RecordLike, command: Buffer, maximumReplyBytes = 4096, timeoutMs = 2_000) {
  if (database.__clamavTest?.socketCommand) return database.__clamavTest.socketCommand(command, timeoutMs, maximumReplyBytes);
  const socketPath = database.__clamavTest?.socketPath ?? database.__clamavDevSidecar?.socketPath ?? "/tmp/sporades-clamd.sock";
  return new Promise<string | null>((resolve) => {
    let settled = false; let response = Buffer.alloc(0); const socket = net.createConnection({ path: socketPath });
    const finish = (value: string | null) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("connect", () => socket.write(command));
    socket.on("data", (chunk: Buffer) => { if (response.length + chunk.length > maximumReplyBytes) return finish(null); response = Buffer.concat([response, chunk]); if (response.includes(0)) finish(response.subarray(0, response.indexOf(0)).toString("utf8")); });
    socket.once("error", () => finish(null)); socket.once("end", () => { if (!settled) finish(null); });
  });
}
async function loadedClamavSignatureVersion(database: RecordLike, timeoutMs = 500) {
  if (typeof database.__clamavTest?.loadedSignature === "string") return /^daily:\d{1,12}$/.test(database.__clamavTest.loadedSignature) ? database.__clamavTest.loadedSignature : null;
  const versionReply = await clamavSocketCommand(database, Buffer.from("zVERSION\0"), 512, Math.max(1, Math.min(500, timeoutMs)));
  const loadedVersion = /^ClamAV\s+[^/]{1,64}\/(\d{1,12})\//.exec(versionReply ?? "")?.[1];
  return loadedVersion ? `daily:${loadedVersion}` : null;
}
async function clamavInstream(database: RecordLike, bytes: Buffer, requestSignature?: RecordLike | null) {
  // A multipart request is one admission unit. Resolving the authenticated
  // disk/daemon identity for each part lets freshclam's atomic publication
  // window turn an otherwise healthy later part into "unavailable". Capture
  // the exact ready identity once at request admission; every part still has
  // its own bounded INSTREAM verdict, so a dead socket or malware never gets
  // promoted by this cache.
  const signature = requestSignature === undefined ? await currentLoadedClamavSignature(database) : requestSignature;
  if (!signature) return { outcome: "inconclusive", signatureVersion: "unavailable" };
  if (bytes.length > clamavMaximumStreamBytes) return { outcome: "inconclusive", signatureVersion: String(signature.version).slice(0, 128) };
  const socketPath = database.__clamavTest?.socketPath ?? database.__clamavDevSidecar?.socketPath ?? "/tmp/sporades-clamd.sock"; const timeoutMs = database.__clamavTest?.timeoutMs ?? 10_000;
  const scanned = await new Promise<RecordLike>((resolve) => {
    let settled = false; let response = Buffer.alloc(0); const socket = net.createConnection({ path: socketPath });
    const finish = (outcome: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve({ outcome, signatureVersion: String(signature.version).slice(0, 128) }); };
    const timer = setTimeout(() => finish("inconclusive"), timeoutMs);
    socket.once("connect", () => { socket.write(Buffer.from("zINSTREAM\0")); for (let offset = 0; offset < bytes.length; offset += 64 * 1024) { const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024)); const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length); socket.write(length); socket.write(chunk); } socket.write(Buffer.alloc(4)); });
    socket.on("data", (chunk: Buffer) => { if (response.length + chunk.length > 4096) return finish("inconclusive"); response = Buffer.concat([response, chunk]); if (response.includes(0)) { const text = response.subarray(0, response.indexOf(0)).toString("utf8"); if (/^stream: OK$/.test(text)) finish("clean"); else if (/^stream: .+ FOUND$/.test(text)) finish("rejected"); else finish("inconclusive"); } });
    socket.once("error", () => finish("inconclusive")); socket.once("end", () => { if (!settled) finish("inconclusive"); });
  });
  if (scanned.outcome !== "clean" && scanned.outcome !== "rejected") return scanned;
  // The admission snapshot is evidence only while the daemon which performed
  // this scan still reports that exact loaded database. A reload between two
  // parts therefore fails closed rather than relabelling a later verdict with
  // an earlier signature; ordinary on-disk freshclam publication alone does
  // not disturb a healthy daemon's request identity.
  const loadedSignature = await loadedClamavSignatureVersion(database);
  const signatureFresh = isCurrentClamavSignature(signature, clamavNow(database));
  // A positive malware verdict is irreversible evidence from the scanner. A
  // later identity change cannot make it clean or merely inconclusive; retain
  // rejection while withholding a version we can no longer authenticate.
  if (scanned.outcome === "rejected") return signatureFresh && loadedSignature === signature.version ? scanned : { outcome: "rejected", signatureVersion: "unavailable" };
  return signatureFresh && loadedSignature === signature.version ? scanned : { outcome: "inconclusive", signatureVersion: signatureFresh ? String(loadedSignature ?? "unavailable").slice(0, 128) : "unavailable" };
}
function waitForChild(child: any, timeoutMs: number) { if (clamavChildTerminated(child)) return Promise.resolve(child?.exitCode === 0); return new Promise<boolean>((resolve) => { let settled = false; const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); }; const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs)); child.once("exit", (code: number) => finish(code === 0)); child.once("error", () => finish(false)); }); }
function signalChildUntil(database: RecordLike, child: any, signal: string, deadline: number) {
  if (clamavChildTerminated(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => { child.removeListener?.("exit", onExit); child.removeListener?.("close", onClose); child.removeListener?.("error", onError); };
    const finish = (value: boolean) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); remove(); resolve(value || clamavChildTerminated(child)); };
    const fail = (error: unknown) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); remove(); reject(error); };
    const onExit = () => { child.__sporadesClamavTerminated = true; finish(true); };
    const onClose = () => { child.__sporadesClamavTerminated = true; finish(true); };
    const onError = () => finish(false);
    child.once("exit", onExit); child.once("close", onClose); child.once("error", onError);
    try { child.kill(signal); } catch (error) { if (clamavChildTerminated(child)) finish(true); else fail(error); return; }
    if (settled || clamavChildTerminated(child)) { finish(true); return; }
    const remaining = clamavRemaining(database, deadline); if (remaining <= 0) { finish(false); return; }
    if (database.__clamavTest?.delay) Promise.resolve(database.__clamavTest.delay(remaining)).then(() => finish(false), fail);
    else timer = setTimeout(() => finish(false), remaining);
  });
}
async function terminateChild(child: any, timeoutMs = 5_000, database: RecordLike = {}) {
  if (!child || clamavChildTerminated(child)) return;
  const startedAt = clamavNow(database); const deadline = startedAt + Math.max(0, timeoutMs); const termDeadline = startedAt + Math.floor(Math.max(0, timeoutMs) / 2);
  if (await signalChildUntil(database, child, "SIGTERM", termDeadline)) return;
  if (await signalChildUntil(database, child, "SIGKILL", deadline)) return;
  throw Object.assign(new Error("ClamAV child did not terminate after SIGKILL."), { code: "CLAMAV_CHILD_TERMINATION_FAILED" });
}
function clamavTerminateTimeout(database: RecordLike) { return database.__clamavTest?.terminateTimeoutMs ?? 5_000; }
function unobserveClamavChild(database: RecordLike, child: any) {
  const observers: Map<RecordLike, RecordLike> | undefined = child?.__sporadesClamavObservers; const observer = observers?.get(database); if (!observer) return;
  child.removeListener?.("exit", observer.terminated); child.removeListener?.("close", observer.terminated); child.removeListener?.("error", observer.failed); observers?.delete(database);
  if (observers?.size === 0) delete child.__sporadesClamavObservers;
}
function observeClamavChild(database: RecordLike, child: any) {
  if (!child) return;
  const observers: Map<RecordLike, RecordLike> = child.__sporadesClamavObservers ?? new Map(); child.__sporadesClamavObservers = observers; if (observers.has(database)) return;
  const terminated = () => { child.__sporadesClamavTerminated = true; database.clamavReady = false; unobserveClamavChild(database, child); };
  const failed = () => { database.clamavReady = false; };
  observers.set(database, { terminated, failed }); child.once?.("exit", terminated); child.once?.("close", terminated); (child.on ?? child.once)?.call(child, "error", failed);
}
function clamavChildTerminated(child: any) { return Boolean(child) && (child.exitCode !== null || child.signalCode != null || child.__sporadesClamavTerminated === true); }
async function currentLoadedClamavSignature(database: RecordLike, deadline = Number.POSITIVE_INFINITY) {
  const signature = await verifiedClamavSignature(database, deadline); if (!isCurrentClamavSignature(signature, clamavNow(database))) return null;
  if (database.__clamavTest?.loadedSignature) return database.__clamavTest.loadedSignature === signature.version ? signature : null;
  const remaining = clamavRemaining(database, deadline); if (remaining <= 0) return null;
  const loadedSignature = await loadedClamavSignatureVersion(database, Math.min(500, remaining));
  return loadedSignature === signature.version ? signature : null;
}
async function probeClamavReadiness(database: RecordLike, deadline: number) {
  const remaining = clamavRemaining(database, deadline); if (remaining <= 0) return false;
  if (database.__clamavTest?.readinessProbe) return Boolean(await database.__clamavTest.readinessProbe(remaining));
  const current = await currentLoadedClamavSignature(database, deadline); if (!current) return false;
  const afterSignature = clamavRemaining(database, deadline); if (afterSignature <= 0) return false;
  return await clamavSocketCommand(database, Buffer.from("zPING\0"), 16, Math.min(500, afterSignature)) === "PONG";
}
export async function waitForClamavReadiness(database: RecordLike, child: any, deadline: number, socketPath?: string) {
  while (clamavRemaining(database, deadline) > 0) {
    if (clamavChildTerminated(child)) return false;
    const exists = database.__clamavTest?.socketExists?.(socketPath) ?? fs.existsSync(socketPath ?? database.__clamavDevSidecar?.socketPath ?? "/tmp/sporades-clamd.sock");
    if (exists && await probeClamavReadiness(database, deadline) && clamavRemaining(database, deadline) > 0) return true;
    const remaining = clamavRemaining(database, deadline); if (remaining <= 0) return false;
    await clamavDelay(database, Math.min(100, remaining));
  }
  return false;
}
async function stopOwnedClamavChildren(database: RecordLike) {
  const owned = [["__clamavProcess", database.__clamavProcess], ["__clamavUpdateProcess", database.__clamavUpdateProcess]].filter(([, child]) => child);
  const results = await Promise.allSettled(owned.map(([, child]) => terminateChild(child, clamavTerminateTimeout(database), database))); const failures: unknown[] = [];
  results.forEach((result, index) => { const [key, child] = owned[index]; if (result.status === "fulfilled") { unobserveClamavChild(database, child); if (database[key] === child) database[key] = null; } else failures.push(result.reason); });
  if (failures.length) throw new AggregateError(failures, "ClamAV child cleanup failed.");
}
export async function initializeClamavRuntime(database: RecordLike) {
  const required = database.endpoints?.some((endpoint: RecordLike) => endpoint?.options?.body?.multipart?.inspection?.requiredInspectors?.includes("clamav")); database.clamavRequired = Boolean(required); database.clamavReady = !required;
  if (!required) return true;
  const deadline = clamavNow(database) + (database.__clamavTest?.startupTimeoutMs ?? 120_000);
  if (database.__clamavDevSidecar) {
    observeClamavChild(database, database.__clamavDevSidecar.process);
    database.clamavReady = await waitForClamavReadiness(database, database.__clamavDevSidecar.process, deadline, database.__clamavDevSidecar.socketPath); return database.clamavReady;
  }
  if (database.__clamavTest) { database.clamavReady = Boolean(await currentLoadedClamavSignature(database, deadline)); return database.clamavReady; }
  if (process.env.SPORADES_CLAMAV_MANAGED !== "1") return false;
  try { fs.mkdirSync("/app/data/clamav", { recursive: true }); fs.mkdirSync("/tmp/sporades-clamav", { recursive: true }); } catch { return false; }
  if (clamavRemaining(database, deadline) <= 0) return false;
  const update = childProcess.spawn("/usr/bin/freshclam", ["--config-file=/etc/clamav/freshclam.conf"], { stdio: "ignore" }); database.__clamavUpdateProcess = update; const updateCompleted = await waitForChild(update, clamavRemaining(database, deadline)); if (!updateCompleted) await terminateChild(update, Math.min(clamavTerminateTimeout(database), clamavRemaining(database, deadline)), database); database.__clamavUpdateProcess = null; const signature = await verifiedClamavSignature(database, deadline); if (!isCurrentClamavSignature(signature, clamavNow(database))) return false;
  if (clamavRemaining(database, deadline) <= 0) return false;
  const daemon = childProcess.spawn("/usr/sbin/clamd", ["--foreground", "--config-file=/etc/clamav/clamd.conf"], { stdio: "ignore" }); database.__clamavProcess = daemon;
  observeClamavChild(database, daemon);
  if (await waitForClamavReadiness(database, daemon, deadline, "/tmp/sporades-clamd.sock")) { database.clamavReady = true; const updater = childProcess.spawn("/usr/bin/freshclam", ["--daemon", "--foreground=true", "--config-file=/etc/clamav/freshclam.conf"], { stdio: "ignore" }); database.__clamavUpdateProcess = updater; observeClamavChild(database, updater); return true; }
  await stopOwnedClamavChildren(database); return false;
}
export async function shutdownClamavRuntime(database: RecordLike) { database.clamavReady = false; if (!database.__clamavDevSidecar?.externallyManaged) await stopOwnedClamavChildren(database); else { unobserveClamavChild(database, database.__clamavDevSidecar.process); database.__clamavProcess = null; database.__clamavUpdateProcess = null; } }
export async function checkClamavRuntime(database: RecordLike) { if (!database.clamavRequired) return { ok: true }; const children = [database.__clamavDevSidecar?.process, database.__clamavProcess, database.__clamavUpdateProcess]; for (const child of children) observeClamavChild(database, child); if (children.some(clamavChildTerminated)) { database.clamavReady = false; return { ok: false }; } const current = await currentLoadedClamavSignature(database); const pong = current ? await clamavSocketCommand(database, Buffer.from("zPING\0"), 16, 500) : null; database.clamavReady = pong === "PONG"; return { ok: database.clamavReady }; }
async function inspectIngressLease(database: RecordLike, policy: RecordLike | null, row: RecordLike, bytes: Buffer, clamavRequestSignature?: RecordLike | null) {
  if (!policy) return undefined;
  const verdicts = await Promise.all(policy.requiredInspectors.map(async (inspector: string) => { const result = inspector === "content-policy-v1" ? { outcome: await contentPolicyOutcome(row, bytes), signatureVersion: "content-policy-v1" } : await clamavInstream(database, bytes, clamavRequestSignature); const inspectedAt = ingressAuditNow(database); return Object.freeze({ inspector, outcome: result.outcome, leaseId: row.leaseId, size: row.size, digest: row.digest, version: row.version, policyRevision: policy.policyRevision, engine: inspector === "content-policy-v1" ? "sporades-content-policy" : "clamav", signatureVersion: result.signatureVersion, inspectedAt }); }));
  return Object.freeze({ policyRevision: policy.policyRevision, maxVerdictAgeMs: policy.maxVerdictAgeMs, verdicts: Object.freeze(verdicts) });
}
function inspectionEvidenceIsCurrent(database: RecordLike, row: RecordLike, policy: RecordLike | null) {
  if (!policy) return true;
  const inspection = row.inspection;
  if (!inspection || inspection.policyRevision !== policy.policyRevision || !Array.isArray(inspection.verdicts) || inspection.verdicts.length !== policy.requiredInspectors.length) return false;
  const now = Date.parse(ingressAuditNow(database));
  return policy.requiredInspectors.every((inspector: string) => {
    const verdict = inspection.verdicts.find((candidate: RecordLike) => candidate?.inspector === inspector);
    const inspectedAt = Date.parse(verdict?.inspectedAt);
    return verdict?.outcome === "clean" && verdict?.leaseId === row.leaseId && verdict?.size === row.size && verdict?.digest === row.digest && verdict?.version === row.version && verdict?.policyRevision === policy.policyRevision && typeof verdict?.engine === "string" && typeof verdict?.signatureVersion === "string" && Number.isFinite(inspectedAt) && inspectedAt <= now && now - inspectedAt <= policy.maxVerdictAgeMs;
  });
}
function framedIngressKey(parts: string[]) {
  const framed = parts.map((value) => { const bytes = Buffer.from(String(value), "utf8"); return `${bytes.length}:${bytes.toString("base64")}`; }).join("|");
  return `v2:${crypto.createHash("sha256").update(framed).digest("hex")}`;
}
function keyFor(endpoint: RecordLike, requestKey: string, partKey: string, actor: string) { return framedIngressKey([String(endpoint.options.method), String(endpoint.options.path), actor, requestKey, partKey]); }
function legacyDelimitedKeyFor(endpoint: RecordLike, requestKey: string, partKey: string, actor: string) { return `${endpoint.options.method}:${endpoint.options.path}:${actor}:${requestKey}:${partKey}`; }
function publicLease(row: RecordLike) { return Object.freeze({ leaseId: row.leaseId, partId: row.partId, fieldName: row.fieldName, name: row.name, type: row.type, declaredSize: null, size: row.size, expiresAt: row.expiresAt }); }
function idempotencyConflict(message = "Ingress claim conflicts with the completed request.") { return Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" }); }
function ingressAuthorityDenied() { return Object.assign(new Error("File ingress authority is unavailable."), { code: "INGRESS_AUTHORITY_DENIED" }); }
const ingressAuditCodes = new Set(["INVALID_MULTIPART", "MULTIPART_LIMIT_EXCEEDED", "INVALID_MULTIPART_REQUEST_KEY", "INVALID_MULTIPART_PART_KEY", "INGRESS_AUTHORITY_DENIED", "INGRESS_LEASE_EXPIRED", "INGRESS_PATH_DENIED", "INGRESS_DESCRIPTOR_CONFLICT", "INGRESS_STAGING_INCOMPLETE", "INGRESS_ORPHAN_CLEANUP_FAILED", "FILE_PATH_EXISTS"]);
async function emitIngressAudit(database: RecordLike, event: string, data: RecordLike) {
  try { await database.log?.emit?.({ category: "platform", event: `file.ingress.${event}`, level: event === "failed" || event === "cleanup-failed" ? "warn" : "info", message: "Multipart ingress lifecycle event", data: { schema: "v1", ...data } }); }
  catch { /* Auditing must not turn a bounded ingress outcome into a transport failure. */ }
}
function safeIngressAuditCode(error: any) { return ingressAuditCodes.has(error?.code) ? error.code : "INGRESS_FAILED"; }
function ingressClaimAuditId(row: RecordLike) {
  // Receipt keys are opaque already; hash again so no private storage identity
  // can accidentally become a future audit payload field.
  return `v1:${crypto.createHash("sha256").update(String(row.key), "utf8").digest("hex")}`;
}
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
  let pending = Buffer.alloc(0); let wire = 0; let state: "preamble" | "headers" | "body" | "separator" | "closing" = "preamble";
  let rawHeaders = ""; let pieces: Buffer[] = []; let size = 0; let partLimit = typeof maxPartBytes === "number" ? maxPartBytes : Math.max(maxPartBytes.file, maxPartBytes.field);
  for await (const source of request) {
    wire += source.byteLength; if (wire > maxWireBytes) throw Object.assign(new Error("Multipart body exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = Buffer.concat([pending, Buffer.from(source)]);
    while (true) {
      if (state === "preamble") { if (pending.length < boundary.length + 2) break; if (!pending.subarray(0, boundary.length).equals(boundary) || pending.subarray(boundary.length, boundary.length + 2).toString() !== "\r\n") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(boundary.length + 2); state = "headers"; continue; }
      if (state === "headers") { const headerEnd = pending.indexOf("\r\n\r\n"); if (headerEnd < 0) { if (pending.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" }); break; } rawHeaders = pending.subarray(0, headerEnd).toString("latin1"); if (typeof maxPartBytes !== "number") { const disposition = /^content-disposition:\s*form-data;\s*name="[^"]+"(?:;\s*filename="([^"]*)")?/im.exec(rawHeaders); partLimit = disposition?.[1] !== undefined ? maxPartBytes.file : maxPartBytes.field; } pending = pending.subarray(headerEnd + 4); pieces = []; size = 0; state = "body"; continue; }
      if (state === "body") { const at = pending.indexOf(marker); if (at < 0) { const take = Math.max(0, pending.length - marker.length + 1); if (take) { pieces.push(pending.subarray(0, take)); size += take; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(take); } break; } if (pending.length < at + marker.length + 2) { if (at) { pieces.push(pending.subarray(0, at)); size += at; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(at); } break; } const suffix = pending.subarray(at + marker.length, at + marker.length + 2).toString(); if (suffix !== "\r\n" && suffix !== "--") { const take = at + marker.length; pieces.push(pending.subarray(0, take)); size += take; if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(take); continue; } if (at) { pieces.push(pending.subarray(0, at)); size += at; } if (size > partLimit) throw Object.assign(new Error("Multipart part exceeds declared limits."), { code: "MULTIPART_LIMIT_EXCEEDED" }); pending = pending.subarray(at + marker.length); state = "separator"; continue; }
      if (state === "separator") { if (pending.length < 2) break;
        const separator = pending.subarray(0, 2).toString(); if (separator !== "\r\n" && separator !== "--") throw Object.assign(new Error("Malformed multipart request."), { code: "INVALID_MULTIPART" }); pending = pending.subarray(2); yield { rawHeaders, body: Buffer.concat(pieces, size) }; if (separator === "--") { state = "closing"; continue; } state = "headers"; continue;
      }
      if (pending.length === 0) break;
      if (pending.length === 1 && pending[0] === 13) break;
      if (pending.subarray(0, 2).toString() !== "\r\n") throw Object.assign(new Error("Malformed multipart closing delimiter."), { code: "INVALID_MULTIPART" });
      return;
    }
  }
  if ((state as string) === "closing" && pending.length === 0) return;
  throw Object.assign(new Error("Truncated multipart request."), { code: "INVALID_MULTIPART" });
}

/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export async function stageMultipartIngress(database: RecordLike, endpoint: RecordLike, request: any, endpointRequest: RecordLike, actor: RecordLike, admittedAuthority?: RecordLike) {
  let policy: RecordLike;
  try { policy = validateMultipartIngressPolicy(endpoint.options.body.multipart); }
  catch (error) { await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(error) }); throw error; }
  const contentType = String(endpointRequest.headers["content-type"] ?? "");
  const boundary = multipartBoundary(contentType);
  if (!boundary) { const error = Object.assign(new Error("Invalid multipart request."), { code: "INVALID_MULTIPART" }); await emitIngressAudit(database, "failed", { outcome: "failed", code: "INVALID_MULTIPART" }); throw error; }
  const requestKey = header(endpointRequest.headers, policy.requestKeyHeader);
  if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 200) { const error = Object.assign(new Error("Missing multipart idempotency key."), { code: "INVALID_MULTIPART_REQUEST_KEY" }); await emitIngressAudit(database, "failed", { outcome: "failed", code: "INVALID_MULTIPART_REQUEST_KEY" }); throw error; }
  await emitIngressAudit(database, "started", { outcome: "started" });
  // Do not re-query signature state for each ordered part. This is deliberately
  // not a retry: an unavailable identity stays unavailable for this request;
  // the next request performs a fresh authenticated readiness check.
  const clamavRequestSignature = policy.inspection?.requiredInspectors?.includes("clamav") ? await currentLoadedClamavSignature(database) : undefined;
  const maxBytes = Number(policy.maxTotalFileBytes) + Number(policy.maxTotalFieldBytes) + 65536;
  const files: any[] = []; const fields: RecordLike = Object.create(null); let fieldCount = 0; let fieldBytes = 0; let fileBytes = 0; const partKeys = new Set<string>(); const wonReceipts: RecordLike[] = [];
  const streamingFileLimit = Math.min(Number(policy.maxFileBytes), Number(database.fileMaxSizeBytes));
  try { for await (const part of multipartParts(request, boundary, maxBytes, { file: streamingFileLimit, field: policy.maxFieldBytes })) {
    const rawHeaders = part.rawHeaders; const body = part.body;
    if (rawHeaders.length > 16384) throw Object.assign(new Error("Multipart headers exceed limit."), { code: "MULTIPART_LIMIT_EXCEEDED" });
    if (unsupportedMultipartPartEncoding(rawHeaders)) throw Object.assign(new Error("Unsupported multipart part encoding."), { code: "INVALID_MULTIPART" });
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
    if (!sameIngressRetryDescriptor(row, candidate)) throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
    if (!acquired.winner && row.state === "staging") row = await awaitCompletedStagingReceipt(database, row.key);
    if (!row || !sameIngressRetryDescriptor(row, candidate)) throw Object.assign(new Error("Multipart retry descriptor conflicts with the original part."), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
    if ((acquired.winner && row.state !== "staging") || (!acquired.winner && row.state !== "leased" && row.state !== "complete")) throw Object.assign(new Error("Multipart ingress staging did not complete."), { code: "INGRESS_STAGING_INCOMPLETE" });
    const inspection = await inspectIngressLease(database, policy.inspection, row, body, clamavRequestSignature);
    if (inspection) {
      if (acquired.winner) Object.assign(row, { inspection });
      else row = await refreshReceiptInspection(database, row, inspection);
    }
    // A retry follows the durable CAS winner, never its caller-local scan. Leased
    // receipts are read and checked again by claim(), closing the later refresh race.
    if (row.state === "complete" && !inspectionEvidenceIsCurrent(database, row, policy.inspection)) throw inspectionRequiredError();
    if (acquired.winner) {
      wonReceipts.push(row);
      await database.fileStorage.writeFileVersion({ fileId: row.fileId, version: row.version, bytes: body });
      const published = await publishStagedReceipt(database, row);
      if (published) row = published;
      else {
        const current = await receipt(database, row.key);
        if (current?.state === "complete" && current.leaseId === row.leaseId) row = current;
        else {
          const primary = Object.assign(new Error("Multipart ingress staging lost its publication lease."), { code: "INGRESS_STAGING_INCOMPLETE" });
          try { await database.fileStorage.deleteFileVersion({ fileId: row.fileId, version: row.version }); }
          catch (cleanup) { throw new AggregateError([primary, cleanup], "Multipart ingress staging lost publication and object cleanup failed."); }
          throw primary;
        }
      }
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
    if (cleanupErrors.length) { await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(primaryError) }); throw new AggregateError([primaryError, ...cleanupErrors], "Multipart ingress staging failed and cleanup was incomplete."); }
    await emitIngressAudit(database, "failed", { outcome: "failed", code: safeIngressAuditCode(primaryError) });
    throw primaryError;
  }
  await emitIngressAudit(database, "completed", { outcome: "leased" });
  return { body: null, bodyBytes: Object.freeze({ byteLength: 0, length: 0, at() { return undefined; }, toUint8Array() { return new Uint8Array(); }, *[Symbol.iterator]() {} }), multipart: Object.freeze({ files: Object.freeze(files), fields: Object.freeze(fields) }), __ingressRequestKey: requestKey, __ingressAuthority: admittedAuthority ?? Object.freeze({ kind: "actor", actorId: String(actor.userId ?? ""), ownerId: String(actor.userId ?? "") }) };
}

export function validateMultipartIngressPolicy(policy: RecordLike) {
  const invalid = () => { throw Object.assign(new Error("Invalid multipart ingress policy."), { code: "INVALID_MULTIPART_POLICY" }); };
  const validPathPrefix = (value: any) => { try { return typeof value === "string" && normalizeAbsoluteFilePath(value) === value; } catch { return false; } };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) invalid();
  for (const name of ["maxFiles", "maxFileBytes", "maxTotalFileBytes"]) if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] <= 0) invalid();
  for (const name of ["maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes"]) if (typeof policy[name] !== "number" || !Number.isFinite(policy[name]) || !Number.isInteger(policy[name]) || policy[name] < 0) invalid();
  const allowedKeys = new Set(["maxFiles", "maxFileBytes", "maxTotalFileBytes", "maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes", "allowedPathPrefixes", "allowedMimeTypes", "requestKeyHeader", "partKeyHeader", "requireStablePartKeys", "claimAuthorities", "inspection", "admit"]);
  if (Object.keys(policy).some((key) => !allowedKeys.has(key))) invalid();
  if (!Array.isArray(policy.allowedPathPrefixes) || policy.allowedPathPrefixes.length === 0 || policy.allowedPathPrefixes.some((value: any) => !validPathPrefix(value))) invalid();
  if (policy.allowedMimeTypes !== undefined && (!Array.isArray(policy.allowedMimeTypes) || policy.allowedMimeTypes.some((value: any) => typeof value !== "string" || safeType(value) !== value.toLowerCase()))) invalid();
  for (const name of ["requestKeyHeader", "partKeyHeader"]) if (typeof policy[name] !== "string" || policy[name].length > 100 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(policy[name])) invalid();
  if (policy.requireStablePartKeys !== undefined && typeof policy.requireStablePartKeys !== "boolean") invalid();
  if (policy.claimAuthorities !== undefined && (!Array.isArray(policy.claimAuthorities) || policy.claimAuthorities.length !== 1 || !["actor", "capsule-principal"].includes(policy.claimAuthorities[0]))) invalid();
  if (policy.admit !== undefined && typeof policy.admit !== "function") invalid();
  if (policy.admit !== undefined && policy.claimAuthorities?.[0] === "capsule-principal") invalid();
  const inspection = normalizedInspectionPolicy(policy.inspection);
  return inspection ? { ...policy, inspection } : policy;
}

export function createEndpointIngressApi(database: RecordLike, endpoint: RecordLike, endpointRequest: RecordLike, context: RecordLike) {
  // Runtime-owned provider callbacks predate Capsule endpoint options and do
  // not declare multipart ingress. Keep their ordinary endpoint context
  // available without requiring a synthetic declaration object.
  const policy = endpoint.options?.body?.multipart;
  const unavailable = () => { throw Object.assign(new Error("File ingress was not declared for this endpoint."), { code: "FILE_INGRESS_UNAVAILABLE" }); };
  if (!policy) return { claim: unavailable, inspection: unavailable, status: unavailable };
  const inspectionPolicy = normalizedInspectionPolicy(policy.inspection);
  const actorId = String(context.auth?.userId ?? ""); const requestKey = endpointRequest.__ingressRequestKey; const admittedAuthority = endpointRequest.__ingressAuthority ?? { kind: "actor", actorId, ownerId: actorId };
  return {
    async claim(lease: RecordLike, options: RecordLike) {
      try {
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
      // Inspector evidence is bound to the staged descriptor as well as its bytes.
      // An inspected claim may repeat that descriptor, but it cannot relabel the
      // ordinary File after content-policy has made a name/type-sensitive decision.
      if (inspectionPolicy && (name !== row.name || type !== row.type)) throw inspectionRequiredError();
      const expectedFile = { id: row.fileId, ownerId: row.ownerId, path, name, type, size: row.size, version: row.version };
      if (row.state === "complete") {
        if (!sameFileDescriptor(row.file, expectedFile)) throw idempotencyConflict();
        if (!inspectionEvidenceIsCurrent(database, row, inspectionPolicy)) throw inspectionRequiredError();
        return fileMetadataFromRow(row.file);
      }
      if (row.state === "expired" || Date.parse(row.expiresAt) <= Date.now()) throw Object.assign(new Error("File ingress lease has expired."), { code: "INGRESS_LEASE_EXPIRED" });
      if (!inspectionEvidenceIsCurrent(database, row, inspectionPolicy)) throw inspectionRequiredError();
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
      // This transaction-scoped write is not coupled to a context object:
      // Capsule middleware may clone contexts before the handler receives one.
      await database.adapter.enqueueIngressClaimAudit({ claimId: ingressClaimAuditId(completed), createdAt: now });
      return fileMetadataFromRow(storedFile);
      } catch (error: any) {
        const code = safeIngressAuditCode(error);
        await emitIngressAudit(database, code === "INGRESS_AUTHORITY_DENIED" || code === "INGRESS_PATH_DENIED" ? "denied" : "failed", { outcome: code === "INGRESS_AUTHORITY_DENIED" || code === "INGRESS_PATH_DENIED" ? "denied" : "failed", code });
        throw error;
      }
    },
    async inspection(lease: RecordLike) {
      const row = await receiptByLease(database, lease?.leaseId);
      const allowed = admittedAuthority.kind === "capsule-principal"
        ? row?.authorityKind === "capsule-principal" && row.authorityId === `capsule:${admittedAuthority.namespace}:${admittedAuthority.keyDigest}` && row.ownerId === admittedAuthority.ownerId
        : row?.authorityKind === "actor" && row.ownerId === actorId;
      if (!allowed || row.endpointMethod !== String(endpoint.options.method) || row.endpointPath !== String(endpoint.options.path) || row.leaseId !== lease?.leaseId) throw ingressAuthorityDenied();
      if (!row.inspection) return null;
      return Object.freeze({ policyRevision: row.inspection.policyRevision, verdicts: Object.freeze(row.inspection.verdicts.map((verdict: RecordLike) => Object.freeze({ inspector: verdict.inspector, outcome: verdict.outcome, digest: verdict.digest, size: verdict.size, version: verdict.version, engine: verdict.engine, signatureVersion: verdict.signatureVersion, inspectedAt: verdict.inspectedAt }))) });
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

/** Reset an interrupted delivery lease at startup; ordinary drains never steal live work. */
export async function recoverIngressClaimAuditOutbox(database: RecordLike) {
  try {
    await database.adapter.recoverIngressClaimAudits(ingressAuditNow(database));
    return true;
  } catch {
    try { await database.log?.emit?.({ category: "platform", event: "file.ingress.audit-recovery-failed", level: "warn", message: "Multipart ingress audit recovery failed", data: { schema: "v1", outcome: "failed", code: "INGRESS_AUDIT_RECOVERY_FAILED" } }); } catch {}
    return false;
  }
}

/** Emit the fixed public audit only after its transaction has committed. */
export async function drainIngressClaimAuditOutbox(database: RecordLike, options: RecordLike = {}) {
  const limit = Math.max(1, Math.min(100, Number.isInteger(options.limit) ? options.limit : 50));
  let pending: RecordLike[];
  try { pending = await database.adapter.selectPendingIngressClaimAudits(limit); } catch { return; }
  for (const candidate of pending) {
    const claimId = String(candidate.claimId ?? ""); if (!claimId) continue;
    const claimToken = crypto.randomUUID();
    try {
      const claimed = await database.adapter.claimIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
      if (Number(claimed?.changes ?? 0) !== 1) continue;
      try {
        await database.log.emit({ category: "platform", event: "file.ingress.completed", level: "info", message: "Multipart ingress lifecycle event", data: { schema: "v1", outcome: "claimed", deliveryId: claimId } });
      } catch {
        await releaseIngressClaimAudit(database, claimId, claimToken, "INGRESS_AUDIT_RELEASE_FAILED");
        continue;
      }
      try {
        await database.adapter.deliverIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
      } catch {
        // The append may already be durable, so retry is deliberately
        // duplicate-tolerant. Return only this token-fenced lease to pending;
        // a concurrent drainer cannot reset another worker's claim.
        try {
          await releaseIngressClaimAudit(database, claimId, claimToken, "INGRESS_AUDIT_ACK_RELEASE_FAILED");
        } catch {
          // Startup recovery remains the final repair path. This marker is
          // observable without exposing the private delivery identity.
          try { await database.log.emit({ category: "platform", event: "file.ingress.audit-delivery-release-failed", level: "warn", message: "Multipart ingress audit delivery release failed", data: { schema: "v1", outcome: "failed", code: "INGRESS_AUDIT_ACK_RELEASE_FAILED" } }); } catch {}
        }
      }
    } catch {
      // A failed sink or adapter operation leaves private durable work pending.
    }
  }
  try {
    const cutoff = new Date(new Date(ingressAuditNow(database)).getTime() - ingressClaimAuditRetentionMs).toISOString();
    await database.adapter.pruneDeliveredIngressClaimAudits(cutoff, ingressClaimAuditPruneLimit);
  } catch { /* Retention is maintenance; the next bounded drain retries. */ }
}

async function releaseIngressClaimAudit(database: RecordLike, claimId: string, claimToken: string, code: string) {
  try {
    await database.adapter.releaseIngressClaimAudit(claimId, claimToken, ingressAuditNow(database));
    return true;
  } catch {
    // This exact claim remains delivering, so make the root maintenance loop
    // retry recovery while the runtime stays alive.
    (database.__rootDatabase ?? database).__ingressAuditRecoveryPending = true;
    try { await database.log?.emit?.({ category: "platform", event: "file.ingress.audit-delivery-release-failed", level: "warn", message: "Multipart ingress audit delivery release failed", data: { schema: "v1", outcome: "failed", code } }); } catch {}
    return false;
  }
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
  if (cleaned.length > 0) await emitIngressAudit(database, "completed", { outcome: "cleaned" });
  if (failures.length > 0) await emitIngressAudit(database, "cleanup-failed", { outcome: "failed", code: failures[0].code });
  return Object.freeze({ scanned: candidates.length, cleaned: Object.freeze(cleaned), failures: Object.freeze(failures) });
}
