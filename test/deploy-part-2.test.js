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
firstDockerRunCall,
readCapsuleServiceCredentials,
seedCapsuleServiceCredentials,
dockerRunEnv,
assertVolume,
updateSporadesConfig,
declareClamavFileIngress,
writeHttpHostBridge,
nodeOptionsWithImport,
installFakeReact,
installFakePreact,
installVue,
withFakeGoogleServer,
withFakeMicrosoftServer,
withFakeCapsuleService,
withFakePostgresService,
getAvailablePort,
waitForJsonStdoutLine,
stopChild,
installEnvProbeQuery,
assertUnknownEnvQuery,
openSocket,
readSocketMessage,
waitForSocketMessage
} from "./support/deploy-fixture.js";


test("invalid private CA fails before replacing a working Container or altering the operator file", async () => {
  await withTempDir(async (dir) => {
    const projectRoot = path.join(dir, "with,comma");
    await mkdir(projectRoot);
    const created = await runCli(["create", "ca-capsule", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: projectRoot });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(projectRoot, "ca-capsule"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "ca-container");
    const configDir = path.join(dir, "operator-config");
    await mkdir(configDir);
    const caPath = path.join(dir, "operator-ca.pem");
    const env = { ...docker.env, SPORADES_CONFIG_DIR: configDir };
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env })).code, 0);
    const originalBinding = await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8");
    const cases = [
      ["missing", async () => {}],
      ["directory", async () => mkdir(caPath)],
      ["oversized", async () => writeFile(caPath, "x".repeat(1024 * 1024 + 1))],
      ["unreadable", async () => { await writeFile(caPath, "unreadable"); await chmod(caPath, 0o000); }],
      ["malformed", async () => writeFile(caPath, "not a certificate")],
    ];
    for (const [name, prepare] of cases) {
      await rm(caPath, { recursive: true, force: true });
      await prepare();
      await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
        private: { endpoint: "https://monitor.example:4318", tls: { mode: "verified", caFile: caPath } },
      } }));
      const before = await docker.calls();
      const result = await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env });
      assert.notEqual(result.code, 0, `${name}: ${result.stdout}`);
      assert.deepEqual(await docker.calls(), before, `${name}: Docker lifecycle remains untouched`);
      assert.equal(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"), originalBinding);
      if (name === "unreadable") assert.equal((await stat(caPath)).mode & 0o777, 0);
    }
    await rm(caPath, { recursive: true, force: true });
    const certificate = await readFile(path.join(repoRoot, "test", "fixtures", "smtp-test-cert.pem"));
    await writeFile(caPath, certificate, { mode: 0o600 });
    await chmod(caPath, 0o600);
    const valid = await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env });
    assert.equal(valid.code, 0, valid.stderr);
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const run = (await docker.calls()).filter(call => call.args[0] === "run").at(-1);
    assert(run.args.some(arg => arg.includes(`"source=${binding.telemetryCaStagePath}"`) && arg.includes("target=/run/sporades/telemetry-ca.pem")));
    assert(!run.args.some(arg => arg.includes(caPath)));
    assert.deepEqual(await readFile(binding.telemetryCaStagePath), certificate);
    assert.equal((await stat(binding.telemetryCaStagePath)).mode & 0o777, 0o644, "runtime UID can read staged trust");
    assert.equal((await stat(caPath)).mode & 0o777, 0o600, "operator mode stays private");
    assert.deepEqual(await readFile(caPath), certificate, "operator CA stays untouched");
    await updateSporadesConfig(projectDir, config => {
      config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    });
    const sshDeploy = await runCli(["deploy", "--json"], { cwd: projectDir, env });
    assert.equal(sshDeploy.code, 0, sshDeploy.stderr);
    const sshBinding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const sshRun = (await docker.calls()).filter(call => call.args[0] === "run").at(-1).args;
    assert(sshRun.includes(BASE_IMAGE_RUNTIME_USER));
    assert(sshRun.some(arg => arg.includes(sshBinding.telemetryCaStagePath)));
    assert.equal((await stat(sshBinding.telemetryCaStagePath)).mode & 0o777, 0o644);
    await assert.rejects(readFile(binding.telemetryCaStagePath), { code: "ENOENT" }, "old staged CA is retired after replacement");
  });
});


test("interrupted CA deployment reconciles its unbound copy and preserves the bound copy until removal", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "ca-recovery", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ca-recovery"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "ca-recovery-container");
    const configDir = path.join(dir, "operator-config");
    const caPath = path.join(dir, "operator-ca.pem");
    await mkdir(configDir);
    const certificate = await readFile(path.join(repoRoot, "test", "fixtures", "smtp-test-cert.pem"));
    await writeFile(caPath, certificate, { mode: 0o600 });
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: "https://monitor.example:4318", tls: { mode: "verified", caFile: caPath } },
    } }));
    const env = { ...docker.env, SPORADES_CONFIG_DIR: configDir };
    assert.equal((await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env })).code, 0);
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const originalBinding = await readFile(bindingPath, "utf8");
    const activeCa = JSON.parse(originalBinding).telemetryCaStagePath;
    const preload = path.join(dir, "exit-after-ca-candidate.mjs");
    await writeFile(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  const result = spawn.call(this, command, args, ...rest);
  if (command === 'docker' && args[0] === 'run' && args.includes('--detach') && result.status === 0) process.exit(17);
  return result;
}; syncBuiltinESMExports();`);
    const interrupted = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${preload}` } });
    assert.equal(interrupted.code, 17, interrupted.stdout + interrupted.stderr);
    const journal = path.join(projectDir, ".sporades", "deploy-file-attempt.jsonl");
    const records = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    const candidateCa = records.find(record => record.telemetryCaStagePath)?.telemetryCaStagePath;
    assert(candidateCa && candidateCa !== activeCa);
    assert.deepEqual(await readFile(candidateCa), certificate);
    assert.deepEqual(await readFile(activeCa), certificate);
    for (const action of ["stop", "remove"]) {
      const blocked = await runCli(["deploy", action, "--json"], { cwd: projectDir, env });
      assert.notEqual(blocked.code, 0);
      assert.match(blocked.stdout + blocked.stderr, /requires recovery/);
    }
    const reconciled = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env });
    assert.equal(reconciled.code, 0, reconciled.stdout + reconciled.stderr);
    assert(JSON.parse(reconciled.stdout).data.actions.includes("candidate-telemetry-ca-removed"));
    await assert.rejects(readFile(candidateCa), { code: "ENOENT" });
    assert.deepEqual(await readFile(activeCa), certificate);
    assert.equal(await readFile(bindingPath, "utf8"), originalBinding);
    const earlyPreload = path.join(dir, "exit-after-ca-write.mjs");
    await writeFile(earlyPreload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const write = fs.promises.writeFile;
fs.promises.writeFile = async function(file, ...args) {
  const result = await write.call(this, file, ...args);
  if (String(file).includes('/.sporades/telemetry-ca/')) process.exit(19);
  return result;
}; syncBuiltinESMExports();`);
    const earlyExit = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${earlyPreload}` } });
    assert.equal(earlyExit.code, 19, earlyExit.stdout + earlyExit.stderr);
    const earlyRecords = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    const earlyCa = earlyRecords.find(record => record.telemetryCaStagePath)?.telemetryCaStagePath;
    assert.deepEqual(await readFile(earlyCa), certificate);
    assert.equal((await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env })).code, 0);
    await assert.rejects(readFile(earlyCa), { code: "ENOENT" });
    assert.deepEqual(await readFile(activeCa), certificate);
    assert.equal((await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env })).code, 0);
    await assert.rejects(readFile(activeCa), { code: "ENOENT" });
    assert.deepEqual(await readFile(caPath), certificate, "operator CA remains untouched");
  });
});


test("reconcile keeps old CA before untrusted replacement commits and retires it after binding commits", async () => {
  for (const selection of [["--no-telemetry"], ["--telemetry", "public"]]) await withTempDir(async (dir) => {
    const created = await runCli(["create", "ca-disable", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ca-disable"));
    await installFakeReact(projectDir);
    const configDir = path.join(dir, "operator-config");
    const caPath = path.join(dir, "operator-ca.pem");
    await mkdir(configDir);
    const certificate = await readFile(path.join(repoRoot, "test", "fixtures", "smtp-test-cert.pem"));
    await writeFile(caPath, certificate, { mode: 0o600 });
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: "https://monitor.example:4318", tls: { mode: "verified", caFile: caPath } },
      public: { endpoint: "https://monitor.example:4318", tls: { mode: "verified" } },
    } }));
    const firstDocker = await installFakeDocker(path.join(dir, "first"), "ca-old-container");
    const firstEnv = { ...firstDocker.env, SPORADES_CONFIG_DIR: configDir };
    assert.equal((await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env: firstEnv })).code, 0);
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const originalBinding = await readFile(bindingPath, "utf8");
    const oldCa = JSON.parse(originalBinding).telemetryCaStagePath;
    const nextDocker = await installFakeDocker(path.join(dir, "next"), "ca-new-container");
    const env = { ...nextDocker.env, SPORADES_CONFIG_DIR: configDir };
    const earlyPreload = path.join(dir, "exit-before-binding.mjs");
    await writeFile(earlyPreload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  const result = spawn.call(this, command, args, ...rest);
  if (command === 'docker' && args[0] === 'run' && args.includes('--detach') && result.status === 0) process.exit(17);
  return result;
}; syncBuiltinESMExports();`);
    const early = await runCli(["deploy", ...selection, "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${earlyPreload}` } });
    assert.equal(early.code, 17, early.stdout + early.stderr);
    const journal = path.join(projectDir, ".sporades", "deploy-file-attempt.jsonl");
    assert((await readFile(journal, "utf8")).includes(oldCa), `${selection.join(" ")}: previous CA recorded for recovery`);
    const before = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env });
    assert.equal(before.code, 0, before.stdout + before.stderr);
    assert.equal(JSON.parse(before.stdout).data.committed, false);
    assert.deepEqual(await readFile(oldCa), certificate, "uncommitted replacement retains bound CA");
    assert.equal(await readFile(bindingPath, "utf8"), originalBinding);
    const latePreload = path.join(dir, "exit-after-binding.mjs");
    await writeFile(latePreload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async function(source, target) {
  const result = await rename.call(this, source, target);
  if (String(target).endsWith('/.sporades/binding.json')) process.exit(18);
  return result;
}; syncBuiltinESMExports();`);
    const late = await runCli(["deploy", ...selection, "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${latePreload}` } });
    assert.equal(late.code, 18, late.stdout + late.stderr);
    assert((await readFile(journal, "utf8")).includes(oldCa));
    const committed = JSON.parse(await readFile(bindingPath, "utf8"));
    assert.equal(committed.telemetryCaStagePath, undefined);
    const after = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env });
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.equal(JSON.parse(after.stdout).data.committed, true);
    await assert.rejects(readFile(oldCa), { code: "ENOENT" });
    assert.deepEqual(await readFile(caPath), certificate);
  });
});


test("forced replacement journals bound CA ownership even when the previous Container is missing", async () => {
  for (const selection of [["--no-telemetry"], ["--telemetry", "private"]]) await withTempDir(async (dir) => {
    const created = await runCli(["create", "ca-stale", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ca-stale"));
    await installFakeReact(projectDir);
    const configDir = path.join(dir, "operator-config");
    const caPath = path.join(dir, "operator-ca.pem");
    await mkdir(configDir);
    const certificate = await readFile(path.join(repoRoot, "test", "fixtures", "smtp-test-cert.pem"));
    await writeFile(caPath, certificate, { mode: 0o600 });
    await writeFile(path.join(configDir, "telemetry.json"), JSON.stringify({ schemaVersion: 1, profiles: {
      private: { endpoint: "https://monitor.example:4318", tls: { mode: "verified", caFile: caPath } },
    } }));
    const oldDocker = await installFakeDocker(path.join(dir, "old"), "ca-old-container");
    const oldEnv = { ...oldDocker.env, SPORADES_CONFIG_DIR: configDir };
    assert.equal((await runCli(["deploy", "--telemetry", "private", "--json"], { cwd: projectDir, env: oldEnv })).code, 0);
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const oldBinding = await readFile(bindingPath, "utf8");
    const oldCa = JSON.parse(oldBinding).telemetryCaStagePath;
    const nextDocker = await installFakeDocker(path.join(dir, "next"), "ca-next-container", { missingInspectIds: ["ca-old-container"] });
    const env = { ...nextDocker.env, SPORADES_CONFIG_DIR: configDir };
    const earlyPreload = path.join(dir, "exit-before-binding.mjs");
    await writeFile(earlyPreload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  const result = spawn.call(this, command, args, ...rest);
  if (command === 'docker' && args[0] === 'run' && args.includes('--detach') && result.status === 0) process.exit(17);
  return result;
}; syncBuiltinESMExports();`);
    const early = await runCli(["deploy", "--force", ...selection, "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${earlyPreload}` } });
    assert.equal(early.code, 17, early.stdout + early.stderr);
    const journal = path.join(projectDir, ".sporades", "deploy-file-attempt.jsonl");
    const earlyRecords = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(earlyRecords.find(record => record.previous)?.previous.telemetryCaStagePath, oldCa);
    const before = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env });
    assert.equal(before.code, 0, before.stdout + before.stderr);
    assert.equal(JSON.parse(before.stdout).data.committed, false);
    assert.deepEqual(await readFile(oldCa), certificate);
    assert.equal(await readFile(bindingPath, "utf8"), oldBinding);
    const latePreload = path.join(dir, "exit-after-binding.mjs");
    await writeFile(latePreload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async function(source, target) {
  const result = await rename.call(this, source, target);
  if (String(target).endsWith('/.sporades/binding.json')) process.exit(18);
  return result;
}; syncBuiltinESMExports();`);
    const late = await runCli(["deploy", "--force", ...selection, "--json"], { cwd: projectDir, env: { ...env, NODE_OPTIONS: `--import=${latePreload}` } });
    assert.equal(late.code, 18, late.stdout + late.stderr);
    const committed = JSON.parse(await readFile(bindingPath, "utf8"));
    assert.notEqual(committed.containerId, JSON.parse(oldBinding).containerId);
    const after = await runCli(["deploy", "reconcile", "--json"], { cwd: projectDir, env });
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.equal(JSON.parse(after.stdout).data.committed, true);
    await assert.rejects(readFile(oldCa), { code: "ENOENT" });
    if (selection.includes("private")) assert.deepEqual(await readFile(committed.telemetryCaStagePath), certificate);
    else assert.equal(committed.telemetryCaStagePath, undefined);
    assert.deepEqual(await readFile(caPath), certificate);
  });
});


for (const { framework, template } of [
  { framework: "react", template: "blank" },
  { framework: "preact", template: "blank" },
  { framework: "lit", template: "blank" },
  { framework: "lit", template: "todo" },
  { framework: "lit", template: "guestbook" },
  { framework: "lit", template: "photo-library" },
  { framework: "lit", template: "campfire" },
  { framework: "solid", template: "blank" },
  { framework: "solid", template: "todo" },
  { framework: "solid", template: "guestbook" },
  { framework: "solid", template: "photo-library" },
  { framework: "solid", template: "campfire" },
  { framework: "vue", template: "blank" },
  { framework: "vue", template: "todo" },
  { framework: "vue", template: "guestbook" },
  { framework: "vue", template: "photo-library" },
  { framework: "vue", template: "campfire" },
  { framework: "svelte", template: "blank" },
  { framework: "svelte", template: "todo" },
  { framework: "svelte", template: "guestbook" },
  { framework: "svelte", template: "photo-library" },
  { framework: "svelte", template: "campfire" },
]) test(`sporades deploy mounts the complete normalized ${framework} Vite ${template} public tree`, async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "vite-release", "--template", template, "--framework", framework, "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "vite-release"));
    await (framework === "react" ? installFakeReact : framework === "preact" ? installFakePreact : framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot) : framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot) : framework === "vue" ? installVue : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}SERVER_ONLY_TOKEN=vite-container-secret\n`);
    const docker = await installFakeDocker(dir, "vite-container");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, framework);
    assert.equal(binding.clientRelease.toolchain, "vite");
    assert(binding.clientRelease.paths.includes("index.html"));
    assert(binding.clientRelease.paths.some((file) => /^assets\/index-[^/]+\.js$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => /^assets\/index-[^/]+\.css$/.test(file)));
    if (framework === "react" || framework === "preact") assert(binding.clientRelease.paths.some((file) => /^assets\/vite-scaffold-[^/]+\.js$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => file.endsWith(".js.map")));
    assert.equal(binding.clientRelease.paths.includes("client.js"), false);

    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(output, /dev\.refresh\.(?:subscribe|ready|received)/, "Container client output omits Dev refresh protocol");
    assert.doesNotMatch(serverBundle, /dev\.refresh\.(?:subscribe|ready|received)/, "Container server output omits Dev refresh capability and hints");
    assert.doesNotMatch(output, /vite-container-secret|SERVER_ONLY_TOKEN|\/@vite\/client|react-refresh|vite\/hmr/i);
    if (framework === "preact") assert.doesNotMatch(output, /node_modules\/react(?:-dom)?\/|from ["']react(?:-dom)?/);
    if (framework === "solid") {
      assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(output, /react-dom|react\/jsx-runtime/);
    }
    if (framework === "lit") {
      assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(output, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
    if (framework === "vue") assert.match(output, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "svelte") assert.match(output, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    const runCall = firstDockerRunCall(await docker.calls());
    assertVolume(runCall.args, `${publicRoot}:/app/public:ro`);
  });
});


test("Container replacement switches one complete public tree while persistent data stays separate", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "replacement-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "replacement-island"));
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, "public"));
    await writeFile(path.join(projectDir, "public/robots.txt"), "first crawler rules");
    const dataMarker = path.join(projectDir, ".sporades", "data", "persistent.txt");
    await mkdir(path.dirname(dataMarker), { recursive: true });
    await writeFile(dataMarker, "keep me");
    const docker = await installFakeDocker(dir, "container-replacement");

    const first = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(first.code, 0, first.stderr);
    const firstBinding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const firstRoot = path.join(projectDir, ".sporades", "build", ".public-trees", firstBinding.clientRelease.publicTree);
    assert.match(await readFile(path.join(firstRoot, "client.js"), "utf8"), /Sporades Todos/);

    const clientEntry = path.join(projectDir, "client", "index.tsx");
    await writeFile(clientEntry, (await readFile(clientEntry, "utf8")).replaceAll("Sporades Todos", "Sporades Replacement Todos"));
    await writeFile(path.join(projectDir, "public/robots.txt"), "second crawler rules");
    const second = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(second.code, 0, second.stderr);
    const secondBinding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const secondRoot = path.join(projectDir, ".sporades", "build", ".public-trees", secondBinding.clientRelease.publicTree);
    assert.notEqual(secondRoot, firstRoot);
    assert.equal(await readFile(path.join(firstRoot, "robots.txt"), "utf8"), "first crawler rules");
    assert.equal(await readFile(path.join(secondRoot, "robots.txt"), "utf8"), "second crawler rules");
    assert.doesNotMatch(await readFile(path.join(firstRoot, "client.js"), "utf8"), /Replacement Todos/);
    assert.match(await readFile(path.join(secondRoot, "client.js"), "utf8"), /Sporades Replacement Todos/);
    assert.equal(await readFile(dataMarker, "utf8"), "keep me");

    const calls = await docker.calls();
    const runs = calls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2);
    assertVolume(runs[0].args, `${firstRoot}:/app/public:ro`);
    assertVolume(runs[1].args, `${secondRoot}:/app/public:ro`);
    assertVolume(runs[0].args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    assertVolume(runs[1].args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    const stopIndex = calls.findIndex((call, index) => index > calls.indexOf(runs[0]) && call.args[0] === "stop");
    assert.ok(stopIndex > calls.indexOf(runs[0]));
    assert.ok(calls.indexOf(runs[1]) > stopIndex);
  });
});


test("ClamAV Container replacement proves authenticated runtime readiness before committing", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "clamav-ready-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "clamav-ready-island"));
    await installFakeReact(projectDir);
    const initialDocker = await installFakeDocker(path.join(dir, "initial"), "container-old-ready");
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
    await declareClamavFileIngress(projectDir);

    const replacementDocker = await installFakeDocker(path.join(dir, "replacement"), "container-new-ready");
    let requests = 0;
    const server = createHttpServer(async (request, response) => {
      requests += 1;
      const calls = await replacementDocker.calls();
      const runCall = firstDockerRunCall(calls);
      const expectedToken = runCall.args.find((arg) => arg.startsWith("SPORADES_RUNTIME_PROBE_TOKEN=")).split("=")[1];
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], expectedToken);
      assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-old-ready");
      response.writeHead(requests === 1 ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(requests === 1
        ? { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: false } } }, error: null }
        : { ok: true, data: { runtime: { ready: true }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: true } } }, error: null }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      await updateSporadesConfig(projectDir, (config) => { config.deploy = { ...(config.deploy ?? {}), port: address.port }; });
      const replacement = await runCli(["deploy", "--json"], { cwd: projectDir, env: replacementDocker.env });
      assert.equal(replacement.code, 0, `${replacement.stderr}\n${replacement.stdout}`);
      assert.equal(requests, 2);
      const calls = await replacementDocker.calls();
      const inspectIndex = calls.findIndex((call) => call.args[0] === "inspect" && call.args.includes("{{json .}}"));
      const cleanupIndex = calls.findIndex((call) => call.args[0] === "rm" && call.args[1]?.includes("rollback"));
      assert.ok(cleanupIndex > inspectIndex, "the retained Container is removed only after candidate readiness succeeds");
      assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-new-ready");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});


test("Container replacement restores the previous committed state across Docker transaction failures", async (t) => {
  for (const failedAction of ["rename", "stop", "run", "rm"]) {
    await t.test(failedAction, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `rollback-${failedAction}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `rollback-${failedAction}-island`));
        await installFakeReact(projectDir);
        await mkdir(path.join(projectDir, "public"));
        await writeFile(path.join(projectDir, "public/sitemap.xml"), "<first-release/>");
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-old-${failedAction}`);
        const initial = await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env });
        assert.equal(initial.code, 0, initial.stderr);
        const buildDir = path.join(projectDir, ".sporades", "build");
        const statePaths = {
          binding: path.join(projectDir, ".sporades", "binding.json"),
          active: path.join(buildDir, ".public-trees", "active.json"),
          consumer: path.join(buildDir, ".public-trees", ".consumers", "container.json"),
          server: path.join(buildDir, "server.mjs"),
          client: path.join(buildDir, "client.js"),
        };
        const before = Object.fromEntries(await Promise.all(Object.entries(statePaths).map(async ([key, value]) => [key, await readFile(value, "utf8")])));
        const retainedRoot = path.join(buildDir, ".public-trees", JSON.parse(before.active).tree);
        await writeFile(path.join(projectDir, "public/sitemap.xml"), "<failed-candidate/>");
        const entry = path.join(projectDir, "client", "index.tsx");
        await writeFile(entry, `${await readFile(entry, "utf8")}\nconsole.log('candidate-${failedAction}');\n`);
        const failingDocker = await installFakeDocker(path.join(dir, "failure"), `container-new-${failedAction}`, { failOnceActions: [failedAction] });
        const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: failingDocker.env });
        assert.equal(failed.code, 1, `${failedAction}: ${failed.stderr}\n${failed.stdout}`);
        for (const [key, value] of Object.entries(statePaths)) {
          assert.equal(await readFile(value, "utf8"), before[key], `${failedAction} changed ${key}`);
        }
        assert.equal(await readFile(path.join(retainedRoot, "sitemap.xml"), "utf8"), "<first-release/>");
        const calls = await failingDocker.calls();
        if (failedAction === "rename") {
          assert.equal(calls.some((call) => call.args[0] === "rm"), false, "rename failure must not remove the old canonical Container");
        } else {
          assert.ok(calls.some((call) => call.args[0] === "rename" && call.args.at(-1) === `sporades-rollback-${failedAction}-island`));
          assert.ok(calls.some((call) => call.args[0] === "start" && call.args[1] === `sporades-rollback-${failedAction}-island`));
        }
      });
    });
  }
});


test("Container ownership preflight rejects configured SSH changes before access or audit mutation", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "ssh-ownership-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ssh-ownership-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    });
    await deployOwnedContainer(projectDir, dir, "ssh-owned-container");

    const buildDir = path.join(projectDir, ".sporades", "build");
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const consumerPath = path.join(buildDir, ".public-trees", ".consumers", "container.json");
    const authorizedKeysPath = path.join(projectDir, ".sporades", "ssh", "authorized_keys");
    const auditPath = path.join(projectDir, ".sporades", "data", "logs", "events.jsonl");
    const lockPath = path.join(projectDir, ".sporades", ".container-lifecycle-lock");
    const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
    consumer.token = "c".repeat(32);
    consumer.identity = "ssh-successor-container";
    await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh.authorizedKeys = [{ key: TEST_PUBLIC_KEY.replace("test@example", "changed@example") }];
    });

    const observedPaths = {
      authorizedKeys: authorizedKeysPath,
      audit: auditPath,
      binding: bindingPath,
      consumer: consumerPath,
      active: path.join(buildDir, ".public-trees", "active.json"),
      server: path.join(buildDir, "server.mjs"),
      client: path.join(buildDir, "client.js"),
    };
    const before = Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)])));
    const beforeFiles = await relativeFiles(buildDir);
    const docker = await installFakeDocker(path.join(dir, "replacement"), "ssh-candidate-container");

    const replacement = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(replacement.code, 1, `${replacement.stderr}\n${replacement.stdout}`);
    assert.equal(JSON.parse(replacement.stdout).error.message, "Container replacement ownership could not be verified.");
    assert.deepEqual(await docker.calls(), []);
    assert.deepEqual(
      Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)]))),
      before,
    );
    assert.deepEqual(await relativeFiles(buildDir), beforeFiles);
    await assert.rejects(stat(lockPath), (error) => error.code === "ENOENT");
  });
});


test("sporades deploy enables configured SSH access for local Container sessions", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "ssh-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const deployBody = JSON.parse(deployResult.stdout);
    assert.equal(deployBody.data.containerId, "container-ssh");
    assert.equal(Object.hasOwn(deployBody.data, "ssh"), false);

    const generatedKeysPath = path.join(projectDir, ".sporades", "ssh", "authorized_keys");
    assert.equal(await readFile(generatedKeysPath, "utf8"), `${TEST_PUBLIC_KEY}\n`);
    assert.equal((await stat(generatedKeysPath)).mode & 0o777, 0o644);

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], BASE_IMAGE_RUNTIME_USER);
    assertVolume(runCall.args, `${generatedKeysPath}:/run/sporades/ssh/authorized_keys:ro`);
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys"));

    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.3.0-node24-alpine");
    assert(imageIndex > -1);
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.3.0-node24-alpine",
      "/usr/local/bin/sporades-start",
    ]);
  });
});


test("bundled Container runtime supports email sign-in after sign-up and sign-out", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bundled-email-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "bundled-email-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = { providers: { anonymous: true, email: true } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-email-runtime");
    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);
      socket.send(JSON.stringify({ id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "mira@example.com", password: "correct horse battery staple", name: "Mira" } }));
      const signUp = await readSocketMessage(socket);
      assert.equal(signUp.type, "auth.signUp.result");
      socket.send(JSON.stringify({ id: "signout", type: "auth.signOut" }));
      const signOut = await readSocketMessage(socket);
      assert.equal(signOut.type, "auth.signOut.result");
      socket.send(JSON.stringify({ id: "signin", type: "auth.signIn", provider: "email", credentials: { email: "mira@example.com", password: "correct horse battery staple" } }));
      const signIn = await readSocketMessage(socket);
      assert.equal(signIn.type, "auth.signIn.result", JSON.stringify(signIn));
      assert.equal(signIn.error, null);
      assert.equal(signIn.data.auth.email, "mira@example.com");
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});


test("generated runtime does not serve fixed root client files outside the public tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "hosted-legacy-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "hosted-legacy-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-hosted-legacy");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const legacyRoot = path.join(dir, "legacy-hosted-mounts");
    await mkdir(legacyRoot);
    await writeFile(path.join(legacyRoot, "index.html"), "<html><body>legacy hosted html</body></html>");
    await writeFile(path.join(legacyRoot, "client.js"), "console.log('legacy hosted client');\n");
    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: legacyRoot,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(legacyRoot, "data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const root = await waitForHttp(`http://127.0.0.1:${port}/`, child, 404);
      assert.equal(root.status, 404);
      assert.equal(await root.text(), "Not found");
      const client = await waitForHttp(`http://127.0.0.1:${port}/client.js`, child, 404);
      assert.equal(client.status, 404);
      assert.equal(await client.text(), "Not found");
    } finally {
      await stopChild(child);
    }
  });
});


test("container server bundle reads injected service env and selects the libSQL adapter", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await installEnvProbeQuery(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakeCapsuleService(async ({ port: serviceReadyPort }) => {
      const docker = await installFakeDocker(dir, "container-with-libsql-bundle", {
        composePortOutput: `127.0.0.1:${serviceReadyPort}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr || deployResult.stdout);
    });

    await withFakeLibsqlService(path.join(dir, "container-libsql.db"), async ({ url, requests }) => {
      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
          SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
          SPORADES_SERVICE_DATABASE_URL: url,
          SPORADES_SERVICE_DATABASE_AUTH_TOKEN: "server-only-token",
          SPORADES_RUNTIME_PROBE_TOKEN: "a".repeat(64),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        const health = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
          headers: { "x-sporades-host-probe": "a".repeat(64) },
        });
        assert.equal(health.status, 200, await health.text());
        assert(
          requests.some((request) => request.requests?.some((entry) => entry.stmt?.sql === 'SELECT 1 AS "ok"')),
          JSON.stringify(requests),
        );
        const socket = await openSocket(`http://127.0.0.1:${port}`);
        try {
          socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "testEnvProbe" }));
          assert.deepEqual(await readSocketMessage(socket), {
            id: "env-1",
            type: "query.result",
            query: "testEnvProbe",
            data: [],
            error: null,
          });
          // The generated Container Bundle ships no runtime-owned env query (#289).
          socket.send(JSON.stringify({ id: "env-2", type: "query.subscribe", query: "ctx.env" }));
          const unknown = await readSocketMessage(socket);
          assertUnknownEnvQuery(unknown, "env-2");
          assert.doesNotMatch(JSON.stringify(unknown), /server-only-token|SPORADES_SERVICE_/);
        } finally {
          socket.close();
        }
      } finally {
        await stopChild(child);
      }
    });
  });
});


test("container server bundle uses injected MinIO storage env for file lifecycle routes", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "file-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { storage: { kind: "storage", engine: "minio" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await seedCapsuleServiceCredentials(projectDir);

    await withFakeS3CompatibleService(async ({ endpoint, port: serviceReadyPort, requests, objects }) => {
      const docker = await installFakeDocker(dir, "container-with-minio-bundle", {
        composePortOutput: `127.0.0.1:${serviceReadyPort}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr || deployResult.stdout);

      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-file-island-services");
      const storageEnv = dockerRunEnv(runCall, "SPORADES_SERVICE_STORAGE_");
      assert.deepEqual(storageEnv, {
        SPORADES_SERVICE_STORAGE_ENGINE: "minio",
        SPORADES_SERVICE_STORAGE_ENDPOINT: "http://sporades-file-island-storage:9000",
        SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
        SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
        SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
        SPORADES_SERVICE_STORAGE_REGION: "us-east-1",
        SPORADES_SERVICE_STORAGE_NAMESPACE: "file-island",
      });

      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const bridgeImport = await writeHttpHostBridge(dir, storageEnv.SPORADES_SERVICE_STORAGE_ENDPOINT, endpoint);
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithImport(bridgeImport),
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
          SPORADES_RUNTIME_PROBE_TOKEN: "a".repeat(64),
          ...storageEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let socket;
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitForHttp(`${baseUrl}/`, child);
        const health = await fetch(`${baseUrl}/__sporades/health/runtime`, {
          headers: { "x-sporades-host-probe": "a".repeat(64) },
        });
        assert.equal(health.status, 200, await health.text());

        socket = await openSocket(baseUrl);
        async function sendAndWait(payload) {
          socket.send(JSON.stringify(payload));
          return await waitForSocketMessage(socket, (message) => message.id === payload.id);
        }

        const auth = await sendAndWait({ id: "auth", type: "auth.get" });
        const uploadUrl = await sendAndWait({
          id: "upload-url",
          type: "file.uploadUrl",
          file: { name: "proof.txt", type: "text/plain", size: 9, path: "/proof/container/minio.txt" },
        });
        assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, baseUrl), {
          method: uploadUrl.data.method,
          body: "minio-one",
        });
        if (uploadResponse.status !== 200) {
          assert.fail(await uploadResponse.text());
        }
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true, uploaded.error?.message);
        assert.equal(uploaded.data.file.path, "/proof/container/minio.txt");
        const firstObjectKey = `capsules/file-island/files/${uploaded.data.file.id}/${uploaded.data.file.version}`;
        assert.equal(objects.get(firstObjectKey).toString("utf8"), "minio-one");

        const privateUrl = await sendAndWait({
          id: "private-url",
          type: "file.url",
          fileReference: "/proof/container/minio.txt",
        });
        assert.equal(privateUrl.error, null);
        const privateRead = await fetch(new URL(privateUrl.data.url, baseUrl), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(await privateRead.text(), "minio-one");

        const publicUrl = await sendAndWait({
          id: "public-url",
          type: "file.publicUrl.create",
          fileId: uploaded.data.file.id,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, baseUrl));
        assert.equal(publicRead.status, 200);
        assert.equal(await publicRead.text(), "minio-one");

        const replaceUrl = await sendAndWait({
          id: "replace-url",
          type: "file.uploadUrl",
          replace: true,
          fileReference: "/proof/container/minio.txt",
          file: { name: "proof-v2.txt", type: "text/plain", size: 9 },
        });
        assert.equal(replaceUrl.error, null, replaceUrl.error?.message);
        const replaceResponse = await fetch(new URL(replaceUrl.data.uploadUrl, baseUrl), {
          method: replaceUrl.data.method,
          body: "minio-two",
        });
        if (replaceResponse.status !== 200) {
          assert.fail(await replaceResponse.text());
        }
        const replaced = await replaceResponse.json();
        assert.equal(replaced.data.file.id, uploaded.data.file.id);
        assert.notEqual(replaced.data.file.version, uploaded.data.file.version);
        assert.equal(objects.has(firstObjectKey), false);
        const replacementObjectKey = `capsules/file-island/files/${replaced.data.file.id}/${replaced.data.file.version}`;
        assert.equal(objects.get(replacementObjectKey).toString("utf8"), "minio-two");

        const stalePrivateRead = await fetch(new URL(privateUrl.data.url, baseUrl), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(stalePrivateRead.status, 404);
        const stalePublicRead = await fetch(new URL(publicUrl.data.publicUrl.url, baseUrl));
        assert.equal(stalePublicRead.status, 404);

        const deleteResult = await sendAndWait({
          id: "delete",
          type: "file.delete",
          fileReference: "/proof/container/minio.txt",
        });
        assert.equal(deleteResult.error, null);
        assert.equal(objects.has(replacementObjectKey), false);
        const missingAfterDelete = await fetch(new URL(`/__sporades/files/public/${publicUrl.data.publicUrl.id}?v=${replaced.data.file.version}`, baseUrl));
        assert.equal(missingAfterDelete.status, 404);

        const firstWriteRequest = requests.find((request) => request.method === "PUT" && request.url === `/sporades-files/${firstObjectKey}`);
        assert(firstWriteRequest, JSON.stringify(requests.map((request) => [request.method, request.url])));
        assert.equal(firstWriteRequest.headers.host, "sporades-file-island-storage:9000");
        const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});


test("sporades logs and db can inspect a local Container session by published port", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(dataDir, { recursive: true });
    const docker = await installFakeDocker(dir, "container-first", { dataDir });

    const deployResult = await runCli(["deploy", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const serverPort = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(serverPort),
        SPORADES_DATABASE_PATH: path.join(dataDir, "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${serverPort}/`, child);
    } finally {
      await stopChild(child);
    }

    const logsResult = await runCli(["logs", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(logsResult.code, 0, logsResult.stderr);
    assert.deepEqual(JSON.parse(logsResult.stdout).data, {
      source: "docker",
      containerId: "container-first",
      entries: [
        {
          schema: "sporades.log.v1",
          timestamp: "2026-07-04T06:32:08.180Z",
          category: "platform",
          event: "runtime.started",
          level: "info",
          message: "Capsule runtime started",
          capsule: { name: "todo-island", id: "todo-island" },
          release: null,
          request: null,
          correlation: null,
          data: null,
          truncated: false,
        },
      ],
    });

    const dbResult = await runCli(["db", "list", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(dbResult.code, 0, dbResult.stderr || dbResult.stdout);
    assert.deepEqual(JSON.parse(dbResult.stdout).data, {
      source: "sqlite-file",
      tables: [
        "sporades",
        "sporades_auth_access_key_locks",
        "sporades_auth_access_key_owners",
        "sporades_auth_access_keys",
        "sporades_auth_email_credentials",
        "sporades_auth_identities",
        "sporades_auth_oauth_states",
        "sporades_auth_password_reset_codes",
        "sporades_auth_reauthentication_proofs",
        "sporades_auth_reauthentication_throttle",
        "sporades_auth_reauthentication_throttle_fence",
        "sporades_auth_service_user_locks",
        "sporades_auth_sessions",
        "sporades_auth_users",
        "sporades_file_buckets",
        "sporades_file_ingress",
        "sporades_file_ingress_audit_outbox",
        "sporades_file_public_urls",
        "sporades_file_uploads",
        "sporades_files",
        "sporades_jobs",
        "sporades_schedule_legacy_adoption",
        "sporades_team_bootstrap",
        "sporades_team_join_link_counters",
        "sporades_team_join_link_redemptions",
        "sporades_team_join_link_secrets",
        "sporades_team_join_link_throttles",
        "sporades_team_join_links",
        "sporades_team_membership_application_roles",
        "sporades_team_membership_counters",
        "sporades_team_memberships",
        "sporades_teams",
        "sporades_user_preferences",
        "todos",
      ],
    });
  });
});


test("generated server bundle emits JSON logs to stdout when requested", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
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
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "stdout-data.db"),
        SPORADES_LOG_STDOUT: "1",
        SPORADES_RELEASE_ID: "20260630T221500Z-feedface",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const event = await waitForJsonStdoutLine(child);
      assert.equal(event.schema, "sporades.log.v1");
      assert.equal(event.category, "platform");
      assert.equal(event.event, "runtime.started");
      assert.equal(event.level, "info");
      assert.equal(event.message, "Capsule runtime started");
      assert.deepEqual(event.data.diagnostics.journey, { sessionInactivityMinutes: 30 });
      assert.equal(event.capsule.name, "todo-island");
      assert.deepEqual(event.release, { id: "20260630T221500Z-feedface" });
    } finally {
      await stopChild(child);
    }
  });
});


test("sporades deploy accepts object-shaped Base image update policy config", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.baseImage = { updatePolicy: { mode: "manual" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-manual-policy");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const runCall = firstDockerRunCall(await docker.calls());
    assert(runCall.args.includes("com.sporades.base-image.update-policy=manual"));
  });
});


test("sporades deploy writes a server bundle that applies additive table migrations on Container session startup", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const databasePath = path.join(projectDir, ".sporades", "data", "data.db");
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const firstPort = await getAvailablePort();
    const firstServer = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(firstPort),
        SPORADES_DATABASE_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let firstSocket;
    let secondSocket;
    try {
      await waitForHttp(`http://127.0.0.1:${firstPort}/`, firstServer);
      firstSocket = await openSocket(`http://127.0.0.1:${firstPort}`);
      firstSocket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(firstSocket)).data.sessionToken;
      firstSocket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(firstSocket)).data, []);
      const addTodoResultPromise = waitForSocketMessage(
        firstSocket,
        (message) => message.id === "add-todo" && message.type === "mutation.result",
      );
      const todosAfterPromise = waitForSocketMessage(
        firstSocket,
        (message) =>
          message.id === "todos-before" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Container keeps me"),
      );
      firstSocket.send(
        JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Container keeps me"] }),
      );
      assert.equal((await addTodoResultPromise).error, null);
      assert.deepEqual(
        (await todosAfterPromise).data.map((todo) => todo.text),
        ["Container keeps me"],
      );
      firstSocket.close();
      firstSocket = null;
      await stopChild(firstServer);

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace(
            "todos: table({",
            `notes: table({
      text: String(),
      ownerId: String(),
    }),
    todos: table({`,
          )
          .replace(
            "todos: query((ctx) =>",
            `notes: query((ctx) =>
      ctx.db.notes
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),

    todos: query((ctx) =>`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `addNote: mutation((ctx, text: string) => {
      ctx.db.notes.insert({ text, ownerId: ctx.auth.userId });
    }),

    addTodo: mutation((ctx, text: string) => {`,
          ),
      );

      const redeployResult = await runCli(["deploy", "--force", "--json"], {
        cwd: projectDir,
        env: {
          ...docker.env,
          FAKE_DOCKER_CONTAINER_ID: "container-second",
          FAKE_DOCKER_MISSING_INSPECT_IDS: "container-first",
        },
      });
      assert.equal(redeployResult.code, 0, redeployResult.stderr);

      const secondPort = await getAvailablePort();
      const secondServer = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(secondPort),
          SPORADES_DATABASE_PATH: databasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForHttp(`http://127.0.0.1:${secondPort}/`, secondServer);
        secondSocket = await openSocket(`http://127.0.0.1:${secondPort}`, sessionToken);
        secondSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
        assert.deepEqual(
          (await readSocketMessage(secondSocket)).data.map((todo) => todo.text),
          ["Container keeps me"],
        );
        secondSocket.send(JSON.stringify({ id: "notes-before", type: "query.subscribe", query: "notes" }));
        assert.deepEqual((await readSocketMessage(secondSocket)).data, []);
        const notesAfterPromise = waitForSocketMessage(
          secondSocket,
          (message) =>
            message.id === "notes-before" &&
            message.type === "query.result" &&
            message.query === "notes" &&
            message.data.length === 1,
        );
        const addNoteResultPromise = waitForSocketMessage(
          secondSocket,
          (message) => message.id === "add-note" && message.type === "mutation.result",
        );
        secondSocket.send(
          JSON.stringify({
            id: "add-note",
            type: "mutation.run",
            mutation: "addNote",
            args: ["Container new table works"],
          }),
        );
        assert.equal((await addNoteResultPromise).error, null);
        const notesAfter = await notesAfterPromise;
        assert.equal(notesAfter.data[0].text, "Container new table works");
      } finally {
        secondSocket?.close();
        await stopChild(secondServer);
      }
    } finally {
      firstSocket?.close();
      await stopChild(firstServer);
    }
  });
});


test("sporades deploy endpoints resolve linked Google auth from the Sporades session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: ctx.auth,
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    const docker = await installFakeDocker(dir, "container-google-auth");

    await withFakeGoogleServer(async (google) => {
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
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_JWKS_URL: google.jwksUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;

        socket.send(JSON.stringify({ id: "signin", type: "auth.signIn", provider: "google", returnTo: `http://127.0.0.1:${port}/integrations/auth` }));
        const signIn = await readSocketMessage(socket);
        const signInUrl = new URL(signIn.data.url);
        google.setNonce(signInUrl.searchParams.get("nonce"));
        const callbackResponse = await fetch(
          `http://127.0.0.1:${port}/__sporades/auth/google/callback?code=container-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302, await callbackResponse.text());

        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
        const linkedAuth = await readSocketMessage(socket);
        assert.deepEqual(linkedAuth.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });

        const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/auth`, {
          headers: { "x-sporades-session-token": anonymousAuth.data.sessionToken },
        });
        const endpointBody = await endpointResponse.json();
        assert.equal(endpointResponse.status, 200, JSON.stringify(endpointBody));
        assert.deepEqual(endpointBody, linkedAuth.data.auth);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});


test("sporades deploy Bundle completes Microsoft OIDC and exposes normal ctx.auth without a client SDK", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "microsoft-endpoint", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "microsoft-endpoint"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "microsoft-endpoint",
  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: ctx.auth,
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const configured = await runCli(
      ["auth", "set", "microsoft", "--client-id", "microsoft-client-id", "--client-secret", "microsoft-secret", "--tenant", "common", "--json"],
      { cwd: projectDir },
    );
    assert.equal(configured.code, 0, configured.stderr);
    const docker = await installFakeDocker(dir, "container-microsoft-auth");

    await withFakeMicrosoftServer(async (microsoft) => {
      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr);
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.doesNotMatch(clientBundle, /@azure\/msal|microsoft-authentication-library|client_secret|microsoft-secret/i);

      const port = await getAvailablePort();
      const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
          SPORADES_MICROSOFT_DISCOVERY_URL: microsoft.discoveryUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const before = await readSocketMessage(socket);
        const userId = before.data.auth.userId;

        socket.send(JSON.stringify({
          id: "signin",
          type: "auth.signIn",
          provider: "microsoft",
          returnTo: `http://127.0.0.1:${port}/integrations/auth`,
        }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        const providerResponse = await fetch(signIn.data.url, { redirect: "manual" });
        const callbackResponse = await fetch(providerResponse.headers.get("location"), { redirect: "manual" });
        assert.equal(callbackResponse.status, 302, await callbackResponse.text());

        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.deepEqual(linked.data.auth, {
          userId,
          displayName: "Container Microsoft",
          email: null,
          picture: null,
          isAuthenticated: true,
          isGuest: false,
          provider: "microsoft",
        });

        const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/auth`, {
          headers: { "x-sporades-session-token": before.data.sessionToken },
        });
        assert.equal(endpointResponse.status, 200);
        assert.deepEqual(await endpointResponse.json(), linked.data.auth);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});


test("sporades deploy skips the server env mount when the env file is absent", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"));
    const docker = await installFakeDocker(dir, "container-no-env");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args.includes("--env-file"), false);
    assert.equal(
      runCall.args.includes(`${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`),
      false,
    );
  });
});


test("sporades deploy starts declared services before replacing the local Container session", async () => {
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
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-replacement", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.equal(output.data.containerId, "container-replacement");
      assert.deepEqual(output.data.services, {
        database: {
          status: "ready",
          engine: "libsql",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-database",
          statePath: path.join(".sporades", "services", "database"),
        },
      });
      assert.doesNotMatch(deployResult.stdout, /sporades-todo-island-database:8080/);

      const calls = await docker.calls();
      const composeUpIndex = calls.findIndex((call) => call.args[0] === "compose" && call.args.includes("up"));
      const stopIndex = calls.findIndex((call) => call.args[0] === "stop");
      const runIndex = calls.findIndex((call) => call.args[0] === "run");
      assert(composeUpIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(stopIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(runIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(composeUpIndex < stopIndex);
      assert(stopIndex < runIndex);
    });
  });
});


test("sporades deploy wires Postgres Capsule database services through Compose", async () => {
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
        engine: "postgres",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakePostgresService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-postgres-service", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.equal(output.data.services.database.engine, "postgres");

      const credentials = await readCapsuleServiceCredentials(projectDir);
      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /image: postgres:16-alpine/);
      assert.match(compose, /POSTGRES_USER: "sporades"/);
      assert.match(compose, /POSTGRES_DB: "sporades"/);
      assert(compose.includes(`POSTGRES_PASSWORD: ${JSON.stringify(credentials.databasePassword)}`), compose);
      assert.doesNotMatch(compose, /POSTGRES_HOST_AUTH_METHOD/);
      assert.doesNotMatch(compose, /ports:/);
      assert.doesNotMatch(compose, /127\.0\.0\.1::5432/);
      assert.match(compose, /healthcheck:/);
      assert.match(compose, /pg_isready/);
      assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/postgresql\/data:rw"/);
      assert.match(compose, /com\.sporades\.capsule-service\.engine: "postgres"/);

      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=postgres"), runCall.args.join(" "));
      assert(
        runCall.args.includes(
          `SPORADES_SERVICE_DATABASE_URL=postgres://sporades:${encodeURIComponent(credentials.databasePassword)}@sporades-todo-island-database:5432/sporades`,
        ),
        runCall.args.join(" "),
      );
    });
  });
});


test("sporades deploy reports Capsule service startup failures without leaking secrets", async () => {
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
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-never-started", { composeUpStatus: 42 });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const output = JSON.parse(deployResult.stdout);
    assert.deepEqual(output, {
      ok: false,
      data: null,
      error: {
        message: "Failed to start Capsule services.",
        hint: "Check Docker is running and supports `docker compose`, then retry the command.",
        diagnostics: {
          services: {
            database: {
              status: "failed",
              engine: "libsql",
              network: "sporades-todo-island-services",
              containerName: "sporades-todo-island-database",
              statePath: path.join(".sporades", "services", "database"),
            },
          },
        },
      },
    });
    assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});


test("sporades deploy reports structured errors for unsupported Capsule service declarations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      cache: {
        kind: "redis",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid services.cache.kind.",
        hint: "Set kind to container.",
      },
    });
  });
});


test("sporades deploy status reports declared Capsule services and generated state as JSON", async () => {
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
    await mkdir(path.join(projectDir, ".sporades", "services", "database"), { recursive: true });
    await mkdir(path.join(projectDir, ".sporades", "services", "storage"), { recursive: true });
    const docker = await installFakeDocker(dir, "container-status", {
      composePsOutput: JSON.stringify({ State: "running", Health: "healthy" }),
    });

    const status = await runCli(["deploy", "status", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      ok: true,
      data: {
        services: {
          database: {
            declared: true,
            engine: "libsql",
            status: "running",
            health: "healthy",
            network: {
              name: "sporades-todo-island-services",
              exists: true,
            },
            volume: {
              type: "bind",
              path: path.join(".sporades", "services", "database"),
              exists: true,
            },
            containerName: "sporades-todo-island-database",
            composeFile: path.join(".sporades", "compose", "capsule-services.compose.yml"),
            diagnostics: [],
          },
          storage: {
            declared: true,
            engine: "minio",
            status: "running",
            health: "healthy",
            network: {
              name: "sporades-todo-island-services",
              exists: true,
            },
            volume: {
              type: "bind",
              path: path.join(".sporades", "services", "storage"),
              exists: true,
            },
            containerName: "sporades-todo-island-storage",
            composeFile: path.join(".sporades", "compose", "capsule-services.compose.yml"),
            diagnostics: [],
          },
        },
      },
      error: null,
    });
  });
});


test("sporades dev stop stops Capsule services without deleting persisted service data", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const stateDir = path.join(projectDir, ".sporades", "services", "database");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "kept.txt"), "still here\n");
    const docker = await installFakeDocker(dir);

    const stop = await runCli(["dev", "stop", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(await readFile(path.join(stateDir, "kept.txt"), "utf8"), "still here\n");
    assert.deepEqual(JSON.parse(stop.stdout).data.services.database.status, "stopped");
    const calls = await docker.calls();
    const downCall = calls.find((call) => call.args[0] === "compose" && call.args.includes("down"));
    assert.deepEqual(downCall.args.slice(0, 4), ["compose", "-p", "sporades-todo-island-services", "-f"]);
    assert.deepEqual(downCall.args.slice(5), ["down", "--remove-orphans"]);
  });
});


test("sporades deploy stop stops the bound local Container session without deleting the binding", async () => {
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

    const stop = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: true,
      data: {
        container: { status: "stopped", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["stop", "container-bound"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")), binding);
  });
});


test("sporades deploy remove force-removes the bound local Container session and deletes the binding", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-bound", containerName: "sporades-todo-island" };
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir);

    const remove = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout), {
      ok: true,
      data: {
        container: { status: "removed", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["rm", "-f", "container-bound"]]);
    await assert.rejects(readFile(bindingPath, "utf8"), { code: "ENOENT" });
  });
});


test("sporades deploy remove clears a stale binding when the bound container is already gone", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-deleted", containerName: "sporades-todo-island" };
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-new", {
      missingContainerActions: ["rm"],
    });

    const remove = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout), {
      ok: true,
      data: {
        container: { status: "removed", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["rm", "-f", "container-deleted"]]);
    await assert.rejects(readFile(bindingPath, "utf8"), { code: "ENOENT" });
  });
});


test("stale and tokenless remove callers cannot delete a successor consumer, Container, or binding", async (t) => {
  for (const mode of ["stale", "tokenless"]) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `consumer-${mode}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `consumer-${mode}-island`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-${mode}`);
        assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
        const bindingPath = path.join(projectDir, ".sporades", "binding.json");
        const consumerPath = path.join(projectDir, ".sporades", "build", ".public-trees", ".consumers", "container.json");
        const binding = JSON.parse(await readFile(bindingPath, "utf8"));
        const successor = { ...JSON.parse(await readFile(consumerPath, "utf8")), token: "f".repeat(32), identity: "successor-container" };
        await writeFile(consumerPath, `${JSON.stringify(successor)}\n`);
        if (mode === "tokenless") {
          delete binding.clientRelease.consumerToken;
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        }
        const beforeBinding = await readFile(bindingPath, "utf8");
        const beforeConsumer = await readFile(consumerPath, "utf8");
        const docker = await installFakeDocker(path.join(dir, "remove"), `container-${mode}`);
        const removed = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });
        assert.equal(removed.code, 1);
        assert.equal((await docker.calls()).some((call) => call.args[0] === "rm"), false);
        assert.equal(await readFile(bindingPath, "utf8"), beforeBinding);
        assert.equal(await readFile(consumerPath, "utf8"), beforeConsumer);
      });
    });
  }
});


test("sporades deploy replaces the existing container binding before starting a new one", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const docker = await installFakeDocker(dir, "container-replacement");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-replacement");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["image", "inspect", "rename", "stop", "run", "inspect", "rm"]);
    assert.equal(calls[2].args[1], "container-old");
    assert.match(calls[2].args[2], /^sporades-todo-island-rollback-/);
    assert.equal(calls[3].args[1], calls[2].args[2]);
    assert.equal(calls[6].args[1], calls[2].args[2]);
    assert.equal(firstDockerRunCall(calls).args[0], "run");

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.containerId, "container-replacement");
    assert.equal(binding.containerName, "sporades-todo-island");
    assert.equal(binding.clientRelease.htmlEntry, "index.html");
  });
});


test("local Container deploy.files snapshots replacements and retains editable files", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "file-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "file-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy.files = [{ path: "settings.json", update: "preserve" }, { path: "defaults.json" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "seed");
    await writeFile(path.join(projectDir, "defaults.json"), "original");
    const docker = await installFakeDocker(dir, "container-files");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
    const calls = await docker.calls();
    const run = calls.find((call) => call.args[0] === "run");
    const replacement = run.args.find((arg) => arg.endsWith(":/app/defaults.json:ro")).slice(0, -":/app/defaults.json:ro".length);
    await writeFile(path.join(projectDir, "defaults.json"), "new local bytes");
    assert.equal(await readFile(replacement, "utf8"), "original");
    const preserved = preservedDeployFilePath(path.join(projectDir, ".sporades/preserved-files"), "settings.json");
    assert(run.args.includes(`${preserved}:/app/settings.json:rw`));
    await writeFile(preserved, "server edit");
    const preload = path.join(dir, "fail-snapshot.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.writeFile; let writes = 0;
fs.promises.writeFile = async function(file, ...args) {
  if (String(file).includes('/.sporades/deploy-files/') && ++writes === 2) throw Object.assign(new Error('injected snapshot quota failure'), { code: 'ENOSPC' });
  return original.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const snapshots = path.join(projectDir, ".sporades/deploy-files");
    assert.equal((await stat(snapshots)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(preserved))).mode & 0o777, 0o700);
    const before = (await readdir(snapshots)).sort();
    const snapshotFailure = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}` } });
    assert.notEqual(snapshotFailure.code, 0, snapshotFailure.stdout);
    assert.match(snapshotFailure.stdout + snapshotFailure.stderr, /injected snapshot quota failure/);
    assert.deepEqual((await readdir(snapshots)).sort(), before);
    await rm(path.join(projectDir, "settings.json"));
    const countBefore = (await docker.calls()).filter((call) => ["stop", "rm", "run"].includes(call.args[0])).length;
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stdout + failed.stderr, /settings.json/);
    assert.equal((await docker.calls()).filter((call) => ["stop", "rm", "run"].includes(call.args[0])).length, countBefore);
    assert.equal(await readFile(preserved, "utf8"), "server edit");
    await writeFile(path.join(projectDir, "settings.json"), "new seed");
    config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    await writeFile(configPath, JSON.stringify(config));
    // Preserved copies stay owner-only like `.sporades/data`: SSH toggles never
    // change ownership, never spawn a privileged Docker helper, and a loosened
    // mode is tightened back to 0600 before the Container starts.
    const ownerOnly = async () => {
      const info = await stat(preserved);
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.uid, process.getuid());
      assert.equal((await docker.calls()).filter((call) => call.args[0] === "run" && call.args.some((arg) => arg.endsWith(":/file:rw"))).length, 0, "no privileged file helper may run");
    };
    await chmod(preserved, 0o664);
    const deniedDeploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT: "consumer" } });
    assert.notEqual(deniedDeploy.code, 0);
    await ownerOnly();
    const sshDeploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(sshDeploy.code, 0, sshDeploy.stdout + sshDeploy.stderr);
    assert((await docker.calls()).filter((call) => call.args[0] === "run").at(-1).args.includes("10001:10001"), "SSH Container runs as the base image user");
    await ownerOnly();
    assert.equal(await readFile(preserved, "utf8"), "server edit");
    delete config.ssh;
    await writeFile(configPath, JSON.stringify(config));
    await chmod(preserved, 0o660);
    const ordinaryDeploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(ordinaryDeploy.code, 0, ordinaryDeploy.stdout + ordinaryDeploy.stderr);
    await ownerOnly();
    for (const policy of ["replace", "remove"]) {
      config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
      config.deploy.files = [{ path: "settings.json", update: "preserve" }, { path: "defaults.json" }];
      await writeFile(configPath, JSON.stringify(config));
      const enabled = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      assert.equal(enabled.code, 0, enabled.stdout + enabled.stderr);
      config.deploy.files = policy === "replace" ? [{ path: "settings.json" }, { path: "defaults.json" }] : [{ path: "defaults.json" }];
      if (policy === "remove") delete config.ssh;
      await writeFile(configPath, JSON.stringify(config));
      const inactive = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      assert.equal(inactive.code, 0, inactive.stdout + inactive.stderr);
      await ownerOnly();
      assert.equal(await readFile(preserved, "utf8"), "server edit");
    }
    let binding = JSON.parse(await readFile(path.join(projectDir, ".sporades/binding.json"), "utf8"));
    assert.equal(await readFile(path.join(binding.deployFilesRoot, "defaults.json"), "utf8"), "new local bytes");
    config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    config.deploy.files = [{ path: "settings.json", update: "preserve" }, { path: "defaults.json" }];
    await writeFile(configPath, JSON.stringify(config));
    const finalDeploy = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(finalDeploy.code, 0, finalDeploy.stdout + finalDeploy.stderr);
    binding = JSON.parse(await readFile(path.join(projectDir, ".sporades/binding.json"), "utf8"));
    const failRemoval = path.join(dir, "fail-snapshot-removal.mjs");
    await writeFile(failRemoval, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.rm;
fs.promises.rm = async function(file, ...args) {
  if (String(file).includes('/.sporades/deploy-files/')) throw Object.assign(new Error('injected snapshot removal denial'), { code: 'EACCES' });
  return original.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const priorSnapshot = binding.deployFilesRoot;
    const cleanupFailure = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${failRemoval}` } });
    assert.notEqual(cleanupFailure.code, 0);
    assert.match(cleanupFailure.stdout + cleanupFailure.stderr, /injected snapshot removal denial/);
    binding = JSON.parse(await readFile(path.join(projectDir, ".sporades/binding.json"), "utf8"));
    assert(binding.pendingDeployFileCleanup.includes(priorSnapshot));
    assert.notEqual(binding.deployFilesRoot, priorSnapshot);
    const removalFailure = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${failRemoval}` } });
    assert.notEqual(removalFailure.code, 0);
    assert.match(removalFailure.stdout + removalFailure.stderr, /injected snapshot removal denial/);
    const removed = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    await ownerOnly();
    await assert.rejects(stat(binding.deployFilesRoot), { code: "ENOENT" });
    await assert.rejects(stat(priorSnapshot), { code: "ENOENT" });
    assert.equal(await readFile(preserved, "utf8"), "server edit");
  });
});



test("local deploy.files cleans failed seeds despite unrelated rollback errors and retains live candidate files", async () => {
  for (const retained of [false, true]) await withTempDir(async (dir) => {
    const created = await runCli(["create", "seed-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "seed-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy.files = [{ path: "settings.json", update: "preserve" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "failed seed");
    const docker = await installFakeDocker(dir, "seed-candidate", retained ? { failOnceActions: ["rm"] } : {});
    const preload = path.join(dir, "fail-public-cleanup.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.rm;
fs.promises.rm = async function(file, ...args) {
  if (String(file).includes('/.public-trees/') && /\\/[0-9]+-[0-9]+-[a-f0-9]+$/.test(String(file))) throw Object.assign(new Error('injected public cleanup denial'), { code: 'EACCES' });
  return original.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: {
      ...docker.env, SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT: "consumer",
      ...(retained ? {} : { NODE_OPTIONS: `--import=${preload}` }),
    } });
    assert.notEqual(failed.code, 0, failed.stdout);
    const details = JSON.parse(failed.stdout).error.diagnostics;
    assert(details?.failures.includes(retained ? "candidate-container" : "candidate-public-tree"), failed.stdout);
    const stored = preservedDeployFilePath(path.join(projectDir, ".sporades/preserved-files"), "settings.json");
    const snapshots = path.join(projectDir, ".sporades/deploy-files");
    if (retained) {
      assert.equal(await readFile(stored, "utf8"), "failed seed");
      assert.equal((await readdir(snapshots)).length, 1);
    } else {
      await assert.rejects(stat(stored), { code: "ENOENT" });
      assert.deepEqual(await readdir(snapshots), []);
      await writeFile(path.join(projectDir, "settings.json"), "successful seed");
      const retry = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      assert.equal(retry.code, 0, retry.stdout + retry.stderr);
      assert.equal(await readFile(stored, "utf8"), "successful seed");
    }
  });
});


test("local deploy.files journals replacement-only snapshots across process exit and cleanup failure", async () => {
  for (const failure of ["exit", "cleanup"]) await withTempDir(async (dir) => {
    const created = await runCli(["create", "snapshot-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "snapshot-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.deploy.files = [{ path: "settings.json" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "snapshot bytes");
    const docker = await installFakeDocker(dir, "snapshot-candidate");
    const preload = path.join(dir, "exit-snapshot.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.writeFile;
fs.promises.writeFile = async function(file, ...args) {
  const result = await original.call(this, file, ...args);
  if (String(file).includes('/.sporades/deploy-files/')) ${failure === "exit" ? "process.exit(17)" : "throw Object.assign(new Error('injected snapshot write failure'), { code: 'ENOSPC' })"};
  return result;
};
const remove = fs.promises.rm;
fs.promises.rm = async function(file, ...args) {
  if (${failure === "cleanup"} && String(file).includes('/.sporades/deploy-files/')) throw Object.assign(new Error('injected snapshot cleanup failure'), { code: 'EACCES' });
  return remove.call(this, file, ...args);
}; syncBuiltinESMExports();`);
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}` } });
    if (failure === "exit") assert.equal(failed.code, 17);
    else assert.notEqual(failed.code, 0);
    const journal = path.join(projectDir, ".sporades/deploy-file-attempt.jsonl");
    const record = JSON.parse((await readFile(journal, "utf8")).trim());
    assert.equal(await readFile(path.join(record.release, "settings.json"), "utf8"), "snapshot bytes");
    const before = await readdir(path.join(projectDir, ".sporades/deploy-files"));
    const retry = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.notEqual(retry.code, 0);
    assert.match(retry.stdout + retry.stderr, /requires recovery/);
    assert.deepEqual(await readdir(path.join(projectDir, ".sporades/deploy-files")), before);
  });
});


test("local deploy.files switches historical ancestor and descendant paths without losing edits", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "shape-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "shape-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const docker = await installFakeDocker(dir, "shape-candidate");
    const root = path.join(projectDir, ".sporades/preserved-files");
    for (const [index, relative] of ["config", "config/settings.json", "config"].entries()) {
      await rm(path.join(projectDir, "config"), { force: true, recursive: true });
      await mkdir(path.dirname(path.join(projectDir, relative)), { recursive: true });
      await writeFile(path.join(projectDir, relative), `seed-${index}`);
      config.deploy.files = [{ path: relative, update: "preserve" }];
      await writeFile(configPath, JSON.stringify(config));
      const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
      const stored = preservedDeployFilePath(root, relative);
      const run = (await docker.calls()).filter((call) => call.args[0] === "run" && call.args.includes("--detach")).at(-1);
      assert(run.args.includes(`${stored}:/app/${relative}:rw`));
      if (index < 2) await writeFile(stored, `edit-${index}`);
    }
    assert.equal(await readFile(preservedDeployFilePath(root, "config"), "utf8"), "edit-0");
    assert.equal(await readFile(preservedDeployFilePath(root, "config/settings.json"), "utf8"), "edit-1");
  });
});


test("local deploy.files restart repairs atomic-save access and rejects unsafe or pending storage", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "restart-files", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "restart-files"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    config.deploy.files = [{ path: "settings.json", update: "preserve" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "seed");
    const docker = await installFakeDocker(dir, "restart-files-candidate");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
    const stopped = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    const stored = preservedDeployFilePath(path.join(projectDir, ".sporades/preserved-files"), "settings.json");
    await writeFile(path.join(projectDir, "replacement"), "atomic edit", { mode: 0o664 });
    await rename(path.join(projectDir, "replacement"), stored);
    const before = (await docker.calls()).length;
    const restarted = await runCli(["deploy", "restart", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(restarted.code, 0, restarted.stdout + restarted.stderr);
    const calls = (await docker.calls()).slice(before);
    assert.deepEqual(calls.map((call) => call.args[0]).filter((action) => action === "run"), [], "restart never spawns a file access helper");
    assert((await stat(stored)).mode & 0o777, 0o600);
    assert.equal((await stat(stored)).uid, process.getuid());
    assert.equal(await readFile(stored, "utf8"), "atomic edit");
    await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });
    for (const failure of ["missing", "symlink", "journal"]) {
      await rm(stored, { force: true });
      if (failure === "symlink") await symlink(path.join(projectDir, "settings.json"), stored);
      if (failure === "journal") {
        await writeFile(stored, "uncommitted seed");
        await writeFile(path.join(projectDir, ".sporades/deploy-file-attempt.jsonl"), "pending");
      }
      const count = (await docker.calls()).length;
      const failed = await runCli(["deploy", "restart", "--json"], { cwd: projectDir, env: docker.env });
      assert.notEqual(failed.code, 0, failed.stdout);
      assert.equal((await docker.calls()).length, count);
    }
  });
});


test("local deploy.files rollback prepares raced replacement storage before restoring the previous runtime", async () => {
  for (const repairFails of [false, true]) await withTempDir(async (dir) => {
    const created = await runCli(["create", "rollback-save", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "rollback-save"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    config.deploy.files = [{ path: "settings.json", update: "preserve" }];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(projectDir, "settings.json"), "seed");
    const docker = await installFakeDocker(dir, "rollback-save-candidate");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stdout + deployed.stderr);
    delete config.ssh;
    await writeFile(configPath, JSON.stringify(config));
    const stored = preservedDeployFilePath(path.join(projectDir, ".sporades/preserved-files"), "settings.json");
    const preload = path.join(dir, "save-during-candidate.mjs");
    await writeFile(preload, `import fs from 'node:fs'; import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(stored)}; let replaced = false;
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  const result = spawn.call(this, command, args, ...rest);
  if (command === 'docker' && args[0] === 'run' && args.includes('--detach') && result.status === 0) {
    fs.writeFileSync(target + '.edit', 'concurrent save', { mode: 0o664 }); fs.renameSync(target + '.edit', target); replaced = true;
  }
  return result;
};
const open = fs.promises.open;
fs.promises.open = async function(file, ...rest) {
  const handle = await open.call(this, file, ...rest);
  if (${repairFails} && replaced && String(file) === target) {
    handle.chmod = async () => { throw Object.assign(new Error('injected repair failure'), { code: 'EACCES' }); };
  }
  return handle;
}; syncBuiltinESMExports();`);
    const before = (await docker.calls()).length;
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: { ...docker.env, NODE_OPTIONS: `--import=${preload}`, SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT: "consumer" } });
    assert.notEqual(failed.code, 0);
    const calls = (await docker.calls()).slice(before);
    const start = calls.findIndex((call) => call.args[0] === "start");
    const info = await stat(stored);
    if (repairFails) {
      assert.equal(start, -1, "the previous runtime must not start with unprepared preserved storage");
      assert.match(failed.stdout, /preserved-files/);
      assert.notEqual(info.mode & 0o777, 0o600, "the failed repair leaves the editor's mode untouched");
    } else {
      assert(start >= 0, JSON.stringify(calls));
      assert.equal(info.mode & 0o777, 0o600, "the raced replacement is owner-only before the previous runtime restarts");
    }
    assert.equal(info.uid, process.getuid());
    assert.equal(await readFile(stored, "utf8"), "concurrent save");
  });
});
