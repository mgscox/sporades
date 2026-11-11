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
TEST_PUBLIC_KEY,
buildHostLifecycle,
withTempDir,
withHttpServer,
reserveUnusedPort,
runCli,
startHostHelper,
runHostHelper,
startExecutable,
waitForHostHelperMarker,
stopHostHelper,
waitForPath,
createHostPauseGate,
hostEnv,
writeHostProfileConfig,
installFakeSsh,
installContractFakeSsh,
installFakeScp,
installFakeDocker,
installFakeCaddy,
installFakeCaddyUserCommands,
setupRootCapsuleHttpLogFixture,
readJsonl,
readProjectAuditEvents,
writeHostedCapsuleRollbackFixture,
listArchiveEntries,
listArchiveVerboseEntries,
extractArchiveFile,
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
prepareRouteLockFixture,
prepareUnregisterRouteFixture,
withBackupRouteFixture,
runRouteRecoveryPass
} from "./support/host-fixture.js";


test("Hosted prerender warnings reach human and structured successful CLI output", async () => {
  await withTempDir(async (dir) => {
    const fakeSsh = await installContractFakeSsh(path.join(dir, "fake-ssh"), `const request = JSON.parse(stdin); process.stdout.write(JSON.stringify({ ok:true, data:{ installed:true, release:{ id:request.release.id, files:request.release.files }, capsule:{ subname:request.capsule.subname, hostedUrl:request.release.hostedUrl } }, error:null }) + "\\n");`);
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const env = { ...hostEnv(hostFixtureConfig(dir, "machine-config")), ...fakeSsh.env, ...fakeScp.env, PATH:`${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}` };
    const created = await runCli(["create", "warning-capsule", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"], {cwd:dir});
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "warning-capsule");
    await installFakeReact(projectDir);
    await installPrerenderWarnings(projectDir);
    const added = await runCli(["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"], {cwd:projectDir, env});
    assert.equal(added.code, 0, added.stderr);
    for (const json of [true, false]) {
      assertPrerenderWarnings(await runCli(["host", "push", "--host", "work", "--subname", "warnings", ...(json ? ["--json"] : [])], {cwd:projectDir, env}), json);
    }
    const failedSsh = await installContractFakeSsh(path.join(dir, "failed-ssh"), 'process.stdout.write(JSON.stringify({ok:false,data:null,error:{message:"install rejected",hint:"retry install"}}) + "\\n");');
    const failed = await runCli(["host", "push", "--host", "work", "--subname", "warnings", "--json"], {cwd:projectDir, env:{...env, ...failedSsh.env, PATH:`${failedSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`}});
    assert.notEqual(failed.code, 0);
    const envelope = JSON.parse(failed.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data, null, 'build warnings never replace failure data');
    assert.match(envelope.error.message, /install rejected/);
  });
});


test("Hosted release requests carry only bounded required inspector metadata", () => {
  const base = {
    alias: "personal", profile: { domain: "capsules.example.dev", remoteRoot: "/srv/sporades" }, subname: "team-notes",
    binding: { hostedUrl: "https://team-notes.capsules.example.dev", remoteCapsuleId: "capsules.example.dev/team-notes" },
    releaseId: "20260903T010203Z-deadbeef", remoteArchive: "/srv/sporades/incoming/release.tar.gz",
    bundle: { containerMounts: { serverEnv: null } }, publicFiles: ["public/index.html"], restart: true,
    updatePolicyMode: "manual", sealedServerEnv: null, sshAccess: { enabled: false },
  };
  assert.deepEqual(createHostReleaseRequest({ ...base, requiredInspectors: ["content-policy-v1", "clamav"] }).inspection, {
    requiredInspectors: ["content-policy-v1", "clamav"],
  });
  assert.equal(createHostReleaseRequest({ ...base, requiredInspectors: [] }).inspection, null);
});



test("conditional token checks preserve live gates and TTL while enforcing refresh authority", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const hub = createWebSocketHub(() => { throw new Error("No database authority is needed"); });
  const token = hub.createConnectionToken();
  let calls = 0;
  try {
    await withHttpServer((request, response) => {
      if (routeConnectionToken(request, response, (current) => { calls += 1; return hub.createConnectionToken(current); })) return;
      response.writeHead(404); response.end();
    }, async (port) => {
      const url = `http://127.0.0.1:${port}/__sporades/connection-token`;
      const headers = { "x-sporades-connection-token-request": "1", "x-sporades-connection-token": token };
      now += 3 * 60 * 60 * 1000;
      const valid = await fetch(url, { headers });
      assert.equal(valid.status, 200);
      assert.equal(valid.headers.get("cache-control"), "no-store");
      assert.equal(valid.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal((await valid.json()).token === token, true, "checking a live token must not mint another");
      const denied = await fetch(url, { headers: { ...headers, origin: "https://evil.example.test" } });
      assert.equal(denied.status, 403);
      const unmarked = await fetch(url, { headers: { "x-sporades-connection-token": token } });
      assert.equal(unmarked.status, 403);
      assert.equal(calls, 1, "authority is checked before even validating a supplied token");
      now += 60 * 60 * 1000;
      const expired = await fetch(url, { headers });
      assert.equal((await expired.json()).token !== token, true, "checks do not extend the original four-hour TTL");
      const forced = await fetch(url, { headers: { "x-sporades-connection-token-request": "1" } });
      assert.equal((await forced.json()).token !== token, true, "manual refresh still mints a fresh token");
    });
  } finally { Date.now = originalNow; }
});


test("Host helper marker wait tolerates startup beyond two seconds", { timeout: 10_000 }, async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "delayed.marker");
    const action = startExecutable(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      setTimeout(() => writeFileSync(process.argv[1], "ready\\n"), 2200);
      setInterval(() => {}, 1000);
    `, marker]);
    try {
      assert.equal(await waitForHostHelperMarker(action, marker, (text) => text === "ready\n"), "ready\n");
    } finally {
      action.child.kill("SIGKILL");
      await action.result;
    }
  });
});


test("Host helper marker wait reports early child exit with captured output", { timeout: 5000 }, async () => {
  await withTempDir(async (dir) => {
    const action = startExecutable(process.execPath, ["-e", `
      process.stdout.write("fixture stdout\\n");
      process.stderr.write("fixture stderr\\n");
      process.exitCode = 17;
    `]);
    await assert.rejects(
      waitForHostHelperMarker(action, path.join(dir, "missing.marker"), () => true, 1000),
      (error) => {
        assert.match(error.message, /exited before.*missing\.marker/);
        assert.match(error.message, /code=17/);
        assert.match(error.message, /fixture stdout/);
        assert.match(error.message, /fixture stderr/);
        return true;
      },
    );
  });
});


test("Host helper marker wait remains bounded when a child never publishes its marker", { timeout: 5000 }, async () => {
  await withTempDir(async (dir) => {
    const action = startExecutable(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      await assert.rejects(
        waitForHostHelperMarker(action, path.join(dir, "missing.marker"), () => true, 100),
        /Timed out waiting for expected contents.*missing\.marker/,
      );
      assert.equal(action.child.exitCode, null);
      assert.equal(action.child.signalCode, null);
    } finally {
      action.child.kill("SIGKILL");
      await action.result;
    }
  });
});





test("Caddy Capsule route publication preserves service read access under restrictive umasks", async () => {
  await withTempDir(async (dir) => {
    const { remoteRoot } = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = { ...docker.env, ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}` };
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    for (const mask of [0o077, 0o022]) {
      for (const action of ["capsule.start", "capsule.stop"]) {
        const previous = process.umask(mask);
        let result;
        try {
          result = await runHostHelper({ action, host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
            capsule: { subname: "team-notes" } }, { cwd: dir, env });
        } finally { process.umask(previous); }
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const details = await stat(routeFile);
        assert.equal(details.mode & 0o777, 0o640, `${action}, umask ${mask.toString(8)}: Caddy must read and other users must not`);
        assert.equal(details.uid, process.getuid());
        assert.equal(details.gid, Number(caddyUser.env.FAKE_CADDY_GID));
        for (const directory of ["caddy", "caddy/hosts", "caddy/hosts/capsules.example.dev"]) {
          const parent = await stat(path.join(remoteRoot, directory));
          assert.equal(parent.mode & 0o777, 0o750);
          assert.equal(parent.gid, Number(caddyUser.env.FAKE_CADDY_GID));
        }
      }
    }
    const legacyBytes = await readFile(routeFile);
    await chmod(routeFile, 0o600);
    const bootstrap = await runHostHelper({ action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot } }, { cwd: dir, env });
    assert.equal(JSON.parse(bootstrap.stdout).ok, true, bootstrap.stdout + bootstrap.stderr);
    assert.equal((await stat(routeFile)).mode & 0o777, 0o640, "bootstrap upgrades legacy route permissions");
    assert.deepEqual(await readFile(routeFile), legacyBytes, "permission repair preserves the route bytes");
  });
});


test("sporades host invoke sends a JSON remote helper request over SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
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
    const configDir = hostFixtureConfig(dir, "machine-config");
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


test("sporades host health checks the selected Host profile and reports safe JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health");
      assert.match(request.headers.host, /^host\.localhost:\d+$/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
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

      const health = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          response: { ok: true },
        },
        error: null,
      });

      const explicitHealth = await runCli(["host", "health", "--host", "personal", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
      assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));
    });
  });
});


test("sporades host bootstrap reports missing Cloudflare origin certificate material with an actionable hint", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Cloudflare origin certificate material is missing or unusable.",
    hint: "Install readable Cloudflare origin certificate and key files at " + request.bootstrap.tls.certificate + " and " + request.bootstrap.tls.key + ", then rerun \`sporades host bootstrap --host " + request.host.alias + "\`."
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
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 1);
    assert.deepEqual(JSON.parse(bootstrap.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: "Install readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key, then rerun `sporades host bootstrap --host personal`.",
      },
    });
  });
});


test("sporades host helper fences sealed-key cleanup to the retained keys directory", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const keys = path.join(fixture.dataDir, "sealed-server-env", "keys");
    const stale = "9999999999999999";
    await mkdir(keys, { recursive: true });
    await writeFile(path.join(keys, `${stale}.private.pem`), "stale private\n", { mode: 0o600 });
    await writeFile(path.join(keys, `${stale}.public.pem`), "stale public\n", { mode: 0o644 });
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const marker = path.join(dir, "cleanup.marker");
    const gate = await createHostPauseGate(dir);
    const request = {
      action: "capsule.sealed-env.rotate-key",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
    };
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_TREE_PUBLICATION_BOUNDARY: "sealed-key-cleanup",
        SPORADES_TEST_RUNTIME_TREE_PUBLICATION_MARKER: marker,
        ...gate.env("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS"),
      },
    });
    await waitForPath(marker);
    // The helper is held at the publication boundary until the swap below is complete.
    await gate.entered("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS", { action });
    const retained = `${keys}.retained`;
    const outside = path.join(dir, "outside-cleanup");
    await mkdir(outside, { mode: 0o711 });
    for (const suffix of ["private", "public"]) await writeFile(path.join(outside, `${stale}.${suffix}.pem`), `outside ${suffix}\n`, { mode: suffix === "private" ? 0o604 : 0o644 });
    const before = await Promise.all((await readdir(outside)).map(async (name) => {
      const file = path.join(outside, name);
      const details = await lstat(file);
      return [name, createHash("sha256").update(await readFile(file)).digest("hex"), details.mode & 0o777, details.uid, details.gid];
    }));
    await rename(keys, retained);
    await symlink(outside, keys);
    await gate.release("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", result.stdout);
    const after = await Promise.all((await readdir(outside)).map(async (name) => {
      const file = path.join(outside, name);
      const details = await lstat(file);
      return [name, createHash("sha256").update(await readFile(file)).digest("hex"), details.mode & 0o777, details.uid, details.gid];
    }));
    assert.deepEqual(after, before);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).sealedServerEnv, undefined);
  });
});


test("sporades host helper provisions running and unavailable Capsule HTTP logs once by retained descriptor", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    for (const routeKind of ["running", "unavailable"]) {
      const fixture = await setupRootCapsuleHttpLogFixture(path.join(dir, routeKind), routeKind);
      const details = await lstat(fixture.logFile);
      const directoryDetails = await lstat(path.dirname(fixture.logFile));
      assert.deepEqual([Number(details.uid), Number(details.gid), Number(details.mode) & 0o777], [12345, 12346, 0o640], routeKind);
      assert.deepEqual([Number(directoryDetails.uid), Number(directoryDetails.gid), Number(directoryDetails.mode) & 0o777], [12345, 12346, 0o750], routeKind);

      const marker = path.join(dir, `${routeKind}-repeat-mutation.marker`);
      const repeat = await runHostHelper(fixture.request, {
        cwd: path.join(dir, routeKind),
        env: {
          ...fixture.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: `capsule-${routeKind}-http-log-descriptor-mutate`,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        },
      });
      assert.equal(JSON.parse(repeat.stdout).ok, true, `${routeKind} repeat: ${repeat.stdout}\n${repeat.stderr}`);
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
      assert.deepEqual(await fixture.caddyUser.chownCalls(), [], routeKind);

      await chown(fixture.logFile, 22345, 22346);
      const foreign = await runHostHelper(fixture.request, { cwd: path.join(dir, routeKind), env: fixture.env });
      assert.equal(JSON.parse(foreign.stdout).error.message, "Hosted Capsule route trust validation failed.", `${routeKind} foreign owner: ${foreign.stdout}`);
      assert.deepEqual([Number((await lstat(fixture.logFile)).uid), Number((await lstat(fixture.logFile)).gid)], [22345, 22346], routeKind);
    }
  });
});


test("sporades host helper fences running and unavailable Capsule HTTP log replacement after descriptor open", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    for (const routeKind of ["running", "unavailable"]) {
      const fixtureDir = path.join(dir, routeKind);
      const fixture = await setupRootCapsuleHttpLogFixture(fixtureDir, routeKind);
      await chmod(fixture.logFile, 0o600);
      const retainedLogFile = `${fixture.logFile}.retained`;
      const outside = path.join(fixtureDir, "outside.bin");
      await writeFile(outside, Buffer.from([2, 7, 1, 8, 2, 8]), { mode: 0o604 });
      const outsideBefore = await lstat(outside);
      const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
      const marker = path.join(fixtureDir, "descriptor-mutation.marker");
      const gate = await createHostPauseGate(fixtureDir);
      const action = startHostHelper(fixture.request, {
        cwd: fixtureDir,
        env: {
          ...fixture.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: `capsule-${routeKind}-http-log-descriptor-mutate`,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          ...gate.env("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS"),
        },
      });
      await waitForPath(marker);
      await gate.entered("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS", { action });
      await rename(fixture.logFile, retainedLogFile);
      await symlink(outside, fixture.logFile);
      await gate.release("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${routeKind}: ${result.stdout}`);

      const outsideAfter = await lstat(outside);
      assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash, routeKind);
      assert.equal(Number(outsideAfter.mode) & 0o777, Number(outsideBefore.mode) & 0o777, routeKind);
      assert.deepEqual([Number(outsideAfter.uid), Number(outsideAfter.gid)], [Number(outsideBefore.uid), Number(outsideBefore.gid)], routeKind);
      assert.equal(Number((await lstat(retainedLogFile)).mode) & 0o777, 0o640, `${routeKind} repair stayed on the retained file descriptor`);
      assert.deepEqual(await fixture.caddyUser.chownCalls(), [], routeKind);
    }
  });
});


test("sporades host helper does not commit registration when the unavailable route cannot be applied", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const failingCaddy = await installFakeCaddy(path.join(dir, "failing-caddy"), { env: { FAKE_CADDY_RELOAD_STATUS: "1" } });
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecord = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const request = {
      action: "capsule.register",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord,
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile,
          tls: { mode: "automatic", directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        },
      },
    };

    const failed = await runHostHelper(request, { cwd: dir, env: failingCaddy.env });
    assert.equal(failed.code, 0, failed.stderr);
    const failedOutput = JSON.parse(failed.stdout);
    assert.equal(failedOutput.ok, false);
    assert.equal(failedOutput.data, null);
    assert.equal(failedOutput.error.message, "Hosted Capsule registration recovery failed.");
    assert.match(failedOutput.error.hint, /Registration: Failed to apply Hosted Capsule route/);
    await assert.rejects(readFile(registryRecord, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });

    const repairedCaddy = await installFakeCaddy(path.join(dir, "repaired-caddy"));
    const repaired = await runHostHelper(request, { cwd: dir, env: repairedCaddy.env });
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).ok, true);
    assert.equal(JSON.parse(await readFile(registryRecord, "utf8")).status, "registered");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});


test("sporades host register creates authoritative remote state and then writes local binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.register") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.register." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId,
      aliasDomains: request.registration.aliasDomains
    },
    registryRecord: request.registration.registryRecord,
    directories: request.registration.directories,
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

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--alias-domain", "fourteen.example", "--alias-domain", "app.fourteen.example", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 0, register.stderr);

    const output = JSON.parse(register.stdout);
    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    const expectedBinding = {
      hostAlias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      subname: "team-notes",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    };
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.registered, true);
    assert.deepEqual(output.data.capsule.aliasDomains, ["fourteen.example", "app.fourteen.example"]);
    assert.equal(output.data.authoritative, true);
    assert.equal(output.data.localBinding, true);
    assert.match(output.data.bindingPath, /\.sporades\/remote-binding\.json$/);
    assert.deepEqual(output.data.binding, expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(output.data.bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(output.data.route, {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
      tls: {
        mode: "automatic",
        directory: "/opt/sporades/hosts/capsules.example.dev/tls",
        certificate: null,
        key: null,
      },
      log: {
        file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.register",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      registration: {
        aliasDomains: ["fourteen.example", "app.fourteen.example"],
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
          log: {
            file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
          },
        },
        baseImage: {
          name: "sporades-base",
          image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
          version: "0.3.0-node24-alpine",
          updatePolicy: {
            mode: "host-managed",
            autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
          },
        },
        bootstrap: {
          command: "sporades host bootstrap --host personal",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
        },
      },
    });
  });
});


test("sporades host push uploads a release archive with declared deploy.files and installs it without restart by default", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
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
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      archive: request.release.remoteArchive,
      directory: request.release.directories.release,
      currentLink: request.release.currentLink,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded
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

    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy.files = [{ path: "config/settings.json", update: "preserve" }, { path: "defaults.json" }];
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(path.join(projectDir, "config"));
    await writeFile(path.join(projectDir, "config/settings.json"), "settings seed", { mode: 0o600 });
    await mkdir(path.join(projectDir, ".sporades/host-push"), { recursive: true, mode: 0o755 });
    await chmod(path.join(projectDir, ".sporades/host-push"), 0o755);
    await writeFile(path.join(projectDir, "defaults.json"), "defaults seed");
    // A pre-telemetry Container keeps its mounted server Bundle while Host push
    // packages the current candidate built from changed Capsule source.
    const legacyBundle = await createBundle(projectDir, config);
    const canonicalServer = await readFile(legacyBundle.paths.serverBundle);
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), JSON.stringify({
      containerId: "legacy-container", containerName: "legacy-container",
      clientRelease: { framework: "react", toolchain: "esbuild", publicTree: "legacy-public-tree" },
    }));
    const serverEntry = path.join(projectDir, "server", "index.ts");
    await writeFile(serverEntry, (await readFile(serverEntry, "utf8")).replace('name: "todo-island"', 'name: "fresh-host-code"'));

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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.deepEqual(await readFile(legacyBundle.paths.serverBundle), canonicalServer);

    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.release.directory, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(output.data.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "config/settings.json",
      "defaults.json",
    ]);

    const stagingRoot = path.join(projectDir, ".sporades/host-push");
    const staging = path.join(stagingRoot, `${output.data.release.id}-files`);
    assert.equal((await stat(stagingRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(staging)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(staging, "config"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(staging, "config/settings.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(stagingRoot, `${output.data.release.id}.tar.gz`))).mode & 0o777, 0o600);
    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.match(scpCall.source, /\.sporades\/host-push\/.+\.tar\.gz$/);
    assert.equal(scpCall.target, `root@example.test:/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    const uploadedArchives = await readdir(fakeScp.uploadDir);
    assert.deepEqual(uploadedArchives, [`${output.data.release.id}.tar.gz`]);
    const entries = await listArchiveEntries(path.join(fakeScp.uploadDir, uploadedArchives[0]), projectDir);
    assert.equal(await extractArchiveFile(path.join(fakeScp.uploadDir, uploadedArchives[0]), "config/settings.json", projectDir), "settings seed");
    assert.match(await extractArchiveFile(path.join(fakeScp.uploadDir, uploadedArchives[0]), "server.mjs", projectDir), /fresh-host-code/);
    assert.deepEqual(entries, [
      "config/settings.json",
      "defaults.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    const request = JSON.parse(sshCall.stdin);
    assert.deepEqual(request.release.deployFiles, [{ path: "config/settings.json", update: "preserve" }, { path: "defaults.json", update: "replace" }]);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.capsule.subname, "team-notes");
    assert.equal(request.release.restart, false);
    assert.equal(request.release.remoteArchive, `/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    assert.equal(request.release.directories.data, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data");
    assert.equal(request.release.directories.release, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(request.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
  });
});


test("sporades host push packages generated SSH authorized keys without leaking source file paths", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const sourceKeyPath = path.join(dir, "operator.keys");
    await writeFile(sourceKeyPath, `# operator keys\n${TEST_PUBLIC_KEY}\n`);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
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
      ssh: request.release.ssh || null
    },
    lifecycle: {
      auditEvents: [{
        category: "audit",
        event: "ssh.access.enabled",
        data: {
          operation: "ssh.hosted-capsule.start",
          metadata: {
            enabled: true,
            keyCount: request.release.ssh?.keyCount ?? 0,
            fingerprints: request.release.ssh?.fingerprints ?? [],
            targetPort: 22,
            loopbackOnly: true
          }
        }
      }]
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "ssh-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ file: sourceKeyPath }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(Object.hasOwn(output.data.release, "ssh"), false);
    assert.equal(Object.hasOwn(output.data, "lifecycle"), false);
    assert.doesNotMatch(push.stdout, /auditEvents|ssh\.access\.enabled|ssh\.hosted-capsule\.start|SHA256:/);
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
    ]);
    assert.doesNotMatch(push.stdout, /\.sporades\/ssh\/authorized_keys/);
    assert.doesNotMatch(push.stdout, /operator\.keys/);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      ".sporades/ssh/authorized_keys",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    assert.equal(await extractArchiveFile(scpCall.copiedTo, ".sporades/ssh/authorized_keys", projectDir), `${TEST_PUBLIC_KEY}\n`);
    assert.match(
      (await listArchiveVerboseEntries(scpCall.copiedTo, projectDir)).find((entry) => entry.endsWith(" .sporades/ssh/authorized_keys")) ?? "",
      /^-rw-r--r--\s+/,
    );
    assert.doesNotMatch(await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir), /operator\.keys/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.deepEqual(request.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      ".sporades/ssh/authorized_keys",
    ]);
    assert.equal(request.release.ssh.enabled, true);
    assert.equal(request.release.ssh.keyCount, 1);
    assert.equal(request.release.ssh.authorizedKeysPath, ".sporades/ssh/authorized_keys");
    assert.equal(request.release.ssh.fingerprints.length, 1);
    assert.doesNotMatch(JSON.stringify(request.release.ssh), /operator\.keys/);

    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.config.validated", "ssh.config.validate", "completed"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.equal(auditEvents[0].data.targetResourceKind, "hosted-ssh-config");
    assert.equal(auditEvents[0].data.metadata.enabled, true);
    assert.equal(auditEvents[0].data.metadata.keyCount, 1);
    assert.deepEqual(auditEvents[0].data.metadata.fingerprints, request.release.ssh.fingerprints);
    assert.doesNotMatch(JSON.stringify(auditEvents), /operator\.keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|authorized_keys/);
  });
});


test("sporades host push strips disabled SSH config file paths from the release archive", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const sourceKeyPath = path.join(dir, "comments-only.keys");
    await writeFile(sourceKeyPath, "# no effective keys today\n\n");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
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
      ssh: request.release.ssh || null
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "disabled-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "disabled-ssh-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ file: sourceKeyPath }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.doesNotMatch(push.stdout, /comments-only\.keys/);
    assert.doesNotMatch(push.stdout, /\.sporades\/ssh\/authorized_keys/);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    const archiveConfig = await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir);
    assert.doesNotMatch(archiveConfig, /comments-only\.keys/);
    assert.equal(JSON.parse(archiveConfig).ssh, undefined);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.release.ssh, null);
    assert.deepEqual(request.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
    ]);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.metadata.enabled, entry.data.metadata.reason]),
      [["ssh.config.validated", "ssh.config.validate", "completed", false, "no-authorized-keys"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.doesNotMatch(JSON.stringify(auditEvents), /comments-only\.keys|authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);
  });
});


test("sporades host push rejects invalid SSH config before uploading a release", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: { message: "Unexpected helper call.", hint: "SSH validation should stop first." }
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "bad-host-ssh", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "bad-host-ssh");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ key: "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----" }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, false);
    assert.match(output.error.message, /private key/);
    assert.match(output.error.hint, /public authorized_keys material only/);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
      [["ssh.config.validated", "ssh.config.validate", "errored", "SSH_CONFIG_INVALID"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.equal(auditEvents[0].data.metadata.reason, "invalid-ssh-config");
    assert.doesNotMatch(JSON.stringify(auditEvents), /OPENSSH PRIVATE KEY|nope/);
    await assert.rejects(readFile(fakeScp.logPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(fakeSsh.logPath, "utf8"), { code: "ENOENT" });
  });
});


test("sporades host push re-encrypts Sealed Server env to the rotated current Hosted Capsule key", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const oldHostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const rotatedHostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const oldFingerprint = createHash("sha256").update(oldHostKeyPair.publicKey).digest("hex").slice(0, 16);
    const rotatedFingerprint = createHash("sha256").update(rotatedHostKeyPair.publicKey).digest("hex").slice(0, 16);
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
        registry: {
          sealedServerEnv: { currentKeyFingerprint: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT }
        },
        currentRelease: {
          id: "20260629T120000Z-deadbeef",
          sealedServerEnv: { publicKeyFingerprint: process.env.FAKE_OLD_HOST_PUBLIC_KEY_FINGERPRINT }
        },
        sealedServerEnv: {
          publicKey: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY,
          publicKeyFingerprint: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT,
          publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/" + process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT + ".public.pem"
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
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      FAKE_OLD_HOST_PUBLIC_KEY_FINGERPRINT: oldFingerprint,
      FAKE_ROTATED_HOST_PUBLIC_KEY: rotatedHostKeyPair.publicKey,
      FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT: rotatedFingerprint,
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
    const output = JSON.parse(push.stdout);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.equal(output.data.release.sealedServerEnv.publicKeyFingerprint, rotatedFingerprint);
    assert.notEqual(output.data.release.sealedServerEnv.publicKeyFingerprint, oldFingerprint);

    const [scpCall] = await readJsonl(fakeScp.logPath);
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
    assert.equal(JSON.parse(archiveEnvelope).publicKeyFingerprint, rotatedFingerprint);

    const [, installCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(installCall.stdin);
    assert.equal(request.release.sealedServerEnv.publicKeyFingerprint, rotatedFingerprint);
  });
});


test("sporades host push refuses legacy Server env values instead of silently importing them", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Should not be called.", hint: "Preflight should fail locally." } }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "legacy-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "legacy-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    assert.doesNotMatch(push.stdout, /swordfish|PRIVATE KEY/);
    const output = JSON.parse(push.stdout);
    assert.equal(output.error.message, "Hosted Capsule push requires Sealed Server env.");
    assert.match(output.error.hint, /sporades env import/);
    assert.deepEqual(output.error.diagnostics, {
      source: "legacy-server-env",
      legacyServerEnvFilePresent: true,
      localSealedServerEnvConfigured: false,
      requiresExplicitImport: true,
    });
    await fakeSsh.assertNotCalled?.();
    await assert.rejects(readFile(fakeScp.logPath, "utf8"), { code: "ENOENT" });
  });
});


test("sporades host push reports a structured recovery hint when local sealed source values are unavailable", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Should not be called.", hint: "Preflight should fail locally." } }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "missing-source-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "missing-source-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    await rm(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"));
    await rm(path.join(projectDir, ".env.sporades.server"));
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
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

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    const output = JSON.parse(push.stdout);
    assert.equal(output.error.message, "Local Sealed Server env source values are unavailable.");
    assert.match(output.error.hint, /local Sealed Server env private key|source-of-truth values/);
    assert.deepEqual(output.error.diagnostics, {
      source: "local-sealed-server-env",
      localSealedServerEnvConfigured: true,
      localPrivateKeyConfigured: false,
      legacyServerEnvFilePresent: false,
      requiresSourceOfTruthValues: true,
    });
    assert.doesNotMatch(push.stdout, /swordfish|PRIVATE KEY/);
  });
});


for (const { framework, template, toolchain, build } of CLIENT_CAPABILITIES.flatMap((capability) =>
  CLIENT_TEMPLATES.map((template) => ({ framework: capability.framework, toolchain: capability.toolchain, build: capability.build, template })),
)) test(`sporades host push archives the complete normalized ${framework} ${toolchain} ${template} public tree`, async () => {
  await withTempDir(async (dir) => {
    const selectedToolchain = toolchain;
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin); process.stdout.write(JSON.stringify({ ok: true, data: { installed: true, release: { id: request.release.id, files: request.release.files }, capsule: { subname: request.capsule.subname, hostedUrl: request.release.hostedUrl } }, error: null }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const created = await runCli(
      ["create", "vite-hosted", "--template", template, "--framework", framework, "--toolchain", selectedToolchain, "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-hosted");
    await (framework === "vanilla" ? async () => {} : framework === "react" ? installFakeReact : framework === "preact" ? installFakePreact : framework === "inferno" ? (project) => installProjectInfernoToolchain(project, repoRoot) : framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot) : framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot) : framework === "vue" ? installVue : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    const clientPath = path.join(projectDir, "client", build.entry);
    const clientSource = await readFile(clientPath, "utf8");
    await Promise.all([
      writeFile(path.join(projectDir, "client", "matrix-nested.ts"), 'import icon from "./matrix.svg"; import font from "./matrix.woff2"; export const matrixAsset = `${icon}:${font}`;\n'),
      writeFile(path.join(projectDir, "client", "matrix.css"), '@font-face{font-family:Matrix;src:url("./matrix.woff2")} .matrix-proof{background:url("./matrix.svg")}\n'),
      writeFile(path.join(projectDir, "client", "matrix.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n'),
      writeFile(path.join(projectDir, "client", "matrix.woff2"), "matrix-font-bytes\n"),
      writeFile(clientPath, `${clientSource}\nimport "./matrix.css"; import("./matrix-nested.ts").then(({ matrixAsset }) => console.log(matrixAsset));\n`),
    ]);
    if (template === "photo-library") {
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.auth = { providers: { anonymous: true } };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const env = {
      ...hostEnv(configDir), ...fakeSsh.env, ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal((await runCli(
      ["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"],
      { cwd: projectDir, env },
    )).code, 0);

    const push = await runCli(["host", "push", "--host", "work", "--subname", "vite-app", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    const files = output.data.release.files;
    assert(files.includes("public/index.html"));
    assert(files.some((file) => selectedToolchain === "esbuild" ? file === "public/client.js" : /^public\/assets\/index-[^/]+\.js$/.test(file)));
    assert(files.some((file) => /^public\/assets\/.+\.js$/.test(file) && !/^public\/assets\/index-/.test(file)), JSON.stringify(files));
    if (selectedToolchain === "vite" && (framework === "react" || framework === "preact")) assert(files.some((file) => /^public\/assets\/vite-scaffold-[^/]+\.js$/.test(file)));
    assert(files.filter((file) => file.startsWith("public/")).every((file) => !file.includes("..") && !file.includes("\\") && /\.(?:html|js|map|css|svg|png|jpe?g|gif|webp|ico|woff2?)$/.test(file)), "Hosted public paths stay bounded to supported MIME assets");
    assert(files.some((file) => file.endsWith(".js.map")));
    for (const extension of [".css", ".svg", ".woff2"]) assert(files.some((file) => file.endsWith(extension)), `${framework}/${toolchain}/${template} emits ${extension}`);
    assert.equal(files.includes("public/client.js"), selectedToolchain === "esbuild");

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const helperRequest = JSON.parse(sshCall.stdin);
    const validated = validateReleaseArchive(helperRequest, scpCall.copiedTo);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [...files.filter((file) => file.startsWith("public/")), "server.mjs", "sporades.json"].sort());
    assert.deepEqual(validated.files.map(({ path }) => path).sort(), [...entries].sort());
    assert(validated.files.every(({ path, size }) => Number.isSafeInteger(size) && size > 0 && !path.includes("..") && !path.includes("\\")));
    const hostedConfig = JSON.parse(await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir));
    assert.deepEqual(hostedConfig.client, { framework, toolchain });
    for (const extension of [".html", ".js", ".js.map", ".css", ".svg", ".woff2"]) {
      const representative = entries.find((file) => file.endsWith(extension));
      assert(representative, `${framework}/${toolchain}/${template} archive contains ${extension}`);
      assert((await extractArchiveFile(scpCall.copiedTo, representative, projectDir)).length > 0, representative);
    }
    const publicEntries = entries.filter((file) => file.startsWith("public/"));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree);
    const publicText = (await Promise.all(publicEntries.map((file) => readFile(path.join(publicRoot, file.slice("public/".length)), "utf8")))).join("\n");
    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(publicText, /dev\.refresh\.(?:subscribe|ready|received)/, "Hosted client output omits Dev refresh protocol");
    assert.doesNotMatch(serverBundle, /dev\.refresh\.(?:subscribe|ready|received)/, "Hosted server output omits Dev refresh capability and hints");
    assert.doesNotMatch(publicText, /\/@vite\/client|react-refresh|vite\/hmr|SERVER_ONLY/i);
    if (framework === "preact") assert.doesNotMatch(publicText, /node_modules\/react(?:-dom)?\/|from ["']react(?:-dom)?/);
    if (framework === "solid") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime/);
    }
    if (framework === "lit") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
    if (framework === "vue") assert.match(publicText, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "svelte") assert.match(publicText, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "inferno") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
  });
});


test("sporades host helper rejects invalid lifecycle authority before a sealed-key release changes state", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "sealed-lifecycle-authority" });
    const previousRelease = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(previousRelease, { recursive: true });
    await writeFile(path.join(previousRelease, "server.mjs"), "previous server\n");
    await symlink(previousRelease, path.join(fixture.capsuleDir, "current"));
    const privateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "server-env.private.pem");
    await mkdir(path.dirname(privateKeyPath), { recursive: true });
    await writeFile(privateKeyPath, "previous private key\n", { mode: 0o600 });
    fixture.release.restart = false;
    fixture.release.sealedServerEnvIncluded = true;
    fixture.release.sealedServerEnv = { privateKey: "replacement private key\n", privateKeyPath };
    fixture.release.files.push(".sporades/sealed-server-env/server-env.sealed.json");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const registryBefore = await readFile(fixture.registryRecordPath);
    const keyBefore = await readFile(privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle: { routes: { running: { upstream: "attacker.invalid:443" } } },
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule lifecycle authority.", result.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(readFile(docker.caddyLogPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(privateKeyPath), keyBefore);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});


test("sporades host helper descriptor-fences release-supplied Sealed Server env private keys", async () => {
  for (const replacement of ["final", "ancestor"]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: `release-private-key-${replacement}` });
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      record.status = "stopped";
      await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
      const privateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "server-env.private.pem");
      const stagedPrivateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "releases", `${fixture.releaseId}.private.pem`);
      fixture.release.restart = false;
      fixture.release.sealedServerEnvIncluded = true;
      fixture.release.sealedServerEnv = {
        privateKey: "-----BEGIN PRIVATE KEY-----\nrelease-owned fixture\n-----END PRIVATE KEY-----\n",
        privateKeyPath,
      };
      const sealedEnvelope = ".sporades/sealed-server-env/server-env.sealed.json";
      const expanded = path.join(dir, `expanded-${replacement}`);
      await mkdir(expanded);
      const extract = spawnSync("tar", ["-xzf", fixture.archivePath, "-C", expanded], { encoding: "utf8" });
      assert.equal(extract.status, 0, extract.stderr);
      await mkdir(path.dirname(path.join(expanded, sealedEnvelope)), { recursive: true });
      await writeFile(path.join(expanded, sealedEnvelope), '{"version":1,"valueAlgorithm":"aes-256-gcm","entries":{}}\n');
      fixture.release.files.push(sealedEnvelope);
      await rm(fixture.archivePath);
      await createTarGz(fixture.archivePath, expanded, fixture.release.files);
      const outsideDirectory = path.join(dir, "outside-release-private-key");
      const outside = path.join(outsideDirectory, "sentinel.bin");
      await mkdir(outsideDirectory, { mode: 0o711 });
      await writeFile(outside, Buffer.from([2, 7, 1, 8]), { mode: 0o604 });
      const before = await lstat(outside);
      const beforeHash = createHash("sha256").update(await readFile(outside)).digest("hex");
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });

      let action;
      if (replacement === "ancestor") {
        await mkdir(path.join(fixture.capsuleDir, "data"), { recursive: true });
        await symlink(outsideDirectory, path.join(fixture.capsuleDir, "data", "sealed-server-env"));
        action = { result: runHostHelper({
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
        }, { cwd: dir, env: docker.env }) };
      } else {
        const marker = path.join(dir, "release-private-key.marker");
        const gate = await createHostPauseGate(dir);
        action = startHostHelper({
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
        }, {
          cwd: dir,
          env: {
            ...docker.env,
            SPORADES_TEST_RUNTIME_TREE_PUBLICATION_BOUNDARY: "release-private-key-publish",
            SPORADES_TEST_RUNTIME_TREE_PUBLICATION_MARKER: marker,
            ...gate.env("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS"),
          },
        });
        await waitForPath(marker);
        await gate.entered("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS", { action });
        await symlink(outside, stagedPrivateKeyPath);
        await gate.release("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS");
      }

      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", `${replacement}: ${result.stdout}`);
      const after = await lstat(outside);
      assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), beforeHash);
      assert.deepEqual([after.mode & 0o777, after.uid, after.gid], [before.mode & 0o777, before.uid, before.gid]);
      await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
      await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
    });
  }
});


test("sporades host helper settles a missing previously-running runtime to stopped after install rollback", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "missing-running-install-rollback", restart: true });
    const staleRoute = [
      `team-notes.${fixture.domain} {`,
      "  reverse_proxy 127.0.0.1:49153",
      `  log { output file ${path.join(fixture.capsuleDir, "logs", "http.log")} }`,
      "}",
      "",
    ].join("\n");
    await writeFile(fixture.routeFile, staleRoute);
    const previousRecord = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));
    const keyBefore = await readFile(fixture.privateKeyPath);
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
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes("registry.example/next:2"));
    assert(!runs[0].args.includes("registry.example/previous:1"));
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });

    const settledRecord = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(settledRecord.status, "stopped");
    assert.deepEqual(settledRecord.baseImage, previousRecord.baseImage);
    assert.deepEqual(settledRecord.currentRelease, previousRecord.currentRelease);
    assert.deepEqual(settledRecord.releases, previousRecord.releases);
    const settledRoute = await readFile(fixture.routeFile, "utf8");
    assert.match(settledRoute, /respond "Hosted Capsule unavailable" 503/);
    assert.doesNotMatch(settledRoute, /127\.0\.0\.1:49153/);
  });
});


test("sporades host helper validates the built upgrade image then restores the registry image after failure", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "built-image-phase-restore", restart: true });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUN_STATUSES: "1,0" } });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes(lifecycle.container.image));
    assert(runs[1].args.includes("registry.example/previous:1"));
    assert(!runs[1].args.includes(lifecycle.container.image));
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});


test("sporades host helper rejects nested macOS archive metadata entries", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "{\"version\":1,\"valueAlgorithm\":\"aes-256-gcm\",\"entries\":{}}\n");
    await writeFile(path.join(runtimeDir, "metadata-server"), "discard me\n");
    await writeFile(path.join(runtimeDir, "metadata-envelope"), "discard me too\n");
    await createTarGzWithTransforms(archivePath, runtimeDir, [
      "|^metadata-server$|._server.mjs|",
      "|^metadata-envelope$|.sporades/sealed-server-env/._server-env.sealed.json|",
    ], [
      "metadata-server",
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "metadata-envelope",
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
        sealedServerEnv: { currentKeyFingerprint: "0123456789abcdef" },
      })}\n`,
    );
    const keysDir = path.join(capsuleDir, "data", "sealed-server-env", "keys");
    await mkdir(keysDir, { recursive: true });
    await writeFile(path.join(keysDir, "0123456789abcdef.private.pem"), "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n");

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
            publicKeyFingerprint: "0123456789abcdef",
            publicKeyPath: path.join(keysDir, "0123456789abcdef.public.pem"),
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
        message: "Hosted Capsule release archive contains unsupported metadata.",
        hint: "Push again without __MACOSX or AppleDouble metadata entries.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper reports remediation when data ownership cannot be prepared", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can chown test data to the runtime UID");
    return;
  }
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const archivePath = path.join(remoteRoot, "incoming", "20260630T221500Z-feedface.tar.gz");
    const runtimeDir = path.join(dir, "runtime-files");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
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
      { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "0", SPORADES_TEST_FORCE_RUNTIME_DATA_CHOWN_FAILURE: "1" } },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Unable to prepare Hosted Capsule data ownership for the non-root runtime user.");
    assert.match(output.error.hint, /sudo chown -R 10001:10001/);
  });
});


test("Hosted Capsule startup and restart accept legacy readiness without runtime bounds", async () => {
  for (const action of ["capsule.start", "capsule.restart"]) await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: `legacy-runtime-readiness-${action}`, restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
      FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{ status: 200, body: {
        ok: true,
        data: { runtime: { ready: true }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } },
        error: null,
      } }]),
    } });

    const result = await runHostHelper({
      action,
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
      // Readiness compatibility is independent of emulator process startup time.
      verification: { healthTimeoutMs: 5000 },
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, `${action}: ${result.stdout}`);
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
  });
});


test("sporades host helper serializes stale health repair against route removal", async () => {
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
      const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", "team-notes");
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
      await mkdir(path.join(capsuleDir, "data"), { recursive: true });
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`);
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `http://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "a".repeat(64) },
        })}\n`,
      );
      const healthRequest = {
        action: "capsule.health",
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      // A startup sleep cannot establish which helper owns the route lock.
      const gate = await createHostPauseGate(dir);
      const healthAction = startHostHelper(healthRequest, { cwd: dir, detached: true, env: {
        ...docker.env,
        ...gate.env("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS"),
      } });
      let unregisterAction;
      try {
        await gate.entered("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS", { action: healthAction });
        unregisterAction = startHostHelper(
          {
            action: "capsule.unregister",
            host: { alias: "personal", domain, scheme: "https", remoteRoot },
            capsule: { subname: "team-notes" },
          },
          { cwd: dir, detached: true, env: { ...docker.env, ...gate.env(), SPORADES_ROUTE_LOCK_TIMEOUT_MS: "60000" } },
        );
        // Release health only once unregister is provably queued behind its route lock.
        await gate.flockWaiter(routeFile + ".lock", { action: unregisterAction });
        await gate.release("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS");

        const [health, unregister] = await Promise.all([healthAction.result, unregisterAction.result]);
        assert.equal(health.code, 0, health.stderr);
        assert.equal(unregister.code, 0, unregister.stderr);
        assert.equal(JSON.parse(health.stdout).ok, true, health.stdout);
        assert.equal(JSON.parse(unregister.stdout).ok, true, unregister.stdout);
        await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });
        assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "unregistered");
        const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
        assert.deepEqual(debris, []);
      } finally {
        await gate.releaseAll();
        await Promise.all([stopHostHelper(healthAction), unregisterAction && stopHostHelper(unregisterAction)]);
      }
      const reloadsBeforeRepeat = (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length;
      const repeatedHealth = await runHostHelper(healthRequest, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, false);
      assert.equal(
        (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length,
        reloadsBeforeRepeat,
        "an unregistered route must not enter a health-triggered reload loop",
      );
    });
  });
});


test("sporades host helper serializes stale health repair against a concurrent start", async () => {
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
      const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", "team-notes");
      const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(releaseDir, { recursive: true });
      await mkdir(path.join(capsuleDir, "data"), { recursive: true });
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
      await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
      await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
      await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
      await symlink(releaseDir, path.join(capsuleDir, "current"));
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`);
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `http://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          releases: [{ id: "20260630T221500Z-feedface", state: "started", current: true, startAttempts: [] }],
          runtimeProbe: { header: "x-sporades-host-probe", token: "a".repeat(64) },
        })}\n`,
      );
      const baseRequest = {
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      const healthPromise = runHostHelper({ ...baseRequest, action: "capsule.health" }, { cwd: dir, env: docker.env });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const startPromise = runHostHelper({ ...baseRequest, action: "capsule.start" }, { cwd: dir, env: docker.env });

      const [health, start] = await Promise.all([healthPromise, startPromise]);
      assert.equal(health.code, 0, health.stderr);
      assert.equal(start.code, 0, start.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true, health.stdout);
      assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
      const route = await readFile(routeFile, "utf8");
      assert.match(route, /reverse_proxy 127\.0\.0\.1:49154/);
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
      assert.deepEqual(debris, []);
      const reloadsBeforeRepeat = (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length;
      const repeatedHealth = await runHostHelper({ ...baseRequest, action: "capsule.health" }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, true, repeatedHealth.stdout);
      assert.equal(
        (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length,
        reloadsBeforeRepeat,
        "the current start route must not enter a health-triggered reload loop",
      );
    });
  });
});





test("sporades host helper keeps read-only Capsule inspection available during a route mutation", async () => {
  await withTempDir(async (dir) => {
    // No timing budget. The mutation holds the route lock until the test creates `release`, so
    // the read is proven not to wait on the lock by completing while the mutation still holds it.
    // A read that queued behind the lock would instead fail with "route is locked" once its own
    // lock timeout expired, because the lock is not released until after the read has settled.
    const release = path.join(dir, "release-route-lock");
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_HOLD_UNTIL_PATH: release },
    });
    const mutation = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    let mutationSettled = false;
    mutation.result.then(() => { mutationSettled = true; });
    let read;
    try {
      await waitForPath(fixture.lockDir);
      read = startHostHelper({
        action: "capsule.release.list",
        host: fixture.request.host,
        capsule: fixture.request.capsule,
      }, { cwd: dir, env: fixture.docker.env });
      const readResult = await read.result;
      const readOutput = JSON.parse(readResult.stdout);
      assert.doesNotMatch(readOutput.error?.message ?? "", /route is locked/i, "read-only inspection must not wait behind route mutation");
      assert.equal(readOutput.ok, true, readResult.stdout);
      assert.equal(mutationSettled, false, "the mutation still holds the route lock while the read completes");
      await writeFile(release, "");
      assert.equal(JSON.parse((await mutation.result).stdout).ok, true);
    } finally {
      // Release the gate even after a failed assertion, and settle both helper processes before
      // the surrounding fixture removes their directory.
      await writeFile(release, "").catch(() => {});
      await Promise.allSettled([mutation.result, ...(read ? [read.result] : [])]);
    }
  });
});


test("sporades host helper rejects symlinks throughout the trusted route ancestor chain", async () => {
  await withTempDir(async (dir) => {
    const attacks = ["remoteRoot", "caddy", "hosts", "domain"];
    for (const attack of attacks) {
      const caseRoot = path.join(dir, attack);
      const realRoot = path.join(caseRoot, "real-root");
      const remoteRoot = path.join(caseRoot, "remote-root");
      const outside = path.join(caseRoot, "outside");
      await mkdir(realRoot, { recursive: true, mode: 0o700 });
      await mkdir(outside, { recursive: true, mode: 0o700 });
      if (attack === "remoteRoot") {
        await symlink(realRoot, remoteRoot, "dir");
      } else {
        await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
        const caddy = path.join(remoteRoot, "caddy");
        if (attack === "caddy") await symlink(outside, caddy, "dir");
        else {
          await mkdir(caddy, { mode: 0o755 });
          const hosts = path.join(caddy, "hosts");
          if (attack === "hosts") await symlink(outside, hosts, "dir");
          else {
            await mkdir(hosts, { mode: 0o755 });
            await symlink(outside, path.join(hosts, "capsules.example.dev"), "dir");
          }
        }
      }
      const result = await runHostHelper({
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {},
      }, { cwd: dir });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${attack}: ${result.stdout}`);
      assert.deepEqual(await readdir(outside), [], attack);
    }
  });
});


test("sporades host helper authenticates the complete route chain from the filesystem anchor", async () => {
  await withTempDir(async (dir) => {
    const unsafeParent = path.join(dir, "unsafe-parent");
    const unsafeRoot = path.join(unsafeParent, "remote-root");
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);
    const unsafe = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: unsafeRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(unsafe.stdout).error.message, "Hosted Capsule route trust validation failed.", unsafe.stdout);
    await assert.rejects(stat(unsafeRoot), { code: "ENOENT" });

    const stickyRoot = path.join(dir, "sticky-ancestor-accepted", "remote-root");
    const sticky = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: stickyRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(sticky.stdout).error.message, "Hosted Capsule is not registered.", sticky.stdout);
    assert.equal((await lstat(stickyRoot)).isDirectory(), true, "the root-owned sticky system temp ancestor is admitted");
  });
});





test("sporades host helper revalidates trust immediately before remove and restore route mutations", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      { boundary: "remove-remove-previous", dockerEnv: {} },
      { boundary: "remove-move-current", dockerEnv: {} },
      { boundary: "remove-rollback-restore", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "remove-finalize-previous", dockerEnv: {} },
      { boundary: "restore-remove-current", dockerEnv: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
      { boundary: "restore-publish-previous", dockerEnv: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
    ];
    for (const scenario of cases) {
      const caseRoot = path.join(dir, scenario.boundary);
      await mkdir(caseRoot, { recursive: true });
      const marker = path.join(caseRoot, "boundary.marker");
      const fixture = await prepareUnregisterRouteFixture(caseRoot, { env: scenario.dockerEnv });
      const domainDirectory = path.dirname(fixture.routeFile);
      const preservedDirectory = `${domainDirectory}.preserved`;
      const outside = path.join(caseRoot, "outside");
      await mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel.bin");
      await writeFile(sentinel, Buffer.from([4, 8, 15, 16, 23, 42]));
      const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
      const gate = await createHostPauseGate(caseRoot);
      const action = startHostHelper(fixture.request, {
        cwd: caseRoot,
        detached: true,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: scenario.boundary,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          ...gate.env("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS"),
        },
      });
      try {
        await waitForHostHelperMarker(action, marker, (text) => text === `${scenario.boundary}\n`);
        await gate.entered("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS", { action });
        await rename(domainDirectory, preservedDirectory);
        await symlink(outside, domainDirectory, "dir");
        await gate.release("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
        const result = await action.result;
        assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${scenario.boundary}: ${result.stdout}`);
        assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, scenario.boundary);
        assert.deepEqual(await readdir(outside), ["sentinel.bin"], scenario.boundary);
        const preservedEntries = await readdir(preservedDirectory);
        const originalEntry = preservedEntries.find((entry) => entry.startsWith("team-notes.caddy.previous-"))
          ?? preservedEntries.find((entry) => entry === "team-notes.caddy");
        assert.ok(originalEntry, `${scenario.boundary}: original route bytes must remain in the fenced directory`);
        assert.match(await readFile(path.join(preservedDirectory, originalEntry), "utf8"), /127\.0\.0\.1:49153/, scenario.boundary);
      } finally {
        await gate.releaseAll();
        await stopHostHelper(action);
      }
    }
  });
});


test("sporades host helper does not send the runtime probe credential to caller-supplied URLs", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);
    let maliciousRequests = 0;

    await withHttpServer((request, response) => {
      assert.equal(request.headers["x-sporades-host-probe"], "a".repeat(64));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (validPort) => {
      await withHttpServer((_request, response) => {
        maliciousRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: {}, error: null }));
      }, async (maliciousPort) => {
        const domain = `localhost:${validPort}`;
        const hostedUrl = `http://team-notes.localhost:${validPort}`;
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
              runtimeHealthUrl: `http://localhost:${maliciousPort}/__sporades/health/runtime`,
              hostedUrl: `http://localhost:${maliciousPort}`,
              remoteCapsuleId: `localhost:${maliciousPort}/team-notes`,
              container: { name: "sporades-capsules-example-dev-team-notes" },
            },
          },
          { cwd: dir, env: docker.env },
        );

        assert.equal(health.code, 0, health.stderr);
        assert.equal(JSON.parse(health.stdout).ok, true);
        assert.equal(maliciousRequests, 0);
        assert.equal(health.stdout.includes("a".repeat(64)), false);
      });
    });
  });
});


test("Sporades runtime health accepts a URL instance through its public request contract", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {});
    database.runtimeProbeToken = "a".repeat(64);
    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = body; },
    };

    try {
      const handled = await routeRuntimeHealth(database, {
        url: new URL("https://unrelated.example/__sporades/health/runtime"),
        method: "GET",
        headers: { "x-sporades-host-probe": "a".repeat(64) },
      }, response);

      assert.equal(handled, true);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).data.runtime.ready, true);
    } finally {
      database.close();
    }
  });
});


test("sporades host helper stops containers and routes Hosted Capsules to unavailable", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
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
      { cwd: dir, env: docker.env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.stopped, true);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_keep 5/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "stopped");
  });
});


test("sporades host helper unregisters Hosted Capsules with tombstone TTL and route removal", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
    await writeFile(path.join(capsuleDir, "data", "guestbook.json"), "[]\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-06-30T22:15:00.000Z",
        updatedAt: "2026-06-30T22:16:00.000Z",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123",
          Names: "sporades-capsules-example-dev-team-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 minutes",
          Labels:
            "com.sporades.managed=true,com.sporades.hosted-domain=capsules.example.dev,com.sporades.capsule-subname=team-notes",
        })}\n`,
      },
    });
    const request = {
      action: "capsule.unregister",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      unregister: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "caller-controlled-name" },
        routes: {
          removed: { hostname: "team-notes.capsules.example.dev", target: "removed", routeFile: path.join(dir, "caller-route.caddy") },
        },
      },
    };

    const before = Date.now();
    const unregister = await runHostHelper(request, { cwd: dir, env: docker.env });
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.route.routeFile, routeFile);
    assert.equal(output.data.route.removed, true);
    const deleteAfterMs = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfterMs >= before + 89 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfterMs <= after + 91 * 24 * 60 * 60 * 1000);
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });
    assert.equal((await stat(path.join(capsuleDir, "releases"))).isDirectory(), true);
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    assert.equal(await readFile(path.join(capsuleDir, "data", "guestbook.json"), "utf8"), "[]\n");

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.match(record.unregisteredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"]],
    );

    const duplicate = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );

    const list = await runHostHelper(
      { action: "capsule.list", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot } },
      { cwd: dir, env: docker.env },
    );
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).data.capsules, []);

    const missing = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "missing" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(missing.code, 0, missing.stderr);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.ok, false);
    assert.equal(missingOutput.error.message, "Hosted Capsule is not registered.");
    assert.match(missingOutput.error.hint, /sporades host register missing/);
  });
});


test("sporades host helper stats inspects admission from the exact current release history", async (t) => {
  const admissionFiles = [{ path: "policy.json", update: "admission" }];
  const releaseId = "20260101T000000Z-abcdef12";
  const digest = "a".repeat(64);
  const health = { state: "degraded", digest, rateLimit: { buckets: 2, maxBuckets: 10000, evictions: 3 } };
  for (const scenario of [
    { name: "normal push pointer with older release first", files: admissionFiles, expected: health },
    { name: "revoked declaration ignores historical and stale pointer metadata", files: [], stalePointer: true, probe: false },
    { name: "missing exact release ignores historical declaration", missing: true, probe: false },
    { name: "legacy current release metadata", legacy: true, expected: health },
    { name: "malformed inspection stays opaque", files: admissionFiles, stdout: "truncated-private-probe", expected: null },
    { name: "failed inspection preserves resource stats", files: admissionFiles, exitStatus: 1, expected: null },
  ]) await t.test(scenario.name, async () => withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const recordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    const source = { deployFiles: admissionFiles };
    await writeFile(recordPath, JSON.stringify({
      subname: "team-notes", domain: "capsules.example.dev", status: "running",
      currentRelease: { id: releaseId, ...(scenario.legacy || scenario.stalePointer ? { source } : {}) },
      ...(scenario.legacy ? {} : { releases: [
        { id: "20251231T000000Z-deadbeef", source },
        ...(!scenario.missing ? [{ id: releaseId, source: { deployFiles: scenario.files } }] : []),
      ] }),
    }) + "\n");
    const docker = await installFakeDocker(dir, { env: {
      FAKE_DOCKER_STATS_JSON: JSON.stringify({ CPUPerc: "12.34%", PIDs: "11" }),
      FAKE_DOCKER_RUNTIME_PROBE_RESULTS: JSON.stringify([{
        stdout: scenario.stdout ?? JSON.stringify({ admissionPolicy: { ...health, address: "private-runtime-address", capability: "private-runtime-capability" } }),
        exitStatus: scenario.exitStatus ?? 0,
      }]),
    } });
    const result = await runHostHelper({
      action: "capsule.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      stats: { hostedUrl: "https://team-notes.capsules.example.dev", remoteCapsuleId: "capsules.example.dev/team-notes", container: { name: "sporades-capsules-example-dev-team-notes" } },
    }, { cwd: dir, env: docker.env });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.stats.cpuPercent, 12.34);
    const probes = (await docker.calls()).filter(call => call.args[0] === "exec");
    assert.equal(probes.length, scenario.probe === false ? 0 : 1);
    if (scenario.probe === false) assert.equal(Object.hasOwn(output.data, "admissionPolicy"), false);
    else {
      assert.deepEqual(output.data.admissionPolicy, scenario.expected);
      assert.deepEqual(probes[0].args, ["exec", "sporades-capsules-example-dev-team-notes", "node", "--input-type=module", "--eval", ADMISSION_INSPECTION_SCRIPT]);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /private-runtime|truncated-private-probe/);
  }));
});


test("sporades host helper lists an empty Hosted Capsule registry", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    await mkdir(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"), { recursive: true });

    const list = await runHostHelper({
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
    });

    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [],
      },
      error: null,
    });
  });
});


test("sporades host helper lists registry records enriched with Docker container state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    const draftsKeyFingerprint = "0123456789abcdef";
    const draftsPublicKey = "-----BEGIN PUBLIC KEY-----\npublic-drafts\n-----END PUBLIC KEY-----\n";
    const draftsKeyDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "drafts", "data", "sealed-server-env", "keys");
    await mkdir(registryDir, { recursive: true });
    await mkdir(draftsKeyDir, { recursive: true });
    await writeFile(path.join(draftsKeyDir, `${draftsKeyFingerprint}.public.pem`), draftsPublicKey);
    await writeFile(path.join(draftsKeyDir, `${draftsKeyFingerprint}.private.pem`), "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n");
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentRelease: null,
        sealedServerEnv: { currentKeyFingerprint: draftsKeyFingerprint },
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        currentRelease: {
          id: "20260103T000000Z-abcdef12",
          createdAt: "2026-01-03T00:00:00.000Z",
          bundleHash: "sha256:abc123",
        },
        sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
        releases: [
          {
            id: "20260103T000000Z-abcdef12",
            createdAt: "2026-01-03T00:00:00.000Z",
            uploadedAt: "2026-01-03T00:00:00.000Z",
            state: "started",
            current: true,
            source: {
              hostedUrl: "https://notes.capsules.example.dev",
              files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: "0123456789abcdef" },
            },
          },
        ],
        baseImage: {
          updatePolicy: { mode: "manual" },
        },
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "archive.json"),
      `${JSON.stringify({
        subname: "archive",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/archive",
        hostedUrl: "https://archive.capsules.example.dev",
        status: "stopped",
        createdAt: "2026-01-04T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
        currentRelease: { id: "20260105T000000Z-fedcba98" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: [
          JSON.stringify({
            ID: "abc123def456",
            Names: "sporades-capsules-example-dev-notes",
            Image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
            State: "running",
            Status: "Up 2 hours",
            Labels:
              "com.sporades.managed=true,com.sporades.hosted-domain=capsules.example.dev,com.sporades.capsule-subname=notes,com.sporades.base-image.name=sporades-base,com.sporades.base-image.version=0.3.0-node24-alpine,com.sporades.base-image.update-policy=manual",
          }),
          JSON.stringify({
            ID: "fedcba654321",
            Names: "sporades-capsules-example-dev-archive",
            Image: "node:22-alpine",
            State: "exited",
            Status: "Exited (0) 3 minutes ago",
          }),
        ].join("\n") + "\n",
      },
    });

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
    assert.doesNotMatch(list.stdout, /PRIVATE KEY|nope/);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [
          {
            aliasDomains: [],
            subname: "archive",
            domain: "capsules.example.dev",
            hostedUrl: "https://archive.capsules.example.dev",
            publicOrigin: "https://archive.capsules.example.dev",
            canonicalDomain: null,
            registry: {
              remoteCapsuleId: "capsules.example.dev/archive",
              createdAt: "2026-01-04T00:00:00.000Z",
              updatedAt: "2026-01-05T00:00:00.000Z",
              status: "stopped",
            },
            currentRelease: { id: "20260105T000000Z-fedcba98" },
            docker: {
              containerId: "fedcba654321",
              containerName: "sporades-capsules-example-dev-archive",
              image: "node:22-alpine",
              state: "exited",
              status: "Exited (0) 3 minutes ago",
              running: false,
            },
            baseImage: {
              name: "unknown",
              image: "node:22-alpine",
              version: "unknown",
              updatePolicy: {
                mode: "host-managed",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
          {
            aliasDomains: [],
            subname: "drafts",
            domain: "capsules.example.dev",
            hostedUrl: "https://drafts.capsules.example.dev",
            publicOrigin: "https://drafts.capsules.example.dev",
            canonicalDomain: null,
            registry: {
              remoteCapsuleId: "capsules.example.dev/drafts",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              status: "registered",
              sealedServerEnv: { currentKeyFingerprint: draftsKeyFingerprint },
            },
            sealedServerEnv: {
              publicKey: draftsPublicKey,
              publicKeyFingerprint: draftsKeyFingerprint,
              publicKeyPath: path.join(draftsKeyDir, `${draftsKeyFingerprint}.public.pem`),
              status: "available",
              publicKeyAvailable: true,
              privateKeyAvailable: true,
            },
            currentRelease: null,
            docker: null,
            baseImage: {
              name: "unknown",
              image: "unknown",
              version: "unknown",
              updatePolicy: {
                mode: "host-managed",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
          {
            aliasDomains: [],
            subname: "notes",
            domain: "capsules.example.dev",
            hostedUrl: "https://notes.capsules.example.dev",
            publicOrigin: "https://notes.capsules.example.dev",
            canonicalDomain: null,
            registry: {
              remoteCapsuleId: "capsules.example.dev/notes",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
              status: "running",
              sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
            },
            currentRelease: {
              id: "20260103T000000Z-abcdef12",
              createdAt: "2026-01-03T00:00:00.000Z",
              bundleHash: "sha256:abc123",
              sealedServerEnv: { publicKeyFingerprint: "0123456789abcdef" },
            },
            sealedServerEnv: {
              publicKeyFingerprint: "fedcba9876543210",
              publicKeyPath: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "notes", "data", "sealed-server-env", "keys", "fedcba9876543210.public.pem"),
              status: "missing-key-material",
              publicKeyAvailable: false,
              privateKeyAvailable: false,
            },
            docker: {
              containerId: "abc123def456",
              containerName: "sporades-capsules-example-dev-notes",
              image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
              state: "running",
              status: "Up 2 hours",
              running: true,
              baseImage: {
                name: "sporades-base",
                version: "0.3.0-node24-alpine",
                updatePolicy: { mode: "manual" },
              },
            },
            baseImage: {
              name: "sporades-base",
              image: "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
              version: "0.3.0-node24-alpine",
              updatePolicy: {
                mode: "manual",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
        ],
      },
      error: null,
    });

    const dockerCalls = await readJsonl(docker.logPath);
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=archive",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
  });
});


test("sporades host helper lists Hosted Capsule releases in deterministic order", async () => {
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
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: true,
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          { id: "", state: "nonsense" },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: false,
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs"] },
          },
        ],
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );
    assert.deepEqual(output.data.releases[0].startAttempts, [{ startedAt: "2026-06-30T22:16:00.000Z" }]);
    assert.deepEqual(output.data.releases[1].verificationAttempts, [{ verifiedAt: "2026-06-29T12:02:00.000Z" }]);
  });
});


test("sporades host helper reports missing and stopped Hosted Capsules for stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const request = {
      action: "capsule.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      stats: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "sporades-capsules-example-dev-team-notes" },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir });
    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before reading stats.",
      },
    });

    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(path.join(dir, "stopped"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no running container.",
        hint: "Run `sporades host start team-notes --host personal`, then retry stats.",
      },
    });

    const dockerInspectUnavailable = await installFakeDocker(path.join(dir, "docker-inspect-unavailable"), {
      env: { FAKE_DOCKER_RUNNING_STATUS: "1" },
    });
    const inspectUnavailable = await runHostHelper(request, { cwd: dir, env: dockerInspectUnavailable.env });
    assert.equal(inspectUnavailable.code, 0, inspectUnavailable.stderr);
    assert.deepEqual(JSON.parse(inspectUnavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });

    const dockerUnavailable = await installFakeDocker(path.join(dir, "docker-unavailable"), { env: { FAKE_DOCKER_STATS_STATUS: "1" } });
    const unavailable = await runHostHelper(request, { cwd: dir, env: dockerUnavailable.env });
    assert.equal(unavailable.code, 0, unavailable.stderr);
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});


test("sporades host helper reports Host server resource and Hosted Capsule counts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260103T000000Z-abcdef12" },
      })}\n`,
    );

    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123def456",
          Names: "sporades-capsules-example-dev-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 hours",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "host.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.host, {
      alias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      remoteRoot,
    });
    assert.equal(output.data.resources.disk.path, remoteRoot);
    assert.equal(typeof output.data.resources.disk.totalBytes, "number");
    assert.equal(typeof output.data.resources.memory.totalBytes, "number");
    assert.deepEqual(Object.keys(output.data.resources.load), ["oneMinute", "fiveMinutes", "fifteenMinutes"]);
    assert.deepEqual(output.data.services, {
      docker: { available: true },
      caddy: { available: true },
    });
    assert.deepEqual(output.data.capsules, {
      total: 2,
      registered: 1,
      running: 1,
      stopped: 0,
      unavailable: 1,
    });

    const dockerCalls = await docker.calls();
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      ["version", "--format", "{{.Server.Version}}"],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
    const caddyCalls = await docker.caddyCalls();
    assert.deepEqual(caddyCalls.map((call) => call.args), [["version"]]);
  });
});


test("sporades host helper reports malformed registry state for Host server stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    const recordPath = path.join(registryDir, "broken.json");
    await writeFile(recordPath, "{not-json}\n");

    const stats = await runHostHelper({
      action: "host.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
    });

    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule registry record is invalid.",
        hint: `Repair the Host server registry record at ${recordPath}, then retry \`sporades host stats --host personal\`.`,
      },
    });
  });
});


test("sporades host helper reads capsule-scoped HTTP logs from the Hosted Capsule log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleLog = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log");
    await mkdir(path.dirname(capsuleLog), { recursive: true });
    await writeFile(
      capsuleLog,
      [
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/old"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        logs: { source: "http", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: [
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
        ],
      },
      error: null,
    });
  });
});


test("sporades host helper preserves previous route when Caddy validation fails", async () => {
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
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_VALIDATE_STATUS: "1" } });
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
        message: "Failed to validate Hosted Capsule route.",
        hint: "Check the generated Caddy route for this Hosted Capsule, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.equal((await stat(routeFile)).mode & 0o777, 0o640, "the retained legacy route remains readable after failure");
    assert.deepEqual((await caddy.calls()).map((call) => call.args), [["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"]]);
  });
});


test("sporades host helper returns a standard JSON error when the Hosted domain registry is locked", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const lockDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", ".lock");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(lockDir, { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", status: "running" })}\n`);
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
      { cwd: dir, env: { ...docker.env, SPORADES_REGISTRY_LOCK_TIMEOUT_MS: "30" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain registry is locked.",
        hint: "Wait for the other Host server operation to finish, then retry the command.",
      },
    });
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
  });
});


test("sporades host helper rejects an unknown restart image before Docker Caddy or state mutation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: "registry.example/sporades-base:previous", version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    lifecycle.container.image = "attacker.invalid/root:latest";
    const routeFile = lifecycle.routes.running.routeFile;
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(routeFile, "previous exact route bytes\n");
    const registryBefore = await readFile(fixture.registryRecordPath);
    const routeBefore = await readFile(routeFile);
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule lifecycle authority.", result.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(readFile(docker.caddyLogPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(routeFile), routeBefore);
  });
});


test("sporades host helper builds the base image when registry pull is unavailable", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(remoteRoot, "Dockerfile.base"), "FROM node:22-alpine\n");
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_IMAGE_INSPECT_STATUS: "1",
        FAKE_DOCKER_PULL_STATUS: "1",
        FAKE_DOCKER_BUILD_STATUS: "0",
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
    assert.equal(JSON.parse(start.stdout).ok, true);
    const calls = await docker.calls();
    assert.deepEqual(
      calls.filter((call) => ["image", "pull", "build"].includes(call.args[0])).map((call) => call.args),
      [
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"],
        ["pull", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"],
        ["build", "-f", path.join(remoteRoot, "Dockerfile.base"), "-t", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine", remoteRoot],
      ],
    );
    assert.ok(calls.some((call) => call.args[0] === "run"));
  });
});


test("sporades host helper delete recovers partial cleanup and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const dataDir = path.join(capsuleDir, "data");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(dataDir, "leftover.db"), "partial cleanup leftover\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "unregistered",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const partial = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(partial.code, 0, partial.stderr);
    const partialOutput = JSON.parse(partial.stdout);
    assert.equal(partialOutput.ok, true);
    assert.equal(partialOutput.data.idempotent, false);
    assert.equal(partialOutput.data.registryRecord.removed, true);
    assert.equal(partialOutput.data.registryRecord.alreadyAbsent, false);
    assert.equal(partialOutput.data.directories.capsule.removed, true);
    assert.equal(partialOutput.data.route.removed, false);
    assert.equal(partialOutput.data.route.alreadyAbsent, true);
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });

    const retry = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(retry.code, 0, retry.stderr);
    const retryOutput = JSON.parse(retry.stdout);
    assert.equal(retryOutput.ok, true);
    assert.equal(retryOutput.data.idempotent, true);
    assert.equal(retryOutput.data.registryRecord.alreadyAbsent, true);
    assert.equal(retryOutput.data.directories.capsule.alreadyAbsent, true);
    assert.equal(retryOutput.data.route.alreadyAbsent, true);
  });
});


test("sporades host helper derives install paths from Host state instead of request-supplied directories", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const outsideDir = path.join(dir, "outside-target");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
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
            capsule: outsideDir,
            releases: path.join(outsideDir, "releases"),
            release: path.join(outsideDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(outsideDir, "data"),
          },
          currentLink: path.join(outsideDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.release.directory, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    assert.equal(output.data.release.currentLink, path.join(capsuleDir, "current"));
    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readlink(path.join(capsuleDir, "current")), path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(stat(path.join(outsideDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(outsideDir, "current")), { code: "ENOENT" });
  });
});


test("sporades host helper rejects known macOS archive metadata before release install", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await mkdir(path.join(runtimeDir, "__MACOSX"), { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, "metadata-root"), "appledouble metadata\n");
    await writeFile(path.join(runtimeDir, "metadata-nested"), "appledouble metadata\n");
    await createTarGzWithTransforms(archivePath, runtimeDir, [
      "|^metadata-root$|._server.mjs|",
      "|^metadata-nested$|__MACOSX/._server.mjs|",
    ], [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "metadata-root",
      "metadata-nested",
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
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule release archive contains unsupported metadata.");
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper rejects archives with unexpected or missing runtime files", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "source.ts"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

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
        message: "Hosted Capsule release archive contains unexpected files.",
        hint: "Push again so Sporades can package only runtime files.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper rejects release archives with parent-relative paths", async () => {
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
    await writeFile(path.join(dir, "outside.txt"), "must not extract outside release\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json", "../outside.txt"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

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
        message: "Hosted Capsule release archive contains unsafe paths.",
        hint: "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper rejects duplicate, normalization-colliding, and bounded-public-tree archive abuse", async (t) => {
  for (const mode of ["absolute", "duplicate", "normalization-collision", "prefix-normalization-collision", "overlong", "oversized", "excess-files", "metadata-over-count", "metadata-over-byte"]) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const fixture = await writeArchiveSecurityFixture(dir, mode);
        const install = await runHostHelper(fixture.request, { cwd: dir });
        assert.equal(install.code, 0, install.stderr);
        const output = JSON.parse(install.stdout);
        assert.equal(output.ok, false, `${mode}: ${install.stdout}`);
        if (mode === "prefix-normalization-collision") assert.equal(output.error.message, "Invalid Hosted Capsule release file list.");
        assert.match(output.error.message, /unsafe paths|unexpected files|duplicate paths|file list|exceeds release bounds|archive exceeds bounds/);
        await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
        await assert.rejects(stat(path.join(fixture.capsuleDir, "data")), { code: "ENOENT" });
      });
    });
  }
});


test("sporades host helper restarts the current release after install when requested", async () => {
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
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", aliasDomains: ["fourteen.example"] })}\n`);
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
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
        lifecycle: {
          mounts: {
            files: [
              { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
              { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
              { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
              { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
            ],
            data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args[0]),
      ["inspect", "stop", "rm", "image", "run", "inspect", "inspect", "inspect", "exec", "inspect", "inspect"],
    );
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert.equal(output.data.lifecycle.container.publishedPort.hostPort, 49153);
    assert.equal(output.data.lifecycle.route.upstream, "127.0.0.1:49153");
    assert.ok((await readFile(output.data.lifecycle.route.routeFile, "utf8")).includes("fourteen.example {\n"));
    assert.ok(runCall.args.includes('SPORADES_PUBLIC_ALIASES=["https://fourteen.example"]'));
  });
});


test("sporades host helper applies verification fallback with the selected release's recorded ClamAV readiness window", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-fallback-success",
      domain: `localhost:${port}`,
      scheme: "http",
      deployFiles: [{ path: "settings.json", update: "replace" }],
    });
    const previousReleaseDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(path.join(previousReleaseDir, "public", "assets"), { recursive: true });
    await writeFile(path.join(previousReleaseDir, "server.mjs"), "export default 'previous';\n");
    await writeFile(path.join(previousReleaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(previousReleaseDir, "public", "index.html"), '<script type="module" src="/assets/previous-deadbeef.js"></script>\n');
    await writeFile(path.join(previousReleaseDir, "public", "assets", "previous-deadbeef.js"), "console.log('previous complete release');\n");
    await writeFile(path.join(previousReleaseDir, "settings.json"), "previous seed");
    const preservedRoot = path.join(fixture.capsuleDir, "preserved-files");
    await mkdir(preservedRoot, { recursive: true });
    await writeFile(preservedDeployFilePath(preservedRoot, "settings.json"), "server edit");
    const before = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    before.releases[0].source = { inspection: { requiredInspectors: ["clamav"] }, deployFiles: [{ path: "settings.json", update: "preserve" }] };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(before, null, 2)}\n`);
    fixture.release.inspection = null;
    const clock = path.join(dir, "fallback-stepping-clock.mjs");
    await writeFile(clock, "const values = [0, 1, 2, 3, 20000, 20001]; let index = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => values[Math.min(index++, values.length - 1)] } }); let wall = 0; Date.now = () => { wall += 200000; return wall; };\n");
    const docker = await installFakeDocker(path.join(dir, "verify-fallback-success-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          fallbackToPreviousRelease: true,
        },
      },
      { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.fallback.applied, true);
    assert.equal(output.data.fallback.release.id, fixture.previousReleaseId);
    assert.equal(output.data.fallback.lifecycle.release.id, fixture.previousReleaseId);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert(runs[0].args.includes(`${path.join(fixture.capsuleDir, "current/settings.json")}:/app/settings.json:ro`));
    assert(runs.at(-1).args.includes(`${preservedDeployFilePath(preservedRoot, "settings.json")}:/app/settings.json:rw`));
    assert(!runs.at(-1).args.includes(`${path.join(fixture.capsuleDir, "current/settings.json")}:/app/settings.json:ro`));

    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), previousReleaseDir);
    assert.match(await readFile(path.join(fixture.capsuleDir, "current", "public", "index.html"), "utf8"), /previous-deadbeef\.js/);
    assert.match(await readFile(path.join(fixture.capsuleDir, "current", "public", "assets", "previous-deadbeef.js"), "utf8"), /previous complete release/);
    await assert.rejects(stat(path.join(fixture.capsuleDir, "current", "public", "assets", "app-a1b2.js")), { code: "ENOENT" });

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const failedRelease = record.releases.find((entry) => entry.id === fixture.releaseId);
    const fallbackRelease = record.releases.find((entry) => entry.id === fixture.previousReleaseId);
    assert.equal(record.currentRelease.id, fixture.previousReleaseId);
    assert.equal(record.status, "running");
    assert.equal(failedRelease.current, false);
    assert.equal(failedRelease.fallbackAttempts.length, 1);
    assert.equal(failedRelease.fallbackAttempts[0].releaseId, fixture.previousReleaseId);
    assert.equal(fallbackRelease.current, true);
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "exec").length, 2, "candidate and fallback both require authenticated runtime readiness");
  });
});


test("sporades host helper keeps failed release current when ordinary fallback ignores the candidate ClamAV window", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-fallback-restart-failure",
    });
    const previousReleaseDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(previousReleaseDir, { recursive: true });
    await writePublicRuntimeFiles(previousReleaseDir);
    await writeFile(path.join(previousReleaseDir, "server.mjs"), "export default 'previous';\n");
    await writeFile(path.join(previousReleaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    const before = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    before.releases[0].source = {};
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(before, null, 2)}\n`);
    fixture.release.inspection = { requiredInspectors: ["clamav"] };
    const clock = path.join(dir, "fallback-stepping-clock.mjs");
    await writeFile(clock, "const values = [0, 1, 2, 3, 20000, 20001]; let index = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => values[Math.min(index++, values.length - 1)] } }); let wall = 0; Date.now = () => { wall += 200000; return wall; };\n");
    const docker = await installFakeDocker(path.join(dir, "verify-fallback-restart-failure-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          fallbackToPreviousRelease: true,
        },
      },
      { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${clock}` } },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "fallback-restart-failed");
    assert.equal(output.data.fallback.release.id, fixture.previousReleaseId);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const failedRelease = record.releases.find((entry) => entry.id === fixture.releaseId);
    const fallbackRelease = record.releases.find((entry) => entry.id === fixture.previousReleaseId);
    assert.equal(record.currentRelease.id, fixture.releaseId);
    assert.equal(record.status, "failed");
    assert.equal(failedRelease.current, true);
    assert.equal(failedRelease.state, "failed");
    assert.equal(failedRelease.fallbackAttempts.length, 1);
    assert.equal(failedRelease.fallbackAttempts[0].releaseId, fixture.previousReleaseId);
    assert.equal(failedRelease.fallbackAttempts[0].failure.message, "Hosted Capsule fallback restart failed.");
    assert.equal(fallbackRelease.current, false);
  });
});


test("sporades host helper reports push restart failure after installing the release", async () => {
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
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

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
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: {
        installed: false,
        restartRequested: true,
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
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          serverEnvIncluded: false,
        },
        rollback: { applied: true, previousCurrentRelease: null },
      },
      error: {
        message: "Hosted Capsule restart failed.",
        hint: "Check Docker logs for sporades-capsules-example-dev-team-notes; the route has been returned to the Hosted Capsule unavailable response.",
      },
    });
    await assert.rejects(readlink(path.join(capsuleDir, "current")), { code: "ENOENT" });
    assert.deepEqual(await readFile(registryRecordPath), registryBefore);
    await assert.rejects(lstat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});


test("sporades host helper rolls back to a recorded release and preserves persistent Capsule data", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releasesDir = path.join(capsuleDir, "releases");
    const currentReleaseDir = path.join(releasesDir, "20260630T221500Z-feedface");
    const rollbackReleaseDir = path.join(releasesDir, "20260629T120000Z-deadbeef");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(currentReleaseDir, { recursive: true });
    await mkdir(rollbackReleaseDir, { recursive: true });
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    for (const releaseDir of [currentReleaseDir, rollbackReleaseDir]) {
      await writePublicRuntimeFiles(releaseDir);
      await writeFile(path.join(releaseDir, "server.mjs"), `export default ${JSON.stringify(path.basename(releaseDir))};\n`);
      await writeFile(path.join(releaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    }
    await symlink(currentReleaseDir, path.join(capsuleDir, "current"));
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "photo.bin"), "uploaded bytes\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"] },
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
          },
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: false,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"] },
            startAttempts: [],
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
          },
        ],
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        rollback: { releaseId: "20260629T120000Z-deadbeef" },
        lifecycle: {
          remoteRoot,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rolledBack, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260629T120000Z-deadbeef");
    assert.equal(await readlink(path.join(capsuleDir, "current")), rollbackReleaseDir);
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "sqlite bytes\n");
    assert.equal(await readFile(path.join(dataDir, "uploads", "photo.bin"), "utf8"), "uploaded bytes\n");
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.ok(runCall);
    assert.ok(runCall.args.includes(`${dataDir}:/app/data:rw`));
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: false },
        { id: "20260629T120000Z-deadbeef", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
  });
});


test("sporades host helper rejects rollback to an unknown release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: "20260628T120000Z-cafebabe" },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    assert.deepEqual(JSON.parse(rollback.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release is not recorded.",
        hint: "Run `sporades host releases team-notes --host personal --json` and choose a recorded release ID.",
      },
    });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});


test("sporades host helper rejects rollback when selected release files are missing", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      missingFiles: ["20260629T120000Z-deadbeef/server.mjs"],
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
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule release files are missing.");
    assert.match(output.error.hint, /recorded release cannot be started/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});


test("sporades host helper rejects rollback when recorded nested public assets are missing", async (t) => {
  const missingAssets = [
    "public/assets/app-a1b2.js",
    "public/assets/app-a1b2.css",
    "public/assets/fonts/app-a1b2.woff2",
    "public/assets/app-a1b2.js.map",
  ];
  for (const missingAsset of missingAssets) {
    await t.test(missingAsset, async () => {
      await withTempDir(async (dir) => {
        const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: `rollback-missing-${path.basename(missingAsset)}`, previousReleaseId: null });
        fixture.release.restart = false;
        const installed = await runHostHelper(
          {
            action: "capsule.release.install",
            host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
            capsule: { subname: fixture.subname },
            release: fixture.release,
          },
          { cwd: dir },
        );
        assert.equal(JSON.parse(installed.stdout).ok, true, installed.stdout);
        const nextId = "20260701T120000Z-cafebabe";
        const nextDir = path.join(fixture.capsuleDir, "releases", nextId);
        await mkdir(path.join(nextDir, "public"), { recursive: true });
        await writeFile(path.join(nextDir, "server.mjs"), "export default {};\n");
        await writeFile(path.join(nextDir, "sporades.json"), "{}\n");
        await writeFile(path.join(nextDir, "public", "index.html"), "<div>next</div>\n");
        await rm(path.join(fixture.capsuleDir, "current"));
        await symlink(nextDir, path.join(fixture.capsuleDir, "current"));
        const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
        record.currentRelease = { id: nextId };
        record.releases.push({ id: nextId, state: "verified", current: true, source: { files: ["server.mjs", "sporades.json", "public/index.html"] } });
        await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
        await rm(path.join(fixture.capsuleDir, "releases", fixture.releaseId, ...missingAsset.split("/")));

        const rollback = await runHostHelper(
          {
            action: "capsule.release.rollback",
            host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
            capsule: { subname: fixture.subname },
            rollback: { releaseId: fixture.releaseId },
          },
          { cwd: dir },
        );

        assert.equal(rollback.code, 0, rollback.stderr);
        const output = JSON.parse(rollback.stdout);
        assert.equal(output.ok, false);
        assert.match(output.error.message, /release files are missing|release inventory changed/);
        assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), nextDir);
      });
    });
  }
});


test("sporades host helper records failed rollback starts and leaves the route unavailable", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

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
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Hosted Capsule rollback start failed.");
    assert.match(output.error.hint, new RegExp(`Previous current release was ${fixture.currentReleaseId}`));
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), fixture.rollbackReleaseDir);
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.startAttempts.length, 1);
    assert.equal(release.failure.message, "Hosted Capsule container did not stay running.");
  });
});


test("sporades host helper returns rollback route reload failures to the unavailable route", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

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
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Failed to apply Hosted Capsule route.");
  });
});


test("sporades host register reports bootstrap-required failures with TLS file hints", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted domain has not been bootstrapped.",
    hint: "Run \`" + request.registration.bootstrap.command + "\` after installing readable Cloudflare origin certificate and key files at " + request.registration.bootstrap.tls.certificate + " and " + request.registration.bootstrap.tls.key + "."
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
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain has not been bootstrapped.",
        hint: "Run `sporades host bootstrap --host personal` after installing readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key.",
      },
    });
  });
});


test("sporades host register validates lowercase DNS-safe non-reserved Capsule subnames before SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "register", "Team_Notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Capsule subname.",
        hint: "Use a lowercase DNS-safe label such as `notes` or `team-notes`.",
      },
    });

    const reserved = await runCli(["host", "register", "www", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(reserved.code, 1);
    assert.deepEqual(JSON.parse(reserved.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Reserved Capsule subname.",
        hint: "Choose a Capsule subname other than www, api, admin, root, or host.",
      },
    });

    await fakeSsh.assertNotCalled();
  });
});


test("sporades host unregister invokes the Hosted Capsule unregister helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.unregister") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.unregister." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    unregistered: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.unregister.hostedUrl,
      remoteCapsuleId: request.unregister.remoteCapsuleId
    },
    deleteAfter: "2026-09-29T12:00:00.000Z",
    route: request.unregister.routes.removed,
    container: request.unregister.container
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

    const unregister = await runCli(["host", "unregister", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.deleteAfter, "2026-09-29T12:00:00.000Z");

    const plain = await runCli(["host", "unregister", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule unregistered: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.unregister",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      unregister: {
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
        container: {
          name: "sporades-capsules-example-dev-team-notes",
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


test("sporades host releases lists release history for one Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    currentRelease: { id: "20260630T221500Z-feedface" },
    releases: [
      {
        id: "20260630T221500Z-feedface",
        createdAt: "2026-06-30T22:15:00.000Z",
        uploadedAt: "2026-06-30T22:15:00.000Z",
        state: "started",
        current: true,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
        verificationAttempts: [],
        failure: null
      },
      {
        id: "20260629T120000Z-deadbeef",
        createdAt: "2026-06-29T12:00:00.000Z",
        uploadedAt: "2026-06-29T12:00:00.000Z",
        state: "verified",
        current: false,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-29T12:01:00.000Z" }],
        verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
        failure: null
      }
    ]
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

    const releases = await runCli(["host", "releases", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.list",
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


test("sporades host helper inspects effective Hosted Capsule SSH state from Docker", async () => {
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
          source: {
            ssh: {
              enabled: true,
              authorizedKeysPath: ".sporades/ssh/authorized_keys",
              keyCount: 1,
              fingerprints: ["SHA256:test"]
            }
          }
        }]
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_INSPECT_JSON: JSON.stringify({
          State: { Running: true },
          Config: { User: "10001:10001" },
          NetworkSettings: {
            Ports: {
              "22/tcp": [
                { HostIp: "127.0.0.1", HostPort: "49162" },
              ],
            },
          },
        }),
      },
    });

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
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.enabled, true);
    assert.equal(output.data.running, true);
    assert.equal(output.data.user, "sporades");
    assert.equal(output.data.host, "127.0.0.1");
    assert.equal(output.data.port, 49162);
    assert.equal(output.data.targetPort, 22);
    assert.equal(output.data.keyCount, 1);
    assert.deepEqual(output.data.fingerprints, ["SHA256:test"]);
    assert.equal(output.data.reason, null);
    assert.deepEqual(
      output.data.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.state.inspected", "ssh.hosted-capsule.inspect", "completed"]],
    );
    assert.equal(output.data.auditEvents[0].data.surface, "sporades-host-helper/capsule.ssh");
    assert.equal(output.data.auditEvents[0].data.metadata.enabled, true);
    assert.equal(output.data.auditEvents[0].data.metadata.running, true);
    assert.equal(output.data.auditEvents[0].data.metadata.loopbackOnly, true);
    assert.equal(output.data.auditEvents[0].data.metadata.port, 49162);
    assert.deepEqual(output.data.auditEvents[0].data.metadata.fingerprints, ["SHA256:test"]);
    assert.doesNotMatch(JSON.stringify(output.data.auditEvents), /authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);
    assert.deepEqual((await docker.calls()).map((call) => call.args), [
      ["inspect", "--format", "{{json .}}", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});


test("sporades host current reports effective Hosted security policy without contacting the Host server", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
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
    await writeFile(
      path.join(dir, "sporades.json"),
      `${JSON.stringify(
        {
          name: "hosted-security-island",
          client: { framework: "react" },
          security: {
            cors: { allowedOrigins: ["https://dashboard.example.test"] },
            csp: { mode: "enforce" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const fakeSsh = await installFakeSsh(dir);

    const current = await runCli(["host", "current", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(current.code, 0, current.stderr);
    const body = JSON.parse(current.stdout);
    assert.equal(body.data.alias, "personal");
    assert.equal(body.data.security.csp.header, "content-security-policy");
    assert.deepEqual(body.data.security.cors.allowedOrigins, ["https://dashboard.example.test"]);
    await fakeSsh.assertNotCalled();
  });
});


test("sporades host logs retrieves default HTTP log lines as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.logs" || request.logs?.source !== "http") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected log request.", hint: "Use host.logs for Caddy combined logs." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines ?? 200,
    source: request.logs.source,
    entries: ["203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] \\"GET / HTTP/1.1\\" 200 12"]
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
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) })).code, 0);

    const logs = await runCli(["host", "logs", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 200,
        source: "http",
        entries: ['203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] "GET / HTTP/1.1" 200 12'],
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.logs",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      logs: {
        source: "http",
      },
    });
  });
});


test("sporades host logs handles empty logs, SSH failure, and remote helper failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
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
    };

    const emptyLogsSsh = await installContractFakeSsh(
      path.join(dir, "empty-logs"),
      `process.stdout.write(JSON.stringify({ ok: true, data: { lineCount: JSON.parse(stdin).logs.lines, entries: [] }, error: null }) + "\\n");
process.exit(0);
`,
    );
    await addHost(emptyLogsSsh.env);
    const emptyLogs = await runCli(["host", "logs", "--host", "personal"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...emptyLogsSsh.env },
    });
    assert.equal(emptyLogs.code, 0, emptyLogs.stderr);
    assert.equal(emptyLogs.stdout, "");

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
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

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Host server Caddy combined logs are unavailable.",
    hint: "Run \`sporades host bootstrap --host personal\` and check Caddy on the Host server."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});


test("sporades host github workflow associates pull request deploy results", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /pull_request:\n    branches: \["main"\]/);
    assert.match(workflow, /pull-requests: write/);
    assert.match(workflow, /if: always\(\) && github\.event_name == 'pull_request'/);
    assert.match(workflow, /actions\/github-script@v7/);
    assert.match(workflow, /github\.rest\.pulls\.createReview/);
    assert.match(workflow, /pull_number: context\.payload\.pull_request\.number/);
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY/);
  });
});


test("sporades host validation returns standard JSON errors", async () => {
  await withTempDir(async (dir) => {
    const configDir = hostFixtureConfig(dir, "machine-config");
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


test("Hosted deploy.files rollback preflights retained storage before changing pointers", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "rollback-preflight-docker"));
    const first = await writeHostedCapsuleInstallFixture(dir, { rootName: "rollback-preflight", previousReleaseId: null,
      releaseId: "20260912T150000Z-feedface", deployFiles: [{ path: "settings.json", update: "preserve" }] });
    const request = { host: { alias: "personal", domain: first.domain, remoteRoot: first.remoteRoot }, capsule: { subname: first.subname } };
    const installed = await runHostHelper({ ...request, action: "capsule.release.install", release: first.release }, { cwd: dir, env: docker.env });
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    const firstRecord = await readFile(first.registryRecordPath);
    const second = await writeHostedCapsuleInstallFixture(dir, { rootName: "rollback-preflight", previousReleaseId: null,
      releaseId: "20260912T150100Z-feedface", deployFiles: [{ path: "settings.json" }] });
    await writeFile(first.registryRecordPath, firstRecord);
    const replaced = await runHostHelper({ ...request, action: "capsule.release.install", release: second.release }, { cwd: dir, env: docker.env });
    assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
    const stored = preservedDeployFilePath(path.join(first.capsuleDir, "preserved-files"), "settings.json");
    const route = path.join(first.remoteRoot, "caddy/hosts", first.domain, `${first.subname}.caddy`);
    const registryBefore = await readFile(first.registryRecordPath);
    const routeBefore = await readFile(route);
    const pointerBefore = await readlink(path.join(first.capsuleDir, "current"));
    for (const unsafe of [false, true]) {
      await rm(stored, { force: true });
      if (unsafe) await symlink(path.join(first.release.directories.release, "settings.json"), stored);
      const before = (await docker.calls()).length;
      const failed = await runHostHelper({ ...request, action: "capsule.release.rollback", rollback: { releaseId: first.release.id } }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
      assert.deepEqual(await readFile(first.registryRecordPath), registryBefore);
      assert.deepEqual(await readFile(route), routeBefore);
      assert.equal(await readlink(path.join(first.capsuleDir, "current")), pointerBefore);
      assert.equal((await docker.calls()).slice(before).filter((call) => ["stop", "rm", "run"].includes(call.args[0])).length, 0);
    }
  });
});


test("Hosted deploy.files repairs atomic-save ownership before quiescing and preserves service on repair failure", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "restart-file-access", previousReleaseId: null,
      deployFiles: [{ path: "settings.json", update: "preserve" }] });
    const docker = await installFakeDocker(path.join(dir, "restart-access-docker"));
    const request = { host: { alias: "personal", domain: fixture.domain, remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    const installed = await runHostHelper({ ...request, action: "capsule.release.install", release: fixture.release }, { cwd: dir, env: docker.env });
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    const stored = preservedDeployFilePath(path.join(fixture.capsuleDir, "preserved-files"), "settings.json");
    await writeFile(path.join(dir, "replacement"), "atomic edit", { mode: 0o400 });
    await rename(path.join(dir, "replacement"), stored);
    const registry = await readFile(fixture.registryRecordPath);
    const route = path.join(fixture.remoteRoot, "caddy/hosts", fixture.domain, `${fixture.subname}.caddy`);
    const routeBefore = await readFile(route);
    const count = (await docker.calls()).length;
    const failed = await runHostHelper({ ...request, action: "capsule.restart" }, { cwd: dir, env: { ...docker.env, SPORADES_TEST_FORCE_RUNTIME_DATA_CHOWN_FAILURE: "1" } });
    assert.equal(JSON.parse(failed.stdout).ok, false, failed.stdout);
    assert.equal((await docker.calls()).slice(count).filter((call) => ["stop", "rm", "run"].includes(call.args[0])).length, 0);
    assert.deepEqual(await readFile(fixture.registryRecordPath), registry);
    assert.deepEqual(await readFile(route), routeBefore);
    const timeline = path.join(dir, "access-timeline.jsonl");
    const preload = path.join(dir, "track-file-repair.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import child from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.open;
fs.promises.open = async function(file, ...args) {
  const handle = await original.call(this, file, ...args);
  if (String(file).endsWith(${JSON.stringify(`/preserved-files/${path.basename(stored)}`)})) {
    const chown = handle.chown.bind(handle);
    handle.chown = async (...values) => { fs.appendFileSync(${JSON.stringify(timeline)}, JSON.stringify({ chown: values }) + '\\n'); return chown(...values); };
  }
  return handle;
};
const spawn = child.spawnSync;
child.spawnSync = function(command, args, ...rest) {
  if (command === 'docker' && ['stop', 'rm', 'run'].includes(args[0])) fs.appendFileSync(${JSON.stringify(timeline)}, JSON.stringify({ docker: args[0] }) + '\\n');
  return spawn.call(this, command, args, ...rest);
}; syncBuiltinESMExports();`);
    const repaired = await runHostHelper({ ...request, action: "capsule.restart" }, { cwd: dir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    const events = (await readFile(timeline, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events[0], { chown: [10001, 10001] });
    assert(events.findIndex((event) => event.docker === "stop") > 0);
    assert.equal((await stat(stored)).mode & 0o777, 0o600);
    assert.equal(await readFile(stored, "utf8"), "atomic edit");
  });
});


test("Host boot recovery resumes a previously running Capsule through authenticated startup", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "boot-resume", restart: false });
    await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "running";
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
      FAKE_DOCKER_INSPECT_JSON: JSON.stringify({ State: { Running: false, Status: "exited", ExitCode: 0 }, RestartCount: 0, Config: { Labels: {
        "com.sporades.managed": "true", "com.sporades.hosted-domain": fixture.domain, "com.sporades.capsule-subname": fixture.subname,
      } } }),
    } });
    const result = await runHostHelper({ action: "capsule.resume", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } }, { cwd: dir, env: docker.env });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.resumed, true);
    const calls = await docker.calls();
    assert(calls.some(c => c.args[0] === "exec"), "resumed runtime must pass authenticated readiness");
    const run = calls.find(c => c.args[0] === "run");
    assert.equal(run.args[run.args.indexOf("--restart") + 1], "on-failure:3");
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});


test('canonical domain updates recreate a running Capsule with canonical links and both browser origins', async () => {
  await withTempDir(async dir => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    await mkdir(path.join(fixture.remoteRoot, 'caddy/hosts/capsules.example.dev'), { recursive: true });
    await writeFile(path.join(fixture.remoteRoot, 'caddy/Caddyfile'), 'import ./hosts/*.caddy\n');
    const record = JSON.parse(await readFile(fixture.registryRecordPath, 'utf8'));
    record.aliasDomains = ['canonical.example'];
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const docker = await installFakeDocker(dir);
    const target = { host: { alias: 'personal', domain: fixture.domain, scheme: 'https', remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } };
    const result = JSON.parse((await runHostHelper({ ...target, action: 'capsule.canonical.set', canonical: { domain: 'canonical.example' } }, { cwd: dir, env: docker.env })).stdout);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.restarted, true);
    const run = (await docker.calls()).find(call => call.args[0] === 'run');
    assert(run, 'running Capsules are recreated');
    assert(run.args.includes('SPORADES_PUBLIC_ORIGIN=https://canonical.example'));
    const aliases = JSON.parse(run.args.find(arg => arg.startsWith('SPORADES_PUBLIC_ALIASES=')).slice('SPORADES_PUBLIC_ALIASES='.length));
    assert(aliases.includes('https://team-notes.capsules.example.dev'));
    assert(aliases.includes('https://canonical.example'));
    const after = JSON.parse(await readFile(fixture.registryRecordPath, 'utf8'));
    assert.equal(after.currentRelease.id, record.currentRelease.id);
    assert.equal(after.hostedUrl, record.hostedUrl);
  });
});


// Route settlement must be part of resume, without a separate health command.
test("backup resume settles a changed Docker publication before clearing its journal", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "backup-route", restart: false });
    await alignSealedFixtureWithBuiltLifecycle(fixture);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "running";
    record.runtimeProbe = { header: "x-sporades-host-probe", token: "a".repeat(64) };
    await writeFile(fixture.registryRecordPath, JSON.stringify(record));
    const journal = path.join(fixture.capsuleDir, ".backup-resume.json");
    await writeFile(journal, JSON.stringify({ id: "b".repeat(64) }), { mode: 0o600 });
    await mkdir(path.dirname(fixture.routeFile), { recursive: true });
    await writeFile(fixture.routeFile, `team-notes.${fixture.domain} {\n reverse_proxy 127.0.0.1:49153 {\n }\n}\n`);
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: {
      FAKE_DOCKER_INSPECT_JSON: JSON.stringify({ Id: "b".repeat(64), State: { Running: true }, Config: { Labels: {
        "com.sporades.managed": "true", "com.sporades.hosted-domain": fixture.domain,
        "com.sporades.capsule-subname": fixture.subname, "com.sporades.release-id": record.currentRelease.id,
      } } }), FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
    } });
    const result = await runHostHelper({ action: "capsule.route.reconcile", host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot }, capsule: { subname: fixture.subname } }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49154/);
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    assert(!(await docker.calls()).some(c => ["start", "stop", "rm", "run"].includes(c.args[0])));
  }, { privateAncestors: true });
});


test('automatic route recovery cannot republish during a deliberate backup stop', () => withBackupRouteFixture(async f => {
  const backup = startHostHelper(f.request, { cwd: f.dir, env: { ...f.docker.env, FAKE_DOCKER_CADDY_DELAY_MS: '750' } });
  await waitForHostHelperMarker(backup, f.journal, text => JSON.parse(text).id === 'b'.repeat(64));
  const concurrent = await runRouteRecoveryPass(f);
  assert.equal(JSON.parse(concurrent.stdout).data.pending, 1, concurrent.stdout);
  const output = await backup.result;
  assert.equal(JSON.parse(output.stdout).ok, true, output.stdout);
  assert.equal((await f.docker.calls()).filter(c => c.args[0] === 'start').length, 1);
  await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
}));


test('Host route timer retries current state on startup and after outages without restarting Docker', async () => {
  const { hostRouteRecoveryUnits } = await import('../dist/cli/host-autostart.js');
  const h = { alias: 'synthetic', domain: 'capsules.example.test', remoteRoot: '/srv/sporades$unit%' };
  const units = hostRouteRecoveryUnits(h);
  assert.match(units.timer, /OnBootSec=5s\nOnUnitInactiveSec=5s\nAccuracySec=1s/);
  assert.match(units.service, /Requisite=docker.service caddy.service/);
  assert.doesNotMatch(units.service, /Requires=|Wants=/);
  assert.match(units.service, /--reconcile-host-routes/);
  assert.match(units.service, /KillMode=control-group/);
  assert.match(units.service, /UMask=0077/);
  assert.match(units.service, /sporades\$\$unit%%/);
  assert.deepEqual(hostRouteRecoveryUnits(h), units);
  const helper = await readFile(hostHelperPath, 'utf8');
  assert(helper.includes('--reconcile-host-routes') && helper.includes('capsule.route.reconcile'), 'shipped helper carries timer parity');
});


test('routed settlement uses a real bounded authenticated HTTP probe and keeps failures opaque', async t => {
  for (const scenario of ['ready', 'redirect', 'invalid', 'oversize', 'not-ready']) await t.test(scenario, () => withBackupRouteFixture(async f => {
    let calls = 0;
    await withHttpServer((request, response) => {
      calls++;
      assert.equal(request.url, '/__sporades/health/runtime');
      assert.equal(request.headers['x-sporades-host-probe'], 'a'.repeat(64));
      assert.equal(request.headers['user-agent'], 'Sporades-Host-Route-Probe');
      if (scenario === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); return; }
      if (scenario === 'invalid') { response.end('private-response-content'); return; }
      if (scenario === 'oversize') { response.end('private-response-content'.repeat(5000)); return; }
      response.writeHead(scenario === 'ready' ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: scenario === 'ready', data: { runtime: { ready: scenario === 'ready' }, checks: { sqlite: {ok:true}, fileStorage: {ok:true} } } }));
    }, async port => {
      await writeFile(f.registryRecordPath, JSON.stringify({ ...f.record, hostedUrl: `http://127.0.0.1:${port}` }));
      await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
      const output = await runHostHelper({ ...f.request, action: 'capsule.route.reconcile' }, { cwd: f.dir, env: { ...f.docker.env, FAKE_HOST_ROUTE_PROBE_REAL: '1' } });
      const envelope = JSON.parse(output.stdout);
      assert.equal(envelope.ok, scenario === 'ready', output.stdout);
      if (scenario !== 'ready') assert.equal(envelope.error.code, 'HOSTED_ROUTE_UNVERIFIED');
      assert(!output.stdout.includes('private-response-content') && !output.stdout.includes('a'.repeat(64)));
      assert.equal(calls, 1, 'redirects and failed responses are never retried within a probe');
    });
  }));
});


test('automatic route recovery executes its real readiness probe within the short worker deadline', () => withBackupRouteFixture(async f => {
  let requests = 0;
  await withHttpServer((request, response) => {
    requests++;
    assert.equal(request.url, '/__sporades/health/runtime');
    assert.equal(request.headers['x-sporades-host-probe'], 'a'.repeat(64));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data: { runtime: { ready: true },
      checks: { sqlite: { ok: true }, fileStorage: { ok: true } } } }));
  }, async port => {
    await writeFile(f.state, JSON.stringify({ running: true, port: '127.0.0.1:49154' }));
    const output = await runRouteRecoveryPass(f, { FAKE_DOCKER_RUNTIME_PROBE_PORT: String(port) });
    assert.equal(JSON.parse(output.stdout).ok, true, output.stdout);
    assert(requests > 0, 'the emitted Docker-exec script must reach the ready runtime');
    assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
    assert(!(await f.docker.calls()).some(c => ['start', 'stop', 'rm', 'run'].includes(c.args[0])));
  });
}));


test('boot backup recovery retains exact-instance evidence through settlement and respects other journals', async t => {
  for (const restore of [false, true]) await t.test(restore ? 'pending restore' : 'interrupted backup', () => withBackupRouteFixture(async f => {
    const container = JSON.parse(f.docker.env.FAKE_DOCKER_INSPECT_JSON);
    container.State = { Running: false, Status: 'exited', ExitCode: 0 }; container.RestartCount = 0;
    await writeFile(f.state, JSON.stringify({ running: false, port: '' }));
    await writeFile(f.journal, JSON.stringify({ id: container.Id, releaseId: f.record.currentRelease.id }), { mode: 0o600 });
    if (restore) await writeFile(path.join(f.capsuleDir, '.backup-restore.json'), 'pending');
    const before = await readFile(f.routeFile);
    const result = await runHostHelper({ ...f.request, action: 'capsule.resume' }, { cwd: f.dir, env: { ...f.docker.env, FAKE_DOCKER_INSPECT_JSON: JSON.stringify(container) } });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.resumed, !restore, result.stdout);
    if (restore) {
      assert.deepEqual(await readFile(f.routeFile), before);
      assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).id, container.Id);
    } else {
      assert.match(await readFile(f.routeFile, 'utf8'), /reverse_proxy 127\.0\.0\.1:49154/);
      await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
    }
    assert.equal((await f.docker.calls()).filter(c => c.args[0] === 'start').length, restore ? 0 : 1);
    assert(!(await f.docker.calls()).some(c => ['run','rm','stop'].includes(c.args[0])));
  }));
});
