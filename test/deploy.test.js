import { waitForHttp } from "./support/http-readiness.js";
import { preservedDeployFilePath } from "../dist/deploy-files.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import NodeWebSocket from "ws";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";
import { CLIENT_CAPABILITIES } from "../dist/client-capabilities.js";
import { installPrerenderWarnings, assertPrerenderWarnings } from "./support/prerender-warnings.js";
// Independent deploy cases share fixture helpers across desk workers.
import {
repoRoot,
BASE_IMAGE_RUNTIME_USER,
TEST_PUBLIC_KEY,
withTempDir,
relativeFiles,
readOptional,
deployOwnedContainer,
runCli,
installFakeDocker,
readProjectAuditEvents,
expectedLocalContainerRuntimeUser,
firstDockerRunCall,
capsuleServiceCredentialsPath,
readCapsuleServiceCredentials,
assertVolume,
updateSporadesConfig,
declareClamavFileIngress,
openSshPublicKeyLine,
installFakeReact,
installFakePreact,
installVue,
withFakeCapsuleService,
getAvailablePort,
stopChild,
openSocket,
readSocketMessage,
waitForSocketMessage
} from "./support/deploy-fixture.js";


test('Container --port overrides use one public origin for launch, links, binding and doctor', async t => {
  for (const item of [
    { name: 'effective port fallback', expected: 'http://localhost:5690' },
    { name: 'explicit environment', envOrigin: 'https://env.example', expected: 'https://env.example' },
    { name: 'explicit config wins', envOrigin: 'https://env.example', configOrigin: 'https://configured.example', expected: 'https://configured.example' },
  ]) await t.test(item.name, async () => {
    await withTempDir(async dir => {
      const created = await runCli(['create', 'origin-port', '--template', 'blank', '--no-install', '--no-git', '--json'], { cwd: dir });
      assert.equal(created.code, 0, created.stderr);
      const projectDir = await realpath(path.join(dir, 'origin-port'));
      await installFakeReact(projectDir);
      const configPath = path.join(projectDir, 'sporades.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.deploy = { ...config.deploy, port: 5689, ...(item.configOrigin ? { publicOrigin: item.configOrigin } : {}) };
      config.auth = { providers: { anonymous: true, email: true } };
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(path.join(projectDir, 'server/index.ts'), `import {capsule,endpoint} from 'sporades/server';
export default capsule({name:'origin-port',endpoints:{links:endpoint({method:'POST',path:'/links'},async ctx=>{
  if(!ctx.auth.email) return {status:403};
  const reset=await ctx.serverAuth.createEmailPasswordResetLink(ctx.auth.email);
  const {teams}=await ctx.teams.list();
  const join=await ctx.teams.createJoinLink(teams[0].id,'recipient@example.com');
  return {status:200,body:{origin:ctx.app.publicOrigin,reset:reset.link,join:join.link}};
})}});`);
      const docker = await installFakeDocker(dir, 'origin-container');
      const env = { ...docker.env, SPORADES_PUBLIC_ORIGIN: item.envOrigin ?? '' };
      const deployed = await runCli(['deploy', '--port', '5690', '--json'], { cwd: projectDir, env });
      assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
      const run = firstDockerRunCall(await docker.calls());
      assert(run.args.includes('5690:4000'));
      assert(run.args.includes(`SPORADES_PUBLIC_ORIGIN=${item.expected}`));
      assert(run.args.includes(`SPORADES_CONTAINER_PUBLIC_ORIGIN=${item.expected}`));
      const binding = JSON.parse(await readFile(path.join(projectDir, '.sporades/binding.json'), 'utf8'));
      assert.equal(binding.publicOrigin, item.expected);
      // Doctor must report the deployed snapshot even after config/env changes.
      config.deploy.publicOrigin = 'https://changed.example';
      await writeFile(configPath, JSON.stringify(config));
      const doctor = await runCli(['doctor', '--session', 'container', '--json'], { cwd: projectDir, env });
      const checks = JSON.parse(doctor.stdout).data.checks;
      assert.equal(checks.find(c => c.id === 'doctor.public-origin').details.publicOrigin, item.expected);
      const launchEnv = Object.fromEntries(run.args.filter(arg => /^SPORADES_(?:CONTAINER_PUBLIC_ORIGIN|PUBLIC_ORIGIN|SECURITY_SESSION)=/.test(arg)).map(arg => {
        const index = arg.indexOf('='); return [arg.slice(0, index), arg.slice(index + 1)];
      }));
      const port = await getAvailablePort();
      const child = spawn(process.execPath, [path.join(projectDir, '.sporades/build/server.mjs')], {
        cwd: projectDir, env: { ...process.env, ...launchEnv, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, '.sporades/data.db') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`, null, item.expected);
        socket.send(JSON.stringify({ id: 'signup', type: 'auth.signUp', provider: 'email', credentials: { email: 'owner@example.com', password: 'password-123' } }));
        const signup = await readSocketMessage(socket);
        assert.equal(signup.error, null, JSON.stringify(signup));
        const response = await fetch(`http://127.0.0.1:${port}/links`, { method: 'POST', headers: { 'x-sporades-session-token': signup.data.sessionToken } });
        assert.equal(response.status, 200, await response.clone().text());
        const links = await response.json();
        assert.equal(links.origin, item.expected);
        assert.equal(new URL(links.reset).origin, item.expected);
        assert.equal(new URL(links.join).origin, item.expected);
      } finally { socket?.close(); await stopChild(child); }
    });
  });
});


test("Container prerender warnings reach human and structured successful CLI output", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "warning-capsule", "--framework", "react", "--toolchain", "vite", "--no-install", "--no-git", "--json"], {cwd:dir});
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "warning-capsule"));
    await installFakeReact(projectDir);
    await installPrerenderWarnings(projectDir);
    for (const json of [true, false]) {
      const docker = await installFakeDocker(path.join(dir, `docker-${json}`), `warning-container-${json}`);
      assertPrerenderWarnings(await runCli(["deploy", ...(json ? ["--json"] : [])], {cwd:projectDir, env:docker.env}), json);
    }
  });
});


test("Container telemetry uses an explicit profile, host routing and credential reference across redeploy and restart", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "trace-capsule", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "trace-capsule"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "trace-container");
    const configDir = path.join(dir, "operator-config");
    await mkdir(configDir);
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      local: { endpoint: "http://127.0.0.1:4318", tls: { mode: "loopback" }, credentialEnv: "TRACE_INGEST_TOKEN" },
    } }));
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SPORADES_CONTAINER_TELEMETRY_CONFIG=null\nSPORADES_SECURITY_SESSION=hosted\n");
    const env = { ...docker.env, SPORADES_CONFIG_DIR: configDir, TRACE_INGEST_TOKEN: "private-container-token" };
    const reservedEnv = await runCli(["deploy", "--telemetry", "local", "--json"], { cwd: projectDir, env });
    assert.notEqual(reservedEnv.code, 0);
    assert.match(reservedEnv.stdout + reservedEnv.stderr, /Remove reserved SPORADES_ keys/);
    await rm(path.join(projectDir, ".env.sporades.server"));
    const disabled = await runCli(["deploy", "--json"], { cwd: projectDir, env });
    assert.equal(disabled.code, 0, disabled.stdout + disabled.stderr);
    assert(!firstDockerRunCall(await docker.calls()).args.includes("--add-host"));
    assert.doesNotMatch(await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8"), /private-container-token/);

    const enabled = await runCli(["deploy", "--telemetry", "local", "--json"], { cwd: projectDir, env });
    assert.equal(enabled.code, 0, enabled.stderr);
    const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert(run.args.includes("host.docker.internal:host-gateway"));
    assert(run.args.includes("TRACE_INGEST_TOKEN"));
    assert(run.args.includes("SPORADES_SECURITY_SESSION=container"));
    assert(!run.args.some((arg) => arg.includes("private-container-token")));
    const bundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(bundle, /host\.docker\.internal:4318/, "shared Dev bundle cannot own Container destination");
    assert(run.args.some((arg) => arg.startsWith("SPORADES_CONTAINER_TELEMETRY_CONFIG=") && arg.includes("host.docker.internal:4318")), "Container launch carries its own descriptor");
    assert.doesNotMatch(bundle, /private-container-token/);
    assert.doesNotMatch(enabled.stdout + enabled.stderr, /private-container-token/);
    assert.equal((await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env })).code, 0);
    assert.equal((await runCli(["deploy", "restart", "--json"], { cwd: projectDir, env })).code, 0);
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env })).code, 0);
    assert((await docker.calls()).filter((call) => call.args[0] === "run").at(-1).args.includes("--add-host"));
    const disabledAgain = await runCli(["deploy", "--no-telemetry", "--json"], { cwd: projectDir, env });
    assert.equal(disabledAgain.code, 0, disabledAgain.stderr);
    const latestRun = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert(!latestRun.args.includes("--add-host"));
    assert(!latestRun.args.includes("TRACE_INGEST_TOKEN"));
    assert.doesNotMatch(await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8"), /host\.docker\.internal:4318/);
  });
});


test("reconcile retires the previous CA after a Container binding commits before cleanup", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "ca-committed", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ca-committed"));
    await installFakeReact(projectDir);
    const configDir = path.join(dir, "operator-config");
    const caPath = path.join(dir, "operator-ca.pem");
    await mkdir(configDir);
    const certificate = await readFile(path.join(repoRoot, "test", "fixtures", "smtp-test-cert.pem"));
    await writeFile(caPath, certificate, { mode: 0o600 });
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: "https://monitor.example:4318", tls: { mode: "verified", caFile: caPath } },
    } }));
    const firstDocker = await installFakeDocker(path.join(dir, "first"), "ca-first-container");
    const env = { ...firstDocker.env, SPORADES_CONFIG_DIR: configDir };
    assert.equal((await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env })).code, 0);
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const previousCa = JSON.parse(await readFile(bindingPath, "utf8")).telemetryCaStagePath;
    const nextDocker = await installFakeDocker(path.join(dir, "next"), "ca-next-container");
    const preload = path.join(dir, "exit-after-binding.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async function(source, target) {
  const result = await rename.call(this, source, target);
  if (String(target).endsWith('/.sporades/binding.json')) process.exit(18);
  return result;
}; syncBuiltinESMExports();`);
    const nextEnv = { ...nextDocker.env, SPORADES_CONFIG_DIR: configDir };
    const interrupted = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...nextEnv, NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(interrupted.code, 18, interrupted.stdout + interrupted.stderr);
    const committed = JSON.parse(await readFile(bindingPath, "utf8"));
    assert.notEqual(committed.telemetryCaStagePath, previousCa);
    assert.deepEqual(await readFile(previousCa), certificate);
    const reconciled = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env: nextEnv });
    assert.equal(reconciled.code, 0, reconciled.stdout + reconciled.stderr);
    const outcome = JSON.parse(reconciled.stdout).data;
    assert.equal(outcome.committed, true);
    assert(outcome.actions.includes("previous-telemetry-ca-removed"));
    await assert.rejects(readFile(previousCa), { code: "ENOENT" });
    assert.deepEqual(await readFile(committed.telemetryCaStagePath), certificate);
    assert.equal((await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: nextEnv })).code, 0);
    await assert.rejects(readFile(committed.telemetryCaStagePath), { code: "ENOENT" });
    assert.deepEqual(await readFile(caPath), certificate);
  });
});


test("sporades deploy --json bundles and starts a container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, "uploads"), 0o755);
    await chmod(path.join(dataDir, "data.db"), 0o644);
    await chmod(path.join(dataDir, "uploads", "file.bin"), 0o644);
    const initialDataDir = await stat(dataDir);
    const initialDatabase = await stat(path.join(dataDir, "data.db"));
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: true,
      data: {
        url: "http://localhost:4321",
        port: 4321,
        containerId: "container-first",
        restartPolicy: {
          mode: "bounded",
          maxAttempts: 3,
          backoffMs: 1000,
          dockerRestart: "on-failure:3",
          restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
          exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
        },
      },
      error: null,
    });

    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(serverBundle, /todo-island/);
    assert.match(clientBundle, /Sporades Todos/);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.containerId, "container-first");
    assert.equal(binding.containerName, "sporades-todo-island");
    assert.equal(binding.clientRelease.framework, "react");
    assert.equal(binding.clientRelease.toolchain, "esbuild");
    assert.equal(binding.clientRelease.htmlEntry, "index.html");
    assert.equal(binding.clientRelease.fileCount, 3);
    assert.deepEqual(binding.clientRelease.paths, ["client.js", "client.js.map", "index.html"]);
    assert.equal(binding.clientRelease.truncated, false);

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.cwd, projectDir);
    assert.equal(runCall.args[0], "run");
    assert(runCall.args.includes("--detach"));
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-todo-island");
    assert.equal(runCall.args[runCall.args.indexOf("--restart") + 1], "on-failure:3");
    assert(runCall.args.includes("--read-only"));
    assert.equal(runCall.args[runCall.args.indexOf("--tmpfs") + 1], "/tmp:rw,nosuid,nodev,noexec");
    assert.equal(runCall.args[runCall.args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(runCall.args[runCall.args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "4321:4000");
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", "server.mjs")}:/app/server.mjs:ro`);
    const activeTree = JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree;
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", ".public-trees", activeTree)}:/app/public:ro`);
    assert.equal(runCall.args.some((arg) => arg.endsWith(":/app/client.js:ro") || arg.endsWith(":/app/index.html:ro")), false);
    assertVolume(runCall.args, `${path.join(projectDir, "sporades.json")}:/app/sporades.json:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`);
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(projectDir, ".env.sporades.server"));
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], expectedLocalContainerRuntimeUser());
    assert(runCall.args.includes("com.sporades.base-image.name=sporades-base"));
    assert(runCall.args.includes("com.sporades.base-image.version=0.3.0-node24-alpine"));
    assert(runCall.args.includes("com.sporades.base-image.update-policy=host-managed"));
    assert(runCall.args.includes("SPORADES_LOG_STDOUT=1"));
    const runtimeProbeEnv = runCall.args.find((arg) => arg.startsWith("SPORADES_RUNTIME_PROBE_TOKEN="));
    assert.match(runtimeProbeEnv ?? "", /^SPORADES_RUNTIME_PROBE_TOKEN=[a-f0-9]{64}$/);
    assert.doesNotMatch(deployResult.stdout + deployResult.stderr, /SPORADES_RUNTIME_PROBE_TOKEN=/);
    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.3.0-node24-alpine");
    assert(imageIndex > -1);
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      "node",
      "/app/server.mjs",
    ]);
    const preparedDataDir = await stat(dataDir);
    const preparedUploadsDir = await stat(path.join(dataDir, "uploads"));
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    const preparedUpload = await stat(path.join(dataDir, "uploads", "file.bin"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedUploadsDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedUpload.mode & 0o777, 0o600);
    assert.equal(preparedDataDir.uid, initialDataDir.uid);
    assert.equal(preparedDataDir.gid, initialDataDir.gid);
    assert.equal(preparedDatabase.uid, initialDatabase.uid);
    assert.equal(preparedDatabase.gid, initialDatabase.gid);

    const statusResult = await runCli(["deploy", "status", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    const statusData = JSON.parse(statusResult.stdout).data;
    assert.equal(statusData.container.containerId, "container-first");
    assert.deepEqual(statusData.container.clientRelease, binding.clientRelease);
  });
});


test("sporades deploy assembles a Vanilla TypeScript release without leaking Server env", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "vanilla-release", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "vanilla-release"));
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=vanilla-server-only\n");
    const docker = await installFakeDocker(dir, "vanilla-container");
    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, "vanilla");
    assert.equal(binding.clientRelease.toolchain, "esbuild");
    assert.deepEqual(binding.clientRelease.paths, ["client.js", "client.js.map", "index.html"]);
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(clientBundle, /Vanilla Sporades/);
    assert.doesNotMatch(clientBundle, /vanilla-server-only|SECRET_TOKEN/);
  });
});


for (const capability of CLIENT_CAPABILITIES) test(`matrix Container packaging validates ${capability.framework}/${capability.toolchain}`, async () => {
  await withTempDir(async (dir) => {
    const name = `matrix-${capability.framework}-${capability.toolchain}`;
    const created = await runCli(["create", name, "--template", "blank", "--framework", capability.framework, "--toolchain", capability.toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, name));
    await (capability.framework === "vanilla" ? async () => {}
      : capability.framework === "react" ? installFakeReact
      : capability.framework === "preact" ? installFakePreact
      : capability.framework === "inferno" ? (project) => installProjectInfernoToolchain(project, repoRoot)
      : capability.framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot)
      : capability.framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot)
      : capability.framework === "vue" ? installVue
      : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SERVER_ONLY_MATRIX=container-secret\n");
    const docker = await installFakeDocker(dir, name);
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, capability.framework);
    assert.equal(binding.clientRelease.toolchain, capability.toolchain);
    assert(binding.clientRelease.paths.includes("index.html"));
    assert(binding.clientRelease.paths.some((file) => file.endsWith(".js")));
    assert(binding.clientRelease.paths.every((file) => !file.includes("..") && !file.includes("\\")));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.filter((file) => /\.(?:html|js|css|map|svg)$/.test(file)).map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    assert.doesNotMatch(output, /SERVER_ONLY_MATRIX|container-secret|\/@vite\/client|react-refresh/);
    assertVolume(firstDockerRunCall(await docker.calls()).args, `${publicRoot}:/app/public:ro`);
  });
});


for (const toolchain of ["esbuild", "vite"]) for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades deploy mounts native Inferno/${toolchain} ${template} output without Server env`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `inferno-${template}-release`, "--template", template, "--framework", "inferno", "--toolchain", toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, `inferno-${template}-release`));
    await installProjectInfernoToolchain(projectDir, repoRoot);
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}INFERNO_SERVER_ONLY=inferno-container-secret\n`);
    const docker = await installFakeDocker(dir, `inferno-${template}-container`);
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env }); assert.equal(deployed.code, 0, deployed.stderr);
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, "inferno"); assert.equal(binding.clientRelease.toolchain, toolchain);
    assert(binding.clientRelease.paths.includes(toolchain === "esbuild" ? "client.js" : "index.html")); assert(binding.clientRelease.paths.some((file) => file.endsWith(".js.map"))); assert(binding.clientRelease.paths.some((file) => file.endsWith(".css")));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
    assert.doesNotMatch(output, /inferno-container-secret|INFERNO_SERVER_ONLY|react-dom|react\/jsx-runtime|node_modules\/react/);
    const runCall = firstDockerRunCall(await docker.calls()); assertVolume(runCall.args, `${publicRoot}:/app/public:ro`);
  });
});


test("sporades deploy does not require changing local runtime data ownership", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root does not exercise the normal local non-root container user");
  }

  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    const initialDataDir = await stat(dataDir);
    const initialDatabase = await stat(path.join(dataDir, "data.db"));
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-first");

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], expectedLocalContainerRuntimeUser());

    const preparedDataDir = await stat(dataDir);
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedDataDir.uid, initialDataDir.uid);
    assert.equal(preparedDataDir.gid, initialDataDir.gid);
    assert.equal(preparedDatabase.uid, initialDatabase.uid);
    assert.equal(preparedDatabase.gid, initialDatabase.gid);
  });
});


test("ClamAV Container readiness failures roll back the candidate and preserve the working binding", async (t) => {
  for (const scenario of ["authentication", "timeout"]) {
    await t.test(scenario, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `clamav-${scenario}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `clamav-${scenario}-island`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-old-${scenario}`);
        assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
        const bindingPath = path.join(projectDir, ".sporades", "binding.json");
        const beforeBinding = await readFile(bindingPath, "utf8");
        await declareClamavFileIngress(projectDir);
        const replacementDocker = await installFakeDocker(path.join(dir, "replacement"), `container-new-${scenario}`);
        const server = createHttpServer((_request, response) => {
          if (scenario === "authentication") {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, data: null, error: { message: "denied" } }));
            return;
          }
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: false } } }, error: null }));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const address = server.address();
          await updateSporadesConfig(projectDir, (config) => { config.deploy = { ...(config.deploy ?? {}), port: address.port }; });
          const replacement = await runCli(["deploy", "--json"], {
            cwd: projectDir,
            env: { ...replacementDocker.env, SPORADES_TEST_CONTAINER_READINESS_TIMEOUT_MS: "80" },
          });
          assert.equal(replacement.code, 1, replacement.stdout);
          assert.match(replacement.stdout, /Container candidate runtime readiness failed/);
          assert.equal(await readFile(bindingPath, "utf8"), beforeBinding);
          const calls = await replacementDocker.calls();
          assert.ok(calls.some((call) => call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === `container-new-${scenario}`));
          assert.ok(calls.some((call) => call.args[0] === "rename" && call.args[1]?.includes("rollback") && call.args[2] === `sporades-clamav-${scenario}-island`));
          assert.ok(calls.some((call) => call.args[0] === "start" && call.args[1] === `sporades-clamav-${scenario}-island`));
        } finally {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      });
    });
  }
});


test("Container deployment without ClamAV keeps the readiness-probe fast path", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "no-clamav-ready-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "no-clamav-ready-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-no-clamav");
    const deployed = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: { ...docker.env, SPORADES_TEST_CONTAINER_READINESS_TIMEOUT_MS: "1" },
    });
    assert.equal(deployed.code, 0, deployed.stderr);
  });
});


test("Container replacement restores publication, consumer, binding, and cleanup faults", async (t) => {
  for (const fault of ["publication", "consumer", "binding", "cleanup"]) {
    await t.test(fault, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `rollback-${fault}-state`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `rollback-${fault}-state`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-old-${fault}`);
        assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
        const buildDir = path.join(projectDir, ".sporades", "build");
        const paths = [
          path.join(projectDir, ".sporades", "binding.json"),
          path.join(buildDir, ".public-trees", "active.json"),
          path.join(buildDir, ".public-trees", ".consumers", "container.json"),
          path.join(buildDir, "server.mjs"),
          path.join(buildDir, "client.js"),
        ];
        const before = await Promise.all(paths.map((file) => readFile(file, "utf8")));
        const entry = path.join(projectDir, "client", "index.tsx");
        await writeFile(entry, `${await readFile(entry, "utf8")}\nconsole.log('fault-${fault}');\n`);
        const docker = await installFakeDocker(path.join(dir, "failure"), `container-new-${fault}`);
        const failed = await runCli(["deploy", "--json"], {
          cwd: projectDir,
          env: { ...docker.env, SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT: fault },
        });
        assert.equal(failed.code, 1, failed.stdout);
        assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, "utf8"))), before);
        const calls = await docker.calls();
        assert.ok(calls.some((call) => call.args[0] === "rename" && call.args.at(-1) === `sporades-rollback-${fault}-state`));
        assert.ok(calls.some((call) => call.args[0] === "start" && call.args[1] === `sporades-rollback-${fault}-state`));
      });
    });
  }
});


test("Container replacement fails closed before mutation when binding and consumer ownership disagree", async (t) => {
  const cases = [
    "stale-binding-successor-consumer",
    "tokenless-binding-successor-consumer",
    "missing-binding-existing-consumer",
    "binding-token-missing-consumer",
    "malformed-consumer",
    "consumer-identity-mismatch",
    "public-tree-mismatch",
    "container-name-mismatch",
  ];
  for (const mode of cases) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `ownership-${mode}`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `ownership-${mode}`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-${mode}`);
        const initial = await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env });
        assert.equal(initial.code, 0, initial.stderr);

        const buildDir = path.join(projectDir, ".sporades", "build");
        const bindingPath = path.join(projectDir, ".sporades", "binding.json");
        const consumerPath = path.join(buildDir, ".public-trees", ".consumers", "container.json");
        const binding = JSON.parse(await readFile(bindingPath, "utf8"));
        const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
        if (mode === "stale-binding-successor-consumer") {
          consumer.token = "a".repeat(32);
          consumer.identity = "successor-container";
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "tokenless-binding-successor-consumer") {
          delete binding.clientRelease.consumerToken;
          consumer.token = "b".repeat(32);
          consumer.identity = "successor-container";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "missing-binding-existing-consumer") {
          await rm(bindingPath);
        } else if (mode === "binding-token-missing-consumer") {
          await rm(consumerPath);
        } else if (mode === "malformed-consumer") {
          await writeFile(consumerPath, "{not-json\n");
        } else if (mode === "consumer-identity-mismatch") {
          consumer.identity = "different-container";
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "public-tree-mismatch") {
          binding.clientRelease.publicTree = "different-public-tree";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        } else if (mode === "container-name-mismatch") {
          binding.containerName = "sporades-different-capsule";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        }

        const observedPaths = {
          binding: bindingPath,
          consumer: consumerPath,
          active: path.join(buildDir, ".public-trees", "active.json"),
          server: path.join(buildDir, "server.mjs"),
          client: path.join(buildDir, "client.js"),
        };
        const before = Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)])));
        const beforeFiles = await relativeFiles(buildDir);
        const docker = await installFakeDocker(path.join(dir, "replacement"), `candidate-${mode}`);

        const replacement = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });

        assert.equal(replacement.code, 1, `${mode}: ${replacement.stderr}\n${replacement.stdout}`);
        assert.deepEqual(await docker.calls(), [], `${mode} reached Docker`);
        assert.deepEqual(
          Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)]))),
          before,
          `${mode} mutated committed state`,
        );
        assert.deepEqual(await relativeFiles(buildDir), beforeFiles, `${mode} mutated public-tree/build publication state`);
      });
    });
  }
});


test("ambiguous docker run failure never removes an unrelated canonical-name container", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "name-conflict-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "name-conflict-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "unrelated-container", { failOnceActions: ["run"] });
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).error.message, "Failed to start the container session.");
    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
    assert.equal(calls.some((call) => call.args[0] === "inspect" && call.args.at(-1) === "unrelated-container"), false);
    await assert.rejects(stat(path.join(projectDir, ".sporades", "binding.json")), (error) => error.code === "ENOENT");
  });
});


test("unsafe Container public output fails validation before replacing the running session", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "unsafe-public-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "unsafe-public-island"));
    await installFakeReact(projectDir);
    const binding = await deployOwnedContainer(projectDir, dir);
    const treesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
    const activeClientPath = path.join(treesDir, binding.clientRelease.publicTree, "client.js");
    const activeClient = await readFile(activeClientPath);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const outside = path.join(projectDir, "outside-client.js");
    await writeFile(outside, "unsafe replacement");

    await withFakeCapsuleService(async ({ port }) => {
      const existingTrees = await readdir(treesDir);
      const hookPath = path.join(dir, "corrupt-public-tree.cjs");
      const evidencePath = path.join(dir, "corrupted-public-tree.json");
      // Services start after the Bundle pipeline stages its candidate, and before
      // public-tree validation. Inject here in fake Docker so neither child
      // startup speed nor a polling/sleep window controls when corruption occurs.
      await writeFile(hookPath, `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const treesDir = ${JSON.stringify(treesDir)};
const excluded = new Set(${JSON.stringify(existingTrees)});
if (!fs.existsSync(${JSON.stringify(evidencePath)})) {
const candidates = fs.readdirSync(treesDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !excluded.has(entry.name));
assert.equal(candidates.length, 1, "exactly one staged public-tree candidate must exist before service readiness");
const candidate = path.join(treesDir, candidates[0].name);
fs.unlinkSync(path.join(candidate, "client.js"));
fs.symlinkSync(${JSON.stringify(outside)}, path.join(candidate, "client.js"));
fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ candidate }));
}
`);
      const docker = await installFakeDocker(dir, "container-never-started", { composePortOutput: `127.0.0.1:${port}`, composePsHook: hookPath });
      const result = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      const { candidate } = JSON.parse(await readFile(evidencePath, "utf8"));
      assert.equal(existingTrees.includes(path.basename(candidate)), false, "only the new candidate was corrupted");
      assert.equal(result.code, 1);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.error.message, "Container public tree validation failed.");
      assert.match(envelope.error.hint, /symbolic link|regular file/i);
      assert.deepEqual(envelope.error.diagnostics, {
        phase: "public",
        framework: "react",
        toolchain: "esbuild",
        cause: "Invalid public tree.",
      });
      const calls = await docker.calls();
      assert.equal(calls.some((call) => call.args[0] === "stop" || call.args[0] === "rm" || call.args[0] === "run"), false);
      assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-old");
      assert.deepEqual(await readFile(activeClientPath), activeClient, "the last successful public tree is retained");
      await assert.rejects(stat(candidate), { code: "ENOENT" }, "the unsafe candidate is discarded");
    });
  });
});


test("missing and over-limit Container public inputs fail before replacement with guidance", async (t) => {
  for (const scenario of ["missing", "over-limit"]) {
    await t.test(scenario, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `invalid-${scenario}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `invalid-${scenario}-island`));
        await installFakeReact(projectDir);
        await deployOwnedContainer(projectDir, dir);
        if (scenario === "missing") await rm(path.join(projectDir, "index.html"));
        else await writeFile(path.join(projectDir, "index.html"), Buffer.alloc(16 * 1024 * 1024 + 1, 1));
        const docker = await installFakeDocker(dir, "container-never-started");
        const result = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
        assert.equal(result.code, 1);
        const envelope = JSON.parse(result.stdout);
        if (scenario === "missing") {
          assert.equal(envelope.error.message, "Missing HTML shell: index.html");
          assert.match(envelope.error.hint, /Restore index\.html/);
        } else {
          assert.equal(envelope.error.message, "Invalid public tree.");
          assert.match(envelope.error.hint, /index\.html exceeds the per-file public output limit/);
        }
        const calls = await docker.calls();
        assert.equal(calls.some((call) => call.args[0] === "stop" || call.args[0] === "rm" || call.args[0] === "run"), false);
        assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-old");
      });
    });
  }
});


test("sporades deploy rejects malformed SSH key blobs before replacing the existing Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bad-blob-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "bad-blob-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-existing");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: "ssh-ed25519 @@@" },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-new");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const body = JSON.parse(deployResult.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /Malformed SSH authorized key material/);
    assert.match(body.error.hint, /authorized_keys-compatible public key/);
    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});


test("sporades deploy ssh --json reports effective local Container SSH state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "inspect-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "inspect-ssh-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh", {
      inspectJson: JSON.stringify({
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
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const sshResult = await runCli(["deploy", "ssh", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(sshResult.code, 0, sshResult.stderr);
    const body = JSON.parse(sshResult.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.running, true);
    assert.equal(body.data.user, "sporades");
    assert.equal(body.data.runtimeUser, "10001:10001");
    assert.equal(body.data.host, "127.0.0.1");
    assert.equal(body.data.port, 49162);
    assert.equal(body.data.targetPort, 22);
    assert.equal(body.data.keyCount, 1);
    assert.equal(body.data.fingerprints.length, 1);
    assert.match(body.data.fingerprints[0], /^SHA256:/);
    assert.equal(body.data.reason, null);
  });
});


test("sporades deploy accepts authorized_keys file entries and treats empty effective SSH keys as disabled", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "file-ssh-island"));
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, "ops.keys"), `# ops\n\n${TEST_PUBLIC_KEY}\n`);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { file: "ops.keys" },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-file-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(
      await readFile(path.join(projectDir, ".sporades", "ssh", "authorized_keys"), "utf8"),
      `${TEST_PUBLIC_KEY}\n`,
    );

    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [],
      };
    });
    const disabledDocker = await installFakeDocker(dir, "container-disabled-ssh");
    const disabledResult = await runCli(["deploy", "--force", "--json"], {
      cwd: projectDir,
      env: disabledDocker.env,
    });
    assert.equal(disabledResult.code, 0, disabledResult.stderr);
    const runCall = (await disabledDocker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert.equal(runCall.args.includes("127.0.0.1::22"), false);
    assert.equal(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"), false);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.slice(-2).map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.metadata.enabled, entry.data.metadata.reason]),
      [
        ["ssh.config.validated", "ssh.config.validate", "completed", false, "no-authorized-keys"],
        ["ssh.access.disabled", "ssh.container.disabled", "completed", false, "no-authorized-keys"],
      ],
    );
  });
});


test("sporades deploy accepts OpenSSH security-key public key material", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "sk-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "sk-ssh-island"));
    await installFakeReact(projectDir);
    const skPublicKey = openSshPublicKeyLine("sk-ssh-ed25519@openssh.com", [
      Buffer.alloc(32, 7),
      "ssh:",
    ]);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: skPublicKey },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-sk-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(
      await readFile(path.join(projectDir, ".sporades", "ssh", "authorized_keys"), "utf8"),
      `${skPublicKey}\n`,
    );
    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], BASE_IMAGE_RUNTIME_USER);
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
  });
});


test("sporades deploy audits SSH validation, enabled lifecycle, and inspection without leaking key material", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "ssh-audit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "ssh-audit-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh-audit");

    const deploy = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.equal(JSON.parse(deploy.stdout).data.ssh, undefined);
    assert.doesNotMatch(deploy.stdout, /ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|SHA256:/);

    const inspection = await runCli(["deploy", "ssh", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(inspection.code, 0, inspection.stderr);

    const logs = await runCli(["logs", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(logs.code, 0, logs.stderr);
    const auditEvents = JSON.parse(logs.stdout).data.entries.filter((entry) => entry.category === "audit");
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [
        ["ssh.config.validated", "ssh.config.validate", "completed"],
        ["ssh.access.enabled", "ssh.container.start", "completed"],
        ["ssh.state.inspected", "ssh.container.inspect", "completed"],
      ],
    );
    const [validation, lifecycle, inspected] = auditEvents;
    assert.equal(validation.data.actorKind, "platform");
    assert.equal(validation.data.surface, "sporades/deploy");
    assert.equal(validation.data.targetResourceKind, "container-ssh-config");
    assert.equal(validation.data.metadata.enabled, true);
    assert.equal(validation.data.metadata.keyCount, 1);
    assert.deepEqual(validation.data.metadata.fingerprints, lifecycle.data.metadata.fingerprints);
    assert.equal(lifecycle.data.metadata.loopbackOnly, true);
    assert.equal(lifecycle.data.metadata.targetPort, 22);
    assert.equal(inspected.data.metadata.running, true);
    assert.equal(inspected.data.metadata.port, 49162);
    assert.equal(inspected.data.metadata.host, "127.0.0.1");
    assert.doesNotMatch(JSON.stringify(auditEvents), /ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|OPENSSH PRIVATE KEY|authorized_keys/);
  });
});


test("Sporades Base image includes dormant OpenSSH, Fail2ban, and Unix-only ClamAV capability", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile.base"), "utf8");
  assert.match(dockerfile, /apk add --no-cache openssh-server/);
  assert.match(dockerfile, /apk add --no-cache openssh-server fail2ban/);
  assert.match(dockerfile, /clamav clamav-daemon/);
  assert.match(dockerfile, /LocalSocket \/tmp\/sporades-clamd\.sock/);
  assert.doesNotMatch(dockerfile, /^User\s+/m);
  assert.doesNotMatch(dockerfile, /DatabaseOwner/);
  assert.doesNotMatch(dockerfile, /TCPSocket|TCPAddr/);
  assert.match(dockerfile, /StreamMaxLength 10M/);
  assert.equal((dockerfile.match(/NotifyClamd \/etc\/clamav\/clamd\.conf/g) ?? []).length, 1);
  assert.match(dockerfile, /\/usr\/local\/bin\/sporades-start/);
  assert.match(dockerfile, /PasswordAuthentication=no/);
  assert.match(dockerfile, /PermitRootLogin=no/);
  assert.match(dockerfile, /AllowUsers=sporades/);
  assert.match(dockerfile, /AuthorizedKeysFile="\$target"/);
  assert.match(dockerfile, /HostKey="\$ssh_dir\/ssh_host_ed25519_key"/);
  assert.match(dockerfile, /PidFile=\/tmp\/sporades-sshd\.pid/);
  assert.match(dockerfile, /adduser -u 10001 -S sporades -G sporades -s \/bin\/sh/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /adduser -u 10001 -S sporades -G sporades\s+\\/);
  assert.doesNotMatch(dockerfile, /fail2ban-(?:client|server)|systemctl enable --now fail2ban|service fail2ban start/);
  assert.doesNotMatch(dockerfile, /sudoers|NOPASSWD|PermitRootLogin=yes|PasswordAuthentication=yes/);
});


test("direct runtime prefers the active built tree over a conventional source public directory", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "active-tree-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "active-tree-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-active-tree");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    // A file authored after publication is still outside the active release.
    await mkdir(path.join(projectDir, "public"));
    await writeFile(path.join(projectDir, "public", "favicon.ico"), "source-only favicon");
    const serverBundle = path.join(projectDir, ".sporades", "build", "server.mjs");
    const start = async () => {
      const port = await getAvailablePort();
      const child = spawn(process.execPath, [serverBundle], {
        cwd: projectDir,
        env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", `active-${port}.db`) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { port, child };
    };

    const active = await start();
    try {
      const root = await waitForHttp(`http://127.0.0.1:${active.port}/`, active.child);
      assert.match(await root.text(), /<div id="app"><\/div>/);
      const client = await waitForHttp(`http://127.0.0.1:${active.port}/client.js`, active.child);
      assert.match(await client.text(), /Sporades Todos/);
      const sourceOnly = await waitForHttp(`http://127.0.0.1:${active.port}/favicon.ico`, active.child, 404);
      assert.equal(await sourceOnly.text(), "Not found");
    } finally {
      await stopChild(active.child);
    }

    const activeReference = path.join(projectDir, ".sporades", "build", ".public-trees", "active.json");
    for (const state of ["malformed", "missing"]) {
      if (state === "malformed") await writeFile(activeReference, "{\"tree\":");
      else await rm(activeReference);
      const fallback = await start();
      try {
        const sourceOnly = await waitForHttp(`http://127.0.0.1:${fallback.port}/favicon.ico`, fallback.child);
        assert.equal(await sourceOnly.text(), "source-only favicon", state);
        const root = await waitForHttp(`http://127.0.0.1:${fallback.port}/`, fallback.child, 404);
        assert.equal(await root.text(), "Not found", state);
      } finally {
        await stopChild(fallback.child);
      }
    }
  });
});


test("Container public-tree runtime serves nested built assets with stable MIME types", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "asset-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "asset-island"));
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, "client", "lazy.ts"), "export const lazyValue = 'nested lazy chunk';\n");
    await writeFile(path.join(projectDir, "client", "styles.css"), "@font-face { font-family: Capsule; src: url('./capsule.woff2'); } body { color: teal; }\n");
    await writeFile(path.join(projectDir, "client", "capsule.woff2"), Buffer.from("fake-font"));
    await writeFile(path.join(projectDir, "client", "capsule.png"), Buffer.from("fake-png"));
    await writeFile(
      path.join(projectDir, "client", "index.tsx"),
      `${await readFile(path.join(projectDir, "client", "index.tsx"), "utf8")}\nimport './styles.css';\nimport logo from './capsule.png';\nconsole.log(logo);\nimport('./lazy').then((value) => console.log(value.lazyValue));\n`,
    );
    await writeFile(
      path.join(projectDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/client.css"></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>\n',
    );
    const docker = await installFakeDocker(dir, "container-assets");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const activeTreeName = JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree;
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", activeTreeName);
    const files = await relativeFiles(publicRoot);
    const nestedJs = files.find((file) => /^assets\/lazy-.*\.js$/.test(file));
    const nestedMap = files.find((file) => /^assets\/lazy-.*\.js\.map$/.test(file));
    const nestedImage = files.find((file) => /^assets\/capsule-.*\.png$/.test(file));
    const nestedFont = files.find((file) => /^assets\/capsule-.*\.woff2$/.test(file));
    for (const expected of ["index.html", "client.js", "client.js.map", "assets/client.css", "assets/client.css.map", nestedJs, nestedMap, nestedImage, nestedFont]) {
      assert.ok(expected && files.includes(expected), `Expected built public asset ${expected}; got ${files.join(", ")}`);
    }

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "asset-data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const expectedTypes = new Map([
        ["/", "text/html; charset=utf-8"],
        ["/client.js", "text/javascript; charset=utf-8"],
        ["/assets/client.css", "text/css; charset=utf-8"],
        [`/${nestedJs}`, "text/javascript; charset=utf-8"],
        [`/${nestedMap}`, "application/json; charset=utf-8"],
        [`/${nestedImage}`, "image/png"],
        [`/${nestedFont}`, "font/woff2"],
      ]);
      for (const [urlPath, contentType] of expectedTypes) {
        const response = await waitForHttp(`http://127.0.0.1:${port}${urlPath}`, child);
        assert.equal(response.status, 200, urlPath);
        assert.equal(response.headers.get("content-type"), contentType, urlPath);
      }
    } finally {
      await stopChild(child);
    }
  });
});


test("container server bundle requires explicit CORS and can enforce CSP", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "secure-container-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "secure-container-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.security.cors.allowedOrigins = ["https://dashboard.example.test"];
    config.security.csp.mode = "enforce";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "secure-container-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => ({
      headers: { "x-powered-by": "custom-stack", server: "custom-server" },
      body: { ok: true },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const securityResult = await runCli(["security", "--session", "hosted", "--json"], { cwd: projectDir });
    assert.equal(securityResult.code, 0, securityResult.stderr);
    const security = JSON.parse(securityResult.stdout).data.security;
    assert.deepEqual(security.cors.allowedOrigins, ["https://dashboard.example.test"]);
    assert.equal(security.csp.header, "content-security-policy");

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const blocked = await fetch(`http://127.0.0.1:${port}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://evil.example.test" },
      });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.headers.get("access-control-allow-origin"), null);
      assert.equal(blocked.headers.get("x-powered-by"), null);
      assert.equal(blocked.headers.get("server"), null);
      assert.match(blocked.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(blocked.headers.get("content-security-policy-report-only"), null);

      const allowed = await fetch(`http://127.0.0.1:${port}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://dashboard.example.test" },
      });
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://dashboard.example.test");
    } finally {
      await stopChild(child);
    }
  });
});


test("sporades deploy writes a server bundle that creates app tables from imported and shared Capsule field definitions", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "composed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "composed-island"));
    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "schema.ts"),
      `import { Boolean, Date, String } from "sporades/server";

const ownershipFields = {
  ownerId: String(),
};

export const todoFields = {
  text: String(),
  done: Boolean().default(false),
  ...ownershipFields,
  dueAt: Date().default("2026-07-03T12:00:00.000Z"),
};
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, table } from "sporades/server";
import { todoFields } from "./schema";

export default capsule({
  name: "composed-island",

  schema: {
    todos: table(todoFields),
  },
});
`,
    );

    const docker = await installFakeDocker(dir, "container-first");
    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);
      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Container composed"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      const rowsAfter = await readSocketMessage(socket);
      assert.equal(rowsAfter.error, null);
      assert.equal(rowsAfter.data[0].text, "Container composed");
      assert.equal(rowsAfter.data[0].done, false);
      assert.equal(typeof rowsAfter.data[0].ownerId, "string");
      assert.equal(rowsAfter.data[0].dueAt, "2026-07-03T12:00:00.000Z");
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});


test("sporades deploy endpoint request bodies are size-limited and unexpected errors are generic", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "hardened-endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "hardened-endpoint-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.http = { maxBodyBytes: 64 };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "hardened-endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 200,
      body: { body: ctx.request.body },
    })),
    explode: endpoint({ method: "POST", path: "/integrations/explode" }, () => {
      const error = new Error("SQLITE_CONSTRAINT at /tmp/secret/server/index.ts:42");
      error.stack = "Error: SQLITE_CONSTRAINT\\n    at secret (/tmp/secret/server/index.ts:42:7)";
      throw error;
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-hardened-endpoint");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const logPath = path.join(projectDir, ".sporades", "logs", "events.jsonl");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      for (const contentType of ["application/json", "text/plain"]) {
        const tooLarge = await fetch(`http://127.0.0.1:${port}/integrations/echo`, {
          method: "POST",
          headers: { "content-type": contentType },
          body: contentType === "application/json"
            ? JSON.stringify({ filler: "x".repeat(128) })
            : "x".repeat(128),
        });
        assert.equal(tooLarge.status, 413);
        assert.deepEqual(await tooLarge.json(), {
          ok: false,
          data: null,
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body is too large.",
            hint: "Send a request body at or below 64 bytes, or raise http.maxBodyBytes in sporades.json.",
          },
        });
      }

      const exploded = await fetch(`http://127.0.0.1:${port}/integrations/explode`, { method: "POST" });
      assert.equal(exploded.status, 500);
      const clientBody = await exploded.text();
      assert.deepEqual(JSON.parse(clientBody), {
        ok: false,
        data: null,
        error: {
          message: "Endpoint handler failed.",
          hint: "Check the endpoint handler and retry the request.",
        },
      });
      assert.equal(clientBody.includes("/tmp/secret"), false);
      assert.equal(clientBody.includes("SQLITE_CONSTRAINT"), false);

      const logs = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const failureLog = logs.find((entry) => entry.event === "http.request.failed" && entry.request?.path === "/integrations/explode");
      assert(failureLog, JSON.stringify(logs));
      assert.equal(failureLog.level, "error");
      assert.equal(failureLog.request.path, "/integrations/explode");
      assert.equal(failureLog.data.message, "SQLITE_CONSTRAINT at /tmp/secret/server/index.ts:42");
      assert.equal(failureLog.data.stack, "[REDACTED]");
    } finally {
      await stopChild(child);
    }
  });
});


test("sporades deploy generates owned Compose for a declared database Capsule service", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-service-compose", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /# Sporades-owned runtime state/);
      assert.match(compose, /name: sporades-todo-island-services/);
      assert.match(compose, /sporades-todo-island-database:/);
      assert.match(compose, /image: ghcr\.io\/tursodatabase\/libsql-server:v0\.24\.32/);
      assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/sqld:rw"/);
      assert.match(compose, /sporades-todo-island-services:/);
      assert.match(compose, /com\.sporades\.managed: "true"/);
      assert.match(compose, /com\.sporades\.capsule-service\.kind: "database"/);

      const calls = await docker.calls();
      const composeUpCall = calls.find((call) => call.args[0] === "compose");
      const runCall = firstDockerRunCall(calls);
      assert.deepEqual(composeUpCall.args, [
        "compose",
        "-p",
        "sporades-todo-island-services",
        "-f",
        path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"),
        "up",
        "--detach",
        "--remove-orphans",
      ]);
      assert(runCall.args.includes("--network"), runCall.args.join(" "));
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(calls.indexOf(composeUpCall) < calls.indexOf(runCall));
    });
  });
});


test("sporades deploy connects the Capsule container to declared services on the Compose network", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-service-network", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=libsql"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_URL=http://sporades-todo-island-database:8080"), runCall.args.join(" "));

      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.sporades\\/services\\/database\:\\/var\\/lib\\/sqld:rw"`));
    });
  });
});


test("sporades deploy wires database and MinIO storage Capsule services through Compose", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
      storage: {
        kind: "storage",
        engine: "minio",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-storage-service", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.deepEqual(output.data.services, {
        database: {
          status: "ready",
          engine: "libsql",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-database",
          statePath: path.join(".sporades", "services", "database"),
        },
        storage: {
          status: "ready",
          engine: "minio",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-storage",
          statePath: path.join(".sporades", "services", "storage"),
        },
      });
      const credentials = await readCapsuleServiceCredentials(projectDir);
      assert.equal(deployResult.stdout.includes(credentials.storageSecretKey), false, deployResult.stdout);
      assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /sporades-todo-island-database:/);
      assert.match(compose, /sporades-todo-island-storage:/);
      assert.match(compose, /command: "server \/data --console-address \\":9001\\""/);
      assert(compose.includes(`MINIO_ROOT_PASSWORD: ${JSON.stringify(credentials.storageSecretKey)}`), compose);
      assert.match(compose, /com\.sporades\.capsule-service\.kind: "storage"/);
      assert.match(compose, new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.sporades\\/services\\/storage\:\\/data:rw"`));

      const calls = await docker.calls();
      const runCall = firstDockerRunCall(calls);
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=libsql"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_URL=http://sporades-todo-island-database:8080"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ENGINE=minio"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ENDPOINT=http://sporades-todo-island-storage:9000"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ACCESS_KEY=sporades"), runCall.args.join(" "));
      assert(runCall.args.includes(`SPORADES_SERVICE_STORAGE_SECRET_KEY=${credentials.storageSecretKey}`), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_BUCKET=sporades-files"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_REGION=us-east-1"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_NAMESPACE=todo-island"), runCall.args.join(" "));
      assert.equal(
        calls.some((call) => call.args[0] === "compose" && call.args.includes("port")),
        false,
        "container sessions must not rely on published service ports",
      );

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENGINE"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENDPOINT"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ACCESS_KEY"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_SECRET_KEY"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_BUCKET"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_REGION"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_NAMESPACE"/);
    });
  });
});


test("sporades deploy fails before replacement when a declared service is unhealthy", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-never-started", {
      composePsOutput: JSON.stringify({ State: "running", Health: "unhealthy" }),
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const output = JSON.parse(deployResult.stdout);
    assert.equal(output.error.message, "Capsule database service did not become ready.");
    assert.equal(output.error.diagnostics.service, "database");
    assert.equal(output.error.diagnostics.engine, "libsql");
    assert.deepEqual(output.error.diagnostics.status, { state: "running", health: "unhealthy" });
    assert.deepEqual(output.error.diagnostics.services, {
      database: {
        status: "failed",
        engine: "libsql",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-database",
        statePath: path.join(".sporades", "services", "database"),
      },
    });
    assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});


test("sporades deploy reset removes generated Capsule service state and orphans without third-party images", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: { kind: "database", engine: "libsql" },
      storage: { kind: "storage", engine: "minio" },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const stateDir = path.join(projectDir, ".sporades", "services", "database");
    const storageStateDir = path.join(projectDir, ".sporades", "services", "storage");
    await mkdir(stateDir, { recursive: true });
    await mkdir(storageStateDir, { recursive: true });
    await writeFile(path.join(stateDir, "removed.txt"), "gone\n");
    await writeFile(path.join(storageStateDir, "removed.txt"), "gone\n");
    const docker = await installFakeDocker(dir, "container-reset", {
      sporadesImages: "sporades-owned-image\n",
    });

    const reset = await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(reset.code, 0, reset.stderr);
    await assert.rejects(readFile(path.join(stateDir, "removed.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(storageStateDir, "removed.txt"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(reset.stdout).data.services, {
      database: {
        status: "reset",
        engine: "libsql",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-database",
        statePath: path.join(".sporades", "services", "database"),
        removedImages: ["sporades-owned-image"],
      },
      storage: {
        status: "reset",
        engine: "minio",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-storage",
        statePath: path.join(".sporades", "services", "storage"),
        removedImages: ["sporades-owned-image"],
      },
    });
    const calls = await docker.calls();
    const downCall = calls.find((call) => call.args[0] === "compose" && call.args.includes("down"));
    assert.deepEqual(downCall.args.slice(0, 4), ["compose", "-p", "sporades-todo-island-services", "-f"]);
    assert.deepEqual(downCall.args.slice(5), ["down", "--remove-orphans", "--volumes"]);
    assert(calls.some((call) => call.args[0] === "rmi" && call.args.includes("sporades-owned-image")));
    assert.equal(calls.some((call) => call.args[0] === "rmi" && call.args.includes("third-party-libsql")), false);
  });
});


test("sporades deploy restart starts the bound stopped local Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-bound", containerName: "sporades-todo-island" };
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir);

    const restart = await runCli(["deploy", "restart", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(restart.code, 0, restart.stderr);
    assert.deepEqual(JSON.parse(restart.stdout), {
      ok: true,
      data: {
        container: { status: "running", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["start", "container-bound"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")), binding);
  });
});


test("Container remove and reset release durable public-tree consumers", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "consumer-lifecycle-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "consumer-lifecycle-island"));
    await installFakeReact(projectDir);
    const consumerPath = path.join(projectDir, ".sporades", "build", ".public-trees", ".consumers", "container.json");
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const docker = await installFakeDocker(dir, "consumer-container");
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await stat(consumerPath);
    assert.equal((await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await assert.rejects(stat(consumerPath), (error) => error.code === "ENOENT");
    await assert.rejects(stat(bindingPath), (error) => error.code === "ENOENT");

    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await stat(consumerPath);
    assert.equal((await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await assert.rejects(stat(consumerPath), (error) => error.code === "ENOENT");
    await assert.rejects(stat(bindingPath), (error) => error.code === "ENOENT");
  });
});


test("sporades deploy builds the bundled Base image when pull is unavailable", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-built-base-image", {
      imageInspectStatus: 1,
      pullStatus: 1,
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-built-base-image");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["image", "pull", "build", "run", "inspect"]);
    assert.deepEqual(calls[0].args, ["image", "inspect", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"]);
    assert.deepEqual(calls[1].args, ["pull", "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine"]);
    assert.deepEqual(calls[2].args.slice(0, 5), [
      "build",
      "-f",
      path.join(repoRoot, "Dockerfile.base"),
      "-t",
      "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
    ]);
    assert.equal(calls[2].args[5], repoRoot);
  });
});


test("sporades deploy fails on stale container bindings without --force", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-deleted");
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingInspectIds: ["container-deleted"],
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "The existing Container binding is stale.",
        hint: "Retry with `sporades deploy --force`; through npm, use `npm run deploy -- --force`.",
      },
    });

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["image", "inspect"],
    );
  });
});


test("local deploy.files reconciles Unicode-equivalent preserved identities once", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "unicode-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "unicode-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    const docker = await installFakeDocker(dir, "unicode-candidate");
    const preservedRoot = path.join(projectDir, ".sporades/preserved-files");
    const stored = preservedDeployFilePath(preservedRoot, "\u00e9.json");
    for (const [index, relative] of ["e\u0301.json", "\u00e9.json"].entries()) {
      await writeFile(path.join(projectDir, relative), `seed-${index}`);
      config.deploy.files = [{ path: relative, update: "preserve" }];
      await writeFile(configPath, JSON.stringify(config));
      const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
      const run = (await docker.calls()).filter((call) => call.args[0] === "run").at(-1);
      assert(run.args.includes(`${stored}:/app/${relative}:rw`), "both spellings mount the one stored copy");
      if (index === 0) await writeFile(stored, "server edit");
    }
    assert.equal(await readFile(stored, "utf8"), "server edit");
    assert.deepEqual((await readdir(preservedRoot)).filter((entry) => entry.endsWith(".file")), [path.basename(stored)], "equivalent spellings share one stored file");
  });
});


test("local deploy.files stop and remove preserve binding and candidate state while an attempt survives", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "remove-pending", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "remove-pending"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy.files = [{ path: "settings.json" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "snapshot");
    const docker = await installFakeDocker(dir, "pending-candidate");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
    const bindingPath = path.join(projectDir, ".sporades/binding.json");
    const beforeBinding = await readFile(bindingPath, "utf8");
    const snapshot = path.join(JSON.parse(beforeBinding).deployFilesRoot, "settings.json");
    const preload = path.join(dir, "exit-candidate.mjs");
    await writeFile(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  const result = spawn.call(this, command, args, ...rest);
  if (command === 'docker' && args[0] === 'run' && args.includes('--detach') && result.status === 0) process.exit(17);
  return result;
}; syncBuiltinESMExports();`);
    const interrupted = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(interrupted.code, 17, interrupted.stdout + interrupted.stderr);
    const journal = path.join(projectDir, ".sporades/deploy-file-attempt.jsonl");
    const beforeJournal = await readFile(journal, "utf8");
    const calls = (await docker.calls()).length;
    for (const action of ["stop", "remove"]) {
      const result = await runCli(["deploy", action, "--json"], { cwd: projectDir, env: docker.env });
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /requires recovery/);
      assert.equal((await docker.calls()).length, calls);
    }
    assert.equal(await readFile(bindingPath, "utf8"), beforeBinding);
    assert.equal(await readFile(journal, "utf8"), beforeJournal);
    assert.equal(await readFile(snapshot, "utf8"), "snapshot");

    // Reconciliation settles the journal without touching the bound Container:
    // the candidate is removed by its transaction label and its snapshot dropped.
    const records = beforeJournal.trim().split("\n").map(JSON.parse);
    const candidate = records.find((record) => record.candidate).candidate;
    assert.match(candidate.transaction, /^[a-f0-9]{32}$/);
    const reconciled = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(reconciled.code, 0, reconciled.stdout + reconciled.stderr);
    const outcome = JSON.parse(reconciled.stdout).data;
    assert.equal(outcome.status, "reconciled");
    assert.equal(outcome.committed, false);
    assert.deepEqual(outcome.actions, ["candidate-container-removed", "candidate-snapshot-removed", "bound-files-prepared", "journal-removed"]);
    const reconcileCalls = (await docker.calls()).slice(calls);
    // The fake Docker reuses one container ID, so the bound Container is inspected
    // for its staged name; no rename, stop, or start is issued.
    assert.deepEqual(reconcileCalls.map((call) => call.args[0]), ["ps", "rm", "inspect"]);
    assert.deepEqual(reconcileCalls[0].args.slice(0, 3), ["ps", "--all", "--quiet"]);
    assert(reconcileCalls[0].args.includes(`label=com.sporades.container-transaction=${candidate.transaction}`));
    assert.equal(reconcileCalls[1].args[1], "-f");
    await assert.rejects(readFile(journal), { code: "ENOENT" });
    assert.notEqual(records[0].release, JSON.parse(beforeBinding).deployFilesRoot);
    await assert.rejects(stat(records[0].release), { code: "ENOENT" });
    assert.equal(await readFile(bindingPath, "utf8"), beforeBinding);
    assert.equal(await readFile(snapshot, "utf8"), "snapshot");
    const clean = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(JSON.parse(clean.stdout).data.status, "clean");
    const stopped = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  });
});


test("Container deployment seeds and pins read-only admission authority across publication and redeploy", async () => {
  await withTempDir(async dir => {
    const created = await runCli(["create","admission-capsule","--no-install","--no-git","--json"],{cwd:dir}); assert.equal(created.code,0,created.stderr);
    const projectDir = await realpath(path.join(dir,"admission-capsule")); await installFakeReact(projectDir);
    const docker = await installFakeDocker(path.join(dir,"docker"),"admission-container");
    const configPath = path.join(projectDir,"sporades.json"); const config = JSON.parse(await readFile(configPath,"utf8")); config.admissionPolicy = {path:"policy.json"}; await writeFile(configPath,JSON.stringify(config));
    const json = id => JSON.stringify({version:1,rules:[{id,enabled:true,conditions:[{kind:"pathname",exact:"/blocked"}],action:{kind:"deny"}}]});
    await writeFile(path.join(projectDir,"policy.json"),json("seed"));
    const deploy = () => runCli(["deploy","--port","5688","--json"],{cwd:projectDir,env:docker.env});
    const first = await deploy(); assert.equal(first.code,0,first.stdout+first.stderr);
    const storage = path.join(projectDir,".sporades","preserved-files","admission"); const stored = preservedDeployFilePath(storage,"policy.json");
    assert.equal((await stat(stored)).mode & 0o777,0o444);
    const run = (await docker.calls()).filter(call=>call.args[0]==="run").at(-1);
    assert(run.args.includes(`${storage}:/run/sporades-admission:ro`)); assert(run.args.includes("SPORADES_ADMISSION_POLICY_PATH=policy.json"));
    const binding = JSON.parse(await readFile(path.join(projectDir,".sporades","binding.json"),"utf8")); assert.deepEqual(binding.deployFiles,[{path:"policy.json",update:"admission"}]);
    await writeFile(path.join(projectDir,"next.json"),json("published"));
    const published = await runCli(["deploy","policy","publish","next.json","--json"],{cwd:projectDir,env:docker.env}); assert.equal(published.code,0,published.stdout+published.stderr);
    await writeFile(path.join(projectDir,"policy.json"),json("new-seed")); const again = await deploy(); assert.equal(again.code,0,again.stdout+again.stderr);
    assert.equal(JSON.parse(await readFile(stored,"utf8")).rules[0].id,"published");
    const removed = await runCli(["deploy","policy","remove","--json"],{cwd:projectDir,env:docker.env}); assert.equal(removed.code,0,removed.stdout+removed.stderr);
    const afterRemoval = await deploy(); assert.equal(afterRemoval.code,0,afterRemoval.stdout+afterRemoval.stderr); assert.equal(JSON.parse(await readFile(stored,"utf8")).removed,true);
    delete config.admissionPolicy; await writeFile(configPath,JSON.stringify(config)); const unconfigured = await deploy(); assert.equal(unconfigured.code,0,unconfigured.stdout+unconfigured.stderr);
    const last = (await docker.calls()).filter(call=>call.args[0]==="run").at(-1); assert(!last.args.some(arg=>arg.includes(":/run/sporades-admission:"))); assert.equal(JSON.parse(await readFile(stored,"utf8")).removed,true);
  });
});



test("declared container services deliver secret references by child environment and keep Compose, Bundles, output and argv clean", async () => {
  await withTempDir(async dir => {
    const created = await runCli(["create", "container-secret-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "container-secret-island"));
    await installFakeReact(projectDir);
    const config = JSON.parse(await readFile(path.join(projectDir, "sporades.json"), "utf8"));
    config.services = { embeddings: { kind: "container", image: "example/embeddings:v1", command: ["--embeddings"], port: 8080, health: { http: "/health" }, env: { HF_TOKEN: { sealed: "HF_TOKEN" }, API_KEY: { generated: "apiKey" }, TUNING: "2048" }, compose: { tty: false, stdin_open: false, "x-note": { purpose: "reviewed" }, logging: { driver: "json-file", options: {} }, privileged: false, dns: "1.1.1.1", dns_search: "example.test", extra_hosts: ["reviewed:127.0.0.1", "ipv6:[::1]"], deploy: { resources: { limits: { pids: 64 } } }, volumes: [{ type: "volume", source: "cache", target: "/cache", volume: { nocopy: false } }] }, elevated: ["privileged", "extra_hosts"] } };
    await writeFile(path.join(projectDir, "sporades.json"), JSON.stringify(config));
    const sealedValue = "synthetic-service-provider-token";
    const { ensureSealedServerEnvKeyPair, sealedServerEnvPaths, sealServerEnv, writeSealedServerEnv } = await import("../dist/sealed-server-env.js");
    const envPaths = sealedServerEnvPaths(projectDir);
    const pair = await ensureSealedServerEnvKeyPair(envPaths);
    await writeSealedServerEnv(envPaths, sealServerEnv({ HF_TOKEN: sealedValue, UNDECLARED_SECRET: "synthetic-unrelated-secret" }, pair.publicKey));
    const docker = await installFakeDocker(dir, "container-service-new");
    docker.env.COMPOSE_PROJECT_NAME = "qa-unrelated";
    const deployed = await runCli(["deploy", "--port", "5203", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
    const credentials = JSON.parse(await readFile(capsuleServiceCredentialsPath(projectDir), "utf8"));
    const generated = credentials.container.embeddings.apiKey;
    const composeSource = await readFile(path.join(projectDir, ".sporades/compose/capsule-services.compose.yml"), "utf8");
    const bundle = await readFile(path.join(projectDir, ".sporades/build/server.mjs"), "utf8");
    const calls = await docker.calls();
    const clientBundle = await readFile(path.join(projectDir, ".sporades/build/client.js"), "utf8");
    const output = deployed.stdout + deployed.stderr + composeSource + bundle + clientBundle + JSON.stringify(calls);
    for (const secret of [sealedValue, generated, "synthetic-unrelated-secret"]) assert(!output.includes(secret));
    const service = Object.values(JSON.parse(composeSource).services)[0];
    assert.deepEqual(Object.keys(service.environment).sort(), ["API_KEY", "HF_TOKEN", "TUNING"]);
    const capsuleRun = firstDockerRunCall(calls);
    assert(capsuleRun.args.includes("SPORADES_CONTAINER_SERVICES"));
    assert(!capsuleRun.args.some(v => v.startsWith("SPORADES_CONTAINER_SERVICES=")));
    assert(calls.findIndex(c => c.args.includes("config")) < calls.findIndex(c => c.args.includes("up")));
    const log = await readFile(path.join(projectDir, ".sporades/data/logs/events.jsonl"), "utf8");
    assert.match(log, /capsule-service.elevated.start/);
    assert(!log.includes(generated));assert(!log.includes(sealedValue));
    const rejected = await runCli(["deploy", "--port", "5203", "--json"], { cwd: projectDir, env: { ...docker.env, FAKE_DOCKER_COMPOSE_TAMPER: "1" } });
    assert.equal(rejected.code, 1);assert.match(rejected.stdout, /services.embeddings.compose.user/);
    assert.equal((await docker.calls()).filter(c => c.args.includes("up")).length, 1);
    config.services.embeddings.network = { egress: false };
    await writeFile(path.join(projectDir, "sporades.json"), JSON.stringify(config));
    const isolated = await runCli(["deploy", "--port", "5203", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(isolated.code, 0, isolated.stdout + isolated.stderr);
    const isolatedRun = (await docker.calls()).filter(c => c.args[0] === "run").at(-1);
    const networkNames = isolatedRun.args.flatMap((arg, index) => arg === "--network" ? [isolatedRun.args[index + 1]] : []);
    assert.deepEqual(networkNames, ["bridge", "sporades-container-secret-island-services-internal"]);
    const status = await runCli(["deploy", "status", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(status.code, 0, status.stdout + status.stderr);
    const activeStop = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(activeStop.code, 0, activeStop.stdout + activeStop.stderr);
    const activeReset = await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(activeReset.code, 0, activeReset.stdout + activeReset.stderr);
    // A retired Dev model may have no Capsule keeping its old network alive.
    // Container startup must use the post-reconciliation service result.
    config.services = {};
    await writeFile(path.join(projectDir, "sporades.json"), JSON.stringify(config));
    const removed = await runCli(["deploy", "--port", "5203", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    const withoutServices = (await docker.calls()).filter(c => c.args[0] === "run").at(-1);
    assert(!withoutServices.args.includes("--network"));
    assert(!withoutServices.args.includes("SPORADES_CONTAINER_SERVICES"));
    await rm(path.join(projectDir, ".sporades/sealed-server-env"), { recursive: true, force: true });
    const stopped = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    const retiredState = path.join(projectDir, ".sporades/services/retired-service");
    await mkdir(retiredState, { recursive: true });
    await writeFile(path.join(retiredState, "model-cache"), "old declaration state");
    const reset = await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(reset.code, 0, reset.stdout + reset.stderr);
    await assert.rejects(readFile(path.join(retiredState, "model-cache")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(capsuleServiceCredentialsPath(projectDir), "utf8")).container, undefined);
    for (const { args } of (await docker.calls()).filter(c => c.args[0] === "compose")) assert.equal(args[args.indexOf("-p") + 1], "sporades-container-secret-island-services");
    assert(!(await docker.calls()).some(c => c.args[0] === "rmi" && c.args.includes("example/embeddings:v1")));
  });
});
