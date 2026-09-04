import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";

import { attachRequiredDevClamavSidecar, ensureDevClamavChildExit, releaseDevClamavSidecar, retireDevClamavSidecarIfUnused, startDevClamavSidecar, waitForDevClamavChildExit } from "../dist/dev-clamav-sidecar.js";
import { replacePreparedRuntimeDatabase } from "../dist/server-runtime-source.js";

test("failed hot-add rollback retains sidecar ownership until cleanup succeeds", async () => {
  const replacementError = new Error("candidate init failed");
  const stopError = new Error("sidecar stop failed");
  let stopAttempts = 0;
  const candidateSidecar = { async stop() { stopAttempts += 1; if (stopAttempts === 1) throw stopError; } };
  let sidecar = candidateSidecar;
  const candidate = { async init() { throw replacementError; }, async close() {} };

  await assert.rejects(
    replacePreparedRuntimeDatabase(
      {},
      candidate,
      async () => {},
      async () => { sidecar = await releaseDevClamavSidecar(sidecar); },
    ),
    (error) => error instanceof AggregateError && error.errors[0] === replacementError && error.errors[1] === stopError,
  );
  assert.equal(sidecar, candidateSidecar, "failed cleanup must retain the owned sidecar handle");
  sidecar = await releaseDevClamavSidecar(sidecar);
  assert.equal(sidecar, undefined);
  assert.equal(stopAttempts, 2);
});

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

test("Dev rebuild attachment replaces a terminated ClamAV sidecar without losing cleanup ownership", async () => {
  const candidate = () => ({ endpoints: [{ options: { body: { multipart: { inspection: { requiredInspectors: ["clamav"] } } } } }] });
  const replacement = () => { const manager = { descriptor: { process: { exitCode: null, signalCode: null } }, attached: 0, attach(database) { this.attached += 1; database.__clamavDevSidecar = this.descriptor; }, async stop() {} }; return manager; };

  for (const process of [{ exitCode: null, signalCode: "SIGKILL" }, { exitCode: null, signalCode: null, __sporadesClamavTerminated: true }]) {
    const calls = []; const old = { descriptor: { process }, async stop() { calls.push("old.stop"); }, attach() { throw new Error("dead sidecar attached"); } }; const next = replacement();
    const result = await attachRequiredDevClamavSidecar(old, candidate(), async () => { calls.push("replacement.create"); return next; });
    assert.equal(result.sidecar, next); assert.equal(result.attached, true); assert.equal(next.attached, 1); assert.deepEqual(calls, ["old.stop", "replacement.create"]);
  }

  const stopError = new Error("dead sidecar cleanup failed"); let stopAttempts = 0; let creates = 0;
  const retryable = { descriptor: { process: { exitCode: null, signalCode: "SIGTERM" } }, async stop() { stopAttempts += 1; if (stopAttempts === 1) throw stopError; }, attach() {} };
  let owned = retryable;
  await assert.rejects(async () => { owned = (await attachRequiredDevClamavSidecar(owned, candidate(), async () => { creates += 1; return replacement(); })).sidecar; }, (error) => error === stopError);
  assert.equal(owned, retryable); assert.equal(creates, 0);
  owned = (await attachRequiredDevClamavSidecar(owned, candidate(), async () => { creates += 1; return replacement(); })).sidecar;
  assert.notEqual(owned, retryable); assert.equal(stopAttempts, 2); assert.equal(creates, 1);

  const live = replacement(); const liveCandidate = candidate(); const reused = await attachRequiredDevClamavSidecar(live, liveCandidate, async () => { throw new Error("duplicate sidecar"); });
  assert.equal(reused.sidecar, live); assert.equal(live.attached, 1);
  const unused = await attachRequiredDevClamavSidecar(live, { endpoints: [] }, async () => { throw new Error("unexpected sidecar"); });
  assert.deepEqual(unused, { sidecar: live, attached: false });
});

test("Dev ClamAV child exit handling is immediate for dead children and escalates only a live child", async () => {
  const child = ({ signalCode = null, latched = false, killExits = false } = {}) => {
    const listeners = new Map(); const signals = [];
    return {
      exitCode: null, signalCode, __sporadesClamavTerminated: latched, signals,
      get listenerCount() { return listeners.size; },
      once(name, listener) { listeners.set(name, listener); },
      removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
      emit(name) { const listener = listeners.get(name); listeners.delete(name); listener?.(); },
      kill(signal) { signals.push(signal); if (killExits) { this.signalCode = signal; this.emit("close"); } },
    };
  };

  for (const dead of [child({ signalCode: "SIGKILL" }), child({ latched: true })]) {
    assert.equal(await waitForDevClamavChildExit(dead, 10_000), true);
    assert.equal(dead.listenerCount, 0);
    assert.equal(await ensureDevClamavChildExit(dead, 10_000), true);
    assert.deepEqual(dead.signals, []);
  }

  const live = child();
  const waiting = waitForDevClamavChildExit(live, 10_000);
  assert.equal(live.listenerCount, 3);
  live.emit("close");
  assert.equal(await waiting, true);
  assert.equal(await waitForDevClamavChildExit(live, 10_000), true);
  assert.equal(live.listenerCount, 0, "the close latch prevents a second wait");

  const escalated = child({ killExits: true });
  assert.equal(await ensureDevClamavChildExit(escalated, 0), true);
  assert.deepEqual(escalated.signals, ["SIGKILL"]);

  const errored = new EventEmitter(); Object.assign(errored, { exitCode: null, signalCode: null });
  const errorWait = waitForDevClamavChildExit(errored, 0); errored.emit("error", new Error("signal failure"));
  assert.equal(await errorWait, false); assert.equal(errored.listenerCount("exit"), 0); assert.equal(errored.listenerCount("close"), 0); assert.equal(errored.listenerCount("error"), 0);
  errored.kill = function () { this.emit("error", new Error("kill denied")); };
  assert.equal(await ensureDevClamavChildExit(errored, 0), false); assert.equal(errored.listenerCount("error"), 0);

  let now = 0; const delays = []; const stubborn = new EventEmitter(); Object.assign(stubborn, { exitCode: null, signalCode: null, signals: [] }); stubborn.kill = function (signal) { this.signals.push(signal); };
  assert.equal(await ensureDevClamavChildExit(stubborn, 100, { now: () => now, delay: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; } }), false);
  assert.equal(now, 100); assert.deepEqual(delays, [50, 50]); assert.deepEqual(stubborn.signals, ["SIGKILL"]);
  assert.equal(stubborn.listenerCount("exit"), 0); assert.equal(stubborn.listenerCount("close"), 0); assert.equal(stubborn.listenerCount("error"), 0);
});

test("Dev ClamAV sidecar is exact-task scoped, UID-safe, Unix-only, and residue-free", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-unit-")); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");\nif(args[0]==="image"&&args[1]==="inspect")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({pid:process.pid})); process.stdout.write("sporades-clamav-ready-v1\\n"); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);}\nelse if(args[0]==="rm"){try{const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));process.kill(s.pid,"SIGTERM");fs.unlinkSync(${JSON.stringify(state)});}catch{}process.exit(0);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));process.kill(s.pid,0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse process.exit(1);\n`); await chmod(docker, 0o755);
  let manager;
  try {
    manager = await startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker }); const database = {}; manager.attach(database); assert.equal(database.__clamavDevSidecar.containerName, manager.descriptor.containerName); assert.equal(database.__clamavDevSidecar.externallyManaged, true);
    for (let attempt = 0; attempt < 100; attempt += 1) { try { await access(state); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
    const socketDir = path.dirname(manager.descriptor.socketPath); await manager.stop(); await assert.rejects(access(socketDir)); await manager.stop();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); const run = calls.find((args) => args[0] === "run"); assert(run.includes("ghcr.io/sporades/sporades-base:0.2.0-node22-alpine")); assert(run.includes("--user")); assert(run.includes("--volume")); assert.equal(run.includes("--publish"), false); assert.equal(run.some((value) => /TCP(?:Addr|Socket)/.test(value)), false);
    const script = run.at(-1); const clamdStart = script.indexOf("/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf"); const readinessScan = script.indexOf("clamdscan --config-file=/etc/clamav/clamd.conf --stream -"); const daemonUpdaterStart = script.indexOf("/usr/bin/freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf"); const updaterAlive = script.indexOf('kill -0 "$updater"'); const readinessMarker = script.indexOf("sporades-clamav-ready-v1", updaterAlive);
    assert(clamdStart >= 0); assert(readinessScan > clamdStart); assert(daemonUpdaterStart > readinessScan, "the notifying updater starts only after a clean scan proves clamd ready"); assert(updaterAlive > daemonUpdaterStart); assert(readinessMarker > updaterAlive, "a dead updater exits before readiness can be published"); assert.doesNotMatch(script, /seq 1 1200/, "the host owns the single readiness deadline");
    const name = run[run.indexOf("--name") + 1]; assert.equal(calls.some((args) => args[0] === "rm" && args.at(-1) === name), true); assert.equal(calls.some((args) => args[0] === "container" && args[1] === "inspect" && args[2] === name), true);
  } finally { await manager?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test("Dev ClamAV sidecar start waits for the container readiness proof", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-ready-")); const docker = path.join(dir, "docker.mjs"); const state = path.join(dir, "state.json");
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));setTimeout(()=>process.stdout.write("sporades-clamav-ready-v1\\n"),200);process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse process.exit(1);\n`); await chmod(docker, 0o755);
  let manager;
  try {
    let settled = false; const pending = startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 1_000 }); pending.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 100; attempt += 1) { try { await access(state); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
    await new Promise((resolve) => setTimeout(resolve, 40)); const settledBeforeReadiness = settled;
    manager = await pending; assert.equal(settledBeforeReadiness, false, "start must not publish a sidecar before clamd is ready"); assert.equal(settled, true);
  } finally { await manager?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test("Dev ClamAV readiness accepts only an exact newline-framed stdout control", async () => {
  const marker = "sporades-clamav-ready-v1";
  const cases = [
    ["stdout-lf", `process.stdout.write(${JSON.stringify(`${marker}\n`)});`, true],
    ["stdout-crlf", `process.stdout.write(${JSON.stringify(`${marker}\r\n`)});`, true],
    ["stdout-chunked", `process.stdout.write("sporades-");setTimeout(()=>process.stdout.write("clamav-ready-v1\\n"),5);`, true],
    ["stdout-lines", `process.stdout.write(${JSON.stringify(`diagnostic\n${marker}\nfinished\n`)});`, true],
    ["stderr-exact", `process.stderr.write(${JSON.stringify(`${marker}\n`)});`, false],
    ["stderr-then-stdout", `process.stderr.write(${JSON.stringify(`${marker}\n`)});process.stdout.write("diagnostic\\n");`, false],
    ["stdout-prefix", `process.stdout.write(${JSON.stringify(`prefix-${marker}\n`)});`, false],
    ["stdout-suffix", `process.stdout.write(${JSON.stringify(`${marker}-suffix\n`)});`, false],
    ["stdout-embedded", `process.stdout.write(${JSON.stringify(`before ${marker} after\n`)});`, false],
    ["stdout-partial", `process.stdout.write(${JSON.stringify(marker)});`, false],
  ];
  for (const [name, emission, expectedReady] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-dev-clamav-frame-${name}-`)); const docker = path.join(dir, "docker.mjs"); const state = path.join(dir, "state.json"); let manager;
    await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));${emission}process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse process.exit(1);\n`); await chmod(docker, 0o755);
    try {
      const outcome = await startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 200 }).then((value) => ({ value }), (error) => ({ error })); manager = outcome.value;
      assert.equal(Boolean(outcome.value), expectedReady, name); if (!expectedReady) assert.equal(outcome.error?.code, "FILE_INSPECTION_UNAVAILABLE", name);
    } finally { await manager?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  }
});

test("Dev ClamAV readiness uses its host monotonic deadline at the exact proof boundary", async () => {
  for (const [name, clock, expectedReady] of [["before", [0, 0, 99], true], ["at", [0, 0, 100], true], ["after", [0, 0, 101], false]]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-dev-clamav-deadline-${name}-`)); const docker = path.join(dir, "docker.mjs"); const state = path.join(dir, "state.json"); let manager; let last = clock.at(-1);
    await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));setTimeout(()=>process.stdout.write("sporades-clamav-ready-v1\\n"),10);process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse process.exit(1);\n`); await chmod(docker, 0o755);
    try {
      const values = [...clock]; const outcome = await startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 100, readinessTiming: { now: () => { if (values.length) last = values.shift(); return last; }, containerIsRunning: async () => true } }).then((value) => ({ value }), (error) => ({ error })); manager = outcome.value;
      assert.equal(Boolean(outcome.value), expectedReady, name); if (!expectedReady) assert.equal(outcome.error?.code, "FILE_INSPECTION_UNAVAILABLE", name);
    } finally { await manager?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  }
});

test("Dev ClamAV readiness is not published when the container exits with or immediately after its proof", async () => {
  const modes = [
    ["same-turn", 'process.stdout.write("sporades-clamav-ready-v1\\n");process.exit(0);'],
    ["next-tick", 'process.stdout.write("sporades-clamav-ready-v1\\n");process.nextTick(()=>process.exit(0));'],
    ["immediate", 'process.stdout.write("sporades-clamav-ready-v1\\n");setImmediate(()=>process.exit(0));'],
    ["timer", 'process.stdout.write("sporades-clamav-ready-v1\\n");setTimeout(()=>process.exit(0),0);'],
  ];
  for (const [mode, runBehavior] of modes) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-dev-clamav-proof-exit-${mode}-`)); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
    await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));${runBehavior}}\nelse if(args[0]==="rm")process.exit(0);\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse process.exit(1);\n`); await chmod(docker, 0o755);
    try {
      await assert.rejects(startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 500 }), (error) => error?.code === "FILE_INSPECTION_UNAVAILABLE", mode);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); assert.equal(calls.some((args) => args[0] === "rm"), true, `${mode}: unpublished container cleaned`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("Dev ClamAV readiness is unpublished when the container exits during proxy publication", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-bind-exit-")); const docker = path.join(dir, "docker.mjs"); const state = path.join(dir, "state.json"); let proxyClosed = false;
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));process.stdout.write("sporades-clamav-ready-v1\\n");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse process.exit(1);\n`); await chmod(docker, 0o755);
  const proxyServerFactory = () => ({
    once(name, callback) { if (name === "error") this.onError = callback; },
    listen(_socketPath, callback) { readFile(state, "utf8").then((pid) => process.kill(Number(pid), "SIGTERM")); setTimeout(callback, 25); },
    close(callback) { proxyClosed = true; callback(); },
  });
  try {
    await assert.rejects(startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 1_000, proxyServerFactory }), (error) => error?.code === "FILE_INSPECTION_UNAVAILABLE");
    assert.equal(proxyClosed, true, "a proxy racing publication is closed before startup rejects");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Dev ClamAV stable readiness can be published and cleaned across repeated starts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-repeat-ready-")); const docker = path.join(dir, "docker.mjs"); const state = path.join(dir, "state.json");
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));process.stdout.write("sporades-clamav-ready-v1\\n");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}\nelse if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}\nelse if(args[0]==="container"&&args[1]==="inspect")process.exit(1);\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse process.exit(1);\n`); await chmod(docker, 0o755);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const manager = await startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 1_000 });
      assert.equal(manager.descriptor.process.exitCode, null); await manager.stop();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Dev ClamAV sidecar readiness timeout and early exit clean the exact unpublished container", async () => {
  for (const mode of ["timeout", "exit"]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-dev-clamav-${mode}-`)); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
    const runBehavior = mode === "exit" ? "process.exit(7);" : "process.on(\"SIGTERM\",()=>process.exit(0));setInterval(()=>{},1000);";
    await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");\nif(args[0]==="image")process.exit(0);\nif(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));${runBehavior}}\nelse if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}\nelse process.exit(1);\n`); await chmod(docker, 0o755);
    try {
      await assert.rejects(startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, readinessTimeoutMs: 20, proxyServerFactory: () => { throw new Error("proxy published before readiness"); } }), (error) => error?.code === "FILE_INSPECTION_UNAVAILABLE" && /did not become ready/.test(error.message));
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); const run = calls.find((args) => args[0] === "run"); const name = run[run.indexOf("--name") + 1];
      assert.equal(calls.some((args) => args[0] === "rm" && args.at(-1) === name), true, mode);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("Dev ClamAV startup failure removes only its exact container and socket directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-startup-")); const docker = path.join(dir, "docker.mjs"); const log = path.join(dir, "calls.jsonl"); const state = path.join(dir, "state.json");
  const beforeSockets = new Set((await readdir(tmpdir())).filter((item) => item.startsWith("sporades-dev-clamav-")));
  await writeFile(docker, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");if(args[0]==="image")process.exit(0);if(args[0]==="run"){fs.writeFileSync(${JSON.stringify(state)},String(process.pid));process.stdout.write("sporades-clamav-ready-v1\\n");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);}else if(args[0]==="rm"){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),"SIGTERM");}catch{}process.exit(0);}else if(args[0]==="container"&&args[1]==="inspect"&&args.includes("--format")){try{process.kill(Number(fs.readFileSync(${JSON.stringify(state)},"utf8")),0);process.stdout.write("true\\n");}catch{process.exit(1);}}else process.exit(1);`); await chmod(docker, 0o755);
  const failingProxy = () => ({ once(name, callback) { if (name === "error") this.onError = callback; }, listen() { queueMicrotask(() => this.onError(new Error("socket unavailable"))); }, close(callback) { callback(); } });
  try {
    await assert.rejects(startDevClamavSidecar({ projectDir: dir, dockerfile: path.join(dir, "Dockerfile.base"), buildContext: dir, dockerCommand: docker, proxyServerFactory: failingProxy }), /socket unavailable/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse); const run = calls.find((args) => args[0] === "run"); const name = run[run.indexOf("--name") + 1]; assert.equal(calls.some((args) => args[0] === "rm" && args.at(-1) === name), true); assert.deepEqual((await readdir(tmpdir())).filter((item) => item.startsWith("sporades-dev-clamav-") && !beforeSockets.has(item)), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
