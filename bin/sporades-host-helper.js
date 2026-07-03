#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, readlink, rename, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { freemem, loadavg, totalmem } from "node:os";
import path from "node:path";

const HOST_HELPER_CONFIG_FILE = "sporades-host-helper.json";
const DEFAULT_HOSTED_CAPSULE_DOCKER_IMAGE = "node:22-alpine";
const DEFAULT_HOSTED_CAPSULE_DOCKER_NETWORK = "sporades-hosted-capsules";
const DEFAULT_HOSTED_CAPSULE_GRACE_CHECK_MS = 500;
const DEFAULT_HOST_LOG_LINES_VALUE = 200;
const DEFAULT_MAX_HOST_LOG_LINES = 10000;
const CAPSULE_RUNTIME_HEALTH_PATH = "/__sporades/health/runtime";
const RUNTIME_PROBE_HEADER = "x-sporades-host-probe";

let HOSTED_CAPSULE_DOCKER_IMAGE = DEFAULT_HOSTED_CAPSULE_DOCKER_IMAGE;
let HOSTED_CAPSULE_DOCKER_NETWORK = DEFAULT_HOSTED_CAPSULE_DOCKER_NETWORK;
let HOSTED_CAPSULE_GRACE_CHECK_MS = DEFAULT_HOSTED_CAPSULE_GRACE_CHECK_MS;
let DEFAULT_HOST_LOG_LINES = DEFAULT_HOST_LOG_LINES_VALUE;
let MAX_HOST_LOG_LINES = DEFAULT_MAX_HOST_LOG_LINES;

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
  await loadHostHelperConfig(request);
  if (request.action === "capsule.register") {
    await registerCapsule(request);
    return;
  }
  if (request.action === "capsule.unregister") {
    await unregisterCapsule(request);
    return;
  }
  if (request.action === "capsule.delete") {
    await deleteCapsule(request);
    return;
  }
  if (request.action === "capsule.release.install") {
    await installRelease(request);
    return;
  }
  if (request.action === "capsule.release.list") {
    await listReleases(request);
    return;
  }
  if (request.action === "capsule.release.rollback") {
    await rollbackRelease(request);
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
  if (request.action === "capsule.stats") {
    await statsCapsule(request);
    return;
  }
  if (request.action === "capsule.health") {
    await healthCapsule(request);
    return;
  }
  if (request.action === "host.stats") {
    await statsHost(request);
    return;
  }
  if (request.action === "capsule.list") {
    await listCapsules(request);
    return;
  }
  if (request.action === "host.logs") {
    await logsHost(request);
    return;
  }
  if (request.action === "host.bootstrap") {
    await bootstrapHost(request);
    return;
  }

  throw helperError("Unsupported Host helper action.", "Update the Host helper or use a supported Sporades host command.");
}

async function loadHostHelperConfig(request) {
  resetHostHelperConfig();
  const configPath = hostHelperConfigPath(request);
  if (!configPath) {
    return;
  }

  let contents;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !process.env.SPORADES_HOST_HELPER_CONFIG) {
      return;
    }
    throw helperError(
      "Failed to read Host helper config.",
      `Check that ${configPath} exists and is readable by the Host helper.`,
    );
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw helperError(
      "Host helper config is invalid JSON.",
      `Fix ${configPath}, then retry the Host helper command.`,
    );
  }

  applyHostHelperConfig(config, configPath);
}

function resetHostHelperConfig() {
  HOSTED_CAPSULE_DOCKER_IMAGE = DEFAULT_HOSTED_CAPSULE_DOCKER_IMAGE;
  HOSTED_CAPSULE_DOCKER_NETWORK = DEFAULT_HOSTED_CAPSULE_DOCKER_NETWORK;
  HOSTED_CAPSULE_GRACE_CHECK_MS = DEFAULT_HOSTED_CAPSULE_GRACE_CHECK_MS;
  DEFAULT_HOST_LOG_LINES = DEFAULT_HOST_LOG_LINES_VALUE;
  MAX_HOST_LOG_LINES = DEFAULT_MAX_HOST_LOG_LINES;
}

function hostHelperConfigPath(request) {
  if (process.env.SPORADES_HOST_HELPER_CONFIG) {
    return process.env.SPORADES_HOST_HELPER_CONFIG;
  }
  if (typeof request.host?.remoteRoot !== "string" || request.host.remoteRoot.length === 0) {
    return null;
  }
  return path.join(request.host.remoteRoot, HOST_HELPER_CONFIG_FILE);
}

function applyHostHelperConfig(config, configPath) {
  assertPlainObject(config, "Host helper config", configPath);
  assertKnownKeys(config, ["hostedCapsule", "logs"], "Host helper config", configPath);

  const hostedCapsule = config.hostedCapsule ?? {};
  assertPlainObject(hostedCapsule, "Host helper hostedCapsule config", configPath);
  assertKnownKeys(hostedCapsule, ["dockerImage", "dockerNetwork", "graceCheckMs"], "Host helper hostedCapsule config", configPath);

  const logs = config.logs ?? {};
  assertPlainObject(logs, "Host helper logs config", configPath);
  assertKnownKeys(logs, ["defaultLines", "maxLines"], "Host helper logs config", configPath);

  if (Object.hasOwn(hostedCapsule, "dockerImage")) {
    HOSTED_CAPSULE_DOCKER_IMAGE = readConfigString(hostedCapsule.dockerImage, "hostedCapsule.dockerImage", configPath);
  }
  if (Object.hasOwn(hostedCapsule, "dockerNetwork")) {
    HOSTED_CAPSULE_DOCKER_NETWORK = readConfigString(hostedCapsule.dockerNetwork, "hostedCapsule.dockerNetwork", configPath);
  }
  if (Object.hasOwn(hostedCapsule, "graceCheckMs")) {
    HOSTED_CAPSULE_GRACE_CHECK_MS = readConfigPositiveInteger(hostedCapsule.graceCheckMs, "hostedCapsule.graceCheckMs", configPath);
  }
  if (Object.hasOwn(logs, "defaultLines")) {
    DEFAULT_HOST_LOG_LINES = readConfigPositiveInteger(logs.defaultLines, "logs.defaultLines", configPath);
  }
  if (Object.hasOwn(logs, "maxLines")) {
    MAX_HOST_LOG_LINES = readConfigPositiveInteger(logs.maxLines, "logs.maxLines", configPath);
  }
  if (DEFAULT_HOST_LOG_LINES > MAX_HOST_LOG_LINES) {
    throw helperError(
      "Host helper config is invalid.",
      `Set logs.defaultLines less than or equal to logs.maxLines in ${configPath}.`,
    );
  }
}

function assertPlainObject(value, label, configPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw helperError(
      "Host helper config is invalid.",
      `${label} must be a JSON object in ${configPath}.`,
    );
  }
}

function assertKnownKeys(value, knownKeys, label, configPath) {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      throw helperError(
        "Host helper config is invalid.",
        `${label} contains unsupported key "${key}" in ${configPath}.`,
      );
    }
  }
}

function readConfigString(value, key, configPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw helperError(
      "Host helper config is invalid.",
      `Set ${key} to a non-empty string in ${configPath}.`,
    );
  }
  return value;
}

function readConfigPositiveInteger(value, key, configPath) {
  if (!Number.isInteger(value) || value < 1) {
    throw helperError(
      "Host helper config is invalid.",
      `Set ${key} to a positive whole number in ${configPath}.`,
    );
  }
  return value;
}

async function bootstrapHost(request) {
  validateBootstrapRequest(request);
  const bootstrap = normaliseBootstrap(request);
  await ensureBootstrapDirectories(bootstrap);
  await validateBootstrapTls(request, bootstrap);
  const network = ensureDockerNetwork(bootstrap.network);
  const accessLog = await provisionCaddyAccessLog(request, bootstrap);
  const caddy = await installCaddyBootstrapConfig(request, bootstrap);

  writeEnvelope({
    ok: true,
    data: {
      bootstrapped: true,
      domain: request.host.domain,
      remoteRoot: request.host.remoteRoot,
      network,
      packages: bootstrap.substrate.packages,
      services: bootstrap.substrate.services,
      directories: bootstrap.directories,
      tls: bootstrap.tls,
      caddy: { ...caddy, accessLog },
      preservedCapsules: true,
    },
    error: null,
  });
}

async function registerCapsule(request) {
  validateRegisterRequest(request);
  const registration = normaliseRegistration(request);
  await ensureHostedDomainBootstrapped(request, registration);

  let reactivated = false;
  await mkdir(path.dirname(registryLockPath(request)), { recursive: true });
  await withRegistryLock(request, async () => {
    if (await pathExists(registration.registryRecord)) {
      const existing = await readRegistryRecordForCapsule(request, "register");
      assertRegistryRecordMatchesRequest(request, existing);
      if (existing.status === "unregistered") {
        await mkdir(path.dirname(registration.registryRecord), { recursive: true });
        await mkdir(registration.directories.releases, { recursive: true });
        await mkdir(registration.directories.data, { recursive: true });
        await writeUnavailableRoute(registration.lifecycle);
        await writeRegistryRecordAtomic(registration.registryRecord, reactivateRegistrationRecord(existing));
        reactivated = true;
        return;
      }
      throw helperError(
        "Hosted Capsule subname is already registered for this Hosted domain.",
        `Choose a different Capsule subname for ${request.host.domain}.`,
      );
    }

    await mkdir(path.dirname(registration.registryRecord), { recursive: true });
    await mkdir(registration.directories.releases, { recursive: true });
    await mkdir(registration.directories.data, { recursive: true });
    await mkdir(registration.directories.logs, { recursive: true });
    await writeUnavailableRoute(registration.lifecycle);
    await writeRegistryRecordAtomic(registration.registryRecord, createRegistrationRecord(registration));
  });

  writeEnvelope({
    ok: true,
    data: {
      registered: true,
      reactivated,
      authoritative: true,
      capsule: {
        subname: registration.subname,
        domain: registration.domain,
        hostedUrl: registration.hostedUrl,
        remoteCapsuleId: registration.remoteCapsuleId,
      },
      registryRecord: registration.registryRecord,
      directories: registration.directories,
      route: registration.route,
    },
    error: null,
  });
}

async function unregisterCapsule(request) {
  validateUnregisterRequest(request);
  const unregister = normaliseUnregister(request);
  await mkdir(path.dirname(registryLockPath(request)), { recursive: true });

  let data;
  await withRegistryLock(request, async () => {
    const record = await readRegistryRecordForCapsule(request, "unregister");
    assertRegistryRecordMatchesRequest(request, record);

    if (record.status === "unregistered") {
      data = createUnregisterResult(request, unregister, record, true);
      return;
    }

    stopAndRemoveContainer(unregister.container.name);
    const route = await removeManagedRoute(unregister.lifecycle, unregister.route.routeFile);
    const now = new Date();
    const deleteAfter = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const nextRecord = {
      ...record,
      status: "unregistered",
      unregistered: true,
      unregisteredAt: now.toISOString(),
      deleteAfter,
      updatedAt: now.toISOString(),
    };
    try {
      await writeRegistryRecordAtomic(unregister.registryRecord, nextRecord);
    } catch (error) {
      await restoreRemovedRoute(unregister.lifecycle, route);
      throw error;
    }
    await finalizeRemovedRoute(route);
    data = createUnregisterResult(request, unregister, nextRecord, false, route);
  });

  writeEnvelope({ ok: true, data, error: null });
}

async function deleteCapsule(request) {
  validateDeleteRequest(request);
  const deletion = normaliseDeletion(request);
  await mkdir(path.dirname(registryLockPath(request)), { recursive: true });

  let data;
  await withRegistryLock(request, async () => {
    const record = await readOptionalRegistryRecordForCapsule(request);
    if (record) {
      assertRegistryRecordMatchesRequest(request, record);
      if (record.status !== "unregistered") {
        throw deletionRequiresUnregisterError(request);
      }
    } else if ((await pathExists(deletion.route.routeFile)) || (await pathExists(deletion.directories.capsule))) {
      throw deletionRequiresUnregisterError(request);
    }

    const route = await removePathIfPresent(deletion.route.routeFile);
    if (route.removed) {
      reloadCaddy(deletion.lifecycle);
    }
    const capsuleDirectory = await removePathIfPresent(deletion.directories.capsule, { recursive: true });
    const registryRecord = await removePathIfPresent(deletion.registryRecord);
    data = createDeleteResult(request, deletion, {
      route,
      capsuleDirectory,
      registryRecord,
      idempotent: !record && !route.removed && !capsuleDirectory.removed && !registryRecord.removed,
    });
  });

  writeEnvelope({ ok: true, data, error: null });
}

function deletionRequiresUnregisterError(request) {
  return helperError(
    "Hosted Capsule must be unregistered before deletion.",
    `Run \`sporades host unregister ${request.capsule.subname} --host ${request.host.alias}\` before deleting Hosted Capsule storage.`,
  );
}

async function installRelease(request) {
  const release = request.release;
  validateInstallRequest(request);
  const previousRecord = await verifyRegisteredCapsule(request);
  const previousCurrentRelease = previousRecord.currentRelease?.id ? { id: previousRecord.currentRelease.id } : null;
  validateReleaseArchive(request);
  const paths = canonicalReleasePaths(request);
  await mkdir(paths.releases, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.logs, { recursive: true });

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
  await removeDiscardedArchiveMetadata(tempReleaseDirectory);

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
  await recordReleaseUploaded(request, release);

  let restartResult = null;
  let restartError = null;
  if (release.restart) {
    try {
      restartResult = await restartCapsule(request, { write: false });
    } catch (error) {
      restartError = error;
    }
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
  if (isVerificationRequested(request)) {
    const verificationResult = await verifyInstalledRelease(request, release, data, previousCurrentRelease, restartResult, restartError);
    writeEnvelope(verificationResult, !verificationResult.ok);
    return;
  }
  if (release.restart && !restartResult) {
    writeEnvelope({
      ok: false,
      data,
      error: {
        message: restartError?.message ?? "Hosted Capsule restart failed.",
        hint:
          restartError?.hint ??
          `Check Docker logs for ${normaliseLifecycle(request).container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
      },
    });
    return;
  }
  writeEnvelope({ ok: true, data, error: null });
}

function isVerificationRequested(request) {
  return request.verification?.enabled === true;
}

async function verifyInstalledRelease(request, release, installData, previousCurrentRelease, restartResult, restartError) {
  const currentAttemptedRelease = { id: release.id };
  const baseData = {
    ...installData,
    previousCurrentRelease,
    currentAttemptedRelease,
  };
  if (!restartResult) {
    return verificationFailureResult(
      request,
      release.id,
      {
        ...baseData,
        verified: false,
        verification: {
          state: "failed",
          health: null,
        },
      },
      restartError?.message ?? "Hosted Capsule restart failed.",
    );
  }

  const healthResult = await evaluateCapsuleHealth(request, {
    timeoutMs: readVerificationHealthTimeoutMs(request),
  });
  if (!healthResult.ok) {
    await routeVerifiedFailureToUnavailable(request, release.id, healthResult.error?.message ?? "Hosted Capsule release verification failed.");
    return verificationFailureResult(
      request,
      release.id,
      {
        ...baseData,
        verified: false,
        verification: {
          state: "failed",
          health: verificationHealthSummary(healthResult),
        },
      },
      healthResult.error?.message ?? "Hosted Capsule release verification failed.",
    );
  }

  await recordReleaseVerified(request, release.id);
  return {
    ok: true,
    data: {
      ...baseData,
      verified: true,
      verification: {
        state: "verified",
        health: verificationHealthSummary(healthResult),
      },
    },
    error: null,
  };
}

function readVerificationHealthTimeoutMs(request) {
  const value = Number(request.verification?.healthTimeoutMs ?? 10_000);
  if (!Number.isFinite(value) || value < 1) {
    return 10_000;
  }
  return Math.min(value, 60_000);
}

async function routeVerifiedFailureToUnavailable(request, releaseId, message) {
  const lifecycle = normaliseLifecycle(request);
  stopAndRemoveContainer(lifecycle.container.name);
  try {
    await writeUnavailableRoute(lifecycle);
  } finally {
    await recordReleaseVerificationFailed(request, releaseId, message);
  }
}

function verificationFailureResult(request, releaseId, data, message) {
  const rollbackGuidance = releaseVerificationRollbackGuidance(request, data.previousCurrentRelease);
  return {
    ok: false,
    data: {
      ...data,
      rollbackGuidance,
    },
    error: {
      message: "Hosted Capsule release verification failed.",
      hint: rollbackGuidance
        ? `Run \`${rollbackGuidance.command}\` to explicitly roll back to the previous current release.`
        : `Inspect \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\` and choose an explicit rollback target.`,
      details: {
        releaseId,
        cause: message,
      },
    },
  };
}

function releaseVerificationRollbackGuidance(request, previousCurrentRelease) {
  if (!previousCurrentRelease?.id) {
    return null;
  }
  return {
    previousReleaseId: previousCurrentRelease.id,
    command: `sporades host rollback ${request.capsule.subname} ${previousCurrentRelease.id} --host ${request.host.alias}`,
  };
}

function verificationHealthSummary(result) {
  if (result.ok) {
    return {
      route: {
        url: result.data.route.url,
        responding: result.data.route.responding === true,
      },
      runtime: result.data.runtime,
    };
  }
  return {
    failure: result.data?.failure ?? "verification-failure",
    route: {
      url: result.data?.route?.url ?? null,
      responding: false,
    },
    runtime: result.data?.runtime ?? null,
  };
}

async function startCapsule(request, options = {}) {
  validateLifecycleRequest(request);
  await verifyRegisteredCapsule(request, "lifecycle");
  const paths = canonicalReleasePaths(request);
  const releaseId = await currentReleaseId(paths.currentLink, request);
  const lifecycle = normaliseLifecycle(request);
  await mkdir(paths.data, { recursive: true });
  await recordReleaseStartAttempt(request, releaseId);

  stopAndRemoveContainer(lifecycle.container.name);
  const runArgs = await dockerRunArgs(lifecycle, releaseId);
  const run = runDocker(runArgs);
  if (!run.ok) {
    await recordFailedStartAndUnavailableRoute(request, lifecycle, releaseId, "Hosted Capsule container failed to start.");
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
    await recordFailedStartAndUnavailableRoute(request, lifecycle, releaseId, "Hosted Capsule container did not stay running.");
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

  const publishedPort = inspectLoopbackPublishedPort(lifecycle.container.name, lifecycle.routes.running.port ?? 4000);
  if (!publishedPort) {
    stopAndRemoveContainer(lifecycle.container.name);
    await recordFailedStartAndUnavailableRoute(request, lifecycle, releaseId, "Docker did not report a loopback published port for Hosted Capsule.");
    const result = {
      ok: false,
      data: null,
      error: {
        message: "Docker did not report a loopback published port for Hosted Capsule.",
        hint: `Ensure Docker published container port 4000 on 127.0.0.1, then retry \`sporades host start ${request.capsule.subname} --host ${request.host.alias}\`.`,
      },
    };
    if (options.write !== false) {
      writeEnvelope(result);
    }
    return null;
  }

  const runtimeProbe = await ensureRuntimeProbeCredential(request);
  const runningRoute = loopbackRunningRoute({ ...lifecycle.routes.running, runtimeProbe }, publishedPort);
  try {
    await writeRunningRoute(lifecycle, runningRoute);
  } catch (error) {
    await recordReleaseFailure(request, releaseId, error?.message ?? "Failed to apply Hosted Capsule route.");
    throw error;
  }
  await recordReleaseStarted(request, releaseId);
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
      publishedPort,
    },
    route: publicRouteData(runningRoute),
  };
  if (options.write !== false) {
    writeEnvelope({ ok: true, data, error: null });
  }
  return data;
}

async function healthCapsule(request) {
  writeEnvelope(await evaluateCapsuleHealth(request));
}

async function evaluateCapsuleHealth(request, options = {}) {
  validateHealthRequest(request);
  let health = normaliseHealth(request);
  let record;
  try {
    record = await readRegistryRecordForCapsule(request, "health");
  } catch (error) {
    if (error.message === "Hosted Capsule is not registered.") {
      return unregisteredHealthFailure(request, health);
    }
    throw error;
  }
  assertRegistryRecordMatchesRequest(request, record);
  health = normaliseHealth(request, record);
  if (record.status === "unregistered") {
    return unregisteredHealthFailure(request, health);
  }

  if (!record.currentRelease?.id) {
    return healthFailure(
      request,
      health,
      "no-current-release",
      "Hosted Capsule has no current release.",
      `Run \`sporades host push --host ${request.host.alias} --subname ${request.capsule.subname}\`, then retry health.`,
    );
  }

  const running = checkContainerRunning(health.container.name);
  if (!running) {
    return healthFailure(
      request,
      health,
      "stopped-container",
      "Hosted Capsule has no running container.",
      `Run \`sporades host start ${request.capsule.subname} --host ${request.host.alias}\`, then retry health.`,
    );
  }

  const runtimeProbe = readRuntimeProbeCredential(record);
  if (!runtimeProbe) {
    return healthFailure(
      request,
      health,
      "route-failure",
      "Hosted Capsule runtime probe is not configured.",
      `Restart the Hosted Capsule with \`sporades host restart ${request.capsule.subname} --host ${request.host.alias}\`, then retry health.`,
    );
  }

  let response;
  try {
    response = await fetch(health.runtimeHealthUrl, {
      headers: {
        accept: "application/json",
        [runtimeProbe.header]: runtimeProbe.token,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return healthFailure(
      request,
      health,
      "route-failure",
      "Hosted Capsule route did not respond to runtime health.",
      "Check DNS, Caddy, and the Hosted Capsule route, then retry health.",
    );
  }

  if (!response.ok) {
    return healthFailure(
      request,
      health,
      "route-failure",
      "Hosted Capsule route returned an HTTP failure for runtime health.",
      "Check Caddy routing and Hosted Capsule logs, then retry health.",
      { statusCode: response.status },
    );
  }

  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return healthFailure(
      request,
      health,
      "runtime-failure",
      "Hosted Capsule runtime health returned invalid JSON.",
      "Check Hosted Capsule logs, then retry health.",
    );
  }

  const runtime = normaliseRuntimeHealthBody(body);
  if (!runtime.valid) {
    return healthFailure(
      request,
      health,
      "runtime-failure",
      "Hosted Capsule runtime health had an unexpected shape.",
      "Update the Hosted Capsule release and retry health.",
    );
  }
  if (!runtime.checks.sqlite.ok) {
    return healthFailure(
      request,
      health,
      "sqlite-failure",
      "Hosted Capsule SQLite health check failed.",
      "Check the Hosted Capsule data volume and runtime logs, then retry health.",
      { runtime: runtime.safe },
    );
  }
  if (!runtime.checks.fileStorage.ok) {
    return healthFailure(
      request,
      health,
      "file-storage-failure",
      "Hosted Capsule file storage health check failed.",
      "Check the Hosted Capsule data volume permissions, then retry health.",
      { runtime: runtime.safe },
    );
  }
  if (!body.ok || !runtime.ready) {
    return healthFailure(
      request,
      health,
      "runtime-failure",
      "Hosted Capsule runtime is not ready.",
      "Check Hosted Capsule logs, then retry health.",
      { runtime: runtime.safe },
    );
  }

  return {
    ok: true,
    data: {
      capsule: {
        subname: request.capsule.subname,
        domain: request.host.domain,
        hostedUrl: health.hostedUrl,
        remoteCapsuleId: health.remoteCapsuleId,
        registered: true,
      },
      release: { id: record.currentRelease.id, current: true },
      container: { name: health.container.name, running: true },
      route: { url: health.runtimeHealthUrl, responding: true },
      runtime: runtime.safe,
    },
    error: null,
  };
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

async function statsCapsule(request) {
  validateStatsRequest(request);
  const registryRecord = await verifyRegisteredCapsule(request, "stats");
  const stats = normaliseStats(request);
  const runningState = inspectContainerRunning(stats.container.name);
  if (!runningState.ok) {
    throw helperError(
      "Failed to read Hosted Capsule Docker stats.",
      `Check Docker on the Host server and retry \`sporades host stats ${request.capsule.subname} --host ${request.host.alias}\`.`,
    );
  }
  if (!runningState.running) {
    throw helperError(
      "Hosted Capsule has no running container.",
      `Run \`sporades host start ${request.capsule.subname} --host ${request.host.alias}\`, then retry stats.`,
    );
  }

  const result = runDocker(["stats", "--no-stream", "--format", "json", stats.container.name]);
  if (!result.ok) {
    throw helperError(
      "Failed to read Hosted Capsule Docker stats.",
      `Check Docker on the Host server and retry \`sporades host stats ${request.capsule.subname} --host ${request.host.alias}\`.`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw helperError(
      "Hosted Capsule Docker stats were not valid JSON.",
      "Update Docker or reinstall the Sporades Host helper on the Host server.",
    );
  }

  const data = {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: stats.hostedUrl,
      remoteCapsuleId: stats.remoteCapsuleId,
    },
    container: {
      name: stats.container.name,
      running: true,
    },
    stats: normaliseDockerStats(raw),
    lifecycle: readCapsuleLifecycle(request, registryRecord, stats.container.name, true),
    raw,
  };
  writeEnvelope({ ok: true, data, error: null });
}

async function listReleases(request) {
  validateReleaseListRequest(request);
  const record = await readRegistryRecordForCapsule(request, "releases");
  assertRegistryRecordMatchesRequest(request, record);
  const releases = normaliseReleaseHistory(record)
    .map((release) => markCurrentReleaseEntry(release, record.currentRelease?.id ?? null))
    .sort(compareReleasesNewestFirst);

  writeEnvelope({
    ok: true,
    data: {
      capsule: {
        subname: record.subname,
        domain: record.domain,
        hostedUrl: record.hostedUrl ?? `${request.host.scheme ?? "https"}://${record.subname}.${request.host.domain}`,
        remoteCapsuleId: record.remoteCapsuleId ?? `${request.host.domain}/${record.subname}`,
      },
      currentRelease: record.currentRelease ?? null,
      releases,
    },
    error: null,
  });
}

async function rollbackRelease(request) {
  validateRollbackRequest(request);
  const record = await readRegistryRecordForCapsule(request, "rollback");
  assertRegistryRecordMatchesRequest(request, record);
  if (record.status === "unregistered") {
    throw helperError(
      "Hosted Capsule is unregistered.",
      `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before retrying this command.`,
    );
  }

  const releases = normaliseReleaseHistory(record);
  if (releases.length === 0) {
    throw helperError(
      "Hosted Capsule has no release history.",
      `Push a release before running \`sporades host rollback ${request.capsule.subname} <release-id> --host ${request.host.alias}\`.`,
    );
  }

  const releaseId = request.rollback.releaseId;
  const selectedRelease = releases.find((release) => release.id === releaseId);
  if (!selectedRelease) {
    throw helperError(
      "Hosted Capsule release is not recorded.",
      `Run \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\` and choose a recorded release ID.`,
    );
  }

  const paths = canonicalRollbackPaths(request, releaseId);
  await assertRollbackReleaseFiles(request, paths.release);
  const previousCurrentRelease = record.currentRelease ?? null;
  const tempCurrentLink = `${paths.currentLink}.tmp-${process.pid}`;
  await rm(tempCurrentLink, { force: true });
  await symlink(paths.release, tempCurrentLink);
  await rename(tempCurrentLink, paths.currentLink);
  await recordReleaseRollbackSelected(request, releaseId);

  let lifecycle = null;
  let restartError = null;
  try {
    lifecycle = await restartCapsule(request, { write: false });
  } catch (error) {
    restartError = error;
  }

  const data = {
    rolledBack: Boolean(lifecycle),
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: selectedRelease.source.hostedUrl ?? `${request.host.scheme ?? "https"}://${request.capsule.subname}.${request.host.domain}`,
      remoteCapsuleId: selectedRelease.source.remoteCapsuleId ?? `${request.host.domain}/${request.capsule.subname}`,
    },
    previousCurrentRelease,
    currentRelease: { ...(record.currentRelease ?? {}), id: releaseId },
  };
  if (lifecycle) {
    data.lifecycle = lifecycle;
    writeEnvelope({ ok: true, data, error: null });
    return;
  }

  try {
    await writeUnavailableRoute(normaliseLifecycle(request));
  } catch (error) {
    restartError = restartError ?? error;
  }
  data.rolledBack = false;
  writeEnvelope({
    ok: false,
    data,
    error: {
      message: restartError?.message ?? "Hosted Capsule rollback start failed.",
      hint:
        restartError?.hint ??
        `Previous current release was ${previousCurrentRelease?.id ?? "none"}. Check Docker logs for ${normaliseLifecycle(request).container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
    },
  });
}

async function statsHost(request) {
  validateHostStatsRequest(request);
  const records = await readCapsuleRegistryRecords(request);
  const dockerAvailable = checkDockerAvailable();
  const caddyAvailable = checkCaddyAvailable();
  const dockerStates = dockerAvailable ? records.map((record) => lookupCapsuleDockerState(request, record)) : [];

  const data = {
    host: {
      alias: request.host.alias,
      domain: request.host.domain,
      scheme: request.host.scheme ?? "https",
      remoteRoot: request.host.remoteRoot,
    },
    resources: {
      disk: await readHostDiskStats(request.host.remoteRoot),
      memory: readHostMemoryStats(),
      load: readHostLoadStats(),
    },
    services: {
      docker: { available: dockerAvailable },
      caddy: { available: caddyAvailable },
    },
    capsules: countHostedCapsules(records, dockerStates),
  };
  writeEnvelope({ ok: true, data, error: null });
}

async function logsHost(request) {
  validateHostLogsRequest(request);
  const logs = normaliseHostLogs(request);
  if (logs.source === "stdout" || logs.source === "stderr") {
    const entries = readDockerStreamLogs(logs);
    writeEnvelope({ ok: true, data: { lineCount: logs.lines, source: logs.source, container: logs.container.name, entries }, error: null });
    return;
  }

  const fileEntries = await readManagedCaddyAccessLog(logs);
  if (fileEntries) {
    writeEnvelope({ ok: true, data: { lineCount: logs.lines, source: "http", entries: fileEntries }, error: null });
    return;
  }

  if (logs.capsuleScoped) {
    throw unavailableCapsuleHttpLogsError(logs);
  }

  const journalEntries = readCaddyJournalLogs(logs);
  if (journalEntries) {
    writeEnvelope({ ok: true, data: { lineCount: logs.lines, source: "http", entries: journalEntries }, error: null });
    return;
  }

  throw unavailableCaddyLogsError(request);
}

async function listCapsules(request) {
  validateListRequest(request);
  const records = await readCapsuleRegistryRecords(request);
  const capsules = [];
  for (const record of records) {
    if (record.status === "unregistered") {
      continue;
    }
    capsules.push({
      subname: record.subname,
      domain: record.domain,
      hostedUrl: record.hostedUrl ?? `${request.host.scheme ?? "https"}://${record.subname}.${request.host.domain}`,
      registry: {
        remoteCapsuleId: record.remoteCapsuleId ?? `${request.host.domain}/${record.subname}`,
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
        status: record.status ?? "registered",
      },
      currentRelease: record.currentRelease ?? null,
      docker: lookupCapsuleDockerState(request, record),
    });
  }

  writeEnvelope({
    ok: true,
    data: {
      host: {
        alias: request.host.alias,
        domain: request.host.domain,
        scheme: request.host.scheme ?? "https",
        remoteRoot: request.host.remoteRoot,
      },
      capsules,
    },
    error: null,
  });
}

function createUnregisterResult(request, unregister, record, idempotent, route = null) {
  return {
    unregistered: true,
    idempotent,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: unregister.hostedUrl,
      remoteCapsuleId: unregister.remoteCapsuleId,
    },
    registryRecord: unregister.registryRecord,
    directories: unregister.directories,
    preserved: {
      releases: record.currentRelease?.id ? path.join(unregister.directories.releases, record.currentRelease.id) : unregister.directories.releases,
      data: unregister.directories.data,
    },
    deleteAfter: record.deleteAfter ?? null,
    container: { name: unregister.container.name, running: false, removed: true },
    route: route ?? { ...unregister.route, removed: true },
  };
}

function createDeleteResult(request, deletion, removals) {
  const capsuleRemoved = removals.capsuleDirectory.removed;
  return {
    deleted: true,
    idempotent: removals.idempotent,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: deletion.hostedUrl,
      remoteCapsuleId: deletion.remoteCapsuleId,
    },
    registryRecord: {
      path: deletion.registryRecord,
      removed: removals.registryRecord.removed,
      alreadyAbsent: !removals.registryRecord.removed,
    },
    directories: {
      capsule: {
        path: deletion.directories.capsule,
        removed: capsuleRemoved,
        alreadyAbsent: !capsuleRemoved,
      },
      releases: {
        path: deletion.directories.releases,
        removed: capsuleRemoved,
        alreadyAbsent: !capsuleRemoved,
      },
      data: {
        path: deletion.directories.data,
        removed: capsuleRemoved,
        alreadyAbsent: !capsuleRemoved,
      },
    },
    route: {
      path: deletion.route.routeFile,
      removed: removals.route.removed,
      alreadyAbsent: !removals.route.removed,
    },
  };
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
    logs: path.join(capsule, "logs"),
    currentLink: path.join(capsule, "current"),
  };
}

function canonicalRollbackPaths(request, releaseId) {
  const paths = canonicalReleasePaths({ ...request, release: { id: releaseId } });
  return {
    ...paths,
    release: path.join(paths.releases, releaseId),
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
  const accessLog = provided.routes?.accessLog ?? provided.accessLog ?? defaultCapsuleHttpLogPath(request.host.remoteRoot, domain, subname);
  return {
    hostedUrl,
    remoteCapsuleId,
    currentLink,
    directories: {
      capsule: paths.capsule,
      releases: paths.releases,
      data: paths.data,
      logs: paths.logs,
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
      running: withRouteAccessLog(
        provided.routes?.running ?? {
          hostname: `${subname}.${domain}`,
          target: "container",
          containerName,
          port: 4000,
          routeFile,
        },
        accessLog,
      ),
      unavailable: withRouteAccessLog(
        provided.routes?.unavailable ?? {
          hostname: `${subname}.${domain}`,
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile,
        },
        accessLog,
      ),
    },
  };
}

function withRouteAccessLog(route, accessLog) {
  if (route.log === null) {
    return route;
  }
  return {
    ...route,
    log: route.log ?? { file: accessLog },
  };
}

function normaliseStats(request) {
  const provided = request.stats ?? {};
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const hostedUrl = provided.hostedUrl ?? `${request.host.scheme ?? "https"}://${subname}.${domain}`;
  const remoteCapsuleId = provided.remoteCapsuleId ?? `${domain}/${subname}`;
  return {
    hostedUrl,
    remoteCapsuleId,
    container: {
      name: provided.container?.name ?? createHostedContainerName(domain, subname),
    },
  };
}

function normaliseHealth(request, record = null) {
  const provided = request.health ?? {};
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const hostedUrl = record?.hostedUrl ?? `${request.host.scheme ?? "https"}://${subname}.${domain}`;
  const remoteCapsuleId = record?.remoteCapsuleId ?? `${domain}/${subname}`;
  return {
    hostedUrl,
    remoteCapsuleId,
    runtimeHealthUrl: `${hostedUrl}${CAPSULE_RUNTIME_HEALTH_PATH}`,
    container: {
      name: provided.container?.name ?? createHostedContainerName(domain, subname),
    },
  };
}

async function ensureRuntimeProbeCredential(request) {
  let probe = null;
  await mutateRegistryRecord(request, (record) => {
    probe = readRuntimeProbeCredential(record) ?? {
      header: RUNTIME_PROBE_HEADER,
      token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    return { ...record, runtimeProbe: probe };
  });
  return probe;
}

function readRuntimeProbeCredential(record) {
  const header = record?.runtimeProbe?.header;
  const token = record?.runtimeProbe?.token;
  if (header !== RUNTIME_PROBE_HEADER || typeof token !== "string" || token.length === 0) {
    return null;
  }
  return { header, token };
}

function normaliseRuntimeHealthBody(body) {
  const checks = body?.data?.checks;
  const sqlite = checks?.sqlite;
  const fileStorage = checks?.fileStorage;
  const ready = body?.data?.runtime?.ready;
  const valid = typeof body?.ok === "boolean" && typeof ready === "boolean" && typeof sqlite?.ok === "boolean" && typeof fileStorage?.ok === "boolean";
  const safe = {
    ready: ready === true,
    checks: {
      sqlite: { ok: sqlite?.ok === true },
      fileStorage: { ok: fileStorage?.ok === true },
    },
  };
  return { valid, ready: ready === true, checks: safe.checks, safe };
}

function healthFailure(request, health, failure, message, hint, extra = {}) {
  return {
    ok: false,
    data: {
      capsule: {
        subname: request.capsule.subname,
        domain: request.host.domain,
        hostedUrl: health.hostedUrl,
        remoteCapsuleId: health.remoteCapsuleId,
      },
      route: { url: health.runtimeHealthUrl },
      container: { name: health.container.name },
      failure,
      ...extra,
    },
    error: { message, hint },
  };
}

function unregisteredHealthFailure(request, health) {
  return healthFailure(
    request,
    health,
    "unregistered-capsule",
    "Hosted Capsule is not registered.",
    `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before checking runtime health.`,
  );
}

function publicRouteData(route) {
  const { runtimeProbe, ...safeRoute } = route;
  return safeRoute;
}

async function readHostDiskStats(targetPath) {
  let stats;
  try {
    stats = await statfs(targetPath);
  } catch {
    throw helperError(
      "Failed to read Host server disk stats.",
      `Check that ${targetPath} exists and is readable by the Host helper, then retry \`sporades host stats --host <alias>\`.`,
    );
  }
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bfree) * blockSize;
  const availableBytes = Number(stats.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    path: targetPath,
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: percentage(usedBytes, totalBytes),
  };
}

function readHostMemoryStats() {
  const totalBytes = totalmem();
  const availableBytes = freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: percentage(usedBytes, totalBytes),
  };
}

function readHostLoadStats() {
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  return { oneMinute, fiveMinutes, fifteenMinutes };
}

function checkDockerAvailable() {
  return runDocker(["version", "--format", "{{.Server.Version}}"]).ok;
}

function checkCaddyAvailable() {
  const result = spawnSync("caddy", ["version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function countHostedCapsules(records, dockerStates) {
  let running = 0;
  let stopped = 0;
  for (let index = 0; index < records.length; index += 1) {
    const docker = dockerStates[index] ?? null;
    if (docker?.running === true) {
      running += 1;
      continue;
    }
    if (docker?.running === false || records[index].status === "stopped") {
      stopped += 1;
    }
  }
  return {
    total: records.length,
    registered: records.filter((record) => (record.status ?? "registered") === "registered").length,
    running,
    stopped,
    unavailable: records.length - running,
  };
}

function readCapsuleLifecycle(request, registryRecord, containerName, running) {
  const inspected = inspectContainerLifecycle(containerName);
  return {
    registered: true,
    registryStatus: registryRecord.status ?? "registered",
    running,
    startedAt: inspected.startedAt,
    uptimeSeconds: inspected.uptimeSeconds,
    restartCount: inspected.restartCount,
    currentReleaseId: registryRecord.currentRelease?.id ?? null,
    routeTarget: registryRecord.route?.target ?? (running ? "container" : "hosted-capsule-unavailable"),
  };
}

function inspectContainerLifecycle(containerName) {
  const result = runDocker(["inspect", "--format", "{{json .}}", containerName]);
  if (!result.ok) {
    return { startedAt: null, uptimeSeconds: null, restartCount: null };
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return { startedAt: null, uptimeSeconds: null, restartCount: null };
  }
  const startedAt = typeof raw.State?.StartedAt === "string" && raw.State.StartedAt !== "0001-01-01T00:00:00Z" ? raw.State.StartedAt : null;
  return {
    startedAt,
    uptimeSeconds: startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) : null,
    restartCount: Number.isFinite(raw.RestartCount) ? raw.RestartCount : null,
  };
}

async function readCapsuleRegistryRecords(request) {
  const registryDirectory = path.join(request.host.remoteRoot, "hosts", request.host.domain, "registry", "capsules");
  let entries;
  try {
    entries = await readdir(registryDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const recordPath = path.join(registryDirectory, file);
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw helperError(
          "Hosted Capsule registry record is invalid.",
          `Repair the Host server registry record at ${recordPath}, then retry \`${hostRegistryRetryCommand(request)}\`.`,
        );
      }
      throw error;
    }
    validateListRegistryRecord(request, record, recordPath);
    records.push(record);
  }
  return records;
}

function lookupCapsuleDockerState(request, record) {
  const subname = record.subname;
  const containerName = createHostedContainerName(request.host.domain, subname);
  const result = runDocker([
    "ps",
    "-a",
    "--filter",
    "label=com.sporades.managed=true",
    "--filter",
    `label=com.sporades.hosted-domain=${request.host.domain}`,
    "--filter",
    `label=com.sporades.capsule-subname=${subname}`,
    "--format",
    "json",
  ]);
  if (!result.ok) {
    return null;
  }

  const containers = parseDockerPsJsonLines(result.stdout);
  const remoteCapsuleId = record.remoteCapsuleId ?? `${request.host.domain}/${subname}`;
  const match = containers.find((container) => dockerPsContainerMatches(container, containerName, remoteCapsuleId, subname));
  return match ? normaliseDockerPsContainer(match, containerName) : null;
}

function hostRegistryRetryCommand(request) {
  return request.action === "host.stats" ? `sporades host stats --host ${request.host.alias}` : `sporades host list --host ${request.host.alias}`;
}

function parseDockerPsJsonLines(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function dockerPsContainerMatches(container, containerName, remoteCapsuleId, subname) {
  const names = String(container.Names ?? container.Name ?? "");
  const labels = parseDockerLabels(container.Labels);
  return (
    names.split(",").map((name) => name.trim()).includes(containerName) ||
    labels["com.sporades.capsule-id"] === remoteCapsuleId ||
    labels["com.sporades.capsule-subname"] === subname
  );
}

function parseDockerLabels(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, labelValue]) => [key, String(labelValue)]));
  }
  const labels = {};
  for (const label of String(value ?? "").split(",")) {
    const [key, ...rest] = label.split("=");
    if (key && rest.length > 0) {
      labels[key.trim()] = rest.join("=").trim();
    }
  }
  return labels;
}

function normaliseDockerPsContainer(container, fallbackContainerName) {
  const state = String(container.State ?? container.state ?? "").toLowerCase();
  const containerName = String(container.Names ?? container.Name ?? fallbackContainerName).split(",")[0].trim();
  const status = String(container.Status ?? container.status ?? "");
  return {
    containerId: String(container.ID ?? container.Id ?? container.id ?? ""),
    containerName,
    image: String(container.Image ?? container.image ?? ""),
    state: state || "unknown",
    status,
    running: state === "running",
  };
}

function normaliseRegistration(request) {
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const remoteRoot = request.host.remoteRoot;
  const scheme = request.host.scheme ?? "https";
  const hostedUrl = `${scheme}://${subname}.${domain}`;
  const remoteCapsuleId = `${domain}/${subname}`;
  const capsuleDirectory = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`);
  const routeTls = normaliseRegistrationTls(request);
  const accessLog = request.registration?.route?.log?.file ?? defaultCapsuleHttpLogPath(remoteRoot, domain, subname);
  const route = {
    hostname: `${subname}.${domain}`,
    target: "hosted-capsule-unavailable",
    statusCode: 503,
    routeFile,
    tls: routeTls,
    log: { file: accessLog },
  };
  return {
    subname,
    domain,
    hostedUrl,
    remoteCapsuleId,
    registryRecord: path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`),
    directories: {
      capsule: capsuleDirectory,
      releases: path.join(capsuleDirectory, "releases"),
      data: path.join(capsuleDirectory, "data"),
      logs: path.join(capsuleDirectory, "logs"),
    },
    route,
    lifecycle: {
      remoteRoot,
      routes: { unavailable: route },
    },
  };
}

function normaliseUnregister(request) {
  const provided = request.unregister ?? {};
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const remoteRoot = request.host.remoteRoot;
  const scheme = request.host.scheme ?? "https";
  const hostedUrl = `${scheme}://${subname}.${domain}`;
  const remoteCapsuleId = `${domain}/${subname}`;
  const capsuleDirectory = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`);
  const containerName = createHostedContainerName(domain, subname);
  return {
    subname,
    domain,
    hostedUrl,
    remoteCapsuleId,
    registryRecord: path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`),
    directories: {
      capsule: capsuleDirectory,
      releases: path.join(capsuleDirectory, "releases"),
      data: path.join(capsuleDirectory, "data"),
    },
    container: {
      name: containerName,
    },
    route: {
      hostname: `${subname}.${domain}`,
      target: "removed",
      routeFile,
    },
    lifecycle: {
      remoteRoot,
    },
    provided,
  };
}

function normaliseDeletion(request) {
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const remoteRoot = request.host.remoteRoot;
  const scheme = request.host.scheme ?? "https";
  const capsuleDirectory = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  return {
    subname,
    domain,
    hostedUrl: `${scheme}://${subname}.${domain}`,
    remoteCapsuleId: `${domain}/${subname}`,
    registryRecord: path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`),
    directories: {
      capsule: capsuleDirectory,
      releases: path.join(capsuleDirectory, "releases"),
      data: path.join(capsuleDirectory, "data"),
    },
    route: {
      hostname: `${subname}.${domain}`,
      routeFile: path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`),
    },
    lifecycle: {
      remoteRoot,
    },
  };
}

function normaliseRegistrationTls(request) {
  const remoteRoot = request.host.remoteRoot;
  const domain = request.host.domain;
  const tlsMode = request.registration?.bootstrap?.tls?.mode ?? request.bootstrap?.tls?.mode ?? "automatic";
  const tlsDirectory = path.join(remoteRoot, "hosts", domain, "tls");
  return {
    mode: tlsMode,
    directory: tlsDirectory,
    certificate: tlsMode === "cloudflare-origin" ? path.join(tlsDirectory, "origin.crt") : null,
    key: tlsMode === "cloudflare-origin" ? path.join(tlsDirectory, "origin.key") : null,
  };
}

async function ensureHostedDomainBootstrapped(request, registration) {
  const caddyfile = path.join(request.host.remoteRoot, "caddy", "Caddyfile");
  const domainInclude = path.join(request.host.remoteRoot, "caddy", "hosts", `${request.host.domain}.caddy`);
  const bootstrapped = (await pathExists(caddyfile)) && (await pathExists(domainInclude));
  if (bootstrapped) {
    return;
  }
  const tls = registration.route.tls;
  const tlsHint =
    tls?.mode === "cloudflare-origin"
      ? ` after installing readable Cloudflare origin certificate and key files at ${tls.certificate} and ${tls.key}`
      : "";
  throw helperError(
    "Hosted domain has not been bootstrapped.",
    `Run \`sporades host bootstrap --host ${request.host.alias}\`${tlsHint}.`,
  );
}

function createRegistrationRecord(registration) {
  const now = new Date().toISOString();
  return {
    subname: registration.subname,
    domain: registration.domain,
    remoteCapsuleId: registration.remoteCapsuleId,
    hostedUrl: registration.hostedUrl,
    status: "registered",
    createdAt: now,
    updatedAt: now,
    currentRelease: null,
  };
}

function reactivateRegistrationRecord(record) {
  const now = new Date().toISOString();
  const { unregistered, unregisteredAt, deleteAfter, ...activeRecord } = record;
  return {
    ...activeRecord,
    status: "registered",
    updatedAt: now,
  };
}

function normaliseHostLogs(request) {
  const provided = request.logs ?? {};
  const lines = provided.lines ?? DEFAULT_HOST_LOG_LINES;
  const explicitFile = Boolean(provided.file ?? provided.path ?? provided.accessLog?.file);
  const source = provided.source === "caddy-combined" ? "http" : (provided.source ?? "http");
  const subname = request.capsule?.subname;
  const containerName = provided.container?.name ?? (subname ? createHostedContainerName(request.host.domain, subname) : null);
  const capsuleScoped = source === "http" && typeof subname === "string" && subname.length > 0;
  return {
    source,
    lines,
    file:
      provided.file ??
      provided.path ??
      provided.accessLog?.file ??
      (capsuleScoped
        ? defaultCapsuleHttpLogPath(request.host.remoteRoot, request.host.domain, subname)
        : defaultCaddyAccessLogPath(request.host.remoteRoot)),
    explicitFile,
    capsuleScoped,
    subname,
    container: containerName ? { name: containerName } : null,
  };
}

function normaliseDockerStats(raw) {
  const [memoryUsageBytes, memoryLimitBytes] = parsePair(raw.MemUsage, parseDockerByteSize);
  const [networkInputBytes, networkOutputBytes] = parsePair(raw.NetIO, parseDockerByteSize);
  const [blockInputBytes, blockOutputBytes] = parsePair(raw.BlockIO, parseDockerByteSize);
  return {
    cpuPercent: parseDockerPercent(raw.CPUPerc),
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: parseDockerPercent(raw.MemPerc),
    networkInputBytes,
    networkOutputBytes,
    blockInputBytes,
    blockOutputBytes,
    pids: parseDockerInteger(raw.PIDs),
  };
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10000) / 100;
}

function normaliseBootstrap(request) {
  const provided = request.bootstrap ?? {};
  const remoteRoot = request.host.remoteRoot;
  const domain = request.host.domain;
  const caddyDirectory = path.join(remoteRoot, "caddy");
  const domainDirectory = path.join(remoteRoot, "hosts", domain);
  const tlsDirectory = path.join(domainDirectory, "tls");
  const tlsMode = provided.tls?.mode ?? "automatic";
  const directories = {
    remoteRoot,
    bin: path.join(remoteRoot, "bin"),
    incoming: path.join(remoteRoot, "incoming"),
    caddy: caddyDirectory,
    caddyHosts: path.join(caddyDirectory, "hosts"),
    hosts: path.join(remoteRoot, "hosts"),
    domain: domainDirectory,
    tls: tlsDirectory,
    registry: path.join(domainDirectory, "registry"),
    capsules: path.join(domainDirectory, "capsules"),
    ...(provided.directories ?? {}),
  };
  directories.incoming = provided.directories?.incoming ?? path.join(remoteRoot, "incoming");
  const tls = {
    mode: tlsMode,
    directory: provided.tls?.directory ?? directories.tls,
    certificate: tlsMode === "cloudflare-origin" ? (provided.tls?.certificate ?? path.join(directories.tls, "origin.crt")) : null,
    key: tlsMode === "cloudflare-origin" ? (provided.tls?.key ?? path.join(directories.tls, "origin.key")) : null,
  };
  return {
    substrate: {
      packages: provided.substrate?.packages ?? ["docker", "caddy"],
      services: provided.substrate?.services ?? ["docker", "caddy"],
    },
    directories,
    domainDirectory: provided.domainDirectory ?? directories.domain,
    tls,
    network: provided.network ?? HOSTED_CAPSULE_DOCKER_NETWORK,
    caddy: {
      caddyfile: path.join(directories.caddy, "Caddyfile"),
      managedInclude: provided.caddy?.managedInclude ?? path.join(directories.caddy, "sporades-hosted-domains.caddy"),
      domainInclude: provided.caddy?.domainInclude ?? path.join(directories.caddyHosts, `${domain}.caddy`),
      routesDirectory: path.join(directories.caddyHosts, domain),
      healthRoute: path.join(directories.caddyHosts, domain, "host.caddy"),
      accessLog: provided.caddy?.accessLog ?? defaultCaddyAccessLogPath(remoteRoot),
    },
  };
}

async function ensureBootstrapDirectories(bootstrap) {
  const directories = [
    bootstrap.directories.remoteRoot,
    bootstrap.directories.bin,
    bootstrap.directories.incoming,
    bootstrap.directories.caddy,
    path.dirname(bootstrap.caddy.accessLog),
    bootstrap.directories.caddyHosts,
    bootstrap.directories.hosts,
    bootstrap.directories.domain,
    bootstrap.directories.tls,
    bootstrap.directories.registry,
    path.join(bootstrap.directories.registry, "capsules"),
    bootstrap.directories.capsules,
    bootstrap.caddy.routesDirectory,
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }
}

async function provisionCaddyAccessLog(request, bootstrap) {
  const logFile = bootstrap.caddy.accessLog;
  const logDirectory = path.dirname(logFile);
  const caddyUser = resolveCaddyServiceUser();
  if (!caddyUser) {
    throw helperError(
      "Caddy service user could not be found.",
      "Install Caddy with its system service user available, then rerun `sporades host bootstrap`.",
    );
  }

  await mkdir(logDirectory, { recursive: true });
  await writeFile(logFile, "", { flag: "a" });
  await chmod(logDirectory, 0o750);
  await chmod(logFile, 0o640);
  const chown = spawnSync("chown", [`${caddyUser.uid}:${caddyUser.gid}`, logDirectory, logFile], { encoding: "utf8" });
  if (chown.error || chown.status !== 0) {
    throw helperError(
      "Failed to provision the Caddy access log for the service user.",
      `Ensure the Host helper runs with permission to chown ${logDirectory} and ${logFile}, then rerun \`sporades host bootstrap --host ${request.host.alias}\`.`,
    );
  }

  return {
    file: logFile,
    directory: logDirectory,
    owner: caddyUser.name,
    writableByService: true,
  };
}

async function provisionRouteLogFile(route) {
  const logFile = route.log?.file;
  if (!logFile) {
    return;
  }
  const logDirectory = path.dirname(logFile);
  await mkdir(logDirectory, { recursive: true });
  await writeFile(logFile, "", { flag: "a" });
  await chmod(logDirectory, 0o750);
  await chmod(logFile, 0o640);

  const caddyUser = resolveCaddyServiceUser();
  if (!caddyUser) {
    return;
  }
  const chown = spawnSync("chown", [`${caddyUser.uid}:${caddyUser.gid}`, logDirectory, logFile], { encoding: "utf8" });
  if (chown.error || chown.status !== 0) {
    throw helperError(
      "Failed to provision the Hosted Capsule HTTP log for the Caddy service user.",
      `Ensure the Host helper runs with permission to chown ${logDirectory} and ${logFile}, then retry the Hosted Capsule command.`,
    );
  }
}

function resolveCaddyServiceUser() {
  const user = spawnSync("id", ["-u", "caddy"], { encoding: "utf8" });
  const group = spawnSync("id", ["-g", "caddy"], { encoding: "utf8" });
  if (user.error || user.status !== 0 || group.error || group.status !== 0) {
    return null;
  }
  return { name: "caddy", uid: user.stdout.trim(), gid: group.stdout.trim() };
}

async function validateBootstrapTls(request, bootstrap) {
  if (bootstrap.tls.mode === "automatic") {
    return;
  }
  if (bootstrap.tls.mode !== "cloudflare-origin") {
    throw helperError(
      "Invalid Host TLS mode.",
      "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.",
    );
  }
  const readable = await Promise.all([
    pathReadable(bootstrap.tls.certificate),
    pathReadable(bootstrap.tls.key),
  ]);
  if (!readable.every(Boolean)) {
    throw helperError(
      "Cloudflare origin certificate material is missing or unusable.",
      `Install readable Cloudflare origin certificate and key files at ${bootstrap.tls.certificate} and ${bootstrap.tls.key}, then rerun \`sporades host bootstrap --host ${request.host.alias}\`.`,
    );
  }
}

function ensureDockerNetwork(networkName) {
  const inspect = spawnSync("docker", ["network", "inspect", networkName], { encoding: "utf8" });
  if (inspect.error) {
    throw helperError(
      "Docker is unavailable on the Host server.",
      "Install Docker, ensure the Docker daemon is running, then rerun `sporades host bootstrap`.",
    );
  }
  if (inspect.status === 0) {
    return { name: networkName, created: false };
  }

  const create = spawnSync("docker", ["network", "create", networkName], { encoding: "utf8" });
  if (create.error || create.status !== 0) {
    throw helperError(
      "Failed to create the Hosted Capsule Docker network.",
      `Check Docker on the Host server, then rerun \`sporades host bootstrap\`. Docker stderr: ${trimForHint(create.stderr)}`,
    );
  }
  return { name: networkName, created: true };
}

async function installCaddyBootstrapConfig(request, bootstrap) {
  const caddyfile = bootstrap.caddy.caddyfile;
  const managedInclude = bootstrap.caddy.managedInclude;
  const domainInclude = bootstrap.caddy.domainInclude;
  const placeholderRoute = path.join(bootstrap.caddy.routesDirectory, ".sporades-placeholder.caddy");
  await writeFile(placeholderRoute, "# Sporades keeps this placeholder so Caddy route imports are valid before Capsules are registered.\n");
  await writeFile(bootstrap.caddy.healthRoute, renderHostHealthRoute(request.host.domain, bootstrap.tls));
  await writeManagedCaddyfile(caddyfile, `import ${managedInclude}`);
  await writeFile(managedInclude, `# Sporades-managed Hosted domain include list.\nimport ${path.join(bootstrap.directories.caddyHosts, "*.caddy")}\n`);
  await writeFile(domainInclude, `# Sporades-managed routes for ${request.host.domain}.\nimport ${path.join(bootstrap.caddy.routesDirectory, "*.caddy")}\n`);

  validateCaddyBootstrap(caddyfile);
  reloadCaddyBootstrap(caddyfile);
  return {
    caddyfile,
    managedInclude,
    domainInclude,
    routesDirectory: bootstrap.caddy.routesDirectory,
    health: {
      hostname: `host.${request.host.domain}`,
      path: "/__sporades/health",
      url: `${request.host.scheme ?? "https"}://host.${request.host.domain}/__sporades/health`,
    },
    globalConfigReplaced: false,
    reloaded: true,
  };
}

function renderHostHealthRoute(domain, tls) {
  const route = {
    hostname: `host.${domain}`,
    tls,
  };
  return renderRoute(
    route,
    [
      "header /__sporades/health Content-Type application/json",
      'respond /__sporades/health "{\\"ok\\":true}" 200',
      "respond 404",
    ].join("\n  "),
  );
}

async function writeManagedCaddyfile(caddyfile, importLine) {
  const begin = "# BEGIN Sporades hosted domains";
  const end = "# END Sporades hosted domains";
  const block = `${begin}\n${importLine}\n${end}\n`;
  let existing = "";
  try {
    existing = await readFile(caddyfile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  let next;
  const markerPattern = new RegExp(`${escapeRegExp(begin)}\\n[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  if (markerPattern.test(existing)) {
    next = existing.replace(markerPattern, block);
  } else {
    const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    next = `${prefix}${existing ? "\n" : ""}${block}`;
  }
  await writeFile(caddyfile, next);
}

function validateCaddyBootstrap(caddyfile) {
  const result = spawnSync("caddy", ["validate", "--config", caddyfile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to validate the Sporades Caddy bootstrap configuration.",
      `Check Caddy on the Host server, then rerun \`sporades host bootstrap\`. Caddy stderr: ${trimForHint(result.stderr)}`,
    );
  }
}

function reloadCaddyBootstrap(caddyfile) {
  const result = spawnSync("caddy", ["reload", "--config", caddyfile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to reload the Sporades Caddy bootstrap configuration.",
      `Check the Host server Caddy service, then rerun \`sporades host bootstrap\`. Caddy stderr: ${trimForHint(result.stderr)}`,
    );
  }
}

function parsePair(value, parser) {
  const [left, right] = String(value ?? "").split("/").map((part) => part.trim());
  return [parser(left), parser(right)];
}

function parseDockerPercent(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDockerInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDockerByteSize(value) {
  const match = String(value ?? "").trim().match(/^([\d.]+)\s*([KMGTPE]?i?B|B)$/i);
  if (!match) {
    return null;
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    pb: 1_000_000_000_000_000,
    eb: 1_000_000_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
    eib: 1024 ** 6,
  };
  if (!multipliers[unit]) {
    return null;
  }
  return Math.round(amount * multipliers[unit]);
}

async function dockerRunArgs(lifecycle, releaseId) {
  const args = [
    "run",
    "--detach",
    "--name",
    lifecycle.container.name,
    "--network",
    lifecycle.container.network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=5",
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
  args.push("--publish", `127.0.0.1::${lifecycle.routes.running.port ?? 4000}`);
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
  return inspectContainerRunning(containerName).running;
}

function inspectContainerRunning(containerName) {
  const result = runDocker(["inspect", "-f", "{{.State.Running}}", containerName]);
  if (!result.ok) {
    return { ok: false, running: false };
  }
  const value = result.stdout.trim();
  return { ok: true, running: value === "true" };
}

function inspectLoopbackPublishedPort(containerName, containerPort) {
  const result = runDocker([
    "inspect",
    "-f",
    `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostIp}}:{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`,
    containerName,
  ]);
  if (!result.ok) {
    return null;
  }
  const match = result.stdout.trim().match(/^(127\.0\.0\.1):([1-9][0-9]*)$/);
  if (!match) {
    return null;
  }
  return {
    containerPort,
    hostIp: match[1],
    hostPort: Number(match[2]),
  };
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

function loopbackRunningRoute(route, publishedPort) {
  return {
    ...route,
    target: "loopback",
    upstream: `${publishedPort.hostIp}:${publishedPort.hostPort}`,
    publishedPort,
  };
}

async function writeRunningRoute(lifecycle, route = lifecycle.routes.running) {
  await provisionRouteLogFile(route);
  const proxyLine = `reverse_proxy ${route.upstream ?? `${route.containerName}:${route.port ?? 4000}`}`;
  await applyManagedRoute(
    lifecycle,
    route.routeFile,
    renderRoute(route, renderRunningRouteHandler(route, proxyLine)),
  );
}

function renderRunningRouteHandler(route, proxyLine) {
  const probe = route.runtimeProbe;
  if (!probe?.token || probe.header !== RUNTIME_PROBE_HEADER) {
    return proxyLine;
  }
  return [
    `@sporadesRuntimeHealth path ${CAPSULE_RUNTIME_HEALTH_PATH}`,
    "@sporadesRuntimeProbe {",
    `  path ${CAPSULE_RUNTIME_HEALTH_PATH}`,
    `  header ${RUNTIME_PROBE_HEADER} ${probe.token}`,
    "}",
    "handle @sporadesRuntimeProbe {",
    `  ${proxyLine}`,
    "}",
    "respond @sporadesRuntimeHealth 404",
    proxyLine,
  ].join("\n  ");
}

async function writeUnavailableRoute(lifecycle) {
  const route = lifecycle.routes.unavailable;
  await provisionRouteLogFile(route);
  await applyManagedRoute(
    lifecycle,
    route.routeFile,
    renderRoute(route, renderUnavailableRouteHandler(route)),
  );
}

function renderUnavailableRouteHandler(route) {
  return [
    `@sporadesRuntimeHealth path ${CAPSULE_RUNTIME_HEALTH_PATH}`,
    "respond @sporadesRuntimeHealth 404",
    `respond "Hosted Capsule unavailable" ${route.statusCode ?? 503}`,
  ].join("\n  ");
}

function renderRoute(route, handlerLine) {
  const tlsLine = renderRouteTlsLine(route.tls);
  const logBlock = renderRouteLogBlock(route.log);
  return `${route.hostname} {\n${tlsLine}${logBlock}  ${handlerLine}\n}\n`;
}

function renderRouteTlsLine(tls) {
  if (tls?.mode !== "cloudflare-origin") {
    return "";
  }
  return `  tls ${tls.certificate} ${tls.key}\n`;
}

function renderRouteLogBlock(log) {
  if (!log?.file) {
    return "";
  }
  return `  log {\n    output file ${log.file} {\n      roll_size 10MiB\n      roll_keep 5\n      roll_keep_for 720h\n    }\n  }\n`;
}

async function applyManagedRoute(lifecycle, routeFile, contents) {
  await mkdir(path.dirname(routeFile), { recursive: true });
  const tempRouteFile = `${routeFile}.tmp`;
  const previousRouteFile = `${routeFile}.previous-${process.pid}`;
  await rm(tempRouteFile, { force: true });
  await rm(previousRouteFile, { force: true });
  await writeFile(tempRouteFile, contents);
  try {
    validateCaddyRoute(tempRouteFile);
  } catch (error) {
    await rm(tempRouteFile, { force: true });
    throw error;
  }

  const hadPreviousRoute = await pathExists(routeFile);
  if (hadPreviousRoute) {
    await rename(routeFile, previousRouteFile);
  }

  try {
    await rename(tempRouteFile, routeFile);
    reloadCaddy(lifecycle);
  } catch (error) {
    await rm(routeFile, { force: true });
    if (hadPreviousRoute) {
      await rename(previousRouteFile, routeFile);
    }
    try {
      reloadCaddy(lifecycle);
    } catch (rollbackError) {
      throw helperError(
        "Failed to apply Hosted Capsule route and failed to reload the restored Caddy config.",
        "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry the lifecycle command.",
      );
    }
    throw error;
  }

  await rm(previousRouteFile, { force: true });
}

async function removeManagedRoute(lifecycle, routeFile) {
  const previousRouteFile = `${routeFile}.previous-${process.pid}`;
  await rm(previousRouteFile, { force: true });
  const hadRoute = await pathExists(routeFile);
  if (!hadRoute) {
    return { routeFile, removed: false };
  }

  await rename(routeFile, previousRouteFile);
  try {
    reloadCaddy(lifecycle);
  } catch (error) {
    await rename(previousRouteFile, routeFile);
    try {
      reloadCaddy(lifecycle);
    } catch {
      throw helperError(
        "Failed to remove Hosted Capsule route and failed to reload the restored Caddy config.",
        "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry unregister.",
      );
    }
    throw helperError(
      "Failed to remove Hosted Capsule route.",
      "The previous route file was restored. Check the Host server Caddy service and configuration, then retry unregister.",
    );
  }

  return { routeFile, removed: true, previousRouteFile };
}

async function finalizeRemovedRoute(route) {
  if (route?.previousRouteFile) {
    await rm(route.previousRouteFile, { force: true });
  }
}

async function restoreRemovedRoute(lifecycle, route) {
  if (!route?.previousRouteFile) {
    return;
  }
  await rm(route.routeFile, { force: true });
  await rename(route.previousRouteFile, route.routeFile);
  reloadCaddy(lifecycle);
}

async function removePathIfPresent(targetPath, options = {}) {
  const existed = await pathExists(targetPath);
  if (!existed) {
    return { path: targetPath, removed: false };
  }
  await rm(targetPath, { recursive: Boolean(options.recursive), force: true });
  return { path: targetPath, removed: true };
}

function validateCaddyRoute(routeFile) {
  const result = spawnSync("caddy", ["validate", "--config", routeFile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to validate Hosted Capsule route.",
      "Check the generated Caddy route for this Hosted Capsule, then retry the lifecycle command.",
    );
  }
}

function reloadCaddy(lifecycle) {
  const configPath = path.join(lifecycle.remoteRoot, "caddy", "Caddyfile");
  const result = spawnSync("caddy", ["reload", "--config", configPath, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to apply Hosted Capsule route.",
      "Check the Host server Caddy configuration, then retry the lifecycle command.",
    );
  }
}

async function updateRegistryStatus(request, status) {
  await mutateRegistryRecord(request, (record) => {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return record;
  });
}

async function recordFailedStartAndUnavailableRoute(request, lifecycle, releaseId, failureMessage) {
  try {
    await writeUnavailableRoute(lifecycle);
  } catch (error) {
    await recordReleaseFailure(request, releaseId, error?.message ?? "Failed to apply Hosted Capsule route.");
    throw error;
  }
  await recordReleaseFailure(request, releaseId, failureMessage);
}

async function recordReleaseUploaded(request, release) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: release.id };
    record.status = "released";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, release.id, (entry) => ({
      ...entry,
      id: release.id,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? now,
      state: "uploaded",
      current: true,
      source: {
        ...(entry.source ?? {}),
        hostedUrl: release.hostedUrl ?? entry.source?.hostedUrl ?? null,
        remoteCapsuleId: release.remoteCapsuleId ?? entry.source?.remoteCapsuleId ?? null,
        files: Array.isArray(release.files) ? [...release.files] : [],
        serverEnvIncluded: Boolean(release.serverEnvIncluded),
      },
    }));
    return record;
  });
}

async function recordReleaseStartAttempt(request, releaseId) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? record.currentRelease?.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      current: true,
      startAttempts: [...normaliseReleaseEventList(entry.startAttempts), { startedAt: now }],
    }));
    return record;
  });
}

async function recordReleaseStarted(request, releaseId) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "running";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      state: "started",
      current: true,
      failure: null,
    }));
    return record;
  });
}

async function recordReleaseVerified(request, releaseId) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "running";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      state: "verified",
      current: true,
      verificationAttempts: [...normaliseReleaseEventList(entry.verificationAttempts), { verifiedAt: now }],
      failure: null,
    }));
    return record;
  });
}

async function recordReleaseVerificationFailed(request, releaseId, message) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.status = "failed";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      state: "failed",
      current: (record.currentRelease?.id ?? null) === releaseId,
      verificationAttempts: [
        ...normaliseReleaseEventList(entry.verificationAttempts),
        { failedAt: now, failure: { message } },
      ],
      failure: {
        failedAt: now,
        message,
      },
    }));
    return record;
  });
}

async function recordReleaseFailure(request, releaseId, message) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.status = "failed";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      state: "failed",
      current: (record.currentRelease?.id ?? null) === releaseId,
      failure: {
        failedAt: now,
        message,
      },
    }));
    return record;
  });
}

async function recordReleaseRollbackSelected(request, releaseId) {
  await mutateRegistryRecord(request, (record) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "released";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry) => ({
      ...entry,
      id: releaseId,
      createdAt: entry.createdAt ?? now,
      uploadedAt: entry.uploadedAt ?? null,
      current: true,
      failure: null,
    }));
    return record;
  });
}

function upsertReleaseEntry(record, releaseId, mutateEntry) {
  const releases = normaliseReleaseHistory(record);
  const existing = releases.find((release) => release.id === releaseId) ?? createLegacyReleaseEntry(releaseId, record);
  const next = mutateEntry(existing);
  const withoutRelease = releases.filter((release) => release.id !== releaseId);
  return [...withoutRelease, next].map((release) => markCurrentReleaseEntry(release, releaseId));
}

function normaliseReleaseHistory(record) {
  const currentReleaseId = record?.currentRelease?.id ?? null;
  const releases = Array.isArray(record?.releases)
    ? record.releases
        .filter((release) => release && typeof release === "object" && typeof release.id === "string" && release.id.length > 0)
        .map((release) => normaliseReleaseEntry(release, currentReleaseId))
    : [];
  if (releases.length === 0 && currentReleaseId) {
    releases.push(createLegacyReleaseEntry(currentReleaseId, record));
  }
  const seen = new Set();
  return releases.filter((release) => {
    if (seen.has(release.id)) {
      return false;
    }
    seen.add(release.id);
    return true;
  });
}

function normaliseReleaseEntry(release, currentReleaseId) {
  const state = ["uploaded", "started", "verified", "failed"].includes(release.state) ? release.state : "uploaded";
  return {
    id: release.id,
    createdAt: typeof release.createdAt === "string" ? release.createdAt : null,
    uploadedAt: typeof release.uploadedAt === "string" ? release.uploadedAt : null,
    state,
    current: release.id === currentReleaseId,
    source: normaliseReleaseSource(release.source),
    startAttempts: normaliseReleaseEventList(release.startAttempts),
    verificationAttempts: normaliseReleaseEventList(release.verificationAttempts),
    failure: normaliseReleaseFailure(release.failure),
  };
}

function createLegacyReleaseEntry(releaseId, record) {
  return {
    id: releaseId,
    createdAt: typeof record?.currentRelease?.createdAt === "string" ? record.currentRelease.createdAt : null,
    uploadedAt: null,
    state: "uploaded",
    current: true,
    source: normaliseReleaseSource(record?.currentRelease?.source),
    startAttempts: [],
    verificationAttempts: [],
    failure: null,
    legacy: true,
  };
}

function markCurrentReleaseEntry(release, currentReleaseId) {
  return {
    ...release,
    current: release.id === currentReleaseId,
  };
}

function normaliseReleaseSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  );
}

function normaliseReleaseEventList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((event) => event && typeof event === "object" && !Array.isArray(event));
}

function normaliseReleaseFailure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    failedAt: typeof value.failedAt === "string" ? value.failedAt : null,
    message: typeof value.message === "string" ? value.message : "Hosted Capsule release failed.",
  };
}

function compareReleasesNewestFirst(left, right) {
  return String(right.createdAt ?? right.id).localeCompare(String(left.createdAt ?? left.id)) || right.id.localeCompare(left.id);
}

async function readRegistryRecordForCapsule(request, purpose) {
  const registryRecordPath = registryPath(request);
  try {
    return JSON.parse(await readFile(registryRecordPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw helperError(
        "Hosted Capsule is not registered.",
        missingCapsuleHint(request, purpose),
      );
    }
    if (error instanceof SyntaxError) {
      throw helperError(
        "Hosted Capsule registry record is invalid.",
        "Repair the Host server registry record before retrying the command.",
      );
    }
    throw error;
  }
}

async function readOptionalRegistryRecordForCapsule(request) {
  try {
    return await readRegistryRecordForCapsule(request, "delete");
  } catch (error) {
    if (error.message === "Hosted Capsule is not registered.") {
      return null;
    }
    throw error;
  }
}

function assertRegistryRecordMatchesRequest(request, record) {
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

async function mutateRegistryRecord(request, mutate) {
  return withRegistryLock(request, async () => {
    const registryRecordPath = registryPath(request);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    await writeRegistryRecordAtomic(registryRecordPath, mutate(record));
  });
}

async function writeRegistryRecordAtomic(registryRecordPath, record) {
  const tempPath = `${registryRecordPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    if (process.env.SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE === "1") {
      throw helperError(
        "Failed to write Hosted Capsule registry record.",
        "Check Host server disk permissions and free space, then retry the command.",
      );
    }
    await rename(tempPath, registryRecordPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function withRegistryLock(request, fn) {
  const lockDir = registryLockPath(request);
  const timeoutMs = Number(process.env.SPORADES_REGISTRY_LOCK_TIMEOUT_MS ?? "5000");
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw helperError(
          "Hosted domain registry is locked.",
          "Wait for the other Host server operation to finish, then retry the command.",
        );
      }
      await delay(25);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
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

function registryLockPath(request) {
  return path.join(request.host.remoteRoot, "hosts", request.host.domain, "registry", ".lock");
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
  const mode = mount.mode === "ro" ? ":ro" : mount.mode === "rw" ? ":rw" : "";
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

async function pathReadable(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readManagedCaddyAccessLog(logs) {
  const readable = await pathReadable(logs.file);
  if (!readable) {
    if (logs.explicitFile) {
      throw helperError(
        "Host server Caddy combined logs are unavailable.",
        `Check that ${logs.file} exists and is readable by the Host helper, then retry \`sporades host logs\`.`,
      );
    }
    return null;
  }
  const contents = await readFile(logs.file, "utf8");
  return lastLogEntries(contents, logs.lines);
}

function readCaddyJournalLogs(logs) {
  const result = spawnSync("journalctl", ["-u", "caddy", "-n", String(logs.lines), "--no-pager", "-o", "cat"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return lastLogEntries(result.stdout ?? "", logs.lines);
}

function readDockerStreamLogs(logs) {
  const result = spawnSync("docker", ["logs", "--tail", String(logs.lines), logs.container.name], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Hosted Capsule container logs are unavailable.",
      `Check that Docker container ${logs.container.name} still exists, then retry \`sporades host logs ${logs.source}\`.`,
    );
  }
  return lastLogEntries(logs.source === "stdout" ? result.stdout : result.stderr, logs.lines);
}

function lastLogEntries(contents, lines) {
  return String(contents ?? "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-lines);
}

function unavailableCaddyLogsError(request) {
  return helperError(
    "Host server Caddy combined logs are unavailable.",
    `Run \`sporades host bootstrap --host ${request.host.alias}\` and check Caddy on the Host server.`,
  );
}

function unavailableCapsuleHttpLogsError(logs) {
  return helperError(
    "Hosted Capsule HTTP logs are unavailable.",
    `Check that ${logs.file} exists and is readable, then retry \`sporades host logs http --subname ${logs.subname}\`.`,
  );
}

function trimForHint(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "no stderr output";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createHostedContainerName(domain, subname) {
  return `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
}

function defaultCaddyAccessLogPath(remoteRoot) {
  return path.join(remoteRoot, "caddy", "logs", "access.log");
}

function defaultCapsuleHttpLogPath(remoteRoot, domain, subname) {
  return path.join(remoteRoot, "hosts", domain, "capsules", subname, "logs", "http.log");
}

function validateReleaseArchive(request) {
  const release = request.release;
  const entries = listArchiveEntries(release.remoteArchive);
  const expectedFiles = expectedReleaseFiles(release);
  const allNames = entries.map((entry) => normaliseArchiveEntryName(entry.name));
  const runtimeEntries = entries.filter((entry) => !isDiscardableArchiveMetadata(entry.name));
  const actualNames = runtimeEntries.map((entry) => normaliseArchiveEntryName(entry.name));

  if (entries.some((entry) => !isSafeArchiveEntryType(entry))) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe entries.",
      "Push again so Sporades can package regular runtime files only.",
    );
  }
  if (allNames.some((name) => !isSafeArchiveEntryName(name))) {
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

async function removeDiscardedArchiveMetadata(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === "__MACOSX" || entry.name.startsWith("._")) {
      await rm(entryPath, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await removeDiscardedArchiveMetadata(entryPath);
    }
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

async function assertRollbackReleaseFiles(request, releaseDirectory) {
  const requiredFiles = ["server.mjs", "client.js", "index.html", "sporades.json"];
  for (const file of requiredFiles) {
    if (!(await pathReadable(path.join(releaseDirectory, file)))) {
      throw helperError(
        "Hosted Capsule release files are missing.",
        `The recorded release cannot be started from ${releaseDirectory}. Push a new release or choose another release from \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\`.`,
      );
    }
  }
}

function normaliseArchiveEntryName(name) {
  return String(name).replace(/^\.\//, "").replace(/\/+$/, "");
}

function isDiscardableArchiveMetadata(name) {
  const normalisedName = normaliseArchiveEntryName(name);
  return normalisedName === "__MACOSX" || normalisedName.startsWith("__MACOSX/") || normalisedName.startsWith("._");
}

function isSafeArchiveEntryType(entry) {
  if (entry.type === "-") {
    return true;
  }
  return entry.type === "d" && isDiscardableArchiveMetadata(entry.name);
}

function isSafeArchiveEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\0")) {
    return false;
  }
  return name.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

async function verifyRegisteredCapsule(request, purpose = "push") {
  const record = await readRegistryRecordForCapsule(request, purpose);
  assertRegistryRecordMatchesRequest(request, record);
  if (record.status === "unregistered") {
    throw helperError(
      "Hosted Capsule is unregistered.",
      `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before retrying this command.`,
    );
  }
  return record;
}

function missingCapsuleHint(request, purpose) {
  if (purpose === "push") {
    return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before pushing a release.`;
  }
  if (purpose === "stats") {
    return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before reading stats.`;
  }
  if (purpose === "unregister") {
    return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before unregistering the Hosted Capsule.`;
  }
  return `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before managing the Hosted Capsule lifecycle.`;
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

function validateStatsRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule stats request.", "Update the Sporades CLI and retry the host stats command.");
  }
}

function validateReleaseListRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule releases request.", "Update the Sporades CLI and retry `sporades host releases`.");
  }
}

function validateHealthRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule health request.", "Update the Sporades CLI and retry the host health command.");
  }
}

function validateHostStatsRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Host stats request.", "Update the Sporades CLI and retry `sporades host stats`.");
  }
}

function validateRollbackRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
    request.rollback?.releaseId,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule rollback request.", "Update the Sporades CLI and retry `sporades host rollback`.");
  }
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(request.rollback.releaseId)) {
    throw helperError(
      "Invalid Hosted Capsule release ID.",
      `Choose a recorded release ID from \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\`.`,
    );
  }
}

function validateHostLogsRequest(request) {
  const requiredStrings = [
    request.host?.alias,
    request.host?.domain,
    request.host?.remoteRoot,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Host logs request.", "Update the Sporades CLI and retry `sporades host logs`.");
  }
  const source = request.logs?.source ?? "caddy-combined";
  if (!["http", "caddy-combined", "stdout", "stderr"].includes(source)) {
    throw helperError(
      "Invalid Host log source.",
      "Use `http`, `stdout`, or `stderr` for `sporades host logs`.",
    );
  }
  if ((source === "stdout" || source === "stderr") && (typeof request.capsule?.subname !== "string" || request.capsule.subname.length === 0)) {
    throw helperError(
      "Missing Capsule subname for container logs.",
      "Pass `--subname <capsule-subname>` or run the command from a project with a Hosted Capsule binding.",
    );
  }
  const lines = request.logs?.lines ?? DEFAULT_HOST_LOG_LINES;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_HOST_LOG_LINES) {
    throw helperError(
      "Invalid Host log line count.",
      `Pass \`--lines <n>\` with a whole number between 1 and ${MAX_HOST_LOG_LINES}.`,
    );
  }
}

function validateListRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule list request.", "Update the Sporades CLI and retry `sporades host list`.");
  }
}

function validateListRegistryRecord(request, record, recordPath) {
  const expectedSubname = path.basename(recordPath, ".json");
  const expectedRemoteCapsuleId = `${request.host.domain}/${record?.subname ?? expectedSubname}`;
  const valid =
    record &&
    typeof record.subname === "string" &&
    record.subname.length > 0 &&
    record.subname === expectedSubname &&
    record.domain === request.host.domain &&
    (record.remoteCapsuleId ?? expectedRemoteCapsuleId) === expectedRemoteCapsuleId;
  if (!valid) {
    throw helperError(
      "Hosted Capsule registry record is invalid.",
      `Repair the Host server registry record at ${recordPath}, then retry \`${hostRegistryRetryCommand(request)}\`.`,
    );
  }
}

function validateBootstrapRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Host bootstrap request.", "Update the Sporades CLI and retry `sporades host bootstrap`.");
  }
  const tlsMode = request.bootstrap?.tls?.mode ?? "automatic";
  if (tlsMode !== "automatic" && tlsMode !== "cloudflare-origin") {
    throw helperError(
      "Invalid Host TLS mode.",
      "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.",
    );
  }
}

function validateRegisterRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule registration request.", "Update the Sporades CLI and retry `sporades host register`.");
  }
  const registration = request.registration ?? {};
  const mismatchedIdentity =
    (registration.subname && registration.subname !== request.capsule.subname) ||
    (registration.domain && registration.domain !== request.host.domain) ||
    (registration.remoteCapsuleId && registration.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
  if (mismatchedIdentity) {
    throw helperError(
      "Hosted Capsule registration request does not match the Host profile.",
      "Rebind the local project or pass the correct Host profile and Capsule subname.",
    );
  }
  const tlsMode = request.registration?.bootstrap?.tls?.mode ?? request.bootstrap?.tls?.mode ?? "automatic";
  if (tlsMode !== "automatic" && tlsMode !== "cloudflare-origin") {
    throw helperError(
      "Invalid Host TLS mode.",
      "Use `--tls automatic` for Caddy-managed certificates or `--tls cloudflare-origin` for preinstalled Cloudflare origin certificates.",
    );
  }
}

function validateUnregisterRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule unregister request.", "Update the Sporades CLI and retry `sporades host unregister`.");
  }
  const unregister = request.unregister ?? {};
  const mismatchedIdentity =
    (unregister.subname && unregister.subname !== request.capsule.subname) ||
    (unregister.domain && unregister.domain !== request.host.domain) ||
    (unregister.remoteCapsuleId && unregister.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
  if (mismatchedIdentity) {
    throw helperError(
      "Hosted Capsule unregister request does not match the Host profile.",
      "Rebind the local project or pass the correct Host profile and Capsule subname.",
    );
  }
}

function validateDeleteRequest(request) {
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid Hosted Capsule delete request.", "Update the Sporades CLI and retry `sporades host delete`.");
  }
  const deletion = request.delete ?? {};
  const mismatchedIdentity =
    (deletion.subname && deletion.subname !== request.capsule.subname) ||
    (deletion.domain && deletion.domain !== request.host.domain) ||
    (deletion.remoteCapsuleId && deletion.remoteCapsuleId !== `${request.host.domain}/${request.capsule.subname}`);
  if (mismatchedIdentity) {
    throw helperError(
      "Hosted Capsule delete request does not match the Host profile.",
      "Rebind the local project or pass the correct Host profile and Capsule subname.",
    );
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
