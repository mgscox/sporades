import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctorShouldExitNonZero } from "../dist/cli/doctor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDI9R+ElI6awrzqT1DDZjMa6q7iH+jF5bughycSLBOa/ test@example";
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;

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

function startCli(args, options = {}) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.trim());
      if (line) {
        cleanup();
        resolve(JSON.parse(line));
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before stdout line.\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)));
}

async function installFakeReact(projectDir) {
  await writePackage(
    projectDir,
    "react",
    {
      ".": "./index.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
  await writePackage(
    projectDir,
    "react-dom",
    {
      "./client": "./client.js",
    },
    {
      "client.js": "export function createRoot() { return { render() {} }; }\n",
    },
  );
}

async function createProject(dir, name = "doctor-island") {
  const result = await runCli(["create", name, "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  return path.join(dir, name);
}

async function updateSporadesConfig(projectDir, update) {
  const configPath = path.join(projectDir, "sporades.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  update(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function findCheck(envelope, id) {
  const check = envelope.data.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `Expected doctor check ${id}`);
  return check;
}

test("sporades doctor --help documents the diagnostic command options", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--help"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: sporades doctor \[options\]/);
    assert.match(result.stdout, /--session <name>/);
    assert.match(result.stdout, /public-dev/);
    assert.match(result.stdout, /--host <alias>/);
    assert.match(result.stdout, /--subname <name>/);
    assert.match(result.stdout, /--strict/);
    assert.match(result.stdout, /--json/);
  });
});

test("sporades doctor --json returns a stable diagnostic envelope", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const result = await runCli(["doctor", "--json"], { cwd: projectDir });

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
      pass: 4,
      warn: 0,
      fail: 0,
      skip: 0,
      info: 4,
      warning: 0,
      error: 0,
    });
    assert.equal(findCheck(envelope, "doctor.command-surface").status, "pass");
    assert.equal(findCheck(envelope, "doctor.project-config").status, "pass");
    assert.equal(findCheck(envelope, "doctor.security-policy").status, "pass");
    assert.equal(findCheck(envelope, "doctor.ssh-authorized-keys").status, "pass");
  });
});

test("sporades doctor human output groups checks by severity", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const result = await runCli(["doctor", "--session", "dev"], { cwd: projectDir });

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
    const projectDir = await createProject(dir);
    const normal = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).data.summary.skip, 1);

    const strict = await runCli(["doctor", "--session", "container", "--strict", "--json"], { cwd: projectDir });
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

test("sporades doctor fails malformed project config and unsupported project-level keys", async () => {
  await withTempDir(async (dir) => {
    const missing = await runCli(["doctor", "--json"], { cwd: dir });
    assert.equal(missing.code, 1);
    assert.equal(findCheck(JSON.parse(missing.stdout), "doctor.project-config").status, "fail");

    const projectDir = await createProject(dir, "malformed-island");
    await writeFile(path.join(projectDir, "sporades.json"), "{ not-json");
    const malformed = await runCli(["doctor", "--json"], { cwd: projectDir });
    assert.equal(malformed.code, 1);
    assert.match(findCheck(JSON.parse(malformed.stdout), "doctor.project-config").message, /Invalid project configuration/);

    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify({ name: "malformed-island", mystery: true })}\n`);
    const unsupported = await runCli(["doctor", "--json"], { cwd: projectDir });
    assert.equal(unsupported.code, 1);
    const check = findCheck(JSON.parse(unsupported.stdout), "doctor.project-config");
    assert.equal(check.status, "fail");
    assert.deepEqual(check.details.unsupportedKeys, ["mystery"]);
  });
});

test("sporades doctor reports effective security policy for the requested session", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "security-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.security.cors.allowedOrigins = ["https://example.com"];
      config.security.csp.mode = "enforce";
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "security-island", "--json"], {
      cwd: projectDir,
    });

    assert.equal(result.code, 0, result.stderr);
    const policy = findCheck(JSON.parse(result.stdout), "doctor.security-policy");
    assert.equal(policy.status, "pass");
    assert.equal(policy.details.session, "hosted");
    assert.equal(policy.details.security.cors.publicDev, false);
    assert.deepEqual(policy.details.security.cors.allowedOrigins, ["https://example.com"]);
    assert.equal(policy.details.security.csp.header, "content-security-policy");
  });
});

test("sporades doctor warns for requested or running Public Dev posture", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "public-dev-island");

    const requested = await runCli(["doctor", "--session", "public-dev", "--json"], { cwd: projectDir });
    assert.equal(requested.code, 0, requested.stderr);
    const requestedEnvelope = JSON.parse(requested.stdout);
    assert.equal(findCheck(requestedEnvelope, "doctor.security-policy").details.security.cors.publicDev, true);
    assert.equal(findCheck(requestedEnvelope, "doctor.public-dev-posture").status, "warn");

    await updateSporadesConfig(projectDir, (config) => {
      config.dev.port = 0;
    });
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--public", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const running = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir });
      assert.equal(running.code, 0, running.stderr);
      assert.equal(findCheck(JSON.parse(running.stdout), "doctor.public-dev-posture").status, "warn");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades doctor warns on permissive Container and Hosted security posture", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "permissive-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.security = {
        cors: { allowedOrigins: ["*"] },
        csp: {
          mode: "report-only",
          directives: {
            "default-src": ["*"],
            "script-src": ["*", "'unsafe-inline'"],
          },
        },
      };
    });

    const container = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(container.code, 0, container.stderr);
    const containerCheck = findCheck(JSON.parse(container.stdout), "doctor.security-policy");
    assert.equal(containerCheck.status, "warn");
    assert.match(containerCheck.hint, /Restrict security\.cors\.allowedOrigins/);
    assert.match(containerCheck.hint, /security\.csp\.mode/);

    const hosted = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "permissive-island", "--json"], {
      cwd: projectDir,
    });
    assert.equal(hosted.code, 0, hosted.stderr);
    assert.equal(findCheck(JSON.parse(hosted.stdout), "doctor.security-policy").status, "warn");
  });
});

test("sporades doctor validates valid SSH config without printing full public keys", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [{ key: TEST_PUBLIC_KEY }],
      };
    });

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(TEST_PUBLIC_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "pass");
    assert.equal(check.details.keyCount, 1);
    assert.match(check.details.fingerprints[0], /^SHA256:/);
    assert.deepEqual(check.commands, ["sporades deploy ssh"]);
  });
});

test("sporades doctor fails malformed SSH config without leaking key material", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "bad-ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [{ key: "ssh-ed25519 definitely-not-valid test@example" }],
      };
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "bad-ssh-island", "--json"], {
      cwd: projectDir,
    });

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /definitely-not-valid/);
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "fail");
    assert.match(check.message, /Malformed SSH authorized key material/);
    assert.deepEqual(check.commands, ["sporades host ssh bad-ssh-island --host personal"]);
  });
});

test("sporades doctor warns when SSH block resolves to no effective authorized keys", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "empty-ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = { authorizedKeys: [] };
    });

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "warn");
    assert.equal(check.details.keyCount, 0);
    assert.match(check.hint, /Add public keys to `ssh\.authorizedKeys`/);
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
    const result = await runCli(["doctor", "--session", "staging", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid doctor session.",
        hint: "Use one of: dev, public-dev, container, hosted.",
        diagnostics: { session: "staging" },
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
