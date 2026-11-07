import { createHostFixture, hostFixtureConfig, removeHostFixture } from "./support/host-fixture-root.js";
import { withFixtureUmask } from "./support/fixture-umask.js";
import { preservedDeployFilePath } from "../dist/deploy-files.js";
import assert from "node:assert/strict";
import { chmod, chown, copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

import { createWebSocketHub, openDevDatabase, prepareHttpSecurity, routeConnectionToken, routeRuntimeHealth } from "../dist/server-runtime-source.js";
import { CLIENT_CAPABILITIES, CLIENT_TEMPLATES } from "../dist/client-capabilities.js";
import { validateReleaseArchive } from "../dist/cli/host-helper-archive.js";
import { createHostLifecycleRequest, createHostReleaseRequest } from "../dist/cli/host-request-builders.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";
import { installPrerenderFixture } from "./support/prerender-capsule.js";
import { createBundle } from "../dist/bundle-pipeline.js";
import { summarizePublicTree } from "../dist/public-tree.js";
import { routeHttpAdmission, routeWebSocketAdmission } from "../dist/http-runtime.js";
import { parseAdmissionPolicy } from "../dist/admission-policy.js";
import { trustedClientAddress } from "../dist/client-address.js";
import { ADMISSION_INSPECTION_SCRIPT } from "../dist/cli/admission-inspection.js";
import { installPrerenderWarnings, assertPrerenderWarnings } from "./support/prerender-warnings.js";
// Independent host cases share fixture helpers across desk workers.
import {
repoRoot,
cliPath,
hostHelperPath,
rootPackageJson,
TEST_PUBLIC_KEY,
buildHostLifecycle,
withTempDir,
withHttpServer,
withHostedRuntimeTransportServer,
openRawWebSocketHandshake,
runCli,
startHostHelper,
runHostHelper,
startExecutable,
writeFakeProcEntry,
waitForPath,
waitForChildPid,
hostEnv,
writeHostProfileConfig,
installFakeSsh,
installFakeShellSsh,
installContractFakeSsh,
installFakeScp,
installFakeDocker,
installFakeCaddy,
installFakeCaddyUserCommands,
readJsonl,
writeHostedCapsuleRollbackFixture,
escapeRegExp,
readHostBootstrapSmokeEnv,
readHostRegisterSmokeEnv,
readHostPushRoutingSmokeEnv,
readHostLogsSmokeEnv,
listArchiveEntries,
withCacheBust,
writePublicRuntimeFiles,
createTarGz,
writeHostedCapsuleInstallFixture,
writeLegacySealedInstallFixture,
alignSealedFixtureWithBuiltLifecycle,
installFakeReact,
prepareRouteLockFixture,
customDomainFixture,
withBackupRouteFixture,
runRouteRecoveryPass
} from "./support/host-fixture.js";


test("Hosted Capsule CORS checks use the configured public origin instead of spoofed forwarded headers", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(
      dir,
      { security: { cors: { allowedOrigins: ["https://ops.example.test"] } } },
      async (baseUrl) => {
        const publicOrigin = await fetch(baseUrl, {
          headers: { origin: "https://team-notes.capsules.example.dev" },
        });
        assert.equal(publicOrigin.headers.get("access-control-allow-origin"), "https://team-notes.capsules.example.dev");

        const explicitOrigin = await fetch(baseUrl, {
          headers: { origin: "https://ops.example.test" },
        });
        assert.equal(explicitOrigin.headers.get("access-control-allow-origin"), "https://ops.example.test");

        const spoofedForwardedOrigin = await fetch(baseUrl, {
          headers: {
            origin: "https://evil.example.test",
            "x-forwarded-host": "evil.example.test",
            "x-forwarded-proto": "https",
          },
        });
        assert.equal(spoofedForwardedOrigin.headers.get("access-control-allow-origin"), null);
      },
    );
  });
});


test("Hosted Capsule WebSocket upgrades reject missing and cross-site origins before activating transport", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(dir, {}, async (baseUrl, createConnectionToken) => {
      const missingOrigin = await openRawWebSocketHandshake(baseUrl, {}, createConnectionToken());
      assert.doesNotMatch(missingOrigin, /^HTTP\/1\.1 101/m);

      const crossSiteOrigin = await openRawWebSocketHandshake(baseUrl, {
        origin: "https://evil.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      }, createConnectionToken());
      assert.doesNotMatch(crossSiteOrigin, /^HTTP\/1\.1 101/m);

      const publicOrigin = await openRawWebSocketHandshake(baseUrl, {
        origin: "https://team-notes.capsules.example.dev",
      }, createConnectionToken());
      assert.match(publicOrigin, /^HTTP\/1\.1 101/m);
    });
  });
});


test("sporades host stores Host profiles outside projects and resolves the current profile", async () => {
  // This target is stored locally; the profile test does not connect over SSH.
  const server = process.env.SPORADES_TEST_HOST_SERVER || "root@203.0.113.10";
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addPersonal = await runCli(
      ["host", "add", "personal", "--server", server, "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addPersonal.code, 0, addPersonal.stderr);
    assert.deepEqual(JSON.parse(addPersonal.stdout), {
      ok: true,
      data: {
        alias: "personal",
        profile: {
          server,
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
          tls: { mode: "automatic" },
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
      tls: { mode: "automatic" },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "hosts.json"), "utf8"), { code: "ENOENT" });
  });
});


test("sporades host upgrade copies the running CLI sibling Host helper to the selected Host server", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
      currentHostAlias: "personal",
    });
    const fakeSsh = await installFakeShellSsh(path.join(dir, "fake-ssh"));
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const result = await runCli(["host", "upgrade", "--host", "personal", "--json"], {
      cwd: dir,
      env,
    });
    assert.equal(result.code, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      ok: true,
      data: {
        alias: "personal",
        version: rootPackageJson.version,
        localHelper: path.join(repoRoot, "bin", "sporades-host-helper.js").split(path.sep).join("/"),
        remoteHelper: "/opt/sporades/bin/sporades-host-helper",
      },
      error: null,
    });

    const sshCalls = (await readFile(fakeSsh.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const [scpCall] = (await readFile(fakeScp.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const helperChecksum = createHash("sha256").update(await readFile(hostHelperPath)).digest("hex");
    const stagedHelper = `/opt/sporades/bin/.sporades-host-helper-stage-${helperChecksum}.mjs`;
    assert.equal(scpCall.source, path.join(repoRoot, "bin", "sporades-host-helper.js"));
    assert.equal(scpCall.target, `root@example.test:${stagedHelper}`);
    assert.deepEqual(sshCalls[0].args, ["root@example.test", "mkdir -p '/opt/sporades/bin'"]);
    assert.equal(sshCalls.length, 2);
    assert.equal(sshCalls[1].args[0], "root@example.test");
    assert.match(sshCalls[1].args[1], new RegExp(`^chmod 0755 '${stagedHelper}' && '${stagedHelper}' --install-host-helper '/opt/sporades/bin/sporades-host-helper' '${helperChecksum}'$`));
  });
});


test("Host helper upgrade times out fail closed and retries without exposing old and new actions together", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const remoteBin = path.join(remoteRoot, "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper-must-not-run\n", { mode: 0o755 });
    await chmod(target, 0o755);
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 42001, target);
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "100",
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
    };

    const malformedTimeout = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: { ...env, SPORADES_HOST_UPGRADE_LOCK_TIMEOUT_MS: "NaN" },
    }).result;
    assert.equal(malformedTimeout.code, 1);
    assert.equal(await readFile(target, "utf8"), "#!/bin/sh\nprintf '%s\\n' legacy-helper-must-not-run\n");

    const failed = await startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env }).result;
    assert.equal(failed.code, 1);
    assert.match(await readFile(target, "utf8"), /SPORADES_HOST_HELPER_DISPATCHER_V1/);
    assert.equal(await readFile(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked"), "utf8"), "upgrade-recovery-required\n");
    assert.equal(await readFile(path.join(remoteBin, ".sporades-host-helper.needs-drain"), "utf8"), "legacy-helper-drain-required\n");
    const request = `${JSON.stringify({
      action: "host.version",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
    })}\n`;
    const blocked = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).error.message, "Host helper upgrade requires recovery.");
    assert.doesNotMatch(blocked.stdout, /legacy-helper-must-not-run/);

    await rm(path.join(procRoot, "42001"), { recursive: true, force: true });
    const recovered = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: { ...env, SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "1000" },
    }).result;
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    const current = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(current.stdout).data.version, rootPackageJson.version, current.stdout);
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.needs-drain")), { code: "ENOENT" });
  });
});


test("Host helper legacy drain uses a monotonic bounded deadline despite wall-clock rollback", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 43002, target);
    const clockRollback = path.join(dir, "clock-rollback.cjs");
    await writeFile(clockRollback, "Date.now = () => 0;\n");
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      detached: true,
      env: {
        NODE_OPTIONS: `--require=${clockRollback}`,
        SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
        SPORADES_TEST_PROC_ROOT: procRoot,
        SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "100",
        SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      },
    });
    const forcedKill = setTimeout(() => {
      try { process.kill(-upgrade.child.pid, "SIGKILL"); } catch {}
    }, 2_000);
    const result = await upgrade.result;
    clearTimeout(forcedKill);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Existing Host helper actions did not drain before the upgrade timeout/);
  });
});


test("Host helper legacy drain rejects an oversized process table within its work bound", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await Promise.all(Array.from({ length: 80 }, (_, index) => mkdir(path.join(procRoot, String(44000 + index)))));
    const startedAt = process.hrtime.bigint();
    const result = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: {
        SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
        SPORADES_TEST_PROC_ROOT: procRoot,
        SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "1000",
        SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES: "64",
        SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      },
    }).result;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Host process inspection exceeded its safe work bound/);
    assert.ok(elapsedMs < 1000, `process inspection must be bounded, took ${elapsedMs}ms`);
  });
});


test("sporades host bootstrap can run against an opt-in real SSH Host server", async (t) => {
  const smoke = await readHostBootstrapSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_REAL_HOST=1 on a disposable Host plus SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, and SPORADES_HOST_SMOKE_REMOTE_ROOT to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const addArgs = [
      "host",
      "add",
      smoke.alias,
      "--server",
      smoke.server,
      "--domain",
      smoke.domain,
      "--remote-root",
      smoke.remoteRoot,
      "--tls",
      smoke.tls,
      "--json",
    ];
    const addHost = await runCli(addArgs, { cwd: dir, env: hostEnv(configDir) });
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(bootstrap.code, 0, `${bootstrap.stderr}\n${bootstrap.stdout}`);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.domain, smoke.domain);
    assert.equal(output.data.remoteRoot, smoke.remoteRoot);
    assert.equal(output.data.tls.mode, smoke.tls);
    assert.equal(output.data.preservedCapsules, true);
  });
});


test("sporades host register can run against an opt-in real SSH Host server and returns the unavailable response", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_REAL_HOST=1 on a disposable Host plus SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const projectName = `${smoke.template}-host-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });

    assert.equal(register.code, 0, `${register.stderr}\n${register.stdout}`);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsule.subname, smoke.subname);
    assert.equal(output.data.capsule.domain, smoke.domain);
    assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(output.data.binding.hostedUrl, output.data.capsule.hostedUrl);

    const response = await fetch(output.data.capsule.hostedUrl);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Hosted Capsule unavailable/);
  });
});


test("sporades host logs can read a real Host server after requesting an opt-in Capsule route", async (t) => {
  const smoke = await readHostLogsSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_REAL_HOST=1 on a disposable Host plus SPORADES_HOST_LOGS_SMOKE_SSH_TARGET, SPORADES_HOST_LOGS_SMOKE_DOMAIN, SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT, and SPORADES_HOST_LOGS_SMOKE_SUBNAME to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const marker = `sporades-log-smoke-${Date.now()}`;
    const routeUrl = `https://${smoke.subname}.${smoke.domain}/?${marker}`;
    const response = await fetch(routeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    assert(response.status >= 100, `Expected ${routeUrl} to return an HTTP response`);

    const logs = await runCli(["host", "logs", "--host", smoke.alias, "--lines", String(smoke.lines), "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(logs.code, 0, `${logs.stderr}\n${logs.stdout}`);
    const output = JSON.parse(logs.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.lineCount, smoke.lines);
    assert(Array.isArray(output.data.entries));
    const joinedEntries = output.data.entries.join("\n");
    assert(
      joinedEntries.includes(marker) || joinedEntries.includes(`${smoke.subname}.${smoke.domain}`),
      "Expected recent Caddy log entries to include the triggered Capsule route or marker",
    );
  });
});


test("sporades host list can run against an opt-in real SSH Host server after disposable registration", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_REAL_HOST=1 on a disposable Host plus SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const projectName = `${smoke.template}-host-list-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    let registeredThisRun = false;
    if (register.code === 0) {
      registeredThisRun = true;
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");
    }

    const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.host.domain, smoke.domain);
    const capsule = output.data.capsules.find((candidate) => candidate.subname === smoke.subname);
    assert.ok(capsule, `Expected ${smoke.subname} to appear in host list output.`);
    assert.equal(capsule.domain, smoke.domain);
    assert.equal(capsule.hostedUrl, `https://${smoke.subname}.${smoke.domain}`);
    assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(typeof capsule.registry.status, "string");
    if (registeredThisRun) {
      assert.equal(capsule.currentRelease, null);
    }
  });
});


test("sporades host push can restart a real Hosted Capsule and serve it through the public route", async (t) => {
  const smoke = await readHostPushRoutingSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_REAL_HOST=1 on a disposable Host plus SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, SPORADES_HOST_SMOKE_SUBNAME, SPORADES_HOST_SMOKE_PUBLIC_URL, and SPORADES_HOST_SMOKE_EXPECTED_TEXT to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const projectName = `${smoke.template}-host-push-routing-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    if (register.code === 0) {
      const output = JSON.parse(register.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.capsule.subname, smoke.subname);
      assert.equal(output.data.capsule.domain, smoke.domain);
      assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

      const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
        cwd: projectDir,
        env: hostEnv(configDir),
      });
      assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
      const capsule = JSON.parse(list.stdout).data.capsules.find((candidate) => candidate.subname === smoke.subname);
      assert.ok(capsule, `Expected existing Hosted Capsule ${smoke.subname} to be listed for ${smoke.domain}.`);
      assert.equal(capsule.domain, smoke.domain);
      assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    }

    const push = await runCli(["host", "push", "--host", smoke.alias, "--subname", smoke.subname, "--restart", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const pushOutput = JSON.parse(push.stdout);
    assert.equal(pushOutput.ok, true);
    assert.equal(pushOutput.error, null);
    assert.equal(pushOutput.data.installed, true);
    assert.equal(pushOutput.data.restartRequested, true);
    assert.equal(pushOutput.data.restarted, true);
    assert.equal(pushOutput.data.capsule.subname, smoke.subname);
    assert.equal(pushOutput.data.capsule.domain, smoke.domain);

    const response = await fetch(withCacheBust(smoke.publicUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, new RegExp(escapeRegExp(smoke.expectedText)));
  });
});


test("sporades host helper bootstraps a Hosted domain idempotently without deleting Capsule state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const preservedCapsuleFile = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data", "data.db");
    await mkdir(path.dirname(preservedCapsuleFile), { recursive: true });
    await writeFile(preservedCapsuleFile, "existing capsule data\n");
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "unrelated.example.dev {\n  respond \"still here\"\n}\n");
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        domainDirectory: path.join(remoteRoot, "hosts", "capsules.example.dev"),
        tls: {
          mode: "automatic",
          directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          certificate: null,
          key: null,
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const savedUmask = process.umask(0o077);
    let bootstrap;
    try { bootstrap = await runHostHelper(request, { cwd: dir, env }); }
    finally { process.umask(savedUmask); }
    for (const file of ["Caddyfile", "sporades-hosted-domains.caddy", "hosts/capsules.example.dev.caddy", "hosts/capsules.example.dev/host.caddy", "hosts/capsules.example.dev/.sporades-placeholder.caddy"]) {
      assert.equal((await stat(path.join(remoteRoot, "caddy", file))).mode & 0o777, 0o644, file);
    }

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.bootstrapped, true);
    assert.equal(output.data.preservedCapsules, true);
    assert.deepEqual(output.data.network, {
      name: "sporades-hosted-capsules",
      created: true,
    });
    assert.equal(output.data.caddy.managedInclude, path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"));
    assert.equal(output.data.caddy.domainInclude, path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"));
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.caddy.accessLog, {
      file: path.join(remoteRoot, "caddy", "logs", "access.log"),
      directory: path.join(remoteRoot, "caddy", "logs"),
      owner: "caddy",
      writableByService: true,
    });

    assert.equal(await readFile(preservedCapsuleFile, "utf8"), "existing capsule data\n");
    assert.equal((await stat(path.join(remoteRoot, "bin"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "incoming"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "caddy", "logs"))).isDirectory(), true);
    assert.equal(await readFile(path.join(remoteRoot, "caddy", "logs", "access.log"), "utf8"), "");
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"))).isDirectory(), true);
    const caddyfile = await readFile(path.join(remoteRoot, "caddy", "Caddyfile"), "utf8");
    assert.match(caddyfile, /unrelated\.example\.dev \{\n  respond "still here"\n\}/);
    assert.match(caddyfile, new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"))}`));
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "*.caddy"))}`),
    );
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "*.caddy"))}`),
    );
    const healthRoute = await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "host.caddy"), "utf8");
    assert.match(healthRoute, /host\.capsules\.example\.dev \{/);
    assert.match(healthRoute, /respond \/__sporades\/health "\{\\"ok\\":true\}" 200/);
    assert.doesNotMatch(healthRoute, /container|registry|\/srv|remote-root|version|metrics|secret/i);

    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["network", "inspect", "sporades-hosted-capsules"],
        ["network", "create", "sporades-hosted-capsules"],
      ],
    );
    assert.deepEqual(
      (await caddyUser.chownCalls()).map((call) => call.args),
      [],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["validate", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});


test("sporades host helper requires readable Cloudflare origin certificate files only for cloudflare-origin TLS", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const tlsDirectory = path.join(remoteRoot, "hosts", "capsules.example.dev", "tls");
    const docker = await installFakeDocker(dir);
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: tlsDirectory,
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        tls: {
          mode: "cloudflare-origin",
          directory: tlsDirectory,
          certificate: path.join(tlsDirectory, "origin.crt"),
          key: path.join(tlsDirectory, "origin.key"),
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir, env });

    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: `Install readable Cloudflare origin certificate and key files at ${path.join(tlsDirectory, "origin.crt")} and ${path.join(tlsDirectory, "origin.key")}, then rerun \`sporades host bootstrap --host personal\`.`,
      },
    });
    await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });

    await writeFile(path.join(tlsDirectory, "origin.crt"), "certificate\n");
    await writeFile(path.join(tlsDirectory, "origin.key"), "key\n");
    const present = await runHostHelper(request, { cwd: dir, env });
    assert.equal(present.code, 0, present.stderr);
    const output = JSON.parse(present.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.tls.mode, "cloudflare-origin");
    assert.equal(output.data.tls.certificate, path.join(tlsDirectory, "origin.crt"));
    assert.equal(output.data.tls.key, path.join(tlsDirectory, "origin.key"));
    for (const file of ["origin.crt", "origin.key"]) {
      const details = await stat(path.join(tlsDirectory, file));
      assert.equal(details.mode & 0o777, 0o640, "Caddy can load TLS material without exposing the private key to other users");
      assert.equal(details.gid, Number(caddyUser.env.FAKE_CADDY_GID));
    }
  });
});


test("sporades host bootstrap rejects path overrides and final-entry symlinks without touching outside bytes", async () => {
  await withTempDir(async (dir) => {
    const outside = path.join(dir, "outside.txt");
    await writeFile(outside, "outside-byte-identity\n", { mode: 0o600 });
    const overrideRoot = path.join(dir, "override-root");
    const override = await runHostHelper({
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: overrideRoot },
      capsule: null,
      bootstrap: { caddy: { accessLog: outside }, tls: { mode: "automatic" } },
    }, { cwd: dir });
    assert.equal(JSON.parse(override.stdout).error.message, "Invalid Host bootstrap path.", override.stdout);
    assert.equal(await readFile(outside, "utf8"), "outside-byte-identity\n");

    const finalEntries = [
      ["caddyfile", (root) => path.join(root, "caddy", "Caddyfile")],
      ["managed", (root) => path.join(root, "caddy", "sporades-hosted-domains.caddy")],
      ["domain", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev.caddy")],
      ["health", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev", "host.caddy")],
      ["placeholder", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev", ".sporades-placeholder.caddy")],
      ["access-log", (root) => path.join(root, "caddy", "logs", "access.log")],
    ];
    for (const [name, resolveFinal] of finalEntries) {
      const remoteRoot = path.join(dir, `symlink-${name}`);
      const finalPath = resolveFinal(remoteRoot);
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o755 });
      await symlink(outside, finalPath);
      const result = await runHostHelper({
        action: "host.bootstrap",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        bootstrap: { tls: { mode: "automatic" } },
      }, { cwd: dir });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${name}: ${result.stdout}`);
      assert.equal(await readFile(outside, "utf8"), "outside-byte-identity\n", name);
    }
  });
});


test("sporades host bootstrap retains exact Caddy access-log ownership across idempotent root runs", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"), {
      env: { FAKE_CADDY_UID: "12345", FAKE_CADDY_GID: "12346", FAKE_CADDY_APPLY_CHOWN: "1" },
    });
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    };
    const first = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(first.stdout).ok, true, `first: ${first.stdout}`);
    const repeatMutationMarker = path.join(dir, "repeat-mutation.marker");
    const repeat = await runHostHelper(request, {
      cwd: dir,
      env: {
        ...env,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-access-log-descriptor-mutate",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: repeatMutationMarker,
      },
    });
    assert.equal(JSON.parse(repeat.stdout).ok, true, `repeat: ${repeat.stdout}`);
    await assert.rejects(readFile(repeatMutationMarker, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await caddyUser.chownCalls(), [], "bootstrap must never delegate privileged ownership changes to pathname-based chown");
    const logDirectory = path.join(remoteRoot, "caddy", "logs");
    const logFile = path.join(logDirectory, "access.log");
    assert.deepEqual([Number((await lstat(logDirectory)).uid), Number((await lstat(logDirectory)).gid)], [12345, 12346]);
    assert.deepEqual([Number((await lstat(logFile)).uid), Number((await lstat(logFile)).gid)], [12345, 12346]);

    await chown(logFile, 22345, 22346);
    const foreign = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(foreign.stdout).error.message, "Hosted Capsule route trust validation failed.", foreign.stdout);
    assert.deepEqual([Number((await lstat(logFile)).uid), Number((await lstat(logFile)).gid)], [22345, 22346]);

    await chown(logFile, 12345, 12346);
    await chown(logDirectory, 22345, 22346);
    const foreignDirectory = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(foreignDirectory.stdout).error.message, "Hosted Capsule route trust validation failed.", foreignDirectory.stdout);
    assert.deepEqual([Number((await lstat(logDirectory)).uid), Number((await lstat(logDirectory)).gid)], [22345, 22346]);
  });
});


test("sporades host helper rotates a Hosted Capsule sealed-env key and cleans only unreferenced keys", async () => {
  await withTempDir(async (dir) => {
    // This key-retention fixture has no runtime container. Keep its state probe
    // independent of whichever Docker engine happens to be on the workstation.
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING_STATUS: "1" } });
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const dataDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data");
    const keysDir = path.join(dataDir, "sealed-server-env", "keys");
    const oldFingerprint = "0123456789abcdef";
    const staleFingerprint = "9999999999999999";
    await mkdir(keysDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(keysDir, `${oldFingerprint}.private.pem`), "old retained private key\n");
    await writeFile(path.join(keysDir, `${oldFingerprint}.public.pem`), "old retained public key\n");
    await writeFile(path.join(keysDir, `${staleFingerprint}.private.pem`), "stale private key\n");
    await writeFile(path.join(keysDir, `${staleFingerprint}.public.pem`), "stale public key\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "released",
        currentRelease: { id: "20260630T221500Z-feedface" },
        sealedServerEnv: { currentKeyFingerprint: oldFingerprint },
        releases: [
          {
            id: "20260630T221500Z-feedface",
            current: true,
            state: "started",
            source: {
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: oldFingerprint },
            },
          },
        ],
      })}\n`,
    );

    const rotate = await runHostHelper(
      {
        action: "capsule.sealed-env.rotate-key",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rotate.code, 0, rotate.stderr);
    const output = JSON.parse(rotate.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rotated, true);
    assert.equal(output.data.sealedServerEnv.previousPublicKeyFingerprint, oldFingerprint);
    assert.match(output.data.sealedServerEnv.publicKeyFingerprint, /^[a-f0-9]{16}$/);
    assert.notEqual(output.data.sealedServerEnv.publicKeyFingerprint, oldFingerprint);
    assert.match(output.data.sealedServerEnv.publicKey, /PUBLIC KEY/);
    assert.equal(
      output.data.sealedServerEnv.publicKeyPath,
      path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`),
    );
    assert.doesNotMatch(rotate.stdout, /PRIVATE KEY|old retained private key|stale private key/);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, output.data.sealedServerEnv.publicKeyFingerprint);
    assert.equal(record.releases[0].source.sealedServerEnv.publicKeyFingerprint, oldFingerprint);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(await readFile(path.join(keysDir, `${oldFingerprint}.private.pem`), "utf8"), "old retained private key\n");
    assert.equal(await readFile(path.join(keysDir, `${oldFingerprint}.public.pem`), "utf8"), "old retained public key\n");
    await assert.rejects(readFile(path.join(keysDir, `${staleFingerprint}.private.pem`), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(keysDir, `${staleFingerprint}.public.pem`), "utf8"), { code: "ENOENT" });
    assert.match(await readFile(path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.private.pem`), "utf8"), /PRIVATE KEY/);
    assert.equal(
      await readFile(path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`), "utf8"),
      output.data.sealedServerEnv.publicKey,
    );
    assert.deepEqual(output.data.cleanup.deletedKeyFingerprints, [staleFingerprint]);
    assert.deepEqual(output.data.cleanup.retainedKeyFingerprints.sort(), [oldFingerprint, output.data.sealedServerEnv.publicKeyFingerprint].sort());
  });
});


test("sporades host helper rejects non-canonical per-Capsule HTTP log paths before filesystem mutation", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const outsideDirectory = path.join(dir, "outside");
    await mkdir(outsideDirectory, { mode: 0o700 });
    const sentinel = path.join(outsideDirectory, "sentinel.bin");
    await writeFile(sentinel, Buffer.from([1, 3, 3, 7]), { mode: 0o600 });
    const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const result = await runHostHelper({
      action: "capsule.register",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      registration: {
        route: { log: { file: path.join(outsideDirectory, "http.log") } },
      },
    }, { cwd: dir, env: caddy.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule HTTP log path.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before);
    assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"]);

    for (const [label, lifecycle] of [
      ["legacy", { accessLog: path.join(outsideDirectory, "legacy.log") }],
      ["shared", { routes: { accessLog: path.join(outsideDirectory, "shared.log") } }],
      ["running", { routes: { running: { log: { file: path.join(outsideDirectory, "running.log") } } } }],
      ["unavailable", { routes: { unavailable: { log: { file: path.join(outsideDirectory, "unavailable.log") } } } }],
    ]) {
      const lifecycleResult = await runHostHelper({
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle,
      }, { cwd: dir, env: caddy.env });
      assert.equal(JSON.parse(lifecycleResult.stdout).error.message, "Invalid Hosted Capsule HTTP log path.", `${label}: ${lifecycleResult.stdout}`);
      assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, label);
      assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"], label);
    }
  });
});


test("required Server env blocks Host push before SSH/upload and allows an explicit bypass", async () => {
  await withTempDir(async (dir) => {
    const fakeSsh = await installContractFakeSsh(path.join(dir, "fake-ssh"), `
const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({ ok: true, data: { installed: true, release: { id: request.release.id } }, error: null }) + "\\n");
`);
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const env = { ...hostEnv(path.join(dir, "config")), ...fakeSsh.env, ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}` };
    const created = await runCli(["create", "env-island", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"], { cwd: dir, env });
    assert.equal(created.code, 0, created.stdout);
    const projectDir = path.join(dir, "env-island");
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.env = { required: ["TICKETS_INTAKE_URL"] };
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await runCli(["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--json"], { cwd: projectDir, env })).code, 0);
    const args = ["host", "push", "--host", "work", "--subname", "env-island", "--json"];
    const denied = await runCli(args, { cwd: projectDir, env });
    assert.equal(denied.code, 1);
    assert.match(JSON.parse(denied.stdout).error.message, /Missing required Server env keys: TICKETS_INTAKE_URL/);
    assert.match(JSON.parse(denied.stdout).error.hint, /--allow-missing-env/);
    await assert.rejects(readFile(fakeSsh.logPath), { code: "ENOENT" });
    await assert.rejects(readFile(fakeScp.logPath), { code: "ENOENT" });
    const bypassed = await runCli([...args, "--allow-missing-env"], { cwd: projectDir, env });
    assert.equal(bypassed.code, 0, bypassed.stdout + bypassed.stderr);
    assert.equal((await readJsonl(fakeScp.logPath)).length, 1);
    // Existing Capsules keep push behavior until they opt in with an env stanza.
    delete config.env;
    await writeFile(configPath, JSON.stringify(config));
    const legacy = await runCli(args, { cwd: projectDir, env });
    assert.equal(legacy.code, 0, legacy.stdout + legacy.stderr);
    assert.equal((await runCli(["env", "init", "--json"], { cwd: projectDir, env })).code, 0);
    config.env = { required: ["TICKETS_INTAKE_URL"] };
    config.mail = { webhooks: { mailjet: { path: "/mail-events", secretEnv: "MAIL_WEBHOOK_SECRET" } } };
    await writeFile(configPath, JSON.stringify(config));
    const sealedDenied = await runCli(args, { cwd: projectDir, env });
    assert.equal(sealedDenied.code, 1);
    assert.match(JSON.parse(sealedDenied.stdout).error.message, /MAIL_WEBHOOK_SECRET, TICKETS_INTAKE_URL/);
    assert.equal((await readJsonl(fakeScp.logPath)).length, 2);
  });
});


test("sporades host push can publish a Vanilla TypeScript Capsule and request restart", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: request.release.restart,
    restarted: false,
    release: {
      id: request.release.id,
      serverEnvIncluded: request.release.serverEnvIncluded,
      files: request.release.files
    },
    capsule: {
      subname: request.capsule.subname,
      hostedUrl: request.release.hostedUrl
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "vanilla-island", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "vanilla-island");
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const push = await runCli(["host", "push", "--host", "work", "--subname", "field-notes", "--restart", "--json"], {
      cwd: projectDir,
      env,
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.deepEqual(output.data.release.files, ["server.mjs", "sporades.json", "public/client.js", "public/client.js.map", "public/index.html"]);
    assert.equal(output.data.capsule.hostedUrl, "https://field-notes.apps.work.test");
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });

    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.equal(scpCall.target, `deploy@example.test:/srv/sporades/incoming/${output.data.release.id}.tar.gz`);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, ["public/client.js", "public/client.js.map", "public/index.html", "server.mjs", "sporades.json"]);
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(clientBundle, /Vanilla Sporades/);
    assert.doesNotMatch(clientBundle, /react-dom|preact\/hooks/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.host.alias, "work");
    assert.equal(request.host.domain, "apps.work.test");
    assert.equal(request.capsule.subname, "field-notes");
    assert.equal(request.release.restart, true);
  });
});


test("Hosted releases package, install, inspect and switch the same prerender public tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(['create', 'prerender-hosted', '--framework', 'react', '--toolchain', 'vite', '--no-install', '--no-git', '--json'], {cwd:dir});
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, 'prerender-hosted');
    await installFakeReact(projectDir);
    const config = await installPrerenderFixture(projectDir);
    const fixture = await writeHostedCapsuleInstallFixture(dir);
    const docker = await installFakeDocker(path.join(dir, 'fake-prerender-docker'));
    const request = { host: {alias:'personal', domain:fixture.domain, scheme:'https', remoteRoot:fixture.remoteRoot}, capsule:{subname:fixture.subname} };
    const retained = [];
    await mkdir(path.join(projectDir, "public"));
    for (const [index, label] of ['Useful before JavaScript', 'New static release'].entries()) {
      await writeFile(path.join(projectDir, 'render/copy.ts'), `export const copy = ${JSON.stringify(label)};`);
      const sitemap = `<urlset><url><loc>https://example.test/release-${index}</loc></url></urlset>`;
      await writeFile(path.join(projectDir, 'public/sitemap.xml'), sitemap);
      await writeFile(path.join(projectDir, 'public/robots.txt'), `Sitemap: /sitemap.xml\n# release ${index}`);
      await writeFile(path.join(projectDir, 'public/favicon.ico'), Buffer.from([0, 0, 1, index]));
      const bundle = await createBundle(projectDir, config);
      const staging = path.join(dir, `prerender-release-${index}`);
      await mkdir(staging);
      await cp(bundle.staticFiles.publicDir, path.join(staging, 'public'), {recursive:true});
      await copyFile(bundle.paths.serverBundle, path.join(staging, 'server.mjs'));
      await copyFile(path.join(projectDir, 'sporades.json'), path.join(staging, 'sporades.json'));
      const publicFiles = (await summarizePublicTree(bundle.staticFiles.publicDir)).paths;
      const releaseId = `20260922T12000${index}Z-feedface`;
      const releaseDir = path.join(fixture.capsuleDir, 'releases', releaseId);
      const archive = path.join(fixture.remoteRoot, 'incoming', `${releaseId}.tar.gz`);
      const files = ['server.mjs', 'sporades.json', ...publicFiles.map((file) => `public/${file}`)];
      await createTarGz(archive, staging, files);
      const release = {...fixture.release, id:releaseId, restart:false, remoteArchive:archive, files, directories:{...fixture.release.directories, release:releaseDir}};
      const installed = await runHostHelper({...request, action:'capsule.release.install', release}, {cwd:dir, env:docker.env});
      assert.equal(installed.code, 0, installed.stderr);
      assert.equal(JSON.parse(installed.stdout).ok, true, installed.stdout);
      assert.equal(await readlink(path.join(fixture.capsuleDir, 'current')), releaseDir);
      const html = await readFile(path.join(releaseDir, 'public/index.html'), 'utf8');
      assert.ok(html.includes(label)); assert.match(html, /Static fallback remains/);
      for (const file of publicFiles) {
        const expected = await readFile(path.join(bundle.staticFiles.publicDir, file));
        assert.deepEqual(await readFile(path.join(releaseDir, 'public', file)), expected);
        assert.doesNotMatch(expected.toString(), /(?:server|project)-env-prerender-must-not-ship/);
      }
      assert.equal(await readFile(path.join(releaseDir, "public/sitemap.xml"), "utf8"), sitemap);
      retained.push({releaseDir, html, releaseId, sitemap});
      for (const prior of retained) assert.equal(await readFile(path.join(prior.releaseDir, 'public/index.html'), 'utf8'), prior.html);
      const inspected = await runHostHelper({...request, action:'capsule.release.list'}, {cwd:dir, env:docker.env});
      assert.equal(inspected.code, 0, inspected.stderr);
      assert.equal(JSON.parse(inspected.stdout).ok, true, inspected.stdout);
      assert.ok(inspected.stdout.includes(releaseId));
    }
    const rollback = await runHostHelper({...request, action: "capsule.release.rollback", rollback: {releaseId: retained[0].releaseId}}, {cwd:dir, env:docker.env});
    assert.equal(rollback.code, 0, rollback.stderr);
    assert.equal(JSON.parse(rollback.stdout).ok, true, rollback.stdout);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), retained[0].releaseDir);
    assert.equal(await readFile(path.join(fixture.capsuleDir, "current/public/sitemap.xml"), "utf8"), retained[0].sitemap);
    assert.equal(await readFile(path.join(fixture.capsuleDir, "current/public/robots.txt"), "utf8"), "Sitemap: /sitemap.xml\n# release 0");
    assert.deepEqual(await readFile(path.join(fixture.capsuleDir, "current/public/favicon.ico")), Buffer.from([0, 0, 1, 0]));
  });
});


test("sporades host helper installs a release atomically and updates the current pointer", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".env.sporades.server",
    ]);
    const previousReleaseDir = path.join(capsuleDir, "releases", "20260629T120000Z-deadbeef");
    await mkdir(previousReleaseDir, { recursive: true });
    await symlink(previousReleaseDir, path.join(capsuleDir, "current"));
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        releases: { malformed: true },
      })}\n`,
    );

    const request = {
      action: "capsule.release.install",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: {
        subname: "team-notes",
      },
      release: {
        id: "20260630T221500Z-feedface",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteArchive: archivePath,
        restart: false,
        serverEnvIncluded: true,
        files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"],
        directories: {
          capsule: capsuleDir,
          releases: path.join(capsuleDir, "releases"),
          release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          data: path.join(capsuleDir, "data"),
        },
        currentLink: path.join(capsuleDir, "current"),
      },
    };

    const runningDocker = await installFakeDocker(path.join(dir, "running-docker"));
    const install = await runHostHelper(request, { cwd: dir, env: runningDocker.env });
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: true,
      data: {
        installed: true,
        restartRequested: false,
        restarted: false,
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
        },
        release: {
          id: "20260630T221500Z-feedface",
          directory: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          currentLink: path.join(capsuleDir, "current"),
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"],
          serverEnvIncluded: true,
        },
      },
      error: null,
    });

    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    const currentTarget = await readFile(path.join(capsuleDir, "current"), "utf8").catch(() => null);
    assert.equal(currentTarget, null);
    const symlinkTarget = await readlink(path.join(capsuleDir, "current"));
    assert.equal(symlinkTarget, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server", "index.ts"), "utf8"), {
      code: "ENOENT",
    });
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "uploaded");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].source.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.releases[0].source.serverEnvIncluded, true);
    await assert.rejects(readFile(runningDocker.logPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(record.releases[0].source.files, ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"]);
    assert.match(record.releases[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].uploadedAt, record.releases[0].createdAt);
  });
});


test("sporades host helper restores the exact previous sealed runtime after a new release start fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-start-failure", restart: true });
    const lifecycle = fixture.lifecycle;
    const oldRoute = [
      `team-notes.${fixture.domain} {`,
      "  reverse_proxy 127.0.0.1:49153",
      `  log { output file ${path.join(fixture.capsuleDir, "logs", "http.log")} }`,
      "}",
      "",
    ].join("\n");
    await writeFile(fixture.routeFile, oldRoute);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUN_STATUSES: "1,0", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154" },
    });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
      verification: { enabled: true, fallbackToPreviousRelease: true, healthTimeoutMs: 25 },
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.data.installed, false);
    assert.equal(output.data.rollback.applied, true);
    assert.equal(output.data.verified, false);
    assert.equal(output.data.verification.state, "failed");
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "install-rolled-back");
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    const restoredRoute = await readFile(fixture.routeFile, "utf8");
    assert.match(restoredRoute, /127\.0\.0\.1:49154/);
    assert.doesNotMatch(restoredRoute, /127\.0\.0\.1:49153/);
    assert.match(restoredRoute, /header_up x-sporades-client-address/);
    assert.match(restoredRoute, new RegExp(escapeRegExp(path.join(fixture.capsuleDir, "logs", "http.log"))));
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes("registry.example/next:2"));
    assert(runs[1].args.includes("registry.example/previous:1"));
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});


test("sporades host helper starts a no-restart release later with its staged private key and release image", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-later-start", restart: false });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const target = {
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    };

    const install = await runHostHelper({ action: "capsule.release.install", ...target, release: fixture.release }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(install.stdout).ok, true, install.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });

    const start = await runHostHelper({ action: "capsule.start", ...target }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
    const [run] = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert(run.args.includes(lifecycle.container.image));
    assert(!run.args.includes("registry.example/previous:1"));
    assert(run.args.includes(`${fixture.nextPrivateKeyPath}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), "previous private key bytes\n");
  });
});


test("sporades host helper keeps the fixed private-key mount for a markerless legacy release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-legacy-mount", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const start = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
    const [run] = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert(run.args.includes(lifecycle.container.image));
    assert(run.args.includes(`${fixture.privateKeyPath}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
  });
});


test("sporades host helper rejects sealed release start when the manifest fingerprint key is missing", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const currentReleaseId = "20260630T221500Z-feedface";
    const fingerprint = "0123456789abcdef";
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const releaseDir = path.join(capsuleDir, "releases", currentReleaseId);
    await mkdir(path.join(releaseDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(
      path.join(releaseDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: fingerprint, entries: {} })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "released",
        currentRelease: { id: currentReleaseId },
        sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
        releases: [
          {
            id: currentReleaseId,
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "uploaded",
            current: true,
            source: {
              hostedUrl: "https://team-notes.capsules.example.dev",
              files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: fingerprint },
            },
          },
        ],
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: { remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    const output = JSON.parse(start.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule Sealed Server env private key is missing.");
    assert.match(output.error.hint, /re-key/);
    assert.match(output.error.hint, /re-seal/);
    assert.deepEqual(output.error.diagnostics, {
      capsule: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      },
      sealedServerEnv: {
        expectedPublicKeyFingerprint: fingerprint,
        privateKeyPath: path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`),
        recovery: "re-key-and-re-seal-from-source-of-truth",
      },
    });
    assert.doesNotMatch(start.stdout, /PRIVATE KEY|host-owned private key|swordfish/);
    assert.equal((await docker.calls()).some((call) => call.args[0] === "run"), false);
  });
});


test("sporades host helper starts the current release in Docker and routes through a loopback-published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const telemetryDir = path.join(remoteRoot, "telemetry");
    await mkdir(telemetryDir, { recursive: true, mode: 0o700 });
    await chmod(telemetryDir, 0o700);
    await writeFile(path.join(telemetryDir, "connection.json"), JSON.stringify({ schemaVersion: 1, endpoint: "https://monitor.example:4318/", network: "sporades-hosted-capsules", internalEndpoint: "http://sporades-telemetry:4318/", caConfigured: false, inventoryHost: "capsules.example.dev", connectedAt: "2026-09-28T00:00:00.000Z", inventory: { generation: "00000000000000000000000000000001", credential: "test-host-inventory-token" } }), { mode: 0o600 });
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await writeFile(path.join(releaseDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    const dataDir = path.join(capsuleDir, "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, "uploads"), 0o755);
    await chmod(path.join(dataDir, "data.db"), 0o644);
    await chmod(path.join(dataDir, "uploads", "file.bin"), 0o644);
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
        baseImage: {
          updatePolicy: { mode: "manual" },
        },
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          currentLink: path.join(capsuleDir, "current"),
          directories: { capsule: capsuleDir, releases: path.join(capsuleDir, "releases"), data: path.join(capsuleDir, "data") },
          mounts: {
            files: [
              { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
              { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
              { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
              { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
              { host: path.join(capsuleDir, "current", ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
            ],
            data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
          },
          container: {
            name: "sporades-capsules-example-dev-team-notes",
            labels: {
              "com.sporades.managed": "true",
              "com.sporades.hosted-domain": "capsules.example.dev",
              "com.sporades.capsule-subname": "team-notes",
              "com.sporades.capsule-id": "capsules.example.dev/team-notes",
              "com.sporades.base-image.update-policy": "manual",
            },
          },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
            },
            unavailable: {
              hostname: "team-notes.capsules.example.dev",
              target: "hosted-capsule-unavailable",
              statusCode: 503,
              routeFile,
            },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(start.code, 0, start.stderr);
    const output = JSON.parse(start.stdout);
    assert.equal(output.ok, true, start.stdout);
    assert.equal(output.data.started, true);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.equal(output.data.container.publishedPort.hostIp, "127.0.0.1");
    assert.equal(output.data.container.publishedPort.hostPort, 49153);
    assert.deepEqual(output.data.restartPolicy, {
      mode: "bounded",
      maxAttempts: 3,
      backoffMs: 1000,
      dockerRestart: "on-failure:3",
      restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
      exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
      exhaustedRouteTarget: "hosted-capsule-unavailable",
      verificationFallbackOnly: true,
    });
    assert.equal(output.data.route.target, "loopback");
    assert.equal(output.data.route.upstream, "127.0.0.1:49153");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["stop", "rm", "image", "run", "inspect", "inspect", "inspect", "exec", "inspect", "inspect"]);
    assert.deepEqual(calls[2].args, ["image", "inspect", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"]);
    const runCall = calls.find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-capsules-example-dev-team-notes");
    assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-hosted-capsules");
    assert.equal(runCall.args[runCall.args.indexOf("--restart") + 1], "on-failure:3");
    assert(runCall.args.includes("--read-only"));
    assert.equal(runCall.args[runCall.args.indexOf("--tmpfs") + 1], "/tmp:rw,nosuid,nodev,noexec");
    assert.equal(runCall.args[runCall.args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(runCall.args[runCall.args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], "10001:10001");
    assert.equal(runCall.args[runCall.args.indexOf("--log-driver") + 1], "json-file");
    assert(runCall.args.includes("max-size=10m"));
    assert(runCall.args.includes("max-file=5"));
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert(runCall.args.includes("--label"));
    assert(runCall.args.includes("com.sporades.release-id=20260630T221500Z-feedface"));
    assert(runCall.args.includes("com.sporades.base-image.name=sporades-base"));
    assert(runCall.args.includes("com.sporades.base-image.version=0.3.0-node24-alpine"));
    assert(runCall.args.includes("com.sporades.base-image.update-policy=manual"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".env.sporades.server")}:/app/.env.sporades.server:ro`));
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(capsuleDir, "current", ".env.sporades.server"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "data")}:/app/data:rw`));
    assert(runCall.args.includes("SPORADES_LOG_STDOUT=1"));
    assert(runCall.args.includes("SPORADES_SECURITY_SESSION=hosted"));
    const hostedTelemetry = runCall.args.find((arg) => arg.startsWith("SPORADES_HOSTED_TELEMETRY_CONFIG="));
    assert.deepEqual(JSON.parse(hostedTelemetry.slice(hostedTelemetry.indexOf("=") + 1)), { endpoint: "http://sporades-telemetry:4318/", tls: { mode: "loopback" }, serviceName: "capsules.example.dev/team-notes", environment: "hosted" });
    assert(runCall.args.indexOf(hostedTelemetry) > runCall.args.indexOf("--env-file"), "Host-owned descriptor must override Capsule Server env");
    assert(runCall.args.includes("SPORADES_PUBLIC_ORIGIN=https://team-notes.capsules.example.dev"));
    assert(runCall.args.includes("SPORADES_RELEASE_ID=20260630T221500Z-feedface"));
    assert.deepEqual(runCall.args.slice(runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.3.0-node24-alpine")), [
      "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      "node",
      "/app/server.mjs",
    ]);
    const portInspectCall = calls.find((call) => call.args.join(" ").includes("NetworkSettings.Ports"));
    assert(portInspectCall, "expected Docker port inspection after container start");
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_size 10MiB/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /header x-sporades-host-probe [a-f0-9]{64}/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /reverse_proxy 127\.0\.0\.1:49153/);
    assert.match(routeContents, /header_up x-sporades-client-address \{http\.request\.remote\.host\}/);
    assert.match(routeContents, /request_header -x-sporades-client-address\n/);
    assert.match(routeContents, /request_header -x-sporades-client-address-token\n/);
    assert.match(routeContents, /header_up x-sporades-client-address-token [a-f0-9]{64}/);
    assert.doesNotMatch(routeContents, /CF-Connecting-IP|sporadesUntrustedCloudflareSource/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.runtimeProbe.header, "x-sporades-host-probe");
    assert.match(record.runtimeProbe.token, /^[a-f0-9]{64}$/);
    assert(runCall.args.includes(`SPORADES_RUNTIME_PROBE_TOKEN=${record.runtimeProbe.token}`));
    assert.doesNotMatch(start.stdout + start.stderr, new RegExp(record.runtimeProbe.token));
    assert.equal(JSON.stringify(output).includes(record.runtimeProbe.token), false);
    assert.equal(JSON.stringify(output).includes("SECRET_TOKEN"), false);
    const preparedDataDir = await stat(dataDir);
    const preparedUploadsDir = await stat(path.join(dataDir, "uploads"));
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    const preparedUpload = await stat(path.join(dataDir, "uploads", "file.bin"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedUploadsDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedUpload.mode & 0o777, 0o600);
    if (process.getuid?.() === 0) {
      assert.equal(preparedDataDir.uid, 10001);
      assert.equal(preparedDataDir.gid, 10001);
      assert.equal(preparedDatabase.uid, 10001);
      assert.equal(preparedDatabase.gid, 10001);
    }
    const inventoryOutbox = async () => JSON.parse(await readFile(path.join(telemetryDir, "inventory.json"), "utf8"));
    assert.equal((await inventoryOutbox()).desired.capsules[0].state, "running");
    const inventoryRevision = (await inventoryOutbox()).desired.revision;
    assert.doesNotMatch(JSON.stringify(await inventoryOutbox()), /swordfish|runtimeProbe|SECRET_TOKEN/);
    const disabled = await runHostHelper({ action: "host.telemetry.disable", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot }, capsule: { subname: "team-notes" } }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(disabled.stdout).ok, true, disabled.stdout);
    assert.equal(JSON.parse(disabled.stdout).data.coverage.state, "unverified", "the fixture does not prove the running runtime's Telemetry capability");
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).telemetry.disabled, true);
    assert.equal((await inventoryOutbox()).desired.capsules[0].state, "opted-out");
    assert.equal((await inventoryOutbox()).desired.revision, inventoryRevision + 1);
    const enabled = await runHostHelper({ action: "host.telemetry.enable", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot }, capsule: { subname: "team-notes" } }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(enabled.stdout).ok, true, enabled.stdout);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).telemetry.disabled, false);
    assert.equal((await inventoryOutbox()).desired.capsules[0].state, "running");
    assert.equal((await inventoryOutbox()).desired.revision, inventoryRevision + 2);
  });
});


test("Hosted Capsule fallback restart uses the recorded ClamAV readiness window for the selected release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "fallback-recorded-clamav", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.releases[0].source.inspection = { requiredInspectors: ["clamav"] };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const clock = path.join(dir, "stepping-monotonic-clock.mjs");
    await writeFile(clock, "let now = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => { const current = now; now += 20000; return current; } } });\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: { id: fixture.releaseId, inspection: null },
      lifecycle,
    }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } });

    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, 1);
  });
});


test("Hosted Capsule fallback restart ignores a failed candidate's ClamAV readiness window", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "fallback-recorded-ordinary", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const clock = path.join(dir, "stepping-monotonic-clock.mjs");
    await writeFile(clock, "let now = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => { const current = now; now += 20000; return current; } } });\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: { id: fixture.releaseId, inspection: { requiredInspectors: ["clamav"] } },
      lifecycle,
    }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, 0);
  });
});


test("Hosted Capsule start uses request inspection metadata only for its exact unrecorded release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "start-exact-request-inspection", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8")); record.releases = [];
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const clock = path.join(dir, "stepping-monotonic-clock.mjs");
    await writeFile(clock, "let now = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => { const current = now; now += 20000; return current; } } });\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const result = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: { id: fixture.previousReleaseId, inspection: { requiredInspectors: ["clamav"] } },
      lifecycle,
    }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } });

    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, 1);
  });
});


test("sporades host helper refreshes a stale loopback route after Docker restarts on a new published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
      },
    });

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], "a".repeat(64));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 },
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } },
        },
        error: null,
      }));
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(
        routeFile,
        [
          `team-notes.${domain} {`,
          "  @sporadesRuntimeProbe {",
          "    path /__sporades/health/runtime",
          `    header x-sporades-host-probe ${"a".repeat(64)}`,
          "  }",
          "  handle @sporadesRuntimeProbe {",
          "    reverse_proxy 127.0.0.1:49153 {",
          "      header_up x-sporades-client-address {http.request.remote.host}",
          "    }",
          "  }",
          "  reverse_proxy 127.0.0.1:49153 {",
          "    header_up x-sporades-client-address {http.request.remote.host}",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "a".repeat(64) },
        })}\n`,
      );

      const health = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(health.code, 0, health.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true);
      const route = await readFile(routeFile, "utf8");
      assert.equal((route.match(/reverse_proxy 127\.0\.0\.1:49154/g) ?? []).length, 2);
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      assert.match(route, new RegExp(`header x-sporades-host-probe ${"a".repeat(64)}`));
      assert.deepEqual(
        (await docker.caddyCalls()).map((call) => call.args),
        [
          ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
          ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ],
      );

      const repeatedHealth = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir, env: docker.env },
      );
      assert.equal(repeatedHealth.code, 0, repeatedHealth.stderr);
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, true);
      assert.equal((await docker.caddyCalls()).length, 2, "a current route must not reload Caddy on every health check");
    });
  });
});








test("sporades host helper preserves malformed-action validation without entering a route lock", async () => {
  await withTempDir(async (dir) => {
    const result = await runHostHelper({ action: "unsupported.review-proof" }, { cwd: dir });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Unsupported Host helper action.");
    assert.doesNotMatch(output.error.message, /lock/i);
  });
});


test("sporades host helper rejects a forged canonical route-lock marker without the retained OS lock descriptor", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const result = await runHostHelper(fixture.request, {
      cwd: dir,
      env: {
        ...fixture.docker.env,
        SPORADES_HOST_ROUTE_LOCK_FILE: `${fixture.routeFile}.lock`,
      },
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.error.message, "Hosted Capsule route lock identity was not retained by the action process.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});


test("sporades host helper rejects an unlocked matching descriptor forged for the canonical route lock", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const lockFile = `${fixture.routeFile}.lock`;
    const attacker = await startExecutable(
      path.join(repoRoot, "test", "support", "exec-flock.py"),
      ["--exclusive", "--timeout", "1", "--conflict-exit-code", "75", "--no-fork", lockFile, process.execPath, hostHelperPath],
      {
        cwd: dir,
        input: `${JSON.stringify(fixture.request)}\n`,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
          SPORADES_TEST_OPEN_WITHOUT_FLOCK: "1",
          SPORADES_HOST_ROUTE_LOCK_FILE: lockFile,
        },
      },
    ).result;
    const output = JSON.parse(attacker.stdout);
    assert.equal(output.ok, false, attacker.stdout);
    assert.equal(output.error.message, "Hosted Capsule route lock identity was not retained by the action process.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});


test("sporades host helper rejects symlink route entries and unsafe writable route ancestry", async () => {
  await withTempDir(async (dir) => {
    for (const finalEntry of ["route", "lock"]) {
      const caseRoot = path.join(dir, finalEntry);
      const remoteRoot = path.join(caseRoot, "remote-root");
      const domainDirectory = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev");
      const routeFile = path.join(domainDirectory, "team-notes.caddy");
      const outside = path.join(caseRoot, "outside.txt");
      await mkdir(domainDirectory, { recursive: true, mode: 0o755 });
      await writeFile(outside, "outside-preserved\n", { mode: 0o600 });
      await symlink(outside, finalEntry === "route" ? routeFile : `${routeFile}.lock`);
      const result = await runHostHelper({
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {},
      }, { cwd: caseRoot });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
      assert.equal(await readFile(outside, "utf8"), "outside-preserved\n");
    }

    const unsafeRoot = path.join(dir, "unsafe", "remote-root");
    const unsafeCaddy = path.join(unsafeRoot, "caddy");
    await mkdir(unsafeCaddy, { recursive: true, mode: 0o755 });
    await chmod(unsafeCaddy, 0o777);
    const unsafe = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: unsafeRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(unsafe.stdout).error.message, "Hosted Capsule route trust validation failed.", unsafe.stdout);

    const createdRoot = path.join(dir, "created", "remote-root");
    await mkdir(createdRoot, { recursive: true, mode: 0o700 });
    const created = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: createdRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(created.stdout).error.message, "Hosted Capsule is not registered.", created.stdout);
    for (const createdDirectory of [
      path.join(createdRoot, "bin"),
      path.join(createdRoot, "caddy"),
      path.join(createdRoot, "caddy", "hosts"),
      path.join(createdRoot, "caddy", "hosts", "capsules.example.dev"),
    ]) {
      assert.equal((await stat(createdDirectory)).mode & 0o022, 0, createdDirectory);
    }
  });
});





test("sporades host helper scavenges a dead pre-publication claim after SIGKILL", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const unrelatedFile = `${fixture.lockDir}.claim-not-a-protocol-token`;
    await writeFile(unrelatedFile, "unrelated\n");
    const orphanClaim = `${fixture.lockDir}.claim-${"e".repeat(32)}`;
    await writeFile(orphanClaim, `${JSON.stringify({ token: "e".repeat(32), pid: 999999, processIdentity: "dead", createdAt: 1 })}\n`);
    const holder = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const routeDir = path.dirname(fixture.routeFile);
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recovered = await runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.deepEqual(
      (await readdir(routeDir)).filter((entry) => new RegExp(`^${path.basename(fixture.lockDir)}\\.(?:claim|stale|reclaim)-[a-f0-9]{32}$`).test(entry)),
      [],
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated\n");
  });
});


test("Sporades runtime health rejects unauthenticated probes and returns safe readiness checks", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { files: { maxSizeBytes: 7_654_321 }, http: { maxBodyBytes: 1_234_567 } });
    const server = createServer(async (request, response) => {
      if (await routeRuntimeHealth(database, request, response)) {
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = server.address().port;
      const unauthenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`);
      assert.equal(unauthenticated.status, 404);
      assert.equal(await unauthenticated.text(), "Not found");

      database.runtimeProbeToken = "a".repeat(64);
      const forged = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "b".repeat(64) },
      });
      assert.equal(forged.status, 404);
      assert.equal(await forged.text(), "Not found");

      database.clamavRequired = true;
      const forgedWithRequiredInspection = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "b".repeat(64) },
      });
      assert.equal(forgedWithRequiredInspection.status, 404);
      assert.equal(await forgedWithRequiredInspection.text(), "Not found");

      const authenticatedWithRequiredInspection = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "a".repeat(64) },
      });
      assert.equal(authenticatedWithRequiredInspection.status, 503);
      assert.deepEqual(await authenticatedWithRequiredInspection.json(), {
        ok: false,
        data: {
          runtime: { ready: false, publicOrigin: "http://localhost:4000", fileMaxSizeBytes: 7_654_321, httpMaxBodyBytes: 1_234_567 },
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
            fileInspection: { ok: false },
          },
        },
        error: {
          message: "Sporades runtime is not ready.",
          hint: "Check Hosted Capsule logs and data volume permissions.",
        },
      });
      database.clamavRequired = false;

      const authenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "a".repeat(64) },
      });
      assert.equal(authenticated.status, 200);
      const body = await authenticated.json();
      assert.deepEqual(body, {
        ok: true,
        data: {
          runtime: { ready: true, publicOrigin: "http://localhost:4000", fileMaxSizeBytes: 7_654_321, httpMaxBodyBytes: 1_234_567 },
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
            fileInspection: { ok: true },
          },
        },
        error: null,
      });
      assert.deepEqual(Object.keys(body.data.runtime).sort(), ["fileMaxSizeBytes", "httpMaxBodyBytes", "publicOrigin", "ready"]);
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(dir), false);
      assert.equal(raw.includes("a".repeat(64)), false);
      assert.equal(raw.includes("SPORADES"), false);
    } finally {
      database.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});


test("Sporades runtime resolves the configured File size bound before exposing it", async () => {
  await withTempDir(async (dir) => {
    const valid = await openDevDatabase(path.join(dir, "valid.db"), "", {}, { files: { maxSizeBytes: 7_654_321 } });
    try {
      assert.equal(valid.fileMaxSizeBytes, 7_654_321);
    } finally {
      valid.close();
    }

    const defaulted = await openDevDatabase(path.join(dir, "default.db"), "", {}, {});
    try {
      assert.equal(defaulted.fileMaxSizeBytes, 10 * 1024 * 1024);
    } finally {
      defaulted.close();
    }

    for (const maxSizeBytes of [0, 1.5, "7654321", null]) {
      await assert.rejects(
        openDevDatabase(path.join(dir, `invalid-${String(maxSizeBytes)}.db`), "", {}, { files: { maxSizeBytes } }),
        { code: "INVALID_FILE_CONFIG" },
      );
    }
  });
});


test("sporades host helper keeps listing registry records when Docker lookup fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PS_STATUS: "1" } });

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsules[0].subname, "notes");
    assert.equal(output.data.capsules[0].docker, null);
    assert.deepEqual(output.data.capsules[0].baseImage, {
      name: "unknown",
      image: "unknown",
      version: "unknown",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
  });
});


test("sporades host helper reads Hosted Capsule stdout and stderr from Docker logs", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: {
        FAKE_DOCKER_LOGS_STDOUT: "stdout old\nstdout one\nstdout two\n",
        FAKE_DOCKER_LOGS_STDERR: "stderr old\nstderr one\nstderr two\n",
      },
    });

    const stdout = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stdout", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stdout",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stdout one", "stdout two"],
      },
      error: null,
    });

    const stderr = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stderr", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stderr",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stderr one", "stderr two"],
      },
      error: null,
    });

    assert.deepEqual((await docker.calls()).map((call) => call.args), [
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});


test("sporades host helper reloads Caddy after lifecycle route changes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"));
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const start = await runHostHelper({ ...request, action: "capsule.start" }, { cwd: dir, env });
    assert.equal(start.code, 0, start.stderr);
    const stop = await runHostHelper({ ...request, action: "capsule.stop" }, { cwd: dir, env });
    assert.equal(stop.code, 0, stop.stderr);

    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});


test("sporades host helper reloads the restored route after candidate reload failure", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    await chmod(routeFile, 0o600);
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,0" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to apply Hosted Capsule route.",
        hint: "Check the Host server Caddy configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.equal((await stat(routeFile)).mode & 0o777, 0o640, "the retained legacy route remains readable after failure");
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});


test("sporades host helper reports no release and failed starts with unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });
    const request = {
      action: "capsule.start",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const noRelease = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.deepEqual(JSON.parse(noRelease.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No Hosted Capsule release has been pushed.",
        hint: "Run `sporades host push --host personal --subname team-notes` before starting the Hosted Capsule.",
      },
    });

    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    await mkdir(releaseDir, { recursive: true });
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    await writeFile(registryRecordPath, JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", currentRelease: { id: path.basename(releaseDir) } }));
    const failedStart = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(failedStart.stdout).ok, false);
    assert.equal(JSON.parse(failedStart.stdout).error.message, "Hosted Capsule container did not stay running.");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].startAttempts.length, 1);
    assert.match(record.releases[0].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].failure.message, "Hosted Capsule container did not stay running.");
    assert.match(record.releases[0].failure.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});


test("sporades host helper rejects caller-controlled Docker lifecycle authority before invoking Docker", async () => {
  for (const [label, createLifecycle] of [
    ["current-link", () => ({ currentLink: "/" })],
    ["file-mount", () => ({ mounts: { files: [{ host: "/etc/passwd", container: "/app/server.mjs", mode: "ro" }] } })],
    ["sealed-key-host", (fixture) => {
      const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
      lifecycle.mounts.files.find((mount) => mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem").host = "/etc/passwd";
      return lifecycle;
    }],
    ["sealed-key-shape", (fixture) => {
      const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
      lifecycle.mounts.files.find((mount) => mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem").fingerprint = "0123456789abcdef";
      return lifecycle;
    }],
    ["data-mount", () => ({ mounts: { data: { host: "/", container: "/app/data", mode: "rw" } } })],
    ["root-user", () => ({ container: { user: "0:0" } })],
    ["attacker-image", () => ({ container: { image: "attacker.invalid/root:latest" } })],
    ["running-upstream", () => ({ routes: { running: { upstream: "127.0.0.1:4000" } } })],
    ["runtime-probe", () => ({ routes: { running: { runtimeProbe: { header: "x-sporades-host-probe", token: "caddy-injection" } } } })],
    ["tls-certificate", (fixture) => ({ routes: { running: { tls: { mode: "cloudflare-origin", certificate: "/tmp/outside.crt", key: "/tmp/outside.key" } } } })],
    ["unknown-route-field", () => ({ routes: { unavailable: { caddyDirective: "respond 200" } } })],
  ]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
      const docker = await installFakeDocker(path.join(dir, "docker"));
      const lifecycle = createLifecycle(fixture);
      const routeFile = path.join(fixture.remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
      const routeBefore = await readFile(routeFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      const registryBefore = await readFile(fixture.registryRecordPath);
      const result = await runHostHelper({
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle,
      }, { cwd: dir, env: docker.env });

      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false, `${label}: ${result.stdout}`);
      assert.equal(output.error.message, "Invalid Hosted Capsule lifecycle authority.", `${label}: ${result.stdout}`);
      await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(docker.caddyLogPath, "utf8"), { code: "ENOENT" });
      assert.deepEqual(await readFile(routeFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)), routeBefore);
      assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    });
  }
});


test("unconfigured Hosted Capsules start and restart beneath a root-owned sticky ancestor", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    // Model root-owned sticky metadata without requiring root.
    const preload = path.join(dir, "sticky-ancestor.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const lstat = fs.promises.lstat;
fs.promises.lstat = async function(file, ...args) {
  const details = await lstat.call(this, file, ...args);
  if (String(file) === ${JSON.stringify(dir)}) {
    details.uid = 0;
    details.mode = (details.mode & ~0o7777) | 0o1777;
  }
  return details;
}; syncBuiltinESMExports();`);
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const journal = path.join(fixture.capsuleDir, ".backup-restore.json");
    const bytes = await readFile(path.join(fixture.dataDir, "data.db"));
    for (const action of ["capsule.start", "capsule.restart"]) {
      await assert.rejects(lstat(journal), { code: "ENOENT" });
      const result = await runHostHelper({
        action,
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
      }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}` } });
      const output = JSON.parse(result.stdout);
      assert.equal(result.code, 0, `${action}: ${result.stdout}\n${result.stderr}`);
      assert.equal(output.ok, true, `${action}: ${result.stdout}`);
      assert.equal(output.data.release.id, fixture.currentReleaseId);
      assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      assert.deepEqual(await readFile(path.join(fixture.dataDir, "data.db")), bytes);
      await assert.rejects(lstat(journal), { code: "ENOENT" });
    }
    assert.equal((await docker.calls()).filter(call => call.args[0] === "run").length, 2);
  });
});


test("sporades host helper fails start when Docker does not report a usable loopback published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    await writeFile(registryRecordPath, JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", currentRelease: { id: path.basename(releaseDir) } }));
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PUBLISHED_PORT: "0.0.0.0:49153" } });

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    assert.deepEqual(JSON.parse(start.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Docker did not report a loopback published port for Hosted Capsule.",
        hint: "Ensure Docker published container port 4000 on 127.0.0.1, then retry `sporades host start team-notes --host personal`.",
      },
    });
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].failure.message, "Docker did not report a loopback published port for Hosted Capsule.");
    assert.match(record.runtimeProbe.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"],
        ["run", "--detach", "--name", "sporades-capsules-example-dev-team-notes", "--network", "sporades-hosted-capsules", "--restart", "on-failure:3", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=5", "--label", "com.sporades.managed=true", "--label", "com.sporades.hosted-domain=capsules.example.dev", "--label", "com.sporades.capsule-subname=team-notes", "--label", "com.sporades.capsule-id=capsules.example.dev/team-notes", "--label", "com.sporades.base-image.name=sporades-base", "--label", "com.sporades.base-image.version=0.3.0-node24-alpine", "--label", "com.sporades.base-image.update-policy=host-managed", "--label", "com.sporades.release-id=20260630T221500Z-feedface", "--volume", `${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`, "--volume", `${path.join(capsuleDir, "current", "public")}:/app/public:ro`, "--volume", `${path.join(capsuleDir, "current", "sporades.json")}:/app/sporades.json:ro`, "--volume", `${path.join(capsuleDir, "data")}:/app/data:rw`, "--workdir", "/app", "--env", "PORT=4000", "--env", "SPORADES_LOG_STDOUT=1", "--env", "SPORADES_SECURITY_SESSION=hosted",
        "--env",
        "SPORADES_ADMISSION_POLICY_PATH=", "--env", "SPORADES_CLAMAV_MANAGED=1", "--env", `SPORADES_RUNTIME_PROBE_TOKEN=${record.runtimeProbe.token}`, "--env", "SPORADES_PUBLIC_ORIGIN=https://team-notes.capsules.example.dev", "--env", "SPORADES_PUBLIC_ALIASES=[]", "--env", "SPORADES_RELEASE_ID=20260630T221500Z-feedface", "--env", "SPORADES_HOSTED_TELEMETRY_CONFIG=null", "--publish", "127.0.0.1::4000", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine", "node", "/app/server.mjs"],
        ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
        ["inspect", "-f", "{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostIp}}:{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostPort}}", "sporades-capsules-example-dev-team-notes"],
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
  });
});


test("sporades host helper refuses to install a release for an unregistered Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before pushing a release.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});


test("sporades host helper unregisters a Hosted Capsule without deleting release or data storage", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import capsules.example.dev/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "running",
          createdAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:30:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const before = Date.now();
    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.preserved.releases, releaseDir);
    assert.equal(output.data.preserved.data, dataDir);
    assert.equal(output.data.route.removed, true);
    assert.equal(output.data.container.removed, true);
    const deleteAfter = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfter >= before + 90 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfter <= after + 90 * 24 * 60 * 60 * 1000 + 1000);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.unregistered, true);
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);

    const duplicate = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);

    const stoppedDocker = await installFakeDocker(path.join(dir, "reactivate-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const reactivate = await runHostHelper(
      {
        action: "capsule.register",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: stoppedDocker.env },
    );
    assert.equal(reactivate.code, 0, reactivate.stderr);
    const reactivateOutput = JSON.parse(reactivate.stdout);
    assert.equal(reactivateOutput.ok, true);
    assert.equal(reactivateOutput.data.registered, true);
    assert.equal(reactivateOutput.data.reactivated, true);
    const reactivatedRecord = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(reactivatedRecord.status, "registered");
    assert.equal(reactivatedRecord.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(reactivatedRecord.deleteAfter, undefined);
    assert.equal(reactivatedRecord.unregisteredAt, undefined);
    assert.equal(reactivatedRecord.unregistered, undefined);
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});


test("sporades host helper deletes unregistered Hosted Capsule storage only", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const otherCapsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "other-notes");
    const otherDomainCapsuleDir = path.join(remoteRoot, "hosts", "other.example.dev", "capsules", "team-notes");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(otherCapsuleDir, { recursive: true });
    await mkdir(otherDomainCapsuleDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(path.join(otherCapsuleDir, "keep.txt"), "same domain, different Capsule\n");
    await writeFile(path.join(otherDomainCapsuleDir, "keep.txt"), "same subname, different domain\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  respond \"removed\" 410\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "unregistered",
          unregistered: true,
          unregisteredAt: "2026-07-01T12:00:00.000Z",
          deleteAfter: "2026-09-29T12:00:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.registryRecord.path, registryRecordPath);
    assert.equal(output.data.registryRecord.removed, true);
    assert.equal(output.data.directories.capsule.path, capsuleDir);
    assert.equal(output.data.directories.capsule.removed, true);
    assert.equal(output.data.directories.releases.path, path.join(capsuleDir, "releases"));
    assert.equal(output.data.directories.releases.removed, true);
    assert.equal(output.data.directories.data.path, dataDir);
    assert.equal(output.data.directories.data.removed, true);
    assert.equal(output.data.route.path, routeFile);
    assert.equal(output.data.route.removed, true);
    await assert.rejects(stat(registryRecordPath), { code: "ENOENT" });
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.equal(await readFile(path.join(otherCapsuleDir, "keep.txt"), "utf8"), "same domain, different Capsule\n");
    assert.equal(await readFile(path.join(otherDomainCapsuleDir, "keep.txt"), "utf8"), "same subname, different domain\n");
    await assert.rejects(stat(docker.logPath), { code: "ENOENT" });
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);
  });
});


test("sporades host helper restores the route when unregister tombstone write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    const originalRoute = "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n";
    await writeFile(routeFile, originalRoute);
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } });

    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Failed to write Hosted Capsule registry record.");
    assert.equal(await readFile(routeFile, "utf8"), originalRoute);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});


test("sporades host helper omits unregistered Capsules from list output", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "active.json"),
      `${JSON.stringify({
        subname: "active",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/active",
        hostedUrl: "https://active.capsules.example.dev",
        status: "registered",
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "old.json"),
      `${JSON.stringify({
        subname: "old",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/old",
        hostedUrl: "https://old.capsules.example.dev",
        status: "unregistered",
        unregistered: true,
        deleteAfter: "2026-09-29T12:00:00.000Z",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(
      output.data.capsules.map((capsule) => capsule.subname),
      ["active"],
    );
  });
});


test("sporades host helper starts SSH-enabled Hosted Capsules through the Base startup script", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await mkdir(path.join(runtimeDir, ".sporades", "ssh"), { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "ssh", "authorized_keys"), `${TEST_PUBLIC_KEY}\n`);
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/ssh/authorized_keys",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/ssh/authorized_keys"],
          ssh: {
            enabled: true,
            authorizedKeysPath: ".sporades/ssh/authorized_keys",
            keyCount: 1,
            fingerprints: ["SHA256:test"],
          },
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(Object.hasOwn(output.data.lifecycle, "ssh"), false);
    assert.deepEqual(
      output.data.lifecycle.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.access.enabled", "ssh.hosted-capsule.start", "completed"]],
    );
    assert.equal(output.data.lifecycle.auditEvents[0].data.surface, "sporades-host-helper/capsule.release.install");
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.enabled, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.running, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.loopbackOnly, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.keyCount, 1);
    assert.deepEqual(output.data.lifecycle.auditEvents[0].data.metadata.fingerprints, ["SHA256:test"]);
    assert.doesNotMatch(JSON.stringify(output.data.lifecycle.auditEvents), /authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);

    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], "10001:10001");
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".sporades", "ssh", "authorized_keys")}:/run/sporades/ssh/authorized_keys:ro`));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys"));
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.3.0-node24-alpine");
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      "/usr/local/bin/sporades-start",
    ]);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.releases[0].source.ssh.enabled, true);
    assert.equal(record.releases[0].source.ssh.keyCount, 1);

    const restart = await runHostHelper(
      {
        action: "capsule.restart",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(restart.code, 0, restart.stderr);
    const restartOutput = JSON.parse(restart.stdout);
    assert.deepEqual(
      restartOutput.data.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.access.enabled", "ssh.hosted-capsule.restart", "completed"]],
    );
    assert.equal(restartOutput.data.auditEvents[0].data.surface, "sporades-host-helper/capsule.restart");
  });
});


test("ClamAV-declaring release verification allows a cold scanner to exceed the legacy ten-second window", async () => {
  await withTempDir(async (dir) => {
    const startedAt = Date.now();
    await withHttpServer((request, response) => {
      if (request.url === "/" && Date.now() - startedAt < 10_100) {
        response.writeHead(502, { "content-type": "text/plain" }); response.end("scanner starting"); return;
      }
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" }); response.end("<main>ready</main>"); return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: true } } }, error: null }));
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "verify-cold-clamav", domain: `localhost:${port}`, scheme: "http" });
      fixture.release.inspection = { requiredInspectors: ["clamav"] };
      const docker = await installFakeDocker(path.join(dir, "verify-cold-clamav-docker"));
      const install = await runHostHelper({ action: "capsule.release.install", host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, release: fixture.release, lifecycle: fixture.lifecycle, verification: { enabled: true } }, { cwd: dir, env: docker.env });
      assert.equal(install.code, 0, install.stderr);
      assert.equal(JSON.parse(install.stdout).data.verified, true);
      assert.ok(Date.now() - startedAt >= 10_000);
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      assert.deepEqual(record.releases.find((entry) => entry.id === fixture.release.id).source.inspection, { requiredInspectors: ["clamav"] });
    });
  });
});


test("sporades host helper marks verified push failed when runtime health checks fail", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        assert.equal(request.headers["x-sporades-host-probe"], undefined);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<div>installed public tree</div>");
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          data: {
            runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 },
            checks: {
              sqlite: { ok: false },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verify-runtime-failure",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verify-runtime-failure-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: { enabled: true },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 1, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(install.stdout.includes(probeToken), false);
      assert.equal(output.ok, false);
      assert.equal(output.data.verification.health.failure, "sqlite-failure");
      assert.equal(output.data.verification.health.runtime.checks.sqlite.ok, false);
      assert.equal(output.data.rollbackGuidance.previousReleaseId, fixture.previousReleaseId);
      assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
      assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "failed");
      assert.equal(release.state, "failed");
      assert.equal(release.failure.message, "Hosted Capsule SQLite health check failed.");
      assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule SQLite health check failed.");
    });
  });
});


test("sporades host helper rollback after key rotation uses the retained release manifest fingerprint key", async () => {
  await withTempDir(async (dir) => {
    const currentFingerprint = "fedcba9876543210";
    const rollbackFingerprint = "0123456789abcdef";
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      currentRegistryFingerprint: currentFingerprint,
      sealedReleaseFingerprints: {
        "20260630T221500Z-feedface": currentFingerprint,
        "20260629T120000Z-deadbeef": rollbackFingerprint,
      },
    });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.ok(runCall);
    assert.ok(
      runCall.args.includes(
        `${path.join(fixture.dataDir, "sealed-server-env", "keys", `${rollbackFingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`,
      ),
    );
    assert.ok(
      !runCall.args.includes(
        `${path.join(fixture.dataDir, "sealed-server-env", "keys", `${currentFingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`,
      ),
    );
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, currentFingerprint);
    assert.equal(record.releases.find((release) => release.id === fixture.rollbackReleaseId).source.sealedServerEnv.publicKeyFingerprint, rollbackFingerprint);
  });
});


test("sporades host helper rejects rollback for unregistered Capsules and empty release history", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { noReleaseHistory: true, currentReleaseId: null, releaseIds: [] });
    const missing = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "missing" },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register missing --host personal` before managing the Hosted Capsule lifecycle.",
      },
    });

    const noHistory = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(noHistory.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no release history.",
        hint: "Push a release before running `sporades host rollback team-notes <release-id> --host personal`.",
      },
    });
  });
});


test("sporades host register relies on the Host server for domain-scoped uniqueness", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(stdin);
const statePath = process.env.FAKE_REGISTER_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const key = request.host.domain + "/" + request.capsule.subname;
if (state[key]) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: {
      message: "Hosted Capsule subname is already registered for this Hosted domain.",
      hint: "Choose a different Capsule subname for " + request.host.domain + "."
    }
  }) + "\\n");
  process.exit(0);
}
state[key] = true;
writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId
    },
    route: request.registration.route
  },
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
    const env = { ...hostEnv(configDir), ...fakeSsh.env, FAKE_REGISTER_STATE: path.join(dir, "register-state.json") };

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(
          ["host", "add", "work", "--server", "root@example.test", "--domain", "apps.work.test", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );

    const first = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(first.code, 0, first.stderr);

    const duplicate = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(duplicate.code, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

    const sameSubnameDifferentDomain = await runCli(["host", "register", "notes", "--host", "work", "--json"], { cwd: projectDir, env });
    assert.equal(sameSubnameDifferentDomain.code, 0, sameSubnameDifferentDomain.stderr);
    assert.equal(JSON.parse(sameSubnameDifferentDomain.stdout).data.binding.remoteCapsuleId, "apps.work.test/notes");
  });
});


test("sporades host delete invokes the Hosted Capsule delete helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.delete") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.delete." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    deleted: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.delete.hostedUrl,
      remoteCapsuleId: request.delete.remoteCapsuleId
    },
    registryRecord: {
      path: request.delete.registryRecord,
      removed: true,
      alreadyAbsent: false
    },
    directories: {
      capsule: { path: request.delete.directories.capsule, removed: true, alreadyAbsent: false },
      releases: { path: request.delete.directories.releases, removed: true, alreadyAbsent: false },
      data: { path: request.delete.directories.data, removed: true, alreadyAbsent: false }
    },
    route: {
      path: request.delete.routes.removed.routeFile,
      removed: true,
      alreadyAbsent: false
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const deleted = await runCli(["host", "delete", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");

    const plain = await runCli(["host", "delete", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule storage deleted: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.delete",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      delete: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
        },
        routes: {
          removed: {
            hostname: "team-notes.capsules.example.dev",
            target: "removed",
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          },
        },
      },
    });
  });
});


test("sporades host list works from outside a project and reports an empty registry", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: []
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const list = await runCli(["host", "list", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        capsules: [],
      },
      error: null,
    });

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "No Hosted Capsules registered for capsules.example.dev.\n");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});


test("sporades host ssh uses the local remote binding and reports helper SSH inspection JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.ssh") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.ssh." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://" + request.capsule.subname + "." + request.host.domain,
      remoteCapsuleId: request.host.domain + "/" + request.capsule.subname
    },
    enabled: true,
    running: true,
    user: "sporades",
    host: "127.0.0.1",
    port: 49162,
    targetPort: 22,
    keyCount: 1,
    fingerprints: ["SHA256:test"],
    reason: null
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const createResult = await runCli(["create", "ssh-bound-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "ssh-bound-island");
    await installFakeReact(projectDir);

    const env = { ...hostEnv(configDir), ...fakeSsh.env };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const ssh = await runCli(["host", "ssh", "--json"], { cwd: projectDir, env });
    assert.equal(ssh.code, 0, ssh.stderr);
    const output = JSON.parse(ssh.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.enabled, true);
    assert.equal(output.data.running, true);
    assert.equal(output.data.user, "sporades");
    assert.equal(output.data.host, "127.0.0.1");
    assert.equal(output.data.port, 49162);
    assert.equal(output.data.targetPort, 22);
    assert.equal(output.data.keyCount, 1);
    assert.deepEqual(output.data.fingerprints, ["SHA256:test"]);
    assert.equal(output.data.reason, null);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.ssh",
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
  });
});


test("sporades host stats without a subname resolves the selected Host profile and returns Host server stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.stats" || request.capsule !== null) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.stats without a Capsule." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    resources: {
      disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
      memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
      load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 }
    },
    services: { docker: { available: true }, caddy: { available: true } },
    capsules: { total: 2, registered: 1, running: 1, stopped: 0 }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        resources: {
          disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
          memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
          load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 },
        },
        services: { docker: { available: true }, caddy: { available: true } },
        capsules: { total: 2, registered: 1, running: 1, stopped: 0 },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});


test("sporades host stats handles SSH failure and remote helper failure as structured JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
        { cwd: dir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
    };

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    await addHost(transportFailureSsh.env);
    const transportFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
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

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Failed to read Hosted Capsule Docker stats.",
    hint: "Check Docker on the Host server and retry \`sporades host stats team-notes --host personal\`."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});


test("sporades host logs prints only recent HTTP log lines in plain output", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    entries: [
      "198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] \\"GET /one HTTP/1.1\\" 200 10",
      "198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] \\"GET /two HTTP/1.1\\" 404 0"
    ]
  },
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
      ["host", "add", "work", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const logs = await runCli(["host", "logs", "http", "--host", "work", "-n", "2"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.equal(
      logs.stdout,
      '198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] "GET /one HTTP/1.1" 200 10\n198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] "GET /two HTTP/1.1" 404 0\n',
    );

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.lines, 2);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
  });
});


test("sporades host logs requests capsule stdout and stderr using a Hosted Capsule binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    source: request.logs.source,
    container: "sporades-capsules-example-dev-team-notes",
    entries: [request.logs.source + " one", request.capsule.subname]
  },
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
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(bind.code, 0, bind.stderr);

    const stdout = await runCli(["host", "logs", "stdout", "-n", "7", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout).data, {
      lineCount: 7,
      source: "stdout",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stdout one", "team-notes"],
    });

    const stderr = await runCli(["host", "logs", "stderr", "--host", "personal", "--subname", "team-notes", "--lines", "3", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout).data, {
      lineCount: 3,
      source: "stderr",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stderr one", "team-notes"],
    });

    const calls = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(calls[0].stdin).logs.source, "stdout");
    assert.equal(JSON.parse(calls[0].stdin).capsule.subname, "team-notes");
    assert.equal(JSON.parse(calls[1].stdin).logs.source, "stderr");
    assert.equal(JSON.parse(calls[1].stdin).capsule.subname, "team-notes");
  });
});


test("sporades host logs validates invalid line counts without calling SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "logs", "--lines", "0", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host log line count.",
        hint: "Pass `--lines <n>` with a whole number between 1 and 10000.",
      },
    });
    await fakeSsh.assertNotCalled();
  });
});


test("sporades host github workflow write dry-runs an inspectable autodeploy workflow", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.file, ".github/workflows/sporades-autodeploy.yml");
    assert.equal(output.data.written, false);
    assert.match(output.data.workflow, /branches: \["main"\]/);
    assert.match(output.data.workflow, /node-version: 22/);
    assert.match(output.data.workflow, /npm ci/);
    assert.match(output.data.workflow, /npm install/);
    assert.match(output.data.workflow, /npm test/);
    assert.match(output.data.workflow, /SPORADES_HOST_ALIAS: personal/);
    assert.match(output.data.workflow, /SPORADES_HOST_SUBNAME: team-notes/);
    assert.match(output.data.workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.match(output.data.workflow, /vars\.SPORADES_HOST_SERVER/);
    assert.match(output.data.workflow, /npx sporades host current --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host health --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host push --host "\$SPORADES_HOST_ALIAS" --subname "\$SPORADES_HOST_SUBNAME" --verify --json/);
    assert.deepEqual(output.data.github.secrets, ["SPORADES_HOST_SSH_PRIVATE_KEY"]);
    assert.deepEqual(output.data.github.variables, [
      "SPORADES_HOST_SERVER",
      "SPORADES_HOST_DOMAIN",
      "SPORADES_HOST_REMOTE_ROOT",
    ]);
    await assert.rejects(readFile(path.join(dir, ".github", "workflows", "sporades-autodeploy.yml"), "utf8"), { code: "ENOENT" });
  });
});


test("sporades host github workflow reports successful deploys to GitHub summaries", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY: \$\{\{ runner\.temp \}\}\/sporades-autodeploy-summary\.md/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /Hosted Capsule/);
    assert.match(workflow, /Release ID/);
    assert.match(workflow, /Verification/);
    assert.match(workflow, /data\.capsule\?\.hostedUrl/);
    assert.match(workflow, /data\.release\?\.id/);
    assert.match(workflow, /verification\?\.state/);
  });
});


test("sporades host github workflow reports command failures without exposing sensitive values", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Command failed/);
    assert.match(workflow, /No structured Sporades deploy output was available/);
    assert.match(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.doesNotMatch(workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*>>/);
    assert.doesNotMatch(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*GITHUB_STEP_SUMMARY/);
    assert.doesNotMatch(workflow, /session token/i);
    assert.doesNotMatch(workflow, /Server env values/);
  });
});


test("sporades host github workflow associates branch push deploy results with the workflow run summary", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "release/stable", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /push:\n    branches: \["release\/stable"\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /fs\.appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /fs\.writeFileSync\(process\.env\.SPORADES_AUTODEPLOY_SUMMARY/);
  });
});


test("host profile implementation does not hard-code the first Hosted domain", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /mattgscox\.co\.uk/);
});


test("custom domains register apex and app aliases, survive lifecycle and release on unregister", async () => {
  await withTempDir(async (dir) => {
    const { request, invoke, docker } = await customDomainFixture(dir);
    const registered = await invoke();
    assert.equal(JSON.parse(registered.stdout).ok, true, registered.stdout + registered.stderr);
    const data = JSON.parse(registered.stdout).data;
    assert.deepEqual(data.capsule.aliasDomains, ["fourteen.example", "app.fourteen.example"]);
    assert.deepEqual(data.capsule.aliasUrls, ["https://fourteen.example", "https://app.fourteen.example"]);
    assert.equal(data.capsule.remoteCapsuleId, "capsules.example.dev/team-notes");
    const routeFile = data.route.routeFile;
    const unavailable = await readFile(routeFile, "utf8");
    for (const hostname of ["team-notes.capsules.example.dev", "fourteen.example", "app.fourteen.example"]) {
      assert.ok(unavailable.includes(`${hostname} {\n`), unavailable);
    }
    assert.equal((unavailable.match(/Hosted Capsule unavailable/g) ?? []).length, 3);
    const list = await invoke({ ...request, action: "capsule.list", registration: undefined });
    assert.equal(JSON.parse(list.stdout).ok, true, list.stdout + list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).data.capsules[0].aliasDomains, request.registration.aliasDomains);
    const forged = await invoke({ ...request, action: "capsule.stop", registration: undefined,
      lifecycle: { routes: { unavailable: { aliasDomains: ["evil.example"] } } },
    });
    assert.equal(JSON.parse(forged.stdout).ok, false, forged.stdout);
    assert.equal(await readFile(routeFile, "utf8"), unavailable);
    const stopped = await invoke({ ...request, action: "capsule.stop", registration: undefined });
    assert.equal(JSON.parse(stopped.stdout).ok, true, stopped.stdout + stopped.stderr);
    assert.equal(await readFile(routeFile, "utf8"), unavailable);

    // Give this registered Capsule two immutable releases using the existing lifecycle fixture.
    const originalRecord = JSON.parse(await readFile(data.registryRecord, "utf8"));
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const releaseRecord = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    await writeFile(data.registryRecord, JSON.stringify({ ...releaseRecord, aliasDomains: originalRecord.aliasDomains }));
    for (const action of ["capsule.start", "capsule.restart", "capsule.release.rollback"]) {
      const result = await invoke({ ...request, action, registration: undefined,
        ...(action === "capsule.release.rollback" ? { rollback: { releaseId: fixture.rollbackReleaseId } } : {}),
      });
      assert.equal(JSON.parse(result.stdout).ok, true, result.stdout + result.stderr);
      const contents = await readFile(routeFile, "utf8");
      assert.equal((contents.match(/reverse_proxy 127\.0\.0\.1:/g) ?? []).length >= 3, true, contents);
      assert.ok(contents.includes("fourteen.example {\n"), contents);
      assert.ok(contents.includes("app.fourteen.example {\n"), contents);
    }
    const calls = await docker.calls();
    assert.ok(calls.some(({ args }) => args.includes('SPORADES_PUBLIC_ALIASES=["https://fourteen.example","https://app.fourteen.example"]')));
    const removed = await invoke({ ...request, action: "capsule.unregister", registration: undefined });
    assert.equal(JSON.parse(removed.stdout).ok, true, removed.stdout + removed.stderr);
    await assert.rejects(readFile(routeFile), { code: "ENOENT" });
    const reactivated = await invoke({ ...request, registration: undefined });
    assert.equal(JSON.parse(reactivated.stdout).ok, true, reactivated.stdout + reactivated.stderr);
    assert.deepEqual(JSON.parse(reactivated.stdout).data.capsule.aliasDomains, request.registration.aliasDomains);
    assert.equal(JSON.parse((await invoke({ ...request, action: "capsule.unregister", registration: undefined })).stdout).ok, true);
    const cleared = await invoke({ ...request, registration: { aliasDomains: [] } });
    assert.equal(JSON.parse(cleared.stdout).ok, true, cleared.stdout);
    assert.deepEqual(JSON.parse(cleared.stdout).data.capsule.aliasDomains, []);
    assert.doesNotMatch(await readFile(routeFile, "utf8"), /fourteen.example/);
  });
});


test("custom domains roll back failed registration and keep automatic TLS separate from origin certificates", async () => {
  await withTempDir(async (dir) => {
    const { remoteRoot, request, invoke } = await customDomainFixture(dir);
    const failed = await invoke(request, { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" });
    assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
    const routeFile = path.join(remoteRoot, "caddy", "hosts", request.host.domain, "team-notes.caddy");
    await assert.rejects(readFile(routeFile), { code: "ENOENT" });
    const registered = await invoke({ ...request, registration: { ...request.registration, bootstrap: { tls: { mode: "cloudflare-origin" } } } });
    assert.equal(JSON.parse(registered.stdout).ok, true, registered.stdout + registered.stderr);
    const contents = await readFile(routeFile, "utf8");
    assert.equal((contents.match(/tls .*origin.crt/g) ?? []).length, 1, contents);
    assert.ok(contents.includes("fourteen.example {\n"));
    assert.doesNotMatch(contents.slice(contents.indexOf("\nfourteen.example {")), /origin.crt/);
  });
});


test("custom domains allow same-origin HTTP and WebSockets while rejecting unregistered origins", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(dir, { __sporadesPublicAliases: ["https://fourteen.example"] }, async (baseUrl, token) => {
      const headers = { origin: "https://fourteen.example", "x-forwarded-host": "fourteen.example", "x-forwarded-proto": "https" };
      const response = await fetch(baseUrl, { headers });
      assert.equal(response.headers.get("access-control-allow-origin"), "https://fourteen.example");
      assert.match(await openRawWebSocketHandshake(baseUrl, headers, token()), /^HTTP\/1\.1 101/m);
      for (const rejected of [
        { ...headers, origin: "https://evil.example", "x-forwarded-host": "evil.example" },
        { ...headers, "x-forwarded-host": "unrelated.example" },
      ]) {
        assert.equal((await fetch(baseUrl, { headers: rejected })).headers.get("access-control-allow-origin"), null);
        assert.doesNotMatch(await openRawWebSocketHandshake(baseUrl, rejected, token()), /^HTTP\/1\.1 101/m);
      }
    });
  });
});


test("custom domains retain ownership when registration and route rollback both fail", async () => {
  await withTempDir(async (dir) => {
    const { remoteRoot, request, invoke } = await customDomainFixture(dir, ["capsules.example.dev", "other.example.dev"]);
    const failed = await invoke(request, {
      SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1",
      FAKE_DOCKER_CADDY_RELOAD_STATUSES: "0,1,0",
    });
    const error = JSON.parse(failed.stdout).error;
    assert.equal(error.message, "Hosted Capsule registration recovery failed.");
    assert.match(error.hint, /Registration: Failed to write Hosted Capsule registry record/);
    assert.match(error.hint, /Route rollback: Failed to remove Hosted Capsule route/);
    const registry = path.join(remoteRoot, "hosts", request.host.domain, "registry");
    await assert.rejects(readFile(path.join(registry, "capsules", "team-notes.json")), { code: "ENOENT" });
    const claimPath = path.join(registry, "registration-claims", "team-notes.json");
    assert.deepEqual(JSON.parse(await readFile(claimPath, "utf8")).aliasDomains, request.registration.aliasDomains);
    for (const action of ["capsule.unregister", "capsule.delete"]) {
      const denied = JSON.parse((await invoke({ ...request, action })).stdout);
      assert.match(denied.error.message, /registration recovery is required before teardown/);
      assert.deepEqual(JSON.parse(await readFile(claimPath, "utf8")).aliasDomains, request.registration.aliasDomains);
    }
    // A separate helper process sees the durable reservation even without a Capsule record.
    const competitor = { ...request, host: { ...request.host, domain: "other.example.dev" }, capsule: { subname: "competitor" } };
    assert.equal(JSON.parse((await invoke(competitor)).stdout).error.message, "Hosted Capsule hostname is already reserved.");
    // Another failed retry must not discard the original orphan-route claim.
    const retriedFailure = await invoke(request, { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" });
    assert.equal(JSON.parse(retriedFailure.stdout).ok, false);
    assert.equal(JSON.parse((await invoke(competitor)).stdout).error.message, "Hosted Capsule hostname is already reserved.");
    const changedAliases = await invoke({ ...request, registration: { aliasDomains: ["replacement.example"] } });
    assert.equal(JSON.parse(changedAliases.stdout).error.message, "Hosted Capsule registration recovery is required.");
    const repaired = await invoke({ ...request, registration: undefined });
    assert.equal(JSON.parse(repaired.stdout).ok, true, repaired.stdout);
    assert.deepEqual(JSON.parse(repaired.stdout).data.capsule.aliasDomains, request.registration.aliasDomains);
    await assert.rejects(readFile(claimPath), { code: "ENOENT" });
  });
});


test("custom domains always settle a quiesced runtime after registration rollback failure", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const { remoteRoot, request, invoke, docker } = await customDomainFixture(dir, ["capsules.example.dev", "other.example.dev"]);
    const existing = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    await writeFile(fixture.registryRecordPath, JSON.stringify({ ...existing, status: "unregistered", aliasDomains: ["old.example"] }));
    const failed = await invoke(request, {
      SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1",
      FAKE_DOCKER_CADDY_RELOAD_STATUSES: "0,1,1",
    });
    const error = JSON.parse(failed.stdout).error;
    assert.equal(error.message, "Hosted Capsule registration recovery failed.");
    assert.match(error.hint, /Registration: Failed to write Hosted Capsule registry record/);
    assert.match(error.hint, /Route rollback:/);
    assert.match(error.hint, /Runtime settlement: Hosted Capsule runtime restoration failed/);
    assert.ok((await docker.calls()).some(({ args }) => args[0] === "stop"));
    const claimPath = path.join(remoteRoot, "hosts", request.host.domain, "registry", "registration-claims", "team-notes.json");
    assert.deepEqual(JSON.parse(await readFile(claimPath, "utf8")).previousAliasDomains, ["old.example"]);
    for (const hostname of ["old.example", "fourteen.example"]) {
      const competitor = await invoke({ ...request, host: { ...request.host, domain: "other.example.dev" }, capsule: { subname: "competitor" }, registration: { aliasDomains: [hostname] } });
      assert.equal(JSON.parse(competitor.stdout).error.message, "Hosted Capsule hostname is already reserved.");
    }
    const repaired = await invoke();
    assert.equal(JSON.parse(repaired.stdout).ok, true, repaired.stdout);
    await assert.rejects(readFile(claimPath), { code: "ENOENT" });
  });
});



test("custom domains preserve committed registration when registry lock cleanup fails", async () => {
  for (const reactivate of [false, true]) {
    await withTempDir(async (dir) => {
      const { remoteRoot, request, invoke: invokeHelper } = await customDomainFixture(dir);
      const invoke = (input = request, env = {}) => invokeHelper(input, { FAKE_DOCKER_RUNNING: "false", ...env });
      if (reactivate) {
        assert.equal(JSON.parse((await invoke()).stdout).ok, true);
        assert.equal(JSON.parse((await invoke({ ...request, action: "capsule.unregister" })).stdout).ok, true);
      }
      const hook = path.join(dir, "fail-lock-cleanup.mjs");
      await writeFile(hook, `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const original = fs.rm;
fs.rm = async (target, ...args) => {
  if (String(target).endsWith("/registry/.lock")) throw new Error("Injected registry lock cleanup failure");
  return original(target, ...args);
};
syncBuiltinESMExports();
`);
      const failed = JSON.parse((await invoke(request, { NODE_OPTIONS: "--import=" + hook })).stdout);
      assert.equal(failed.ok, false);
      assert.match(failed.error.hint, /Registration committed.*Registry lock cleanup: Injected registry lock cleanup failure/);
      const registry = path.join(remoteRoot, "hosts", request.host.domain, "registry");
      const record = JSON.parse(await readFile(path.join(registry, "capsules", "team-notes.json"), "utf8"));
      assert.notEqual(record.status, "unregistered");
      assert.deepEqual(record.aliasDomains, request.registration.aliasDomains);
      const route = path.join(remoteRoot, "caddy", "hosts", request.host.domain, "team-notes.caddy");
      assert.match(await readFile(route, "utf8"), /fourteen\.example/);
      const claim = path.join(registry, "registration-claims", "team-notes.json");
      assert.deepEqual(JSON.parse(await readFile(claim, "utf8")).aliasDomains, request.registration.aliasDomains);
      // Simulate operator repair of the failed lock cleanup before retrying.
      await rm(path.join(registry, ".lock"), { recursive: true });
      for (const action of ["capsule.unregister", "capsule.delete"]) {
        const denied = JSON.parse((await invoke({ ...request, action })).stdout);
        assert.equal(denied.ok, false);
        assert.match(denied.error.message, /registration recovery is required before teardown/);
        assert.deepEqual(JSON.parse(await readFile(claim, "utf8")).aliasDomains, request.registration.aliasDomains);
        assert.match(await readFile(route, "utf8"), /fourteen\.example/);
      }
      const repaired = JSON.parse((await invoke()).stdout);
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      await assert.rejects(readFile(claim), { code: "ENOENT" });
      assert.match(await readFile(route, "utf8"), /fourteen\.example/);
      assert.equal(JSON.parse((await invoke({ ...request, action: "capsule.unregister" })).stdout).ok, true);
      assert.equal(JSON.parse((await invoke({ ...request, action: "capsule.delete" })).stdout).ok, true);
      assert.equal(JSON.parse((await invoke({ ...request, capsule: { subname: "new-owner" } })).stdout).ok, true);
    });
  }
});



test("Hosted deploy.files restores the pointer and release when seed cleanup fails", async () => {
  for (const failure of ["registry", "startup", "verified-startup"]) await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "cleanup-failure", previousReleaseId: null,
      deployFiles: [{ path: "new.json", update: "preserve" }] });
    fixture.release.restart = failure !== "registry";
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "registered";
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const docker = await installFakeDocker(path.join(dir, "cleanup-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const preload = path.join(dir, "fail-cleanup.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
let settlement = false; const write = fs.promises.writeFile; const stat = fs.promises.lstat;
fs.promises.writeFile = async function(file, ...args) {
  const result = await write.call(this, file, ...args);
  if (String(file).includes('/registry/capsules/') && String(file).includes('.tmp-')) settlement = true;
  return result;
};
fs.promises.lstat = async function(file, ...args) {
  if (settlement && String(file) === ${JSON.stringify(preservedDeployFilePath(path.join(fixture.capsuleDir, 'preserved-files'), 'new.json'))}) throw Object.assign(new Error('injected cleanup denial'), { code: 'EACCES' });
  return stat.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const registry = await readFile(fixture.registryRecordPath);
    const result = await runHostHelper({ action: "capsule.release.install", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, release: fixture.release, ...(failure === "verified-startup" ? { verification: { enabled: true } } : {}) },
      { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}`, ...(failure === "registry" ? { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } : {}) } });
    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    const output = JSON.parse(result.stdout);
    if (failure === "registry") assert.match(output.error.message, /cleanup is incomplete/);
    else {
      assert.equal(output.data.installed, false, result.stdout);
      assert.equal(output.data.rollback.applied, true);
      assert.equal(output.data.cleanup.complete, false);
      assert.equal(output.data.cleanup.reason, "preserved-seed-cleanup-failed");
      if (failure === "verified-startup") assert.equal(output.data.fallback.reason, "install-rolled-back");
    }
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "current")), { code: "ENOENT" });
    await assert.rejects(lstat(fixture.release.directories.release), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registry);
  });
});



test("Hosted deploy.files retains candidate seeds when pointer restoration fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "pointer-failure", previousReleaseId: null,
      deployFiles: [{ path: "new.json", update: "preserve" }], fileContents: "retained candidate" });
    fixture.release.restart = false;
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "registered";
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const preload = path.join(dir, "fail-pointer.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.rm;
fs.promises.rm = async function(file, ...args) {
  if (String(file).endsWith('/current')) throw Object.assign(new Error('injected pointer restoration denial'), { code: 'EACCES' });
  return original.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const result = await runHostHelper({ action: "capsule.release.install", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, release: fixture.release },
      { cwd: dir, env: { NODE_OPTIONS: `--import=${preload}`, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1", SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), fixture.release.directories.release);
    assert.equal(await readFile(preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "new.json"), "utf8"), "retained candidate");
    await stat(fixture.release.directories.release);
    await stat(path.join(fixture.capsuleDir, "deploy-file-attempt.jsonl"));
  });
});


test("Hosted deploy.files retains historical path shapes across deploy and rollback", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "shape-docker"));
    let savedRecord; let fixture;
    for (const [index, relative] of ["config", "config/settings.json", "config"].entries()) {
      await rm(path.join(dir, "shape-files-runtime-files/config"), { force: true, recursive: true });
      fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "shape-files", previousReleaseId: null,
        releaseId: `20260912T16000${index}Z-feedface`, deployFiles: [{ path: relative, update: "preserve" }], fileContents: `seed-${index}` });
      if (savedRecord) await writeFile(fixture.registryRecordPath, savedRecord);
      const installed = await runHostHelper({ action: "capsule.release.install", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, release: fixture.release }, { cwd: dir, env: docker.env });
      assert.equal(installed.code, 0, installed.stdout + installed.stderr);
      savedRecord = await readFile(fixture.registryRecordPath);
      const stored = preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), relative);
      const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
      assert(run.args.includes(`${stored}:/app/${relative}:rw`));
      if (index < 2) await writeFile(stored, `edit-${index}`);
    }
    const root = path.join(fixture.capsuleDir, "preserved-files");
    assert.equal(await readFile(preservedDeployFilePath(root, "config"), "utf8"), "edit-0");
    assert.equal(await readFile(preservedDeployFilePath(root, "config/settings.json"), "utf8"), "edit-1");
    const rollback = await runHostHelper({ action: "capsule.release.rollback", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, rollback: { releaseId: "20260912T160001Z-feedface" } }, { cwd: dir, env: docker.env });
    assert.equal(rollback.code, 0, rollback.stdout + rollback.stderr);
    const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert(run.args.includes(`${preservedDeployFilePath(root, "config/settings.json")}:/app/config/settings.json:rw`));
  });
});


test("Host shutdown evidence cannot authorize OOM, stale containers, or stale releases", async (t) => {
  for (const scenario of ["oom", "container", "release", "no-checkpoint", "late-checkpoint"]) await t.test(scenario, async () => {
    await withTempDir(async (dir) => {
      const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "boot-checkpoint-deny", restart: false });
      await alignSealedFixtureWithBuiltLifecycle(fixture);
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const finishedAt = new Date(Date.now() - 1_000).toISOString();
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      record.status = "running";
      record.shutdownCheckpoint = scenario === "no-checkpoint" ? null : {
        containerId: scenario === "container" ? "b".repeat(64) : "a".repeat(64),
        releaseId: scenario === "release" ? "different-release" : record.currentRelease.id,
        startedAt, capturedAt: scenario === "late-checkpoint" ? new Date().toISOString() : new Date(Date.now() - 5_000).toISOString(),
      };
      await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_INSPECT_JSON: JSON.stringify({
        Id: "a".repeat(64), RestartCount: 3,
        State: { Running: false, Status: "exited", ExitCode: 137, OOMKilled: scenario === "oom", StartedAt: startedAt, FinishedAt: finishedAt },
        Config: { Labels: { "com.sporades.managed": "true", "com.sporades.hosted-domain": fixture.domain, "com.sporades.capsule-subname": fixture.subname } },
      }) } });
      const result = await runHostHelper({ action: "capsule.resume", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(result.stdout).data.resumed, false, result.stdout);
      assert(!(await docker.calls()).some((call) => ["run", "start"].includes(call.args[0])));
    });
  });
});



test("Hosted admission policy uses Host-owned read-only storage and authorized publication", async () => {
  await withTempDir(async dir => {
    const json = id => JSON.stringify({version:1,rules:[{id,enabled:true,conditions:[{kind:"pathname",exact:"/blocked"}],action:{kind:"deny"}}]});
    const docker = await installFakeDocker(path.join(dir,"admission-docker"));
    const fixture = await writeHostedCapsuleInstallFixture(dir, {rootName:"admission-host", previousReleaseId:null, deployFiles:[{path:"policy.json",update:"admission"}], admissionPolicy:{path:"policy.json"}, fileContents:json("seed")});
    const target = {host:{alias:"personal",domain:fixture.domain,remoteRoot:fixture.remoteRoot},capsule:{subname:fixture.subname}};
    const installed = await runHostHelper({...target,action:"capsule.release.install",release:fixture.release},{cwd:dir,env:docker.env});
    assert.equal(installed.code,0,installed.stdout+installed.stderr);
    assert.equal(JSON.parse(installed.stdout).ok,true,installed.stdout+installed.stderr);
    const storage = path.join(fixture.capsuleDir,"preserved-files","admission");
    const file = preservedDeployFilePath(storage,"policy.json");
    assert.equal((await stat(file)).mode & 0o777,0o444);
    const run = (await docker.calls()).filter(call=>call.args[0]==="run").at(-1);
    assert(run.args.includes(`${storage}:/run/sporades-admission:ro`));
    assert.equal(run.args[run.args.indexOf("SPORADES_ADMISSION_POLICY_PATH=policy.json")-1],"--env");
    const publish = contents => runHostHelper({...target,action:"capsule.admission.publish",admission:{contents}},{cwd:dir,env:docker.env});
    const changed = await publish(Buffer.from(json("updated")).toString("base64")); assert.equal(changed.code,0,changed.stdout+changed.stderr); assert.equal(JSON.parse(changed.stdout).ok,true,changed.stdout);
    assert.equal(JSON.parse(await readFile(file,"utf8")).rules[0].id,"updated");
    const invalid = await publish(Buffer.from("{}").toString("base64")); assert.equal(JSON.parse(invalid.stdout).ok,false,invalid.stdout); assert.equal(JSON.parse(await readFile(file,"utf8")).rules[0].id,"updated");
    const removed = await publish(null); assert.equal(removed.code,0,removed.stdout+removed.stderr); assert.equal(JSON.parse(removed.stdout).ok,true,removed.stdout);
    assert.equal(JSON.parse(await readFile(file,"utf8")).removed,true);
    const restart = await runHostHelper({...target,action:"capsule.restart"},{cwd:dir,env:docker.env}); assert.equal(restart.code,0,restart.stdout+restart.stderr);
    assert.equal(JSON.parse(await readFile(file,"utf8")).removed,true);
  });
});


test("Hosted admission publication denies untrusted authority without mutation or Docker operations", async (t) => {
  const messages = {
    "registry identity mismatch": "Hosted Capsule registry record does not match the release request.",
    "interrupted deployment journal": "Interrupted deployment requires recovery.",
    "undeclared policy": "The deployed Capsule has no admission policy.",
    "symlink storage": "Unsafe admission storage.",
  };
  const policy = id => Buffer.from(JSON.stringify({ version: 1, rules: [{
    id, enabled: true, conditions: [{ kind: "header", name: "x-policy-test", value: "private-policy-value" }], action: { kind: "deny" },
  }] }));
  for (const scenario of ["registry identity mismatch", "interrupted deployment journal", "undeclared policy", "symlink storage"]) {
    await t.test(scenario, async () => withTempDir(async dir => {
      const docker = await installFakeDocker(path.join(dir, "denied-admission-docker"));
      await writeFile(path.join(dir, "denied-admission-docker", "docker-calls.jsonl"), "");
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "denied-admission-host", previousReleaseId: null,
        deployFiles: [{ path: "policy.json", update: "admission" }],
        admissionPolicy: { path: "policy.json" }, fileContents: policy("retained-policy").toString(),
      });
      const target = { host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
      const installed = await runHostHelper({ ...target, action: "capsule.release.install", release: { ...fixture.release, restart: false } }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(installed.stdout).ok, true, installed.stdout + installed.stderr);
      const storage = path.join(fixture.capsuleDir, "preserved-files", "admission");
      const file = preservedDeployFilePath(storage, "policy.json");
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      if (scenario === "registry identity mismatch") {
        record.remoteCapsuleId = `${fixture.domain}/another-capsule`;
        await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      } else if (scenario === "interrupted deployment journal") {
        await writeFile(path.join(fixture.capsuleDir, "deploy-file-attempt.jsonl"), JSON.stringify({
          release: "interrupted-attempt", preservedRoot: path.join(fixture.capsuleDir, "preserved-files"),
        }) + "\n");
      } else if (scenario === "undeclared policy") {
        record.releases.find(release => release.id === record.currentRelease.id).source.deployFiles = [];
        await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      } else {
        await rename(storage, `${storage}-retained`);
        await symlink(`${storage}-retained`, storage);
      }
      const bytesBefore = await readFile(file);
      const registryBefore = await readFile(fixture.registryRecordPath);
      const dockerBefore = await docker.calls();
      // The same authority boundary applies to replacement and explicit removal.
      for (const contents of [policy("replacement-policy").toString("base64"), null]) {
        const result = await runHostHelper({ ...target, action: "capsule.admission.publish", admission: { contents } }, { cwd: dir, env: docker.env });
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false, result.stdout);
        assert.equal(result.stderr, "");
        assert.equal(output.data, null);
        assert.equal(output.error.message, messages[scenario]);
        for (const sensitive of ["private-policy-value", "retained-policy", "replacement-policy", contents, storage, "Error:", " at "]) {
          if (sensitive) assert(!result.stdout.includes(sensitive), `denial exposes ${sensitive}`);
        }
        assert.deepEqual(await readFile(file), bytesBefore);
        assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
        assert.deepEqual(await docker.calls(), dockerBefore);
      }
    }));
  }
});


test('real Caddy rewrites Hosted identity and gates simulated Cloudflare traffic before admission', { skip: !process.env.SPORADES_CADDY_ACCEPTANCE_BIN, timeout: 30000 }, async () => {
  await withTempDir(async dir => {
    const remoteRoot = path.join(dir, 'remote-root');
    const capsuleDir = path.join(remoteRoot, 'hosts', 'capsules.example.dev', 'capsules', 'address');
    const releaseDir = path.join(capsuleDir, 'releases', '20260630T221500Z-feedface');
    const recordPath = path.join(remoteRoot, 'hosts', 'capsules.example.dev', 'registry', 'capsules', 'address.json');
    const routeFile = path.join(remoteRoot, 'caddy', 'hosts', 'capsules.example.dev', 'address.caddy');
    await mkdir(releaseDir, { recursive: true });
    for (const [name, bytes] of [['server.mjs','export default {};'],['client.js',''],['index.html',''],['sporades.json','{}']]) await writeFile(path.join(releaseDir,name),bytes);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify({subname:'address',domain:'capsules.example.dev'}));
    await symlink(releaseDir, path.join(capsuleDir,'current'));
    let policy = parseAdmissionPolicy(Buffer.from(JSON.stringify({version:1,rules:[{id:'address',enabled:true,conditions:[{kind:'pathname',exact:'/blocked'},{kind:'address',value:'192.0.2.0/24'}],action:{kind:'deny'}}]})));
    const database = {securitySession:'hosted',runtimeProbeToken:null,admissionPolicy:{current:()=>policy}};
    let calls = 0, handlers = 0;
    const runtime = createServer((request,response) => {
      calls++;
      if (routeHttpAdmission(database,request,response)) return;
      handlers++;
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({address:trustedClientAddress(database,request),count:request.rawHeaders.filter((name,i)=>i%2===0 && name.toLowerCase()==='x-sporades-client-address').length}));
    });
    runtime.on('upgrade', (request, socket) => {
      if (routeWebSocketAdmission(database, request, socket)) return;
      handlers++;
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
    try {
      const docker = await installFakeDocker(path.join(dir,'docker'),{env:{FAKE_DOCKER_PUBLISHED_PORT:`127.0.0.1:${runtime.address().port}`}});
      const caddy = await installFakeCaddy(path.join(dir,'caddy'));
      // The real proxy runs as the fixture owner. Host service management remains
      // fake; an installed system caddy user must not change this fixture's owner.
      const caddyUser = await installFakeCaddyUserCommands(path.join(dir,'caddy-user'));
      const env = {...docker.env,...caddy.env,...caddyUser.env,
        PATH:`${caddyUser.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`};
      for (const mode of ['automatic','cloudflare-origin','simulated-cloudflare']) {
        const tls = mode === 'automatic' ? {mode:'automatic'} : {mode:'cloudflare-origin',certificate:path.join(remoteRoot,'hosts','capsules.example.dev','tls','origin.crt'),key:path.join(remoteRoot,'hosts','capsules.example.dev','tls','origin.key')};
        const result = await runHostHelper({action:'capsule.start',host:{alias:'local',domain:'capsules.example.dev',scheme:'https',remoteRoot},capsule:{subname:'address'},lifecycle:{hostedUrl:'https://address.capsules.example.dev',container:{name:'sporades-capsules-example-dev-address'},routes:{running:{hostname:'address.capsules.example.dev',target:'container',containerName:'sporades-capsules-example-dev-address',port:4000,routeFile,tls}}}},{cwd:dir,env});
        assert.equal(result.code,0,result.stderr);
        assert.equal(JSON.parse(result.stdout).ok,true,result.stdout);
        database.runtimeProbeToken = JSON.parse(await readFile(recordPath,'utf8')).runtimeProbe.token;
        const reservation = createServer(); await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
        const port = reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
        let route = (await readFile(routeFile,'utf8')).replace('address.capsules.example.dev {',`http://127.0.0.1:${port} {`).replace(/^  tls .*\n/m,'');
        // This fixture models an already validated CF source without claiming real CF infrastructure proof.
        if (mode === 'simulated-cloudflare') route = route.replace(/(@sporadesUntrustedCloudflareSource not remote_ip )[^\n]+/,(_match,prefix)=>`${prefix}127.0.0.1/32`);
        const configPath = path.join(dir,'Caddyfile'); await writeFile(configPath,`{\n admin off\n auto_https off\n}\n${route}`);
        const child = spawn(process.env.SPORADES_CADDY_ACCEPTANCE_BIN,['run','--config',configPath,'--adapter','caddyfile'],{env:{...process.env,XDG_CONFIG_HOME:path.join(dir,'config'),XDG_DATA_HOME:path.join(dir,'data')},stdio:['ignore','ignore','pipe']});
        let stderr = ''; child.stderr.on('data',chunk=>{stderr+=chunk;});
        const base = `http://127.0.0.1:${port}`;
        try {
          const deadline = Date.now()+5000;
          for (;;) {
            if (await fetch(base+'/ready').then(()=>true,()=>false)) break;
            assert.equal(child.exitCode,null,stderr);
            assert.ok(Date.now()<deadline,stderr);
            await new Promise(resolve=>setTimeout(resolve,25));
          }
          const headers = {'x-sporades-client-address':'192.0.2.1','x-sporades-client-address-token':'b'.repeat(64),forwarded:'for=192.0.2.1','x-forwarded-for':'192.0.2.1','cf-connecting-ip':'192.0.2.1'};
          const before = calls;
          const response = await fetch(base+'/blocked',{headers});
          if (mode === 'automatic') {
            assert.equal(response.status,200); assert.deepEqual(await response.json(),{address:'127.0.0.1',count:1});
          } else {
            assert.equal(response.status,403);
            if (mode === 'cloudflare-origin') assert.equal(calls,before,'untrusted CF peer must never reach runtime');
          }
          if (mode === 'simulated-cloudflare') {
            const ipv6 = await fetch(base+'/blocked',{headers:{...headers,'cf-connecting-ip':'2001:0DB8:0:0:0:0:0:1'}});
            assert.equal(ipv6.status,200); assert.deepEqual(await ipv6.json(),{address:'2001:db8::1',count:1});
            for (const value of [undefined,'invalid','198.51.100.1,198.51.100.2','::ffff:192.0.2.1']) {
              const cfHeaders = {...headers}; if (value === undefined) delete cfHeaders['cf-connecting-ip']; else cfHeaders['cf-connecting-ip']=value;
              const denied = await fetch(base+'/blocked',{headers:cfHeaders}); assert.equal(denied.status,403); assert.equal(await denied.text(),'Forbidden\n');
            }
          }
          // Send duplicate wire fields, not merely a comma-containing fixture value.
          const {request:httpRequest} = await import('node:http');
          const duplicate = await new Promise((resolve,reject)=>{
            const outgoing = httpRequest(base+'/blocked',{headers:{...headers,'x-sporades-client-address':['192.0.2.1','192.0.2.2'],'x-sporades-client-address-token':['b'.repeat(64),'c'.repeat(64)],'cf-connecting-ip':['198.51.100.1','198.51.100.1']}},incoming=>{
              const chunks=[]; incoming.on('data',chunk=>chunks.push(chunk)); incoming.on('end',()=>resolve({status:incoming.statusCode,body:Buffer.concat(chunks).toString()}));
            }); outgoing.on('error',reject); outgoing.end();
          });
          assert.equal(duplicate.status,mode==='automatic'?200:403);
          if (mode==='automatic') assert.deepEqual(JSON.parse(duplicate.body),{address:'127.0.0.1',count:1});
          if (mode==='simulated-cloudflare') assert.equal(duplicate.body,'Forbidden\n');
          if (mode==='automatic') {
            const upgrade = target => new Promise((resolve,reject) => {
              const outgoing=httpRequest(base+target,{headers:{...headers,connection:'Upgrade',upgrade:'websocket',
                'sec-websocket-version':'13','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ=='}},incoming=>{
                const chunks=[]; incoming.on('data',chunk=>chunks.push(chunk));
                incoming.on('end',()=>resolve({status:incoming.statusCode,headers:incoming.headers,body:Buffer.concat(chunks).toString()}));
              });
              outgoing.on('upgrade',(incoming,socket)=>{socket.destroy();resolve({status:incoming.statusCode});});
              outgoing.on('error',reject); outgoing.setTimeout(5000,()=>outgoing.destroy(new Error('Caddy upgrade timeout'))); outgoing.end();
            });
            const denied = async (response, status) => {
              assert.equal(response.status,status); assert.equal(await response.text(),status===403?'Forbidden\n':'Too Many Requests\n');
              assert.equal(response.headers.get('cache-control'),'no-store');
            };
            const beforeControl=calls;
            assert.equal((await fetch(base+'/__sporades/health/runtime')).status,404);
            assert.equal(calls,beforeControl,'public runtime control must not reach the runtime');
            const direct=await fetch(`http://127.0.0.1:${runtime.address().port}/blocked`,{headers});
            await denied(direct,403);
            // Match the actual accepted peer, irrespective of forged forwarding
            // values. Both transports deny before the fixture application marker.
            policy=parseAdmissionPolicy(Buffer.from(JSON.stringify({version:1,rules:[{id:'socket-peer',enabled:true,
              conditions:[{kind:'pathname',prefix:'/proof'},{kind:'address',value:'127.0.0.1/32'}],action:{kind:'deny'}}]})));
            const beforeDeny=handlers;
            await denied(await fetch(base+'/proof/limited',{headers}),403);
            const wsDenied=await upgrade('/proof/ws');
            assert.equal(wsDenied.status,403); assert.equal(wsDenied.body,'Forbidden\n');
            assert.equal(wsDenied.headers['cache-control'],'no-store');
            assert.equal(handlers,beforeDeny);
            // The proxy must use one trusted socket identity for HTTP and upgrade
            // traffic, so changing forged headers cannot split a shared quota.
            for (const first of ['http','websocket']) {
              policy=parseAdmissionPolicy(Buffer.from(JSON.stringify({version:1,rules:[{id:'proxy-quota-'+first,enabled:true,
                conditions:[{kind:'pathname',prefix:'/proof'}],action:{kind:'rate-limit',limit:1,windowMs:60000}}]})));
              const admitted=first==='http' ? await fetch(base+'/proof/limited',{headers}) : await upgrade('/proof/ws');
              assert.equal(admitted.status,first==='http'?200:101);
              if(first==='http') await admitted.arrayBuffer();
              const beforeQuota=handlers;
              if(first==='http') {
                const limited=await upgrade('/proof/ws');
                assert.equal(limited.status,429); assert.equal(limited.body,'Too Many Requests\n');
                assert.equal(limited.headers['cache-control'],'no-store');
                assert.ok(Number(limited.headers['retry-after'])>=1 && Number(limited.headers['retry-after'])<=60);
              } else {
                const limited=await fetch(base+'/proof/limited',{headers});
                await denied(limited,429);
                assert.ok(Number(limited.headers.get('retry-after'))>=1 && Number(limited.headers.get('retry-after'))<=60);
              }
              assert.equal(handlers,beforeQuota,'rate-limited traffic reached application code');
            }
            // Restore the original generation for the optional simulated modes.
            policy=parseAdmissionPolicy(Buffer.from(JSON.stringify({version:1,rules:[{id:'address',enabled:true,
              conditions:[{kind:'pathname',exact:'/blocked'},{kind:'address',value:'192.0.2.0/24'}],action:{kind:'deny'}}]})));
          }
        } finally {
          if (child.exitCode === null) {
            child.kill('SIGTERM'); const kill = setTimeout(()=>child.kill('SIGKILL'),1000);
            await new Promise(resolve=>child.once('exit',resolve)); clearTimeout(kill);
          }
        }
      }
    } finally { runtime.closeAllConnections(); await new Promise(resolve=>runtime.close(resolve)); }
  });
});


test('canonical changes recover after registry publication interrupts recreation', async () => {
  await withTempDir(async dir => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    await mkdir(path.join(fixture.remoteRoot, 'caddy/hosts/capsules.example.dev'), { recursive: true });
    await writeFile(path.join(fixture.remoteRoot, 'caddy/Caddyfile'), 'import ./hosts/*.caddy\n');
    const record = JSON.parse(await readFile(fixture.registryRecordPath, 'utf8'));
    record.aliasDomains = ['canonical.example'];
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const docker = await installFakeDocker(dir);
    const target = { action: 'capsule.canonical.set', host: { alias: 'personal', domain: fixture.domain, scheme: 'https', remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    // Interrupt at the real publication boundary, after releasing the registry lock
    // but before any lifecycle/Docker work. The Host route OS lock dies with us.
    const hook = path.join(dir, 'interrupt-canonical.mjs');
    await writeFile(docker.logPath, '');
    await writeFile(hook, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const rm = fs.rm; fs.rm = async (target, ...args) => {
  const result = await rm(target, ...args);
  if (String(target).endsWith('/registry/.lock')) process.exit(17);
  return result;
}; syncBuiltinESMExports();`);
    for (const domain of ['canonical.example', null]) {
      const request = { ...target, canonical: { domain } };
      const callsBefore = (await docker.calls()).length;
      const interrupted = await runHostHelper(request, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${hook}` } });
      assert.equal(interrupted.code, 17, interrupted.stdout + interrupted.stderr);
      assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, 'utf8')).canonicalDomain, domain);
      assert.equal((await docker.calls()).length, callsBefore);
      const retried = JSON.parse((await runHostHelper(request, { cwd: dir, env: docker.env })).stdout);
      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(retried.data.restarted, true, 'same-value retry must apply the saved origin');
      const run = (await docker.calls()).filter(call => call.args[0] === 'run').at(-1);
      assert(run.args.includes(`SPORADES_PUBLIC_ORIGIN=${domain ? 'https://' + domain : record.hostedUrl}`));
    }
  });
});


test('backup settlement failures retain evidence, distinguish snapshots and recover on the next automatic pass', async t => {
  for (const scenario of ['missing-publication', 'non-loopback', 'invalid-port', 'not-ready', 'reload-failure', 'route-unverified', 'capture-and-resume-fail']) await t.test(scenario, () => withBackupRouteFixture(async f => {
    const extra = scenario === 'missing-publication' ? { FAKE_DOCKER_PUBLISHED_PORT: 'missing' }
      : scenario === 'non-loopback' ? { FAKE_DOCKER_PUBLISHED_PORT: '0.0.0.0:49154' }
      : scenario === 'invalid-port' ? { FAKE_DOCKER_PUBLISHED_PORT: '127.0.0.1:65536' }
      : scenario === 'not-ready' ? { FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{ status: 401 }]) }
      : scenario === 'reload-failure' ? { FAKE_DOCKER_CADDY_RELOAD_STATUSES: '0,1,0' }
      : scenario === 'route-unverified' ? { FAKE_HOST_ROUTE_PROBE_FAIL: '1' }
      : { FAKE_DOCKER_PUBLISHED_PORT: 'missing' };
    if (scenario === 'capture-and-resume-fail') await writeFile(path.join(f.data, 'data.db'), 'not a database');
    const result = await runHostHelper(f.request, { cwd: f.dir, env: { ...f.docker.env, ...extra } });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.deepEqual(output.error.diagnostics.snapshotCompleted, scenario !== 'capture-and-resume-fail');
    assert.equal(output.error.diagnostics.resumePending, true);
    if (scenario === 'capture-and-resume-fail') assert.match(output.error.message, /database/);
    assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).id, 'b'.repeat(64));
    assert(!result.stdout.includes('a'.repeat(64)));
    // Docker/publication and Caddy repairs require no new backup or manual health.
    await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
    const calls = (await f.docker.calls()).length;
    const retry = await runHostHelper({ ...f.request, action: 'capsule.route.reconcile' }, { cwd: f.dir, env: f.docker.env });
    assert.equal(JSON.parse(retry.stdout).ok, true, retry.stdout);
    assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
    await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
    assert(!(await f.docker.calls()).slice(calls).some(c => ['run', 'rm', 'stop', 'start'].includes(c.args[0])));
  }));
});


test('route worker startup, duplicate passes and recovery after missed Docker changes converge without lifecycle commands', () => withBackupRouteFixture(async f => {
  // No event history: the first pass discovers the real publication directly.
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
  assert.equal(JSON.parse((await runRouteRecoveryPass(f)).stdout).ok, true);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  const reloads = (await f.docker.caddyCalls()).filter(c => c.args[0] === 'reload').length;
  assert.equal(JSON.parse((await runRouteRecoveryPass(f)).stdout).ok, true);
  assert.equal((await f.docker.caddyCalls()).filter(c => c.args[0] === 'reload').length, reloads, 'duplicate scans are idempotent');
  // A Docker outage produces an actionable aggregate failure, then a restarted
  // worker reconciles the latest state without consuming old events or IDs.
  const broken = await runRouteRecoveryPass(f, { FAKE_DOCKER_BACKUP_STATE: '', FAKE_DOCKER_INSPECT_STATUS: '1', FAKE_DOCKER_PS_STATUS: '1' });
  assert.equal(JSON.parse(broken.stdout).ok, false);
  assert.equal(JSON.parse(broken.stdout).data.pending, 1);
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49155' }));
  const start = performance.now();
  const repaired = await runRouteRecoveryPass(f, { FAKE_DOCKER_PUBLISHED_PORT: '127.0.0.1:49155' });
  assert.equal(JSON.parse(repaired.stdout).ok, true, repaired.stdout);
  assert(performance.now() - start < 30_000);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49155/);
  assert(!(await f.docker.calls()).some(c => ['start', 'stop', 'rm', 'run'].includes(c.args[0])));
  assert(!repaired.stdout.includes('a'.repeat(64)));
}));


test('concurrent sibling route recovery isolates routes and ignores replaced container evidence', () => withBackupRouteFixture(async f => {
  const sibling = 'sibling';
  const siblingDir = path.join(path.dirname(f.capsuleDir), sibling);
  const release = path.join(siblingDir, 'releases', f.record.currentRelease.id);
  await mkdir(release, { recursive: true });
  await symlink(release, path.join(siblingDir, 'current'));
  const siblingRecord = { ...f.record, subname: sibling, remoteCapsuleId: `${f.domain}/${sibling}`, hostedUrl: `https://${sibling}.${f.domain}` };
  await writeFile(path.join(path.dirname(f.registryRecordPath), `${sibling}.json`), JSON.stringify(siblingRecord));
  const siblingRoute = path.join(path.dirname(f.routeFile), `${sibling}.caddy`);
  await writeFile(siblingRoute, `${sibling}.${f.domain} {\n reverse_proxy 127.0.0.1:49151 {\n }\n}\n`);
  const all = {};
  for (const [subname, id, port] of [[f.subname, 'b'.repeat(64), '127.0.0.1:49154'], [sibling, 'd'.repeat(64), '127.0.0.1:49155']]) {
    const container = JSON.parse(f.docker.env.FAKE_DOCKER_INSPECT_JSON);
    container.Id = id; container.port = port; container.Config.Labels['com.sporades.capsule-subname'] = subname;
    all[`sporades-${f.domain.replace(/[^a-z0-9]+/g, '-')}-${subname}`] = container;
  }
  const containers = path.join(f.dir, 'containers.json'); await writeFile(containers, JSON.stringify(all));
  const extra = { FAKE_DOCKER_RECOVERY_CONTAINERS: containers, FAKE_HOST_ROUTE_PROBE_ROUTE: '' };
  const pass = await runRouteRecoveryPass(f, extra);
  assert.equal(JSON.parse(pass.stdout).ok, true, pass.stdout);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  assert.match(await readFile(siblingRoute, 'utf8'), /reverse_proxy 127\.0\.0\.1:49155/);
  const siblingBefore = await readFile(siblingRoute);
  // Replacement with an old journal must never inherit its predecessor's authority.
  await writeFile(f.journal, JSON.stringify({ id: 'e'.repeat(64) }), { mode: 0o600 });
  all[Object.keys(all).find(name => name.endsWith(`-${f.subname}`))].port = '127.0.0.1:49156';
  await writeFile(containers, JSON.stringify(all));
  const second = await runRouteRecoveryPass(f, extra);
  assert.equal(JSON.parse(second.stdout).ok, true, second.stdout);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  assert.deepEqual(await readFile(siblingRoute), siblingBefore);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).id, 'e'.repeat(64));
}));


test('recovery reloads matching route bytes when an interrupted worker left Caddy on the old upstream', () => withBackupRouteFixture(async f => {
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
  const route = (await readFile(f.routeFile, 'utf8')).replace('49153', '49154');
  await writeFile(f.routeFile, route);
  const pass = await runRouteRecoveryPass(f, { FAKE_HOST_ROUTE_PROBE_REQUIRE_RELOAD: '1' });
  assert.equal(JSON.parse(pass.stdout).ok, true, pass.stdout);
  assert.equal(await readFile(f.routeFile, 'utf8'), route);
  assert.deepEqual((await f.docker.caddyCalls()).map(c => c.args[0]), ['validate', 'reload']);
  assert(!(await f.docker.calls()).some(c => ['run','rm','start','stop'].includes(c.args[0])));
}));


test('boot recovery settles an already-running current instance without replacing it', () => withBackupRouteFixture(async f => {
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
  const result = await runHostHelper({ ...f.request, action: 'capsule.resume' }, { cwd: f.dir, env: f.docker.env });
  assert.equal(JSON.parse(result.stdout).data.reconciled, true, result.stdout);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  assert(!(await f.docker.calls()).some(c => ['run','rm','start','stop'].includes(c.args[0])));
}));


test('backup completion rechecks external Docker restarts during upload and retains failed final settlement', async t => {
  for (const failed of [false, true]) await t.test(failed ? 'final probe fails' : 'second port change', () => withBackupRouteFixture(async f => {
    await writeFile(f.uploadRestart, 'synthetic restart');
    const result = await runHostHelper(f.request, { cwd: f.dir, env: { ...f.docker.env,
      FAKE_HOST_ROUTE_PROBE_FAIL_FINAL: failed ? '1' : '0',
    } });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, !failed, result.stdout);
    assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49155/);
    assert.equal((await f.docker.calls()).filter(c => c.args[0] === 'start').length, 1);
    if (failed) {
      assert.equal(output.error.diagnostics.snapshotCompleted, true);
      assert.equal(output.error.diagnostics.resumePending, true);
      assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).id, 'b'.repeat(64));
      const recovered = await runRouteRecoveryPass(f);
      assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    }
    await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
  }));
});
