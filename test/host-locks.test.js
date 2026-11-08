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
// OS lock and signal fixtures run in the serial lane.
import {
repoRoot,
cliPath,
hostHelperPath,
rootPackageJson,
TEST_PUBLIC_KEY,
TEST_WEBSOCKET_TIMEOUT_MS,
workstationPath,
unavailableDockerDirectory,
buildHostLifecycle,
withTempDir,
withHttpServer,
withHostedRuntimeTransportServer,
reserveUnusedPort,
openRawWebSocketHandshake,
runCli,
startHostHelper,
runHostHelper,
startExecutable,
writeFakeProcEntry,
waitForFileText,
waitForHostHelperMarker,
stopHostHelper,
waitForPath,
waitForChildPid,
hostEnv,
writeHostProfileConfig,
prepareFakeBin,
installFakeSsh,
installFakeShellSsh,
installContractFakeSsh,
installFakeScp,
installFakeDocker,
installFakeCaddy,
installFakeJournalctl,
installFakeCaddyUserCommands,
setupRootCapsuleHttpLogFixture,
readJsonl,
readProjectAuditEvents,
writeHostedCapsuleRollbackFixture,
escapeRegExp,
readHostBootstrapSmokeEnv,
readHostRegisterSmokeEnv,
readHostPushRoutingSmokeEnv,
readHostLogsSmokeEnv,
readDotEnv,
listArchiveEntries,
listArchiveVerboseEntries,
extractArchiveFile,
withCacheBust,
writePublicRuntimeFiles,
createTarGz,
createTarGzWithTransforms,
writeArchiveSecurityFixture,
writeHostedCapsuleInstallFixture,
writeLegacySealedInstallFixture,
alignSealedFixtureWithBuiltLifecycle,
installFakeReact,
installFakePreact,
installVue,
writePackage,
prepareRouteLockFixture,
prepareUnregisterRouteFixture,
customDomainFixture,
withBackupRouteFixture,
runRouteRecoveryPass
} from "./support/host-fixture.js";

test("sporades host helper automatically releases the OS route lock after its owner is killed", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const holder = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recoveredDocker = await installFakeDocker(path.join(dir, "recovered"));
    const recovered = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...recoveredDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "500" },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true, "the inert lock file may persist while its OS lock is released");
  });
});

test("sporades host helper releases the OS route lock to one waiting successor", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "300" },
    });
    const predecessor = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const successor = runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });

    const [predecessorResult, successorResult] = await Promise.all([predecessor.result, successor]);
    assert.equal(JSON.parse(predecessorResult.stdout).ok, true, predecessorResult.stdout);
    assert.equal(JSON.parse(successorResult.stdout).ok, true, successorResult.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
  });
});

test("Host bootstrap and Capsule route mutations share a global lock without deadlock", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "1000" },
    });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...fixture.docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${fixture.docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const mutation = startHostHelper(fixture.request, { cwd: dir, env });
    await waitForPath(fixture.lockDir);
    const bootstrap = startHostHelper({
      action: "host.bootstrap",
      host: fixture.request.host,
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, { cwd: dir, env });
    let bootstrapSettled = false;
    bootstrap.result.then(() => { bootstrapSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(bootstrapSettled, false, "global bootstrap must wait for an active Capsule route mutation");
    assert.equal(JSON.parse((await mutation.result).stdout).ok, true);
    assert.equal(JSON.parse((await bootstrap.result).stdout).ok, true);

    const exclusiveBootstrap = startHostHelper({
      action: "host.bootstrap",
      host: fixture.request.host,
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, { cwd: dir, env: { ...env, SPORADES_FAKE_HOST_GLOBAL_ROUTE_LOCK_PAUSE_MS: "700" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const laterMutation = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...env, SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "0" },
    });
    let mutationSettled = false;
    laterMutation.result.then(() => { mutationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(mutationSettled, false, "Capsule mutation must wait for exclusive global bootstrap");
    assert.equal(JSON.parse((await exclusiveBootstrap.result).stdout).ok, true);
    assert.equal(JSON.parse((await laterMutation.result).stdout).ok, true);
  });
});

test("Host helper cleanup releases the retained action lock before fixture removal", { timeout: 15_000 }, async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const marker = path.join(dir, "cleanup-lock.marker");
    const action = startHostHelper(fixture.request, { cwd: dir, detached: true, env: {
      ...fixture.docker.env,
      SPORADES_TEST_ROUTE_LOCK_PROOF_MARKER: marker,
      SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000",
    } });
    try {
      await waitForHostHelperMarker(action, marker, (text) => text === "route-lock-proof-retained\n");
      await stopHostHelper(action);
      const next = await runHostHelper(fixture.request, { cwd: dir, env: {
        ...fixture.docker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "500",
      } });
      assert.equal(JSON.parse(next.stdout).ok, true, next.stdout);
    } finally {
      try { process.kill(-action.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await action.result;
    }
  });
});

test("sporades host helper ignores stale lock-file contents because ownership is kernel-scoped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    await writeFile(
      fixture.lockDir,
      `${JSON.stringify({
        token: "b".repeat(32),
        pid: process.pid,
        processIdentity: "stale-process-from-an-earlier-boot",
        createdAt: Date.now() - 60_000,
      })}\n`,
    );

    const recovered = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "500" },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
  });
});

test("sporades host helper fences an ancestor swap after route lock acquisition", async () => {
  await withTempDir(async (dir) => {
    const proofMarker = path.join(dir, "route-lock-proof.marker");
    const fixture = await prepareRouteLockFixture(dir, {
      env: {
        SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "700",
        SPORADES_TEST_ROUTE_LOCK_PROOF_MARKER: proofMarker,
      },
    });
    const domainDirectory = path.dirname(fixture.routeFile);
    const preservedDirectory = `${domainDirectory}.preserved`;
    const outside = path.join(dir, "outside-route-target");
    await mkdir(outside, { mode: 0o700 });
    const action = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(proofMarker);
    await rename(domainDirectory, preservedDirectory);
    await symlink(outside, domainDirectory, "dir");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.deepEqual(await readdir(outside), []);
    assert.match(await readFile(path.join(preservedDirectory, "team-notes.caddy"), "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});

test("first Host helper upgrade drains legacy actions and blocks new commands behind an atomic dispatcher", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await copyFile(hostHelperPath, target); // A raw installed bundle contains the dispatcher marker as JavaScript source.
    await chmod(target, 0o755);
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 41001, target);
    const installerLookalike = path.join(procRoot, "41000");
    await mkdir(installerLookalike, { recursive: true });
    await writeFile(path.join(installerLookalike, "cmdline"), Buffer.from(`${process.execPath}\0${stage}\0--install-host-helper\0${target}\0`, "utf8"));
    await writeFile(path.join(installerLookalike, "environ"), Buffer.from("\0", "utf8"));
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "2000",
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
    };
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env });
    await Promise.race([
      waitForFileText(target, (contents) => contents.startsWith("#!/bin/sh\n# SPORADES_HOST_HELPER_DISPATCHER_V1\n")),
      upgrade.result.then((result) => assert.fail(`upgrade exited before dispatcher publication: ${JSON.stringify(result)}`)),
    ]);
    await writeFakeProcEntry(procRoot, 41002, target, [], "start-during-replacement window");

    const request = `${JSON.stringify({
      action: "host.version",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote") },
    })}\n`;
    const command = startExecutable(target, [], { cwd: dir, env, input: request });
    let commandSettled = false;
    command.result.then(() => { commandSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(commandSettled, false, "a new command must wait behind the exclusive upgrade barrier");

    await rm(path.join(procRoot, "41001"), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(commandSettled, false, "a legacy action starting during replacement must also drain");
    await rm(path.join(procRoot, "41002"), { recursive: true, force: true });

    const upgraded = await upgrade.result;
    assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
    const commandResult = await command.result;
    assert.equal(commandResult.code, 0, commandResult.stderr);
    assert.equal(JSON.parse(commandResult.stdout).data.version, rootPackageJson.version, commandResult.stdout);
    const payloadName = (await readFile(path.join(remoteBin, ".sporades-host-helper.active"), "utf8")).trim();
    assert.equal(payloadName, `.sporades-host-helper-payload-${checksum}.mjs`);
    assert.equal(createHash("sha256").update(await readFile(path.join(remoteBin, payloadName))).digest("hex"), checksum);
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.needs-drain")), { code: "ENOENT" });
    assert.deepEqual((await readdir(remoteBin)).filter((entry) => entry.includes(".tmp-")), []);

    const bootHost = { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote") };
    await mkdir(path.join(bootHost.remoteRoot, "hosts", bootHost.domain, "registry", "capsules"), { recursive: true });
    const boot = await startExecutable(target, ["--resume-host", Buffer.from(JSON.stringify(bootHost)).toString("base64url")], { cwd: dir, env }).result;
    assert.equal(boot.code, 0, boot.stderr || boot.stdout);
    assert.deepEqual(JSON.parse(boot.stdout), { ok: true, data: { capsules: [] }, error: null }, "upgraded dispatcher must forward boot arguments unchanged");

    await writeFile(path.join(remoteBin, payloadName), Buffer.concat([await readFile(path.join(remoteBin, payloadName)), Buffer.from("\ncorrupt\n")]));
    const corrupted = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(corrupted.stdout).error.message, "Host helper payload integrity check failed.");
    await writeFile(path.join(remoteBin, ".sporades-host-helper.active"), "../../attacker\n");
    const hostilePointer = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(hostilePointer.stdout).error.message, "Host helper dispatcher state is invalid.");
  });
});

test("sporades host helper cannot continue route mutation after its lock-holding action process is killed", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "600" },
    });
    const staleRequest = structuredClone(fixture.request);
    const winnerRequest = structuredClone(fixture.request);
    const stale = startHostHelper(staleRequest, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lockHolderPid = await waitForChildPid(stale.child.pid);
    process.kill(lockHolderPid, "SIGKILL");

    const winnerDocker = await installFakeDocker(path.join(dir, "winner"));
    const winner = await runHostHelper(winnerRequest, { cwd: dir, env: winnerDocker.env });
    const staleResult = await stale.result;
    assert.equal(JSON.parse(winner.stdout).ok, true, winner.stdout);
    assert.equal(JSON.parse(staleResult.stdout).ok, false, staleResult.stdout);
    const route = await readFile(fixture.routeFile, "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host helper does not steal a live route owner and rejects malformed lock bounds", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const holder = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const contenderDocker = await installFakeDocker(path.join(dir, "contender"));
    const startedAt = Date.now();
    const contender = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...contenderDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "100" },
    });
    assert.equal(JSON.parse(contender.stdout).error.message, "Hosted Capsule route is locked.");
    assert.ok(Date.now() - startedAt < 1000, "a live-owner timeout must remain bounded");

    for (const invalidTimeout of ["NaN", "Infinity", "0", "-1", "1.5", "60001"]) {
      const invalid = await runHostHelper(fixture.request, {
        cwd: dir,
        env: { ...contenderDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: invalidTimeout },
      });
      assert.equal(JSON.parse(invalid.stdout).error.message, "Invalid Hosted Capsule route lock timeout.");
    }
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;
  });
});
