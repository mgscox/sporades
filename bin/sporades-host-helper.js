#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const HOSTED_CAPSULE_DOCKER_IMAGE = "node:22-alpine";
const HOSTED_CAPSULE_DOCKER_NETWORK = "sporades-hosted-capsules";
const HOSTED_CAPSULE_GRACE_CHECK_MS = 500;

main().catch((error) => {
  writeEnvelope(
    {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: error.hint ?? "Check the Host helper request and retry the command.",
      },
    },
    false,
  );
});

async function main() {
  const request = JSON.parse(await readStdin());
  if (request.action === "capsule.release.install") {
    await installRelease(request);
    return;
  }
  if (request.action === "capsule.start") {
    await startCapsule(request);
    return;
  }
  if (request.action === "capsule.stop") {
    await stopCapsule(request);
    return;
  }
  if (request.action === "capsule.restart") {
    await restartCapsule(request);
    return;
  }

  throw helperError("Unsupported Host helper action.", "Update the Host helper or use a supported Sporades host command.");
}

async function installRelease(request) {
  const release = request.release;
  validateInstallRequest(request);
  await verifyRegisteredCapsule(request);
  validateReleaseArchive(request);
  const paths = canonicalReleasePaths(request);
  await mkdir(paths.releases, { recursive: true });
  await mkdir(paths.data, { recursive: true });

  const tempReleaseDirectory = `${paths.release}.tmp-${process.pid}`;
  const tempCurrentLink = `${paths.currentLink}.tmp-${process.pid}`;
  await rm(tempReleaseDirectory, { recursive: true, force: true });
  await rm(tempCurrentLink, { force: true });
  await mkdir(tempReleaseDirectory, { recursive: true });

  const extract = spawnSync("tar", ["-xzf", release.remoteArchive, "-C", tempReleaseDirectory], {
    encoding: "utf8",
  });
  if (extract.error || extract.status !== 0) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    throw helperError(
      "Failed to extract Hosted Capsule release archive.",
      "Upload the release again with `sporades host push` and check that tar is installed on the Host server.",
    );
  }

  try {
    await rename(tempReleaseDirectory, paths.release);
  } catch (error) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      throw helperError(
        "Hosted Capsule release already exists.",
        "Push again to generate a fresh immutable release ID.",
      );
    }
    throw error;
  }

  await symlink(paths.release, tempCurrentLink);
  await rename(tempCurrentLink, paths.currentLink);
  await updateRegistryCurrentRelease(request, release.id, "released");

  let restartResult = null;
  if (release.restart) {
    restartResult = await restartCapsule(request, { write: false });
  }

  const data = {
    installed: true,
    restartRequested: Boolean(release.restart),
    restarted: Boolean(restartResult?.restarted),
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: release.hostedUrl,
    },
    release: {
      id: release.id,
      directory: paths.release,
      currentLink: paths.currentLink,
      files: release.files,
      serverEnvIncluded: Boolean(release.serverEnvIncluded),
    },
  };
  if (restartResult) {
    data.lifecycle = restartResult;
  }
  if (release.restart && !restartResult) {
    writeEnvelope({
      ok: false,
      data,
      error: {
        message: "Hosted Capsule restart failed.",
        hint: `Check Docker logs for ${normaliseLifecycle(request).container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
      },
    });
    return;
  }
  writeEnvelope({ ok: true, data, error: null });
}

async function startCapsule(request, options = {}) {
  validateLifecycleRequest(request);
  await verifyRegisteredCapsule(request, "lifecycle");
  const paths = canonicalReleasePaths(request);
  const releaseId = await currentReleaseId(paths.currentLink, request);
  const lifecycle = normaliseLifecycle(request);
  await mkdir(paths.data, { recursive: true });

  stopAndRemoveContainer(lifecycle.container.name);
  const runArgs = await dockerRunArgs(lifecycle, releaseId);
  const run = runDocker(runArgs);
  if (!run.ok) {
    await writeUnavailableRoute(lifecycle);
    const result = {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule container failed to start.",
        hint: `Check Docker logs for ${lifecycle.container.name}, then retry \`sporades host start ${request.capsule.subname} --host ${request.host.alias}\`.`,
      },
    };
    if (options.write !== false) {
      writeEnvelope(result);
    }
    return null;
  }

  const running = checkContainerRunning(lifecycle.container.name);
  if (!running) {
    await writeUnavailableRoute(lifecycle);
    const result = {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule container did not stay running.",
        hint: `Check Docker logs for ${lifecycle.container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
      },
    };
    if (options.write !== false) {
      writeEnvelope(result);
    }
    return null;
  }

  await writeRunningRoute(lifecycle);
  await updateRegistryCurrentRelease(request, releaseId, "running");
  const data = {
    started: true,
    restarted: false,
    capsule: capsuleData(request, lifecycle),
    release: { id: releaseId },
    container: {
      id: run.stdout.trim(),
      name: lifecycle.container.name,
      network: lifecycle.container.network,
      image: lifecycle.container.image,
      running: true,
    },
    route: lifecycle.routes.running,
  };
  if (options.write !== false) {
    writeEnvelope({ ok: true, data, error: null });
  }
  return data;
}

async function stopCapsule(request, options = {}) {
  validateLifecycleRequest(request);
  await verifyRegisteredCapsule(request, "lifecycle");
  const lifecycle = normaliseLifecycle(request);
  stopAndRemoveContainer(lifecycle.container.name);
  await writeUnavailableRoute(lifecycle);
  await updateRegistryStatus(request, "stopped");
  const data = {
    stopped: true,
    capsule: capsuleData(request, lifecycle),
    container: { name: lifecycle.container.name, running: false },
    route: lifecycle.routes.unavailable,
  };
  if (options.write !== false) {
    writeEnvelope({ ok: true, data, error: null });
  }
  return data;
}

async function restartCapsule(request, options = {}) {
  validateLifecycleRequest(request);
  const lifecycle = normaliseLifecycle(request);
  stopAndRemoveContainer(lifecycle.container.name);
  const startResult = await startCapsule(request, { write: false });
  if (!startResult) {
    if (options.write !== false) {
      writeEnvelope({
        ok: false,
        data: null,
        error: {
          message: "Hosted Capsule restart failed.",
          hint: `Check Docker logs for ${lifecycle.container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
        },
      });
    }
    return null;
  }
  const data = { ...startResult, restarted: true };
  if (options.write !== false) {
    writeEnvelope({ ok: true, data, error: null });
  }
  return data;
}

function canonicalReleasePaths(request) {
  const capsule = path.join(
    request.host.remoteRoot,
    "hosts",
    request.host.domain,
    "capsules",
    request.capsule.subname,
  );
  const releases = path.join(capsule, "releases");
  return {
    capsule,
    releases,
    release: request.release?.id ? path.join(releases, request.release.id) : null,
    data: path.join(capsule, "data"),
    currentLink: path.join(capsule, "current"),
  };
}

function normaliseLifecycle(request) {
  const provided = request.lifecycle ?? {};
  const paths = canonicalReleasePaths(request);
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const hostedUrl = provided.hostedUrl ?? request.release?.hostedUrl ?? `${request.host.scheme ?? "https"}://${subname}.${domain}`;
  const remoteCapsuleId = provided.remoteCapsuleId ?? `${domain}/${subname}`;
  const containerName = provided.container?.name ?? createHostedContainerName(domain, subname);
  const routeFile = provided.routes?.running?.routeFile ?? path.join(request.host.remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`);
  const currentLink = provided.currentLink ?? paths.currentLink;
  return {
    hostedUrl,
    remoteCapsuleId,
    currentLink,
    directories: {
      capsule: paths.capsule,
      releases: paths.releases,
      data: paths.data,
    },
    remoteRoot: request.host.remoteRoot,
    mounts: provided.mounts ?? {
      files: [
        { host: path.join(currentLink, "server.mjs"), container: "/app/server.mjs", mode: "ro" },
        { host: path.join(currentLink, "client.js"), container: "/app/client.js", mode: "ro" },
        { host: path.join(currentLink, "index.html"), container: "/app/index.html", mode: "ro" },
        { host: path.join(currentLink, "sporades.json"), container: "/app/sporades.json", mode: "ro" },
        { host: path.join(currentLink, ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
      ],
      data: { host: paths.data, container: "/app/data", mode: "rw" },
    },
    container: {
      name: containerName,
      network: provided.container?.network ?? HOSTED_CAPSULE_DOCKER_NETWORK,
      image: provided.container?.image ?? HOSTED_CAPSULE_DOCKER_IMAGE,
      graceCheckMs: provided.container?.graceCheckMs ?? HOSTED_CAPSULE_GRACE_CHECK_MS,
      labels: {
        "com.sporades.managed": "true",
        "com.sporades.hosted-domain": domain,
        "com.sporades.capsule-subname": subname,
        "com.sporades.capsule-id": remoteCapsuleId,
        ...(provided.container?.labels ?? {}),
      },
    },
    routes: {
      running: provided.routes?.running ?? {
        hostname: `${subname}.${domain}`,
        target: "container",
        containerName,
        port: 4000,
        routeFile,
      },
      unavailable: provided.routes?.unavailable ?? {
        hostname: `${subname}.${domain}`,
        target: "hosted-capsule-unavailable",
        statusCode: 503,
        routeFile,
      },
    },
  };
}

async function dockerRunArgs(lifecycle, releaseId) {
  const args = [
    "run",
    "--detach",
    "--name",
    lifecycle.container.name,
    "--network",
    lifecycle.container.network,
  ];
  const labels = {
    ...lifecycle.container.labels,
    "com.sporades.release-id": releaseId,
  };
  for (const [key, value] of Object.entries(labels)) {
    args.push("--label", `${key}=${value}`);
  }
  for (const mount of lifecycle.mounts.files) {
    if (mount.optional && !(await pathExists(mount.host))) {
      continue;
    }
    args.push("--volume", formatMount(mount));
    if (mount.container === "/app/.env.sporades.server") {
      args.push("--env-file", mount.host);
    }
  }
  args.push("--volume", formatMount(lifecycle.mounts.data), "--workdir", "/app", "--env", "PORT=4000");
  args.push(lifecycle.container.image, "node", "/app/server.mjs");
  return args;
}

function stopAndRemoveContainer(containerName) {
  runDocker(["stop", containerName], { ignoreFailure: true });
  runDocker(["rm", containerName], { ignoreFailure: true });
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (options.ignoreFailure) {
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function checkContainerRunning(containerName) {
  const result = runDocker(["inspect", "-f", "{{.State.Running}}", containerName]);
  return result.ok && result.stdout.trim() === "true";
}

async function currentReleaseId(currentLink, request) {
  let target;
  try {
    target = await readlink(currentLink);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EINVAL") {
      throw helperError(
        "No Hosted Capsule release has been pushed.",
        `Run \`sporades host push --host ${request.host.alias} --subname ${request.capsule.subname}\` before starting the Hosted Capsule.`,
      );
    }
    throw error;
  }
  return path.basename(target);
}

async function writeRunningRoute(lifecycle) {
  const route = lifecycle.routes.running;
  await mkdir(path.dirname(route.routeFile), { recursive: true });
  await writeFile(
    route.routeFile,
    `${route.hostname} {\n  reverse_proxy ${route.containerName}:${route.port ?? 4000}\n}\n`,
  );
  reloadCaddy(lifecycle);
}

async function writeUnavailableRoute(lifecycle) {
  const route = lifecycle.routes.unavailable;
  await mkdir(path.dirname(route.routeFile), { recursive: true });
  await writeFile(
    route.routeFile,
    `${route.hostname} {\n  respond "Hosted Capsule unavailable" ${route.statusCode ?? 503}\n}\n`,
  );
  reloadCaddy(lifecycle);
}

function reloadCaddy(lifecycle) {
  const configPath = path.join(lifecycle.remoteRoot, "caddy", "Caddyfile");
  const result = spawnSync("caddy", ["reload", "--config", configPath], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to apply Hosted Capsule route.",
      "Check the Host server Caddy configuration, then retry the lifecycle command.",
    );
  }
}

async function updateRegistryCurrentRelease(request, releaseId, status) {
  const registryRecordPath = registryPath(request);
  const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
  record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
  record.status = status;
  record.updatedAt = new Date().toISOString();
  await writeFile(registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function updateRegistryStatus(request, status) {
  const registryRecordPath = registryPath(request);
  const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
  record.status = status;
  record.updatedAt = new Date().toISOString();
  await writeFile(registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function registryPath(request) {
  return path.join(
    request.host.remoteRoot,
    "hosts",
    request.host.domain,
    "registry",
    "capsules",
    `${request.capsule.subname}.json`,
  );
}

function capsuleData(request, lifecycle) {
  return {
    subname: request.capsule.subname,
    domain: request.host.domain,
    hostedUrl: lifecycle.hostedUrl,
    remoteCapsuleId: lifecycle.remoteCapsuleId,
  };
}

function formatMount(mount) {
  const mode = mount.mode === "ro" ? ":ro" : "";
  return `${mount.host}:${mount.container}${mode}`;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createHostedContainerName(domain, subname) {
  return `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
}

function validateReleaseArchive(request) {
  const release = request.release;
  const entries = listArchiveEntries(release.remoteArchive);
  const expectedFiles = expectedReleaseFiles(release);
  const actualNames = entries.map((entry) => normaliseArchiveEntryName(entry.name));

  if (entries.some((entry) => entry.type !== "-")) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe entries.",
      "Push again so Sporades can package regular runtime files only.",
    );
  }
  if (actualNames.some((name) => !isSafeArchiveEntryName(name))) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe paths.",
      "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
    );
  }

  const actual = [...actualNames].sort();
  const expected = [...expectedFiles].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw helperError(
      "Hosted Capsule release archive contains unexpected files.",
      "Push again so Sporades can package only runtime files.",
    );
  }
}

function listArchiveEntries(archivePath) {
  const namesResult = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  const verboseResult = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (namesResult.error || namesResult.status !== 0 || verboseResult.error || verboseResult.status !== 0) {
    throw helperError(
      "Failed to inspect Hosted Capsule release archive.",
      "Upload the release again with `sporades host push` and check that tar is installed on the Host server.",
    );
  }

  const names = namesResult.stdout.trim().split("\n").filter(Boolean);
  const verboseLines = verboseResult.stdout.trim().split("\n").filter(Boolean);
  if (names.length !== verboseLines.length) {
    throw helperError(
      "Hosted Capsule release archive could not be validated.",
      "Push again so Sporades can package a clean runtime archive.",
    );
  }
  return names.map((name, index) => ({
    name,
    type: verboseLines[index]?.[0],
  }));
}

function expectedReleaseFiles(release) {
  return release.serverEnvIncluded
    ? ["server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"]
    : ["server.mjs", "client.js", "index.html", "sporades.json"];
}

function normaliseArchiveEntryName(name) {
  return String(name).replace(/^\.\//, "");
}

function isSafeArchiveEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\0")) {
    return false;
  }
  return name.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

async function verifyRegisteredCapsule(request, purpose = "push") {
  const registryRecordPath = registryPath(request);
  let record;
  try {
    record = JSON.parse(await readFile(registryRecordPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw helperError(
        "Hosted Capsule is not registered.",
        purpose === "push"
          ? `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before pushing a release.`
          : `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before managing the Hosted Capsule lifecycle.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw helperError(
        "Hosted Capsule registry record is invalid.",
        "Repair the Host server registry record before pushing a release.",
      );
    }
    throw error;
  }

  const expectedRemoteCapsuleId = `${request.host.domain}/${request.capsule.subname}`;
  const matches =
    record?.subname === request.capsule.subname &&
    record?.domain === request.host.domain &&
    (record?.remoteCapsuleId ?? expectedRemoteCapsuleId) === expectedRemoteCapsuleId;
  if (!matches) {
    throw helperError(
      "Hosted Capsule registry record does not match the release request.",
      "Rebind the local project or pass the correct Host profile and Capsule subname.",
    );
  }
}

function validateLifecycleRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule lifecycle request.", "Update the Sporades CLI and retry the host lifecycle command.");
  }
}

function validateInstallRequest(request) {
  const release = request.release;
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
    release?.id,
    release?.remoteArchive,
    release?.hostedUrl,
    release?.directories?.releases,
    release?.directories?.release,
    release?.directories?.data,
    release?.currentLink,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid release install request.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(release.id)) {
    throw helperError("Invalid Hosted Capsule release ID.", "Push again to generate a fresh UTC-sortable release ID.");
  }
  if (!Array.isArray(release.files) || release.files.some((file) => typeof file !== "string" || file.includes("/") || file === "..")) {
    throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  const expectedFiles = expectedReleaseFiles(release);
  const claimedFiles = [...release.files].sort();
  const sortedExpectedFiles = [...expectedFiles].sort();
  if (claimedFiles.length !== sortedExpectedFiles.length || claimedFiles.some((file, index) => file !== sortedExpectedFiles[index])) {
    throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  const expectedReleaseDirectory = path.join(release.directories.releases, release.id);
  if (path.resolve(release.directories.release) !== path.resolve(expectedReleaseDirectory)) {
    throw helperError("Invalid Hosted Capsule release directory.", "Update the Sporades CLI and retry `sporades host push`.");
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    process.stdin.on("end", () => resolve(stdin));
    process.stdin.on("error", reject);
  });
}

function helperError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}

function writeEnvelope(result, failed = false) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failed) {
    process.exitCode = 1;
  }
}
