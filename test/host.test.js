import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-host-"));
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

function hostEnv(configDir) {
  return { SPORADES_CONFIG_DIR: configDir };
}

async function installFakeSsh(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "ssh-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(42);
`,
  );
  await chmod(sshPath, 0o755);

  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
    },
    async assertNotCalled() {
      await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
    },
  };
}

async function installContractFakeSsh(dir, scriptBody) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const fakeRemoteDir = path.join(dir, "fake-remote", "bin");
  const logPath = path.join(dir, "ssh-contract-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  const helperPath = path.join(fakeRemoteDir, "sporades-host-helper");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(fakeRemoteDir, { recursive: true });
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  ${scriptBody}
});
`,
  );
  await chmod(helperPath, 0o755);
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  const result = spawnSync(process.env.FAKE_REMOTE_HELPER, {
    input: stdin,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) {
    process.stderr.write(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
});
`,
  );
  await chmod(sshPath, 0o755);

  return {
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
      FAKE_REMOTE_HELPER: helperPath,
    },
  };
}

async function readJsonl(filePath) {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("sporades host stores Host profiles outside projects and resolves the current profile", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addPersonal = await runCli(
      ["host", "add", "personal", "--server", "root@168.119.161.21", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addPersonal.code, 0, addPersonal.stderr);
    assert.deepEqual(JSON.parse(addPersonal.stdout), {
      ok: true,
      data: {
        alias: "personal",
        profile: {
          server: "root@168.119.161.21",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
        },
      },
      error: null,
    });

    const addWork = await runCli(
      ["host", "add", "work", "--server", "deploy@ssh.other.example", "--domain", "islands.other.test", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addWork.code, 0, addWork.stderr);

    const usePersonal = await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(usePersonal.code, 0, usePersonal.stderr);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout).data.alias, "personal");
    assert.equal(JSON.parse(current.stdout).data.profile.domain, "capsules.example.dev");

    const override = await runCli(["host", "current", "--host", "work", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(override.code, 0, override.stderr);
    assert.equal(JSON.parse(override.stdout).data.alias, "work");
    assert.equal(JSON.parse(override.stdout).data.profile.server, "deploy@ssh.other.example");
    assert.equal(JSON.parse(override.stdout).data.profile.domain, "islands.other.test");

    const hostConfig = JSON.parse(await readFile(path.join(configDir, "hosts.json"), "utf8"));
    assert.equal(hostConfig.currentHostAlias, "personal");
    assert.deepEqual(hostConfig.profiles.work, {
      server: "deploy@ssh.other.example",
      domain: "islands.other.test",
      scheme: "https",
      remoteRoot: "/srv/sporades",
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "hosts.json"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host bind is a local-only project remote binding helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@203.0.113.10", "--domain", "capsules.example.dev", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(["host", "add", "work", "--server", "deployer@198.51.100.40", "--domain", "apps.work.test", "--json"], {
          cwd: projectDir,
          env: { ...hostEnv(configDir), ...fakeSsh.env },
        })
      ).code,
      0,
    );
    assert.equal(
      (await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } })).code,
      0,
    );

    const bind = await runCli(["host", "bind", "notes", "--host", "work", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bind.code, 0, bind.stderr);
    const bindData = JSON.parse(bind.stdout).data;
    assert.equal(bindData.localOnly, true);
    assert.equal(bindData.authoritative, false);
    assert.deepEqual(bindData.binding, {
      hostAlias: "work",
      domain: "apps.work.test",
      scheme: "https",
      subname: "notes",
      hostedUrl: "https://notes.apps.work.test",
      remoteCapsuleId: "apps.work.test/notes",
    });

    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), bindData.binding);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.deepEqual(JSON.parse(current.stdout).data.binding, bindData.binding);

    const plainBind = await runCli(["host", "bind", "draft", "--host", "work"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plainBind.code, 0, plainBind.stderr);
    assert.match(plainBind.stdout, /Local remote binding written/);
    assert.match(plainBind.stdout, /does not register or create a Hosted Capsule/);

    await assert.rejects(readFile(path.join(configDir, "remote-binding.json"), "utf8"), { code: "ENOENT" });
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host invoke sends a JSON remote helper request over SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `process.stdout.write(JSON.stringify({
  ok: true,
  data: { received: JSON.parse(stdin), helper: "fake" },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const invoke = await runCli(["host", "invoke", "contract.echo", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invoke.code, 0, invoke.stderr);

    const output = JSON.parse(invoke.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.received, {
      action: "contract.echo",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), output.data.received);
  });
});

test("sporades host invoke reports remote helper envelopes separately from SSH transport failures", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
        { cwd: projectDir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
      return result;
    };

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule is not registered.",
    hint: "Run \`sporades host register team-notes\` first."
  }
}) + "\\n");
process.exit(0);
`,
    );
    await addHost(helperFailureSsh.env);
    const helperFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes` first.",
      },
    });

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const commandFailureSsh = await installContractFakeSsh(
      path.join(dir, "command-failure"),
      `process.stderr.write("sporades-host-helper: command not found\\n");
process.exit(127);
`,
    );
    const commandFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...commandFailureSsh.env },
    });
    assert.equal(commandFailure.code, 1);
    assert.deepEqual(JSON.parse(commandFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Remote Host helper command failed.",
        hint: "Check the Host server helper installation and retry the command.",
      },
    });
  });
});

test("sporades host validation returns standard JSON errors", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await mkdir(configDir, { recursive: true });

    const missingAlias = await runCli(["host", "add", "--server", "root@example.com", "--domain", "example.com", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(missingAlias.code, 1);
    assert.deepEqual(JSON.parse(missingAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Missing Host profile alias.",
        hint: "Use `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>`.",
      },
    });

    const invalidDomain = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "bad_domain", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidDomain.code, 1);
    assert.deepEqual(JSON.parse(invalidDomain.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Hosted domain.",
        hint: "Pass a DNS domain such as `example.com` without a scheme, path, or wildcard.",
      },
    });

    const invalidRemoteRoot = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "example.com", "--remote-root", "relative/path", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidRemoteRoot.code, 1);
    assert.deepEqual(JSON.parse(invalidRemoteRoot.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host remote root.",
        hint: "Pass an absolute POSIX path such as `/srv/sporades`.",
      },
    });

    const unknownAlias = await runCli(["host", "use", "missing", "--json"], { cwd: dir, env: hostEnv(configDir) });
    assert.equal(unknownAlias.code, 1);
    assert.deepEqual(JSON.parse(unknownAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unknown Host profile alias: missing",
        hint: "Add it with `sporades host add missing --server <ssh-target> --domain <hosted-domain>`.",
      },
    });
  });
});

test("host profile implementation does not hard-code the first Hosted domain", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /mattgscox\.co\.uk/);
});
