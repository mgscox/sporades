import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { capsule, endpoint, requireAuth, String as StringField, table } from "../dist/server.js";
import { createControllableRuntimeClock, openDevDatabase, routeEndpoint, runEndpoint } from "../dist/server-runtime-source.js";
import { bash52CommandVocabulary, checkClamavRuntime, collectBoundedToolOutput, createEndpointIngressApi, hasExecutableJavaScriptSemantics, hasExecutablePythonSemantics, hasExecutableShellSemantics, initializeClamavRuntime, isCurrentClamavSignature, isJavaScriptParserInputWithinBounds, isJavaScriptRawInputWithinBounds, isSupportedInspectionNodeVersion, multipartParts, shutdownClamavRuntime, stageMultipartIngress, sweepExpiredFileIngress, validatePdfIngress, waitForClamavReadiness } from "../dist/file-ingress-runtime.js";
import { capsuleIngressAuthUserId } from "../dist/auth-runtime.js";
import { accessKeyVerifierDigest, createAccessKeySecret } from "../dist/access-keys-runtime.js";
import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";

function multipart(boundary, headers = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain', bytes = "hello") {
  return Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n${bytes}\r\n--${boundary}--`);
}
function multipartMany(boundary, parts) {
  return Buffer.from(parts.map(({ headers, body }) => `--${boundary}\r\n${headers}\r\n\r\n${body}\r\n`).join("") + `--${boundary}--`);
}
function multipartBinary(boundary, name, type, bytes) { return Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\nContent-ID: stable\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--`)]); }
function testCrc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const typeBytes = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data]))); return Buffer.concat([length, typeBytes, data, crc]); }
function minimalPng() { return PNG.sync.write({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }); }
function minimalJpeg() { return Buffer.from(jpeg.encode({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 90).data); }
function removeJpegSegments(bytes, marker) { let output = Buffer.from(bytes); while (true) { const at = output.indexOf(Buffer.from([0xff, marker])); if (at < 0) return output; const length = output.readUInt16BE(at + 2); output = Buffer.concat([output.subarray(0, at), output.subarray(at + 2 + length)]); } }
function breakJpegComponent(bytes) { const output = Buffer.from(bytes); const at = output.indexOf(Buffer.from([0xff, 0xda])); if (at >= 0) output[at + 5] = 99; return output; }
function pngChunks(bytes) { const chunks = []; for (let offset = 8; offset < bytes.length;) { const length = bytes.readUInt32BE(offset); const type = bytes.subarray(offset + 4, offset + 8).toString("ascii"); chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) }); offset += 12 + length; } return chunks; }
function rebuildPng(chunks) { return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), ...chunks.map(({ type, data }) => pngChunk(type, data))]); }
function minimalPdf() { const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = "%PDF-1.4\n"; const offsets = [0]; for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; } const xref = Buffer.byteLength(body); body += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body); }
function freshPdfDeadlineProbe(timeouts, wallClockMode) {
  const moduleUrl = new URL("../dist/file-ingress-runtime.js", import.meta.url).href;
  const script = `import { validatePdfIngress } from ${JSON.stringify(moduleUrl)};
const bytes = Buffer.from(${JSON.stringify(minimalPdf().toString("base64"))}, "base64");
const actualWallNow = Date.now;
const wallOrigin = actualWallNow();
let wallReads = 0;
Date.now = ${wallClockMode === "frozen" ? "() => wallOrigin" : wallClockMode === "backward" ? "() => wallOrigin - (++wallReads * 1_000_000_000)" : "() => wallOrigin + (++wallReads * 1_000_000_000)"};
let expiredHooks = 0;
const startedAt = performance.now();
const timeouts = ${JSON.stringify(timeouts)};
const results = await Promise.all(timeouts.map((timeoutMs) => validatePdfIngress(bytes, { timeoutMs, beforeOperatorList() { expiredHooks += 1; } })));
const elapsedMs = performance.now() - startedAt;
let retryHooks = 0;
const retry = await validatePdfIngress(bytes, { timeoutMs: 2000, beforeOperatorList() { retryHooks += 1; } });
console.log(JSON.stringify({ results, expiredHooks, elapsedMs, retry, retryHooks }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
function compactTrailerPdf(suffix = "") { return Buffer.from(minimalPdf().toString("latin1").replace("<</Size 5 /Root 1 0 R>>", `<</Size 5/Root 1 0 R${suffix}>>`), "latin1"); }
function classicPdfWithStreamLength(lengthToken, lengthObject = "4", content = "q\nQ\n", trailerExtra = "", streamExtra = "") { const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", `4 0 obj\n<</Length ${lengthToken}${streamExtra}>>\nstream\n${content}endstream\nendobj\n`, `5 0 obj\n${lengthObject}\nendobj\n`]; let body = "%PDF-1.5\n"; const offsets = [0]; for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; } const xref = Buffer.byteLength(body); body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 6 /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body); }
function futureRevisionStreamLength() { const base = classicPdfWithStreamLength("6 0 R"); const previousXref = Number(/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]); const objectOffset = base.length; const object = Buffer.from("6 0 obj\n4\nendobj\n"); const xrefOffset = objectOffset + object.length; return Buffer.concat([base, object, Buffer.from(`xref\n6 1\n${String(objectOffset).padStart(10, "0")} 00000 n \ntrailer\n<</Size 7 /Root 1 0 R /Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function classicPdfWithCatalogGeneration(generation) { const objects = [`1 ${generation} obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n`, "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = "%PDF-1.4\n"; const offsets = [0]; for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; } const xref = Buffer.byteLength(body); body += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((value, index) => `${String(value).padStart(10, "0")} ${String(index === 0 ? generation : 0).padStart(5, "0")} n \n`).join("")}trailer\n<</Size 5 /Root 1 ${generation} R>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body); }
function classicPdfWithInUseObjectZero() { const objects = ["0 0 obj\nnull\nendobj\n", "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = "%PDF-1.4\n"; const offsets = []; for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; } const xref = Buffer.byteLength(body); body += `xref\n0 5\n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body); }
function minimalPdfWithBinaryHeaderComment() { const base = minimalPdf(); const comment = Buffer.from([0x25, 0x80, 0x81, 0x82, 0x83, 0x0a]); const headerEnd = base.indexOf(0x0a) + 1; const shifted = Buffer.concat([base.subarray(0, headerEnd), comment, base.subarray(headerEnd)]).toString("latin1"); return Buffer.from(shifted.replace(/(\d{10})(?= 00000 n)/g, (value) => String(Number(value) + comment.length).padStart(10, "0")).replace(/startxref\n(\d+)/, (_all, value) => `startxref\n${Number(value) + comment.length}`), "latin1"); }
function incrementalPdfRevision(prefix = Buffer.alloc(0), object = Buffer.from("5 0 obj\n<</Producer (incremental update)>>\nendobj\n")) { const base = minimalPdf(); const previousXref = /startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]; const objectOffset = base.length + prefix.length; const xrefOffset = objectOffset + object.length; return Buffer.concat([base, prefix, object, Buffer.from(`xref\n5 1\n${String(objectOffset).padStart(10, "0")} 00000 n \ntrailer\n<</Size 6 /Root 1 0 R /Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function incrementalPdf() { return incrementalPdfRevision(); }
function xrefStreamPdf(filterStyle = false) { const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = Buffer.from("%PDF-1.5\n"); const offsets = [0]; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); } const xrefOffset = body.length; offsets.push(xrefOffset); const entries = Buffer.alloc(6 * 7); entries[5] = 0xff; entries[6] = 0xff; for (let index = 1; index < 6; index += 1) { const at = index * 7; entries[at] = 1; entries.writeUInt32BE(offsets[index], at + 1); } const stream = filterStyle ? deflateSync(entries) : entries; const filter = filterStyle === "array" ? " /Filter [/FlateDecode]" : filterStyle === "multiple" ? " /Filter [/FlateDecode /ASCIIHexDecode]" : filterStyle ? " /Filter /FlateDecode" : ""; return Buffer.concat([body, Buffer.from(`5 0 obj\n<</Type /XRef /Size 6 /Root 1 0 R /W [1 4 2]${filter} /Length ${stream.length}>>\nstream\n`), stream, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function xrefStreamPdfWithIndirectLength(options = {}) { const entries = Buffer.alloc(7 * 7); const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n", `5 0 obj\n${options.wrongType ? "(forty nine)" : entries.length}\nendobj\n`]; let body = Buffer.from("%PDF-1.5\n"); const offsets = [0]; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); } const xrefOffset = body.length; offsets.push(xrefOffset); entries[5] = 0xff; entries[6] = 0xff; for (let index = 1; index <= 6; index += 1) { const at = index * 7; entries[at] = 1; entries.writeUInt32BE(offsets[index], at + 1); } return Buffer.concat([body, Buffer.from(`6 0 obj\n<</Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length 5 ${options.wrongGeneration ? 1 : 0} R${options.encrypt ? " /Encrypt <</Filter /Standard>>" : ""}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function xrefStreamPdfWithCatalogGeneration(generation, objectZeroGeneration = 65535) { const objects = [`1 ${generation} obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n`, "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = Buffer.from("%PDF-1.5\n"); const offsets = [0]; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); } const xrefOffset = body.length; offsets.push(xrefOffset); const entries = Buffer.alloc(6 * 8); entries.writeUIntBE(objectZeroGeneration, 5, 3); for (let index = 1; index < 6; index += 1) { const at = index * 8; entries[at] = 1; entries.writeUInt32BE(offsets[index], at + 1); entries.writeUIntBE(index === 1 ? generation : 0, at + 5, 3); } return Buffer.concat([body, Buffer.from(`5 0 obj\n<</Type /XRef /Size 6 /Root 1 ${generation} R /W [1 4 3] /Length ${entries.length}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function xrefStreamPdfWithInUseObjectZero() { const objects = ["0 0 obj\nnull\nendobj\n", "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = Buffer.from("%PDF-1.5\n"); const offsets = []; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); } const xrefOffset = body.length; offsets.push(xrefOffset); const entries = Buffer.alloc(6 * 7); for (let index = 0; index < 6; index += 1) { const at = index * 7; entries[at] = 1; entries.writeUInt32BE(offsets[index], at + 1); } return Buffer.concat([body, Buffer.from(`5 0 obj\n<</Type /XRef /Size 6 /Root 1 0 R /W [1 4 2] /Length ${entries.length}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function xrefStreamPdfWithCompressedObject(options = {}) {
  const tableObject = options.tableObject ?? 6; const objectPayload = `${tableObject} 0 <</Producer (compressed evidence)>>`; const decodedObjectStream = Buffer.from(objectPayload); const objectStreamBytes = options.flate ? deflateSync(decodedObjectStream) : decodedObjectStream;
  const lengthToken = options.indirectLength ? "7 0 R" : objectStreamBytes.length; const objectStreamDictionary = options.ordinaryStream ? `/Length ${lengthToken}` : `/Type /ObjStm /N ${options.count ?? 1} /First ${options.first ?? String(tableObject).length + 3}${options.flate ? " /Filter /FlateDecode" : ""} /Length ${lengthToken}`;
  const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = Buffer.from("%PDF-1.5\n"); const offsets = [0]; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); }
  offsets.push(body.length); body = Buffer.concat([body, Buffer.from(`5 0 obj\n<<${objectStreamDictionary}>>\nstream\n`), objectStreamBytes, Buffer.from("\nendstream\nendobj\n")]);
  const selfObject = options.indirectLength ? 8 : 7; if (options.indirectLength) { offsets[7] = body.length; body = Buffer.concat([body, Buffer.from(`7 0 obj\n${objectStreamBytes.length}\nendobj\n`)]); }
  const xrefOffset = body.length; offsets[selfObject] = xrefOffset; const entries = Buffer.alloc((selfObject + 1) * 7); entries.writeUInt32BE(options.freeHead ?? 0, 1); entries[5] = 0xff; entries[6] = 0xff;
  for (let index = 1; index <= 5; index += 1) { const at = index * 7; entries[at] = 1; entries.writeUInt32BE(offsets[index], at + 1); }
  const compressedAt = 6 * 7; entries[compressedAt] = 2; entries.writeUInt32BE(options.container ?? 5, compressedAt + 1); entries.writeUInt16BE(options.index ?? 0, compressedAt + 5);
  if (options.indirectLength) { entries[7 * 7] = 1; entries.writeUInt32BE(offsets[7], 7 * 7 + 1); }
  const selfAt = selfObject * 7; entries[selfAt] = 1; entries.writeUInt32BE(xrefOffset, selfAt + 1);
  return Buffer.concat([body, Buffer.from(`${selfObject} 0 obj\n<</Type /XRef /Size ${selfObject + 1} /Root 1 0 R /W [1 4 2] /Length ${entries.length}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]);
}
function incrementallySupersededCompressedObject(free = false) {
  const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"];
  let body = Buffer.from("%PDF-1.5\n"); const offsets = [0];
  for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); }
  const memberSix = "<</Producer (historical six)>>"; const memberSeven = "<</Producer (current seven)>>"; const header = `6 0 7 ${Buffer.byteLength(memberSix)} `; const objectStream = Buffer.from(header + memberSix + memberSeven);
  offsets.push(body.length); body = Buffer.concat([body, Buffer.from(`5 0 obj\n<</Type /ObjStm /N 2 /First ${Buffer.byteLength(header)} /Length ${objectStream.length}>>\nstream\n`), objectStream, Buffer.from("\nendstream\nendobj\n")]);
  const baseXref = body.length; const entries = Buffer.alloc(9 * 7); entries[5] = 0xff; entries[6] = 0xff;
  for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) { const at = objectNumber * 7; entries[at] = 1; entries.writeUInt32BE(offsets[objectNumber], at + 1); }
  for (let objectNumber = 6; objectNumber <= 7; objectNumber += 1) { const at = objectNumber * 7; entries[at] = 2; entries.writeUInt32BE(5, at + 1); entries.writeUInt16BE(objectNumber - 6, at + 5); }
  entries[8 * 7] = 1; entries.writeUInt32BE(baseXref, 8 * 7 + 1);
  body = Buffer.concat([body, Buffer.from(`8 0 obj\n<</Type /XRef /Size 9 /Root 1 0 R /W [1 4 2] /Length ${entries.length}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${baseXref}\n%%EOF\n`)]);
  const replacement = free ? Buffer.alloc(0) : Buffer.from("6 0 obj\n<</Producer (replacement six)>>\nendobj\n"); const replacementOffset = body.length; const updateXref = replacementOffset + replacement.length;
  const update = free ? `xref\n0 1\n0000000006 65535 f \n6 1\n0000000000 00001 f \n` : `xref\n6 1\n${String(replacementOffset).padStart(10, "0")} 00000 n \n`;
  return Buffer.concat([body, replacement, Buffer.from(`${update}trailer\n<</Size 9 /Root 1 0 R /Prev ${baseXref}>>\nstartxref\n${updateXref}\n%%EOF\n`)]);
}
function classicPdfWithFreeChain({ head = 5, next = 0, includeFree = true } = {}) { const text = minimalPdf().toString("latin1"); const entries = [...text.matchAll(/\d{10} \d{5} [fn] \n/g)].map((match) => match[0]); const xref = /startxref\n(\d+)/.exec(text)[1]; const table = `xref\n0 ${includeFree ? 6 : 5}\n${String(head).padStart(10, "0")} 65535 f \n${entries.slice(1).join("")}${includeFree ? `${String(next).padStart(10, "0")} 00001 f \n` : ""}trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(text.replace(/xref\n[\s\S]*$/, table), "latin1"); }
function incrementallyRepairInvalidCompressedContainer() { const base = xrefStreamPdfWithCompressedObject({ container: 1 }); const previousXref = Number([...base.toString("latin1").matchAll(/startxref\n(\d+)\n%%EOF/g)].at(-1)[1]); const replacementOffset = base.length; const replacement = Buffer.from("6 0 obj\n<</Producer (replacement six)>>\nendobj\n"); const xrefOffset = replacementOffset + replacement.length; return Buffer.concat([base, replacement, Buffer.from(`xref\n6 1\n${String(replacementOffset).padStart(10, "0")} 00000 n \ntrailer\n<</Size 8 /Root 1 0 R /Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function incrementallyRepairInvalidFreeHead() { const base = xrefStreamPdfWithCompressedObject({ freeHead: 1 }); const previousXref = Number([...base.toString("latin1").matchAll(/startxref\n(\d+)\n%%EOF/g)].at(-1)[1]); const xrefOffset = base.length; return Buffer.concat([base, Buffer.from(`xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 8 /Root 1 0 R /Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function incrementallyReplaceHistoricalFreeEntry() { const base = classicPdfWithFreeChain(); const previousXref = Number([...base.toString("latin1").matchAll(/startxref\n(\d+)\n%%EOF/g)].at(-1)[1]); const replacementOffset = base.length; const replacement = Buffer.from("5 1 obj\n<</Producer (reused free object)>>\nendobj\n"); const xrefOffset = replacementOffset + replacement.length; return Buffer.concat([base, replacement, Buffer.from(`xref\n0 1\n0000000000 65535 f \n5 1\n${String(replacementOffset).padStart(10, "0")} 00001 n \ntrailer\n<</Size 6 /Root 1 0 R /Prev ${previousXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function hybridXrefPdf(interveningObject = false) { const objects = ["1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n", "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R>>\nendobj\n", "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n"]; let body = Buffer.from("%PDF-1.5\n"); const offsets = [0]; for (const object of objects) { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(object)]); } const streamOffset = body.length; const size = interveningObject ? 7 : 6; const entry = Buffer.alloc(7); entry[0] = 1; entry.writeUInt32BE(streamOffset, 1); body = Buffer.concat([body, Buffer.from(`5 0 obj\n<</Type /XRef /Size ${size} /Root 1 0 R /Index [5 1] /W [1 4 2] /Length 7>>\nstream\n`), entry, Buffer.from("\nendstream\nendobj\n")]); let interveningOffset; if (interveningObject) { interveningOffset = body.length; body = Buffer.concat([body, Buffer.from("6 0 obj\n<</Producer (between hybrid sections)>>\nendobj\n")]); } const xrefOffset = body.length; return Buffer.concat([body, Buffer.from(`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}${interveningObject ? `6 1\n${String(interveningOffset).padStart(10, "0")} 00000 n \n` : ""}trailer\n<</Size ${size} /Root 1 0 R /XRefStm ${streamOffset}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function outOfOrderClassicXrefPdf() { const text = minimalPdf().toString("latin1"); const match = /xref\n0 5\n((?:\d{10} \d{5} [fn] \n){5})trailer/.exec(text); const entries = match[1].match(/\d{10} \d{5} [fn] \n/g); return Buffer.from(text.replace(match[0], `xref\n3 2\n${entries.slice(3).join("")}0 3\n${entries.slice(0, 3).join("")}trailer`), "latin1"); }
function incrementalHybridXrefPdf() { const base = minimalPdf(); const previousXref = Number(/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]); let body = Buffer.from(base); const objectOffset = body.length; body = Buffer.concat([body, Buffer.from("5 0 obj\n<</Producer (hybrid update)>>\nendobj\n")]); const streamOffset = body.length; const streamEntry = Buffer.alloc(7); streamEntry[0] = 1; streamEntry.writeUInt32BE(streamOffset, 1); body = Buffer.concat([body, Buffer.from("6 0 obj\n<</Type /XRef /Size 8 /Root 1 0 R /Index [6 1] /W [1 4 2] /Length 7>>\nstream\n"), streamEntry, Buffer.from("\nendstream\nendobj\n")]); const trailingOffset = body.length; body = Buffer.concat([body, Buffer.from("7 0 obj\n<</Producer (after xref stream)>>\nendobj\n")]); const xrefOffset = body.length; return Buffer.concat([body, Buffer.from(`xref\n7 1\n${String(trailingOffset).padStart(10, "0")} 00000 n \n5 1\n${String(objectOffset).padStart(10, "0")} 00000 n \ntrailer\n<</Size 8 /Root 1 0 R /Prev ${previousXref} /XRefStm ${streamOffset}>>\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function conflictingHybridMappingPdf() { const base = hybridXrefPdf(); const text = base.toString("latin1"); const xrefOffset = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]); const duplicate = Buffer.from("5 0 obj\n<</Producer (ambiguous duplicate)>>\nendobj\n"); const shifted = Buffer.concat([base.subarray(0, xrefOffset), duplicate, base.subarray(xrefOffset)]).toString("latin1"); return Buffer.from(shifted.replace("trailer\n", `5 1\n${String(xrefOffset).padStart(10, "0")} 00000 n \ntrailer\n`).replace(`startxref\n${xrefOffset}`, `startxref\n${xrefOffset + duplicate.length}`), "latin1"); }
function incrementalXrefStreamPdf() { const base = minimalPdf(); const previousXref = Number(/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]); const objectOffset = base.length; const object = Buffer.from("5 0 obj\n<</Producer (xref stream update)>>\nendobj\n"); const xrefOffset = objectOffset + object.length; const entries = Buffer.alloc(14); entries[0] = 1; entries.writeUInt32BE(objectOffset, 1); entries[7] = 1; entries.writeUInt32BE(xrefOffset, 8); return Buffer.concat([base, object, Buffer.from(`6 0 obj\n<</Type /XRef /Size 7 /Root 1 0 R /Index [5 2] /W [1 4 2] /Length 14 /Prev ${previousXref}>>\nstream\n`), entries, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function forgedPdfTail(base, payload) { const originalXref = /startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]; return Buffer.concat([base, payload, Buffer.from(`\nstartxref\n${originalXref}\n%%EOF\n`)]); }
function initialPdfWithUnclaimedBytes(payload) { const base = minimalPdf(); const xrefOffset = Number(/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]); const tail = base.subarray(xrefOffset).toString("latin1").replace(`startxref\n${xrefOffset}`, `startxref\n${xrefOffset + payload.length}`); return Buffer.concat([base.subarray(0, xrefOffset), payload, Buffer.from(tail, "latin1")]); }
function masqueradingXrefStream(dictionary, data = Buffer.alloc(7)) { const base = minimalPdf(); const previousXref = Number(/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]); const xrefOffset = base.length; return Buffer.concat([base, Buffer.from(`5 0 obj\n<<${dictionary} /Length ${data.length} /Prev ${previousXref}>>\nstream\n`), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]); }
function structuredPdf(catalogExtra, extras, pageExtra = "") { const objects = [`1 0 obj\n<</Type /Catalog /Pages 2 0 R ${catalogExtra}>>\nendobj\n`, "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n", `3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R ${pageExtra}>>\nendobj\n`, "4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n", ...extras]; let body = "%PDF-1.7\n"; const offsets = [0]; for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; } const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body); }
async function fakeClamSocket(socketPath, options = {}) { let received = Buffer.alloc(0); let requestIndex = 0; const server = createNetServer((socket) => { let request = Buffer.alloc(0); let answered = false; socket.on("error", () => {}); socket.on("data", (chunk) => { received = Buffer.concat([received, chunk]); request = Buffer.concat([request, chunk]); if (!answered && request.length >= 14 && request.subarray(-4).equals(Buffer.alloc(4))) { answered = true; const index = requestIndex++; options.onRequest?.(request, index); const response = typeof options.response === "function" ? options.response(request, index) : options.response; const delayMs = typeof options.delayMs === "function" ? options.delayMs(request, index) : options.delayMs; if (response !== undefined) setTimeout(() => socket.end(Buffer.from(response)), delayMs ?? 0); } }); }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); return { server, get received() { return received; } }; }
async function* splitEvery(bytes, size) { for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size); }

test("file inspection runtime accepts only supported pdfjs Node release lines", () => {
  assert.equal(isSupportedInspectionNodeVersion("22.12.0"), false);
  assert.equal(isSupportedInspectionNodeVersion("22.13.0"), true);
  assert.equal(isSupportedInspectionNodeVersion("22.14.1"), true);
  assert.equal(isSupportedInspectionNodeVersion("23.11.0"), false);
  assert.equal(isSupportedInspectionNodeVersion("24.0.0"), true);
  assert.equal(isSupportedInspectionNodeVersion("not-a-version"), false);
});

test("strict text shell classification uses the complete bounded syntax tree", () => {
  const executable = [
    "cat /etc/passwd",
    "value=secret",
    "cat input | sort",
    "echo $(id)",
    "printf value > output",
    "work() { echo ready; }",
    "if true; then echo ready; fi",
    "for item in one two; do echo $item; done",
    "echo ${value}",
    '"safe"; cat /etc/passwd; "tail"',
    '"safe"\ncat /etc/passwd\n"tail"',
    '"safe"cat /etc/passwd"tail"',
    "'safe'; cat /etc/passwd; 'tail'",
    "'safe'cat /etc/passwd'tail'",
    "(whoami)",
    "( whoami )",
    "((whoami))",
    "(whoami; id)",
    "printf pwned > /tmp/x\nif",
    "echo first; for",
    "value=secret\ncase",
    "touch /tmp/x\ncat | | broken",
    "touch /tmp/x & if",
    "whoami",
    "'whoami'",
    '"whoami"',
    "shopt",
    "'shopt'",
    '"shopt"',
  ];
  const prose = [
    "Support requested another screenshot.",
    "Please call me (tomorrow) about this ticket.",
    "Ticket reference: ABC-123.",
    "The recorded value is 42.",
    "42",
    "https://example.test/ticket",
    "ticket_reference",
    "'ticket reference'",
    "hello",
    '"hello"',
    '"echo hello"',
    "if this sentence is unfinished",
    "cat | | broken",
    "for item in",
    "printf pwned >",
    "touch /tmp/x &&",
    "Please review docs/v1.2 before release.",
    "Please visit https://example.test/tickets/42.",
    "Email support@example.test/path.",
    "Version /v1.2 is current.",
    "The ratio is one/two.",
    "A/B testing remains active.",
    "One/two ratio.",
    "/v1.2 is current.",
    "docs/v1.2 release notes.",
  ];
  for (const text of executable) assert.equal(hasExecutableShellSemantics(text), true, text);
  for (const text of prose) assert.equal(hasExecutableShellSemantics(text), false, text);
});

test("sentence-shaped shell classification checks only regular executable filesystem entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-shell-path-")); const originalPath = process.env.PATH; const originalHome = process.env.HOME; const originalUser = process.env.USER; const originalCwd = process.cwd();
  const executable = path.join(dir, "Payload", "run"); const nestedExecutable = path.join(dir, "Payload", "nested", "run"); const nonExecutable = path.join(dir, "Payload", "evidence"); const child = path.join(dir, "child"); const pathBin = path.join(dir, "bin");
  try {
    await mkdir(path.dirname(nestedExecutable), { recursive: true }); await mkdir(child); await mkdir(pathBin);
    await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o755); await writeFile(nestedExecutable, "#!/bin/sh\nexit 0\n"); await chmod(nestedExecutable, 0o755); await writeFile(nonExecutable, "support datum\n");
    for (const name of ["literal*", "run1", "run01", "runa", "rrun", "1un", "élocale"]) { await writeFile(path.join(dir, "Payload", name), "#!/bin/sh\nexit 0\n"); await chmod(path.join(dir, "Payload", name), 0o755); }
    await writeFile(path.join(dir, "MatchOne"), "not executable\n"); await writeFile(path.join(dir, "MatchTwo"), "not executable\n"); await mkdir(path.join(dir, "DirMatchOne"));
    await mkdir(path.join(dir, "Payload", "directory")); await symlink(executable, path.join(dir, "Payload", "linked")); await symlink(path.join(dir, "missing"), path.join(dir, "Payload", "broken"));
    for (const name of ["Runner", "Run*", "MatchOne"]) { await writeFile(path.join(pathBin, name), "#!/bin/sh\nexit 0\n"); await chmod(path.join(pathBin, name), 0o755); }
    await writeFile(path.join(pathBin, "Miss*"), "support datum\n"); await writeFile(path.join(pathBin, "Evidence"), "support datum\n"); await mkdir(path.join(pathBin, "Support")); await mkdir(path.join(pathBin, "DirMatchOne")); await symlink(executable, path.join(pathBin, "LinkedRunner")); await symlink(path.join(dir, "missing"), path.join(pathBin, "BrokenRunner"));
    process.chdir(dir); process.env.PATH = pathBin; process.env.HOME = dir;
    for (const command of ["Payload/run argument.", "./Payload/run argument.", `${executable} argument.`, "Payload/nested/run --flag value.", '"Payload/run" argument.', "'Payload/run' argument.", "Payload\\/run argument.", '"Payload/literal*" argument.', "Payload/literal\\* argument.", "Payload/linked argument.", "Payload/* argument.", "Payload/r?n argument.", "Payload/[r]un argument.", "Payload/{run,nope} argument.", "Payload/run{1..2} argument.", "Payload/run{01..02} argument.", "Payload/run{a..b} argument.", "Payload/run{2..1} argument.", "Payload/run{b..a} argument.", "Payload/run{5..1..2} argument.", "Payload/run{5..1..-2} argument.", "Payload/run{1..5..2} argument.", "Payload/run{01..05..2} argument.", "Payload/run{a..e..2} argument.", "Payload/run{1..1000} argument.", "Payload/[[:alpha:]]una argument.", "Payload/[[:digit:]]un argument.", "Payload/[[:digit:]]una argument.", "Payload/[[:alnum:]]una argument.", "Payload/[![:digit:]]una argument.", "Payload/[[:digit:]r]una argument.", "Payload/[[:alpha:]]locale argument.", "~/Payload/r*n argument.", "~/Payload/run{1..2} argument.", "Run* argument.", "Match* argument.", "Runner argument.", "LinkedRunner argument."]) assert.equal(hasExecutableShellSemantics(command), true, command);
    for (const prose of ["Payload/evidence remains available.", "Payload/directory remains available.", "Payload/broken remains available.", "Payload/missing* remains unavailable.", "Payload/n?pe remains unavailable.", "Payload/[x]un remains unavailable.", "Payload/[z-a] remains documented.", "Payload/{nope,missing} remains unavailable.", "Payload/run{1..3..0} remains documented.", "Payload/run{1..x} remains documented.", "Payload/run{1...2} remains documented.", '"Payload/run{1..2}" remains documented.', "Payload/run\\{1..2\\} remains documented.", '"Payload/[[:alpha:]]una" remains documented.', "Payload/\\[\\[:alpha:\\]\\]una remains documented.", '"Payload/*" remains documented.', "Payload/\\* remains documented.", "~/sporades-file-ingress-no-such-command-* remains unavailable.", "NoMatch* remains unavailable.", "Miss* remains unavailable.", "DirMatch* remains available.", "Evidence argument.", "Support request remains active.", "BrokenRunner argument.", "A * marker remains visible.", "A {draft,final} label remains visible.", "A {1..2} range remains visible.", "A [[:alpha:]] class remains visible."]) assert.equal(hasExecutableShellSemantics(prose), false, prose);
    for (const length of [127, 128, 129]) assert.equal(hasExecutableShellSemantics(`Payload/[${"r".repeat(length)}]run argument.`), true, `bracket body ${length}`);
    assert.equal(hasExecutableShellSemantics(`Payload/[${"r".repeat(128)}[:alpha:]]run argument.`), true, "oversized POSIX bracket class");
    for (const prose of [`Payload/[${"r".repeat(129)}run remains documented.`, "Payload/[]run remains documented.", `"Payload/[${"r".repeat(129)}]run" remains documented.`, `Payload/\\[${"r".repeat(129)}\\]run remains documented.`]) assert.equal(hasExecutableShellSemantics(prose), false, prose);
    process.env.PATH = Array.from({ length: 129 }, (_, index) => path.join(dir, `missing-${index}`)).join(":"); assert.equal(hasExecutableShellSemantics("BeyondPathBound argument."), true);
    process.env.PATH = "x".repeat(4097); assert.equal(hasExecutableShellSemantics("BeyondPathEntryBound argument."), true); process.env.PATH = pathBin;
    process.env.USER = "sporades-fixture"; process.env.HOME = dir; assert.equal(hasExecutableShellSemantics("~sporades-fixture/Payload/run argument."), true);
    for (const invalidHome of [undefined, "", "relative/home", "x".repeat(4097)]) { if (invalidHome === undefined) delete process.env.HOME; else process.env.HOME = invalidHome; assert.equal(hasExecutableShellSemantics("~/Payload/run argument."), true, `HOME=${String(invalidHome)}`); }
    process.env.HOME = dir; delete process.env.USER; assert.equal(hasExecutableShellSemantics("~sporades-fixture/Payload/run argument."), true, "missing USER"); process.env.USER = "someone-else"; assert.equal(hasExecutableShellSemantics("~sporades-fixture/Payload/run argument."), true, "mismatched USER"); assert.equal(hasExecutableShellSemantics("~unsupported/Payload/run argument."), true, "unsupported named user");
    process.env.USER = "sporades-fixture"; process.env.HOME = dir; for (const prose of ['"~/Payload/run" remains documented.', "\\~/Payload/run remains documented.", '"~sporades-fixture/Payload/run" remains documented.', "Tilde ~ means home."]) assert.equal(hasExecutableShellSemantics(prose), false, prose);
    for (const command of ["Payload/run argument.\nIf (then).", "Payload/run argument.\r\nIf (then).", "  Payload/run argument.\nIf (then).", '"Payload/run" argument.\nIf (then).', "Payload\\/run argument.\nIf (then).", "Payload/run argument. # comment\nIf (then).", "Payload/run argument.; If (then).", "Payload/run argument.; true\nIf (then).", "Payload/run argument. && true\nIf (then).", "Payload/run argument. || true\nIf (then).", "Payload/run argument.\nRunner argument.\nIf (then)."]) assert.equal(hasExecutableShellSemantics(command), true, command);
    for (const prose of ["Payload/run argument. && If (then).", "Payload/run argument. || If (then).", "Payload/run argument. &&\nIf (then).", "If (then).\nPayload/run argument.", "If (then).\nWhen (else)."] ) assert.equal(hasExecutableShellSemantics(prose), false, prose);
    for (const command of ["if true; then\n Payload/run argument.\nfi\nIf (then).", "{\n Payload/run argument.\n}\nIf (then).", "work() {\n Payload/run argument.\n}\nwork\nIf (then).", "case one in\n one) Payload/run argument. ;;\nesac\nIf (then).", "while true; do\n Payload/run argument.\ndone\nIf (then).", "for item in one; do\n Payload/run argument.\ndone\nIf (then).", "(\n Payload/run argument.\n)\nIf (then).", "if true; then\n {\n  Payload/run argument.\n }\nfi\nIf (then)."] ) assert.equal(hasExecutableShellSemantics(command), true, command);
    for (const prose of ["if true; then\n Payload/run argument.\nIf (then).", "if true; then\r\n # comment\r\n\r\n Payload/run argument.\r\nIf (then).", "{\n Payload/run argument.\nIf (then).", "work() {\n Payload/run argument.\nIf (then).", "case one in\n one) Payload/run argument. ;;\nIf (then).", "while true; do\n Payload/run argument.\nIf (then).", "for item in one; do\n Payload/run argument.\nIf (then).", "(\n Payload/run argument.\nIf (then).", "if true; then\n {\n  Payload/run argument.\n }\nIf (then).", "Payload/run |\nIf (then).", '"Payload/run argument.\nIf (then).'] ) assert.equal(hasExecutableShellSemantics(prose), false, prose);
    process.chdir(child); assert.equal(hasExecutableShellSemantics("../Payload/run argument."), true);
    assert.equal(hasExecutableShellSemantics("Please inspect Payload output."), false);
  } finally { process.chdir(originalCwd); if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; if (originalUser === undefined) delete process.env.USER; else process.env.USER = originalUser; await rm(dir, { recursive: true, force: true }); }
});

test("strict text shell vocabulary matches the pinned Bash 5.2 command vocabulary", () => {
  const fixture = readFileSync(new URL("./fixtures/bash-5.2-command-vocabulary.txt", import.meta.url), "utf8")
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.deepEqual([...bash52CommandVocabulary].sort(), fixture.sort());
  for (const name of fixture) {
    assert.equal(hasExecutableShellSemantics(name), true, name);
    assert.equal(hasExecutableShellSemantics(`'${name}'`), true, `'${name}'`);
    assert.equal(hasExecutableShellSemantics(`"${name}"`), true, `"${name}"`);
  }
});

test("PDF inspection fail-closes expired fresh and concurrent lazy loads before operator work", () => {
  const cases = [
    { wallClock: "frozen", timeouts: [1] },
    { wallClock: "backward", timeouts: Array(8).fill(1) },
    { wallClock: "forward", timeouts: [1, 2000, 1, 2000, 2000, 1, 2000, 1] },
  ];
  for (const { wallClock, timeouts } of cases) {
    const probe = freshPdfDeadlineProbe(timeouts, wallClock);
    const expected = timeouts.map((timeoutMs) => timeoutMs > 1);
    assert.deepEqual(probe.results, expected, `${wallClock} wall clock with ${timeouts.length} concurrent lazy loads`);
    assert.equal(probe.expiredHooks, expected.filter(Boolean).length, `${wallClock} wall clock let expired work reach the operator hook`);
    assert.ok(probe.elapsedMs < 2_000, `${wallClock} wall clock prevented a bounded result: ${probe.elapsedMs}ms`);
    assert.equal(probe.retry, true, `normal retry failed after ${wallClock} wall clock lazy load`);
    assert.equal(probe.retryHooks, 1, `normal retry did not reach its operator hook after ${wallClock} wall clock lazy load`);
  }
});

test("PDF inspection deadline covers every costly structural preflight stage", async () => {
  const cases = [
    { name: "preflight entry", pdf: minimalPdf(), stage: "header", occurrence: 1 },
    { name: "xref traversal", pdf: minimalPdf(), stage: "xref", occurrence: 2 },
    { name: "dictionary parsing", pdf: minimalPdf(), stage: "dictionary", occurrence: 2 },
    { name: "revision chain", pdf: incrementalPdf(), stage: "revision", occurrence: 2 },
    { name: "revision object traversal", pdf: minimalPdf(), stage: "objects", occurrence: 2 },
    { name: "xref Flate decompression", pdf: xrefStreamPdf(true), stage: "inflate-after", occurrence: 1 },
    { name: "object-stream Flate decompression", pdf: xrefStreamPdfWithCompressedObject({ flate: true }), stage: "inflate-after", occurrence: 1 },
  ];
  for (const { name, pdf, stage, occurrence } of cases) {
    let now = 0n; let stages = 0; let imports = 0; let operators = 0;
    const result = await validatePdfIngress(pdf, {
      timeoutMs: 10,
      monotonicNow: () => now,
      pdfPreflightCheckpoint(candidate) {
        if (candidate === stage && ++stages === occurrence) now = 10_000_000n;
      },
      beforePdfJsImport() { imports += 1; },
      beforeOperatorList() { operators += 1; },
    });
    assert.ok(stages >= occurrence, `${name} did not expose its bounded checkpoint`);
    assert.equal(result, false, `${name} continued after its absolute deadline`);
    assert.equal(imports, 0, `${name} imported PDF.js after preflight expiry`);
    assert.equal(operators, 0, `${name} reached PDF.js operator inspection after preflight expiry`);
  }

  for (const [name, pdf] of [["classic", minimalPdf()], ["incremental", incrementalPdf()], ["xref stream", xrefStreamPdf(true)], ["object stream", xrefStreamPdfWithCompressedObject({ flate: true })]]) {
    let imports = 0; let operators = 0;
    assert.equal(await validatePdfIngress(pdf, { timeoutMs: 2_000, monotonicNow: () => 0n, beforePdfJsImport() { imports += 1; }, beforeOperatorList() { operators += 1; } }), true, `${name} near-bound control`);
    assert.equal(imports, 1, `${name} did not reach PDF.js import`);
    assert.ok(operators > 0, `${name} did not complete PDF.js inspection`);
  }
});

test("PDF inspection fails closed and retries after a transient lazy module failure", async () => {
  const token = randomUUID();
  const runtimePath = path.join(process.cwd(), "dist", `.file-ingress-runtime-${token}.mjs`);
  const loaderName = `.pdfjs-retry-${token}.mjs`;
  const loaderPath = path.join(process.cwd(), "dist", loaderName);
  try {
    const source = await readFile(path.join(process.cwd(), "dist", "file-ingress-runtime.js"), "utf8");
    assert.match(source, /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/);
    await writeFile(runtimePath, source.replace('import("pdfjs-dist/legacy/build/pdf.mjs")', `import("./${loaderName}")`));
    const isolated = await import(`${pathToFileURL(runtimePath).href}?${token}`);
    assert.equal(await isolated.validatePdfIngress(minimalPdf()), false);
    await writeFile(loaderPath, `export function getDocument() {
  const page = { async getOperatorList() { return {}; }, async getJSActions() { return null; }, async getAnnotations() { return []; } };
  const document = { numPages: 1, async getAttachments() { return null; }, async getJSActions() { return null; }, async getOpenAction() { return null; }, async getPage() { return page; } };
  return { promise: Promise.resolve(document), async destroy() {} };
}\n`);
    assert.equal(await isolated.validatePdfIngress(minimalPdf()), true);
  } finally {
    await rm(runtimePath, { force: true });
    await rm(loaderPath, { force: true });
  }
});

test("PDF action entries are classified from their owning dictionary without rejecting tagged layout attributes", async () => {
  const taggedLayout = structuredPdf(
    "/MarkInfo <</Marked true>> /StructTreeRoot 5 0 R",
    [
      "5 0 obj\n<</Type /StructTreeRoot /K [6 0 R]>>\nendobj\n",
      "6 0 obj\n<</Type /StructElem /S /P /P 5 0 R /Pg 3 0 R /A <</O /Layout /TextAlign /Center>>>>\nendobj\n",
    ],
  );
  const iconFit = structuredPdf("/AcroForm 5 0 R", [
    "5 0 obj\n<</Fields [6 0 R]>>\nendobj\n",
    "6 0 obj\n<</Type /Annot /Subtype /Widget /FT /Btn /Rect [0 0 1 1] /MK <</IF 7 0 R>>>>\nendobj\n",
    "7 0 obj\n<</SW /A /S /P /A [0.5 0.5]>>\nendobj\n",
  ], "/Annots [6 0 R]");
  const annotationActions = [
    structuredPdf("", ["5 0 obj\n<</Rect [0 0 1 1] /A <</D [3 0 R /Fit]>>>>\nendobj\n"], "/Annots [5 0 R]"),
    structuredPdf("", ["5 0 obj\n<</Rect [0 0 1 1] /A 6 0 R>>\nendobj\n", "6 0 obj\n<</D [3 0 R /Fit]>>\nendobj\n"], "/Annots [5 0 R]"),
    structuredPdf("", ["5 0 obj\n<</Subtype /CustomNote /Rect [0 0 1 1] /A <</D [3 0 R /Fit]>>>>\nendobj\n"], "/Annots [5 0 R]"),
    structuredPdf("", ["5 0 obj\n<</Subtype /CustomNote /Rect [0 0 1 1] /A 6 0 R>>\nendobj\n", "6 0 obj\n<</D [3 0 R /Fit]>>\nendobj\n"], "/Annots [5 0 R]"),
  ];
  const outlineActions = [
    structuredPdf("/Outlines 5 0 R", ["5 0 obj\n<</First 6 0 R /Last 6 0 R /Count 1>>\nendobj\n", "6 0 obj\n<</Title (Unsafe) /A <</D [3 0 R /Fit]>>>>\nendobj\n"]),
    structuredPdf("/Outlines 5 0 R", ["5 0 obj\n<</First 6 0 R /Last 6 0 R /Count 1>>\nendobj\n", "6 0 obj\n<</Title (Unsafe) /A 7 0 R>>\nendobj\n", "7 0 obj\n<</D [3 0 R /Fit]>>\nendobj\n"]),
    structuredPdf("/Outlines 5 0 R", ["5 0 obj\n<</First 6 0 R /Last 7 0 R /Count 2>>\nendobj\n", "6 0 obj\n<</Title (First) /Next 7 0 R>>\nendobj\n", "7 0 obj\n<</Title (Unsafe) /Prev 6 0 R /Next 6 0 R /A <</D [3 0 R /Fit]>>>>\nendobj\n"]),
  ];

  assert.equal(await validatePdfIngress(taggedLayout), true);
  assert.equal(await validatePdfIngress(iconFit), true);
  for (const pdf of annotationActions) assert.equal(await validatePdfIngress(pdf), false);
  for (const pdf of outlineActions) assert.equal(await validatePdfIngress(pdf), false);
});

test("PDF inspection requires the final cross-reference EOF boundary to be terminal", async () => {
  const base = minimalPdf();
  const embeddedMarker = structuredPdf("", ["5 0 obj\n(embedded %%EOF marker)\nendobj\n"]);
  const acceptedPdfs = [
    base,
    base.subarray(0, base.length - 1),
    Buffer.concat([base, Buffer.from("\r\n\t\f ")]),
    Buffer.concat([base, Buffer.from("% retained by archive\r\n% second comment\n")]),
    Buffer.concat([base, Buffer.from("% archive mentions %%EOF without creating a footer\n")]),
    minimalPdfWithBinaryHeaderComment(),
    incrementalPdf(),
    incrementalPdfRevision(Buffer.alloc(0), Buffer.from("5 0 obj\n<</Length 8>>\nstream\nevidence\nendstream\nendobj\n")),
    xrefStreamPdf(),
    xrefStreamPdf(true),
    xrefStreamPdf("array"),
    incrementalXrefStreamPdf(),
    hybridXrefPdf(),
    hybridXrefPdf(true),
    incrementalHybridXrefPdf(),
    outOfOrderClassicXrefPdf(),
    classicPdfWithCatalogGeneration(65534),
    classicPdfWithCatalogGeneration(65535),
    xrefStreamPdfWithCatalogGeneration(65534),
    xrefStreamPdfWithCatalogGeneration(65535),
    xrefStreamPdfWithCompressedObject(),
    xrefStreamPdfWithCompressedObject({ flate: true }),
    incrementallySupersededCompressedObject(),
    incrementallySupersededCompressedObject(true),
    classicPdfWithFreeChain(),
    incrementallyReplaceHistoricalFreeEntry(),
    classicPdfWithStreamLength("5 0 R"),
    classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "", "/Custom null"),
    compactTrailerPdf("/Info null"),
    xrefStreamPdfWithCompressedObject({ indirectLength: true }),
    xrefStreamPdfWithCompressedObject({ indirectLength: true, flate: true }),
    xrefStreamPdfWithIndirectLength(),
    classicPdfWithStreamLength("47", "4", "/Encrypt % harmless name and comment\n(Encrypt)\n"),
    classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "/CustomName /Encrypt"),
    embeddedMarker,
  ];
  for (const [index, accepted] of acceptedPdfs.entries()) assert.equal(await validatePdfIngress(accepted), true, `accepted PDF control ${index}`);

  for (const suffix of [
    Buffer.from("PK\x03\x04archive"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
    Buffer.from("MZexecutable"),
    Buffer.from("#!/bin/sh\necho unsafe\n"),
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  ]) assert.equal(await validatePdfIngress(Buffer.concat([base, suffix])), false);

  for (const payload of [
    Buffer.from("PK\x03\x04archive"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
    Buffer.from("MZexecutable"),
    Buffer.from("#!/bin/sh\necho unsafe\n"),
    Buffer.from("printable garbage"),
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    minimalPdf(),
  ]) assert.equal(await validatePdfIngress(forgedPdfTail(base, payload)), false);

  const update = incrementalPdf(); const updateXref = Number([...update.toString("latin1").matchAll(/startxref\n(\d+)\n%%EOF/g)].at(-1)[1]);
  assert.equal(await validatePdfIngress(Buffer.from(update.toString("latin1").replace(`/Prev ${/startxref\n(\d+)\n%%EOF/.exec(base.toString("latin1"))[1]}`, `/Prev ${updateXref}`), "latin1")), false);
  assert.equal(await validatePdfIngress(Buffer.from(update.toString("latin1").replace(/\/Prev \d+/, "/Prev 999999999"), "latin1")), false);
  assert.equal(await validatePdfIngress(Buffer.from(update.toString("latin1").replace(/\/Prev \d+/, (match) => `${match} ${match}`), "latin1")), false);
  assert.equal(await validatePdfIngress(incrementalPdfRevision(Buffer.from("PK\x03\x04unreferenced payload\n"))), false);

  for (const payload of [Buffer.from("PK\x03\x04archive"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("#!/bin/sh\n"), Buffer.from([0xde, 0xad, 0xbe, 0xef])]) {
    assert.equal(await validatePdfIngress(initialPdfWithUnclaimedBytes(payload)), false);
  }

  for (const fake of [
    masqueradingXrefStream("/Size 6 /W [1 4 2]"),
    masqueradingXrefStream("/Type /Metadata /Size 6 /W [1 4 2]"),
    masqueradingXrefStream("/Type /XRef /Size 6"),
    masqueradingXrefStream("/Type /XRef /Size 6 /W [1 0 2]"),
    masqueradingXrefStream("/Type /XRef /W [1 4 2]"),
    masqueradingXrefStream("/Type /XRef /Size 6 /Index [7 1] /W [1 4 2]"),
  ]) assert.equal(await validatePdfIngress(fake), false);

  const classic = base.toString("latin1"); const inUseEntries = [...classic.matchAll(/\d{10} 00000 n /g)].map((match) => match[0]);
  const swappedEntries = classic.replace(inUseEntries[0], "SWAP_ENTRY").replace(inUseEntries[1], inUseEntries[0]).replace("SWAP_ENTRY", inUseEntries[1]);
  for (const malformed of [
    swappedEntries,
    classic.replace(inUseEntries[0], `${inUseEntries[0].slice(0, 11)}00001 n `),
    classic.replace("xref\n0 5\n0000000000 65535 f \n", "xref\n2 4\n").replace("/Size 5", "/Size 6"),
    classic.replace("/Size 5", "/Size 4"),
    classic.replace("/Size 5", "/Size 999999"),
    classic.replace("/Size 5", "/Size 999999999"),
  ]) assert.equal(await validatePdfIngress(Buffer.from(malformed, "latin1")), false);

  const nonzeroGeneration = Buffer.from(classic.replace("1 0 obj", "1 2 obj").replace("/Root 1 0 R", "/Root 1 2 R").replace(inUseEntries[0], `${inUseEntries[0].slice(0, 11)}00002 n `), "latin1");
  assert.equal(await validatePdfIngress(nonzeroGeneration), true);
  assert.equal(await validatePdfIngress(classicPdfWithCatalogGeneration(99999)), false);
  assert.equal(await validatePdfIngress(Buffer.from(classic.replace("1 0 obj", "1 -1 obj"), "latin1")), false);
  assert.equal(await validatePdfIngress(Buffer.from(classic.replace("0000000000 65535 f", "0000000000 00000 f"), "latin1")), false);
  assert.equal(await validatePdfIngress(classicPdfWithInUseObjectZero()), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithCatalogGeneration(65536)), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithCatalogGeneration(0, 65534)), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithInUseObjectZero()), false);
  for (const invalidCompressed of [
    xrefStreamPdfWithCompressedObject({ container: 1 }),
    xrefStreamPdfWithCompressedObject({ ordinaryStream: true }),
    xrefStreamPdfWithCompressedObject({ index: 1 }),
    xrefStreamPdfWithCompressedObject({ tableObject: 9 }),
    xrefStreamPdfWithCompressedObject({ container: 6 }),
  ]) assert.equal(await validatePdfIngress(invalidCompressed), false);
  for (const invalidFreeList of [
    classicPdfWithFreeChain({ head: 1 }),
    classicPdfWithFreeChain({ head: 5, next: 5 }),
    classicPdfWithFreeChain({ head: 9 }),
    classicPdfWithFreeChain({ head: 0 }),
    xrefStreamPdfWithCompressedObject({ freeHead: 6 }),
    xrefStreamPdfWithCompressedObject({ freeHead: 9 }),
  ]) assert.equal(await validatePdfIngress(invalidFreeList), false);
  assert.equal(await validatePdfIngress(incrementallyRepairInvalidCompressedContainer()), false);
  assert.equal(await validatePdfIngress(incrementallyRepairInvalidFreeHead()), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("5 1 R")), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("5 0 R", "(four)")), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("9 0 R")), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("4 0 R")), false);
  assert.equal(await validatePdfIngress(futureRevisionStreamLength()), false);
  assert.equal(await validatePdfIngress(Buffer.from(xrefStreamPdfWithCompressedObject({ indirectLength: true }).toString("latin1").replace("/Length 7 0 R", "/Length 7 1 R"), "latin1")), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithIndirectLength({ wrongGeneration: true })), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithIndirectLength({ wrongType: true })), false);
  assert.equal(await validatePdfIngress(xrefStreamPdfWithIndirectLength({ encrypt: true })), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "/Encrypt <</Filter /Standard>>")), false);
  assert.equal(await validatePdfIngress(classicPdfWithStreamLength("5 0 R", "<</Filter /Standard>>", "q\nQ\n", "/Encrypt 5 0 R")), false);
  assert.equal(await validatePdfIngress(compactTrailerPdf("/Encrypt null")), false);
  assert.equal(await validatePdfIngress(compactTrailerPdf("/Encrypt 4 0 R")), false);
  assert.equal(await validatePdfIngress(compactTrailerPdf("/Encrypt 9 0 R")), false);
  for (const delimiter of ["/Meta <00>/Encrypt null", "/Meta <</Ignored true>>/Encrypt null", "/Meta [null]/Encrypt null", "/Meta (ignored)/Encrypt null"]) assert.equal(await validatePdfIngress(compactTrailerPdf(delimiter)), false, delimiter);
  assert.equal(await validatePdfIngress(compactTrailerPdf("% adjacent comment\n")), true);
  assert.equal(await validatePdfIngress(compactTrailerPdf("% adjacent comment\n/Encrypt null")), false);
  const objectTwoOffset = /2 0 obj/.exec(classic).index;
  assert.equal(await validatePdfIngress(Buffer.from(classic.replace("trailer\n", `2 1\n${String(objectTwoOffset).padStart(10, "0")} 00000 n \ntrailer\n`), "latin1")), false);

  const hybrid = hybridXrefPdf(); const hybridText = hybrid.toString("latin1"); const hybridPointer = /\/XRefStm (\d+)/.exec(hybridText)[1]; const ordinaryObjectOffset = /4 0 obj/.exec(hybridText).index;
  for (const malformed of [
    hybridText.replace(`/XRefStm ${hybridPointer}`, `/XRefStm ${ordinaryObjectOffset}`),
    hybridText.replace(`/XRefStm ${hybridPointer}`, "/XRefStm 999999999"),
    hybridText.replace(`/XRefStm ${hybridPointer}`, `/XRefStm ${hybridPointer} /XRefStm ${hybridPointer}`),
    hybridText.replace("/W [1 4 2]", "/W [1 0 2]"),
  ]) assert.equal(await validatePdfIngress(Buffer.from(malformed, "latin1")), false);
  assert.equal(await validatePdfIngress(Buffer.from(hybridText.replace("trailer\n", `5 1\n${String(hybridPointer).padStart(10, "0")} 00000 n \ntrailer\n`), "latin1")), true);
  assert.equal(await validatePdfIngress(Buffer.from(hybridText.replace("0000000000 65535 f", "0000000005 65535 f").replace("trailer\n", "5 1\n0000000000 00001 f \ntrailer\n"), "latin1")), true);
  assert.equal(await validatePdfIngress(conflictingHybridMappingPdf()), true);
  assert.equal(await validatePdfIngress(xrefStreamPdf("multiple")), false);
});

test("JavaScript classification fails closed before recursive parser exhaustion without rejecting malformed prose", () => {
  assert.equal(hasExecutableJavaScriptSemantics("(".repeat(1000) + "alert(1)" + ")".repeat(1000)), true);
  assert.equal(hasExecutableJavaScriptSemantics("[".repeat(1000) + "alert(1)" + "]".repeat(1000)), true);
  assert.equal(hasExecutableJavaScriptSemantics("!".repeat(4000) + "alert(1)"), true);
  assert.equal(hasExecutableJavaScriptSemantics("await ".repeat(4000) + "alert(1)"), true);
  assert.equal(hasExecutableJavaScriptSemantics("new ".repeat(4000) + "alert(1)"), true);
  assert.equal(hasExecutableJavaScriptSemantics("a=>".repeat(4000) + "alert(1)"), true);
  assert.equal(hasExecutableJavaScriptSemantics("a?".repeat(4000) + "alert(1)" + ":a".repeat(4000)), true);
  assert.equal(hasExecutableJavaScriptSemantics("(".repeat(255) + "supportNote" + ")".repeat(255)), false);
  assert.equal(hasExecutableJavaScriptSemantics("Please (if practical) call me tomorrow."), false);
  assert.equal(hasExecutableJavaScriptSemantics("const ="), false);
});

test("Python classification rejects complete executable programs without treating prose as code", () => {
  const executablePrograms = [
    "import pathlib\npathlib.Path(\"/tmp/report\").unlink()",
    "import os as operating_system",
    "from os.path import join as combine",
    "factory.build()",
    "registry[\"handler\"]()",
    "value = 1",
    "value += 1",
    "if ready:\n    process()",
    "for item in items:\n    process(item)",
    "@register\ndef handler():\n    pass",
    "class Handler:\n    pass",
    "async def task():\n    await work()",
    "def stream():\n    yield 1",
    "lambda item: process(item)",
    "[process(item) for item in items]",
    "{item: process(item) for item in items}",
    "{process(item) for item in items}",
    "(process(item) for item in items)",
    "raise RuntimeError()",
    "assert ready",
    "del registry[\"handler\"]",
  ];
  for (const program of executablePrograms) assert.equal(hasExecutablePythonSemantics(program), true, program.split("\n", 1)[0]);

  const benignText = [
    "hello",
    "ticket_reference",
    "\"quoted text\"",
    "'quoted text'",
    "A harmless support note.\nSecond line.",
    "Please (if practical) call me tomorrow.",
    "import from",
    "def broken(",
    "alert(\"x\") is the exact text shown in the report.",
  ];
  for (const text of benignText) assert.equal(hasExecutablePythonSemantics(text), false, text.split("\n", 1)[0]);
  assert.equal(hasExecutablePythonSemantics("(".repeat(255) + "supportNote" + ")".repeat(255)), false);
  assert.equal(hasExecutablePythonSemantics("(".repeat(257) + "supportNote" + ")".repeat(257)), true);
  assert.equal(hasExecutablePythonSemantics("a".repeat(1024 * 1024 + 1)), true);
});

test("the flat parser budget bounds every recursive Acorn expression grammar at one threshold", () => {
  const expressions = [
    ["parentheses", (depth) => "(".repeat(depth) + "supportNote" + ")".repeat(depth)],
    ["arrays", (depth) => "[".repeat(depth) + "supportNote" + "]".repeat(depth)],
    ["blocks", (depth) => "{".repeat(depth) + "supportNote;" + "}".repeat(depth)],
    ["template expressions", (depth) => "`${".repeat(depth) + "supportNote" + "}`".repeat(depth)],
    ["prefix operators", (depth) => "!".repeat(depth) + "supportNote"],
    ["await", (depth) => "await ".repeat(depth) + "supportNote"],
    ["yield", (depth) => "yield ".repeat(depth) + "supportNote"],
    ["new", (depth) => "new ".repeat(depth) + "SupportNote"],
    ["arrows", (depth) => "a=>".repeat(depth) + "a"],
    ["conditionals", (depth) => "a?".repeat(depth) + "a" + ":a".repeat(depth)],
    ["assignments", (depth) => "a=".repeat(depth) + "a"],
    ["binary precedence", (depth) => "a+".repeat(depth) + "a"],
    ["exponentiation", (depth) => "a**".repeat(depth) + "a"],
    ["if statement bodies", (depth) => "if(a)".repeat(depth) + "supportNote;"],
    ["while statement bodies", (depth) => "while(a)".repeat(depth) + "supportNote;"],
    ["for statement bodies", (depth) => "for(;;)".repeat(depth) + "supportNote;"],
    ["do statement bodies", (depth) => "do ".repeat(depth) + "supportNote;" + "while(a);".repeat(depth), 2],
    ["with statement bodies", (depth) => "with(a)".repeat(depth) + "supportNote;"],
    ["labels", (depth) => "support:".repeat(depth) + "supportNote;"],
  ];
  for (const [name, expression, recursionTokensPerDepth = 1] of expressions) {
    const maximumDepth = Math.floor(256 / recursionTokensPerDepth);
    assert.equal(isJavaScriptParserInputWithinBounds(expression(maximumDepth)), true, `${name} at the token bound`);
    assert.equal(isJavaScriptParserInputWithinBounds(expression(maximumDepth + 1)), false, `${name} just above the token bound`);
  }
  assert.equal(hasExecutableJavaScriptSemantics("Please await a new reply (tomorrow)."), false);
  assert.equal(hasExecutableJavaScriptSemantics("`" + "await new => ? ([{ ".repeat(64) + "`"), false);
  assert.equal(hasExecutableJavaScriptSemantics("/await new => \\? \\( \\[ \\{/"), false);
  assert.equal(hasExecutableJavaScriptSemantics("/* " + "await new => ? ([{ ".repeat(64) + " */ supportNote"), false);
});

test("raw structural nesting is bounded before any third-party JavaScript work", () => {
  const nested = (open, close, depth, prefix = "", suffix = "") => prefix + open.repeat(depth) + "evidence" + close.repeat(depth) + suffix;
  for (const [name, open, close] of [["parentheses", "(", ")"], ["brackets", "[", "]"], ["braces", "{", "}"]]) {
    assert.equal(isJavaScriptRawInputWithinBounds(nested(open, close, 256)), true, `${name} at bound`);
    assert.equal(isJavaScriptRawInputWithinBounds(nested(open, close, 257)), false, `${name} above bound`);
  }
  assert.equal(isJavaScriptRawInputWithinBounds("([{".repeat(85) + "(" + "evidence" + ")" + "}])".repeat(85)), true, "mixed at bound");
  assert.equal(isJavaScriptRawInputWithinBounds("([{".repeat(85) + "([" + "evidence" + "])" + "}])".repeat(85)), false, "mixed above bound");
  assert.equal(isJavaScriptRawInputWithinBounds(nested("[", "]", 256, "/", "/v")), true, "Unicode set at bound");
  assert.equal(isJavaScriptRawInputWithinBounds(nested("[", "]", 257, "/", "/v")), false, "Unicode set above bound");
  assert.equal(isJavaScriptRawInputWithinBounds(nested("(", ")", 256, "/", "/")), true, "regex group at bound");
  assert.equal(isJavaScriptRawInputWithinBounds(nested("(", ")", 257, "/", "/")), false, "regex group above bound");
  for (const [name, prefix, suffix] of [["quoted", "'", "'"], ["comment", "/*", "*/"], ["template", "`", "`"]]) {
    assert.equal(isJavaScriptRawInputWithinBounds(nested("(", ")", 256, prefix, suffix)), true, `${name} at bound`);
    assert.equal(isJavaScriptRawInputWithinBounds(nested("(", ")", 257, prefix, suffix)), false, `${name} above bound`);
  }
  assert.equal(isJavaScriptRawInputWithinBounds("(".repeat(256) + "evidence"), true, "unmatched openers at bound");
  assert.equal(isJavaScriptRawInputWithinBounds("(".repeat(257) + "evidence"), false, "unmatched openers above bound");
  assert.equal(isJavaScriptRawInputWithinBounds(")]}".repeat(1000) + "evidence"), true, "unmatched closers do not create depth");
  assert.equal(isJavaScriptRawInputWithinBounds("[({])}".repeat(1000) + "evidence"), true, "mismatched delimiters remain shallow");
  assert.equal(isJavaScriptRawInputWithinBounds("if (ready) /" + "[({])}".repeat(129) + "/"), true, "slash-prefixed malformed prose remains shallow");
  assert.equal(isJavaScriptRawInputWithinBounds("Please keep the ticket wording (including this aside)."), true);
});

test("multipart framing survives every one-byte boundary/header split and keeps boundary-like payload bytes", async () => {
  const boundary = "split-boundary"; const payload = "one\r\n--not-the-boundary\r\ntwo"; const source = multipart(boundary, undefined, payload);
  for (let split = 1; split <= source.length; split += 1) {
    const parts = []; for await (const part of multipartParts(splitEvery(source, split), boundary, 10000, 10000)) parts.push(part);
    assert.equal(parts.length, 1, `split ${split}`); assert.equal(parts[0].body.toString(), payload, `split ${split}`);
  }
});

test("multipart framing retains false boundary prefixes, including binary suffixes split from the prefix", async () => {
  const boundary = "false-prefix";
  const falsePrefixes = Buffer.concat([Buffer.from("before\r\n--false-prefixXmiddle\r\n--false-prefix"), Buffer.from([0]), Buffer.from("after")]);
  const source = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="binary.bin"\r\n\r\n`), falsePrefixes, Buffer.from(`\r\n--${boundary}--`)]);
  for (let split = 1; split <= source.length; split += 1) {
    const parts = []; for await (const part of multipartParts(splitEvery(source, split), boundary, 10000, 10000)) parts.push(part);
    assert.equal(parts.length, 1, `split ${split}`); assert.deepEqual(parts[0].body, falsePrefixes, `split ${split}`);
  }
});

test("multipart closing delimiters require EOF or CRLF and never silently truncate suffix bytes", async () => {
  const boundary = "closing"; const headers = 'Content-Disposition: form-data; name="file"; filename="a.bin"';
  const invalid = Buffer.from(`--${boundary}\r\n${headers}\r\n\r\npayload\r\n--${boundary}--X`);
  for (let split = 1; split < invalid.length; split += 1) await assert.rejects(async () => { const yielded = []; for await (const part of multipartParts(splitEvery(invalid, split), boundary, 10000, 10000)) yielded.push(part); }, { code: "INVALID_MULTIPART" });
  const valid = Buffer.from(`--${boundary}\r\n${headers}\r\n\r\npayload\r\n--${boundary}--\r\nepilogue`); const parts = [];
  for await (const part of multipartParts(splitEvery(valid, 1), boundary, 10000, 10000)) parts.push(part); assert.equal(parts[0].body.toString(), "payload");
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\npayload\r\n--${boundary}-`), 1), boundary, 10000, 10000)) {} }, { code: "INVALID_MULTIPART" });
});

test("multipart policy rejects missing and non-finite or fractional limits before reading request bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-invalid-limits-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-limits" }, capsule({ name: "invalid-limits" }));
    const invalid = [undefined, NaN, Infinity, -Infinity, 1.5, "1"];
    for (const name of ["maxFiles", "maxFileBytes", "maxTotalFileBytes", "maxFieldCount", "maxFieldBytes", "maxTotalFieldBytes"]) {
      for (const value of invalid) {
        const policy = { ...ingressPolicy(), [name]: value }; let reads = 0;
        const request = { async *[Symbol.asyncIterator]() { reads += 1; yield multipart("invalid"); } };
        await assert.rejects(stageMultipartIngress(database, { options: { method: "POST", path: "/invalid", body: { multipart: policy } } }, request, { headers: { "content-type": "multipart/form-data; boundary=invalid", "idempotency-key": "request" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" });
        assert.equal(reads, 0, `${name}=${String(value)}`);
      }
    }
    for (const [name, value] of [["maxFiles", 0], ["maxFileBytes", 0], ["maxTotalFileBytes", 0], ["maxFieldCount", -1], ["maxFieldBytes", -1], ["maxTotalFieldBytes", -1]]) {
      await assert.rejects(stageMultipartIngress(database, { options: { method: "POST", path: "/invalid", body: { multipart: { ...ingressPolicy(), [name]: value } } } }, { async *[Symbol.asyncIterator]() { throw new Error("must not read"); } }, { headers: { "content-type": "multipart/form-data; boundary=invalid", "idempotency-key": "request" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" });
    }
    const malformed = [["allowedPathPrefixes", undefined], ["allowedPathPrefixes", []], ["allowedPathPrefixes", ["relative"]], ["allowedMimeTypes", "text/plain"], ["allowedMimeTypes", ["bad"]], ["requestKeyHeader", "bad header"], ["partKeyHeader", ""], ["requireStablePartKeys", "true"], ["claimAuthorities", ["actor", "capsule-principal"]], ["unknown", true]];
    for (const [name, value] of malformed) {
      let reads = 0; const policy = { ...ingressPolicy(), [name]: value }; await assert.rejects(stageMultipartIngress(database, { options: { method: "POST", path: "/invalid", body: { multipart: policy } } }, { async *[Symbol.asyncIterator]() { reads += 1; yield multipart("invalid"); } }, { headers: { "content-type": "multipart/form-data; boundary=invalid", "idempotency-key": "request" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" }); assert.equal(reads, 0, name);
    }
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule startup rejects an invalid untyped multipart declaration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-invalid-startup-"));
  try {
    const definition = capsule({ name: "invalid-startup", endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart: { ...ingressPolicy(), maxFileBytes: NaN } } }, () => ({ ok: true })) } });
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-startup" }, definition), { code: "INVALID_MULTIPART_POLICY" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("omitted optional stable-part-key policy is accepted at startup and before body reads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-optional-stable-key-")); let database;
  try {
    const policy = { ...ingressPolicy() }; delete policy.requireStablePartKeys;
    const definition = capsule({ name: "optional-stable-key", endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart: policy } }, () => ({ ok: true })) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "optional-stable-key", files: { storagePath: path.join(dir, "files") } }, definition);
    let reads = 0; const result = await stageMultipartIngress(database, database.endpoints[0], { async *[Symbol.asyncIterator]() { reads += 1; yield multipart("optional", 'Content-Disposition: form-data; name="file"; filename="a.txt"', "bytes"); } }, { headers: { "content-type": "multipart/form-data; boundary=optional", "idempotency-key": "request" } }, { userId: "actor" });
    assert.equal(reads, 1); assert.equal(result.multipart.files.length, 1); assert.equal(Object.hasOwn(policy, "requireStablePartKeys"), false);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("length-framed ingress keys distinguish delimiter-collision tuples", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-framed-key-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "framed-key", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "framed-key" }));
    const policy = ingressPolicy(); const make = (endpointPath, actorId, requestKey, partKey, body) => stageMultipartIngress(database, { options: { method: "POST", path: endpointPath, body: { multipart: policy } } }, { async *[Symbol.asyncIterator]() { yield multipart("framed", `Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: ${partKey}`, body); } }, { headers: { "content-type": "multipart/form-data; boundary=framed", "idempotency-key": requestKey } }, { userId: actorId });
    const first = await make("/upload", "actor", "a:b", "c", "first"); const second = await make("/upload", "actor", "a", "b:c", "second");
    assert.notEqual(first.multipart.files[0].leaseId, second.multipart.files[0].leaseId);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("multipart framing rejects malformed terminators and bounded headers/parts", async () => {
  const boundary = "limits";
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\na\r\n--${boundary}X`), 1), boundary, 1000, 1000)) {} }, { code: "INVALID_MULTIPART" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, `X: ${"a".repeat(17000)}`), 17), boundary, 20000, 20000)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
  await assert.rejects(async () => { for await (const _ of multipartParts(splitEvery(multipart(boundary, undefined, "x".repeat(20)), 1), boundary, 1000, 10)) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
});

test("multipart streaming applies the header-classified field cap before reading a file-sized body", async () => {
  const boundary = "classified-limit"; const fieldBytes = "x".repeat(200); const fieldSource = multipart(boundary, 'Content-Disposition: form-data; name="tag"', fieldBytes);
  let reads = 0; const chunks = splitEvery(fieldSource, 8); const request = { async *[Symbol.asyncIterator]() { for await (const chunk of chunks) { reads += 1; yield chunk; } } };
  await assert.rejects(async () => { for await (const _ of multipartParts(request, boundary, 1000, { file: 512, field: 16 })) {} }, { code: "MULTIPART_LIMIT_EXCEEDED" });
  assert.ok(reads < Math.ceil(fieldSource.length / 8), `read ${reads} chunks for ${fieldSource.length} bytes`);
  const fileBody = "y".repeat(200); const files = []; for await (const part of multipartParts(splitEvery(multipart(boundary, 'Content-Disposition: form-data; name="file"; filename="large.bin"', fileBody), 7), boundary, 1000, { file: 512, field: 16 })) files.push(part);
  assert.equal(files[0].body.toString(), fileBody);
});

test("multipart streaming enforces the smaller endpoint and Capsule File limit before staging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-global-cap-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "global-cap", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "global-cap" })); const endpoint = { options: { method: "POST", path: "/cap", body: { multipart: { ...ingressPolicy(), maxFileBytes: 100, maxTotalFileBytes: 100 } } } };
    const attempt = async (limit, body, requestKey) => { database.fileMaxSizeBytes = limit; let reads = 0; const bytes = multipart("cap", 'Content-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-ID: stable', body); const request = { async *[Symbol.asyncIterator]() { for (const byte of bytes) { reads += 1; yield Buffer.from([byte]); } } }; return { get reads() { return reads; }, total: bytes.length, promise: stageMultipartIngress(database, endpoint, request, { headers: { "content-type": "multipart/form-data; boundary=cap", "idempotency-key": requestKey } }, { userId: "actor" }) }; };
    let probe = await attempt(5, "123456", "global-small"); await assert.rejects(probe.promise, { code: "MULTIPART_LIMIT_EXCEEDED" }); assert.ok(probe.reads < probe.total); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_file_ingress").get()).count), 0);
    endpoint.options.body.multipart.maxFileBytes = 4; probe = await attempt(100, "12345", "endpoint-small"); await assert.rejects(probe.promise, { code: "MULTIPART_LIMIT_EXCEEDED" }); assert.ok(probe.reads < probe.total);
    endpoint.options.body.multipart.maxFileBytes = 5; probe = await attempt(5, "12345", "equal"); const accepted = await probe.promise; assert.equal(accepted.multipart.files[0].size, 5);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("multipart fields safely aggregate prototype-shaped names", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-field-keys-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "field-keys" }, capsule({ name: "field-keys" }));
    const endpoint = { options: { method: "POST", path: "/field-keys", body: { multipart: { ...ingressPolicy(), maxFieldCount: 4 } } } };
    const parts = ["constructor", "toString", "__proto__", "constructor"].map((name, index) => ({ headers: `Content-Disposition: form-data; name="${name}"`, body: `v${index}` }));
    const result = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartMany("field-keys", parts); } }, { headers: { "content-type": "multipart/form-data; boundary=field-keys", "idempotency-key": "field-keys" } }, { userId: "actor" });
    assert.equal(Object.getPrototypeOf(result.multipart.fields), null); assert.deepEqual([...result.multipart.fields.constructor], ["v0", "v3"]); assert.deepEqual([...result.multipart.fields.toString], ["v1"]); assert.deepEqual([...result.multipart.fields.__proto__], ["v2"]); assert.equal({}.v2, undefined);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("multipart ingress rejects nested multipart and transfer encodings before staging any residue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-nested-rejected-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "nested-rejected", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "nested-rejected" }));
    const endpoint = { options: { method: "POST", path: "/nested", body: { multipart: ingressPolicy() } } };
    const headers = { "content-type": "multipart/form-data; boundary=nested", "idempotency-key": "must-not-persist" };
    for (const partHeaders of [
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\r\nContent-Type: MULTIPART/MIXED; boundary=inner\r\nContent-ID: stable',
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\r\nContent-Transfer-Encoding: BaSe64\r\nContent-ID: stable',
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\r\nContent-Type:\r\n multipart/mixed; boundary=inner\r\nContent-ID: stable',
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\r\nContent-Transfer-Encoding:\r\n\tbase64\r\nContent-ID: stable',
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\nContent-Transfer-Encoding: base64\r\nContent-ID: stable',
      'Content-Disposition: form-data; name="file"; filename="secret-name.txt"\rContent-Type: multipart/mixed\r\nContent-ID: stable',
    ]) {
      let reads = 0;
      const bytes = multipart("nested", partHeaders, "super-secret-bytes");
      const request = { async *[Symbol.asyncIterator]() { for (const byte of bytes) { reads += 1; yield Buffer.from([byte]); } } };
      await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers }, { userId: "secret-actor" }), { code: "INVALID_MULTIPART" });
      assert.ok(reads <= bytes.length, "rejection must consume only the bounded request source");
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
    }
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a running runtime periodically sweeps expired ingress leases and stops its ingress timer on shutdown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-live-sweep-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "live-sweep", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "live-sweep" }), { clock });
    await database.init();
    const endpoint = { options: { method: "POST", path: "/live-sweep", body: { multipart: ingressPolicy() } } };
    const result = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipart("live-sweep", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-ID: stable', "bytes"); } }, { headers: { "content-type": "multipart/form-data; boundary=live-sweep", "idempotency-key": "sweep-key" } }, { userId: "actor" });
    const row = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress] WHERE [leaseId] = ?").get(result.multipart.files[0].leaseId)).payload);
    row.expiresAt = "2029-12-31T23:59:59.000Z";
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [expiresAt] = ?, [payload] = ? WHERE [leaseId] = ?").run(row.expiresAt, JSON.stringify(row), row.leaseId);
    clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
    await database.shutdown();
    clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("durable ingress keeps maintenance alive after the last implicit-storage endpoint is removed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-retained-maintenance-")); let first; let second; let legacy;
  try {
    const dbPath = path.join(dir, "data.db");
    const firstDefinition = capsule({ name: "retained-maintenance", endpoints: { upload: endpoint({ method: "POST", path: "/removed", body: { multipart: ingressPolicy() } }, () => null) } });
    first = await openDevDatabase(dbPath, "", {}, { name: "retained-maintenance" }, firstDefinition);
    const staged = await stageMultipartIngress(first, first.endpoints[0], ingressRequest("retained-maintenance"), { headers: ingressRequest("retained-maintenance").headers }, { userId: "claim-user" });
    await expireIngressReceipt(first, staged.multipart.files[0].leaseId, "2030-01-01T00:00:30.000Z");
    await first.close(); first = null;

    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    second = await openDevDatabase(dbPath, "", {}, { name: "retained-maintenance" }, capsule({ name: "retained-maintenance" }), { clock });
    assert.equal(second.fileIngressEnabled, true, "durable lease enables maintenance without a current declaration");
    await second.init(); clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal(await second.adapter.selectIngressByLease(staged.multipart.files[0].leaseId), null);
    await second.shutdown(); await second.close(); second = null;

    legacy = await openDevDatabase(path.join(dir, "legacy.db"), "", {}, { name: "legacy" }, capsule({ name: "legacy" }), { clock: createControllableRuntimeClock("2030-01-01T00:00:00.000Z") });
    assert.equal(legacy.fileIngressEnabled, false, "a Capsule with no declaration or durable ingress stays maintenance-free");
    await legacy.init(); assert.equal(legacy.__ingressSweepTimer, undefined);
  } finally { await first?.close(); await second?.close(); await legacy?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown waits for an in-flight periodic ingress sweep before closing its lifecycle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-shutdown-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "sweep-shutdown", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "sweep-shutdown" }), { clock }); await database.init();
    const endpoint = { options: { method: "POST", path: "/sweep-shutdown", body: { multipart: ingressPolicy() } } };
    const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipart("sweep-shutdown", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-ID: stable', "bytes"); } }, { headers: { "content-type": "multipart/form-data; boundary=sweep-shutdown", "idempotency-key": "key" } }, { userId: "actor" });
    const row = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress] WHERE [leaseId] = ?").get(staged.multipart.files[0].leaseId)).payload); row.expiresAt = "2029-12-31T23:59:59.000Z"; await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [expiresAt] = ?, [payload] = ? WHERE [leaseId] = ?").run(row.expiresAt, JSON.stringify(row), row.leaseId);
    let release; const blocked = new Promise((resolve) => { release = resolve; }); let started; const entered = new Promise((resolve) => { started = resolve; }); const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage); database.fileStorage.deleteFileVersion = async (input) => { started(); await blocked; return await remove(input); };
    clock.advanceBy(60_000); const sweep = clock.runDueTimers(); await entered; let settled = false; const shutdown = database.shutdown().then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false); release(); await sweep; await shutdown; assert.equal(settled, true); clock.advanceBy(60_000); await clock.runDueTimers();
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress audit lifecycle is useful but never records upload secrets or error detail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-redaction-")); let database;
  const secret = "request-key-part-key-file-name-mime-secret-bytes-actor";
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-redaction", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "audit-redaction" }));
    const endpoint = { options: { method: "POST", path: "/audit", body: { multipart: ingressPolicy() } } };
    const headers = { "content-type": "multipart/form-data; boundary=audit", "idempotency-key": secret };
    await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipart("audit", `Content-Disposition: form-data; name="${secret}"; filename="${secret}.txt"\r\nContent-Type: text/${secret}\r\nContent-ID: ${secret}`, secret); } }, { headers }, { userId: secret });
    await assert.rejects(stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipart("audit", `Content-Disposition: form-data; name="file"; filename="${secret}.txt"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: ${secret}`, secret); } }, { headers }, { userId: secret }), { code: "INVALID_MULTIPART" });
    const events = (await database.log.tail(20)).filter((event) => event.event.startsWith("file.ingress."));
    assert.deepEqual(events.map((event) => event.event), ["file.ingress.started", "file.ingress.completed", "file.ingress.started", "file.ingress.failed"]);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.deepEqual(events.at(-1).data, { schema: "v1", outcome: "failed", code: "INVALID_MULTIPART" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("declared non-Content-ID part-key headers are case-insensitive and replay one stable lease", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-custom-part-key-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "custom-part-key", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "custom-part-key" }));
    const policy = { ...ingressPolicy(), partKeyHeader: "x-upload-part-key", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/custom-part-key", body: { multipart: policy } } };
    const headers = { "content-type": "multipart/form-data; boundary=custom-key", "idempotency-key": "stable-request" };
    const request = () => ({ async *[Symbol.asyncIterator]() { yield multipart("custom-key", 'Content-Disposition: form-data; name="file"; filename="custom.txt"\r\nContent-Type: text/plain\r\nX-UPLOAD-PART-KEY: <opaque>', "custom-bytes"); } });
    const first = await stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" });
    const replay = await stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" });
    assert.equal(replay.multipart.files[0].leaseId, first.multipart.files[0].leaseId);
    let receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(receipt.partKey, "<opaque>");
    const legacyEndpoint = { options: { method: "POST", path: "/legacy-content-id", body: { multipart: ingressPolicy() } } };
    const legacyHeaders = { "content-type": "multipart/form-data; boundary=legacy-key", "idempotency-key": "legacy-request" };
    const legacyRequest = { async *[Symbol.asyncIterator]() { yield multipart("legacy-key", 'Content-Disposition: form-data; name="file"; filename="legacy.txt"\r\nContent-Type: text/plain\r\nContent-ID: <legacy>', "legacy-bytes"); } };
    await stageMultipartIngress(database, legacyEndpoint, legacyRequest, { headers: legacyHeaders }, { userId: "actor" });
    receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress] WHERE [requestKey] = ?").get("legacy-request")).payload); assert.equal(receipt.partKey, "legacy");
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a later field-count failure compensates only File parts won by this local request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-local-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-cleanup-local", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-cleanup-local" }));
    const endpoint = { options: { method: "POST", path: "/request-cleanup", body: { multipart: { ...ingressPolicy(), maxFieldCount: 1 } } } };
    const headersFor = (requestKey) => ({ "content-type": "multipart/form-data; boundary=request-cleanup", "idempotency-key": requestKey });
    const file = { headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "cleanup-bytes" };
    const tag = (body) => ({ headers: 'Content-Disposition: form-data; name="tag"', body });
    const request = (parts) => ({ async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup", parts); } });
    const writes = []; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes.push(input); return await write(input); };
    await assert.rejects(stageMultipartIngress(database, endpoint, request([file, tag("a"), tag("b")]), { headers: headersFor("new-failure") }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
    await assert.rejects(access(path.join(dir, "files", writes[0].fileId, writes[0].version)));

    const prior = await stageMultipartIngress(database, endpoint, request([file]), { headers: headersFor("pre-existing") }, { userId: "actor" }); const priorWrite = writes.at(-1);
    await assert.rejects(stageMultipartIngress(database, endpoint, request([file, tag("a"), tag("b")]), { headers: headersFor("pre-existing") }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    assert.ok(prior.multipart.files[0].leaseId); await access(path.join(dir, "files", priorWrite.fileId, priorWrite.version));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a later field-count failure removes the request-owned fake-MinIO object and receipt", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-minio-")); let database; const namespace = `cleanup-${randomUUID()}`;
    try {
      const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } }; const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, config, capsule({ name: namespace }), { serviceEnv });
      const endpoint = { options: { method: "POST", path: "/request-cleanup-minio", body: { multipart: { ...ingressPolicy(), maxFieldCount: 1 } } } };
      const headers = { "content-type": "multipart/form-data; boundary=request-cleanup-minio", "idempotency-key": "minio-failure" };
      const parts = [
        { headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "cleanup-bytes" },
        { headers: 'Content-Disposition: form-data; name="tag"', body: "a" },
        { headers: 'Content-Disposition: form-data; name="tag"', body: "b" },
      ];
      const request = { async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup-minio", parts); } };
      await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
      assert.deepEqual([...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`)), []);
    } finally { await database?.close(); for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key); await rm(dir, { recursive: true, force: true }); }
  });
});

test("a parser disconnect after a completed File part compensates its request-owned staging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-disconnect-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-disconnect", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-disconnect" }));
    const endpoint = { options: { method: "POST", path: "/request-disconnect", body: { multipart: ingressPolicy() } } };
    const headers = { "content-type": "multipart/form-data; boundary=request-disconnect", "idempotency-key": "disconnect" };
    const bytes = Buffer.from('--request-disconnect\r\nContent-Disposition: form-data; name="file"; filename="disconnect.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-disconnect\r\n\r\nfile-bytes\r\n--request-disconnect\r\nContent-Disposition: form-data; name="tag"\r\n\r\ntruncated');
    const request = { async *[Symbol.asyncIterator]() { yield bytes; } };
    await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers }, { userId: "actor" }), { code: "INVALID_MULTIPART" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("request staging retains the primary parser error when compensation also fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-request-cleanup-error-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "request-cleanup-error", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "request-cleanup-error" }));
    const endpoint = { options: { method: "POST", path: "/request-cleanup-error", body: { multipart: { ...ingressPolicy(), maxFieldCount: 0 } } } };
    const headers = { "content-type": "multipart/form-data; boundary=request-cleanup-error", "idempotency-key": "cleanup-error" };
    const parts = [{ headers: 'Content-Disposition: form-data; name="file"; filename="cleanup.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-cleanup', body: "bytes" }, { headers: 'Content-Disposition: form-data; name="tag"', body: "a" }];
    const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage); database.fileStorage.deleteFileVersion = async () => { throw new Error("controlled cleanup failure"); };
    await assert.rejects(stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartMany("request-cleanup-error", parts); } }, { headers }, { userId: "actor" }), (error) => error instanceof AggregateError && error.errors[0]?.code === "MULTIPART_LIMIT_EXCEEDED" && /controlled cleanup failure/.test(error.errors[1]?.message));
    database.fileStorage.deleteFileVersion = remove;
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("maxFieldCount accepts the exact text-part boundary and rejects one repeated-name part beyond it without residue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-field-count-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "field-count", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "field-count" }));
    const endpoint = { options: { method: "POST", path: "/field-count", body: { multipart: { ...ingressPolicy(), maxFieldCount: 2 } } } };
    const headers = { "content-type": "multipart/form-data; boundary=fields", "idempotency-key": "field-request" };
    const part = (body) => ({ headers: 'Content-Disposition: form-data; name="tag"', body });
    const request = (parts) => ({ async *[Symbol.asyncIterator]() { yield multipartMany("fields", parts); } });
    const exact = await stageMultipartIngress(database, endpoint, request([part("a"), part("b")]), { headers }, { userId: "actor" });
    assert.deepEqual({ ...exact.multipart.fields }, { tag: ["a", "b"] });
    await assert.rejects(stageMultipartIngress(database, endpoint, request([part("a"), part("b"), part("c")]), { headers }, { userId: "actor" }), { code: "MULTIPART_LIMIT_EXCEEDED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("denied multipart admission does not advance the file-body source or create ingress state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-denied-"));
  try {
    const definition = endpoint({ method: "POST", path: "/denied", body: { multipart: { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true } } }, requireAuth(() => ({ body: { ok: true } })));
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "denied", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "denied" }));
    let reads = 0; const request = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "idempotency-key": "request" }, async *[Symbol.asyncIterator]() { reads += 1; yield multipart("x"); } };
    await assert.rejects(runEndpoint(database, { ...definition, options: definition.options }, new URL("http://localhost/denied"), request), { code: "UNAUTHENTICATED" });
    assert.equal(reads, 0); assert.equal(database.__sporadesIngressLeases, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("disconnects in every multipart parser state reject without yielding a staged part", async () => {
  const boundary = "cut";
  const cuts = [Buffer.from(`--${boundary}`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\npayload`), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\npayload\r\n--${boundary}`)];
  for (const bytes of cuts) {
    const yielded = [];
    await assert.rejects(async () => { for await (const part of multipartParts(splitEvery(bytes, 1), boundary, 1000, 1000)) yielded.push(part); }, { code: "INVALID_MULTIPART" });
    assert.deepEqual(yielded, []);
  }
});

test("twenty concurrent identical ingress receipts stage one durable lease", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-race-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "race", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "race" }));
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/race", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=race", "idempotency-key": "same" };
    let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const partHeaders = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-a';
    const makeRequest = () => ({ async *[Symbol.asyncIterator]() { yield multipart("race", partHeaders, "same-bytes"); } });
    const results = await Promise.all(Array.from({ length: 20 }, () => stageMultipartIngress(database, endpoint, makeRequest(), { headers }, { userId: "actor" })));
    assert.equal(new Set(results.map((result) => result.multipart.files[0].leaseId)).size, 1); assert.equal(writes, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("staging publication CAS compensates its object when sweep or deletion wins", async () => {
  for (const mode of ["sweeping", "deleted"]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-ingress-publish-${mode}-`)); let database;
    try {
      database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: `publish-${mode}`, files: { storagePath: path.join(dir, "files") } }, capsule({ name: `publish-${mode}` })); const endpoint = { options: { method: "POST", path: "/publish", body: { multipart: ingressPolicy() } } }; let deletes = 0;
      const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage);
      database.fileStorage.deleteFileVersion = async (input) => { deletes += 1; return await remove(input); };
      database.fileStorage.writeFileVersion = async (input) => { await write(input); const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const row = JSON.parse(stored.payload); if (mode === "deleted") await database.adapter.prepare("DELETE FROM [sporades_file_ingress] WHERE [key] = ?").run(stored.key); else await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [state]='sweeping', [payload]=? WHERE [key]=?").run(JSON.stringify({ ...row, state: "sweeping" }), stored.key); };
      const request = { async *[Symbol.asyncIterator]() { yield multipart("publish", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-ID: stable', "bytes"); } };
      await assert.rejects(stageMultipartIngress(database, endpoint, request, { headers: { "content-type": "multipart/form-data; boundary=publish", "idempotency-key": mode } }, { userId: "actor" }), { code: "INGRESS_STAGING_INCOMPLETE" }); assert.ok(deletes >= 1);
      const rows = await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress]").all(); assert.equal(rows.some((row) => row.state === "leased"), false);
    } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("a retry waits beyond the former polling window for the durable staging winner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-slow-winner-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "slow-winner", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "slow-winner" }));
    const endpoint = { options: { method: "POST", path: "/slow", body: { multipart: ingressPolicy() } } }; const headers = { "content-type": "multipart/form-data; boundary=slow", "idempotency-key": "same" };
    const original = database.fileStorage.writeFileVersion.bind(database.fileStorage); let writes = 0;
    database.fileStorage.writeFileVersion = async (input) => { writes += 1; await new Promise((resolve) => setTimeout(resolve, 2300)); return await original(input); };
    const request = () => ({ async *[Symbol.asyncIterator]() { yield multipart("slow", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable', "bytes"); } });
    const [winner, retry] = await Promise.all([stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" }), stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" })]);
    assert.equal(retry.multipart.files[0].leaseId, winner.multipart.files[0].leaseId); assert.equal(writes, 1);
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const row = JSON.parse(stored.payload);
    for (const replacement of [{ ...row, state: "staging", expiresAt: "2000-01-01T00:00:00.000Z" }, { ...row, state: "failed", retryable: false }]) {
      await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(replacement), stored.key);
      const started = Date.now(); await assert.rejects(stageMultipartIngress(database, endpoint, request(), { headers }, { userId: "actor" }), { code: "INGRESS_STAGING_INCOMPLETE" }); assert.ok(Date.now() - started < 500);
    }
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("multipart Content-Type accepts RFC quoted boundaries and rejects malformed declarations before reading", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-content-type-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "content-type", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "content-type" }));
    const endpoint = { options: { method: "POST", path: "/quoted", body: { multipart: ingressPolicy() } } }; const boundary = "quoted:boundary";
    const result = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipart(boundary, 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable', "bytes"); } }, { headers: { "content-type": `multipart/form-data; boundary="${boundary}"`, "idempotency-key": "quoted" } }, { userId: "actor" });
    assert.equal(result.multipart.files.length, 1);
    for (const contentType of ['multipart/form-data; boundary="unterminated', 'multipart/form-data; boundary="bad\\"escape"', 'multipart/form-data; boundary=bad!boundary', 'multipart/form-data; boundary=bad|boundary', 'multipart/form-data; boundary=bad~boundary', `multipart/form-data; boundary=${"x".repeat(71)}`]) {
      let reads = 0; await assert.rejects(stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { reads += 1; if (false) yield Buffer.alloc(0); } }, { headers: { "content-type": contentType, "idempotency-key": "bad" } }, { userId: "actor" }), { code: "INVALID_MULTIPART" }); assert.equal(reads, 0);
    }
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed ingress claim rolls File, receipt claim, and app row back together", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-rollback-")); let fail = true;
  try {
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const definition = capsule({ name: "rollback", schema: { effects: table({ source: StringField() }) }, endpoints: { upload: endpoint({ method: "POST", path: "/rollback", body: { multipart: policy } }, requireAuth(async (ctx) => { const file = await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/retry.txt" }); await ctx.db.effects.insert({ source: "claimed" }); if (fail) throw new Error("rollback sentinel"); return file; })) } });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "rollback", files: { storagePath: path.join(dir, "files") } }, definition);
    await database.adapter.insertAuthUser({ id: "user", createdAt: new Date().toISOString(), displayName: "user", email: "u@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" }); await database.adapter.insertAuthSession({ token: "session", userId: "user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const route = database.endpoints[0]; const headers = { "content-type": "multipart/form-data; boundary=rollback", "idempotency-key": "retry", "x-sporades-session-token": "session" }; const request = () => ({ method: "POST", headers, async *[Symbol.asyncIterator]() { yield multipart("rollback", 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable', "bytes"); } });
    await assert.rejects(runEndpoint(database, route, new URL("http://capsule.test/rollback"), request()), /rollback sentinel/);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), 0); let receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(receipt.state, "leased"); assert.equal(receipt.file, undefined);
    fail = false; const result = await runEndpoint(database, route, new URL("http://capsule.test/rollback"), request()); receipt = JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [effects]").get()).count), 1); assert.equal(receipt.state, "complete"); assert.equal(receipt.file.id, result.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("committed ingress claims enqueue one durable completed audit per claim across middleware, retries, and logger failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-outbox-")); let database;
  try {
    const policy = { ...ingressPolicy(), maxFiles: 2, maxTotalFileBytes: 200 };
    const definition = capsule({ name: "audit-outbox", context: [async (ctx) => ({ ...ctx })], endpoints: { upload: endpoint({ method: "POST", path: "/audit-outbox", body: { multipart: policy } }, requireAuth(async (ctx) => {
      const files = [];
      for (const lease of ctx.request.multipart.files) files.push(await ctx.files.claim(lease, { path: `/attachments/${lease.partId}.txt` }));
      return files;
    })) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-outbox", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    const source = multipartMany("audit-outbox", [
      { headers: 'Content-Disposition: form-data; name="first"; filename="first.txt"\r\nContent-ID: first', body: "first" },
      { headers: 'Content-Disposition: form-data; name="second"; filename="second.txt"\r\nContent-ID: second', body: "second" },
    ]);
    const request = () => ({ method: "POST", headers: { "content-type": "multipart/form-data; boundary=audit-outbox", "idempotency-key": "audit-outbox", "x-sporades-session-token": "claim-session" }, async *[Symbol.asyncIterator]() { yield source; } });
    const originalEmit = database.log.emit.bind(database.log); let failDelivery = true;
    database.log.emit = async (event) => { if (event.event === "file.ingress.completed" && failDelivery) throw new Error("audit sink unavailable"); return await originalEmit(event); };
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-outbox"), request());
    assert.equal((await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed").length, 0);
    failDelivery = false;
    await database.close();
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-outbox", files: { storagePath: path.join(dir, "files") } }, definition);
    await database.init();
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-outbox"), request());
    const completed = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed");
    assert.equal(completed.length, 2);
    assert.ok(completed.every((event) => event.data?.schema === "v1" && event.data?.outcome === "claimed" && /^v1:[a-f0-9]{64}$/.test(event.data?.deliveryId)));
    assert.notEqual(completed[0].data.deliveryId, completed[1].data.deliveryId);
    assert.equal(JSON.stringify(completed).includes("first.txt"), false);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rolled-back ingress claims leave no completed audit intent to replay after startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-rollback-")); let database;
  try {
    const definition = capsule({ name: "audit-rollback", endpoints: { upload: endpoint({ method: "POST", path: "/audit-rollback", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => { await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/rollback.txt" }); throw new Error("rollback"); })) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-rollback", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    await assert.rejects(runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-rollback"), ingressRequest("audit-rollback")), /rollback/);
    await database.init();
    assert.equal((await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed").length, 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a live runtime retries a failed ingress audit drain on its clock without another endpoint commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-clock-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    const definition = capsule({ name: "audit-clock", endpoints: { upload: endpoint({ method: "POST", path: "/audit-clock", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/clock.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-clock", files: { storagePath: path.join(dir, "files") } }, definition, { clock }); await seedIngressUser(database); await database.init();
    const originalEmit = database.log.emit.bind(database.log); let fail = true;
    database.log.emit = async (event) => { if (event.event === "file.ingress.completed" && fail) throw new Error("sink unavailable"); return await originalEmit(event); };
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-clock"), ingressRequest("audit-clock"));
    fail = false; clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal((await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed").length, 1);
    await database.shutdown(); clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal((await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed").length, 1);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a live runtime releases an acknowledgement-failed audit delivery for timer retry with the same opaque key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-ack-clock-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    const definition = capsule({ name: "audit-ack-clock", endpoints: { upload: endpoint({ method: "POST", path: "/audit-ack-clock", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/ack-clock.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-ack-clock", files: { storagePath: path.join(dir, "files") } }, definition, { clock }); await seedIngressUser(database); await database.init();
    const originalDeliver = database.adapter.deliverIngressClaimAudit.bind(database.adapter); let failAck = true;
    database.adapter.deliverIngressClaimAudit = async (...args) => { if (failAck) throw new Error("ack unavailable"); return await originalDeliver(...args); };
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-ack-clock"), ingressRequest("audit-ack-clock"));
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "pending");
    failAck = false; clock.advanceBy(60_000); await clock.runDueTimers();
    const completed = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed");
    assert.equal(completed.length, 2); assert.equal(completed[0].data.deliveryId, completed[1].data.deliveryId);
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "delivered");
    await database.shutdown(); clock.advanceBy(60_000); await clock.runDueTimers();
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a live runtime retries transient startup outbox recovery without an endpoint or restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-recovery-clock-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-recovery-clock", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "audit-recovery-clock" }), { clock });
    await database.adapter.prepare("INSERT INTO [sporades_file_ingress_audit_outbox] ([claimId], [state], [claimToken], [createdAt], [updatedAt], [deliveredAt]) VALUES ('v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'delivering', 'interrupted', ?, ?, NULL)").run("2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z");
    const originalRecover = database.adapter.recoverIngressClaimAudits.bind(database.adapter); let failRecovery = true;
    database.adapter.recoverIngressClaimAudits = async (...args) => { if (failRecovery) throw new Error("temporary recovery adapter failure"); return await originalRecover(...args); };
    await database.init();
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "delivering");
    failRecovery = false; clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "delivered");
    const completed = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed");
    assert.equal(completed.length, 1); assert.equal(completed[0].data.deliveryId, "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await database.shutdown();
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("logger and release failures rearm live recovery for the stranded audit claim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-release-clock-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    const definition = capsule({ name: "audit-release-clock", endpoints: { upload: endpoint({ method: "POST", path: "/audit-release-clock", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/release.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-release-clock", files: { storagePath: path.join(dir, "files") } }, definition, { clock }); await seedIngressUser(database); await database.init();
    const emit = database.log.emit.bind(database.log); const release = database.adapter.releaseIngressClaimAudit.bind(database.adapter); let failEmit = true; let failRelease = true;
    database.log.emit = async (event) => event.event === "file.ingress.completed" && failEmit ? Promise.reject(new Error("emit failed")) : emit(event);
    database.adapter.releaseIngressClaimAudit = async (...args) => { if (failRelease) throw new Error("release failed"); return await release(...args); };
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-release-clock"), ingressRequest("audit-release-clock"));
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "delivering");
    failEmit = false; failRelease = false; clock.advanceBy(60_000); await clock.runDueTimers();
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox]").get()).state, "delivered");
    assert.equal((await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed").length, 1);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("startup and periodic ingress sweep selection failures emit one safe cleanup warning and later recover", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-selection-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "sweep-selection", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "sweep-selection" }), { clock });
    const select = database.adapter.selectIngressSweepCandidates.bind(database.adapter); let fail = true;
    database.adapter.selectIngressSweepCandidates = async (...args) => { if (fail) throw new Error("secret selection failure"); return await select(...args); };
    await database.init();
    let warnings = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.cleanup-failed");
    assert.deepEqual(warnings.map((event) => event.data), [{ schema: "v1", outcome: "failed", code: "INGRESS_SWEEP_STORAGE_FAILED" }]);
    assert.equal(JSON.stringify(warnings).includes("secret selection failure"), false);
    fail = false; clock.advanceBy(60_000); await clock.runDueTimers();
    warnings = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.cleanup-failed"); assert.equal(warnings.length, 1);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress audit recovery may duplicate after an emit-before-ack crash, with one opaque delivery key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-crash-")); let database;
  try {
    const definition = capsule({ name: "audit-crash", endpoints: { upload: endpoint({ method: "POST", path: "/audit-crash", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/crash.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-crash", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    database.adapter.deliverIngressClaimAudit = async () => { throw new Error("simulated process crash after JSONL emit"); };
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-crash"), ingressRequest("audit-crash"));
    await database.close();
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-crash", files: { storagePath: path.join(dir, "files") } }, definition); await database.init();
    const completed = (await database.log.tail(50)).filter((event) => event.event === "file.ingress.completed" && event.data?.outcome === "claimed");
    assert.equal(completed.length, 2);
    assert.equal(completed[0].data.deliveryId, completed[1].data.deliveryId);
    assert.match(completed[0].data.deliveryId, /^v1:[a-f0-9]{64}$/);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("outbox retention prunes delivered intents in bounded batches without touching pending work or re-enqueuing completed claims", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-retention-")); let database;
  try {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    const definition = capsule({ name: "audit-retention", endpoints: { upload: endpoint({ method: "POST", path: "/audit-retention", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/retention.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "audit-retention", files: { storagePath: path.join(dir, "files") } }, definition, { clock }); await seedIngressUser(database); await database.init();
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-retention"), ingressRequest("audit-retention"));
    for (let index = 0; index < 55; index += 1) await database.adapter.prepare("INSERT INTO [sporades_file_ingress_audit_outbox] ([claimId], [state], [claimToken], [createdAt], [updatedAt], [deliveredAt]) VALUES (?, 'delivered', NULL, ?, ?, ?)").run(`old-${index}`, "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z");
    await database.adapter.prepare("INSERT INTO [sporades_file_ingress_audit_outbox] ([claimId], [state], [claimToken], [createdAt], [updatedAt], [deliveredAt]) VALUES ('pending-keep', 'pending', NULL, ?, ?, NULL), ('delivering-keep', 'delivering', 'token', ?, ?, NULL)").run("2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z");
    const originalEmit = database.log.emit.bind(database.log); database.log.emit = async (event) => event.event === "file.ingress.completed" ? Promise.reject(new Error("keep pending")) : originalEmit(event);
    clock.advanceBy(24 * 60 * 60 * 1000); await clock.runDueTimers();
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress_audit_outbox] WHERE [state] = 'delivered'").get()).count), 6);
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox] WHERE [claimId] = 'pending-keep'").get()).state, "pending");
    assert.equal((await database.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox] WHERE [claimId] = 'delivering-keep'").get()).state, "delivering");
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/audit-retention"), ingressRequest("audit-retention"));
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress_audit_outbox] WHERE [state] = 'delivered'").get()).count), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress_audit_outbox] WHERE [state] = 'pending'").get()).count), 1);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a removed ingress surface retains one durable audit-prune wake until delivered rows expire", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-retention-restart-")); let first; let replacement;
  try {
    const dbPath = path.join(dir, "data.db");
    first = await openDevDatabase(dbPath, "", {}, { name: "audit-retention-restart" }, capsule({ name: "audit-retention-restart", endpoints: { upload: endpoint({ method: "POST", path: "/removed", body: { multipart: ingressPolicy() } }, () => null) } }));
    await first.adapter.prepare("INSERT INTO [sporades_file_ingress_audit_outbox] ([claimId], [state], [claimToken], [createdAt], [updatedAt], [deliveredAt]) VALUES ('retained-delivered', 'delivered', NULL, ?, ?, ?)").run("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    await first.close(); first = null;

    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    replacement = await openDevDatabase(dbPath, "", {}, { name: "audit-retention-restart" }, capsule({ name: "audit-retention-restart" }), { clock });
    assert.equal(replacement.fileIngressEnabled, false, "a delivered audit does not retain scanner or ingress-sweep resources");
    await replacement.init();
    assert.notEqual(replacement.__ingressAuditOutboxTimer, null, "retention keeps one deadline wake");
    clock.advanceBy(24 * 60 * 60 * 1000 - 1); await clock.runDueTimers();
    assert.equal((await replacement.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox] WHERE [claimId] = 'retained-delivered'").get()).state, "delivered");
    clock.advanceBy(1); await clock.runDueTimers();
    assert.equal(await replacement.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox] WHERE [claimId] = 'retained-delivered'").get(), undefined);
    assert.equal(replacement.__ingressAuditOutboxTimer, null, "an empty outbox disarms audit maintenance");
    clock.advanceBy(7 * 24 * 60 * 60 * 1000); await clock.runDueTimers();
    assert.equal(replacement.__ingressAuditOutboxTimer, null, "an empty outbox does not recreate an idle maintenance loop");
  } finally { await first?.close(); await replacement?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a removed ingress surface prunes already-due delivered audits during restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-audit-retention-due-restart-")); let first; let replacement;
  try {
    const dbPath = path.join(dir, "data.db");
    first = await openDevDatabase(dbPath, "", {}, { name: "audit-retention-due-restart" }, capsule({ name: "audit-retention-due-restart", endpoints: { upload: endpoint({ method: "POST", path: "/removed", body: { multipart: ingressPolicy() } }, () => null) } }));
    await first.adapter.prepare("INSERT INTO [sporades_file_ingress_audit_outbox] ([claimId], [state], [claimToken], [createdAt], [updatedAt], [deliveredAt]) VALUES ('due-delivered', 'delivered', NULL, ?, ?, ?)").run("2029-12-30T00:00:00.000Z", "2029-12-30T00:00:00.000Z", "2029-12-30T00:00:00.000Z");
    await first.close(); first = null;

    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    replacement = await openDevDatabase(dbPath, "", {}, { name: "audit-retention-due-restart" }, capsule({ name: "audit-retention-due-restart" }), { clock });
    assert.equal(replacement.fileIngressEnabled, false);
    await replacement.init();
    assert.equal(await replacement.adapter.prepare("SELECT [state] FROM [sporades_file_ingress_audit_outbox] WHERE [claimId] = 'due-delivered'").get(), undefined);
  } finally { await first?.close(); await replacement?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("concurrent incompatible ingress descriptors keep one winner and stage no loser bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-conflict-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "conflict", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "conflict" }));
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/conflict", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=conflict", "idempotency-key": "same" };
    let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const request = (name, type, body) => ({ async *[Symbol.asyncIterator]() { yield multipart("conflict", `Content-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\nContent-ID: stable-a`, body); } });
    const attempts = Array.from({ length: 20 }, (_, index) => index % 2 ? stageMultipartIngress(database, endpoint, request("one.txt", "text/plain", "one"), { headers }, { userId: "actor" }) : stageMultipartIngress(database, endpoint, request("two.bin", "application/octet-stream", "two"), { headers }, { userId: "actor" }));
    const settled = await Promise.allSettled(attempts); const winners = settled.filter((result) => result.status === "fulfilled"); const losers = settled.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 10); assert.equal(losers.length, 10); assert.equal(writes, 1); assert.ok(losers.every((result) => result.reason?.code === "INGRESS_DESCRIPTOR_CONFLICT"));
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("response loss and reopen recover the same private ingress lease without another write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-reopen-"));
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "reopen", files: { storagePath: path.join(dir, "files") } }; const definition = capsule({ name: "reopen" });
    const policy = { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
    const endpoint = { options: { method: "POST", path: "/reopen", body: { multipart: policy } } }; const headers = { "content-type": "multipart/form-data; boundary=reopen", "idempotency-key": "same" }; const partHeaders = 'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-a';
    const request = () => ({ async *[Symbol.asyncIterator]() { yield multipart("reopen", partHeaders, "persisted"); } });
    let writes = 0; let first = await openDevDatabase(dbPath, "", {}, config, definition); const write = first.fileStorage.writeFileVersion.bind(first.fileStorage); first.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    await stageMultipartIngress(first, endpoint, request(), { headers }, { userId: "actor" }); await first.close(); first = null;
    const second = await openDevDatabase(dbPath, "", {}, config, definition); const retry = await stageMultipartIngress(second, endpoint, request(), { headers }, { userId: "actor" });
    assert.equal(writes, 1); assert.equal(Number((await second.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1); const receipt = JSON.parse((await second.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload); assert.equal(retry.multipart.files[0].leaseId, receipt.leaseId); assert.equal(await second.adapter.selectFileById(receipt.fileId), null); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pre-authority actor receipt keys recover leased and completed retries without duplicate state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-legacy-actor-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const actorId = "legacy-actor"; const endpointPath = "/legacy"; const partKey = "stable-claim"; const bytes = Buffer.from("claim-bytes");
    const oldDatabase = new DatabaseSync(dbPath);
    oldDatabase.exec("CREATE TABLE [sporades_file_ingress] ([key] TEXT PRIMARY KEY, [payload] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
    const makeReceipt = (requestKey, state, fileId, version) => {
      const key = `POST:${endpointPath}:${actorId}:${requestKey}:${partKey}`;
      const row = { key, leaseId: `lease-${requestKey}`, partId: createHash("sha256").update(key).digest("hex"), fieldName: "file", name: "claim.txt", type: "text/plain", size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), fileId, version, state, actorId, endpointMethod: "POST", endpointPath, requestKey, partKey, expiresAt: "2099-01-01T00:00:00.000Z" };
      oldDatabase.prepare("INSERT INTO [sporades_file_ingress] ([key], [payload], [updatedAt]) VALUES (?, ?, ?)").run(key, JSON.stringify(row), "2026-01-01T00:00:00.000Z"); return row;
    };
    const leased = makeReceipt("legacy-leased", "leased", "legacy-leased-file", "legacy-leased-version");
    const completed = makeReceipt("legacy-complete", "complete", "legacy-complete-file", "legacy-complete-version");
    completed.file = { id: completed.fileId, ownerId: actorId, bucketId: "legacy-bucket", bucketName: "default", path: "/attachments/legacy-complete.txt", name: completed.name, type: completed.type, size: completed.size, version: completed.version, status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    oldDatabase.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(completed), completed.key); oldDatabase.close();
    const definition = capsule({ name: "legacy-actor", endpoints: {
      upload: endpoint(
        { method: "POST", path: endpointPath, body: { multipart: ingressPolicy() } },
        requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], {
          path: ctx.request.headers["idempotency-key"] === "legacy-complete" ? "/attachments/legacy-complete.txt" : "/attachments/legacy-leased.txt",
        })),
      ),
    } });
    const config = { name: "legacy-actor", files: { storagePath: path.join(dir, "files") } };
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    await database.adapter.insertAuthUser({ id: actorId, createdAt: new Date().toISOString(), displayName: "legacy", email: "legacy@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "claim-session", userId: actorId, provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    await database.fileStorage.writeFileVersion({ fileId: leased.fileId, version: leased.version, bytes });
    await database.adapter.createFileBucket({ id: "legacy-bucket", ownerId: actorId, name: "default", createdAt: "2026-01-01T00:00:00.000Z" });
    await database.adapter.insertFileRow(completed.file); await database.close(); database = null;
    database = await openDevDatabase(dbPath, "", {}, config, definition); let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const statusApi = (requestKey) => createEndpointIngressApi(database, database.endpoints[0], { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId, ownerId: actorId } }, { auth: { userId: actorId, isAuthenticated: true, isGuest: false } });
    const leasedStatus = await statusApi("legacy-leased").status("legacy-leased", partKey); assert.equal(leasedStatus.state, "leased"); assert.equal(leasedStatus.lease.leaseId, leased.leaseId);
    const completedStatus = await statusApi("legacy-complete").status("legacy-complete", partKey); assert.equal(completedStatus.state, "complete"); assert.equal(completedStatus.file.id, completed.fileId);
    const leasedRetry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/legacy"), ingressRequest("legacy-leased"));
    const completedRetry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/legacy"), ingressRequest("legacy-complete"));
    assert.equal(leasedRetry.id, leased.fileId); assert.equal(completedRetry.id, completed.fileId); assert.equal(writes, 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 2); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 2);
    assert.equal((await database.adapter.selectIngressByLease(leased.leaseId)).key, leased.key); assert.equal((await database.adapter.selectIngressByLease(completed.leaseId)).key, completed.key);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("trusted multipart ingress leases bytes before the handler and claim atomically creates an ordinary private File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-")); let server;
  try {
    const definition = capsule({ name: "ingress", endpoints: {
      upload: endpoint({ method: "POST", path: "/upload", body: { multipart: { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true } } }, requireAuth(async (ctx) => {
        assert.equal(ctx.request.body, null); assert.equal(ctx.request.multipart.files.length, 1);
        const file = await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/a.txt" });
        return { body: file };
      })),
    } });
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "ingress", files: { storagePath: path.join(dir, "files") } }, definition);
    await database.adapter.insertAuthUser({ id: "user", createdAt: new Date().toISOString(), displayName: "user", email: "u@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
    await database.adapter.insertAuthSession({ token: "session", userId: "user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    server = createServer(async (req, res) => { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const { port } = server.address();
    const boundary = "ingress-boundary"; const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\nContent-ID: a\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const response = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": "request-a", "x-sporades-session-token": "session" }, body });
    const responseBody = await response.json();
    if (response.status !== 200) console.log(await database.log.tail(20));
    assert.equal(response.status, 200, JSON.stringify(responseBody)); const file = responseBody;
    assert.equal(file.path, "/attachments/a.txt"); assert.equal((await database.adapter.selectFileById(file.id)).status, "uploaded");
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

function ingressPolicy() {
  return { maxFiles: 1, maxFileBytes: 100, maxTotalFileBytes: 100, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true };
}

async function seedIngressUser(database) {
  await database.adapter.insertAuthUser({ id: "claim-user", createdAt: new Date().toISOString(), displayName: "claim user", email: "claim@example.com", picture: null, isAuthenticated: 1, isGuest: 0, provider: "email" });
  await database.adapter.insertAuthSession({ token: "claim-session", userId: "claim-user", provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
}

function ingressRequest(requestKey = "claim-request") {
  const headers = { "content-type": "multipart/form-data; boundary=claim", "idempotency-key": requestKey, "x-sporades-session-token": "claim-session" };
  return { method: "POST", headers, async *[Symbol.asyncIterator]() { yield multipart("claim", 'Content-Disposition: form-data; name="file"; filename="claim.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim', "claim-bytes"); } };
}

async function seedIngressAccessKey(database, ownerUserId = "service-owner") {
  await database.adapter.insertAuthUser({ id: ownerUserId, createdAt: new Date().toISOString(), displayName: "service owner", email: null, picture: null, isAuthenticated: 1, isGuest: 0, provider: "service" });
  const secret = createAccessKeySecret();
  assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({
    id: "service-ingress-key", ownerUserId, name: "service ingress", reservedName: "service ingress",
    grantsJson: JSON.stringify(["attachments:write"]), secretVersion: 1, selector: secret.selector,
    verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier), lifecycleRevision: 1,
    createdAt: new Date().toISOString(), expiresAt: null,
  })), { status: "issued" });
  return secret.token;
}

function accessKeyIngressRequest(token, requestKey = "service-request") {
  const request = ingressRequest(requestKey);
  delete request.headers["x-sporades-session-token"];
  request.headers.authorization = `Bearer ${token}`;
  request.rawHeaders = Object.entries(request.headers).flatMap(([name, value]) => [name, value]);
  return request;
}

async function expireIngressReceipt(database, leaseId, expiresAt = "2000-01-01T00:00:00.000Z") {
  const stored = await database.adapter.selectIngressByLease(leaseId); const payload = JSON.parse(stored.payload); payload.expiresAt = expiresAt;
  await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [expiresAt] = ?, [payload] = ? WHERE [leaseId] = ?").run(expiresAt, JSON.stringify(payload), leaseId);
  return payload;
}

test("Capsule ingress owners are deterministic reserved identities with no login or access-key surface", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-reserved-owner-")); let database;
  try {
    const ownerId = capsuleIngressAuthUserId("reserved-owner");
    assert.equal(ownerId, capsuleIngressAuthUserId("reserved-owner"));
    assert.notEqual(ownerId, capsuleIngressAuthUserId("another-capsule"));
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "reserved-owner", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "reserved-owner" }));
    assert.throws(() => database.adapter.insertAuthUser({ id: ownerId, createdAt: new Date().toISOString(), displayName: "forbidden", email: null, picture: null, isAuthenticated: 1, isGuest: 0, provider: "service" }), { code: "RESERVED_AUTH_USER_ID" });
    assert.throws(() => database.adapter.insertAuthSession({ token: "forbidden", userId: ownerId, provider: "service", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" }), { code: "RESERVED_AUTH_USER_ID" });
    const secret = createAccessKeySecret();
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id: "forbidden-key", ownerUserId: ownerId, name: "forbidden", reservedName: "forbidden", grantsJson: "[]", secretVersion: 1, selector: secret.selector, verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier), lifecycleRevision: 1, createdAt: new Date().toISOString(), expiresAt: null })), { status: "owner-ineligible" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?").get(ownerId)).count), 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a scoped service-user Access key claims a File owned by that non-session actor across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-service-owner-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "service-owner", files: { storagePath: path.join(dir, "files") }, accessKeys: { enabled: true } };
    const definition = capsule({ name: "service-owner", accessKeys: { scopes: ["attachments:write"] }, endpoints: { upload: endpoint({ method: "POST", path: "/service", body: { multipart: ingressPolicy() } }, requireAuth({ credentials: ["access-key"], scopes: ["attachments:write"] }, async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/service.txt" }))) } });
    database = await openDevDatabase(dbPath, "", {}, config, definition); const token = await seedIngressAccessKey(database);
    const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/service"), accessKeyIngressRequest(token));
    assert.equal((await database.adapter.selectFileById(first.id)).ownerId, "service-owner");
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [userId] = ?").get("service-owner")).count), 0);
    await database.close(); database = await openDevDatabase(dbPath, "", {}, config, definition);
    const retry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/service"), accessKeyIngressRequest(token));
    assert.equal(retry.id, first.id); assert.equal((await database.adapter.selectFileById(first.id)).ownerId, "service-owner");
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal claims persist a reserved owner and digest, never the raw principal key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-owner-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "principal-owner", files: { storagePath: path.join(dir, "files") } };
    const definition = capsule({ name: "principal-owner", files: { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ["application"], admit: ({ request }) => ({ allow: true, principal: { namespace: "application", key: request.headers["x-app-key"] } }) } }, endpoints: { upload: endpoint({ method: "POST", path: "/principal", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/principal.txt", authority: { kind: "capsule-principal", ...ctx.ingress.principal } })) } });
    const request = () => { const value = ingressRequest("principal-request"); delete value.headers["x-sporades-session-token"]; value.headers["x-app-key"] = "app-a-secret"; return value; };
    database = await openDevDatabase(dbPath, "", {}, config, definition); const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/principal"), request());
    const ownerId = capsuleIngressAuthUserId("principal-owner"); const receipt = await database.adapter.selectIngressByLease(JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload).leaseId);
    assert.equal((await database.adapter.selectFileById(first.id)).ownerId, ownerId); assert.equal(receipt.ownerId, ownerId); assert.equal(receipt.authorityKind, "capsule-principal"); assert.equal(receipt.principalNamespace, "application"); assert.equal(JSON.stringify(receipt).includes("app-a-secret"), false); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_users] WHERE [id] = ?").get(ownerId)).count), 0);
    await database.close(); database = await openDevDatabase(dbPath, "", {}, config, definition); const retry = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/principal"), request());
    assert.equal(retry.id, first.id); assert.equal((await database.adapter.selectFileById(first.id)).ownerId, ownerId);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal status reports its leased and completed receipt while a wrong principal sees opaque missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-status-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "principal-status", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "principal-status" }));
    const endpoint = { options: { method: "POST", path: "/principal-status", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } } };
    const principalKey = "principal-status-key"; const namespace = "application";
    const authority = Object.freeze({ kind: "capsule-principal", namespace, key: principalKey, keyDigest: createHash("sha256").update(`${namespace}\0${principalKey}`, "utf8").digest("hex"), ownerId: database.capsuleIngressOwnerId });
    const request = ingressRequest("principal-status-request"); delete request.headers["x-sporades-session-token"];
    const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "" }, authority);
    const endpointRequest = { __ingressRequestKey: "principal-status-request", __ingressAuthority: authority };
    const api = createEndpointIngressApi(database, endpoint, endpointRequest, { auth: { userId: "", isAuthenticated: false, isGuest: true } });
    const leased = await api.status("principal-status-request", "stable-claim");
    assert.equal(leased.state, "leased"); assert.equal(leased.lease.leaseId, staged.multipart.files[0].leaseId);
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const consistent = JSON.parse(stored.payload); const inconsistent = { ...consistent, ownerId: "internal-wrong-owner" };
    for (const [state, retryable] of [["expired", true], ["sweeping", true], ["failed", false], ["staging", true]]) {
      await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify({ ...consistent, state }), stored.key);
      assert.deepEqual(await api.status("principal-status-request", "stable-claim"), { state: "failed", retryable });
    }
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify({ ...consistent, expiresAt: "2000-01-01T00:00:00.000Z" }), stored.key);
    assert.deepEqual(await api.status("principal-status-request", "stable-claim"), { state: "failed", retryable: true });
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(inconsistent), stored.key);
    assert.deepEqual(await api.status("principal-status-request", "stable-claim"), { state: "missing" });
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(consistent), stored.key);
    const file = await api.claim(staged.multipart.files[0], { path: "/attachments/principal-status.txt", authority: { kind: "capsule-principal", namespace, key: principalKey } });
    const completed = await api.status("principal-status-request", "stable-claim");
    assert.equal(completed.state, "complete"); assert.equal(completed.file.id, file.id);
    const wrongKey = "wrong-principal";
    const wrongAuthority = Object.freeze({ kind: "capsule-principal", namespace, key: wrongKey, keyDigest: createHash("sha256").update(`${namespace}\0${wrongKey}`, "utf8").digest("hex"), ownerId: database.capsuleIngressOwnerId });
    const wrongApi = createEndpointIngressApi(database, endpoint, { ...endpointRequest, __ingressAuthority: wrongAuthority }, { auth: { userId: "", isAuthenticated: false, isGuest: true } });
    assert.deepEqual(await wrongApi.status("principal-status-request", "stable-claim"), { state: "missing" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("pre-v2 Capsule-principal receipts replay leased and completed state without a second receipt or object", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-legacy-principal-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "legacy-principal", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "legacy-principal" }));
    const endpoint = { options: { method: "POST", path: "/legacy-principal", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } } };
    const namespace = "application"; const principalKey = "legacy-secret"; const keyDigest = createHash("sha256").update(`${namespace}\0${principalKey}`, "utf8").digest("hex");
    const authority = Object.freeze({ kind: "capsule-principal", namespace, key: principalKey, keyDigest, ownerId: database.capsuleIngressOwnerId });
    const request = () => { const value = ingressRequest("legacy-principal-request"); delete value.headers["x-sporades-session-token"]; return value; };
    let writes = 0; const write = database.fileStorage.writeFileVersion.bind(database.fileStorage); database.fileStorage.writeFileVersion = async (input) => { writes += 1; return await write(input); };
    const first = await stageMultipartIngress(database, endpoint, request(), { headers: request().headers }, { userId: "" }, authority);
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const row = JSON.parse(stored.payload);
    const legacyKey = `POST:/legacy-principal:capsule:${namespace}:${keyDigest}:legacy-principal-request:stable-claim`; row.key = legacyKey; row.state = "staging";
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [key] = ?, [payload] = ? WHERE [key] = ?").run(legacyKey, JSON.stringify(row), stored.key);
    const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: row.requestKey, __ingressAuthority: authority }, { auth: { userId: "", isAuthenticated: false, isGuest: true } });
    const publish = setTimeout(async () => { row.state = "leased"; await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [state] = ?, [payload] = ? WHERE [key] = ?").run("leased", JSON.stringify(row), legacyKey); }, 2300);
    const replay = await stageMultipartIngress(database, endpoint, request(), { headers: request().headers }, { userId: "" }, authority); clearTimeout(publish); assert.equal(replay.multipart.files[0].leaseId, first.multipart.files[0].leaseId); assert.equal(writes, 1);
    const leased = await api.status(row.requestKey, row.partKey); assert.equal(leased.state, "leased"); assert.equal(leased.lease.leaseId, first.multipart.files[0].leaseId);
    const file = await api.claim(replay.multipart.files[0], { path: "/attachments/legacy-principal.txt", authority: { kind: "capsule-principal", namespace, key: principalKey } });
    const completedReplay = await stageMultipartIngress(database, endpoint, request(), { headers: request().headers }, { userId: "" }, authority); assert.equal(completedReplay.multipart.files[0].leaseId, first.multipart.files[0].leaseId); assert.equal(writes, 1);
    const completed = await api.status(row.requestKey, row.partKey); assert.equal(completed.state, "complete"); assert.equal(completed.file.id, file.id);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1);
    const inconsistent = { ...JSON.parse((await database.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload), endpointPath: "/wrong" };
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(inconsistent), legacyKey);
    assert.deepEqual(await api.status(row.requestKey, row.partKey), { state: "missing" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Capsule-principal ingress requires explicit read and delete ACL declarations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-acl-"));
  try {
    const definition = capsule({ name: "principal-acl", files: { ingress: { principalNamespaces: ["application"], admit: () => ({ allow: false }) } }, endpoints: { upload: endpoint({ method: "POST", path: "/principal-acl", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, () => null) } });
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "principal-acl", files: { storagePath: path.join(dir, "files") } }, definition), { code: "FILE_INGRESS_ACL_REQUIRED" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cross-principal and cross-Capsule claims fail with the same opaque authority denial", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-principal-isolation-")); let first; let second; let retainedLease; let claimRetained = false;
  try {
    const files = { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ["application"], admit: ({ request }) => ({ allow: true, principal: { namespace: "application", key: request.headers["x-app-key"] } }) } };
    const makeDefinition = (name) => capsule({ name, files, endpoints: { upload: endpoint({ method: "POST", path: "/principal-isolation", body: { multipart: { ...ingressPolicy(), claimAuthorities: ["capsule-principal"] } } }, async (ctx) => {
      if (!retainedLease) { retainedLease = ctx.request.multipart.files[0]; return retainedLease; }
      return await ctx.files.claim(claimRetained ? retainedLease : ctx.request.multipart.files[0], { path: "/attachments/isolation.txt", authority: { kind: "capsule-principal", ...ctx.ingress.principal } });
    }) } });
    const request = (key, requestKey) => { const value = ingressRequest(requestKey); delete value.headers["x-sporades-session-token"]; value.headers["x-app-key"] = key; return value; };
    first = await openDevDatabase(path.join(dir, "first.db"), "", {}, { name: "isolation-a", files: { storagePath: path.join(dir, "first-files") } }, makeDefinition("isolation-a"));
    await runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-a", "request-a")); claimRetained = true;
    let crossPrincipal; await assert.rejects(runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-b", "request-b")), (error) => { crossPrincipal = error; return error.code === "INGRESS_AUTHORITY_DENIED"; });
    second = await openDevDatabase(path.join(dir, "second.db"), "", {}, { name: "isolation-b", files: { storagePath: path.join(dir, "second-files") } }, makeDefinition("isolation-b"));
    let crossCapsule; await assert.rejects(runEndpoint(second, second.endpoints[0], new URL("http://capsule.test/principal-isolation"), request("app-a", "request-c")), (error) => { crossCapsule = error; return error.code === "INGRESS_AUTHORITY_DENIED"; });
    assert.equal(crossPrincipal.message, crossCapsule.message); assert.equal(JSON.stringify(crossPrincipal).includes("app-a"), false); assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("trusted ingress has identical denial, claim, replay, restart, disconnect, and cleanup semantics on MinIO", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-minio-")); let database; const namespace = `ingress-${randomUUID()}`;
    try {
      let shouldClaim = true;
      const definition = capsule({ name: namespace, endpoints: {
        upload: endpoint({ method: "POST", path: "/minio", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => shouldClaim ? await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/minio.txt" }) : ctx.request.multipart.files[0])),
        denied: endpoint({ method: "POST", path: "/minio-denied", body: { multipart: ingressPolicy() } }, requireAuth(() => ({ body: { impossible: true } }))),
      } });
      const dbPath = path.join(dir, "data.db"); const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } };
      const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(dbPath, "", serviceEnv, config, definition, { serviceEnv }); await seedIngressUser(database);
      let deniedReads = 0; const denied = ingressRequest("minio-denied"); delete denied.headers["x-sporades-session-token"]; denied[Symbol.asyncIterator] = async function* () { deniedReads += 1; yield multipart("claim"); };
      await assert.rejects(runEndpoint(database, database.endpoints.find((route) => route.options.path === "/minio-denied"), new URL("http://capsule.test/minio-denied"), denied), { code: "UNAUTHENTICATED" }); assert.equal(deniedReads, 0); assert.equal(objects.size, 0);
      const route = database.endpoints.find((candidate) => candidate.options.path === "/minio");
      const claims = await Promise.all(Array.from({ length: 20 }, () => runEndpoint(database, route, new URL("http://capsule.test/minio"), ingressRequest("minio-claim"))));
      assert.equal(new Set(claims.map((file) => file.id)).size, 1); assert.equal(objects.size, 1); const canonicalKey = [...objects.keys()][0]; assert.ok(canonicalKey.startsWith(`capsules/${namespace}/files/`));
      await database.close(); database = await openDevDatabase(dbPath, "", serviceEnv, config, definition, { serviceEnv }); const replay = await runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), ingressRequest("minio-claim")); assert.equal(replay.id, claims[0].id); assert.deepEqual([...objects.keys()], [canonicalKey]);
      const truncated = ingressRequest("minio-truncated"); truncated[Symbol.asyncIterator] = async function* () { yield Buffer.from("--claim\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cut.txt\"\r\n\r\npartial"); };
      await assert.rejects(runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), truncated), { code: "INVALID_MULTIPART" }); assert.deepEqual([...objects.keys()], [canonicalKey]);
      shouldClaim = false; const orphan = await runEndpoint(database, database.endpoints.find((candidate) => candidate.options.path === "/minio"), new URL("http://capsule.test/minio"), ingressRequest("minio-orphan")); const orphanRow = await expireIngressReceipt(database, orphan.leaseId); const orphanKey = `capsules/${namespace}/files/${orphanRow.fileId}/${orphanRow.version}`; assert.equal(objects.has(orphanKey), true);
      const swept = await sweepExpiredFileIngress(database, { limit: 1 }); assert.equal(swept.cleaned.length, 1); assert.equal(objects.has(orphanKey), false); assert.deepEqual([...objects.keys()], [canonicalKey]);
    } finally {
      await database?.close();
      for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key);
      assert.equal([...objects.keys()].some((value) => value.startsWith(`capsules/${namespace}/`)), false);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("MinIO ingress accepts byte-fragmented multipart and leaves no residue for every disconnected parser state", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-minio-fragments-")); let database; const namespace = `ingress-fragments-${randomUUID()}`;
    try {
      const definition = capsule({ name: namespace, endpoints: { upload: endpoint({ method: "POST", path: "/fragments", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/fragmented.txt" }))) } });
      const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } }; const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace };
      database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, config, definition, { serviceEnv }); await seedIngressUser(database); const route = database.endpoints[0];
      const cuts = [
        Buffer.from("--claim"),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"'),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim\r\n\r\npartial'),
        Buffer.from('--claim\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim\r\n\r\npartial\r\n--claim'),
      ];
      for (const [index, cut] of cuts.entries()) {
        const request = ingressRequest(`fragment-cut-${index}`); request[Symbol.asyncIterator] = async function* () { for (const byte of cut) yield Buffer.from([byte]); };
        await assert.rejects(runEndpoint(database, route, new URL("http://capsule.test/fragments"), request), { code: "INVALID_MULTIPART" });
        assert.deepEqual([...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`)), []);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 0);
        assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
      }
      const source = multipart("claim", 'Content-Disposition: form-data; name="file"; filename="fragmented.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable-claim', "fragmented-bytes"); const success = ingressRequest("fragment-success"); success[Symbol.asyncIterator] = async function* () { yield* splitEvery(source, 1); };
      const file = await runEndpoint(database, route, new URL("http://capsule.test/fragments"), success); const keys = [...objects.keys()].filter((key) => key.startsWith(`capsules/${namespace}/`));
      assert.deepEqual(keys, [`capsules/${namespace}/files/${file.id}/${file.version}`]); assert.equal(objects.get(keys[0]).toString(), "fragmented-bytes");
      assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1); assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1);
    } finally {
      await database?.close(); for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key); assert.equal([...objects.keys()].some((value) => value.startsWith(`capsules/${namespace}/`)), false); await rm(dir, { recursive: true, force: true });
    }
  });
});

test("twenty claims across two SQLite connections all recover one completed File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-two-connection-")); let first; let second;
  try {
    const definition = capsule({ name: "two-connection", endpoints: { upload: endpoint({ method: "POST", path: "/claim", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/claim.txt" }))) } });
    const dbPath = path.join(dir, "data.db"); const config = { name: "two-connection", files: { storagePath: path.join(dir, "files") } };
    first = await openDevDatabase(dbPath, "", {}, config, definition); second = await openDevDatabase(dbPath, "", {}, config, definition); await seedIngressUser(first);
    const attempts = Array.from({ length: 20 }, (_, index) => { const database = index % 2 ? first : second; return runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim"), ingressRequest()); });
    const settled = await Promise.allSettled(attempts);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 20, settled.filter((result) => result.status === "rejected").map((result) => result.reason?.message).join("\n"));
    assert.equal(new Set(settled.map((result) => result.value?.id)).size, 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    assert.equal(Number((await first.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_buckets]").get()).count), 1);
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed ingress retries reject a changed claim descriptor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-claim-conflict-")); let database;
  try {
    let changed = false;
    const definition = capsule({ name: "claim-conflict", endpoints: { upload: endpoint({ method: "POST", path: "/claim-conflict", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: changed ? "/attachments/changed.txt" : "/attachments/original.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "claim-conflict", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim-conflict"), ingressRequest("claim-conflict")); changed = true;
    await assert.rejects(runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/claim-conflict"), ingressRequest("claim-conflict")), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed ingress response-loss retry succeeds after the original lease expiry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-complete-expired-")); let database;
  try {
    const definition = capsule({ name: "complete-expired", endpoints: { upload: endpoint({ method: "POST", path: "/complete-expired", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/expired.txt" }))) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "complete-expired", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    const first = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/complete-expired"), ingressRequest("complete-expired"));
    const stored = await database.adapter.prepare("SELECT [key], [payload] FROM [sporades_file_ingress]").get(); const payload = JSON.parse(stored.payload); payload.expiresAt = "2000-01-01T00:00:00.000Z";
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [key] = ?").run(JSON.stringify(payload), stored.key);
    const retried = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/complete-expired"), ingressRequest("complete-expired")); assert.equal(retried.id, first.id);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an expired unclaimed ingress lease is never claimable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-expired-claim-")); let database; let claim = false;
  try {
    const definition = capsule({ name: "expired-claim", endpoints: { upload: endpoint({ method: "POST", path: "/expired-claim", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => claim ? await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/expired-claim.txt" }) : ctx.request.multipart.files[0])) } });
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "expired-claim", files: { storagePath: path.join(dir, "files") } }, definition); await seedIngressUser(database);
    const lease = await runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/expired-claim"), ingressRequest("expired-claim")); await expireIngressReceipt(database, lease.leaseId); claim = true;
    await assert.rejects(runEndpoint(database, database.endpoints[0], new URL("http://capsule.test/expired-claim"), ingressRequest("expired-claim")), { code: "INGRESS_LEASE_EXPIRED" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress sweep is bounded, deterministic, and deletes only expired staged objects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-bounded-sweep-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "bounded-sweep", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "bounded-sweep" }));
    const endpoint = { options: { method: "POST", path: "/sweep", body: { multipart: ingressPolicy() } } };
    const staged = [];
    for (const requestKey of ["c", "a", "b"]) {
      const result = await stageMultipartIngress(database, endpoint, ingressRequest(requestKey), { headers: ingressRequest(requestKey).headers }, { userId: "claim-user" }); const lease = result.multipart.files[0]; const payload = await expireIngressReceipt(database, lease.leaseId); staged.push({ requestKey, lease, payload });
    }
    const result = await sweepExpiredFileIngress(database, { now: new Date().toISOString(), limit: 2 });
    assert.deepEqual(result.cleaned.map((entry) => entry.requestKey), ["a", "b"]); assert.equal(result.scanned, 2); assert.equal(result.failures.length, 0);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress]").get()).count), 1);
    for (const entry of staged.filter(({ requestKey }) => requestKey !== "c")) await assert.rejects(access(path.join(dir, "files", entry.payload.fileId, entry.payload.version)));
    await access(path.join(dir, "files", staged.find(({ requestKey }) => requestKey === "c").payload.fileId, staged.find(({ requestKey }) => requestKey === "c").payload.version));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a concurrent sweep waits for an in-flight claim and never deletes its committed File", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-claim-race-")); let first; let second; let releaseHandler; let handlerEntered;
  try {
    const entered = new Promise((resolve) => { handlerEntered = resolve; }); const release = new Promise((resolve) => { releaseHandler = resolve; });
    const definition = capsule({ name: "sweep-claim-race", endpoints: { upload: endpoint({ method: "POST", path: "/sweep-claim-race", body: { multipart: ingressPolicy() } }, requireAuth(async (ctx) => { handlerEntered(); await release; return await ctx.files.claim(ctx.request.multipart.files[0], { path: "/attachments/sweep-race.txt" }); })) } });
    const dbPath = path.join(dir, "data.db"); const config = { name: "sweep-claim-race", files: { storagePath: path.join(dir, "files") } };
    first = await openDevDatabase(dbPath, "", {}, config, definition); second = await openDevDatabase(dbPath, "", {}, config, definition); await seedIngressUser(first);
    const claim = runEndpoint(first, first.endpoints[0], new URL("http://capsule.test/sweep-claim-race"), ingressRequest("sweep-claim-race")); await entered;
    const sweep = sweepExpiredFileIngress(second, { now: "2099-01-01T00:00:00.000Z", limit: 10 }); releaseHandler(); const file = await claim; const swept = await sweep;
    assert.equal(swept.cleaned.length, 0); assert.equal((await first.adapter.selectFileById(file.id)).id, file.id); assert.equal(JSON.parse((await first.adapter.prepare("SELECT [payload] FROM [sporades_file_ingress]").get()).payload).state, "complete");
  } finally { await first?.close(); await second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("restart recovers a sweeping orphan", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-restart-")); let database;
  try {
    const dbPath = path.join(dir, "data.db"); const config = { name: "sweep-restart", files: { storagePath: path.join(dir, "files") } }; const definition = capsule({ name: "sweep-restart" }); const endpoint = { options: { method: "POST", path: "/restart", body: { multipart: ingressPolicy() } } };
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    const staged = await stageMultipartIngress(database, endpoint, ingressRequest("restart-orphan"), { headers: ingressRequest("restart-orphan").headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0]; const payload = await expireIngressReceipt(database, lease.leaseId);
    await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [state] = 'sweeping' WHERE [leaseId] = ?").run(lease.leaseId); await database.close(); database = null;
    database = await openDevDatabase(dbPath, "", {}, config, definition);
    assert.equal(await database.adapter.selectIngressByLease(lease.leaseId), null); await assert.rejects(access(path.join(dir, "files", payload.fileId, payload.version)));
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ingress orphan cleanup failures are stable, bounded, and retryable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-sweep-failure-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "sweep-failure", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "sweep-failure" }));
    const endpoint = { options: { method: "POST", path: "/failure", body: { multipart: ingressPolicy() } } };
    const staged = await stageMultipartIngress(database, endpoint, ingressRequest("failure"), { headers: ingressRequest("failure").headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0]; await expireIngressReceipt(database, lease.leaseId);
    const remove = database.fileStorage.deleteFileVersion.bind(database.fileStorage); database.fileStorage.deleteFileVersion = async () => { throw new Error("provider-secret-detail"); };
    const failed = await sweepExpiredFileIngress(database, { limit: 1 });
    assert.deepEqual(failed.failures, [{ leaseId: lease.leaseId, code: "INGRESS_ORPHAN_CLEANUP_FAILED" }]); assert.equal(JSON.stringify(failed).includes("provider-secret-detail"), false); assert.equal((await database.adapter.selectIngressByLease(lease.leaseId)).state, "sweeping");
    database.fileStorage.deleteFileVersion = remove; const retried = await sweepExpiredFileIngress(database, { limit: 1 }); assert.equal(retried.cleaned.length, 1); assert.equal(await database.adapter.selectIngressByLease(lease.leaseId), null);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("required inspection evidence is bound to the lease and fails closed before a File exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspection-gate-")); let database;
  try {
    const inspection = { policyRevision: "attachments-v1", maxVerdictAgeMs: 60_000, requiredInspectors: ["content-policy-v1"] };
    const endpoint = { options: { method: "POST", path: "/inspection", body: { multipart: { ...ingressPolicy(), inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspection", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "inspection" }));
    const request = { headers: ingressRequest("inspection").headers, async *[Symbol.asyncIterator]() { yield multipart("claim", 'Content-Disposition: form-data; name="file"; filename="claim.pdf"\r\nContent-Type: application/pdf\r\nContent-ID: stable-claim', "claim-bytes"); } };
    const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "claim-user" });
    const lease = staged.multipart.files[0]; const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: "inspection", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    await assert.rejects(api.claim(lease, { path: "/attachments/blocked.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
    const receipt = JSON.parse((await database.adapter.selectIngressByLease(lease.leaseId)).payload);
    assert.equal(receipt.inspection.policyRevision, "attachments-v1"); assert.equal(receipt.inspection.verdicts[0].leaseId, lease.leaseId); assert.equal(receipt.inspection.verdicts[0].digest, receipt.digest); assert.equal(receipt.inspection.verdicts[0].size, lease.size);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("inspection verdict age starts when each asynchronous inspector completes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-inspect-clock-")); let database; let fake;
  try {
    const startedAt = "2030-01-01T00:00:00.000Z"; const clock = createControllableRuntimeClock(startedAt);
    const inspection = { policyRevision: "completion-clock-v1", maxVerdictAgeMs: 1_000, requiredInspectors: ["content-policy-v1", "clamav"] };
    const endpoint = { options: { method: "POST", path: "/completion-clock", body: { multipart: { ...ingressPolicy(), inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspection-completion-clock", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "inspection-completion-clock" }), { clock });
    const socketPath = path.join(dir, "clamd.sock");
    const fakeOptions = { response: "stream: OK\0", onRequest: () => clock.advanceBy(750) };
    fake = await fakeClamSocket(socketPath, fakeOptions);
    database.__clamavTest = { socketPath, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: new Date().toISOString() } };
    const stage = async (requestKey) => {
      const request = ingressRequest(requestKey);
      const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "claim-user" });
      const lease = staged.multipart.files[0];
      const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
      return { api, lease };
    };

    const immediate = await stage("completion-clock-immediate");
    const evidence = await immediate.api.inspection(immediate.lease);
    assert.deepEqual(evidence.verdicts.map((verdict) => verdict.inspectedAt), [startedAt, "2030-01-01T00:00:00.750Z"]);
    assert.equal((await immediate.api.claim(immediate.lease, { path: "/attachments/immediate.txt" })).path, "/attachments/immediate.txt");

    const aging = await stage("completion-clock-aging");
    clock.advanceBy(1_001);
    await assert.rejects(aging.api.claim(aging.lease, { path: "/attachments/stale.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });

    fakeOptions.response = "stream: Eicar-Test-Signature FOUND\0";
    const infected = await stage("completion-clock-infected");
    const infectedEvidence = await infected.api.inspection(infected.lease);
    assert.deepEqual(infectedEvidence.verdicts.map((verdict) => [verdict.outcome, verdict.inspectedAt]), [["clean", "2030-01-01T00:00:02.501Z"], ["rejected", "2030-01-01T00:00:03.251Z"]]);

    fakeOptions.response = "malformed scanner response\0";
    const inconclusive = await stage("completion-clock-inconclusive");
    const inconclusiveEvidence = await inconclusive.api.inspection(inconclusive.lease);
    assert.deepEqual(inconclusiveEvidence.verdicts.map((verdict) => [verdict.outcome, verdict.inspectedAt]), [["clean", "2030-01-01T00:00:03.251Z"], ["inconclusive", "2030-01-01T00:00:04.001Z"]]);
  } finally { if (fake) await new Promise((resolve) => fake.server.close(resolve)); await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("inspection declarations reject forged verdict providers before request bytes are consumed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspection-forged-")); let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspection-forged" }, capsule({ name: "inspection-forged" })); let reads = 0;
    const endpoint = { options: { method: "POST", path: "/forged", body: { multipart: { ...ingressPolicy(), inspection: { policyRevision: "v1", inspectors: [{ name: "clean", verdict: "clean" }] } } } } };
    await assert.rejects(stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { reads += 1; yield multipart("forged"); } }, { headers: { "content-type": "multipart/form-data; boundary=forged", "idempotency-key": "forged" } }, { userId: "actor" }), { code: "INVALID_MULTIPART_POLICY" }); assert.equal(reads, 0);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("every required inspector must be clean when a configured runtime inspector is unavailable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspection-all-")); let database;
  try {
    const inspection = { policyRevision: "all-v1", requiredInspectors: ["content-policy-v1", "clamav"] }; const endpoint = { options: { method: "POST", path: "/all", body: { multipart: { ...ingressPolicy(), inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspection-all", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "inspection-all" })); const request = ingressRequest("inspection-all"); const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0];
    const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: "inspection-all", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    await assert.rejects(api.claim(lease, { path: "/attachments/all.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" }); const evidence = await api.inspection(lease); assert.deepEqual(evidence.verdicts.map((item) => item.outcome), ["clean", "inconclusive"]); assert.equal(await database.adapter.selectFileById(JSON.parse((await database.adapter.selectIngressByLease(lease.leaseId)).payload).fileId), null);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ClamAV inspection uses only bounded Unix INSTREAM framing and fails closed for every non-clean condition", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-clamav-socket-")); let database;
  try { database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "clamav-socket", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "clamav-socket" })); const inspection = { policyRevision: "clam-v1", requiredInspectors: ["clamav"] }; const endpoint = { options: { method: "POST", path: "/clam", body: { multipart: { ...ingressPolicy(), inspection } } } }; const body = Buffer.from("claim-bytes");
    const cases = [["clean", "stream: OK\0", "clean"], ["infected", "stream: Eicar-Test-Signature FOUND\0", "rejected"], ["malformed", "nonsense\0", "inconclusive"], ["limit", "INSTREAM size limit exceeded. ERROR\0", "inconclusive"], ["timeout", undefined, "inconclusive"], ["unavailable", null, "inconclusive"], ["stale", null, "inconclusive"]];
    for (const [key, response, expected] of cases) { const socketPath = path.join(dir, `${key}.sock`); let fake; if (response !== null) fake = await fakeClamSocket(socketPath, { response, delayMs: key === "timeout" ? 100 : 0 }); database.__clamavTest = { socketPath, timeoutMs: 10, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: key === "stale" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString() } }; const headers = { "content-type": `multipart/form-data; boundary=${key}`, "idempotency-key": key }; const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartBinary(key, "claim.txt", "text/plain", body); } }, { headers }, { userId: "claim-user" }); const receipt = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload); const verdict = receipt.inspection.verdicts[0]; assert.equal(verdict.outcome, expected, key); assert.equal(JSON.stringify(verdict).includes("Eicar"), false); if (key === "clean") { const wire = fake.received; assert.equal(wire.subarray(0, 10).toString(), "zINSTREAM\0"); assert.equal(wire.readUInt32BE(10), body.length); assert.deepEqual(wire.subarray(14, 14 + body.length), body); assert.deepEqual(wire.subarray(-4), Buffer.alloc(4)); } if (fake) await new Promise((resolve) => fake.server.close(resolve)); }
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the one ClamAV freshness predicate rejects stale, future, malformed, and over-24-hour signatures", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z"); assert.equal(isCurrentClamavSignature({ version: "daily:42", updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() }, now), true); assert.equal(isCurrentClamavSignature({ version: "daily:42", updatedAt: new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString() }, now), false); assert.equal(isCurrentClamavSignature({ version: "daily:42", updatedAt: new Date(now + 1).toISOString() }, now), false); assert.equal(isCurrentClamavSignature({ version: "forged", updatedAt: new Date(now).toISOString() }, now), false);
});

test("bounded scanner tool collection drains stdout after process exit", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  const pending = collectBoundedToolOutput(child, 10_000); let settled = false; pending.then(() => { settled = true; });
  child.emit("exit", 0); await Promise.resolve(); assert.equal(settled, false);
  child.stdout.emit("data", Buffer.from("Version: 42\nVerification: OK\n"));
  child.stdout.emit("end");
  assert.deepEqual(await pending, { ok: true, stdout: "Version: 42\nVerification: OK\n" });

  const excessive = new EventEmitter(); excessive.stdout = new EventEmitter(); const bounded = collectBoundedToolOutput(excessive, 10_000, 4); excessive.stdout.emit("data", Buffer.from("12345"));
  assert.deepEqual(await bounded, { ok: false, stdout: "" });
  const errored = new EventEmitter(); errored.stdout = new EventEmitter(); const failed = collectBoundedToolOutput(errored, 10_000); errored.emit("error", new Error("spawn failed")); assert.equal((await failed).ok, false);
});

test("signal-terminated ClamAV children permanently degrade health before scanner probes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-clamav-signals-")); const socketPath = path.join(dir, "clamd.sock"); let commands = 0;
  const server = createNetServer((socket) => socket.once("data", () => { commands += 1; socket.end(Buffer.from("PONG\0")); })); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const alive = () => { const listeners = new Map(); return { exitCode: null, signalCode: null, once(name, listener) { listeners.set(name, listener); }, emit(name, ...args) { listeners.get(name)?.(...args); }, kill() {} }; };
  const testState = { socketPath, loadedSignature: "daily:1", signature: { version: "daily:1", updatedAt: new Date().toISOString() } };
  try {
    for (const signalCode of ["SIGTERM", "SIGKILL", "SIGABRT"]) {
      const daemon = alive(); const updater = alive(); updater.signalCode = signalCode;
      const database = { clamavRequired: true, clamavReady: true, __clamavProcess: daemon, __clamavUpdateProcess: updater, __clamavTest: testState };
      assert.deepEqual(await checkClamavRuntime(database), { ok: false }, signalCode); assert.equal(database.clamavReady, false);
    }
    const sidecarProcess = alive(); sidecarProcess.signalCode = "SIGKILL";
    const sidecarDatabase = { clamavRequired: true, clamavReady: true, __clamavDevSidecar: { process: sidecarProcess, externallyManaged: true }, __clamavTest: testState };
    assert.deepEqual(await checkClamavRuntime(sidecarDatabase), { ok: false }); assert.equal(sidecarDatabase.clamavReady, false);
    assert.equal(commands, 0);
    const exitedDaemon = alive(); const exitedUpdater = alive(); const exitedDatabase = { clamavRequired: true, clamavReady: true, __clamavProcess: exitedDaemon, __clamavUpdateProcess: exitedUpdater, __clamavTest: testState };
    assert.deepEqual(await checkClamavRuntime(exitedDatabase), { ok: true }); const beforeExit = commands; exitedDaemon.emit("exit", 0);
    assert.deepEqual(await checkClamavRuntime(exitedDatabase), { ok: false }); assert.equal(commands, beforeExit, "exit latch prevents probes");

    const erroredDaemon = alive(); const erroredUpdater = alive(); const erroredDatabase = { clamavRequired: true, clamavReady: true, __clamavProcess: erroredDaemon, __clamavUpdateProcess: erroredUpdater, __clamavTest: testState };
    assert.deepEqual(await checkClamavRuntime(erroredDatabase), { ok: true }); erroredUpdater.emit("error", new Error("child error")); assert.equal(erroredDatabase.clamavReady, false);
    assert.deepEqual(await checkClamavRuntime(erroredDatabase), { ok: true }, "an error without exit evidence is not terminal");
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test("ClamAV supervision handles every nonterminal child error until exit or owner teardown", async () => {
  const child = new EventEmitter(); Object.assign(child, { exitCode: null, signalCode: null, signals: [] }); child.kill = function (signal) { this.signals.push(signal); this.exitCode = 0; this.emit("close", 0, signal); };
  const testState = { loadedSignature: "daily:1", signature: { version: "daily:1", updatedAt: new Date().toISOString() }, socketCommand: async () => "PONG" };
  const database = { clamavRequired: true, clamavReady: false, __clamavProcess: child, __clamavTest: testState };
  assert.deepEqual(await checkClamavRuntime(database), { ok: true }); assert.equal(child.listenerCount("error"), 1);
  child.emit("error", new Error("transient one")); assert.equal(database.clamavReady, false);
  assert.deepEqual(await checkClamavRuntime(database), { ok: true }); assert.equal(child.listenerCount("error"), 1);
  assert.doesNotThrow(() => child.emit("error", new Error("transient two"))); assert.equal(database.clamavReady, false); assert.equal(child.listenerCount("error"), 1);
  await shutdownClamavRuntime(database); assert.equal(database.__clamavProcess, null);
  assert.equal(child.listenerCount("exit"), 0); assert.equal(child.listenerCount("close"), 0); assert.equal(child.listenerCount("error"), 0);

  const terminal = new EventEmitter(); Object.assign(terminal, { exitCode: null, signalCode: null }); terminal.kill = () => {};
  const terminalDatabase = { clamavRequired: true, clamavReady: false, __clamavProcess: terminal, __clamavTest: testState };
  assert.deepEqual(await checkClamavRuntime(terminalDatabase), { ok: true }); terminal.emit("exit", 1); assert.equal(terminalDatabase.clamavReady, false);
  assert.equal(terminal.listenerCount("exit"), 0); assert.equal(terminal.listenerCount("close"), 0); assert.equal(terminal.listenerCount("error"), 0);

  const sidecar = new EventEmitter(); Object.assign(sidecar, { exitCode: null, signalCode: null }); sidecar.kill = () => {};
  const oldRuntime = { clamavRequired: true, clamavReady: false, __clamavDevSidecar: { process: sidecar, externallyManaged: true }, __clamavTest: testState };
  assert.deepEqual(await checkClamavRuntime(oldRuntime), { ok: true }); await shutdownClamavRuntime(oldRuntime); assert.equal(sidecar.listenerCount("error"), 0);
  const replacementRuntime = { ...oldRuntime, clamavReady: false };
  assert.deepEqual(await checkClamavRuntime(replacementRuntime), { ok: true }); sidecar.emit("error", new Error("replacement runtime error")); assert.equal(replacementRuntime.clamavReady, false); assert.equal(sidecar.listenerCount("error"), 1);
  await shutdownClamavRuntime(replacementRuntime); assert.equal(sidecar.listenerCount("error"), 0);
});

test("ClamAV shutdown skips already-dead children and deterministically escalates only live children", async () => {
  const child = ({ signalCode = null, latched = false, termExits = false } = {}) => {
    const listeners = new Map(); const signals = [];
    return {
      exitCode: null, signalCode, __sporadesClamavTerminated: latched, signals,
      get listenerCount() { return listeners.size; },
      once(name, listener) { listeners.set(name, listener); },
      removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
      kill(signal) {
        signals.push(signal);
        if ((signal === "SIGTERM" && termExits) || signal === "SIGKILL") {
          this.exitCode = 0;
          const listener = listeners.get("exit"); listeners.delete("exit"); listener?.(0);
        }
      },
    };
  };
  for (const dead of [child({ signalCode: "SIGKILL" }), child({ latched: true })]) {
    await shutdownClamavRuntime({ __clamavProcess: dead, __clamavTest: { terminateTimeoutMs: 0 } });
    assert.deepEqual(dead.signals, []);
    assert.equal(dead.listenerCount, 0);
  }
  const termExit = child({ termExits: true });
  await shutdownClamavRuntime({ __clamavProcess: termExit, __clamavTest: { terminateTimeoutMs: 0 } });
  assert.deepEqual(termExit.signals, ["SIGTERM"]);
  assert.equal(termExit.listenerCount, 0);

  const escalated = child();
  await shutdownClamavRuntime({ __clamavProcess: escalated, __clamavTest: { terminateTimeoutMs: 0 } });
  assert.deepEqual(escalated.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(escalated.listenerCount, 0);
});

test("ClamAV readiness consumes one absolute deadline across probes and retry delays", async () => {
  const process = { exitCode: null, signalCode: null, once() {}, kill() {} };
  const run = async ({ budget, probeCosts, outcomes }) => {
    let now = 1000; const timeouts = []; const delays = [];
    const database = { __clamavTest: {
      now: () => now,
      delay: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
      socketExists: () => true,
      readinessProbe: async (timeoutMs) => { timeouts.push(timeoutMs); now += Math.min(probeCosts.shift() ?? 0, timeoutMs); return outcomes.shift() ?? false; },
    } };
    const ready = await waitForClamavReadiness(database, process, now + budget);
    return { ready, elapsed: now - 1000, timeouts, delays };
  };
  assert.deepEqual(await run({ budget: 0, probeCosts: [], outcomes: [] }), { ready: false, elapsed: 0, timeouts: [], delays: [] });
  assert.deepEqual(await run({ budget: 50, probeCosts: [49], outcomes: [true] }), { ready: true, elapsed: 49, timeouts: [50], delays: [] });
  assert.deepEqual(await run({ budget: 50, probeCosts: [51], outcomes: [true] }), { ready: false, elapsed: 50, timeouts: [50], delays: [] });
  assert.deepEqual(await run({ budget: 250, probeCosts: [120, 20], outcomes: [false, true] }), { ready: true, elapsed: 240, timeouts: [250, 30], delays: [100] });
  assert.deepEqual(await run({ budget: 250, probeCosts: [200, 200], outcomes: [false, false] }), { ready: false, elapsed: 250, timeouts: [250], delays: [50] });

  let now = Date.parse("2030-01-01T00:00:00.000Z"); const devTimeouts = []; const devDatabase = {
    endpoints: [{ options: { body: { multipart: { inspection: { requiredInspectors: ["clamav"] } } } } }],
    __clamavDevSidecar: { socketPath: "/unused-test-socket", process, externallyManaged: true },
    __clamavTest: { startupTimeoutMs: 75, now: () => now, delay: async (milliseconds) => { now += milliseconds; }, socketExists: () => true, signature: { version: "daily:1", updatedAt: new Date(now).toISOString() }, loadedSignature: "daily:1", socketCommand: async (_command, timeoutMs) => { devTimeouts.push(timeoutMs); now += timeoutMs; return null; } },
  };
  assert.equal(await initializeClamavRuntime(devDatabase), false); assert.equal(now, Date.parse("2030-01-01T00:00:00.075Z")); assert.deepEqual(devTimeouts, [75]);
});

test("ClamAV shutdown retains stubborn children for a later successful cleanup retry", async () => {
  const child = () => {
    const listeners = new Map(); const signals = []; let canExit = false;
    return { exitCode: null, signalCode: null, signals, once(name, listener) { listeners.set(name, listener); }, kill(signal) { signals.push(signal); if (canExit && signal === "SIGKILL") { this.signalCode = signal; listeners.get("exit")?.(null, signal); } }, allowExit() { canExit = true; } };
  };
  const daemon = child(); const updater = child(); const database = { __clamavProcess: daemon, __clamavUpdateProcess: updater, __clamavTest: { terminateTimeoutMs: 0 } };
  await assert.rejects(shutdownClamavRuntime(database), AggregateError);
  assert.equal(database.__clamavProcess, daemon); assert.equal(database.__clamavUpdateProcess, updater);
  assert.deepEqual(daemon.signals, ["SIGTERM", "SIGKILL"]); assert.deepEqual(updater.signals, ["SIGTERM", "SIGKILL"]);
  daemon.allowExit(); updater.allowExit(); await shutdownClamavRuntime(database);
  assert.equal(database.__clamavProcess, null); assert.equal(database.__clamavUpdateProcess, null);
  assert.deepEqual(daemon.signals, ["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

  const signalError = new EventEmitter(); Object.assign(signalError, { exitCode: null, signalCode: null, signals: [], canExit: false });
  signalError.kill = function (signal) { this.signals.push(signal); if (this.canExit) { this.signalCode = signal; this.emit("close", null, signal); } else this.emit("error", Object.assign(new Error("signal denied"), { code: "EPERM" })); };
  const errorDatabase = { __clamavProcess: signalError, __clamavTest: { terminateTimeoutMs: 0 } };
  await assert.rejects(shutdownClamavRuntime(errorDatabase), AggregateError); assert.equal(errorDatabase.__clamavProcess, signalError);
  assert.equal(signalError.listenerCount("exit"), 0); assert.equal(signalError.listenerCount("close"), 0); assert.equal(signalError.listenerCount("error"), 0);
  signalError.canExit = true; await shutdownClamavRuntime(errorDatabase); assert.equal(errorDatabase.__clamavProcess, null);

  let now = 0; const delays = []; const timed = new EventEmitter(); Object.assign(timed, { exitCode: null, signalCode: null, signals: [] }); timed.kill = function (signal) { this.signals.push(signal); };
  const timedDatabase = { __clamavProcess: timed, __clamavTest: { terminateTimeoutMs: 100, now: () => now, delay: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; } } };
  await assert.rejects(shutdownClamavRuntime(timedDatabase), AggregateError);
  assert.equal(now, 100); assert.deepEqual(delays, [50, 50]); assert.deepEqual(timed.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(timed.listenerCount("exit"), 0); assert.equal(timed.listenerCount("close"), 0); assert.equal(timed.listenerCount("error"), 0);
  await assert.rejects(shutdownClamavRuntime(timedDatabase), AggregateError); assert.equal(now, 200); assert.deepEqual(delays, [50, 50, 50, 50]);
  assert.equal(timed.listenerCount("exit"), 0); assert.equal(timed.listenerCount("close"), 0); assert.equal(timed.listenerCount("error"), 0);
});

test("ClamAV health requires a bounded PING and shutdown awaits both managed children", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-clamav-health-")); const socketPath = path.join(dir, "clamd.sock"); let commands = 0;
  const server = createNetServer((socket) => socket.once("data", (bytes) => { commands += 1; assert.equal(bytes.toString(), "zPING\0"); socket.end(Buffer.from(commands === 1 ? "BUSY\0" : "PONG\0")); })); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const child = (stuck = false) => { const listeners = new Map(); const signals = []; return { exitCode: null, signals, once(name, handler) { listeners.set(name, handler); }, kill(signal) { signals.push(signal); if (stuck && signal === "SIGTERM") return; this.exitCode = signal === "SIGKILL" ? null : 0; queueMicrotask(() => { this.exitCode = 0; listeners.get("exit")?.(0); }); } }; };
  try {
    const clamd = child(); const updater = child(true); const database = { clamavRequired: true, clamavReady: true, __clamavProcess: clamd, __clamavUpdateProcess: updater, __clamavTest: { socketPath, loadedSignature: "daily:1", terminateTimeoutMs: 5, signature: { version: "daily:1", updatedAt: new Date().toISOString() } } };
    assert.deepEqual(await checkClamavRuntime(database), { ok: false }); assert.equal(database.clamavReady, false); assert.deepEqual(await checkClamavRuntime(database), { ok: true }); assert.equal(commands, 2); await shutdownClamavRuntime(database); assert.deepEqual(clamd.signals, ["SIGTERM"]); assert.deepEqual(updater.signals, ["SIGTERM", "SIGKILL"]); assert.equal(database.clamavReady, false); assert.equal(database.__clamavProcess, null); assert.equal(database.__clamavUpdateProcess, null);
    const external = { clamavRequired: true, clamavReady: true, __clamavDevSidecar: { process: child(), externallyManaged: true }, __clamavTest: { socketPath, loadedSignature: "daily:1", signature: { version: "daily:1", updatedAt: new Date().toISOString() } } }; assert.deepEqual(await checkClamavRuntime(external), { ok: true }); assert.equal(commands, 3);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test("runtime init failure shuts down a started ClamAV before a collision-free retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-clamav-init-rollback-")); let database; let attempts = 0;
  const child = () => { const listeners = new Map(); const signals = []; return { exitCode: null, signals, once(name, handler) { listeners.set(name, handler); }, kill(signal) { signals.push(signal); this.exitCode = 0; queueMicrotask(() => listeners.get("exit")?.(0)); } }; };
  const inspection = { policyRevision: "init-rollback-v1", requiredInspectors: ["clamav"] };
  const definition = capsule({ name: "clamav-init-rollback", hooks: { init() { attempts += 1; if (attempts === 1) throw new Error("later init hook failed"); } }, endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart: { ...ingressPolicy(), inspection } } }, () => ({ ok: true })) } });
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition); database.__clamavTest = { loadedSignature: "daily:1", signature: { version: "daily:1", updatedAt: new Date().toISOString() } };
    const firstClamd = child(); const firstUpdater = child(); database.__clamavProcess = firstClamd; database.__clamavUpdateProcess = firstUpdater;
    await assert.rejects(database.init(), /later init hook failed/); assert.deepEqual(firstClamd.signals, ["SIGTERM"]); assert.deepEqual(firstUpdater.signals, ["SIGTERM"]); assert.equal(database.clamavReady, false); assert.equal(database.__clamavProcess, null); assert.equal(database.__clamavUpdateProcess, null);
    const retryClamd = child(); const retryUpdater = child(); database.__clamavProcess = retryClamd; database.__clamavUpdateProcess = retryUpdater; await database.init(); assert.equal(database.clamavReady, true); await database.shutdown(); assert.deepEqual(retryClamd.signals, ["SIGTERM"]); assert.deepEqual(retryUpdater.signals, ["SIGTERM"]);
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ClamAV refuses bytes above its exact 10 MB stream cap before opening a socket", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-clamav-cap-")); const socketPath = path.join(dir, "clamd.sock"); let connections = 0; let database;
  const server = createNetServer(() => { connections += 1; }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "clamav-cap", files: { storagePath: path.join(dir, "files"), maxSizeBytes: 11 * 1024 * 1024 } }, capsule({ name: "clamav-cap" })); database.__clamavTest = { socketPath, loadedSignature: "daily:1", signature: { version: "daily:1", updatedAt: new Date().toISOString() } };
    const inspection = { policyRevision: "clam-cap-v1", requiredInspectors: ["clamav"] }; const policy = { ...ingressPolicy(), maxFileBytes: 11 * 1024 * 1024, maxTotalFileBytes: 11 * 1024 * 1024, inspection }; const endpoint = { options: { method: "POST", path: "/clam-cap", body: { multipart: policy } } }; const boundary = "clam-cap"; const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
    const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartBinary(boundary, "large.txt", "text/plain", bytes); } }, { headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": boundary } }, { userId: "claim-user" }); const row = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload);
    assert.equal(row.inspection.verdicts[0].outcome, "inconclusive"); assert.equal(connections, 0);
  } finally { await database?.close(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test("content-policy-v1 structurally validates its allowlist and rejects executable or ambiguous evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-content-matrix-")); const originalHome = process.env.HOME; const originalUser = process.env.USER; const originalPath = process.env.PATH; const originalCwd = process.cwd(); let database;
  try {
    const inspection = { policyRevision: "matrix-v1", requiredInspectors: ["content-policy-v1"] }; const policy = { ...ingressPolicy(), maxFileBytes: 20_000, maxTotalFileBytes: 20_000, inspection };
    const sentenceExecutable = path.join(dir, "Payload", "run"); await mkdir(path.dirname(sentenceExecutable), { recursive: true });
    for (const name of ["run", "run1", "run01", "runa", "rrun", "1un", "élocale"]) { const candidate = path.join(path.dirname(sentenceExecutable), name); await writeFile(candidate, "#!/bin/sh\nexit 0\n"); await chmod(candidate, 0o755); }
    const pathBin = path.join(dir, "bin"); await mkdir(pathBin); for (const name of ["Run*", "MatchOne"]) { const candidate = path.join(pathBin, name); await writeFile(candidate, "#!/bin/sh\nexit 0\n"); await chmod(candidate, 0o755); }
    await writeFile(path.join(pathBin, "Miss*"), "not executable\n"); await mkdir(path.join(pathBin, "DirMatchOne")); await writeFile(path.join(dir, "MatchOne"), "not executable\n"); await writeFile(path.join(dir, "MatchTwo"), "not executable\n"); await mkdir(path.join(dir, "DirMatchOne"));
    process.env.HOME = dir; process.env.USER = "sporades-fixture"; process.env.PATH = `${pathBin}:${originalPath ?? ""}`; process.chdir(dir);
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "content-matrix", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "content-matrix" }));
    const validPdf = minimalPdf(); const validPdfText = validPdf.toString("latin1"); const validEntries = [...validPdfText.matchAll(/\d{10} 00000 n /g)].map((match) => match[0]); const swappedClassicPdf = Buffer.from(validPdfText.replace(validEntries[0], "SWAP_ENTRY").replace(validEntries[1], validEntries[0]).replace("SWAP_ENTRY", validEntries[1]), "latin1"); const validNonzeroGenerationPdf = Buffer.from(validPdfText.replace("1 0 obj", "1 2 obj").replace("/Root 1 0 R", "/Root 1 2 R").replace(validEntries[0], `${validEntries[0].slice(0, 11)}00002 n `), "latin1"); const invalidHybridPdf = Buffer.from(hybridXrefPdf().toString("latin1").replace("/W [1 4 2]", "/W [1 0 2]"), "latin1"); const validPng = minimalPng(); const parsedPng = pngChunks(validPng); const idatAt = parsedPng.findIndex((chunk) => chunk.type === "IDAT");
    const badZlibPng = rebuildPng(parsedPng.map((chunk) => chunk.type === "IDAT" ? { ...chunk, data: Buffer.from([0xff, 0xff]) } : chunk)); const rawPng = inflateSync(parsedPng[idatAt].data); rawPng[0] = 5; const badFilterPng = rebuildPng(parsedPng.map((chunk) => chunk.type === "IDAT" ? { ...chunk, data: deflateSync(rawPng) } : chunk)); const idat = parsedPng[idatAt]; const split = Math.max(1, Math.floor(idat.data.length / 2)); const badOrderPng = rebuildPng([...parsedPng.slice(0, idatAt), { type: "IDAT", data: idat.data.subarray(0, split) }, { type: "tEXt", data: Buffer.from("x\0y") }, { type: "IDAT", data: idat.data.subarray(split) }, ...parsedPng.slice(idatAt + 1)]);
    const cases = [
      ["valid-compressed-object-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject(), "clean"],
      ["valid-flate-compressed-object-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ flate: true }), "clean"],
      ["valid-replaced-compressed-member-pdf", "note.pdf", "application/pdf", incrementallySupersededCompressedObject(), "clean"],
      ["valid-freed-compressed-member-pdf", "note.pdf", "application/pdf", incrementallySupersededCompressedObject(true), "clean"],
      ["valid-reused-historical-free-entry-pdf", "note.pdf", "application/pdf", incrementallyReplaceHistoricalFreeEntry(), "clean"],
      ["valid-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R"), "clean"],
      ["valid-adjacent-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "", "/Custom null"), "clean"],
      ["valid-adjacent-non-encrypt-trailer-key-pdf", "note.pdf", "application/pdf", compactTrailerPdf("/Info null"), "clean"],
      ["valid-indirect-object-stream-length-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ indirectLength: true }), "clean"],
      ["valid-indirect-flate-object-stream-length-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ indirectLength: true, flate: true }), "clean"],
      ["valid-indirect-xref-stream-length-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithIndirectLength(), "clean"],
      ["valid-harmless-encrypt-content-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("47", "4", "/Encrypt % harmless name and comment\n(Encrypt)\n"), "clean"],
      ["valid-harmless-encrypt-name-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "/CustomName /Encrypt"), "clean"],
      ["wrong-generation-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 1 R"), "rejected"],
      ["wrong-type-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R", "(four)"), "rejected"],
      ["missing-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("9 0 R"), "rejected"],
      ["cyclic-indirect-stream-length-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("4 0 R"), "rejected"],
      ["future-revision-indirect-stream-length-pdf", "note.pdf", "application/pdf", futureRevisionStreamLength(), "rejected"],
      ["wrong-generation-indirect-object-stream-length-pdf", "note.pdf", "application/pdf", Buffer.from(xrefStreamPdfWithCompressedObject({ indirectLength: true }).toString("latin1").replace("/Length 7 0 R", "/Length 7 1 R"), "latin1"), "rejected"],
      ["wrong-generation-indirect-xref-stream-length-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithIndirectLength({ wrongGeneration: true }), "rejected"],
      ["wrong-type-indirect-xref-stream-length-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithIndirectLength({ wrongType: true }), "rejected"],
      ["direct-encrypt-trailer-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R", "4", "q\nQ\n", "/Encrypt <</Filter /Standard>>"), "rejected"],
      ["indirect-encrypt-trailer-pdf", "note.pdf", "application/pdf", classicPdfWithStreamLength("5 0 R", "<</Filter /Standard>>", "q\nQ\n", "/Encrypt 5 0 R"), "rejected"],
      ["compact-null-encrypt-trailer-pdf", "note.pdf", "application/pdf", compactTrailerPdf("/Encrypt null"), "rejected"],
      ["compact-indirect-encrypt-trailer-pdf", "note.pdf", "application/pdf", compactTrailerPdf("/Encrypt 4 0 R"), "rejected"],
      ["compact-missing-encrypt-trailer-pdf", "note.pdf", "application/pdf", compactTrailerPdf("/Encrypt 9 0 R"), "rejected"],
      ["repaired-invalid-historical-compressed-container-pdf", "note.pdf", "application/pdf", incrementallyRepairInvalidCompressedContainer(), "rejected"],
      ["repaired-invalid-historical-free-head-pdf", "note.pdf", "application/pdf", incrementallyRepairInvalidFreeHead(), "rejected"],
      ["compressed-object-catalog-container-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ container: 1 }), "rejected"],
      ["compressed-object-out-of-range-index-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ index: 1 }), "rejected"],
      ["compressed-object-circular-container-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ container: 6 }), "rejected"],
      ["valid-free-list-pdf", "note.pdf", "application/pdf", classicPdfWithFreeChain(), "clean"],
      ["free-list-to-in-use-pdf", "note.pdf", "application/pdf", classicPdfWithFreeChain({ head: 1 }), "rejected"],
      ["cyclic-free-list-pdf", "note.pdf", "application/pdf", classicPdfWithFreeChain({ head: 5, next: 5 }), "rejected"],
      ["free-list-to-compressed-object-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCompressedObject({ freeHead: 6 }), "rejected"],
      ["classic-max-generation-pdf", "note.pdf", "application/pdf", classicPdfWithCatalogGeneration(65535), "clean"],
      ["stream-max-generation-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCatalogGeneration(65535), "clean"],
      ["classic-overflow-generation-pdf", "note.pdf", "application/pdf", classicPdfWithCatalogGeneration(99999), "rejected"],
      ["classic-bad-object-zero-generation-pdf", "note.pdf", "application/pdf", Buffer.from(validPdfText.replace("0000000000 65535 f", "0000000000 00000 f"), "latin1"), "rejected"],
      ["stream-overflow-generation-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCatalogGeneration(65536), "rejected"],
      ["stream-bad-object-zero-generation-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithCatalogGeneration(0, 65534), "rejected"],
      ["classic-in-use-object-zero-pdf", "note.pdf", "application/pdf", classicPdfWithInUseObjectZero(), "rejected"],
      ["stream-in-use-object-zero-pdf", "note.pdf", "application/pdf", xrefStreamPdfWithInUseObjectZero(), "rejected"],
      ["benign-outline-next-pdf", "note.pdf", "application/pdf", structuredPdf("/Outlines 5 0 R", ["5 0 obj\n<</Type /Outlines /First 6 0 R /Last 7 0 R /Count 2>>\nendobj\n", "6 0 obj\n<</Title (First) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit]>>\nendobj\n", "7 0 obj\n<</Title (Second) /Parent 5 0 R /Prev 6 0 R /Dest [3 0 R /Fit]>>\nendobj\n"]), "clean"],
      ["xfa-packet-pdf", "note.pdf", "application/pdf", structuredPdf("/AcroForm <</Fields [] /XFA [(template) 5 0 R]>>", ["5 0 obj\n<</Length 43>>\nstream\n<template><script>xfa.host</script></template>\nendstream\nendobj\n"]), "rejected"],
      ["xfa-formcalc-pdf", "note.pdf", "application/pdf", structuredPdf("/AcroForm <</Fields [] /XFA 5 0 R>>", ["5 0 obj\n<</Length 24>>\nstream\n$host.messageBox(\"x\")\nendstream\nendobj\n"]), "rejected"],
      ["valid-jpeg", "photo.jpg", "image/jpeg", minimalJpeg(), "clean"], ["bad-jpeg", "photo.jpg", "image/jpeg", minimalJpeg().subarray(0, -1), "rejected"], ["missing-dqt-jpeg", "photo.jpg", "image/jpeg", removeJpegSegments(minimalJpeg(), 0xdb), "rejected"], ["missing-dht-jpeg", "photo.jpg", "image/jpeg", removeJpegSegments(minimalJpeg(), 0xc4), "rejected"], ["component-jpeg", "photo.jpg", "image/jpeg", breakJpegComponent(minimalJpeg()), "rejected"],
      ["valid-png", "photo.png", "image/png", validPng, "clean"], ["bad-png", "photo.png", "image/png", Buffer.from(validPng.map((byte, index) => index === 40 ? byte ^ 1 : byte)), "rejected"], ["bad-zlib-png", "photo.png", "image/png", badZlibPng, "rejected"], ["bad-filter-png", "photo.png", "image/png", badFilterPng, "rejected"], ["bad-order-png", "photo.png", "image/png", badOrderPng, "rejected"],
      ["valid-pdf", "note.pdf", "application/pdf", validPdf, "clean"], ["nonzero-generation-pdf", "note.pdf", "application/pdf", validNonzeroGenerationPdf, "clean"], ["out-of-order-classic-xref", "note.pdf", "application/pdf", outOfOrderClassicXrefPdf(), "clean"], ["binary-header-pdf", "note.pdf", "application/pdf", minimalPdfWithBinaryHeaderComment(), "clean"], ["incremental-pdf", "note.pdf", "application/pdf", incrementalPdf(), "clean"], ["xref-stream-pdf", "note.pdf", "application/pdf", xrefStreamPdf(), "clean"], ["compressed-xref-stream-pdf", "note.pdf", "application/pdf", xrefStreamPdf(true), "clean"], ["array-filter-xref-stream-pdf", "note.pdf", "application/pdf", xrefStreamPdf("array"), "clean"], ["incremental-xref-stream-pdf", "note.pdf", "application/pdf", incrementalXrefStreamPdf(), "clean"], ["hybrid-xref-pdf", "note.pdf", "application/pdf", hybridXrefPdf(), "clean"], ["hybrid-with-intervening-object", "note.pdf", "application/pdf", hybridXrefPdf(true), "clean"], ["incremental-hybrid-xref", "note.pdf", "application/pdf", incrementalHybridXrefPdf(), "clean"], ["hybrid-classic-precedence", "note.pdf", "application/pdf", conflictingHybridMappingPdf(), "clean"], ["swapped-classic-xref-entries", "note.pdf", "application/pdf", swappedClassicPdf, "rejected"], ["corrupt-hybrid-xref-stream", "note.pdf", "application/pdf", invalidHybridPdf, "rejected"], ["multiple-filter-xref-stream", "note.pdf", "application/pdf", xrefStreamPdf("multiple"), "rejected"], ["trailing-comment-pdf", "note.pdf", "application/pdf", Buffer.concat([validPdf, Buffer.from("% retained by archive\n")]), "clean"], ["pdf-zip-polyglot", "note.pdf", "application/pdf", Buffer.concat([validPdf, Buffer.from("PK\x03\x04archive")]), "rejected"], ["pdf-script-tail", "note.pdf", "application/pdf", Buffer.concat([validPdf, Buffer.from("#!/bin/sh\necho unsafe\n")]), "rejected"], ["forged-pdf-zip-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from("PK\x03\x04archive")), "rejected"], ["forged-pdf-elf-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "rejected"], ["forged-pdf-pe-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from("MZexecutable")), "rejected"], ["forged-pdf-script-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from("#!/bin/sh\necho unsafe\n")), "rejected"], ["forged-pdf-random-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from([0xde, 0xad, 0xbe, 0xef])), "rejected"], ["forged-pdf-printable-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, Buffer.from("printable garbage")), "rejected"], ["forged-second-pdf-tail", "note.pdf", "application/pdf", forgedPdfTail(validPdf, minimalPdf()), "rejected"], ["initial-pdf-zip-gap", "note.pdf", "application/pdf", initialPdfWithUnclaimedBytes(Buffer.from("PK\x03\x04archive")), "rejected"], ["initial-pdf-random-gap", "note.pdf", "application/pdf", initialPdfWithUnclaimedBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef])), "rejected"], ["ordinary-stream-fake-xref", "note.pdf", "application/pdf", masqueradingXrefStream("/Size 6 /W [1 4 2]"), "rejected"], ["invalid-width-fake-xref", "note.pdf", "application/pdf", masqueradingXrefStream("/Type /XRef /Size 6 /W [1 0 2]"), "rejected"], ["benign-border-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /Annot /Subtype /Square /Rect [0 0 1 1] /BS <</Type /Border /W 1 /S /D /D [3 2]>>>>\nendobj\n"], "/Annots [5 0 R]"), "clean"], ["benign-form-pdf", "note.pdf", "application/pdf", structuredPdf("/AcroForm 5 0 R", ["5 0 obj\n<</Fields [6 0 R] /DA (/Helv 10 Tf 0 g)>>\nendobj\n", "6 0 obj\n<</Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [0 0 1 1] /V (safe) /BS <</W 1 /S /S>>>>\nendobj\n"], "/Annots [6 0 R]"), "clean"], ["benign-transparency-pdf", "note.pdf", "application/pdf", structuredPdf("", [], "/Group <</Type /Group /S /Transparency /CS /DeviceRGB>>"), "clean"], ["bad-pdf", "note.pdf", "application/pdf", Buffer.from("%PDF-1.4\nnot a document"), "rejected"], ["encrypted-pdf", "note.pdf", "application/pdf", Buffer.concat([validPdf, Buffer.from("/Encrypt")]), "rejected"], ["javascript-action-pdf", "note.pdf", "application/pdf", structuredPdf("/OpenAction 5 0 R", ["5 0 obj\n<</S /JavaScript /JS (app.alert('x'))>>\nendobj\n"]), "rejected"], ["launch-action-pdf", "note.pdf", "application/pdf", structuredPdf("/OpenAction 5 0 R", ["5 0 obj\n<</S /Launch /F (payload.exe)>>\nendobj\n"]), "rejected"], ["page-aa-uri-pdf", "note.pdf", "application/pdf", structuredPdf("", [], "/AA <</O <</S /URI /URI (https://example.invalid/)>>>>"), "rejected"], ["catalog-aa-pdf", "note.pdf", "application/pdf", structuredPdf("/AA <</WC <</S /Named /N /Print>>>>", []), "rejected"], ["annotation-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /Annot /Subtype /Link /Rect [0 0 1 1] /A <</S /URI /URI (https://example.invalid/)>>>>\nendobj\n"], "/Annots [5 0 R]"), "rejected"], ["indirect-type-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type 6 0 R /S /D>>\nendobj\n", "6 0 obj\n/Action\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["indirect-subtype-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</S 6 0 R /URI (https://example.invalid/)>>\nendobj\n", "6 0 obj\n/URI\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["multihop-semantic-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</S 6 0 R /URI (https://example.invalid/)>>\nendobj\n", "6 0 obj\n7 0 R\nendobj\n", "7 0 obj\n/URI\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["cyclic-semantic-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</S 6 0 R>>\nendobj\n", "6 0 obj\n7 0 R\nendobj\n", "7 0 obj\n6 0 R\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["missing-semantic-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</S 99 0 R>>\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["malformed-semantic-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</S (URI)>>\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["nested-indirect-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Evidence 6 0 R>>\nendobj\n", "6 0 obj\n<</S /URI /URI (https://example.invalid/)>>\nendobj\n"], "/PieceInfo 5 0 R"), "rejected"], ["indirect-next-action-pdf", "note.pdf", "application/pdf", structuredPdf("/OpenAction 5 0 R", ["5 0 obj\n<</S /GoTo /D [3 0 R /Fit] /Next [6 0 R]>>\nendobj\n", "6 0 obj\n<</S /URI /URI (https://example.invalid/)>>\nendobj\n"]), "rejected"], ["submit-form-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /Action /S /SubmitForm /F (https://example.invalid/)>>\nendobj\n"], "/AA <</O 5 0 R>>"), "rejected"], ["import-data-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /Action /S /ImportData /F (payload.fdf)>>\nendobj\n"], "/AA <</O 5 0 R>>"), "rejected"], ["names-javascript-pdf", "note.pdf", "application/pdf", structuredPdf("/Names <</JavaScript 5 0 R>>", ["5 0 obj\n<</Names [(startup) 6 0 R]>>\nendobj\n", "6 0 obj\n<</S /JavaScript /JS (app.alert('x'))>>\nendobj\n"]), "rejected"], ["filespec-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /Filespec /F (evidence.txt)>>\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["embedded-file-stream-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Type /EmbeddedFile /Length 4>>\nstream\nevil\nendstream\nendobj\n"], "/PieceInfo <</Evidence 5 0 R>>"), "rejected"], ["embedded-file-pdf", "note.pdf", "application/pdf", structuredPdf("/Names <</EmbeddedFiles 5 0 R>>", ["5 0 obj\n<</Names [(evidence.txt) 6 0 R]>>\nendobj\n", "6 0 obj\n<</Type /Filespec /F (evidence.txt) /EF <</F 7 0 R>>>>\nendobj\n", "7 0 obj\n<</Type /EmbeddedFile /Length 4>>\nstream\nevil\nendstream\nendobj\n"]), "rejected"],
      ["tagged-layout-attributes-pdf", "note.pdf", "application/pdf", structuredPdf("/MarkInfo <</Marked true>> /StructTreeRoot 5 0 R", ["5 0 obj\n<</Type /StructTreeRoot /K [6 0 R]>>\nendobj\n", "6 0 obj\n<</Type /StructElem /S /P /P 5 0 R /Pg 3 0 R /A <</O /Layout /TextAlign /Center>>>>\nendobj\n"]), "clean"],
      ["icon-fit-alignment-pdf", "note.pdf", "application/pdf", structuredPdf("/AcroForm 5 0 R", ["5 0 obj\n<</Fields [6 0 R]>>\nendobj\n", "6 0 obj\n<</Type /Annot /Subtype /Widget /FT /Btn /Rect [0 0 1 1] /MK <</IF 7 0 R>>>>\nendobj\n", "7 0 obj\n<</SW /A /S /P /A [0.5 0.5]>>\nendobj\n"], "/Annots [6 0 R]"), "clean"],
      ["untyped-annotation-action-pdf", "note.pdf", "application/pdf", structuredPdf("", ["5 0 obj\n<</Rect [0 0 1 1] /A 6 0 R>>\nendobj\n", "6 0 obj\n<</D [3 0 R /Fit]>>\nendobj\n"], "/Annots [5 0 R]"), "rejected"],
      ["unparented-outline-action-pdf", "note.pdf", "application/pdf", structuredPdf("/Outlines 5 0 R", ["5 0 obj\n<</First 6 0 R /Last 6 0 R /Count 1>>\nendobj\n", "6 0 obj\n<</Title (Unsafe) /A 7 0 R>>\nendobj\n", "7 0 obj\n<</D [3 0 R /Fit]>>\nendobj\n"]), "rejected"],
      ["deep-parenthesized-shell-command", "note.txt", "text/plain", Buffer.from("(".repeat(255) + "supportNote" + ")".repeat(255)), "rejected"], ["near-bound-regex-control", "note.txt", "text/plain", Buffer.from("/" + "(".repeat(256) + "evidence" + ")".repeat(256) + "/"), "clean"], ["deep-parenthesized-call", "note.txt", "text/plain", Buffer.from("(".repeat(1000) + "alert(1)" + ")".repeat(1000)), "rejected"], ["deep-array-call", "note.txt", "text/plain", Buffer.from("[".repeat(1000) + "alert(1)" + "]".repeat(1000)), "rejected"], ["deep-unary-call", "note.txt", "text/plain", Buffer.from("!".repeat(4000) + "alert(1)"), "rejected"], ["deep-await-call", "note.txt", "text/plain", Buffer.from("await ".repeat(1000) + "alert(1)"), "rejected"], ["deep-new-call", "note.txt", "text/plain", Buffer.from("new ".repeat(1000) + "alert(1)"), "rejected"], ["deep-arrow-call", "note.txt", "text/plain", Buffer.from("a=>".repeat(1000) + "alert(1)"), "rejected"], ["deep-conditional-call", "note.txt", "text/plain", Buffer.from("a?".repeat(1000) + "alert(1)" + ":a".repeat(1000)), "rejected"], ["deep-regex-capture-call", "note.txt", "text/plain", Buffer.from("/" + "(".repeat(1000) + "alert" + ")".repeat(1000) + "/"), "rejected"],
      ["deep-unicode-set-regex", "note.txt", "text/plain", Buffer.from("/" + "[".repeat(1000) + "a" + "]".repeat(1000) + "/v"), "rejected"], ["shallow-slash-prose-control", "note.txt", "text/plain", Buffer.from("if (ready) /" + "[({])}".repeat(129) + "/"), "clean"],
      ["python-import-filesystem-call", "note.txt", "text/plain", Buffer.from("import pathlib\npathlib.Path(\"/tmp/report\").unlink()"), "rejected"],
      ["python-import-alias", "note.txt", "text/plain", Buffer.from("import os as operating_system"), "rejected"], ["python-from-import", "note.txt", "text/plain", Buffer.from("from os.path import join as combine"), "rejected"], ["python-subscript-call", "note.txt", "text/plain", Buffer.from("registry[\"handler\"]()"), "rejected"], ["python-indented-block", "note.txt", "text/plain", Buffer.from("if ready:\n    process()"), "rejected"], ["python-decorator", "note.txt", "text/plain", Buffer.from("@register\ndef handler():\n    pass"), "rejected"], ["python-lambda", "note.txt", "text/plain", Buffer.from("lambda item: process(item)"), "rejected"], ["python-comprehension", "note.txt", "text/plain", Buffer.from("[process(item) for item in items]"), "rejected"],
      ["shell-quoted-tail-bypass", "note.txt", "text/plain", Buffer.from('"safe"; cat /etc/passwd; "tail"'), "rejected"],
      ["shell-parenthesized-subshell", "note.txt", "text/plain", Buffer.from("(whoami)"), "rejected"],
      ["shell-executable-prefix-error", "note.txt", "text/plain", Buffer.from("printf pwned > /tmp/x\nif"), "rejected"],
      ["shell-incomplete-only", "note.txt", "text/plain", Buffer.from("printf pwned >"), "clean"],
      ["shell-bare-builtin", "note.txt", "text/plain", Buffer.from("whoami"), "rejected"],
      ["shell-quoted-builtin", "note.txt", "text/plain", Buffer.from("'whoami'"), "rejected"],
      ["shell-bash-builtin", "note.txt", "text/plain", Buffer.from("shopt"), "rejected"],
      ["shell-quoted-bash-builtin", "note.txt", "text/plain", Buffer.from("\"shopt\""), "rejected"],
      ["shell-sentence-path-command", "note.txt", "text/plain", Buffer.from(`${sentenceExecutable} argument.`), "rejected"],
      ["shell-sentence-quoted-path-command", "note.txt", "text/plain", Buffer.from(`"${sentenceExecutable}" --flag value.`), "rejected"],
      ["shell-sentence-star-expansion", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/* argument.`), "rejected"],
      ["shell-sentence-question-expansion", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/r?n argument.`), "rejected"],
      ["shell-sentence-class-expansion", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[r]un argument.`), "rejected"],
      ["shell-sentence-brace-expansion", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/{run,nope} argument.`), "rejected"],
      ["shell-sentence-numeric-brace-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{1..2} argument.`), "rejected"],
      ["shell-sentence-padded-brace-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{01..02} argument.`), "rejected"],
      ["shell-sentence-alpha-brace-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{a..b} argument.`), "rejected"],
      ["shell-sentence-stepped-brace-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{5..1..2} argument.`), "rejected"],
      ["shell-sentence-descending-alpha-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{b..a} argument.`), "rejected"],
      ["shell-sentence-tilde-brace-sequence", "note.txt", "text/plain", Buffer.from("~/Payload/run{1..2} argument."), "rejected"],
      ["shell-sentence-current-user-tilde", "note.txt", "text/plain", Buffer.from("~sporades-fixture/Payload/run argument."), "rejected"],
      ["shell-sentence-posix-alpha-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:alpha:]]una argument.`), "rejected"],
      ["shell-sentence-posix-digit-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:digit:]]un argument.`), "rejected"],
      ["shell-sentence-posix-alnum-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:alnum:]]una argument.`), "rejected"],
      ["shell-sentence-posix-negated-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[![:digit:]]una argument.`), "rejected"],
      ["shell-sentence-posix-mixed-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:digit:]r]una argument.`), "rejected"],
      ["shell-sentence-posix-locale-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:alpha:]]locale argument.`), "rejected"],
      ["shell-sentence-active-unmatched-posix-class", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[[:digit:]]una remains unavailable.`), "rejected"],
      ["shell-sentence-path-literal-fallback", "note.txt", "text/plain", Buffer.from("Run* argument."), "rejected"],
      ["shell-sentence-matched-path-command", "note.txt", "text/plain", Buffer.from("Match* argument."), "rejected"],
      ["shell-completed-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument.\nIf (then)."), "rejected"],
      ["shell-completed-prefix-before-later-error-crlf", "note.txt", "text/plain", Buffer.from("Payload/run argument.\r\nIf (then)."), "rejected"],
      ["shell-completed-quoted-prefix-before-later-error", "note.txt", "text/plain", Buffer.from('"Payload/run" argument.\nIf (then).'), "rejected"],
      ["shell-completed-escaped-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload\\/run argument.\nIf (then)."), "rejected"],
      ["shell-completed-commented-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument. # comment\nIf (then)."), "rejected"],
      ["shell-completed-and-or-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument. && true\nIf (then)."), "rejected"],
      ["shell-completed-or-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument. || true\nIf (then)."), "rejected"],
      ["shell-multiple-completed-prefixes-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument.\nRunner argument.\nIf (then)."), "rejected"],
      ["shell-completed-if-before-later-error", "note.txt", "text/plain", Buffer.from("if true; then\n Payload/run argument.\nfi\nIf (then)."), "rejected"],
      ["shell-completed-group-before-later-error", "note.txt", "text/plain", Buffer.from("{\n Payload/run argument.\n}\nIf (then)."), "rejected"],
      ["shell-completed-function-before-later-error", "note.txt", "text/plain", Buffer.from("work() {\n Payload/run argument.\n}\nwork\nIf (then)."), "rejected"],
      ["shell-completed-case-before-later-error", "note.txt", "text/plain", Buffer.from("case one in\n one) Payload/run argument. ;;\nesac\nIf (then)."), "rejected"],
      ["shell-completed-while-before-later-error", "note.txt", "text/plain", Buffer.from("while true; do\n Payload/run argument.\ndone\nIf (then)."), "rejected"],
      ["shell-completed-loop-before-later-error", "note.txt", "text/plain", Buffer.from("for item in one; do\n Payload/run argument.\ndone\nIf (then)."), "rejected"],
      ["shell-completed-subshell-before-later-error", "note.txt", "text/plain", Buffer.from("(\n Payload/run argument.\n)\nIf (then)."), "rejected"],
      ["shell-completed-nested-unit-before-later-error", "note.txt", "text/plain", Buffer.from("if true; then\n {\n  Payload/run argument.\n }\nfi\nIf (then)."), "rejected"],
      ...[127, 128, 129].map((length) => [`shell-sentence-bracket-bound-${length}`, "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[${"r".repeat(length)}]run argument.`), "rejected"]),
      ["shell-sentence-oversized-posix-bracket", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[${"r".repeat(128)}[:alpha:]]run argument.`), "rejected"],
      ["shell-ordinary-label", "note.txt", "text/plain", Buffer.from("ticket_reference"), "clean"],
      ["valid-shell-slash-prose", "note.txt", "text/plain", Buffer.from("Please review docs/v1.2 at https://example.test/tickets/42."), "clean"],
      ["valid-shell-leading-letter-slash", "note.txt", "text/plain", Buffer.from("A/B testing remains active."), "clean"],
      ["valid-shell-leading-ratio", "note.txt", "text/plain", Buffer.from("One/two ratio."), "clean"],
      ["valid-shell-leading-version", "note.txt", "text/plain", Buffer.from("/v1.2 is current."), "clean"],
      ["valid-shell-leading-docs-path", "note.txt", "text/plain", Buffer.from("docs/v1.2 release notes."), "clean"],
      ["valid-shell-unmatched-star", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/missing* remains unavailable.`), "clean"],
      ["valid-shell-unmatched-brace", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/{nope,missing} remains unavailable.`), "clean"],
      ["valid-shell-zero-step-brace", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{1..3..0} remains documented.`), "clean"],
      ["valid-shell-malformed-brace-sequence", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/run{1..x} remains documented.`), "clean"],
      ["valid-shell-unmatched-path-pattern", "note.txt", "text/plain", Buffer.from("NoMatch* remains unavailable."), "clean"],
      ["valid-shell-non-x-path-literal", "note.txt", "text/plain", Buffer.from("Miss* remains unavailable."), "clean"],
      ["valid-shell-path-directory", "note.txt", "text/plain", Buffer.from("DirMatch* remains available."), "clean"],
      ["shell-semicolon-prefix-before-later-error", "note.txt", "text/plain", Buffer.from("Payload/run argument.; If (then)."), "rejected"],
      ["valid-shell-incomplete-and-or-before-error", "note.txt", "text/plain", Buffer.from("Payload/run argument. &&\nIf (then)."), "clean"],
      ["valid-shell-same-line-or-error-before-execution", "note.txt", "text/plain", Buffer.from("Payload/run argument. || If (then)."), "clean"],
      ["valid-shell-error-before-runnable-line", "note.txt", "text/plain", Buffer.from("If (then).\nPayload/run argument."), "clean"],
      ["valid-shell-malformed-only-lines", "note.txt", "text/plain", Buffer.from("If (then).\nWhen (else)."), "clean"],
      ["valid-shell-incomplete-if-unit", "note.txt", "text/plain", Buffer.from("if true; then\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-if-crlf-comments", "note.txt", "text/plain", Buffer.from("if true; then\r\n # comment\r\n\r\n Payload/run argument.\r\nIf (then)."), "clean"],
      ["valid-shell-incomplete-group-unit", "note.txt", "text/plain", Buffer.from("{\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-function-unit", "note.txt", "text/plain", Buffer.from("work() {\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-case-unit", "note.txt", "text/plain", Buffer.from("case one in\n one) Payload/run argument. ;;\nIf (then)."), "clean"],
      ["valid-shell-incomplete-while-unit", "note.txt", "text/plain", Buffer.from("while true; do\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-loop-unit", "note.txt", "text/plain", Buffer.from("for item in one; do\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-subshell-unit", "note.txt", "text/plain", Buffer.from("(\n Payload/run argument.\nIf (then)."), "clean"],
      ["valid-shell-incomplete-nested-unit", "note.txt", "text/plain", Buffer.from("if true; then\n {\n  Payload/run argument.\n }\nIf (then)."), "clean"],
      ["valid-shell-unterminated-oversized-bracket", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[${"r".repeat(129)}run remains documented.`), "clean"],
      ["valid-shell-malformed-empty-bracket", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/[]run remains documented.`), "clean"],
      ["valid-shell-quoted-oversized-bracket", "note.txt", "text/plain", Buffer.from(`"${path.dirname(sentenceExecutable)}/[${"r".repeat(129)}]run" remains documented.`), "clean"],
      ["valid-shell-escaped-oversized-bracket", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/\\[${"r".repeat(129)}\\]run remains documented.`), "clean"],
      ["valid-shell-quoted-tilde", "note.txt", "text/plain", Buffer.from('"~/Payload/run" remains documented.'), "clean"],
      ["valid-shell-escaped-tilde", "note.txt", "text/plain", Buffer.from("\\~/Payload/run remains documented."), "clean"],
      ["valid-shell-tilde-prose", "note.txt", "text/plain", Buffer.from("Tilde ~ means home."), "clean"],
      ["valid-shell-quoted-star", "note.txt", "text/plain", Buffer.from(`"${path.dirname(sentenceExecutable)}/*" remains documented.`), "clean"],
      ["valid-shell-escaped-star", "note.txt", "text/plain", Buffer.from(`${path.dirname(sentenceExecutable)}/\\* remains documented.`), "clean"],
      ["valid-shell-unmatched-tilde", "note.txt", "text/plain", Buffer.from("~/sporades-file-ingress-no-such-command-* remains unavailable."), "clean"],
      ["valid-text", "note.txt", "text/plain", Buffer.from("A harmless support note.\nSecond line."), "clean"], ["valid-prose-parenthesis", "note.txt", "text/plain", Buffer.from("Call me (tomorrow) about the ticket."), "clean"], ["valid-prose-nested-parentheses", "note.txt", "text/plain", Buffer.from("Please (if practical) call me tomorrow."), "clean"], ["valid-quoted-call-prose", "note.txt", "text/plain", Buffer.from("alert(\"x\") is the exact text shown in the report."), "clean"], ["html", "note.txt", "text/plain", Buffer.from("Please inspect <script>alert(1)</script>"), "rejected"], ["xml", "note.txt", "text/plain", Buffer.from("prefix <?xml version=\"1.0\"?><x/>") , "rejected"], ["generic-xml", "note.txt", "text/plain", Buffer.from("prefix <root>value</root> suffix"), "rejected"], ["javascript", "note.txt", "text/plain", Buffer.from("const answer = 42; console.log(answer);"), "rejected"], ["javascript-call", "note.txt", "text/plain", Buffer.from("alert(\"x\")"), "rejected"], ["javascript-member-call", "note.txt", "text/plain", Buffer.from("globalThis.fetch(\"/secret\")"), "rejected"], ["javascript-comment-call", "note.txt", "text/plain", Buffer.from("/* evidence */ alert(\"x\")"), "rejected"], ["javascript-parenthesized-callee", "note.txt", "text/plain", Buffer.from("(alert)(\"x\")"), "rejected"], ["javascript-computed-member-call", "note.txt", "text/plain", Buffer.from("globalThis[\"fetch\"](\"/secret\")"), "rejected"], ["javascript-unicode-identifier", "note.txt", "text/plain", Buffer.from("al\\u0065rt(\"x\")"), "rejected"], ["javascript-void-call", "note.txt", "text/plain", Buffer.from("void alert(\"x\")"), "rejected"], ["javascript-optional-chain-call", "note.txt", "text/plain", Buffer.from("globalThis?.fetch?.(\"/secret\")"), "rejected"], ["javascript-new-call", "note.txt", "text/plain", Buffer.from("new Function(\"return 1\")()"), "rejected"], ["javascript-dynamic-import", "note.txt", "text/plain", Buffer.from("import(\"/secret\")"), "rejected"], ["javascript-static-import", "note.txt", "text/plain", Buffer.from("import \"./side-effect.js\""), "rejected"], ["javascript-eval-call", "note.txt", "text/plain", Buffer.from("eval(\"alert(1)\")"), "rejected"], ["javascript-arrow-iife", "note.txt", "text/plain", Buffer.from("(() => alert(\"x\"))()"), "rejected"], ["javascript-tagged-template", "note.txt", "text/plain", Buffer.from("String.raw`secret`"), "rejected"], ["javascript-delete", "note.txt", "text/plain", Buffer.from("delete globalThis.secret"), "rejected"], ["javascript-sequence-callee", "note.txt", "text/plain", Buffer.from("(0, alert)(\"x\")"), "rejected"], ["python", "note.txt", "text/plain", Buffer.from("print(\"hello\")"), "rejected"], ["shell", "note.txt", "text/plain", Buffer.from("curl https://example.test | sh"), "rejected"], ["shell-unlisted-command", "note.txt", "text/plain", Buffer.from("cat /etc/passwd"), "rejected"], ["shell-echo", "note.txt", "text/plain", Buffer.from("echo secret > output"), "rejected"], ["shell-source", "note.txt", "text/plain", Buffer.from("source ./profile"), "rejected"],
      ["archive", "note.zip", "application/zip", Buffer.from("PK\x03\x04archive"), "rejected"], ["office", "note.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\x03\x04office"), "rejected"], ["executable", "note.exe", "application/octet-stream", Buffer.from("MZbinary"), "rejected"], ["empty", "note.txt", "text/plain", Buffer.alloc(0), "rejected"], ["polyglot", "photo.jpg", "image/jpeg", Buffer.concat([minimalJpeg(), Buffer.from("const x=1")]), "rejected"], ["unknown", "note.bin", "application/octet-stream", Buffer.from([0xff,0,0xaa]), "rejected"],
    ];
    for (const [key, name, type, bytes, expected] of cases) { const endpoint = { options: { method: "POST", path: "/matrix", body: { multipart: policy } } }; const headers = { "content-type": `multipart/form-data; boundary=${key}`, "idempotency-key": key }; const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartBinary(key, name, type, bytes); } }, { headers }, { userId: "claim-user" }); const receipt = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload); assert.equal(receipt.inspection.verdicts[0].outcome, expected, key); }
    const tildeEnvironments = [
      ["missing-home", () => { delete process.env.HOME; }, "~/Payload/run argument."], ["empty-home", () => { process.env.HOME = ""; }, "~/Payload/run argument."],
      ["relative-home", () => { process.env.HOME = "relative/home"; }, "~/Payload/run argument."], ["overlong-home", () => { process.env.HOME = "x".repeat(4097); }, "~/Payload/run argument."],
      ["missing-user", () => { delete process.env.USER; }, "~sporades-fixture/Payload/run argument."], ["mismatched-user", () => { process.env.USER = "someone-else"; }, "~sporades-fixture/Payload/run argument."],
      ["unsupported-user", () => {}, "~unsupported/Payload/run argument."],
    ];
    for (const [key, mutate, text] of tildeEnvironments) { process.env.HOME = dir; process.env.USER = "sporades-fixture"; mutate(); const endpoint = { options: { method: "POST", path: "/matrix", body: { multipart: policy } } }; const headers = { "content-type": `multipart/form-data; boundary=tilde-${key}`, "idempotency-key": `tilde-${key}` }; const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartBinary(`tilde-${key}`, "note.txt", "text/plain", Buffer.from(text)); } }, { headers }, { userId: "claim-user" }); const receipt = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload); assert.equal(receipt.inspection.verdicts[0].outcome, "rejected", key); }
  } finally { process.chdir(originalCwd); if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; if (originalUser === undefined) delete process.env.USER; else process.env.USER = originalUser; if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("strict text inspection accepts its exact 1 MiB parser limit and rejects one byte beyond it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-text-bound-")); let database;
  try {
    const limit = 1024 * 1024; const inspection = { policyRevision: "text-bound-v1", requiredInspectors: ["content-policy-v1"] };
    const endpoint = { options: { method: "POST", path: "/text-bound", body: { multipart: { ...ingressPolicy(), maxFileBytes: limit + 1, maxTotalFileBytes: limit + 1, inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "text-bound", files: { storagePath: path.join(dir, "files"), maxSizeBytes: limit + 1 } }, capsule({ name: "text-bound" }));
    for (const [key, size, expected] of [["at-limit", limit, "clean"], ["over-limit", limit + 1, "rejected"]]) {
      const headers = { "content-type": `multipart/form-data; boundary=${key}`, "idempotency-key": key };
      const staged = await stageMultipartIngress(database, endpoint, { async *[Symbol.asyncIterator]() { yield multipartBinary(key, "note.txt", "text/plain", Buffer.alloc(size, 97)); } }, { headers }, { userId: "claim-user" });
      const receipt = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload);
      assert.equal(receipt.inspection.verdicts[0].outcome, expected, key);
    }
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("PDF inspection times out and destroys work during the operator-list phase", async () => {
  let entered = false; const accepted = await validatePdfIngress(minimalPdf(), { timeoutMs: 10, beforeOperatorList: async () => { entered = true; await new Promise((resolve) => setTimeout(resolve, 100)); } }); assert.equal(entered, true); assert.equal(accepted, false);
});

test("inspection-gated clean claims have the same evidence and File semantics on fake MinIO", async () => {
  await withFakeS3CompatibleService(async ({ endpoint: storageEndpoint, objects }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspection-minio-")); let database; const namespace = `inspection-${randomUUID()}`;
    try { const serviceEnv = { SPORADES_SERVICE_STORAGE_ENGINE: "minio", SPORADES_SERVICE_STORAGE_ENDPOINT: storageEndpoint, SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades", SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret", SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files", SPORADES_SERVICE_STORAGE_REGION: "eu-west-2", SPORADES_SERVICE_STORAGE_NAMESPACE: namespace }; const config = { name: namespace, services: { storage: { kind: "storage", engine: "minio" } } };
      database = await openDevDatabase(path.join(dir, "data.db"), "", serviceEnv, config, capsule({ name: namespace }), { serviceEnv }); const endpoint = { options: { method: "POST", path: "/inspection-minio", body: { multipart: { ...ingressPolicy(), inspection: { policyRevision: "minio-v1", requiredInspectors: ["content-policy-v1"] } } } } }; const request = ingressRequest("inspection-minio"); const staged = await stageMultipartIngress(database, endpoint, request, { headers: request.headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0]; const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: "inspection-minio", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } }); const file = await api.claim(lease, { path: "/attachments/minio.txt" }); const evidence = await api.inspection(lease); assert.equal(evidence.verdicts[0].outcome, "clean"); assert.equal(evidence.verdicts[0].version, file.version); assert.ok([...objects.keys()].some((key) => key.includes(file.id)));
    } finally { await database?.close(); for (const key of [...objects.keys()].filter((value) => value.startsWith(`capsules/${namespace}/`))) objects.delete(key); await rm(dir, { recursive: true, force: true }); }
  });
});

test("a clean required verdict must remain current and exactly match the staged receipt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspection-current-")); let database;
  try {
    const inspection = { policyRevision: "attachments-v1", maxVerdictAgeMs: 1_000, requiredInspectors: ["content-policy-v1"] };
    const endpoint = { options: { method: "POST", path: "/inspection-current", body: { multipart: { ...ingressPolicy(), inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspection-current", files: { storagePath: path.join(dir, "files") } }, capsule({ name: "inspection-current" }));
    const staged = await stageMultipartIngress(database, endpoint, ingressRequest("inspection-current"), { headers: ingressRequest("inspection-current").headers }, { userId: "claim-user" }); const lease = staged.multipart.files[0];
    const api = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: "inspection-current", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    const row = await database.adapter.selectIngressByLease(lease.leaseId); const original = JSON.parse(row.payload);
    for (const mutate of [
      (verdict) => { verdict.leaseId = "wrong"; }, (verdict) => { verdict.size += 1; }, (verdict) => { verdict.digest = "0".repeat(64); }, (verdict) => { verdict.version = "wrong"; }, (verdict) => { verdict.policyRevision = "wrong"; },
      (verdict) => { verdict.inspectedAt = "2000-01-01T00:00:00.000Z"; }, (verdict) => { verdict.inspectedAt = "2999-01-01T00:00:00.000Z"; }, (verdict) => { verdict.inspectedAt = "malformed"; },
    ]) { const receipt = structuredClone(original); mutate(receipt.inspection.verdicts[0]); await database.adapter.prepare("UPDATE [sporades_file_ingress] SET [payload] = ? WHERE [leaseId] = ?").run(JSON.stringify(receipt), lease.leaseId); await assert.rejects(api.claim(lease, { path: "/attachments/mismatch.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" }); }
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_files]").get()).count), 0);
    const fresh = await stageMultipartIngress(database, endpoint, ingressRequest("inspection-current-fresh"), { headers: ingressRequest("inspection-current-fresh").headers }, { userId: "claim-user" }); const freshLease = fresh.multipart.files[0];
    const freshApi = createEndpointIngressApi(database, endpoint, { __ingressRequestKey: "inspection-current-fresh", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    const changedPolicy = { options: { ...endpoint.options, body: { multipart: { ...endpoint.options.body.multipart, inspection: { ...inspection, policyRevision: "attachments-v2" } } } } };
    const changedApi = createEndpointIngressApi(database, changedPolicy, { __ingressRequestKey: "inspection-current-fresh", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    await assert.rejects(changedApi.claim(freshLease, { path: "/attachments/revision.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });
    assert.equal((await freshApi.claim(freshLease, { path: "/attachments/current.txt" })).path, "/attachments/current.txt");
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a completed pre-inspection receipt requires fresh current ClamAV evidence before idempotent replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-completed-reinspection-")); let database;
  const databasePath = path.join(dir, "data.db"); const filesPath = path.join(dir, "files");
  const requestKey = "completed-reinspection"; const bytes = Buffer.from("stable completed bytes");
  const request = (boundary) => ({ headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": requestKey }, async *[Symbol.asyncIterator]() { yield multipartBinary(boundary, "claim.txt", "text/plain", bytes); } });
  const legacyEndpoint = { options: { method: "POST", path: "/completed-reinspection", body: { multipart: ingressPolicy() } } };
  const inspection = { policyRevision: "completed-clamav-v2", maxVerdictAgeMs: 60_000, requiredInspectors: ["clamav"] };
  const inspectedEndpoint = { options: { ...legacyEndpoint.options, body: { multipart: { ...ingressPolicy(), inspection } } } };
  const endpointRequest = (boundary) => ({ headers: request(boundary).headers });
  const api = (endpoint) => createEndpointIngressApi(database, endpoint, { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
  const socketPath = path.join(tmpdir(), `clam-${process.pid}-${randomUUID().slice(0, 8)}.sock`); let scanner;
  try {
    database = await openDevDatabase(databasePath, "", {}, { name: "completed-reinspection", files: { storagePath: filesPath } }, capsule({ name: "completed-reinspection" }));
    const firstRequest = request("completed-old");
    const first = await stageMultipartIngress(database, legacyEndpoint, firstRequest, endpointRequest("completed-old"), { userId: "claim-user" });
    const originalFile = await api(legacyEndpoint).claim(first.multipart.files[0], { path: "/attachments/completed.txt" });
    database.__clamavTest = { socketPath, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: new Date().toISOString() } };

    scanner = await fakeClamSocket(socketPath, { response: "stream: Malware FOUND\0" });
    const rejectedRequest = request("completed-reject");
    await assert.rejects(stageMultipartIngress(database, inspectedEndpoint, rejectedRequest, endpointRequest("completed-reject"), { userId: "claim-user" }), { code: "INGRESS_INSPECTION_REQUIRED" });
    let stored = JSON.parse((await database.adapter.selectIngressByLease(first.multipart.files[0].leaseId)).payload);
    assert.equal(stored.inspection.policyRevision, "completed-clamav-v2"); assert.equal(stored.inspection.verdicts[0].outcome, "rejected");

    await new Promise((resolve) => scanner.server.close(resolve)); scanner = await fakeClamSocket(socketPath, { response: "stream: OK\0" });
    const cleanRequest = request("completed-clean");
    const clean = await stageMultipartIngress(database, inspectedEndpoint, cleanRequest, endpointRequest("completed-clean"), { userId: "claim-user" });
    const replayed = await api(inspectedEndpoint).claim(clean.multipart.files[0], { path: "/attachments/completed.txt" });
    assert.equal(replayed.id, originalFile.id); assert.equal(replayed.version, originalFile.version);
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress_audit_outbox]").get()).count), 1);

    await database.close();
    database = await openDevDatabase(databasePath, "", {}, { name: "completed-reinspection", files: { storagePath: filesPath } }, capsule({ name: "completed-reinspection" }));
    const afterRestart = await api(inspectedEndpoint).claim(clean.multipart.files[0], { path: "/attachments/completed.txt" });
    assert.equal(afterRestart.id, originalFile.id);
    stored = JSON.parse((await database.adapter.selectIngressByLease(clean.multipart.files[0].leaseId)).payload);
    assert.equal(stored.inspection.verdicts[0].outcome, "clean");
  } finally { if (scanner) await new Promise((resolve) => scanner.server.close(resolve)); await database?.close(); await rm(socketPath, { force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("concurrent completed retries follow the inspection evidence that wins the durable refresh", async () => {
  for (const race of [
    { name: "rejected-wins", responses: ["stream: OK\0", "stream: Malware FOUND\0"], delays: [30, 0], outcome: "rejected" },
    { name: "clean-wins", responses: ["stream: Malware FOUND\0", "stream: OK\0"], delays: [30, 0], outcome: "clean" },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-ingress-refresh-${race.name}-`)); let database; let scanner;
    const socketPath = path.join(tmpdir(), `clam-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    const requestKey = `refresh-${race.name}`; const bytes = Buffer.from("stable completed race bytes");
    const legacyEndpoint = { options: { method: "POST", path: "/completed-refresh-race", body: { multipart: ingressPolicy() } } };
    const inspection = { policyRevision: `race-${race.name}-v2`, maxVerdictAgeMs: 60_000, requiredInspectors: ["clamav"] };
    const inspectedEndpoint = { options: { ...legacyEndpoint.options, body: { multipart: { ...ingressPolicy(), inspection } } } };
    const request = (boundary) => ({ headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": requestKey }, async *[Symbol.asyncIterator]() { yield multipartBinary(boundary, "claim.txt", "text/plain", bytes); } });
    const stage = async (boundary) => { const incoming = request(boundary); return await stageMultipartIngress(database, inspectedEndpoint, incoming, { headers: incoming.headers }, { userId: "claim-user" }); };
    const api = (endpoint) => createEndpointIngressApi(database, endpoint, { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    try {
      database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: `refresh-${race.name}`, files: { storagePath: path.join(dir, "files") } }, capsule({ name: `refresh-${race.name}` }));
      const initialRequest = request("legacy");
      const initial = await stageMultipartIngress(database, legacyEndpoint, initialRequest, { headers: initialRequest.headers }, { userId: "claim-user" });
      const file = await api(legacyEndpoint).claim(initial.multipart.files[0], { path: "/attachments/race.txt" });
      database.__clamavTest = { socketPath, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: new Date().toISOString() } };
      scanner = await fakeClamSocket(socketPath, { response: (_request, index) => race.responses[index], delayMs: (_request, index) => race.delays[index] });

      const results = await Promise.allSettled([stage("race-first"), stage("race-second")]);
      const stored = JSON.parse((await database.adapter.selectIngressByLease(initial.multipart.files[0].leaseId)).payload);
      assert.equal(stored.inspection.verdicts[0].outcome, race.outcome, race.name);
      if (race.outcome === "rejected") {
        assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
        for (const result of results) assert.equal(result.reason?.code, "INGRESS_INSPECTION_REQUIRED");
        await assert.rejects(api(inspectedEndpoint).claim(initial.multipart.files[0], { path: "/attachments/race.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });
      } else {
        assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
        assert.equal((await api(inspectedEndpoint).claim(initial.multipart.files[0], { path: "/attachments/race.txt" })).id, file.id);
      }
    } finally { if (scanner) await new Promise((resolve) => scanner.server.close(resolve)); await database?.close(); await rm(socketPath, { force: true }); await rm(dir, { recursive: true, force: true }); }
  }
});

test("concurrent leased retries expose claim readiness only from the durable inspection winner", async () => {
  for (const race of [
    { name: "rejected-wins", responses: ["stream: OK\0", "stream: Malware FOUND\0"], delays: [30, 0], outcome: "rejected" },
    { name: "clean-wins", responses: ["stream: Malware FOUND\0", "stream: OK\0"], delays: [30, 0], outcome: "clean" },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-ingress-leased-race-${race.name}-`)); let database; let scanner;
    const socketPath = path.join(tmpdir(), `clam-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    const requestKey = `leased-race-${race.name}`; const bytes = Buffer.from("stable leased race bytes");
    const legacyEndpoint = { options: { method: "POST", path: "/leased-refresh-race", body: { multipart: ingressPolicy() } } };
    const inspection = { policyRevision: `leased-race-${race.name}-v2`, maxVerdictAgeMs: 60_000, requiredInspectors: ["clamav"] };
    const inspectedEndpoint = { options: { ...legacyEndpoint.options, body: { multipart: { ...ingressPolicy(), inspection } } } };
    const request = (boundary) => ({ headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": requestKey }, async *[Symbol.asyncIterator]() { yield multipartBinary(boundary, "claim.txt", "text/plain", bytes); } });
    const stage = async (boundary) => { const incoming = request(boundary); return await stageMultipartIngress(database, inspectedEndpoint, incoming, { headers: incoming.headers }, { userId: "claim-user" }); };
    const api = () => createEndpointIngressApi(database, inspectedEndpoint, { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    try {
      database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: `leased-race-${race.name}`, files: { storagePath: path.join(dir, "files") } }, capsule({ name: `leased-race-${race.name}` }));
      const initialRequest = request("legacy");
      const initial = await stageMultipartIngress(database, legacyEndpoint, initialRequest, { headers: initialRequest.headers }, { userId: "claim-user" });
      database.__clamavTest = { socketPath, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: new Date().toISOString() } };
      scanner = await fakeClamSocket(socketPath, { response: (_request, index) => race.responses[index], delayMs: (_request, index) => race.delays[index] });

      const retries = await Promise.all([stage("race-first"), stage("race-second")]);
      const stored = JSON.parse((await database.adapter.selectIngressByLease(initial.multipart.files[0].leaseId)).payload);
      assert.equal(stored.inspection.verdicts[0].outcome, race.outcome, race.name);
      const claims = await Promise.allSettled(retries.map((retry) => api().claim(retry.multipart.files[0], { path: "/attachments/leased-race.txt" })));
      if (race.outcome === "rejected") {
        assert.deepEqual(claims.map((result) => result.status), ["rejected", "rejected"]);
        for (const result of claims) assert.equal(result.reason?.code, "INGRESS_INSPECTION_REQUIRED");
      } else {
        assert.deepEqual(claims.map((result) => result.status), ["fulfilled", "fulfilled"]);
        assert.equal(claims[0].value.id, claims[1].value.id);
      }
    } finally { if (scanner) await new Promise((resolve) => scanner.server.close(resolve)); await database?.close(); await rm(socketPath, { force: true }); await rm(dir, { recursive: true, force: true }); }
  }
});

test("stable retries atomically refresh a matching leased receipt's inspection without accepting descriptor changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-leased-reinspection-")); let database;
  const databasePath = path.join(dir, "data.db"); const filesPath = path.join(dir, "files"); const requestKey = "leased-reinspection";
  const endpoint = (revision) => ({ options: { method: "POST", path: "/leased-reinspection", body: { multipart: { ...ingressPolicy(), inspection: { policyRevision: revision, maxVerdictAgeMs: 60_000, requiredInspectors: ["clamav"] } } } } });
  const request = (boundary, bytes = "stable leased bytes") => ({ headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": requestKey }, async *[Symbol.asyncIterator]() { yield multipartBinary(boundary, "claim.txt", "text/plain", Buffer.from(bytes)); } });
  const stage = async (activeEndpoint, boundary, bytes) => { const incoming = request(boundary, bytes); return await stageMultipartIngress(database, activeEndpoint, incoming, { headers: incoming.headers }, { userId: "claim-user" }); };
  const api = (activeEndpoint) => createEndpointIngressApi(database, activeEndpoint, { __ingressRequestKey: requestKey, __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
  const socketPath = path.join(tmpdir(), `clam-${process.pid}-${randomUUID().slice(0, 8)}.sock`); let scanner; let scannerCalls = 0;
  try {
    database = await openDevDatabase(databasePath, "", {}, { name: "leased-reinspection", files: { storagePath: filesPath } }, capsule({ name: "leased-reinspection" }));
    database.__clamavTest = { socketPath, timeoutMs: 5, loadedSignature: "daily:42", signature: { version: "daily:42", updatedAt: new Date().toISOString() } };
    const v1 = endpoint("leased-clamav-v1"); const initial = await stage(v1, "leased-v1"); const lease = initial.multipart.files[0];
    await assert.rejects(api(v1).claim(lease, { path: "/attachments/leased.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });

    scanner = await fakeClamSocket(socketPath, { response: "stream: OK\0", onRequest: () => { scannerCalls += 1; } });
    const v2 = endpoint("leased-clamav-v2"); const callsBeforeConflict = scannerCalls;
    await assert.rejects(stage(v2, "leased-conflict", "different bytes"), { code: "INGRESS_DESCRIPTOR_CONFLICT" });
    assert.equal(scannerCalls, callsBeforeConflict, "a descriptor mismatch must fail before scanner work or evidence publication");

    const retries = await Promise.all(Array.from({ length: 12 }, (_, index) => stage(v2, `leased-clean-${index}`)));
    assert.deepEqual([...new Set(retries.map((retry) => retry.multipart.files[0].leaseId))], [lease.leaseId]);
    const refreshed = JSON.parse((await database.adapter.selectIngressByLease(lease.leaseId)).payload);
    assert.equal(refreshed.state, "leased"); assert.equal(refreshed.inspection.policyRevision, "leased-clamav-v2"); assert.equal(refreshed.inspection.verdicts[0].outcome, "clean");

    await database.close();
    database = await openDevDatabase(databasePath, "", {}, { name: "leased-reinspection", files: { storagePath: filesPath } }, capsule({ name: "leased-reinspection" }));
    const claimed = await api(v2).claim(lease, { path: "/attachments/leased.txt" });
    assert.equal(claimed.path, "/attachments/leased.txt");
    assert.equal(Number((await database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_file_ingress_audit_outbox]").get()).count), 1);
  } finally { if (scanner) await new Promise((resolve) => scanner.server.close(resolve)); await database?.close(); await rm(socketPath, { force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("an inspected lease cannot substitute its inspected name or MIME type at claim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ingress-inspected-descriptor-")); let database;
  try {
    const inspection = { policyRevision: "descriptor-v1", requiredInspectors: ["content-policy-v1"] };
    const inspectedEndpoint = { options: { method: "POST", path: "/inspected", body: { multipart: { ...ingressPolicy(), inspection } } } };
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "inspected-descriptor" }, capsule({ name: "inspected-descriptor" }));
    const staged = await stageMultipartIngress(database, inspectedEndpoint, ingressRequest("inspected-descriptor"), { headers: ingressRequest("inspected-descriptor").headers }, { userId: "claim-user" });
    const api = createEndpointIngressApi(database, inspectedEndpoint, { __ingressRequestKey: "inspected-descriptor", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    await assert.rejects(api.claim(staged.multipart.files[0], { path: "/attachments/changed-name.txt", name: "changed.txt" }), { code: "INGRESS_INSPECTION_REQUIRED" });
    await assert.rejects(api.claim(staged.multipart.files[0], { path: "/attachments/changed-type.txt", type: "application/javascript" }), { code: "INGRESS_INSPECTION_REQUIRED" });
    assert.equal((await api.claim(staged.multipart.files[0], { path: "/attachments/original.txt", name: "claim.txt", type: "text/plain" })).name, "claim.txt");

    const legacyEndpoint = { options: { method: "POST", path: "/legacy", body: { multipart: ingressPolicy() } } };
    const legacy = await stageMultipartIngress(database, legacyEndpoint, ingressRequest("legacy-descriptor"), { headers: ingressRequest("legacy-descriptor").headers }, { userId: "claim-user" });
    const legacyApi = createEndpointIngressApi(database, legacyEndpoint, { __ingressRequestKey: "legacy-descriptor", __ingressAuthority: { kind: "actor", actorId: "claim-user", ownerId: "claim-user" } }, { auth: { userId: "claim-user", isAuthenticated: true, isGuest: false } });
    const legacyFile = await legacyApi.claim(legacy.multipart.files[0], { path: "/attachments/legacy.bin", name: "renamed.bin", type: "application/octet-stream" });
    assert.deepEqual({ name: legacyFile.name, type: legacyFile.type }, { name: "renamed.bin", type: "application/octet-stream" });
  } finally { await database?.close(); await rm(dir, { recursive: true, force: true }); }
});
