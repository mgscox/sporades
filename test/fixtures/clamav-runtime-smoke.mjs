import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { capsule, endpoint } from "/src/dist/server.js";
import { routeRuntimeHealth } from "/src/dist/http-runtime.js";
import { openDevDatabase } from "/src/dist/server-runtime-source.js";
import { stageMultipartIngress } from "/src/dist/file-ingress-runtime.js";

if (process.env.SPORADES_EXPECT_RUNTIME_UID) assert.equal(String(process.getuid?.()), process.env.SPORADES_EXPECT_RUNTIME_UID);

const policy = { maxFiles: 1, maxFileBytes: 10 * 1024 * 1024, maxTotalFileBytes: 10 * 1024 * 1024, maxFieldCount: 1, maxFieldBytes: 1024, maxTotalFieldBytes: 1024, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: true, inspection: { policyRevision: "docker-v1", requiredInspectors: ["clamav"] } };
const definition = capsule({ name: "clamav-runtime-smoke", endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart: policy } }, () => ({ ok: true })) } });
const database = await openDevDatabase("/app/data/runtime-smoke.db", "", {}, { name: definition.name, files: { storagePath: "/app/data/files" } }, definition);
const runtimeProbeToken = randomBytes(32).toString("hex");
assert.match(runtimeProbeToken, /^[a-f0-9]{64}$/);
database.runtimeProbeToken = runtimeProbeToken;
let server;
try {
  await database.init();
  const health = async () => { const response = await fetch(`http://127.0.0.1:${server.address().port}/__sporades/health/runtime`, { headers: { "x-sporades-host-probe": runtimeProbeToken } }); return { status: response.status, body: await response.json() }; };
  server = createServer((request, response) => routeRuntimeHealth(database, request, response)); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.equal((await health()).status, 200);
  const multipart = (boundary, bytes) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
  for (const [key, bytes, outcome] of [["clean", Buffer.from("clean support evidence"), "clean"], ["eicar", Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"), "rejected"]]) {
    const headers = { "content-type": `multipart/form-data; boundary=${key}`, "idempotency-key": key }; const staged = await stageMultipartIngress(database, database.endpoints[0], { async *[Symbol.asyncIterator]() { yield multipart(key, bytes); } }, { headers }, { userId: "acceptance" }); const receipt = JSON.parse((await database.adapter.selectIngressByLease(staged.multipart.files[0].leaseId)).payload); assert.equal(receipt.inspection.verdicts[0].outcome, outcome); assert.equal(JSON.stringify(receipt.inspection).includes("Eicar"), false);
  }
  if (process.env.SPORADES_SMOKE_REPLACEMENT === "1") { const daily = existsSync("/app/data/clamav/daily.cld") ? "/app/data/clamav/daily.cld" : "/app/data/clamav/daily.cvd"; const backup = `${daily}.acceptance-backup`; await copyFile(daily, backup); await writeFile(daily, `ClamAV-VDB:${new Date().toUTCString()}:999999:1:0:0:0:0:0:0:0:`); assert.equal((await health()).status, 503); await rename(backup, daily); database.clamavReady = true; assert.equal((await health()).status, 200); }
  const clamd = database.__clamavProcess; const updater = database.__clamavUpdateProcess; clamd.kill("SIGTERM"); await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal((await health()).status, 503); await database.close(); assert.notEqual(clamd.exitCode, null); assert.notEqual(updater.exitCode, null);
} finally { if (server) await new Promise((resolve) => server.close(resolve)); await database.close().catch(() => {}); }
