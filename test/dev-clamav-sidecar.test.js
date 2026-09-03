import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { retireDevClamavSidecarIfUnused, startDevClamavSidecar } from "../dist/dev-clamav-sidecar.js";

test("Dev ClamAV sidecar retirement follows the successfully promoted runtime's final policy", async () => {
  const calls = [];
  const sidecar = { async stop() { calls.push("stop"); } };
  const required = { endpoints: [{ options: { body: { multipart: { inspection: { requiredInspectors: ["clamav"] } } } } }] };
  assert.equal(await retireDevClamavSidecarIfUnused(sidecar, required), sidecar);
  assert.deepEqual(calls, []);
  assert.equal(await retireDevClamavSidecarIfUnused(sidecar, { endpoints: [] }), undefined);
  assert.deepEqual(calls, ["stop"]);

  const stopError = new Error("sidecar stop failed");
  const failing = { async stop() { throw stopError; } };
  let retained = failing;
  await assert.rejects(async () => { retained = await retireDevClamavSidecarIfUnused(retained, { endpoints: [] }); }, (error) => error === stopError);
  assert.equal(retained, failing, "failed retirement remains reachable for shutdown retry");
});

test("Dev ClamAV sidecar is exact-task scoped, UID-safe, Unix-only, and residue-free", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-unit-")); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");\nif(args[0]==="image"&&args[1]==="inspect")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({pid:process.pid})); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);}\nelse if(args[0]==="rm"){try{const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));process.kill(s.pid,"SIGTERM");fs.unlinkSync(${JSON.stringify(state)});}catch{}process.exit(0);}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse process.exit(1);\n`); await chmod(docker, 0o755);
  let manager;
  try {
    manager = await startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker }); const database = {}; manager.attach(database); assert.equal(database.__clamavDevSidecar.containerName, manager.descriptor.containerName); assert.equal(database.__clamavDevSidecar.externallyManaged, true);
    for (let attempt = 0; attempt < 100; attempt += 1) { try { await access(state); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
    const socketDir = path.dirname(manager.descriptor.socketPath); await manager.stop(); await assert.rejects(access(socketDir)); await manager.stop();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); const run = calls.find((args) => args[0] === "run"); assert(run.includes("ghcr.io/sporades/sporades-base:0.2.0-node22-alpine")); assert(run.includes("--user")); assert(run.includes("--volume")); assert.equal(run.includes("--publish"), false); assert.equal(run.some((value) => /TCP(?:Addr|Socket)/.test(value)), false); const name = run[run.indexOf("--name") + 1]; assert.equal(calls.some((args) => args[0] === "rm" && args.at(-1) === name), true); assert.equal(calls.some((args) => args[0] === "container" && args[1] === "inspect" && args[2] === name), true);
  } finally { await manager?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test("Dev ClamAV startup failure removes only its exact container and socket directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-startup-")); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
  const beforeSockets = new Set((await readdir(tmpdir())).filter((item) => item.startsWith("sporades-dev-clamav-")));
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");if(args[0]==="image")process.exit(0);if(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}else if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}else process.exit(1);`); await chmod(docker, 0o755);
  const failingProxy = () => ({ once(name, callback) { if (name === "error") this.onError = callback; }, listen() { queueMicrotask(() => this.onError(new Error("socket unavailable"))); }, close(callback) { callback(); } });
  try {
    await assert.rejects(startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, proxyServerFactory: failingProxy }), /socket unavailable/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); const run = calls.find((args) => args[0] === "run"); const name = run[run.indexOf("--name") + 1]; assert.equal(calls.some((args) => args[0] === "rm" && args.at(-1) === name), true); assert.deepEqual((await readdir(tmpdir())).filter((item) => item.startsWith("sporades-dev-clamav-") && !beforeSockets.has(item)), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
