// Preserve the strict replay deadline without parallel compiler contention.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capsule } from '../dist/server.js';
import { openDevDatabase } from '../dist/server-runtime-source.js';
import { stageMultipartIngress } from '../dist/file-ingress-runtime.js';
import { multipart, ingressPolicy } from './support/ingress-fixture.js';

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
