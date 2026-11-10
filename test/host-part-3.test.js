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
hostHelperPath,
rootPackageJson,
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
createHostPauseGate,
hostEnv,
writeHostProfileConfig,
installFakeSsh,
installContractFakeSsh,
installFakeScp,
installFakeDocker,
installFakeCaddy,
installFakeJournalctl,
installFakeCaddyUserCommands,
readJsonl,
writeHostedCapsuleRollbackFixture,
listArchiveEntries,
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


test("connection-token refresh route returns a fresh no-store browser gate", async () => {
  let issued = 0;
  await withHttpServer((request, response) => {
    if (prepareHttpSecurity({}, request, response)) return;
    if (routeConnectionToken(request, response, () => `connection-token-${++issued}`)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }, async (port) => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const refreshHeaders = { "x-sporades-connection-token-request": "1" };
    const first = await fetch(new URL("/__sporades/connection-token", baseUrl), { headers: refreshHeaders });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("pragma"), "no-cache");
    assert.equal(first.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.ok(first.headers.get("content-security-policy-report-only"));
    assert.deepEqual(await first.json(), { token: "connection-token-1" });

    const second = await fetch(new URL("/__sporades/connection-token", baseUrl), { headers: refreshHeaders });
    assert.deepEqual(await second.json(), { token: "connection-token-2" });

    const wrongMethod = await fetch(new URL("/__sporades/connection-token", baseUrl), { method: "POST" });
    assert.equal(wrongMethod.status, 404);

    const crossOrigin = await fetch(new URL("/__sporades/connection-token", baseUrl), {
      headers: { ...refreshHeaders, origin: "https://evil.example.test" },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(issued, 2, "cross-origin requests do not mint connection tokens");

    const crossSiteSubresource = await fetch(new URL("/__sporades/connection-token?cache-bust=1", baseUrl));
    assert.equal(crossSiteSubresource.status, 403);
    assert.equal(issued, 2, "requests without the runtime-only header do not mint connection tokens");
  });
});


test("Hosted Capsule connection-token inventory evicts its oldest browser gates at the fixed cap", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(dir, {}, async (baseUrl, createConnectionToken) => {
      const oldest = createConnectionToken();
      let newest;
      for (let index = 0; index < 4_096; index += 1) newest = createConnectionToken();
      const headers = { origin: "https://team-notes.capsules.example.dev" };

      const evicted = await openRawWebSocketHandshake(baseUrl, headers, oldest);
      assert.doesNotMatch(evicted, /^HTTP\/1\.1 101/m);

      const retained = await openRawWebSocketHandshake(baseUrl, headers, newest);
      assert.match(retained, /^HTTP\/1\.1 101/m);
    });
  });
});



test("Hosted Capsule connection-token expiry rejects the old gate and accepts its conditional replacement", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    await withTempDir(async (dir) => {
      await withHostedRuntimeTransportServer(dir, {}, async (baseUrl, createConnectionToken) => {
        const token = createConnectionToken();
        const upgradeHeaders = { origin: "https://team-notes.capsules.example.dev" };
        assert.match(await openRawWebSocketHandshake(baseUrl, upgradeHeaders, token), /^HTTP\/1\.1 101/m);
        const headers = { "x-sporades-connection-token-request": "1", "x-sporades-connection-token": token };
        const url = new URL("/__sporades/connection-token", baseUrl);
        const healthy = await fetch(url, { headers });
        assert.equal((await healthy.json()).token === token, true, "a transport blip does not consume a fresh gate");
        now += 4 * 60 * 60 * 1000 + 1;
        const rejected = await openRawWebSocketHandshake(baseUrl, upgradeHeaders, token);
        assert.match(rejected, /^HTTP\/1\.1 403 Forbidden/m);
        assert.doesNotMatch(rejected, /Sec-WebSocket-Accept/i, "auth rejection happens before WebSocket upgrade");
        const replacement = await fetch(url, { headers });
        const fresh = (await replacement.json()).token;
        assert.equal(fresh !== token, true);
        assert.match(await openRawWebSocketHandshake(baseUrl, upgradeHeaders, fresh), /^HTTP\/1\.1 101/m);
        assert.match(await openRawWebSocketHandshake(baseUrl, upgradeHeaders, token), /^HTTP\/1\.1 403 Forbidden/m);
      });
    });
  } finally { Date.now = originalNow; }
});


test("Caddy route permissions allow the distinct service user and deny unrelated users", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0 ? "Requires an isolated Linux root fixture for distinct uid/gid checks" : false,
}, async () => {
  await withTempDir(async (dir) => {
    await chmod(dir, 0o755);
    const { remoteRoot } = await writeHostedCapsuleRollbackFixture(dir);
    // POSIX chooses group bits before other bits when Caddy matches the group.
    await chown(remoteRoot, 0, 12346);
    await chmod(remoteRoot, 0o700);
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"), {
      env: { FAKE_CADDY_UID: "12345", FAKE_CADDY_GID: "12346" },
    });
    const env = { ...docker.env, ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}` };
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const request = { action: "capsule.start", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" } };
    const previous = process.umask(0o077);
    let result;
    try { result = await runHostHelper(request, { cwd: dir, env }); }
    finally { process.umask(previous); }
    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout + result.stderr);
    const check = (uid, gid, operation) => spawnSync(process.execPath, ["-e",
      `require('node:fs').accessSync(process.argv[1],require('node:fs').constants.${operation})`, routeFile], { uid, gid });
    assert.equal(check(12345, 12346, "R_OK").status, 0, "Caddy can read its configuration");
    assert.notEqual(check(12345, 12346, "W_OK").status, 0, "Caddy cannot rewrite root-owned routes");
    assert.notEqual(check(12347, 12348, "R_OK").status, 0, "an unrelated user cannot read internal tokens");
    const details = await stat(routeFile);
    assert.equal(details.uid, 0);
    assert.equal(details.gid, 12346);
    assert.equal(details.mode & 0o777, 0o640);
  });
});


test("Caddy route permission repair refuses hard links without changing their other name", async () => {
  await withTempDir(async (dir) => {
    const { remoteRoot } = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(routeFile), { recursive: true });
    const other = path.join(dir, "private-other-file");
    await writeFile(other, "private fixture\n", { mode: 0o600 });
    await link(other, routeFile);
    const result = await runHostHelper({ action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" } }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal((await stat(other)).mode & 0o777, 0o600);
    assert.equal(await readFile(other, "utf8"), "private fixture\n");
  });
});


test("sporades host bind is a local-only project remote binding helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
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


test("sporades --version --host reports the Host server CLI version", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      profiles: {
        personal: {
          server: "root@203.0.113.10",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
          tls: { mode: "automatic" },
        },
      },
      currentHostAlias: "personal",
    });
    const fakeSsh = await installContractFakeSsh(
      dir,
      `
const request = JSON.parse(stdin);
if (request.action !== "host.version") {
  process.stderr.write("unexpected action " + request.action + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    version: "${rootPackageJson.version}",
    source: "host",
    host: {
      alias: request.host.alias,
      domain: request.host.domain
    }
  },
  error: null
}) + "\\n");
`,
    );

    const plain = await runCli(["--version", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, `${rootPackageJson.version}\n`);

    const json = await runCli(["-v", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      data: {
        version: rootPackageJson.version,
        source: "host",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
        },
      },
      error: null,
    });

    const calls = (await readFile(fakeSsh.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => JSON.parse(call.stdin).action), ["host.version", "host.version"]);
  });
});





test("first Host helper upgrade requires stable quiescence when a legacy action becomes identifiable after an empty proc scan", async () => {
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
    const DRAIN_SCAN = "SPORADES_FAKE_HOST_UPGRADE_DRAIN_SCAN_PAUSE_MS";
    const gate = await createHostPauseGate(dir);
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      ...gate.env(DRAIN_SCAN),
    };
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env });
    // Scan 1 found no legacy action. The action becomes identifiable before scan 2, so a drain that
    // finished on one empty snapshot would exit instead of reaching the gate after scan 2.
    await gate.entered(DRAIN_SCAN, { action: upgrade });
    await writeFakeProcEntry(procRoot, 43001, target);
    await gate.release(DRAIN_SCAN, 1);
    await gate.entered(DRAIN_SCAN, { visit: 2, action: upgrade });
    await rm(path.join(procRoot, "43001"), { recursive: true, force: true });
    await gate.open(DRAIN_SCAN);
    await gate.release(DRAIN_SCAN, 2);
    const result = await upgrade.result;
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });
});


test("sporades host health checks a Hosted Capsule runtime through the remote helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.health") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.health." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.health.hostedUrl,
      remoteCapsuleId: request.health.remoteCapsuleId,
      registered: true
    },
    release: { id: "20260703T120000Z-abc12345", current: true },
    container: { name: request.health.container.name, running: true },
    route: { url: request.health.runtimeHealthUrl, responding: true },
    runtime: {
      ready: true,
      checks: {
        sqlite: { ok: true },
        fileStorage: { ok: true }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });

    const health = await runCli(["host", "health", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(health.code, 0, health.stderr);
    assert.deepEqual(JSON.parse(health.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          registered: true,
        },
        release: { id: "20260703T120000Z-abc12345", current: true },
        container: { name: "sporades-capsules-example-dev-team-notes", running: true },
        route: {
          url: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
          responding: true,
        },
        runtime: {
          ready: true,
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
          },
        },
      },
      error: null,
    });

    const explicitHealth = await runCli(["host", "health", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
    assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));

    const [sshCall, explicitSshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.health",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      health: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        runtimeHealthUrl: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
    assert.deepEqual(JSON.parse(explicitSshCall.stdin), JSON.parse(sshCall.stdin));
  });
});


test("sporades host health distinguishes unreachable, HTTP failure, and unexpected response shape", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const unreachablePort = await reserveUnusedPort();

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: `localhost:${unreachablePort}`,
          scheme: "http",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });
    const unreachable = await runCli(["host", "health", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(unreachable.code, 1);
    assert.deepEqual(JSON.parse(unreachable.stdout), {
      ok: false,
      data: {
        alias: "personal",
        healthUrl: `http://host.localhost:${unreachablePort}/__sporades/health`,
        failure: "unreachable",
      },
      error: {
        message: "Host server is unreachable.",
        hint: "Check DNS for the Host server health name, network connectivity, and whether the Host server is running.",
      },
    });

    await withHttpServer((request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"ok":false}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      const httpFailure = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(httpFailure.code, 1);
      assert.deepEqual(JSON.parse(httpFailure.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "tls-http",
          statusCode: 503,
        },
        error: {
          message: "Host server health returned an HTTP failure.",
          hint: "Check TLS mode, certificate configuration, Caddy, and the Host server health route.",
        },
      });
    });

    await withHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"version":"0.0.0"}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      const unexpectedShape = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(unexpectedShape.code, 1);
      assert.deepEqual(JSON.parse(unexpectedShape.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "unexpected-response",
          statusCode: 200,
        },
        error: {
          message: "Host server health response had an unexpected shape.",
          hint: "Run `sporades host bootstrap --host personal` and check the generated Host server health route.",
        },
      });
    });
  });
});


test("sporades host bootstrap enables one Hosted domain through the remote helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.bootstrap") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.bootstrap." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    bootstrapped: true,
    domain: request.host.domain,
    remoteRoot: request.host.remoteRoot,
    network: request.bootstrap.network,
    packages: request.bootstrap.substrate.packages,
    directories: request.bootstrap.directories,
    tls: request.bootstrap.tls,
    caddy: {
      managedInclude: request.bootstrap.caddy.managedInclude,
      globalConfigReplaced: false
    },
    preservedCapsules: true
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

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 0, bootstrap.stderr);

    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.tls, {
      mode: "automatic",
      directory: "/opt/sporades/hosts/capsules.example.dev/tls",
      certificate: null,
      key: null,
    });
    assert.equal(output.data.caddy.managedInclude, "/opt/sporades/caddy/sporades-hosted-domains.caddy");
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.packages, ["docker", "caddy"]);
    assert.deepEqual(output.data.directories, {
      remoteRoot: "/opt/sporades",
      bin: "/opt/sporades/bin",
      incoming: "/opt/sporades/incoming",
      caddy: "/opt/sporades/caddy",
      caddyHosts: "/opt/sporades/caddy/hosts",
      hosts: "/opt/sporades/hosts",
      domain: "/opt/sporades/hosts/capsules.example.dev",
      tls: "/opt/sporades/hosts/capsules.example.dev/tls",
      registry: "/opt/sporades/hosts/capsules.example.dev/registry",
      capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
    });
    assert.equal(output.data.preservedCapsules, true);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot: "/opt/sporades",
          bin: "/opt/sporades/bin",
          incoming: "/opt/sporades/incoming",
          caddy: "/opt/sporades/caddy",
          caddyHosts: "/opt/sporades/caddy/hosts",
          hosts: "/opt/sporades/hosts",
          domain: "/opt/sporades/hosts/capsules.example.dev",
          tls: "/opt/sporades/hosts/capsules.example.dev/tls",
          registry: "/opt/sporades/hosts/capsules.example.dev/registry",
          capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
        },
        domainDirectory: "/opt/sporades/hosts/capsules.example.dev",
        tls: {
          mode: "automatic",
          directory: "/opt/sporades/hosts/capsules.example.dev/tls",
          certificate: null,
          key: null,
        },
        caddy: {
          managedInclude: "/opt/sporades/caddy/sporades-hosted-domains.caddy",
          domainInclude: "/opt/sporades/caddy/hosts/capsules.example.dev.caddy",
        },
      },
    });
  });
});


test("sporades host helper reads configurable production defaults from remoteRoot JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(
      path.join(remoteRoot, "sporades-host-helper.json"),
      `${JSON.stringify(
        {
          hostedCapsule: {
            dockerNetwork: "sporades-custom-network",
          },
          logs: {
            defaultLines: 2,
            maxLines: 50,
          },
        },
        null,
        2,
      )}\n`,
    );

    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const bootstrap = await runHostHelper(
      {
        action: "host.bootstrap",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env },
    );

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.deepEqual(JSON.parse(bootstrap.stdout).data.network, {
      name: "sporades-custom-network",
      created: true,
    });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args).slice(0, 2),
      [
        ["network", "inspect", "sporades-custom-network"],
        ["network", "create", "sporades-custom-network"],
      ],
    );

    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await writeFile(accessLog, ["old", "one", "two"].join("\n") + "\n");
    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["one", "two"],
      },
      error: null,
    });

    const explicitLogs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 1 },
      },
      { cwd: dir },
    );

    assert.equal(explicitLogs.code, 0, explicitLogs.stderr);
    assert.deepEqual(JSON.parse(explicitLogs.stdout), {
      ok: true,
      data: {
        lineCount: 1,
        source: "http",
        entries: ["two"],
      },
      error: null,
    });
  });
});


test("sporades host helper returns a structured error for invalid config JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(path.join(remoteRoot, "sporades-host-helper.json"), "{ nope\n");

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host helper config is invalid JSON.",
        hint: `Fix ${path.join(remoteRoot, "sporades-host-helper.json")}, then retry the Host helper command.`,
      },
    });
  });
});


test("sporades host helper reports Docker and Caddy bootstrap substrate failures as JSON errors", async () => {
  await withTempDir(async (dir) => {
    const dockerFailureRoot = path.join(dir, "docker-failure-root");
    const docker = await installFakeDocker(path.join(dir, "docker-failure"), {
      env: {
        FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1",
        FAKE_DOCKER_NETWORK_CREATE_STATUS: "1",
      },
    });
    const baseRequest = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: dockerFailureRoot,
      },
      capsule: null,
      bootstrap: {
        tls: { mode: "automatic", directory: path.join(dockerFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        network: "sporades-hosted-capsules",
      },
    };

    const dockerFailure = await runHostHelper(baseRequest, { cwd: dir, env: docker.env });

    assert.equal(dockerFailure.code, 0, dockerFailure.stderr);
    const dockerFailureOutput = JSON.parse(dockerFailure.stdout);
    assert.equal(dockerFailureOutput.ok, false);
    assert.equal(dockerFailureOutput.error.message, "Failed to create the Hosted Capsule Docker network.");
    assert.match(dockerFailureOutput.error.hint, /Check Docker on the Host server/);

    const caddyFailureRoot = path.join(dir, "caddy-failure-root");
    const caddy = await installFakeDocker(path.join(dir, "caddy-failure"), {
      env: {
        FAKE_DOCKER_CADDY_VALIDATE_STATUS: "1",
      },
    });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-failure-user"));
    const caddyFailureEnv = {
      ...caddy.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const caddyFailure = await runHostHelper(
      {
        ...baseRequest,
        host: { ...baseRequest.host, remoteRoot: caddyFailureRoot },
        bootstrap: {
          tls: { mode: "automatic", directory: path.join(caddyFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
          network: "sporades-hosted-capsules",
        },
      },
      { cwd: dir, env: caddyFailureEnv },
    );

    assert.equal(caddyFailure.code, 0, caddyFailure.stderr);
    const caddyFailureOutput = JSON.parse(caddyFailure.stdout);
    assert.equal(caddyFailureOutput.ok, false);
    assert.equal(caddyFailureOutput.error.message, "Failed to validate the Sporades Caddy bootstrap configuration.");
    assert.match(caddyFailureOutput.error.hint, /Check Caddy on the Host server/);
  });
});


test("sporades host bootstrap revalidates the trusted chain immediately before atomic publication", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const marker = path.join(dir, "bootstrap-boundary.marker");
    const outside = path.join(dir, "outside");
    const domainDirectory = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev");
    const preservedDirectory = `${domainDirectory}.preserved`;
    await mkdir(outside, { mode: 0o700 });
    const sentinel = path.join(outside, "sentinel.bin");
    await writeFile(sentinel, Buffer.from([9, 8, 7, 6, 5, 4]));
    const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const gate = await createHostPauseGate(dir);
    const action = startHostHelper({
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, {
      cwd: dir,
      env: {
        ...docker.env,
        ...caddyUser.env,
        PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-health-route-publish",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        ...gate.env("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS"),
      },
    });
    await waitForPath(marker);
    await gate.entered("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS", { action });
    await rename(domainDirectory, preservedDirectory);
    await symlink(outside, domainDirectory, "dir");
    await gate.release("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before);
    assert.deepEqual(await readdir(outside), ["sentinel.bin"]);
  });
});


test("sporades host bootstrap keeps privileged access-log repair on retained inodes when Caddy replaces the pathname", async (t) => {
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
    const initial = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(initial.stdout).ok, true, initial.stdout);

    const logFile = path.join(remoteRoot, "caddy", "logs", "access.log");
    const retainedLogFile = `${logFile}.retained`;
    await chmod(logFile, 0o600);
    const outside = path.join(dir, "outside.bin");
    await writeFile(outside, Buffer.from([4, 8, 15, 16, 23, 42]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
    const marker = path.join(dir, "descriptor-boundary.marker");
    const gate = await createHostPauseGate(dir);
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...env,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-access-log-descriptor-mutate",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        ...gate.env("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS"),
      },
    });
    await waitForPath(marker);
    await gate.entered("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS", { action });
    await rename(logFile, retainedLogFile);
    await symlink(outside, logFile);
    await gate.release("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);

    const outsideAfter = await lstat(outside);
    assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash);
    assert.equal(Number(outsideAfter.mode) & 0o777, Number(outsideBefore.mode) & 0o777);
    assert.deepEqual([Number(outsideAfter.uid), Number(outsideAfter.gid)], [Number(outsideBefore.uid), Number(outsideBefore.gid)]);
    assert.equal(Number((await lstat(retainedLogFile)).mode) & 0o777, 0o640, "repair stayed on the retained file descriptor");
    assert.deepEqual(await caddyUser.chownCalls(), []);
  });
});


test("sporades host helper registers Hosted Capsules with registry state and unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const request = {
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
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
          logs: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 418,
          routeFile: path.join(dir, "caller-controlled", "team-notes.caddy"),
          tls: {
            mode: "cloudflare-origin",
            directory: path.join(dir, "caller-controlled", "tls"),
            certificate: path.join(dir, "caller-controlled", "tls", "origin.crt"),
            key: path.join(dir, "caller-controlled", "tls", "origin.key"),
          },
        },
      },
    };
    const expectedRoute = {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy"),
      tls: {
        mode: "automatic",
        directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
        certificate: null,
        key: null,
      },
      log: { file: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log") },
    };

    const register = await runHostHelper(request, { cwd: dir, env: caddy.env });

    assert.equal(register.code, 0, register.stderr);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.registered, true);
    assert.equal(output.data.authoritative, true);
    assert.deepEqual(output.data.capsule, {
      canonicalDomain: null,
      publicOrigin: "https://team-notes.capsules.example.dev",
      aliasDomains: [],
      aliasUrls: [],
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.registryRecord, request.registration.registryRecord);
    assert.deepEqual(output.data.directories, request.registration.directories);
    assert.deepEqual(output.data.route, expectedRoute);
    assert.equal(typeof output.data.sealedServerEnv.publicKey, "string");
    assert.match(output.data.sealedServerEnv.publicKey, /PUBLIC KEY/);
    assert.match(output.data.sealedServerEnv.publicKeyFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(
      output.data.sealedServerEnv.publicKeyPath,
      path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data", "sealed-server-env", "keys", `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`),
    );
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE KEY/);

    const record = JSON.parse(await readFile(request.registration.registryRecord, "utf8"));
    assert.equal(record.subname, "team-notes");
    assert.equal(record.domain, "capsules.example.dev");
    assert.equal(record.remoteCapsuleId, "capsules.example.dev/team-notes");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.status, "registered");
    assert.equal(record.currentRelease, null);
    assert.deepEqual(record.sealedServerEnv, {
      currentKeyFingerprint: output.data.sealedServerEnv.publicKeyFingerprint,
    });
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.updatedAt, record.createdAt);
    assert.equal((await stat(request.registration.directories.releases)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.data)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.logs)).isDirectory(), true);
    const privateKeyPath = path.join(
      request.registration.directories.data,
      "sealed-server-env",
      "keys",
      `${output.data.sealedServerEnv.publicKeyFingerprint}.private.pem`,
    );
    const publicKeyPath = path.join(
      request.registration.directories.data,
      "sealed-server-env",
      "keys",
      `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`,
    );
    assert.match(await readFile(privateKeyPath, "utf8"), /PRIVATE KEY/);
    assert.equal(await readFile(publicKeyPath, "utf8"), output.data.sealedServerEnv.publicKey);
    assert.equal((await stat(path.dirname(path.dirname(privateKeyPath)))).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(privateKeyPath))).mode & 0o777, 0o700);
    assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(publicKeyPath)).mode & 0o777, 0o644);
    const originalPrivateKey = await readFile(privateKeyPath, "utf8");
    const routeContents = await readFile(expectedRoute.routeFile, "utf8");
    assert.match(routeContents, /team-notes\.capsules\.example\.dev/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.match(routeContents, /hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log/);
    assert.doesNotMatch(routeContents, /418|caller-controlled|tls /);
    await assert.rejects(readFile(request.registration.route.routeFile, "utf8"), { code: "ENOENT" });
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${expectedRoute.routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );

    const duplicateDocker = await installFakeDocker(path.join(dir, "duplicate-docker"));
    const duplicate = await runHostHelper(request, {
      cwd: dir,
      env: {
        ...caddy.env,
        ...duplicateDocker.env,
        PATH: `${duplicateDocker.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(await readFile(privateKeyPath, "utf8"), originalPrivateKey);
    assert.equal(JSON.parse(await readFile(request.registration.registryRecord, "utf8")).sealedServerEnv.currentKeyFingerprint, output.data.sealedServerEnv.publicKeyFingerprint);
    assert.deepEqual(JSON.parse(duplicate.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });
    await assert.rejects(readFile(duplicateDocker.logPath, "utf8"), { code: "ENOENT" });

    const otherDomainRoot = path.join(dir, "other-domain-root");
    await mkdir(path.join(otherDomainRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(otherDomainRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test.caddy"), "import ./apps.work.test/*.caddy\n");
    const otherDomainRequest = {
      ...request,
      host: {
        ...request.host,
        domain: "apps.work.test",
        remoteRoot: otherDomainRoot,
      },
      registration: {
        ...request.registration,
        domain: "apps.work.test",
        hostedUrl: "https://team-notes.apps.work.test",
        remoteCapsuleId: "apps.work.test/team-notes",
        registryRecord: path.join(otherDomainRoot, "hosts", "apps.work.test", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes"),
          releases: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "releases"),
          data: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "data"),
        },
        route: {
          ...request.registration.route,
          hostname: "team-notes.apps.work.test",
          routeFile: path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test", "team-notes.caddy"),
          tls: {
            mode: "automatic",
            directory: path.join(otherDomainRoot, "hosts", "apps.work.test", "tls"),
            certificate: null,
            key: null,
          },
        },
      },
    };

    const sameSubnameOtherDomain = await runHostHelper(otherDomainRequest, { cwd: dir, env: caddy.env });
    assert.equal(sameSubnameOtherDomain.code, 0, sameSubnameOtherDomain.stderr);
    assert.equal(JSON.parse(sameSubnameOtherDomain.stdout).data.capsule.remoteCapsuleId, "apps.work.test/team-notes");
  });
});


test("sporades host helper restores the exact pre-rotation running state", async () => {
  for (const [label, running] of [["running", true], ["stopped", false]]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: String(running) } });
      const result = await runHostHelper({
        action: "capsule.sealed-env.rotate-key",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "team-notes" },
      }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(result.stdout).ok, true, `${label}: ${result.stdout}\n${result.stderr}\n${JSON.stringify(await docker.calls())}`);
      const calls = (await docker.calls()).map((call) => call.args[0]);
      if (running) {
        assert.deepEqual(calls, ["inspect", "stop", "rm", "image", "run", "inspect", "inspect", "inspect", "exec", "inspect", "inspect"], label);
        assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      } else {
        assert.deepEqual(calls, ["inspect"], label);
        assert.notEqual(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      }
    });
  }
});


test("sporades host helper descriptor-fences sealed-env key creation after quiescing Docker", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const outside = path.join(dir, "outside-key.bin");
    await writeFile(outside, Buffer.from([4, 2, 4, 2]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
    const marker = path.join(dir, "sealed-key.marker");
    const request = {
      action: "capsule.sealed-env.rotate-key",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
    };
    const gate = await createHostPauseGate(dir);
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_BOUNDARY: "runtime-data-descriptor-mutate",
        SPORADES_TEST_RUNTIME_DATA_MUTATION_MARKER: marker,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_TARGET_SUFFIX: ".private.pem",
        ...gate.env("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS"),
      },
    });
    try {
      const keyPath = (await waitForHostHelperMarker(action, marker, (contents) => contents.endsWith(".private.pem\n"))).trim();
      await gate.entered("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS", { action });
      assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["inspect", "stop", "rm"]);
      const retained = `${keyPath}.retained`;
      await rename(keyPath, retained);
      await symlink(outside, keyPath);
      await gate.release("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS");
      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule runtime restoration failed.", result.stdout);
      assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "stopped");
      const outsideAfter = await lstat(outside);
      assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash);
      assert.deepEqual([outsideAfter.mode & 0o777, outsideAfter.uid, outsideAfter.gid], [outsideBefore.mode & 0o777, outsideBefore.uid, outsideBefore.gid]);
      assert.match(await readFile(retained, "utf8"), /PRIVATE KEY/);
    } finally {
      action.child.kill("SIGKILL");
      await action.result;
    }

    await rm(path.join(fixture.dataDir, "sealed-server-env"), { recursive: true, force: true });
    const outsideDirectory = path.join(dir, "outside-key-directory");
    const sentinel = path.join(outsideDirectory, "sentinel.bin");
    await mkdir(outsideDirectory);
    await writeFile(sentinel, Buffer.from([1, 6, 1, 8]), { mode: 0o604 });
    const sentinelHash = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    await symlink(outsideDirectory, path.join(fixture.dataDir, "sealed-server-env"));
    const ancestor = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(ancestor.stdout).error.message, "Hosted Capsule runtime restoration failed.", ancestor.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), sentinelHash);
    assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"]);
  });
});


test("sporades host rotate-key invokes the Hosted Capsule sealed-env rotation helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.sealed-env.rotate-key") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.sealed-env.rotate-key." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    rotated: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://" + request.capsule.subname + "." + request.host.domain
    },
    sealedServerEnv: {
      previousPublicKeyFingerprint: "0123456789abcdef",
      publicKeyFingerprint: "fedcba9876543210",
      publicKey: "-----BEGIN PUBLIC KEY-----\\\\nrotated\\\\n-----END PUBLIC KEY-----\\\\n",
      publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/fedcba9876543210.public.pem"
    },
    cleanup: {
      deletedKeyFingerprints: ["9999999999999999"],
      retainedKeyFingerprints: ["0123456789abcdef", "fedcba9876543210"]
    }
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

    const env = { ...hostEnv(configDir), ...fakeSsh.env };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const rotate = await runCli(["host", "rotate-key", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env,
    });
    assert.equal(rotate.code, 0, rotate.stderr);
    const output = JSON.parse(rotate.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rotated, true);
    assert.equal(output.data.sealedServerEnv.previousPublicKeyFingerprint, "0123456789abcdef");
    assert.equal(output.data.sealedServerEnv.publicKeyFingerprint, "fedcba9876543210");

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.sealed-env.rotate-key",
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


test("sporades host push automatically re-encrypts Sealed Server env to the Hosted Capsule public key", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const hostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const hostPublicKeyFingerprint = createHash("sha256").update(hostKeyPair.publicKey).digest("hex").slice(0, 16);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action === "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      capsules: [{
        subname: "team-notes",
        domain: request.host.domain,
        hostedUrl: "https://team-notes." + request.host.domain,
        sealedServerEnv: {
          publicKey: process.env.FAKE_HOST_PUBLIC_KEY,
          publicKeyFingerprint: process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT,
          publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/" + process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT + ".public.pem"
        }
      }]
    },
    error: null
  }) + "\\n");
  process.exit(0);
}
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded,
      sealedServerEnvIncluded: request.release.sealedServerEnvIncluded,
      sealedServerEnv: request.release.sealedServerEnv
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "sealed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "sealed-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\nPUBLIC_LABEL=not-client\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      FAKE_HOST_PUBLIC_KEY: hostKeyPair.publicKey,
      FAKE_HOST_PUBLIC_KEY_FINGERPRINT: hostPublicKeyFingerprint,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
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
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.doesNotMatch(push.stdout, /swordfish|not-client|PRIVATE KEY/);
    const output = JSON.parse(push.stdout);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.equal(output.data.release.sealedServerEnv.publicKeyFingerprint, hostPublicKeyFingerprint);
    assert.equal(output.data.release.sealedServerEnv.privateKey, undefined);
    assert.equal(output.data.release.sealedServerEnv.privateKeyPath, undefined);
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      ".sporades/sealed-server-env/server-env.sealed.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    const archiveEnvelope = await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xOzf", scpCall.copiedTo, ".sporades/sealed-server-env/server-env.sealed.json"], {
        cwd: projectDir,
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
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    assert.doesNotMatch(archiveEnvelope, /swordfish|not-client|PRIVATE KEY/);
    assert.equal(JSON.parse(archiveEnvelope).publicKeyFingerprint, hostPublicKeyFingerprint);

    const [listCall, installCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(listCall.stdin).action, "capsule.list");
    const request = JSON.parse(installCall.stdin);
    assert.equal(request.release.sealedServerEnvIncluded, true);
    assert.equal(request.release.sealedServerEnv.publicKeyFingerprint, hostPublicKeyFingerprint);
    assert.equal(request.release.sealedServerEnv.privateKey, undefined);
    assert.equal(request.release.sealedServerEnv.privateKeyPath, undefined);
    assert.doesNotMatch(JSON.stringify(request.release), /swordfish|not-client|PRIVATE KEY/);
  });
});


test("sporades host push --verify requests Hosted Capsule restart and release verification", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install" || request.release.restart !== true || !request.verification) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected verification request.", hint: "Use capsule.release.install with verification." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: true,
    restarted: true,
    verified: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      current: true
    },
    previousCurrentRelease: { id: "20260629T120000Z-deadbeef" },
    currentAttemptedRelease: { id: request.release.id },
    verification: {
      state: "verified",
      health: {
        route: { responding: true },
        runtime: {
          ready: true,
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } }
        }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const projectConfigPath = path.join(projectDir, "sporades.json");
    const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
    projectConfig.baseImage = { updatePolicy: { mode: "manual" } };
    await writeFile(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(bind.code, 0, bind.stderr);

    const push = await runCli(["host", "push", "--verify", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.verification.state, "verified");
    assert.equal(output.data.verification.health.runtime.ready, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.previousCurrentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.currentAttemptedRelease.id, output.data.release.id);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.release.restart, true);
    assert.equal(request.release.baseImage.updatePolicy.mode, "manual");
    assert.equal(request.verification.enabled, true);
    assert.equal(request.verification.health.runtimeHealthUrl, "https://team-notes.capsules.example.dev/__sporades/health/runtime");
    assert.equal(request.lifecycle.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(request.lifecycle.container.baseImage.updatePolicy.mode, "manual");
    assert.equal(request.lifecycle.container.labels["com.sporades.base-image.update-policy"], "manual");
  });
});


test("sporades host start stop and restart invoke the Hosted Capsule lifecycle helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    action: request.action,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.lifecycle.hostedUrl
    },
    container: request.lifecycle.container,
    route: request.lifecycle.routes[request.action === "capsule.stop" ? "unavailable" : "running"]
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

    const start = await runCli(["host", "start", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(start.code, 0, start.stderr);
    const startOutput = JSON.parse(start.stdout);
    assert.equal(startOutput.data.action, "capsule.start");
    assert.equal(startOutput.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.managed"], "true");
    assert.equal(startOutput.data.container.labels["com.sporades.hosted-domain"], "capsules.example.dev");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-subname"], "team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-id"], "capsules.example.dev/team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.name"], "sporades-base");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.version"], "0.3.0-node24-alpine");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.update-policy"], "host-managed");
    assert.deepEqual(startOutput.data.container.baseImage, {
      name: "sporades-base",
      image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      version: "0.3.0-node24-alpine",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
    assert.equal(startOutput.data.route.target, "container");

    const stop = await runCli(["host", "stop", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.action, "capsule.stop");
    assert.equal(JSON.parse(stop.stdout).data.route.target, "hosted-capsule-unavailable");

    const restart = await runCli(["host", "restart", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(restart.code, 0, restart.stderr);
    assert.equal(JSON.parse(restart.stdout).data.action, "capsule.restart");

    const reconcile = await runCli(["host", "reconcile", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(reconcile.code, 0, reconcile.stderr);
    assert.equal(JSON.parse(reconcile.stdout).data.action, "capsule.release.reconcile");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(
      calls.map((call) => JSON.parse(call.stdin).action),
      ["capsule.start", "capsule.stop", "capsule.restart", "capsule.release.reconcile"],
    );
    const startRequest = JSON.parse(calls[0].stdin);
    assert.equal(startRequest.lifecycle.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(startRequest.lifecycle.mounts.files, [
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/public", container: "/app/public", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server",
        container: "/app/.env.sporades.server",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
        container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
        container: "/app/.sporades/sealed-server-env/server-env.private.pem",
        mode: "ro",
        optional: true,
      },
    ]);
    assert.deepEqual(startRequest.lifecycle.mounts.data, {
      host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
      container: "/app/data",
      mode: "rw",
    });
    assert.equal(startRequest.lifecycle.container.image, "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine");
    assert.equal(startRequest.lifecycle.container.user, "10001:10001");
    assert.deepEqual(startRequest.lifecycle.container.baseImage, {
      name: "sporades-base",
      image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      version: "0.3.0-node24-alpine",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
  });
});


test("sporades host helper extracts the atomically claimed archive when the incoming path is swapped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "archive-swap", previousReleaseId: null });
    fixture.release.restart = false;
    const maliciousDir = path.join(dir, "malicious-runtime");
    for (const file of fixture.release.files) {
      const target = path.join(maliciousDir, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file === "public/index.html" ? '<script src="/assets/evil.js"></script>\n' : "malicious replacement bytes\n");
    }
    const maliciousArchive = path.join(dir, "malicious-swap.tar.gz");
    await createTarGz(maliciousArchive, maliciousDir, fixture.release.files);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
      },
      { cwd: dir, env: { SPORADES_TEST_HOST_ARCHIVE_SWAP_PATH: maliciousArchive } },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).ok, true, install.stdout);
    const installed = path.join(fixture.capsuleDir, "releases", fixture.releaseId);
    assert.match(await readFile(path.join(installed, "public", "assets", "app-a1b2.js"), "utf8"), /client bundle/);
    assert.doesNotMatch(await readFile(path.join(installed, "public", "index.html"), "utf8"), /evil\.js/);
    await assert.rejects(stat(fixture.archivePath), { code: "ENOENT" });
    await assert.rejects(stat(maliciousArchive), { code: "ENOENT" });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), installed);
  });
});


test("sporades host helper rejects non-canonical Sealed Server env private key paths", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const escapedPrivateKeyPath = path.join(dir, "escaped-private.pem");
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "{\"version\":1,\"valueAlgorithm\":\"aes-256-gcm\",\"entries\":{}}\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            privateKey: "-----BEGIN PRIVATE KEY-----\\nnot-real\\n-----END PRIVATE KEY-----\\n",
            privateKeyPath: escapedPrivateKeyPath,
          },
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
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
        message: "Invalid Sealed Server env private key path.",
        hint: "Update the Sporades CLI and retry `sporades host push`.",
      },
    });
    await assert.rejects(readFile(escapedPrivateKeyPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(capsuleDir, "current"), "utf8"), { code: "ENOENT" });
  });
});


test("sporades host helper leaves the legacy key and running release exact on a no-restart sealed install", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-no-restart", restart: false });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.dev, keyStatAfter.ino, keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.dev, keyStatBefore.ino, keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readFile(fixture.nextPrivateKeyPath, "utf8"), "next private key bytes\n");
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.deepEqual(record.releases.find((release) => release.id === fixture.releaseId).source.sealedServerEnv, {
      publicKeyFingerprint: fixture.nextKeyFingerprint,
      suppliedPrivateKey: true,
    });
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
  });
});


test("sporades host helper restores an absent route when a stopped prior runtime remains stopped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "stopped-install-rollback", restart: true });
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "stopped";
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    await rm(fixture.routeFile);
    const registryBefore = await readFile(fixture.registryRecordPath);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_RUN_STATUS: "1" },
    });

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle: fixture.lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    await assert.rejects(lstat(fixture.routeFile), { code: "ENOENT" });
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "run").length, 1);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});


test("sporades host helper rolls back a sealed install when release registry settlement fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-registry-failure", restart: false });
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const routeBefore = await readFile(fixture.routeFile);
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Failed to write Hosted Capsule registry record.", result.stdout);
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(fixture.routeFile), routeBefore);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.dev, keyStatAfter.ino, keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.dev, keyStatBefore.ino, keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});


test("sporades host helper starts public-key-only sealed releases with the release manifest fingerprint key", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const fingerprint = "0123456789abcdef";
    const currentRegistryFingerprint = "fedcba9876543210";
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(
      path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: fingerprint, entries: {} })}\n`,
    );
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(capsuleDir, "data", "sealed-server-env", "keys"), { recursive: true });
    await writeFile(path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`), "host-owned private key\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "registered",
        sealedServerEnv: { currentKeyFingerprint: currentRegistryFingerprint },
      })}\n`,
    );

    const docker = await installFakeDocker(dir);
    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            publicKeyFingerprint: fingerprint,
            publicKeyPath: path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.public.pem`),
          },
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
          baseImage: {
            name: "sporades-base",
            image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
            version: "0.3.0-node24-alpine",
            updatePolicy: { mode: "manual" },
          },
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
        lifecycle: buildHostLifecycle(remoteRoot, "capsules.example.dev", "team-notes"),
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.doesNotMatch(install.stdout, /PRIVATE KEY|host-owned private key/);

    const calls = await docker.calls();
    const runCall = calls.find((call) => call.args[0] === "run");
    assert(runCall);
    const privateKeyMount = `${path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`;
    assert(runCall.args.includes(privateKeyMount));
    assert(!runCall.args.includes(`${path.join(capsuleDir, "data", "sealed-server-env", "server-env.private.pem")}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".sporades", "sealed-server-env", "server-env.sealed.json")}:/app/.sporades/sealed-server-env/server-env.sealed.json:ro`));
    assert(runCall.args.includes("SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH=/app/.sporades/sealed-server-env/server-env.private.pem"));
    assert(runCall.args.includes("SPORADES_SEALED_SERVER_ENV_PATH=/app/.sporades/sealed-server-env/server-env.sealed.json"));

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, currentRegistryFingerprint);
    assert.equal(record.releases[0].source.sealedServerEnvIncluded, true);
    assert.deepEqual(record.releases[0].source.sealedServerEnv, { publicKeyFingerprint: fingerprint });
  });
});


test("sporades host helper marks previous releases non-current and records start attempts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
        ],
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260629T120000Z-deadbeef", state: "uploaded", current: false },
        { id: "20260630T221500Z-feedface", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
    assert.match(record.releases[1].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});


test("Hosted Capsule restart never publishes a running route before authenticated runtime readiness", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "restart-runtime-readiness", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: {
        FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{ status: 503, body: { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: false } } }, error: null } }]),
        FAKE_DOCKER_RUNTIME_PROBE_OBSERVATION: path.join(dir, "readiness-observation.json"),
        FAKE_DOCKER_RUNTIME_PROBE_ROUTE: fixture.routeFile,
        FAKE_DOCKER_RUNTIME_PROBE_REGISTRY: fixture.registryRecordPath,
      },
    });
    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
      verification: { healthTimeoutMs: 25 },
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.error.message, "Hosted Capsule restart failed.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.notEqual(record.status, "running");
    assert((await docker.calls()).some((call) => call.args[0] === "exec"), "authenticated runtime probe was not attempted");
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "readiness-observation.json"), "utf8")), { routeRunning: false, registryStatus: "running" });
  });
});


test("Hosted Capsule startup distinguishes delayed readiness, probe authentication failure, and exit during initialization", async () => {
  const readyBody = { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: true } } }, error: null };
  const startingBody = { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: false } } }, error: null };
  for (const scenario of ["delayed", "authentication", "exit"]) await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: `runtime-readiness-${scenario}`, restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    if (scenario === "delayed") {
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8")); record.status = "released";
      await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    const results = scenario === "delayed"
      ? [{ status: 503, body: startingBody }, { status: 200, body: readyBody }]
      : scenario === "authentication" ? [{ status: 404, body: startingBody }] : [{ status: 503, body: startingBody }];
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
      FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify(results),
      ...(scenario === "delayed" ? {
        FAKE_DOCKER_RUNTIME_PROBE_OBSERVATION: path.join(dir, "readiness-observation.json"),
        FAKE_DOCKER_RUNTIME_PROBE_ROUTE: fixture.routeFile,
        FAKE_DOCKER_RUNTIME_PROBE_REGISTRY: fixture.registryRecordPath,
      } : {}),
      ...(scenario === "exit" ? { FAKE_DOCKER_RUNNING_VALUES: "true,true,false" } : {}),
    } });
    const result = await runHostHelper({ action: "capsule.start", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, lifecycle, verification: { healthTimeoutMs: scenario === "delayed" ? 5000 : 500 } }, { cwd: dir, env: docker.env });
    const output = JSON.parse(result.stdout); const calls = await docker.calls(); const probes = calls.filter((call) => call.args[0] === "exec");
    if (scenario === "delayed") {
      assert.equal(output.ok, true, result.stdout); assert.equal(probes.length, 2); assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
      assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, "readiness-observation.json"), "utf8")), { routeRunning: false, registryStatus: "released" });
    } else {
      assert.equal(output.ok, false, result.stdout); assert.equal(probes.length, 1); assert.match(await readFile(fixture.routeFile, "utf8"), /Hosted Capsule unavailable/);
      assert.notEqual(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
    }
    const recordText = await readFile(fixture.registryRecordPath, "utf8");
    assert.equal(result.stdout.includes(JSON.parse(recordText).runtimeProbe.token), false);
  });
});


test("Hosted Capsule startup rejects partial or malformed runtime bounds", async () => {
  const validRuntime = { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 };
  for (const { name, runtime } of [
    { name: "missing-file-max", runtime: { ready: true, httpMaxBodyBytes: validRuntime.httpMaxBodyBytes } },
    { name: "missing-http-max", runtime: { ready: true, fileMaxSizeBytes: validRuntime.fileMaxSizeBytes } },
    { name: "fractional-file-max", runtime: { ...validRuntime, fileMaxSizeBytes: 10.5 } },
    { name: "fractional-http-max", runtime: { ...validRuntime, httpMaxBodyBytes: 10.5 } },
    { name: "non-positive-file-max", runtime: { ...validRuntime, fileMaxSizeBytes: 0 } },
    { name: "non-positive-http-max", runtime: { ...validRuntime, httpMaxBodyBytes: -1 } },
    { name: "string-file-max", runtime: { ...validRuntime, fileMaxSizeBytes: "10485760" } },
    { name: "null-http-max", runtime: { ...validRuntime, httpMaxBodyBytes: null } },
  ]) await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: `runtime-readiness-${name}`, restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    // Classify one actual probe reply, without a final near-deadline mock-process
    // launch overwriting its invalid result with an unrelated connection timeout.
    const tick = path.join(dir, "probe-replied");
    const clock = path.join(dir, "readiness-clock.mjs");
    await writeFile(clock, `import { existsSync } from 'node:fs';
Object.defineProperty(globalThis, 'performance', { value: { now: () => existsSync(${JSON.stringify(tick)}) ? 10000 : 0 } });
`);
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
      FAKE_DOCKER_RUNTIME_PROBE_CLOCK_TICK_FILE: tick,
      FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{ status: 200, body: {
        ok: true,
        data: { runtime, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: true } } },
        error: null,
      } }]),
    } });

    const result = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
      // Classify the response after the process-based emulator has started.
      verification: { healthTimeoutMs: 5000 },
    }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, `${name}: ${result.stdout}`);
    assert.equal(output.error.message, "Hosted Capsule runtime did not become ready.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.releases.find((release) => release.id === record.currentRelease.id).failure.message, "Hosted Capsule runtime readiness failed (invalid).");
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, 1, `${name}: classify the authenticated probe response exactly once`);
  });
});


test("Hosted Capsule restart accepts only canonical persisted inspector metadata", async () => {
  const cases = [
    { name: "absent", inspection: undefined, longWindow: false },
    { name: "content-only", inspection: { requiredInspectors: ["content-policy-v1"] }, longWindow: false },
    { name: "clamav-only", inspection: { requiredInspectors: ["clamav"] }, longWindow: true },
    { name: "both", inspection: { requiredInspectors: ["content-policy-v1", "clamav"] }, longWindow: true },
    { name: "unknown", inspection: { requiredInspectors: ["unknown"] }, longWindow: true },
    { name: "empty-string", inspection: { requiredInspectors: [""] }, longWindow: true },
    { name: "duplicate-content", inspection: { requiredInspectors: ["content-policy-v1", "content-policy-v1"] }, longWindow: true },
    { name: "duplicate-clamav", inspection: { requiredInspectors: ["clamav", "clamav"] }, longWindow: true },
    { name: "mixed-duplicate", inspection: { requiredInspectors: ["content-policy-v1", "clamav", "content-policy-v1"] }, longWindow: true },
    { name: "too-many", inspection: { requiredInspectors: Array.from({ length: 9 }, (_, index) => `unknown-${index}`) }, longWindow: true },
    { name: "empty-array", inspection: { requiredInspectors: [] }, longWindow: true },
    { name: "non-string", inspection: { requiredInspectors: [1] }, longWindow: true },
    { name: "object", inspection: { requiredInspectors: {} }, longWindow: true },
    { name: "missing-list", inspection: {}, longWindow: true },
    { name: "null", inspection: null, longWindow: true },
    { name: "array", inspection: [], longWindow: true },
  ];
  for (const scenario of cases) await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: `restart-inspection-${scenario.name}`, restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    if (scenario.inspection === undefined) delete record.releases[0].source.inspection;
    else record.releases[0].source.inspection = scenario.inspection;
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const clock = path.join(dir, "stepping-monotonic-clock.mjs");
    await writeFile(clock, "let now = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => { const current = now; now += 20000; return current; } } });\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const result = await runHostHelper({ action: "capsule.restart", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, lifecycle }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } });
    assert.equal(JSON.parse(result.stdout).ok, scenario.longWindow, `${scenario.name}: ${result.stdout}`);
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, scenario.longWindow ? 1 : 0, scenario.name);
  });
});


test("sporades host helper checks Hosted Capsule runtime health with a Host-owned probe credential", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], "a".repeat(64));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true, fileMaxSizeBytes: 7_654_321, httpMaxBodyBytes: 1_234_567 },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
              fileInspection: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
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
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          capsule: {
            subname: "team-notes",
            domain,
            hostedUrl,
            remoteCapsuleId: `${domain}/team-notes`,
            registered: true,
          },
          release: { id: "20260630T221500Z-feedface", current: true },
          container: { name: "sporades-capsules-example-dev-team-notes", running: true },
          route: {
            url: `${hostedUrl}/__sporades/health/runtime`,
            responding: true,
          },
          runtime: {
            ready: true,
            fileMaxSizeBytes: 7_654_321,
            httpMaxBodyBytes: 1_234_567,
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
              fileInspection: { ok: true },
            },
          },
        },
        error: null,
      });
      assert.equal(health.stdout.includes("a".repeat(64)), false);
    });
  });
});


test("sporades host helper serializes two stale health route repairs across helper processes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
        FAKE_DOCKER_CADDY_DELAY_MS: "100",
      },
    });

    await withHttpServer((_request, response) => {
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
        `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\nfourteen.example {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`,
      );
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          aliasDomains: ["fourteen.example"],
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "a".repeat(64) },
        })}\n`,
      );
      const request = {
        action: "capsule.health",
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      await writeFile(
        `${routeFile}.lock`,
        `${JSON.stringify({
          token: "d".repeat(32),
          pid: 999999,
          processIdentity: "dead-route-owner",
          createdAt: Date.now() - 60_000,
        })}\n`,
      );
      const deadReclaimGuard = `${routeFile}.lock.reclaim-${"a".repeat(32)}`;
      await writeFile(
        deadReclaimGuard,
        `${JSON.stringify({
          token: "a".repeat(32),
          pid: 999999,
          processIdentity: "dead-reclaim-guard",
          createdAt: Date.now() - 60_000,
        })}\n`,
      );

      const results = await Promise.all([
        runHostHelper(request, { cwd: dir, env: docker.env }),
        runHostHelper(request, { cwd: dir, env: docker.env }),
      ]);

      for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
      }
      const route = await readFile(routeFile, "utf8");
      assert.equal((route.match(/reverse_proxy 127\.0\.0\.1:49154/g) ?? []).length, 2);
      assert.ok(route.includes("fourteen.example {\n"));
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      assert.deepEqual(
        (await docker.caddyCalls()).map((call) => call.args),
        [
          ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
          ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ],
        "the second helper must re-read the winner and avoid another Caddy reload",
      );
      const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
      assert.deepEqual(debris, []);
    });
  });
});








test("sporades host helper rejects a lifecycle route that does not match the canonical Capsule lock identity", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const canonicalRoute = fixture.routeFile;
    const foreignRoute = path.join(path.dirname(canonicalRoute), "other-capsule.caddy");
    await writeFile(foreignRoute, "other-capsule.capsules.example.dev {\n  respond 418\n}\n");
    const mismatched = structuredClone(fixture.request);
    mismatched.lifecycle.routes.unavailable.routeFile = foreignRoute;
    const result = await runHostHelper(mismatched, { cwd: dir, env: fixture.docker.env });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.error.message, "Invalid Hosted Capsule lifecycle authority.");
    assert.equal(await readFile(foreignRoute, "utf8"), "other-capsule.capsules.example.dev {\n  respond 418\n}\n");
    assert.match(await readFile(canonicalRoute, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});


test("sporades host helper rejects traversal and Caddy-injection route identities before filesystem mutation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const cases = [
      { field: "remoteRoot", value: "relative/root" },
      { field: "remoteRoot", value: `${fixture.request.host.remoteRoot}/../escaped-root` },
      { field: "domain", value: "../escaped.example" },
      { field: "domain", value: "capsules.example.dev\nmalicious.example { respond 200 }" },
      { field: "domain", value: "capsules.example.dev:0" },
      { field: "domain", value: "capsules.example.dev:65536" },
      { field: "subname", value: "../other-capsule" },
      { field: "subname", value: "team-notes\nrespond 200" },
    ];
    for (const attack of cases) {
      const request = structuredClone(fixture.request);
      request.lifecycle = {};
      if (attack.field === "subname") request.capsule.subname = attack.value;
      else request.host[attack.field] = attack.value;
      const result = await runHostHelper(request, { cwd: dir, env: fixture.docker.env });
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false, `${attack.field}=${JSON.stringify(attack.value)}: ${result.stdout}`);
      assert.equal(output.error.message, "Invalid Hosted Capsule route identity.");
    }
    assert.deepEqual((await readdir(path.dirname(fixture.routeFile))).sort(), ["team-notes.caddy"]);
  });
});


test("sporades host helper rejects a symlink above remoteRoot without resolving away its lexical parent", async () => {
  await withTempDir(async (dir) => {
    const attackerParent = path.join(dir, "attacker-parent");
    const trustedTarget = path.join(dir, "trusted-target");
    const outside = path.join(trustedTarget, "outside.bin");
    await mkdir(attackerParent, { mode: 0o700 });
    await mkdir(trustedTarget, { mode: 0o700 });
    await writeFile(outside, Buffer.from([3, 1, 4, 1, 5, 9]));
    const before = createHash("sha256").update(await readFile(outside)).digest("hex");
    await symlink(trustedTarget, path.join(attackerParent, "link"), "dir");
    const remoteRoot = path.join(attackerParent, "link", "sporades");
    const result = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), before);
    await assert.rejects(lstat(path.join(trustedTarget, "sporades")), { code: "ENOENT" });
  });
});


test("sporades host helper revalidates trust immediately before apply and rollback route mutations", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      { boundary: "apply-remove-temp", dockerEnv: {} },
      { boundary: "apply-remove-previous", dockerEnv: {} },
      { boundary: "apply-write-temp", dockerEnv: {} },
      { boundary: "apply-validation-cleanup", dockerEnv: { FAKE_DOCKER_CADDY_VALIDATE_STATUS: "1" } },
      { boundary: "apply-move-current", dockerEnv: {} },
      { boundary: "apply-publish-temp", dockerEnv: {} },
      { boundary: "apply-rollback-remove-temp", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-rollback-remove-current", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-rollback-restore", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-finalize-previous", dockerEnv: {} },
    ];
    for (const scenario of cases) {
      const boundary = scenario.boundary;
      const caseRoot = path.join(dir, boundary);
      await mkdir(caseRoot, { recursive: true });
      const marker = path.join(caseRoot, "boundary.marker");
      const fixture = await prepareRouteLockFixture(caseRoot, { env: scenario.dockerEnv });
      const domainDirectory = path.dirname(fixture.routeFile);
      const preservedDirectory = `${domainDirectory}.preserved`;
      const outside = path.join(caseRoot, "outside");
      await mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel.bin");
      await writeFile(sentinel, Buffer.from([0, 1, 2, 253, 254, 255]));
      const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
      const gate = await createHostPauseGate(caseRoot);
      const action = startHostHelper(fixture.request, {
        cwd: caseRoot,
        detached: true,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: boundary,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          ...gate.env("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS"),
        },
      });
      try {
        await waitForHostHelperMarker(action, marker, (text) => text === `${boundary}\n`);
        await gate.entered("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS", { action });
        await rename(domainDirectory, preservedDirectory);
        await symlink(outside, domainDirectory, "dir");
        await gate.release("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
        const result = await action.result;
        assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${boundary}: ${result.stdout}`);
        assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, boundary);
        assert.deepEqual(await readdir(outside), ["sentinel.bin"], boundary);
        const preservedEntries = await readdir(preservedDirectory);
        const originalEntry = preservedEntries.find((entry) => entry.startsWith("team-notes.caddy.previous-"))
          ?? preservedEntries.find((entry) => entry === "team-notes.caddy");
        assert.ok(originalEntry, `${boundary}: original route bytes must remain in the fenced directory`);
        assert.match(await readFile(path.join(preservedDirectory, originalEntry), "utf8"), /127\.0\.0\.1:49153/, boundary);
      } finally {
        await gate.releaseAll();
        await stopHostHelper(action);
      }
    }
  });
});


test("sporades host helper scavenges a dead stale-lock quarantine after SIGKILL", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const orphanStale = `${fixture.lockDir}.stale-${"f".repeat(32)}`;
    await writeFile(
      orphanStale,
      `${JSON.stringify({
        token: "c".repeat(32),
        pid: 999999,
        processIdentity: "dead-route-owner",
        createdAt: Date.now() - 60_000,
      })}\n`,
    );
    const gate = await createHostPauseGate(dir);
    const holder = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, ...gate.env("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS") },
    });
    const routeDir = path.dirname(fixture.routeFile);
    // Killed while provably holding the lock; the gate is never released.
    await gate.entered("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS", { action: holder });
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recovered = await runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.deepEqual(
      (await readdir(routeDir)).filter((entry) => new RegExp(`^${path.basename(fixture.lockDir)}\\.(?:claim|stale|reclaim)-[a-f0-9]{32}$`).test(entry)),
      [],
    );
  });
});


test("sporades host helper reports structured Hosted Capsule runtime health failures", async () => {
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "remote-root");

    async function writeHealthRecord(root, overrides = {}) {
      const domain = overrides.domain ?? "capsules.example.dev";
      const { scheme = "https", ...recordOverrides } = overrides;
      const registryRecordPath = path.join(root, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `${scheme}://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "a".repeat(64) },
          ...recordOverrides,
        })}\n`,
      );
    }

    async function runHealth(root, env = {}, host = {}) {
      const domain = host.domain ?? "capsules.example.dev";
      const scheme = host.scheme ?? "https";
      return runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme, remoteRoot: root },
          capsule: { subname: "team-notes" },
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env },
      );
    }

    const missingRoot = path.join(baseRoot, "missing");
    const missingDocker = await installFakeDocker(path.join(dir, "missing-docker"));
    const missing = await runHealth(missingRoot, missingDocker.env);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).data.failure, "unregistered-capsule");

    const noReleaseRoot = path.join(baseRoot, "no-release");
    await writeHealthRecord(noReleaseRoot, { currentRelease: null });
    const noReleaseDocker = await installFakeDocker(path.join(dir, "no-release-docker"));
    const noRelease = await runHealth(noReleaseRoot, noReleaseDocker.env);
    assert.equal(noRelease.code, 0, noRelease.stderr);
    assert.equal(JSON.parse(noRelease.stdout).data.failure, "no-current-release");

    const stoppedRoot = path.join(baseRoot, "stopped");
    await writeHealthRecord(stoppedRoot);
    const stoppedDocker = await installFakeDocker(path.join(dir, "stopped-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHealth(stoppedRoot, stoppedDocker.env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).data.failure, "stopped-container");

    const routeRoot = path.join(baseRoot, "route");
    const routeDocker = await installFakeDocker(path.join(dir, "route-docker"));
    const routePort = await reserveUnusedPort();
    const routeDomain = `localhost:${routePort}`;
    await writeHealthRecord(routeRoot, {
      domain: routeDomain,
      scheme: "http",
      hostedUrl: `http://team-notes.localhost:${routePort}`,
      remoteCapsuleId: `${routeDomain}/team-notes`,
    });
    const route = await runHealth(routeRoot, routeDocker.env, { domain: routeDomain, scheme: "http" });
    assert.equal(route.code, 0, route.stderr);
    assert.equal(JSON.parse(route.stdout).data.failure, "route-failure");

    const responseCases = [
      {
        failure: "runtime-failure",
        body: { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "sqlite-failure",
        body: { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: false }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "file-storage-failure",
        body: { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: false } } }, error: null },
      },
      {
        failure: "file-inspection-failure",
        statusCode: 503,
        body: { ok: false, data: { runtime: { ready: false, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: false } } }, error: null },
      },
      {
        name: "invalid-runtime-bounds",
        failure: "runtime-failure",
        message: "Hosted Capsule runtime health had an unexpected shape.",
        body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10.5, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        name: "partial-runtime-bounds",
        failure: "runtime-failure",
        message: "Hosted Capsule runtime health had an unexpected shape.",
        body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        name: "non-positive-runtime-bounds",
        failure: "runtime-failure",
        message: "Hosted Capsule runtime health had an unexpected shape.",
        body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 0 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        name: "malformed-runtime-bounds",
        failure: "runtime-failure",
        message: "Hosted Capsule runtime health had an unexpected shape.",
        body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: "10485760", httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
    ];

    for (const responseCase of responseCases) {
      const caseName = responseCase.name ?? responseCase.failure;
      const root = path.join(baseRoot, caseName);
      const docker = await installFakeDocker(path.join(dir, `${caseName}-docker`));
      await withHttpServer((request, response) => {
        assert.equal(request.headers["x-sporades-host-probe"], "a".repeat(64));
        response.writeHead(responseCase.statusCode ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseCase.body));
      }, async (port) => {
        const domain = `localhost:${port}`;
        await writeHealthRecord(root, {
          domain,
          scheme: "http",
          hostedUrl: `http://team-notes.localhost:${port}`,
          remoteCapsuleId: `${domain}/team-notes`,
        });
        const result = await runHealth(root, docker.env, { domain, scheme: "http" });
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.data.failure, responseCase.failure);
        if (responseCase.message) assert.equal(output.error.message, responseCase.message);
        assert.equal(result.stdout.includes("a".repeat(64)), false);
        assert.equal(result.stdout.includes(baseRoot), false);
      });
    }

    for (const responseCase of [
      {
        name: "legacy-runtime-health",
        body: { ok: true, data: { runtime: { ready: true }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
        expectedRuntime: { ready: true, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } },
      },
      {
        name: "bounded-runtime-health",
        body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 7_654_321, httpMaxBodyBytes: 1_234_567 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
        expectedRuntime: { ready: true, fileMaxSizeBytes: 7_654_321, httpMaxBodyBytes: 1_234_567, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } },
      },
    ]) {
      const root = path.join(baseRoot, responseCase.name);
      const docker = await installFakeDocker(path.join(dir, `${responseCase.name}-docker`));
      await withHttpServer((request, response) => {
        assert.equal(request.headers["x-sporades-host-probe"], "a".repeat(64));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseCase.body));
      }, async (port) => {
        const domain = `localhost:${port}`;
        await writeHealthRecord(root, {
          domain,
          scheme: "http",
          hostedUrl: `http://team-notes.localhost:${port}`,
          remoteCapsuleId: `${domain}/team-notes`,
        });
        const result = await runHealth(root, docker.env, { domain, scheme: "http" });
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, true, `${responseCase.name}: ${result.stdout}`);
        assert.deepEqual(output.data.runtime, responseCase.expectedRuntime, responseCase.name);
      });
    }
  });
});


test("sporades host helper reports normalized Docker no-stream stats with raw passthrough", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260101T000000Z-abcdef12" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({
          State: {
            Running: true,
            Status: "running",
            StartedAt: "2026-01-01T00:00:00.000Z",
          },
          RestartCount: 2,
        })}\n`,
        FAKE_DOCKER_STATS_JSON: `${JSON.stringify({
          Container: "abc123",
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "12.34%",
          MemUsage: "128MiB / 1GiB",
          MemPerc: "12.50%",
          NetIO: "1.5MB / 240kB",
          BlockIO: "8.19kB / 16.4MB",
          PIDs: "11",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "capsule.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        stats: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          container: { name: "sporades-capsules-example-dev-team-notes" },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.stats, {
      cpuPercent: 12.34,
      memoryUsageBytes: 134217728,
      memoryLimitBytes: 1073741824,
      memoryPercent: 12.5,
      networkInputBytes: 1500000,
      networkOutputBytes: 240000,
      blockInputBytes: 8190,
      blockOutputBytes: 16400000,
      pids: 11,
    });
    assert.equal(output.data.raw.CPUPerc, "12.34%");
    assert.equal(output.data.raw.MemUsage, "128MiB / 1GiB");
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.lifecycle.registered, true);
    assert.equal(output.data.lifecycle.registryStatus, "running");
    assert.equal(output.data.lifecycle.running, true);
    assert.equal(output.data.lifecycle.restartCount, 2);
    assert.equal(output.data.lifecycle.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(typeof output.data.lifecycle.uptimeSeconds, "number");
    assert.equal(output.data.lifecycle.currentReleaseId, "20260101T000000Z-abcdef12");
    assert.equal(output.data.lifecycle.routeTarget, "container");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args), [
      ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
      ["stats", "--no-stream", "--format", "json", "sporades-capsules-example-dev-team-notes"],
      ["inspect", "--format", "{{json .}}", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});


test("sporades host helper lists legacy current release metadata without release history", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "team-notes.json"),
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface", createdAt: "2026-06-30T22:15:00.000Z" },
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.deepEqual(
      output.data.releases.map((release) => ({
        id: release.id,
        createdAt: release.createdAt,
        state: release.state,
        current: release.current,
        legacy: release.legacy,
      })),
      [
        {
          id: "20260630T221500Z-feedface",
          createdAt: "2026-06-30T22:15:00.000Z",
          state: "uploaded",
          current: true,
          legacy: true,
        },
      ],
    );
  });
});


test("sporades host helper reads recent Caddy access log entries from the managed log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await mkdir(path.dirname(accessLog), { recursive: true });
    await writeFile(
      accessLog,
      [
        "2026/01/01 00:00:01 GET /old",
        "2026/01/01 00:00:02 GET /one",
        "2026/01/01 00:00:03 GET /two",
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["2026/01/01 00:00:02 GET /one", "2026/01/01 00:00:03 GET /two"],
      },
      error: null,
    });
  });
});


test("sporades host helper falls back to Caddy journald logs when the managed log file is absent", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STDOUT: "caddy service started\nhandled request for team-notes.capsules.example.dev\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 50 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 50,
        source: "http",
        entries: ["caddy service started", "handled request for team-notes.capsules.example.dev"],
      },
      error: null,
    });
    assert.deepEqual((await journalctl.calls()).map((call) => call.args), [
      ["-u", "caddy", "-n", "50", "--no-pager", "-o", "cat"],
    ]);
  });
});


test("sporades host helper reports unavailable Caddy logs as a structured error", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STATUS: "1",
        FAKE_JOURNALCTL_STDERR: "No journal files were found.\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 100 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});


test("sporades host helper writes explicit Cloudflare origin TLS routes when requested", async () => {
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

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
              tls: {
                mode: "cloudflare-origin",
                certificate: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.crt"),
                key: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.key"),
              },
            },
          },
        },
      },
      { cwd: dir, env },
    );
    assert.equal(start.code, 0, start.stderr);
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(
      routeContents,
      /tls .*hosts\/capsules\.example\.dev\/tls\/origin\.crt .*hosts\/capsules\.example\.dev\/tls\/origin\.key/,
    );
    assert.match(routeContents, /@sporadesUntrustedCloudflareSource not remote_ip .*173\.245\.48\.0\/20/);
    assert.match(routeContents, /2400:cb00::\/32/);
    assert.match(routeContents, /respond @sporadesUntrustedCloudflareSource 403/);
    assert.match(routeContents, /header_up x-sporades-client-address \{http\.request\.header\.CF-Connecting-IP\}/i);
    assert.match(routeContents, /request_header -x-sporades-client-address\n/);
    assert.match(routeContents, /request_header -x-sporades-client-address-token\n/);
    assert.match(routeContents, /header_up x-sporades-client-address-token [a-f0-9]{64}/);
    assert.doesNotMatch(routeContents, /header_up x-sporades-client-address \{http\.request\.remote\.host\}/);
  });
});


test("sporades host helper reports candidate and rollback reload failures", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,1" } });
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
        message: "Failed to apply Hosted Capsule route and failed to reload the restored Caddy config.",
        hint: "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
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


test("sporades host helper keeps the authoritative registry JSON when an atomic write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const originalRecord = { subname: "team-notes", domain: "capsules.example.dev", status: "running" };
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify(originalRecord)}\n`);
    const docker = await installFakeDocker(dir);

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
      { cwd: dir, env: { ...docker.env, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to write Hosted Capsule registry record.",
        hint: "Check Host server disk permissions and free space, then retry the command.",
      },
    });
    assert.deepEqual(JSON.parse(await readFile(registryRecordPath, "utf8")), originalRecord);
    assert.deepEqual((await readdir(path.dirname(registryRecordPath))).sort(), ["team-notes.json"]);
  });
});


test("sporades host helper starts a retained old-image release from the current builder lifecycle DTO", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      releaseIds: ["20260630T221500Z-feedface"],
      status: "stopped",
    });
    const previousImage = "registry.example/sporades-base:previous";
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: previousImage, version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "true", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49161" },
    });

    const result = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.container.image, previousImage);
    assert.equal(output.data.route.hostname, `${fixture.subname}.${fixture.domain}`);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes(previousImage));
    assert(!runs[0].args.includes(lifecycle.container.image));
    const route = await readFile(lifecycle.routes.running.routeFile, "utf8");
    assert.match(route, /127\.0\.0\.1:49161/);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
  });
});


test("sporades host helper validates a current builder restart before stopping and runs the retained old image", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const previousImage = "registry.example/sporades-base:previous";
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: previousImage, version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    await mkdir(path.dirname(lifecycle.routes.running.routeFile), { recursive: true });
    await writeFile(lifecycle.routes.running.routeFile, `${fixture.subname}.${fixture.domain} {\n  reverse_proxy 127.0.0.1:49160\n}\n`);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "true", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49162" },
    });

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.container.image, previousImage);
    assert.equal(output.data.route.hostname, `${fixture.subname}.${fixture.domain}`);
    const calls = await docker.calls();
    const runs = calls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(calls));
    assert(runs[0].args.includes(previousImage));
    assert(!runs[0].args.includes(lifecycle.container.image));
    assert.deepEqual(calls.slice(0, 2).map((call) => call.args[0]), ["stop", "rm"]);
    const route = await readFile(lifecycle.routes.running.routeFile, "utf8");
    assert.match(route, /127\.0\.0\.1:49162/);
    assert.doesNotMatch(route, /127\.0\.0\.1:49160/);
  });
});


test("sporades host helper quiesces Docker before descriptor-fenced runtime-data preparation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const outside = path.join(dir, "outside-runtime-data");
    const sentinel = path.join(outside, "sentinel.bin");
    await mkdir(outside, { mode: 0o711 });
    await writeFile(sentinel, Buffer.from([9, 2, 6, 5]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const sentinelBefore = await lstat(sentinel);
    const sentinelHash = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const marker = path.join(dir, "runtime-data.marker");
    const retainedData = `${fixture.dataDir}.retained`;
    const gate = await createHostPauseGate(dir);
    const action = startHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_BOUNDARY: "runtime-data-descriptor-mutate",
        SPORADES_TEST_RUNTIME_DATA_MUTATION_MARKER: marker,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_TARGET_SUFFIX: "/data",
        ...gate.env("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS"),
      },
    });
    await waitForPath(marker);
    await gate.entered("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS", { action });
    assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["stop", "rm"]);
    await rename(fixture.dataDir, retainedData);
    await symlink(outside, fixture.dataDir);
    await gate.release("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", result.stdout);
    assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["stop", "rm"]);
    const outsideAfter = await lstat(outside);
    const sentinelAfter = await lstat(sentinel);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), sentinelHash);
    assert.deepEqual([outsideAfter.mode & 0o777, outsideAfter.uid, outsideAfter.gid], [outsideBefore.mode & 0o777, outsideBefore.uid, outsideBefore.gid]);
    assert.deepEqual([sentinelAfter.mode & 0o777, sentinelAfter.uid, sentinelAfter.gid], [sentinelBefore.mode & 0o777, sentinelBefore.uid, sentinelBefore.gid]);
  });
});


test("sporades host helper fails start with guidance when the base image cannot be pulled or built", async () => {
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
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_IMAGE_INSPECT_STATUS: "1",
        FAKE_DOCKER_PULL_STATUS: "1",
      },
    });

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
        message: "Unable to prepare the Sporades Base image.",
        hint: `Docker could not pull ghcr.io/sporades/sporades-base:0.3.0-node24-alpine, and ${path.join(remoteRoot, "Dockerfile.base")} is missing. Reinstall the Sporades Host helper files, then retry \`sporades host start team-notes --host <alias>\`.`,
      },
    });
    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"],
        ["pull", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"],
      ],
    );
  });
});


test("sporades host helper refuses to delete active Hosted Capsule registry states", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });

    for (const status of ["registered", "running", "stopped", "released"]) {
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status,
        })}\n`,
      );
      const deleted = await runHostHelper(
        {
          action: "capsule.delete",
          host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir },
      );
      assert.equal(deleted.code, 0, deleted.stderr);
      const output = JSON.parse(deleted.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
      assert.match(output.error.hint, /sporades host unregister team-notes/);
      assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, status);
      assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    }
  });
});


test("sporades host helper delete refuses missing tombstone when storage remains", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await writeFile(path.join(capsuleDir, "data", "live.db"), "must not delete without tombstone proof\n");

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
    assert.match(output.error.hint, /sporades host unregister team-notes/);
    assert.equal(await readFile(path.join(capsuleDir, "data", "live.db"), "utf8"), "must not delete without tombstone proof\n");
  });
});


test("sporades host helper fails unregister for a missing Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
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
      { cwd: dir },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    assert.deepEqual(JSON.parse(unregister.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before unregistering the Hosted Capsule.",
      },
    });
  });
});


test("sporades host helper rejects unsafe or unexpected release archive entries before extraction", async () => {
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
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await symlink("server.mjs", path.join(runtimeDir, "linked-server.mjs"));
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "source.ts",
      "linked-server.mjs",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

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
        message: "Hosted Capsule release archive contains unsafe entries.",
        hint: "Push again so Sporades can package regular runtime files only.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});


test("sporades host helper verifies a pushed Hosted Capsule release after restart", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        assert.equal(request.headers["x-sporades-host-probe"], undefined);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<script type="module" src="/assets/app-a1b2.js"></script>');
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
              fileInspection: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verified",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verified-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: {
            enabled: true,
            health: { runtimeHealthUrl: `http://malicious.localhost:${port}/__sporades/health/runtime` },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 0, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.installed, true);
      assert.equal(output.data.restarted, true);
      assert.equal(output.data.verified, true);
      assert.equal(output.data.release.id, fixture.releaseId);
      assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
      assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
      assert.equal(output.data.verification.state, "verified");
      assert.equal(output.data.verification.health.route.responding, true);
      assert.equal(output.data.verification.health.runtime.ready, true);
      assert.deepEqual(output.data.verification.health.runtime.checks.fileInspection, { ok: true });
      assert.deepEqual(output.data.verification.health.public, {
        url: `http://${fixture.subname}.${fixture.domain}/`,
        path: "/",
        responding: true,
        statusCode: 200,
        html: true,
      });
      assert.equal(install.stdout.includes(probeToken), false);
      const installedPublic = path.join(fixture.capsuleDir, "releases", fixture.releaseId, "public");
      assert.match(await readFile(path.join(installedPublic, "index.html"), "utf8"), /app-a1b2\.js/);
      assert.equal(await readFile(path.join(installedPublic, "assets", "app-a1b2.css"), "utf8"), "body{background:url('./images/logo-a1b2.png')}\n");
      assert.deepEqual(await readFile(path.join(installedPublic, "assets", "images", "logo-a1b2.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      assert.equal(await readFile(path.join(installedPublic, "assets", "fonts", "app-a1b2.woff2"), "utf8"), "wOF2fixture");
      await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId, "client.js")), { code: "ENOENT" });
      const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
      assert(runCall.args.includes(`${path.join(fixture.capsuleDir, "current", "public")}:/app/public:ro`));
      assert.equal(runCall.args.some((arg) => arg.endsWith(":/app/client.js:ro") || arg.endsWith(":/app/index.html:ro")), false);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "running");
      assert.equal(release.state, "verified");
      assert.equal(release.current, true);
      assert.equal(release.verificationAttempts.length, 1);
      assert.match(release.verificationAttempts[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(release.failure, null);
    });
  });
});


test("sporades host helper waits for a newly started Capsule route to serve its public tree", async () => {
  await withTempDir(async (dir) => {
    let publicAttempts = 0;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        publicAttempts += 1;
        if (publicAttempts === 1) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("upstream is still starting");
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<script type="module" src="/assets/app-a1b2.js"></script>');
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } },
        error: null,
      }));
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verify-delayed-public-tree",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verify-delayed-public-tree-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: { enabled: true, healthTimeoutMs: 1000 },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 0, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.verification.state, "verified");
      assert.equal(output.data.verification.health.public.statusCode, 200);
      assert.equal(publicAttempts, 2);
    });
  });
});


test("sporades host helper marks verified push failed when the Capsule route does not become healthy", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-route-failure",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const registered = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    await writeFile(fixture.registryRecordPath, JSON.stringify({ ...registered, aliasDomains: ["fourteen.example"] }));
    const docker = await installFakeDocker(path.join(dir, "verify-route-failure-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          healthTimeoutMs: 25,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.release.id, fixture.releaseId);
    assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
    assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
    assert.equal(output.data.verified, false);
    assert.equal(output.data.verification.state, "failed");
    assert.equal(output.data.verification.health.failure, "route-failure");
    assert.equal(output.data.rollbackGuidance.command, `sporades host rollback team-notes ${fixture.previousReleaseId} --host personal`);
    assert.equal(output.error.message, "Hosted Capsule release verification failed.");
    assert.match(output.error.hint, /sporades host rollback team-notes 20260629T120000Z-deadbeef --host personal/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
    assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

    assert.ok((await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8")).includes("fourteen.example {\n"));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.deepEqual(record.aliasDomains, ["fourteen.example"]);
    const release = record.releases.find((entry) => entry.id === fixture.releaseId);
    assert.equal(record.currentRelease.id, fixture.releaseId);
    assert.equal(record.status, "failed");
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Hosted Capsule installed public tree did not respond.");
    assert.equal(release.verificationAttempts.length, 1);
    assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule installed public tree did not respond.");
  });
});


test("sporades host helper leaves current unchanged when fallback inventory is missing a source map", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "fallback-missing-map",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const previousDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    const previousFiles = ["server.mjs", "sporades.json", "public/index.html", "public/assets/previous.js", "public/assets/previous.css", "public/assets/previous.woff2", "public/assets/previous.js.map"];
    for (const file of previousFiles) {
      const target = path.join(previousDir, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${file}\n`);
    }
    const inventory = await Promise.all(previousFiles.map(async (file) => {
      const contents = await readFile(path.join(previousDir, ...file.split("/")));
      return { path: file, size: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
    }));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.releases[0].source = { files: previousFiles, fileInventory: inventory };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
    await rm(path.join(previousDir, "public", "assets", "previous.js.map"));
    const docker = await installFakeDocker(path.join(dir, "fallback-missing-map-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: { enabled: true, fallbackToPreviousRelease: true, healthTimeoutMs: 25 },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "fallback-failed");
    assert.match(output.data.fallback.error.message, /release files are missing|release inventory changed/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
  });
});


test("sporades host helper preserves install metadata when push restart route reload fails", async () => {
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
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const registryBefore = await readFile(registryRecordPath);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

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
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.installed, false);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.deepEqual(output.data.rollback, { applied: true, previousCurrentRelease: null });
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    await assert.rejects(readlink(path.join(capsuleDir, "current")), { code: "ENOENT" });
    assert.deepEqual(await readFile(registryRecordPath), registryBefore);
    await assert.rejects(lstat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper starts a stopped Capsule during rollback", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { status: "stopped" });
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
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.release.id, fixture.rollbackReleaseId);
    assert.ok((await docker.calls()).some((call) => call.args[0] === "run"));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
  });
});


test("sporades host register leaves local binding untouched when authoritative registration fails", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule subname is already registered for this Hosted domain.",
    hint: "Choose a different Capsule subname for " + request.host.domain + "."
  }
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
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });
  });
});


test("sporades host register requires complete alias confirmation before writing a binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(dir, `
const capsule = JSON.parse(process.env.FAKE_REGISTER_CAPSULE);
process.stdout.write(JSON.stringify({ ok: true, data: { registered: true, capsule }, error: null }) + "\\n");
`);
    const create = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(create.code, 0, create.stderr);
    const projectDir = path.join(dir, "todo-island");
    const env = { ...hostEnv(configDir), ...fakeSsh.env };
    const add = await runCli(["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"], { cwd: projectDir, env });
    assert.equal(add.code, 0, add.stderr);
    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    const args = ["host", "register", "team-notes", "--host", "personal", "--alias-domain", "fourteen.example", "--alias-domain", "app.fourteen.example", "--json"];
    for (const capsule of [{}, { aliasDomains: [] }, { aliasDomains: ["fourteen.example"] }, { aliasDomains: ["fourteen.example", "fourteen.example"] }, { aliasDomains: ["fourteen.example", "app.fourteen.example", "extra.example"] }, { aliasDomains: "fourteen.example" }]) {
      const result = await runCli(args, { cwd: projectDir, env: { ...env, FAKE_REGISTER_CAPSULE: JSON.stringify(capsule) } });
      assert.equal(result.code, 1, result.stdout);
      assert.match(JSON.parse(result.stdout).error.message, /did not confirm the requested alias domains/);
      await assert.rejects(readFile(bindingPath), { code: "ENOENT" });
    }
    await mkdir(path.dirname(bindingPath), { recursive: true });
    await writeFile(bindingPath, "existing binding\n");
    const denied = await runCli(args, { cwd: projectDir, env: { ...env, FAKE_REGISTER_CAPSULE: "{}" } });
    assert.equal(denied.code, 1);
    assert.equal(await readFile(bindingPath, "utf8"), "existing binding\n");
    const confirmed = await runCli(args, { cwd: projectDir, env: { ...env, FAKE_REGISTER_CAPSULE: JSON.stringify({ aliasDomains: ["app.fourteen.example", "fourteen.example"] }) } });
    assert.equal(confirmed.code, 0, confirmed.stdout + confirmed.stderr);
    assert.equal(JSON.parse(confirmed.stdout).data.localBinding, true);
  });
});


test("sporades host rollback invokes the Hosted Capsule rollback helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.rollback") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.rollback." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    rolledBack: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    previousCurrentRelease: { id: "20260630T221500Z-feedface" },
    currentRelease: { id: request.rollback.releaseId },
    lifecycle: {
      started: true,
      restarted: true,
      release: { id: request.rollback.releaseId },
      container: { name: "sporades-capsules-example-dev-team-notes", running: true }
    }
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

    const rollback = await runCli(
      ["host", "rollback", "team-notes", "20260629T120000Z-deadbeef", "--host", "personal", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.rollback",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      rollback: {
        releaseId: "20260629T120000Z-deadbeef",
      },
      lifecycle: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        currentLink: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        mounts: {
          files: [
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/public", container: "/app/public", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server", container: "/app/.env.sporades.server", mode: "ro", optional: true },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
              container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
              mode: "ro",
              optional: true,
            },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
              container: "/app/.sporades/sealed-server-env/server-env.private.pem",
              mode: "ro",
              optional: true,
            },
          ],
          data: {
            host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
            container: "/app/data",
            mode: "rw",
          },
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
          user: "10001:10001",
          baseImage: {
            name: "sporades-base",
            image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
            version: "0.3.0-node24-alpine",
            updatePolicy: {
              mode: "host-managed",
              autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
            },
          },
          labels: {
            "com.sporades.managed": "true",
            "com.sporades.hosted-domain": "capsules.example.dev",
            "com.sporades.capsule-subname": "team-notes",
            "com.sporades.capsule-id": "capsules.example.dev/team-notes",
            "com.sporades.base-image.name": "sporades-base",
            "com.sporades.base-image.version": "0.3.0-node24-alpine",
            "com.sporades.base-image.update-policy": "host-managed",
          },
        },
        routes: {
          running: {
            hostname: "team-notes.capsules.example.dev",
            target: "container",
            containerName: "sporades-capsules-example-dev-team-notes",
            port: 4000,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
          },
          unavailable: {
            hostname: "team-notes.capsules.example.dev",
            target: "hosted-capsule-unavailable",
            statusCode: 503,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
            log: { file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log" },
          },
        },
      },
    });
  });
});


test("sporades host list combines registry release metadata and fake Docker state", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [
      {
        subname: "drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/drafts",
          registeredAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "registered"
        },
        currentRelease: null,
        docker: null
      },
      {
        subname: "notes",
        hostedUrl: "https://notes.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/notes",
          registeredAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          status: "released"
        },
        currentRelease: {
          id: "20260104T000000Z",
          createdAt: "2026-01-04T00:00:00.000Z",
          bundleHash: "sha256:abc123"
        },
        docker: {
          containerId: "abc123def456",
          containerName: "sporades-capsules-example-dev-notes",
          state: "running",
          status: "Up 2 hours",
          running: true,
          image: "node:22-alpine"
        }
      },
      {
        subname: "archive",
        hostedUrl: "https://archive.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/archive",
          registeredAt: "2026-01-05T00:00:00.000Z",
          updatedAt: "2026-01-06T00:00:00.000Z",
          status: "stopped"
        },
        currentRelease: {
          id: "20260106T000000Z",
          createdAt: "2026-01-06T00:00:00.000Z"
        },
        docker: {
          containerId: "fedcba654321",
          containerName: "sporades-capsules-example-dev-archive",
          state: "exited",
          status: "Exited (0) 3 minutes ago",
          running: false,
          image: "node:22-alpine"
        }
      }
    ]
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

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const data = JSON.parse(list.stdout).data;
    assert.equal(data.capsules.length, 3);
    assert.equal(data.capsules[0].subname, "drafts");
    assert.equal(data.capsules[0].currentRelease, null);
    assert.equal(data.capsules[0].docker, null);
    assert.equal(data.capsules[1].currentRelease.bundleHash, "sha256:abc123");
    assert.equal(data.capsules[1].docker.running, true);
    assert.equal(data.capsules[2].docker.running, false);

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /SUBNAME\s+URL\s+REGISTRY\s+RELEASE\s+DOCKER/);
    assert.match(plain.stdout, /drafts\s+https:\/\/drafts\.capsules\.example\.dev\s+registered\s+none\s+unavailable/);
    assert.match(plain.stdout, /notes\s+https:\/\/notes\.capsules\.example\.dev\s+released\s+20260104T000000Z\s+running \(Up 2 hours\)/);
    assert.match(plain.stdout, /archive\s+https:\/\/archive\.capsules\.example\.dev\s+stopped\s+20260106T000000Z\s+stopped \(Exited \(0\) 3 minutes ago\)/);
  });
});


test("sporades host list trusts the Host server registry over a local project binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [{
      subname: "registry-notes",
      hostedUrl: "https://registry-notes.capsules.example.dev",
      registry: {
        remoteCapsuleId: "capsules.example.dev/registry-notes",
        registeredAt: "2026-01-01T00:00:00.000Z",
        status: "registered"
      },
      currentRelease: null,
      docker: null
    }]
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
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "remote-binding.json"),
      `${JSON.stringify({
        hostAlias: "personal",
        domain: "wrong.example.dev",
        scheme: "https",
        subname: "local-notes",
        hostedUrl: "https://local-notes.wrong.example.dev",
        remoteCapsuleId: "wrong.example.dev/local-notes",
      })}\n`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.data.capsules[0].subname, "registry-notes");
    assert.doesNotMatch(list.stdout, /local-notes/);
    assert.doesNotMatch(list.stdout, /wrong\.example\.dev/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
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


test("sporades host helper reports disabled SSH without inspecting Docker when no keys are configured", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [{
          id: "20260630T221500Z-feedface",
          state: "started",
          current: true,
          source: {}
        }]
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const result = await runHostHelper(
      {
        action: "capsule.ssh",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.enabled, false);
    assert.equal(output.data.running, false);
    assert.equal(output.data.reason, "no-authorized-keys");
    await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });
  });
});


test("sporades host stats resolves a Hosted Capsule and returns normalized Docker stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.stats") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.stats." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.stats.hostedUrl,
      remoteCapsuleId: request.stats.remoteCapsuleId
    },
    container: {
      name: request.stats.container.name,
      running: true
    },
    stats: {
      cpuPercent: 3.14,
      memoryUsageBytes: 104857600,
      memoryLimitBytes: 536870912,
      memoryPercent: 19.53,
      networkInputBytes: 2048,
      networkOutputBytes: 4096,
      blockInputBytes: 8192,
      blockOutputBytes: 16384,
      pids: 7
    },
    lifecycle: {
      registered: true,
      registryStatus: "running",
      running: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSeconds: 7200,
      restartCount: 1,
      currentReleaseId: "20260101T000000Z-abcdef12",
      routeTarget: "container"
    },
    raw: {
      Name: "sporades-capsules-example-dev-team-notes",
      CPUPerc: "3.14%",
      MemUsage: "100MiB / 512MiB",
      MemPerc: "19.53%",
      NetIO: "2kB / 4kB",
      BlockIO: "8kB / 16kB",
      PIDs: "7"
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
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          running: true,
        },
        stats: {
          cpuPercent: 3.14,
          memoryUsageBytes: 104857600,
          memoryLimitBytes: 536870912,
          memoryPercent: 19.53,
          networkInputBytes: 2048,
          networkOutputBytes: 4096,
          blockInputBytes: 8192,
          blockOutputBytes: 16384,
          pids: 7,
        },
        lifecycle: {
          registered: true,
          registryStatus: "running",
          running: true,
          startedAt: "2026-01-01T00:00:00.000Z",
          uptimeSeconds: 7200,
          restartCount: 1,
          currentReleaseId: "20260101T000000Z-abcdef12",
          routeTarget: "container",
        },
        raw: {
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "3.14%",
          MemUsage: "100MiB / 512MiB",
          MemPerc: "19.53%",
          NetIO: "2kB / 4kB",
          BlockIO: "8kB / 16kB",
          PIDs: "7",
        },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: { subname: "team-notes" },
      stats: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
  });
});


test("sporades host stats without a Host profile reports a structured JSON failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(stats.code, 1);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No current Host profile selected.",
        hint: "Run `sporades host use <alias>` or pass `--host <alias>`.",
      },
    });
  });
});


test("sporades host logs can request HTTP logs for one Hosted Capsule", async () => {
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
    entries: [request.capsule.subname + " http"]
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

    const logs = await runCli(["host", "logs", "http", "--host", "personal", "--subname", "team-notes", "-n", "4", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout).data, {
      lineCount: 4,
      source: "http",
      entries: ["team-notes http"],
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
    assert.equal(JSON.parse(sshCall.stdin).capsule.subname, "team-notes");
  });
});


test("sporades host github workflow reports verification failures without automatic rollback", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Verification failed/);
    assert.match(workflow, /rollbackGuidance\?\.command/);
    assert.match(workflow, /previousCurrentRelease\?\.id/);
    assert.match(workflow, /sporades host rollback/);
    assert.match(workflow, /Sporades did not roll back automatically/);
    assert.doesNotMatch(workflow, /npx sporades host rollback/);
  });
});


test("sporades host github workflow write writes a workflow and refuses accidental overwrite", async () => {
  await withTempDir(async (dir) => {
    const file = ".github/workflows/custom-sporades.yml";
    const first = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "feat,main", "--file", file, "--json"],
      { cwd: dir },
    );

    assert.equal(first.code, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout);
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.data.file, file);
    assert.equal(firstOutput.data.written, true);

    const workflowPath = path.join(dir, file);
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /branches: \["feat,main"\]/);
    assert.match(workflow, /SPORADES_HOST_ALIAS: work/);
    assert.match(workflow, /SPORADES_HOST_SUBNAME: field-notes/);

    const second = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "release/stable", "--file", file, "--json"],
      { cwd: dir },
    );
    assert.equal(second.code, 1);
    assert.deepEqual(JSON.parse(second.stdout), {
      ok: false,
      data: null,
      error: {
        message: "GitHub Actions workflow already exists.",
        hint: "Pass `--force` to overwrite it, or choose another path with `--file <path>`.",
      },
    });

    const forced = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "main", "--file", file, "--force", "--json"],
      { cwd: dir },
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(workflowPath, "utf8"), /branches: \["main"\]/);

    const outsideProject = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--file", "../outside.yml", "--json"],
      { cwd: dir },
    );
    assert.equal(outsideProject.code, 1);
    assert.deepEqual(JSON.parse(outsideProject.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid GitHub workflow file path.",
        hint: "Pass a relative path inside the project, such as `.github/workflows/sporades-autodeploy.yml`.",
      },
    });
  });
});


test("custom domains reject invalid input, cross-domain collisions and concurrent claims", async () => {
  await withTempDir(async (dir) => {
    const { request, invoke } = await customDomainFixture(dir, ["capsules.example.dev", "other.example.dev"]);
    for (const aliasDomains of [["*.example.com"], ["https://example.com"], ["x.example\nrespond 200"], ["127.0.0.1"], ["app.example:443"], ["Upper.example"], ["x.example", "x.example"], ["team-notes.capsules.example.dev"], ["host.other.example.dev"], "fourteen.example", null]) {
      const invalid = await invoke({ ...request, registration: { aliasDomains } });
      assert.equal(JSON.parse(invalid.stdout).ok, false, JSON.stringify(aliasDomains) + invalid.stdout);
    }
    const competitor = { ...request, host: { ...request.host, domain: "other.example.dev" }, capsule: { subname: "second" } };
    const results = await Promise.all([invoke(), invoke(competitor)]);
    assert.deepEqual(results.map((result) => JSON.parse(result.stdout).ok).sort(), [false, true], JSON.stringify(results));
    const winner = JSON.parse(results[0].stdout).ok ? request : competitor;
    const loser = JSON.parse(results[0].stdout).ok ? competitor : request;
    const canonicalConflict = await invoke({ ...loser, registration: { aliasDomains: [`${winner.capsule.subname}.${winner.host.domain}`] } });
    assert.equal(JSON.parse(canonicalConflict.stdout).ok, false, canonicalConflict.stdout);
    // An alias that is a future Capsule's canonical hostname must block that registration too.
    const aliasOwner = await invoke({ ...loser, capsule: { subname: "owner" }, registration: { aliasDomains: [`future.${loser.host.domain}`, "host.future.example"] } });
    assert.equal(JSON.parse(aliasOwner.stdout).ok, true, aliasOwner.stdout + aliasOwner.stderr);
    const healthConflict = await invoke({ action: "host.bootstrap", host: { ...request.host, domain: "future.example" } });
    assert.equal(JSON.parse(healthConflict.stdout).ok, false, healthConflict.stdout);
    assert.equal(JSON.parse(healthConflict.stdout).error.message, "Hosted Capsule hostname is already reserved.");
    const future = await invoke({ ...loser, capsule: { subname: "future" }, registration: undefined });
    assert.equal(JSON.parse(future.stdout).ok, false, future.stdout);
    const removed = await invoke({ ...winner, action: "capsule.unregister", registration: undefined });
    assert.equal(JSON.parse(removed.stdout).ok, true, removed.stdout + removed.stderr);
    const reassigned = await invoke(loser);
    assert.equal(JSON.parse(reassigned.stdout).ok, true, reassigned.stdout + reassigned.stderr);
    const reactivation = await invoke(winner);
    assert.equal(JSON.parse(reactivation.stdout).ok, false, reactivation.stdout);
  });
});



test("Hosted deploy.files install preserves edits and uses recorded mounts across restart and policy changes", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "deploy-files-docker"));
    let savedRecord = null;
    let fixture;
    const policies = ["preserve", "preserve", "replace", null, "preserve"];
    for (let index = 0; index < policies.length; index++) {
      const policy = policies[index];
      fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "deploy-files", previousReleaseId: null,
        releaseId: `20260912T12000${index}Z-feedface`,
        deployFiles: policy ? [{ path: "config/settings.json", update: policy }] : [],
        fileContents: `local-${index}`,
      });
      if (savedRecord) await writeFile(fixture.registryRecordPath, savedRecord);
      const request = {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname }, release: fixture.release, lifecycle: fixture.lifecycle,
      };
      const install = await runHostHelper(request, { cwd: dir, env: docker.env });
      assert.equal(install.code, 0, install.stdout + install.stderr);
      assert.equal(JSON.parse(install.stdout).ok, true, install.stdout);
      const preserved = preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "config/settings.json");
      if (index === 0) await writeFile(preserved, "server edit");
      assert.equal(await readFile(preserved, "utf8"), "server edit");
      const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
      const fileMounts = run.args.filter((arg) => arg.includes(":/app/config/settings.json:"));
      assert.deepEqual(fileMounts, policy ? [policy === "preserve" ? `${preserved}:/app/config/settings.json:rw` : `${path.join(fixture.capsuleDir, "current/config/settings.json")}:/app/config/settings.json:ro`] : []);
      savedRecord = await readFile(fixture.registryRecordPath, "utf8");
      if (policy) {
        assert.equal(await readFile(path.join(fixture.release.directories.release, "config/settings.json"), "utf8"), `local-${index}`);
        assert.equal((await stat(path.join(fixture.release.directories.release, "config/settings.json"))).mode & 0o777, 0o400);
        assert.equal((await stat(path.join(fixture.capsuleDir, "preserved-files"))).mode & 0o777, 0o700);
      }
    }
    const restart = await runHostHelper({
      action: "capsule.restart", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
    }, { cwd: dir, env: docker.env });
    assert.equal(restart.code, 0, restart.stdout + restart.stderr);
    const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert(run.args.includes(`${preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "config/settings.json")}:/app/config/settings.json:rw`));
    for (const [releaseId, update] of [["20260912T120002Z-feedface", "replace"], ["20260912T120000Z-feedface", "preserve"]]) {
      const rollback = await runHostHelper({
        action: "capsule.release.rollback", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname }, rollback: { releaseId },
      }, { cwd: dir, env: docker.env });
      assert.equal(rollback.code, 0, rollback.stdout + rollback.stderr);
      const latest = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
      const hostPath = update === "preserve" ? preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "config/settings.json") : path.join(fixture.capsuleDir, "current", "config/settings.json");
      assert(latest.args.includes(`${hostPath}:/app/config/settings.json:${update === "preserve" ? "rw" : "ro"}`));
      assert.equal(await readFile(preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "config/settings.json"), "utf8"), "server edit");
    }

  });
});



test("Hosted deploy.files rolls back new seeds on registry and startup failure", async () => {
  for (const failure of ["registry", "startup"]) await withTempDir(async (dir) => {
    const deployFiles = [{ path: "new.json", update: "preserve" }, { path: "existing.json", update: "preserve" }];
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "seed-rollback", previousReleaseId: null, deployFiles, fileContents: "failed seed" });
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "registered";
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const preserved = path.join(fixture.capsuleDir, "preserved-files");
    await mkdir(preserved, { recursive: true });
    await writeFile(preservedDeployFilePath(preserved, "existing.json"), "existing edit");
    fixture.release.restart = failure === "startup";
    const docker = await installFakeDocker(path.join(dir, "seed-docker"), { env: {
      FAKE_DOCKER_RUNNING: "false",
      ...(failure === "registry" ? { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } : { FAKE_DOCKER_RUN_STATUS: "1" }),
    } });
    const request = { action: "capsule.release.install", host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname }, release: fixture.release };
    const failed = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
    await assert.rejects(stat(preservedDeployFilePath(preserved, "new.json")), { code: "ENOENT" });
    assert.equal(await readFile(preservedDeployFilePath(preserved, "existing.json"), "utf8"), "existing edit");
    const retry = await writeHostedCapsuleInstallFixture(dir, { rootName: "seed-rollback", previousReleaseId: null, releaseId: "20260912T130000Z-feedface", deployFiles, fileContents: "successful seed" });
    retry.release.restart = false;
    const result = await runHostHelper({ ...request, release: retry.release }, { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.equal(await readFile(preservedDeployFilePath(preserved, "new.json"), "utf8"), "successful seed");
    assert.equal(await readFile(preservedDeployFilePath(preserved, "existing.json"), "utf8"), "existing edit");
  });
});


test("Hosted deploy.files reconcile discards an unrecorded attempt and clears a recorded one", async () => {
  await withTempDir(async (dir) => {
    // Each install claims and consumes the incoming archive, so regenerate the
    // fixture before every attempt; the registry record is rewritten identically.
    const refresh = async () => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "reconcile-files", previousReleaseId: null,
        deployFiles: [{ path: "new.json", update: "preserve" }], fileContents: "retained candidate" });
      fixture.release.restart = false;
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      record.status = "registered";
      await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      return fixture;
    };
    let fixture = await refresh();
    const registry = await readFile(fixture.registryRecordPath);
    const request = { host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    const preload = path.join(dir, "fail-pointer.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.rm;
fs.promises.rm = async function(file, ...args) {
  if (String(file).endsWith('/current')) throw Object.assign(new Error('injected pointer restoration denial'), { code: 'EACCES' });
  return original.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const failed = await runHostHelper({ ...request, action: "capsule.release.install", release: fixture.release },
      { cwd: dir, env: { NODE_OPTIONS: `--import=${preload}`, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1", SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
    const journal = path.join(fixture.capsuleDir, "deploy-file-attempt.jsonl");
    const seed = preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "new.json");
    await stat(journal);

    const blocked = await runHostHelper({ ...request, action: "capsule.start" }, { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.match(JSON.parse(blocked.stdout).error.hint, /sporades host reconcile/);

    // Unrecorded attempt: unchanged seed, candidate pointer and directory are discarded.
    const reconciled = await runHostHelper({ ...request, action: "capsule.release.reconcile" }, { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    const outcome = JSON.parse(reconciled.stdout);
    assert.equal(outcome.ok, true, reconciled.stdout);
    assert.equal(outcome.data.reconciled, true);
    assert.equal(outcome.data.committed, false);
    assert.equal(outcome.data.release, fixture.release.id);
    assert.deepEqual(outcome.data.actions, ["seeds-rolled-back", "current-pointer-restored", "candidate-release-removed", "journal-removed"]);
    await assert.rejects(lstat(seed), { code: "ENOENT" });
    assert((await readdir(path.join(fixture.capsuleDir, "preserved-files"))).some((entry) => entry.startsWith(".rollback-")), "seed retained as a recovery copy");
    // The registry still records the fixture's previous release, so the pointer returns to it.
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", "20260629T120000Z-deadbeef"));
    await assert.rejects(lstat(fixture.release.directories.release), { code: "ENOENT" });
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registry);
    const clean = await runHostHelper({ ...request, action: "capsule.release.reconcile" }, { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(clean.stdout).data.reconciled, false, clean.stdout);

    // An edited seed survives reconciliation even when the attempt is discarded.
    fixture = await refresh();
    const edited = await runHostHelper({ ...request, action: "capsule.release.install", release: fixture.release },
      { cwd: dir, env: { NODE_OPTIONS: `--import=${preload}`, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1", SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(edited.stdout).ok, false, edited.stdout);
    await writeFile(seed, "operator edit");
    const kept = await runHostHelper({ ...request, action: "capsule.release.reconcile" }, { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1" } });
    assert.equal(JSON.parse(kept.stdout).ok, true, kept.stdout);
    assert.equal(await readFile(seed, "utf8"), "operator edit");
    await rm(seed, { force: true });

    // Recorded attempt: the release stays installed and only the journal clears.
    fixture = await refresh();
    const docker = await installFakeDocker(path.join(dir, "reconcile-docker"));
    const installed = await runHostHelper({ ...request, action: "capsule.release.install", release: fixture.release }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(installed.stdout).ok, true, installed.stdout);
    await writeFile(journal, `${JSON.stringify({ release: fixture.release.id, preservedRoot: path.join(fixture.capsuleDir, "preserved-files") })}\n${JSON.stringify({ temporary: ".seed-0123abcd-0123-0123-0123-0123456789ab" })}\n`);
    await writeFile(path.join(fixture.capsuleDir, "preserved-files", ".seed-0123abcd-0123-0123-0123-0123456789ab"), "stale temporary");
    const committed = await runHostHelper({ ...request, action: "capsule.release.reconcile" }, { cwd: dir, env: docker.env });
    const committedOutcome = JSON.parse(committed.stdout);
    assert.equal(committedOutcome.ok, true, committed.stdout);
    assert.deepEqual(committedOutcome.data.actions, ["journal-removed"]);
    assert.equal(committedOutcome.data.committed, true);
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "preserved-files", ".seed-0123abcd-0123-0123-0123-0123456789ab")), { code: "ENOENT" });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), fixture.release.directories.release);
    assert.equal(await readFile(seed, "utf8"), "retained candidate");
    const restarted = await runHostHelper({ ...request, action: "capsule.restart" }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(restarted.stdout).ok, true, restarted.stdout);
  });
});


test("Hosted deploy.files preflights recorded releases and preserved files before start or restart", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "preflight-files", previousReleaseId: null,
      deployFiles: [{ path: "settings.json", update: "preserve" }] });
    const docker = await installFakeDocker(path.join(dir, "preflight-docker"));
    const request = { host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    const installed = await runHostHelper({ ...request, action: "capsule.release.install", release: fixture.release }, { cwd: dir, env: docker.env });
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    const stored = preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "settings.json");
    const original = await readFile(fixture.registryRecordPath);
    const route = path.join(fixture.remoteRoot, "caddy/hosts", fixture.domain, `${fixture.subname}.caddy`);
    const routeBefore = await readFile(route);
    for (const failure of ["missing", "unsafe", "journal", "unrecorded"]) {
      await rm(stored, { force: true });
      await writeFile(fixture.registryRecordPath, original);
      if (failure === "unsafe") await symlink(path.join(fixture.release.directories.release, "settings.json"), stored);
      if (failure === "journal") {
        await writeFile(stored, "uncommitted seed");
        await writeFile(path.join(fixture.capsuleDir, "deploy-file-attempt.jsonl"), JSON.stringify({ release: "uncommitted-attempt" }));
      }
      if (failure === "unrecorded") {
        await writeFile(stored, "retained seed");
        const record = JSON.parse(original);
        record.currentRelease = null; record.releases = [];
        await writeFile(fixture.registryRecordPath, JSON.stringify(record));
        await writeFile(path.join(fixture.capsuleDir, "deploy-file-attempt.jsonl"), JSON.stringify({ release: fixture.release.id }));
      }
      const registryBefore = await readFile(fixture.registryRecordPath);
      const before = (await docker.calls()).length;
      for (const action of ["capsule.start", "capsule.restart", ...(failure === "journal" ? ["capsule.release.rollback"] : [])]) {
        const failed = await runHostHelper({ ...request, action, ...(action === "capsule.release.rollback" ? { rollback: { releaseId: fixture.release.id } } : {}) }, { cwd: dir, env: docker.env });
        assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
        if (failure === "unrecorded") assert.match(failed.stdout, /not recorded/);
        if (failure === "journal") assert.match(failed.stdout, /requires recovery/);
        assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
        assert.deepEqual(await readFile(route), routeBefore);
      }
      assert.equal((await docker.calls()).slice(before).filter((call) => ["stop", "rm", "run"].includes(call.args[0])).length, 0);
    }
  });
});


test("Host boot recovery preserves stopped state, running instances and exhausted crash limits", async (t) => {
  for (const scenario of ["stopped", "failed", "unregistered", "already-running", "exhausted", "foreign-container", "never-started"]) await t.test(scenario, async () => {
    await withTempDir(async (dir) => {
      const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "boot-policy", restart: false });
      await alignSealedFixtureWithBuiltLifecycle(fixture);
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      record.status = ["stopped", "failed", "unregistered"].includes(scenario) ? scenario : scenario === "never-started" ? "released" : "running";
      await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
        FAKE_DOCKER_INSPECT_STATUS: scenario === "never-started" ? "1" : "0",
        FAKE_DOCKER_INSPECT_JSON: JSON.stringify({ State: { Running: scenario === "already-running", Status: "exited", ExitCode: scenario === "exhausted" ? 1 : 0 }, RestartCount: scenario === "exhausted" ? 3 : 0, Config: { Labels: {
          "com.sporades.managed": scenario === "foreign-container" ? "false" : "true", "com.sporades.hosted-domain": fixture.domain, "com.sporades.capsule-subname": fixture.subname,
        } } }),
      } });
      const result = await runHostHelper({ action: "capsule.resume", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } }, { cwd: dir, env: docker.env });
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, scenario !== "foreign-container", result.stdout);
      if (output.ok) assert.equal(output.data.resumed, false);
      const calls = await docker.calls().catch(e => { if (e.code === "ENOENT") return []; throw e; });
      assert(!calls.some(c => ["run", "start", "stop", "rm"].includes(c.args[0])), "boot policy must not restart or replace this container");
      if (scenario === "exhausted") assert.match(await readFile(fixture.routeFile, "utf8"), /Hosted Capsule unavailable/);
    });
  });
});


test("Host shutdown evidence resumes a healthy runtime with historical retries after forced termination", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "boot-recovered", restart: false });
    await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "running";
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const retained = { Id: "a".repeat(64), State: { Running: true, Status: "running", StartedAt: startedAt, OOMKilled: false }, RestartCount: 3,
      Config: { Labels: { "com.sporades.managed": "true", "com.sporades.hosted-domain": fixture.domain, "com.sporades.capsule-subname": fixture.subname } } };
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_INSPECT_JSON: JSON.stringify(retained) } });
    const request = { host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    const checkpoint = await runHostHelper({ ...request, action: "capsule.shutdown.checkpoint" }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(checkpoint.stdout).ok, true, checkpoint.stdout);
    assert(!(await docker.calls()).some((call) => ["run", "start", "stop", "rm"].includes(call.args[0])), "checkpointing cannot interrupt Capsules");
    const stopped = { ...retained, State: { ...retained.State, Running: false, Status: "exited", ExitCode: 137, FinishedAt: new Date().toISOString() } };
    const result = await runHostHelper({ ...request, action: "capsule.resume" }, { cwd: dir, env: { ...docker.env, FAKE_DOCKER_INSPECT_JSON: JSON.stringify(stopped) } });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.resumed, true, result.stdout);
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});


test('canonical public origin is registered as a routed alias and changes without unregistering', async () => {
  await withTempDir(async dir => {
    const remoteRoot = path.join(dir, 'remote-root');
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, 'caddy', 'hosts'), { recursive: true });
    await writeFile(path.join(remoteRoot, 'caddy', 'Caddyfile'), 'import ./sporades-hosted-domains.caddy\n');
    await writeFile(path.join(remoteRoot, 'caddy', 'hosts', 'capsules.example.dev.caddy'), 'import ./capsules.example.dev/*.caddy\n');
    const target = { host: { alias: 'personal', domain: 'capsules.example.dev', scheme: 'https', remoteRoot }, capsule: { subname: 'team-notes' } };
    const registered = await runHostHelper({ ...target, action: 'capsule.register', registration: { aliasDomains: ['other.example'], canonicalDomain: 'canonical.example' } }, { cwd: dir, env: caddy.env });
    assert.equal(JSON.parse(registered.stdout).ok, true, registered.stdout);
    assert.equal(JSON.parse(registered.stdout).data.capsule.publicOrigin, 'https://canonical.example');
    const recordPath = path.join(remoteRoot, 'hosts/capsules.example.dev/registry/capsules/team-notes.json');
    const first = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(first.canonicalDomain, 'canonical.example');
    assert.deepEqual(first.aliasDomains, ['other.example', 'canonical.example']);
    assert.match(await readFile(path.join(remoteRoot, 'caddy/hosts/capsules.example.dev/team-notes.caddy'), 'utf8'), /canonical\.example/);
    const change = async canonicalDomain => JSON.parse((await runHostHelper({ ...target, action: 'capsule.canonical.set', canonical: { domain: canonicalDomain } }, { cwd: dir, env: caddy.env })).stdout);
    const rejected = await change('unregistered.example');
    assert.equal(rejected.ok, false);
    assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).canonicalDomain, 'canonical.example');
    const changed = await change('other.example');
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.data.publicOrigin, 'https://other.example');
    assert.equal(changed.data.restarted, false, 'registration stays stopped');
    const cleared = await change(null);
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.data.publicOrigin, 'https://team-notes.capsules.example.dev');
    const final = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(final.createdAt, first.createdAt);
    assert.equal(final.hostedUrl, first.hostedUrl);
    assert.deepEqual(final.aliasDomains, first.aliasDomains);
  });
});


test('canonical restart failures remain retryable until started or explicitly stopped', async t => {
  for (const stop of [false, true]) await t.test(stop ? 'explicit stop cancels pending recreation' : 'same-value retry repairs failed restart', async () => {
    await withTempDir(async dir => {
      const fixture = await writeHostedCapsuleRollbackFixture(dir);
      await mkdir(path.join(fixture.remoteRoot, 'caddy/hosts/capsules.example.dev'), { recursive: true });
      await writeFile(path.join(fixture.remoteRoot, 'caddy/Caddyfile'), 'import ./hosts/*.caddy\n');
      const record = JSON.parse(await readFile(fixture.registryRecordPath, 'utf8'));
      record.aliasDomains = ['canonical.example'];
      await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUN_STATUSES: '1,0' } });
      const target = { host: { alias: 'personal', domain: fixture.domain, scheme: 'https', remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
      const invoke = async request => JSON.parse((await runHostHelper({ ...target, ...request }, { cwd: dir, env: docker.env })).stdout);
      const request = { action: 'capsule.canonical.set', canonical: { domain: 'canonical.example' } };
      const failed = await invoke(request);
      assert.equal(failed.ok, false, JSON.stringify(failed));
      assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, 'utf8')).canonicalDomain, 'canonical.example');
      if (stop) assert.equal((await invoke({ action: 'capsule.stop' })).ok, true);
      const callsBefore = (await docker.calls()).length;
      const retried = await invoke(request);
      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(retried.data.restarted, !stop);
      if (stop) assert.equal((await docker.calls()).length, callsBefore, 'stopped Capsules stay stopped');
      else {
        const run = (await docker.calls()).filter(call => call.args[0] === 'run').at(-1);
        assert(run.args.includes('SPORADES_PUBLIC_ORIGIN=https://canonical.example'));
      }
      const settledCalls = (await docker.calls()).length;
      assert.equal((await invoke(request)).data.restarted, false, 'settled retries do not recreate');
      assert.equal((await docker.calls()).length, settledCalls);
    });
  });
});


test('backup capture returns only after its actual changed route and protected runtime settle', () => withBackupRouteFixture(async f => {
  const result = await runHostHelper(f.request, { cwd: f.dir, env: f.docker.env });
  assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
  const observed = JSON.parse(await readFile(f.resticLog, 'utf8'));
  assert.match(observed.route, /reverse_proxy 127\.0\.0\.1:49154/);
  assert.equal(observed.journal, true, 'resume evidence survives the upload window');
  await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
  assert.match(observed.route, /alias\.example\.test/);
  assert.match(observed.route, /respond @sporadesRuntimeHealth 404/);
  assert.match(observed.route, /request_header -x-sporades-client-address/);
  assert.equal((await f.docker.calls()).filter(c => c.args[0] === 'start').length, 1);
  assert(!result.stdout.includes('a'.repeat(64)));
}));


test('backup capture failure still settles resume and preserves its original error', () => withBackupRouteFixture(async f => {
  await writeFile(path.join(f.data, 'data.db'), 'not a database');
  const result = await runHostHelper(f.request, { cwd: f.dir, env: f.docker.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false, result.stdout);
  assert.match(output.error.message, /database/);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
}));


test('interrupted backup resumes and settles the exact retained instance before a new capture', () => withBackupRouteFixture(async f => {
  await writeFile(f.state, JSON.stringify({ running: false, port: '' }));
  await writeFile(f.journal, JSON.stringify({ id: 'b'.repeat(64), releaseId: f.record.currentRelease.id }), { mode: 0o600 });
  const result = await runHostHelper(f.request, { cwd: f.dir, env: f.docker.env });
  assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
  assert.equal((await f.docker.calls()).filter(c => c.args[0] === 'start').length, 2);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
  await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
}));


test('automatic route recovery preserves stopped, unavailable, foreign and pending release boundaries', async t => {
  for (const scenario of ['stopped', 'failed', 'unregistered', 'not-running', 'unavailable', 'unmanaged', 'release-mismatch', 'stale-backup-id', 'deploy-journal', 'restore-journal', 'pointer-mismatch', 'invalid-inspection']) await t.test(scenario, () => withBackupRouteFixture(async f => {
    const record = { ...f.record };
    const env = { ...f.docker.env };
    if (['stopped', 'failed', 'unregistered'].includes(scenario)) record.status = scenario;
    if (scenario === 'not-running') await writeFile(f.state, JSON.stringify({ running: false, port: '' }));
    if (scenario === 'unavailable') await writeFile(f.routeFile, 'unavailable exact bytes\n');
    if (['unmanaged', 'release-mismatch'].includes(scenario)) {
      const container = JSON.parse(env.FAKE_DOCKER_INSPECT_JSON);
      container.Config.Labels[scenario === 'unmanaged' ? 'com.sporades.managed' : 'com.sporades.release-id'] = 'other';
      env.FAKE_DOCKER_INSPECT_JSON = JSON.stringify(container);
    }
    if (scenario === 'invalid-inspection') { delete env.FAKE_DOCKER_BACKUP_STATE; env.FAKE_DOCKER_INSPECT_JSON = 'bad-secret-inspection'; }
    if (scenario === 'stale-backup-id') await writeFile(f.journal, JSON.stringify({ id: 'd'.repeat(64) }), { mode: 0o600 });
    if (scenario === 'deploy-journal') {
      await mkdir(path.join(f.capsuleDir, 'preserved-files'), { recursive: true });
      const { attemptJournalPath } = await import('../dist/deploy-files.js');
      await writeFile(attemptJournalPath(path.join(f.capsuleDir, 'preserved-files')), 'pending');
    }
    if (scenario === 'restore-journal') await writeFile(path.join(f.capsuleDir, '.backup-restore.json'), 'pending');
    if (scenario === 'pointer-mismatch') { await rm(path.join(f.capsuleDir, 'current')); await symlink(path.join(f.capsuleDir, 'releases', 'different'), path.join(f.capsuleDir, 'current')); }
    await writeFile(f.registryRecordPath, JSON.stringify(record));
    const before = await readFile(f.routeFile);
    const result = await runHostHelper({ ...f.request, action: 'capsule.route.reconcile' }, { cwd: f.dir, env });
    const output = JSON.parse(result.stdout);
    assert.equal(output.data?.reconciled === true, false, result.stdout);
    assert(!result.stdout.includes('bad-secret-inspection'));
    assert.deepEqual(await readFile(f.routeFile), before);
    const calls = await f.docker.calls().catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    assert(!calls.some(c => ['start', 'stop', 'rm', 'run', 'exec'].includes(c.args[0])));
  }));
});


test('a cold runtime remains pending and is automatically retried after readiness', () => withBackupRouteFixture(async f => {
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
  const before = await readFile(f.routeFile);
  const cold = await runRouteRecoveryPass(f, { FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{ status: 503,
    body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: {ok:true}, fileStorage: {ok:true} } } } }]) });
  assert.equal(JSON.parse(cold.stdout).ok, false, cold.stdout);
  assert.deepEqual(await readFile(f.routeFile), before, 'readiness precedes Caddy publication');
  const ready = await runRouteRecoveryPass(f);
  assert.equal(JSON.parse(ready.stdout).ok, true, ready.stdout);
  assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
}));


test('recovery rebuilds a missing running route after interrupted publication without starting its container', () => withBackupRouteFixture(async f => {
  await rm(f.routeFile);
  await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
  const pass = await runRouteRecoveryPass(f);
  assert.equal(JSON.parse(pass.stdout).ok, true, pass.stdout);
  const route = await readFile(f.routeFile, 'utf8');
  assert.match(route, /reverse_proxy 127\.0\.0\.1:49154/);
  assert.match(route, /alias\.example\.test/);
  assert.match(route, /respond @sporadesRuntimeHealth 404/);
  assert(!(await f.docker.calls()).some(c => ['run','rm','start','stop'].includes(c.args[0])));
}));
