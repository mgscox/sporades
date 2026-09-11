import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProjectConfig } from "../dist/cli/project-config.js";
import { createLogEnvelope, openDevDatabase } from "../dist/server-runtime-source.js";
import { minimumLogPayloadMaxBytes, validateLogConfig } from "../dist/log-envelope.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";

test("configuration rejects a log cap that discards ordinary platform payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-log-cap-"));
  try {
    for (const key of ["logs", "logging"]) {
      await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "capsule", [key]: { payloadMaxBytes: 256 } }));
      await assert.rejects(readProjectConfig(dir), (error) => {
        assert.equal(error.code, "INVALID_LOG_CONFIG");
        assert.match(error.hint, new RegExp(`${key}\\.payloadMaxBytes.*integer.*at least \\d+`));
        return true;
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the exact floor preserves bounded data with actual identities and escaped UTF-8", () => {
  const data = { value: "d".repeat(244) };
  assert.equal(Buffer.byteLength(JSON.stringify(data)), 256);
  for (const identity of [
    {},
    { name: "a" },
    { name: "long-name".repeat(100) },
    { name: '🦊"\\\n'.repeat(30), id: "別の識別子".repeat(40) },
    { name: "name", id: "ignored", capsule: { id: '"'.repeat(500) }, release: { id: "release".repeat(100) } },
  ]) {
    const minimum = minimumLogPayloadMaxBytes(identity);
    for (const key of ["logs", "logging"]) {
      assert.throws(() => validateLogConfig({ ...identity, [key]: { payloadMaxBytes: minimum - 1 } }), { code: "INVALID_LOG_CONFIG" });
      const config = { ...identity, [key]: { payloadMaxBytes: minimum } };
      assert.doesNotThrow(() => validateLogConfig(config));
      const envelope = createLogEnvelope({
        config, timestamp: "2026-09-11T00:00:00.000Z",
        category: "c".repeat(16), level: "l".repeat(16),
        event: "e".repeat(64), message: "\n".repeat(64), data,
      });
      assert.deepEqual(envelope.data, data);
      assert.equal(envelope.truncated, false);
      assert.equal(Buffer.byteLength(JSON.stringify(envelope)), minimum);
      assert.equal(envelope.capsule.id, identity.capsule?.id ?? identity.id ?? identity.name ?? "unknown");
    }
  }
});

test("default and alias precedence stay explicit without coercion or silent clamping", () => {
  for (const config of [{}, { logs: { payloadMaxBytes: 4096 } }, { logging: { payloadMaxBytes: 4096 } }]) {
    assert.doesNotThrow(() => validateLogConfig(config));
  }
  for (const value of [0, -1, 1.5, "4096", null, true, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["logs", "logging"]) {
      assert.throws(() => validateLogConfig({ [key]: { payloadMaxBytes: value } }), { code: "INVALID_LOG_CONFIG" });
    }
  }
  assert.throws(() => validateLogConfig({ logs: { payloadMaxBytes: 4096 }, logging: { payloadMaxBytes: 256 } }), { code: "INVALID_LOG_CONFIG" });
  const longIdentity = { name: "x".repeat(2500) };
  assert.throws(() => validateLogConfig(longIdentity), { code: "INVALID_LOG_CONFIG" });
  assert.doesNotThrow(() => validateLogConfig({ ...longIdentity, logs: { payloadMaxBytes: minimumLogPayloadMaxBytes(longIdentity) } }));
  const oversized = { config: { logs: { payloadMaxBytes: 4096 }, logging: { payloadMaxBytes: 8192 } }, data: { value: "x".repeat(5000) } };
  assert.equal(createLogEnvelope(oversized).truncated, true);
  assert.equal(createLogEnvelope({ ...oversized, config: { logging: { payloadMaxBytes: 8192 } } }).truncated, false);
});

test("runtime startup rejects invalid caps before opening storage", async () => {
  for (const key of ["logs", "logging"]) {
    await assert.rejects(openDevDatabase("/not-created/log-cap/data.db", "", {}, { [key]: { payloadMaxBytes: 256 } }), { code: "INVALID_LOG_CONFIG" });
  }
});

test("generated Capsule startup enforces the same cap contract", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-log-cap-bundle-"));
  try {
    const config = { name: "bundle-capsule", logging: { payloadMaxBytes: 256 } };
    const source = await createServerBundleModuleSource({
      config, serverEnv: {}, serverSource: "", serverModuleSource: "export default {};",
    });
    const bundle = path.join(dir, "server.mjs");
    await writeFile(bundle, source);
    const result = spawnSync(process.execPath, [bundle], { cwd: dir, encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INVALID_LOG_CONFIG/);
    assert.match(result.stderr, new RegExp(`at least ${minimumLogPayloadMaxBytes(config)} bytes`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shipped CLI agrees with configuration loading at both sides of the floor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-log-cap-cli-"));
  const cli = fileURLToPath(new URL("../bin/sporades.js", import.meta.url));
  try {
    const identity = { name: 'Capsule 🦊"'.repeat(20), capsule: { id: "long-id".repeat(50) } };
    const minimum = minimumLogPayloadMaxBytes(identity);
    for (const key of ["logs", "logging"]) {
      for (const cap of [minimum - 1, minimum, 4096]) {
        await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ ...identity, [key]: { payloadMaxBytes: cap } }));
        if (cap < minimum) await assert.rejects(readProjectConfig(dir), { code: "INVALID_LOG_CONFIG" });
        else await readProjectConfig(dir);
        const result = spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd: dir, encoding: "utf8", timeout: 10000 });
        assert.equal(result.error, undefined);
        const output = JSON.parse(result.stdout);
        const check = output.data.checks.find((entry) => entry.id === "doctor.project-config");
        assert.equal(check.status, cap < minimum ? "fail" : "pass");
        if (cap < minimum) assert.match(check.hint, new RegExp(`at least ${minimum} bytes`));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
