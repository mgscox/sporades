import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctorShouldExitNonZero } from "../dist/cli/doctor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-doctor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("sporades doctor --help documents the diagnostic command options", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--help"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: sporades doctor \[options\]/);
    assert.match(result.stdout, /--session <name>/);
    assert.match(result.stdout, /--host <alias>/);
    assert.match(result.stdout, /--subname <name>/);
    assert.match(result.stdout, /--strict/);
    assert.match(result.stdout, /--json/);
  });
});

test("sporades doctor --json returns a stable diagnostic envelope", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.error, null);
    assert.equal(envelope.data.command, "doctor");
    assert.equal(envelope.data.version, 1);
    assert.equal(envelope.data.strict, false);
    assert.equal(envelope.data.session, null);
    assert.deepEqual(envelope.data.summary, {
      pass: 1,
      warn: 0,
      fail: 0,
      skip: 0,
      info: 1,
      warning: 0,
      error: 0,
    });
    assert.deepEqual(envelope.data.checks, [
      {
        id: "doctor.command-surface",
        title: "Doctor command surface",
        scope: "project",
        status: "pass",
        severity: "info",
        message: "Doctor command parsed successfully.",
      },
    ]);
  });
});

test("sporades doctor human output groups checks by severity", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--session", "dev"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Sporades doctor/);
    assert.match(result.stdout, /\nINFO\n(?:- .+\n)*- \[skip\] Dev session diagnostics pending:/);
    assert.match(result.stdout, /\nINFO\n- \[pass\] Doctor command surface:/);
    assert.doesNotMatch(result.stdout, /WARNING/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

test("sporades doctor skips placeholder session checks without failing strict mode", async () => {
  await withTempDir(async (dir) => {
    const normal = await runCli(["doctor", "--session", "container", "--json"], { cwd: dir });
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).data.summary.skip, 1);

    const strict = await runCli(["doctor", "--session", "container", "--strict", "--json"], { cwd: dir });
    assert.equal(strict.code, 0, strict.stderr);
    assert.equal(strict.stderr, "");
    const envelope = JSON.parse(strict.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.strict, true);
    assert.equal(envelope.data.summary.warn, 0);
    assert.equal(envelope.data.summary.fail, 0);
    assert.equal(envelope.data.summary.skip, 1);
  });
});

test("doctor exit contract fails normal mode only for failed checks", () => {
  const passingChecks = [{ id: "doctor.pass", status: "pass" }];
  const skippedChecks = [{ id: "doctor.skip", status: "skip" }];
  const warningChecks = [{ id: "doctor.warn", status: "warn" }];
  const failingChecks = [{ id: "doctor.fail", status: "fail" }];

  assert.equal(doctorShouldExitNonZero(passingChecks, false), false);
  assert.equal(doctorShouldExitNonZero(skippedChecks, false), false);
  assert.equal(doctorShouldExitNonZero(warningChecks, false), false);
  assert.equal(doctorShouldExitNonZero(warningChecks, true), true);
  assert.equal(doctorShouldExitNonZero(failingChecks, false), true);
});

test("sporades doctor rejects unknown sessions with structured errors and hints", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--session", "public-dev", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid doctor session.",
        hint: "Use one of: dev, container, hosted.",
        diagnostics: { session: "public-dev" },
      },
    });
  });
});

test("sporades doctor rejects incompatible hosted option combinations", async () => {
  await withTempDir(async (dir) => {
    const localWithHost = await runCli(["doctor", "--session", "dev", "--host", "personal", "--json"], { cwd: dir });
    assert.equal(localWithHost.code, 1);
    assert.match(JSON.parse(localWithHost.stdout).error.hint, /--session hosted/);

    const hostedWithoutSubname = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--json"], {
      cwd: dir,
    });
    assert.equal(hostedWithoutSubname.code, 1);
    assert.match(JSON.parse(hostedWithoutSubname.stdout).error.hint, /--host <alias> --subname <name>/);
  });
});
