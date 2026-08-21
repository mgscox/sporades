#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream, statSync } from "node:fs";
import { access, chmod, chown, lstat, mkdir, readdir, readFile, readlink, rename, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import {
  SPORADES_BASE_IMAGE,
  baseImageLabels,
  baseImageMetadata,
  baseImageRuntimeUser,
  normaliseBaseImageUpdatePolicy,
} from "../base-image.js";
import type { DockerRestartPolcy } from "../runtime-restart-policy.js";
import { restartPolicyForMode, restartPolicyStatus } from "../runtime-restart-policy.js";
import { normalizePublicTreePath, validatePublicTreeFileSet } from "../public-tree-contract.js";
import type {
  CommandResult,
  DockerPsContainerRaw,
  DockerStatsRaw,
  HostHelperCapsuleTarget,
  HostHelperEnvelope,
  HostHelperErrorBody,
  HostHelperRelease,
  HostHelperRequest as HostHelperContractRequest,
  HostBootstrapOptions,
  HostLogsOptions,
  HostedCapsuleBaseImage,
  HostedCapsuleLifecycle,
  HostedCapsuleRegistryRecord,
  HostedCapsuleReleaseEntry,
  HostedCapsuleRoute,
  JsonObject,
  JsonValue,
} from "./host-helper-contract.js";
import {
  createLogEnvelope,
  createPrivilegedAuditLogInput,
} from "../server-runtime-source.js";
import {
  delay,
  errorDetails,
  helperError,
  readStdin,
  writeEnvelope,
  type HelperError,
  type LooseRecord,
} from "./cli-support.js";
import { CLI_VERSION } from "./cli-version.js";
import { sanitizeScheduleInspectionEnvelope } from "./schedule-inspection-envelope.js";
import { sanitizeAccessKeyOperatorEnvelope, validateAccessKeyOperatorActionInput } from "./access-key-operator-envelope.js";
import { HOST_RELEASE_ARCHIVE_LIMITS, validateReleaseArchive, type ReleaseArchiveFile } from "./host-helper-archive.js";
import { defaultHostHelperConfig, loadHostHelperConfig, type HostHelperConfig } from "./host-helper-config.js";
import {
  hostRegistryRetryCommand,
  missingCapsuleHint,
  validateBootstrapRequest,
  validateDeleteRequest,
  validateHealthRequest,
  validateHostLogsRequest,
  validateHostStatsRequest,
  validateInstallRequest,
  validateLifecycleRequest,
  validateListRegistryRecord,
  validateListRequest,
  validateRegisterRequest,
  validateReleaseListRequest,
  validateScheduleInspectionRequest,
  validateRollbackRequest,
  validateSealedEnvRotationRequest,
  validateStatsRequest,
  validateUnregisterRequest,
} from "./host-helper-validation.js";

type HostHelperRequest = HostHelperContractRequest & {
  capsule: HostHelperCapsuleTarget;
  release: HostHelperRelease;
};
type ReleasePaths = {
  capsule: string;
  releases: string;
  release: string | null;
  data: string;
  logs: string;
  currentLink: string;
};
const CAPSULE_RUNTIME_HEALTH_PATH = "/__sporades/health/runtime";
const RUNTIME_PROBE_HEADER = "x-sporades-host-probe";

let hostHelperConfig: HostHelperConfig = defaultHostHelperConfig();
const HOSTED_ACCESS_KEY_ACTIONS = new Set([
  "access-keys.list", "access-keys.inspect", "access-keys.revoke", "access-keys.revoke-all", "access-keys.delete",
]);

main().catch((error: HelperError) => {
  writeEnvelope(
    {
      ok: false,
      data: null,
      error: {
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
        hint: error.hint ?? "Check the Host helper request and retry the command.",
        ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      },
    },
    false,
  );
});

async function main() {
  const request = JSON.parse(await readStdin()) as HostHelperRequest;
  if (request.action === "schedules.inspect") validateScheduleInspectionRequest(request);
  hostHelperConfig = await loadHostHelperConfig(request);
  if (request.action === "capsule.register") {
    await registerCapsule(request);
    return;
  }
  if (request.action === "capsule.sealed-env.rotate-key") {
    await rotateCapsuleSealedEnvKey(request);
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
  if (request.action === "capsule.ssh") {
    await inspectCapsuleSsh(request);
    return;
  }
  if (request.action === "capsule.health") {
    await healthCapsule(request);
    return;
  }
  if (request.action === "jobs.inspect") {
    inspectCapsuleJobs(request);
    return;
  }
  if (request.action === "schedules.inspect") {
    inspectCapsuleSchedules(request);
    return;
  }
  if (HOSTED_ACCESS_KEY_ACTIONS.has(request.action)) {
    runCapsuleAccessKeyAction(request);
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
  if (request.action === "host.version") {
    versionHost(request);
    return;
  }
  if (request.action === "host.bootstrap") {
    await bootstrapHost(request);
    return;
  }

  throw helperError("Unsupported Host helper action.", "Update the Host helper or use a supported Sporades host command.");
}

function inspectCapsuleJobs(request: HostHelperRequest) {
  inspectCapsuleRuntime(request, "jobs.inspect", "Job");
}

function inspectCapsuleSchedules(request: HostHelperRequest) {
  validateScheduleInspectionRequest(request);
  inspectCapsuleRuntime(request, "schedules.inspect", "Schedule", (envelope) => sanitizeScheduleInspectionEnvelope(envelope, () => {
    throw helperError("Hosted Schedule inspection returned an invalid response.", "Run `sporades host upgrade`, redeploy the Capsule, and retry the command.");
  }), [], true);
}

function runCapsuleAccessKeyAction(request: HostHelperRequest) {
  const exactKeys = (value: LooseRecord, keys: string[]) => Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
  if (!exactKeys(request, ["action", "host", "capsule", "accessKeys"])
    || !request.host || typeof request.host !== "object" || Array.isArray(request.host)
    || !exactKeys(request.host, ["alias", "domain", "scheme", "remoteRoot"])
    || !request.capsule || typeof request.capsule !== "object" || Array.isArray(request.capsule)
    || !exactKeys(request.capsule, ["subname"])) {
    throw Object.assign(helperError("Invalid Hosted Access-key action request.", "Upgrade the local Sporades CLI and Host helper together."), { code: "INVALID_ACCESS_KEY_ACTION_INPUT" });
  }
  const accessKeys = validateAccessKeyOperatorActionInput(request.action, request.accessKeys, () => {
    throw Object.assign(helperError("Invalid Hosted Access-key action request.", "Upgrade the local Sporades CLI and Host helper together."), { code: "INVALID_ACCESS_KEY_ACTION_INPUT" });
  });
  inspectCapsuleRuntime(request, request.action, "Access-key", (envelope) => sanitizeAccessKeyOperatorEnvelope(envelope, request.action, accessKeys, () => {
    throw Object.assign(helperError("Hosted Access-key action returned an invalid response.", "Run `sporades host upgrade`, redeploy the Capsule, and retry the command."), { code: "HOSTED_ACCESS_KEY_RESPONSE_INVALID" });
  }), [
    "--sporades-action-input",
    Buffer.from(JSON.stringify(accessKeys), "utf8").toString("base64url"),
  ]);
}

function inspectCapsuleRuntime(request: HostHelperRequest, action: string, label: string, sanitize: (envelope: LooseRecord) => LooseRecord = (envelope) => envelope, extraArgs: string[] = [], preserveBoundedDiagnostics = false) {
  const containerName = createHostedContainerName(request.host.domain, request.capsule.subname);
  if (!checkContainerRunning(containerName)) {
    const error = helperError("The Hosted Capsule is not running.", `Run \`sporades host start ${request.capsule.subname} --host ${request.host.alias}\`, then retry the command.`);
    if (label === "Access-key") error.code = "HOSTED_CAPSULE_NOT_RUNNING";
    throw error;
  }
  const result = runDocker(["exec", containerName, "node", "/app/server.mjs", "--sporades-action", action, ...extraArgs]);
  let envelope: LooseRecord;
  try { envelope = JSON.parse(result.stdout.trim()); }
  catch { throw helperError(`Hosted ${label} inspection returned invalid JSON.`, "Run `sporades host upgrade`, redeploy the Capsule, and retry the command."); }
  const bounded = sanitize(envelope);
  if (!bounded.ok) {
    const error = helperError(bounded.error.message, bounded.error.hint, preserveBoundedDiagnostics ? bounded.error.diagnostics : undefined);
    if (label === "Access-key" && bounded.error.code) error.code = bounded.error.code;
    throw error;
  }
  writeEnvelope(bounded);
}

function versionHost(request: HostHelperRequest) {
  writeEnvelope({
    ok: true,
    data: {
      version: CLI_VERSION,
      source: "host",
      host: {
        alias: request.host.alias,
        domain: request.host.domain,
      },
    },
    error: null,
  });
}

async function bootstrapHost(request: HostHelperRequest) {
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

async function registerCapsule(request: HostHelperRequest) {
  validateRegisterRequest(request);
  const registration = normaliseRegistration(request);
  await ensureHostedDomainBootstrapped(request, registration);

  let reactivated = false;
  let sealedServerEnv = null;
  await mkdir(path.dirname(registryLockPath(request)), { recursive: true });
  await withRegistryLock(request, async () => {
    if (await pathExists(registration.registryRecord)) {
      const existing = await readRegistryRecordForCapsule(request, "register");
      assertRegistryRecordMatchesRequest(request, existing);
      if (existing.status === "unregistered") {
        await mkdir(path.dirname(registration.registryRecord), { recursive: true });
        await mkdir(registration.directories.releases, { recursive: true });
        await mkdir(registration.directories.data, { recursive: true });
        await writeUnavailableRoute(registration.lifecycle as unknown as HostedCapsuleLifecycle);
        sealedServerEnv = await ensureHostSealedEnvKeyPair(registration, existing);
        await writeRegistryRecordAtomic(registration.registryRecord, reactivateRegistrationRecord(existing, sealedServerEnv));
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
    await writeUnavailableRoute(registration.lifecycle as unknown as HostedCapsuleLifecycle);
    sealedServerEnv = await ensureHostSealedEnvKeyPair(registration);
    await writeRegistryRecordAtomic(registration.registryRecord, createRegistrationRecord(registration, sealedServerEnv));
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
      sealedServerEnv,
    },
    error: null,
  });
}

async function rotateCapsuleSealedEnvKey(request: HostHelperRequest) {
  validateSealedEnvRotationRequest(request);
  await mkdir(path.dirname(registryLockPath(request)), { recursive: true });

  let data;
  await withRegistryLock(request, async () => {
    const record = await readRegistryRecordForCapsule(request, "rotate-key");
    assertRegistryRecordMatchesRequest(request, record);
    if (record.status === "unregistered") {
      throw helperError(
        "Hosted Capsule is unregistered.",
        `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before rotating the sealed-env key.`,
      );
    }

    const dataDirectory = path.join(request.host.remoteRoot, "hosts", request.host.domain, "capsules", request.capsule.subname, "data");
    const previousPublicKeyFingerprint = record.sealedServerEnv?.currentKeyFingerprint ?? null;
    const sealedServerEnv = await generateHostSealedEnvKeyPair(dataDirectory);
    const now = new Date().toISOString();
    const nextRecord = {
      ...record,
      sealedServerEnv: { ...(record.sealedServerEnv ?? {}), currentKeyFingerprint: sealedServerEnv.publicKeyFingerprint },
      updatedAt: now,
    };
    await writeRegistryRecordAtomic(registryPath(request), nextRecord);

    const referenced = referencedSealedEnvKeyFingerprints(nextRecord);
    referenced.add(sealedServerEnv.publicKeyFingerprint);
    const cleanup = await cleanupUnreferencedHostSealedEnvKeys(dataDirectory, referenced);
    data = {
      rotated: true,
      capsule: {
        subname: request.capsule.subname,
        domain: request.host.domain,
        hostedUrl: record.hostedUrl ?? `${request.host.scheme ?? "https"}://${request.capsule.subname}.${request.host.domain}`,
        remoteCapsuleId: record.remoteCapsuleId ?? `${request.host.domain}/${request.capsule.subname}`,
      },
      sealedServerEnv: {
        previousPublicKeyFingerprint,
        publicKey: sealedServerEnv.publicKey,
        publicKeyFingerprint: sealedServerEnv.publicKeyFingerprint,
        publicKeyPath: sealedServerEnv.publicKeyPath,
      },
      cleanup,
    };
  });

  writeEnvelope({ ok: true, data, error: null });
}

async function unregisterCapsule(request: HostHelperRequest) {
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
    const route = await removeManagedRoute(unregister.lifecycle as HostedCapsuleLifecycle, unregister.route.routeFile);
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
      await restoreRemovedRoute(unregister.lifecycle as HostedCapsuleLifecycle, route);
      throw error;
    }
    await finalizeRemovedRoute(route);
    data = createUnregisterResult(request, unregister, nextRecord, false, route);
  });

  writeEnvelope({ ok: true, data, error: null });
}

async function deleteCapsule(request: HostHelperRequest) {
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
      reloadCaddy(deletion.lifecycle as HostedCapsuleLifecycle);
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

function deletionRequiresUnregisterError(request: HostHelperRequest) {
  return helperError(
    "Hosted Capsule must be unregistered before deletion.",
    `Run \`sporades host unregister ${request.capsule.subname} --host ${request.host.alias}\` before deleting Hosted Capsule storage.`,
  );
}

async function installRelease(request: HostHelperRequest) {
  validateInstallRequest(request);
  const previousRecord = await verifyRegisteredCapsule(request);
  const paths = canonicalReleasePaths(request);
  if (!paths.release) {
    throw helperError("Invalid release install request.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  const claimedArchive = await claimReleaseArchive(request);
  try {
    await installClaimedRelease(request, previousRecord, { ...paths, release: paths.release }, claimedArchive);
  } finally {
    await rm(claimedArchive.path, { force: true });
    await rm(request.release.remoteArchive, { force: true });
  }
}

async function installClaimedRelease(request: HostHelperRequest, previousRecord: any, paths: ReleasePaths & { release: string }, claimedArchive: { path: string; sha256: string }) {
  const release = request.release;
  const previousCurrentRelease = previousRecord.currentRelease?.id ? { id: previousRecord.currentRelease.id } : null;
  const validatedArchive = validateReleaseArchive(request, claimedArchive.path);
  await maybeSwapUnclaimedArchiveForTest(release);
  if (await releaseArchiveSha256(claimedArchive.path) !== claimedArchive.sha256) {
    throw helperError("Hosted Capsule release archive ownership changed.", "Upload the release again so the Host helper can claim immutable archive bytes.");
  }
  validateSealedServerEnvPrivateKeyPath(release, paths);
  await mkdir(paths.releases, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await prepareWritableDataPath(paths.data);
  await mkdir(paths.logs, { recursive: true });

  const tempReleaseDirectory = `${paths.release}.tmp-${process.pid}`;
  const tempCurrentLink = `${paths.currentLink}.tmp-${process.pid}`;
  await rm(tempReleaseDirectory, { recursive: true, force: true });
  await rm(tempCurrentLink, { force: true });
  await mkdir(tempReleaseDirectory, { recursive: true });

  const extract = spawnSync("tar", ["-xzf", claimedArchive.path, "-C", tempReleaseDirectory], {
    encoding: "utf8",
  });
  if (extract.error || extract.status !== 0) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    throw helperError(
      "Failed to extract Hosted Capsule release archive.",
      "Upload the release again with `sporades host push` and check that tar is installed on the Host server.",
    );
  }
  let installedInventory: ReleaseFileIdentity[];
  try {
    installedInventory = await validateExtractedReleaseTree(tempReleaseDirectory, validatedArchive.files);
    if (await releaseArchiveSha256(claimedArchive.path) !== claimedArchive.sha256) {
      throw helperError("Hosted Capsule release archive ownership changed.", "Upload the release again so the Host helper can claim immutable archive bytes.");
    }
  } catch (error) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    throw error;
  }

  try {
    await rename(tempReleaseDirectory, paths.release);
  } catch (error) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    const details = errorDetails(error);
    if (details.code === "EEXIST" || details.code === "ENOTEMPTY") {
      throw helperError(
        "Hosted Capsule release already exists.",
        "Push again to generate a fresh immutable release ID.",
      );
    }
    throw error;
  }

  await symlink(paths.release, tempCurrentLink);
  await rename(tempCurrentLink, paths.currentLink);
  await installSealedServerEnvPrivateKey(release);
  await recordReleaseUploaded(request, release, installedInventory);

  let restartResult = null;
  let restartError = null;
  if (release.restart) {
    try {
      restartResult = await restartCapsule(request, { write: false });
    } catch (error) {
      restartError = error;
    }
  }

  const data: LooseRecord = {
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
      ...(release.sealedServerEnvIncluded ? { sealedServerEnvIncluded: true } : {}),
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
        message: errorDetails(restartError).message ?? "Hosted Capsule restart failed.",
        hint:
          errorDetails(restartError).hint ??
          `Check Docker logs for ${normaliseLifecycle(request).container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
      },
    });
    return;
  }
  writeEnvelope({ ok: true, data, error: null });
}

type ReleaseFileIdentity = ReleaseArchiveFile & { sha256: string };

async function claimReleaseArchive(request: HostHelperRequest) {
  const expectedIncoming = path.join(request.host.remoteRoot, "incoming", `${request.release.id}.tar.gz`);
  if (path.resolve(request.release.remoteArchive) !== path.resolve(expectedIncoming)) {
    throw helperError("Invalid release install request.", "Upload the release to the canonical Host incoming path and retry `sporades host push`.");
  }
  const claimsDirectory = path.join(request.host.remoteRoot, ".release-claims");
  await mkdir(claimsDirectory, { recursive: true, mode: 0o700 });
  const claimsStats = await lstat(claimsDirectory);
  if (!claimsStats.isDirectory() || claimsStats.isSymbolicLink() || (typeof process.getuid === "function" && claimsStats.uid !== process.getuid())) {
    throw helperError("Hosted Capsule release claim directory is unsafe.", "Repair Host helper ownership of the release claim directory and retry.");
  }
  await chmod(claimsDirectory, 0o700);
  const claimedPath = path.join(claimsDirectory, `${request.release.id}-${process.pid}-${randomBytes(16).toString("hex")}.tar.gz`);
  await rename(request.release.remoteArchive, claimedPath);
  try {
    const stats = await lstat(claimedPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > HOST_RELEASE_ARCHIVE_LIMITS.compressedBytes) {
      throw helperError("Hosted Capsule release archive is unsafe.", "Upload one bounded regular archive file and retry `sporades host push`.");
    }
    await chmod(claimedPath, 0o600);
    return { path: claimedPath, sha256: await releaseArchiveSha256(claimedPath) };
  } catch (error) {
    await rm(claimedPath, { force: true });
    throw error;
  }
}

async function releaseArchiveSha256(archivePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(archivePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function maybeSwapUnclaimedArchiveForTest(release: HostHelperRelease) {
  const replacement = process.env.SPORADES_TEST_HOST_ARCHIVE_SWAP_PATH;
  if (!replacement) return;
  await rename(replacement, release.remoteArchive);
}

async function validateExtractedReleaseTree(root: string, expectedFiles: ReleaseArchiveFile[]) {
  const expected = new Map(expectedFiles.map((file) => [file.path, file]));
  const canonical = new Set<string>();
  const actual: ReleaseFileIdentity[] = [];
  let totalBytes = 0;
  const publicClaims: Array<{ path: string; size: number }> = [];

  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const normalized = relative.normalize("NFC");
      const safe = relative.length > 0
        && !relative.startsWith("/")
        && !relative.includes("\\")
        && !relative.includes("\0")
        && path.posix.normalize(relative) === relative
        && Buffer.byteLength(relative, "utf8") <= HOST_RELEASE_ARCHIVE_LIMITS.pathBytes
        && relative.split("/").every((segment) => segment && segment !== "." && segment !== "..");
      if (!safe || canonical.has(normalized)) {
        throw helperError("Extracted Hosted Capsule release is unsafe.", "Upload a release with unique bounded relative paths.");
      }
      canonical.add(normalized);
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw helperError("Extracted Hosted Capsule release is unsafe.", "Upload regular release files without symbolic links.");
      }
      if (stats.isDirectory()) {
        if (![...expected.keys()].some((file) => file.startsWith(`${relative}/`))) {
          throw helperError("Extracted Hosted Capsule release does not match its archive.", "Upload the release again from a clean normalized Bundle.");
        }
        await visit(entryPath, relative);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw helperError("Extracted Hosted Capsule release is unsafe.", "Upload regular single-link release files only.");
      }
      if (stats.size > HOST_RELEASE_ARCHIVE_LIMITS.fileBytes) {
        throw helperError("Extracted Hosted Capsule release exceeds bounds.", "Choose another bounded release or push a replacement.");
      }
      const claimed = expected.get(relative);
      if (!claimed || claimed.size !== stats.size) {
        throw helperError("Extracted Hosted Capsule release does not match its archive.", "Upload the release again from a clean normalized Bundle.");
      }
      totalBytes += stats.size;
      if (relative.startsWith("public/")) {
        const publicPath = relative.slice("public/".length);
        if (normalizePublicTreePath(publicPath) === null) {
          throw helperError("Extracted Hosted Capsule public tree exceeds bounds.", "Reduce public paths and files, then push again.");
        }
        publicClaims.push({ path: publicPath, size: stats.size });
      }
      actual.push({ path: relative, size: stats.size, sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex") });
    }
  }

  await visit(root);
  const publicValidation = validatePublicTreeFileSet(publicClaims);
  if (actual.length !== expected.size || actual.length > HOST_RELEASE_ARCHIVE_LIMITS.entries || totalBytes > HOST_RELEASE_ARCHIVE_LIMITS.totalBytes || !publicValidation.ok) {
    throw helperError("Extracted Hosted Capsule release does not match its bounded archive.", "Upload the release again from a clean normalized Bundle.");
  }
  return actual.sort((left, right) => left.path.localeCompare(right.path));
}

function isVerificationRequested(request: HostHelperRequest) {
  return request.verification?.enabled === true;
}

async function verifyInstalledRelease(request: HostHelperRequest, release: HostHelperRelease, installData: any, previousCurrentRelease: any, restartResult: any, restartError: any) {
  const currentAttemptedRelease = { id: release.id };
  const baseData = {
    ...installData,
    previousCurrentRelease,
    currentAttemptedRelease,
  };
  if (!restartResult) {
    const fallback = await maybeFallbackToPreviousRelease(request, release.id, previousCurrentRelease, restartError?.message ?? "Hosted Capsule restart failed.");
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
        fallback,
      },
      restartError?.message ?? "Hosted Capsule restart failed.",
    );
  }

  const timeoutMs = readVerificationHealthTimeoutMs(request);
  const publicResult = await verifyInstalledPublicTree(request, timeoutMs);
  if (!publicResult.ok) {
    const publicFailure = publicResult.error?.message ?? "Hosted Capsule installed public tree verification failed.";
    await routeVerifiedFailureToUnavailable(request, release.id, publicFailure);
    const fallback = await maybeFallbackToPreviousRelease(request, release.id, previousCurrentRelease, publicFailure);
    return verificationFailureResult(
      request,
      release.id,
      {
        ...baseData,
        verified: false,
        verification: { state: "failed", health: { public: publicResult.data, route: { url: publicResult.data.url, responding: false }, runtime: null, failure: "route-failure" } },
        fallback,
      },
      publicFailure,
    );
  }

  const healthResult = await evaluateCapsuleHealth(request, { timeoutMs });
  if (!healthResult.ok) {
    await routeVerifiedFailureToUnavailable(request, release.id, healthResult.error?.message ?? "Hosted Capsule release verification failed.");
    const fallback = await maybeFallbackToPreviousRelease(
      request,
      release.id,
      previousCurrentRelease,
      healthResult.error?.message ?? "Hosted Capsule release verification failed.",
    );
    return verificationFailureResult(
      request,
      release.id,
      {
        ...baseData,
        verified: false,
        verification: {
          state: "failed",
          health: { ...verificationHealthSummary(healthResult), public: publicResult.data },
        },
        fallback,
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
        health: { ...verificationHealthSummary(healthResult), public: publicResult.data },
      },
    },
    error: null,
  };
}

async function verifyInstalledPublicTree(request: HostHelperRequest, timeoutMs: number) {
  const url = new URL("/", `${request.host.scheme ?? "https"}://${request.capsule.subname}.${request.host.domain}`).toString();
  try {
    const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.toLowerCase().startsWith("text/html")) {
      return {
        ok: false,
        data: { url, path: "/", responding: response.ok, statusCode: response.status, html: false },
        error: { message: "Hosted Capsule installed public tree did not serve its HTML entry." },
      };
    }
    await response.body?.cancel();
    return { ok: true, data: { url, path: "/", responding: true, statusCode: response.status, html: true } };
  } catch {
    return {
      ok: false,
      data: { url, path: "/", responding: false, statusCode: null, html: false },
      error: { message: "Hosted Capsule installed public tree did not respond." },
    };
  }
}

function readVerificationHealthTimeoutMs(request: HostHelperRequest) {
  const value = Number(request.verification?.healthTimeoutMs ?? 10_000);
  if (!Number.isFinite(value) || value < 1) {
    return 10_000;
  }
  return Math.min(value, 60_000);
}

async function routeVerifiedFailureToUnavailable(request: HostHelperRequest, releaseId: string, message: string) {
  const lifecycle = normaliseLifecycle(request);
  stopAndRemoveContainer(lifecycle.container.name);
  try {
    await writeUnavailableRoute(lifecycle);
  } finally {
    await recordReleaseVerificationFailed(request, releaseId, message);
  }
}

async function maybeFallbackToPreviousRelease(request: HostHelperRequest, failedReleaseId: string, previousCurrentRelease: any, reason: string) {
  if (request.verification?.fallbackToPreviousRelease !== true || !previousCurrentRelease?.id) {
    return {
      applied: false,
      reason: request.verification?.fallbackToPreviousRelease === true ? "no-previous-release" : "not-configured",
    };
  }

  const releaseId = previousCurrentRelease.id;
  const paths = canonicalRollbackPaths(request, releaseId);
  try {
    const record = await readRegistryRecordForCapsule(request, "rollback");
    const recordedRelease = normaliseReleaseHistory(record).find((entry: HostHelperRelease) => entry.id === releaseId) ?? null;
    await assertRollbackReleaseFiles(request, paths.release, recordedRelease);
    await switchCurrentReleaseLink(paths.currentLink, paths.release);
    let lifecycle = null;
    let restartError = null;
    try {
      lifecycle = await restartCapsule(request, { write: false });
    } catch (error) {
      restartError = error;
    }
    if (!lifecycle) {
      await restoreFailedReleaseAfterFallbackRestartFailure(request, failedReleaseId, releaseId, reason, restartError);
      return {
        applied: false,
        reason: "fallback-restart-failed",
        release: { id: releaseId },
        error: restartError ? { message: errorDetails(restartError).message, hint: errorDetails(restartError).hint ?? null } : null,
      };
    }
    await recordReleaseVerificationFallback(request, failedReleaseId, releaseId, reason);
    return { applied: true, release: { id: releaseId }, lifecycle };
  } catch (error) {
    const details = errorDetails(error);
    return {
      applied: false,
      reason: "fallback-failed",
      release: { id: releaseId },
      error: { message: details.message, hint: details.hint ?? null },
    };
  }
}

async function switchCurrentReleaseLink(currentLink: string, releaseDirectory: string) {
  const tempCurrentLink = `${currentLink}.tmp-${process.pid}`;
  await rm(tempCurrentLink, { force: true });
  await symlink(releaseDirectory, tempCurrentLink);
  await rename(tempCurrentLink, currentLink);
}

async function restoreFailedReleaseAfterFallbackRestartFailure(request: HostHelperRequest, failedReleaseId: string, fallbackReleaseId: string, reason: string, restartError: any) {
  const failedPaths = canonicalRollbackPaths(request, failedReleaseId);
  try {
    await switchCurrentReleaseLink(failedPaths.currentLink, failedPaths.release);
  } catch {
    // Registry state below still makes the failed attempted release authoritative.
  }
  await recordReleaseVerificationFallbackFailed(
    request,
    failedReleaseId,
    fallbackReleaseId,
    restartError?.message ?? "Hosted Capsule fallback restart failed.",
    reason,
  );
  try {
    await writeUnavailableRoute(normaliseLifecycle(request));
  } catch {
    // The original verification failure has already returned the route to unavailable.
  }
}

function verificationFailureResult(request: HostHelperRequest, releaseId: string, data: any, message: string) {
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
        fallback: data.fallback ?? { applied: false, reason: "not-configured" },
      },
    },
  };
}

function releaseVerificationRollbackGuidance(request: HostHelperRequest, previousCurrentRelease: any) {
  if (!previousCurrentRelease?.id) {
    return null;
  }
  return {
    previousReleaseId: previousCurrentRelease.id,
    command: `sporades host rollback ${request.capsule.subname} ${previousCurrentRelease.id} --host ${request.host.alias}`,
  };
}

function verificationHealthSummary(result: any) {
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

async function startCapsule(request: HostHelperRequest, options: LooseRecord = {}) {
  validateLifecycleRequest(request);
  const registryRecord = await verifyRegisteredCapsule(request, "lifecycle");
  const paths = canonicalReleasePaths(request);
  const releaseId = await currentReleaseId(paths.currentLink, request);
  const lifecycle = normaliseLifecycle(request, registryRecord);
  await mkdir(paths.data, { recursive: true });
  await prepareWritableDataPath(paths.data);
  await recordReleaseStartAttempt(request, releaseId);

  stopAndRemoveContainer(lifecycle.container.name);
  ensureHostedBaseImage(lifecycle);
  const runArgs = await dockerRunArgs(lifecycle, releaseId);
  const run = runDocker(runArgs);
  if (!run.ok) {
    await recordFailedStartAndUnavailableRoute(request, lifecycle, releaseId, "Hosted Capsule container failed to start.");
    const result: LooseRecord = {
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
    const result: LooseRecord = {
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
    const result: LooseRecord = {
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
    await recordReleaseFailure(request, releaseId, String(errorDetails(error).message ?? "Failed to apply Hosted Capsule route."));
    throw error;
  }
  await recordReleaseStarted(request, releaseId);
  const data: LooseRecord = {
    started: true,
    restarted: false,
    capsule: capsuleData(request, lifecycle),
    release: { id: releaseId },
    container: {
      id: run.stdout.trim(),
      name: lifecycle.container.name,
      network: lifecycle.container.network,
      image: lifecycle.container.image,
      user: lifecycle.container.user,
      labels: lifecycle.container.labels,
      baseImage: lifecycle.container.baseImage,
      running: true,
      publishedPort,
    },
    route: publicRouteData(runningRoute),
    restartPolicy: restartPolicyStatus("hosted"),
  };
  const ssh = currentReleaseSshIntent(registryRecord);
  if (!ssh.reason) {
    data.auditEvents = [
      hostedSshAuditEvent(request, {
        event: "ssh.access.enabled",
        operation: request.action === "capsule.restart" ? "ssh.hosted-capsule.restart" : "ssh.hosted-capsule.start",
        surface: `sporades-host-helper/${request.action}`,
        targetResourceKind: "hosted-capsule-ssh-access",
        outcome: "completed",
        message: "Hosted Capsule SSH access enabled for lifecycle start.",
        release: { id: releaseId },
        metadata: {
          enabled: true,
          running: true,
          host: null,
          port: null,
          targetPort: 22,
          loopbackOnly: true,
          keyCount: ssh.keyCount,
          fingerprints: ssh.fingerprints,
          reason: null,
        },
      }),
    ];
  }
  if (options.write !== false) {
    writeEnvelope({ ok: true, data, error: null });
  }
  return data;
}

async function installSealedServerEnvPrivateKey(release: HostHelperRelease) {
  const privateKey = release.sealedServerEnv?.privateKey;
  const privateKeyPath = release.sealedServerEnv?.privateKeyPath;
  if (!release.sealedServerEnvIncluded || !privateKey || !privateKeyPath) {
    return;
  }
  await mkdir(path.dirname(privateKeyPath), { recursive: true });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
}

function validateSealedServerEnvPrivateKeyPath(release: HostHelperRelease, paths: ReleasePaths) {
  if (!release.sealedServerEnvIncluded) {
    return;
  }
  if (!release.sealedServerEnv?.privateKey && !release.sealedServerEnv?.privateKeyPath) {
    return;
  }
  const privateKeyPath = release.sealedServerEnv?.privateKeyPath;
  const expectedPrivateKeyPath = path.join(paths.data, "sealed-server-env", "server-env.private.pem");
  if (typeof privateKeyPath !== "string" || path.resolve(privateKeyPath) !== path.resolve(expectedPrivateKeyPath)) {
    throw helperError(
      "Invalid Sealed Server env private key path.",
      "Update the Sporades CLI and retry `sporades host push`.",
    );
  }
}

async function healthCapsule(request: HostHelperRequest) {
  writeEnvelope(await evaluateCapsuleHealth(request));
}

async function evaluateCapsuleHealth(request: HostHelperRequest, options: { timeoutMs?: number } = {}) {
  validateHealthRequest(request);
  let health = normaliseHealth(request);
  let record;
  try {
    record = await readRegistryRecordForCapsule(request, "health");
  } catch (error) {
    if (errorDetails(error).message === "Hosted Capsule is not registered.") {
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
    await routeRuntimeExhaustionToUnavailable(request, record, health);
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

async function routeRuntimeExhaustionToUnavailable(request: HostHelperRequest, record: any, health: any) {
  const inspected = inspectContainerLifecycle(health.container.name);
  const policy = restartPolicyForMode("hosted");
  if (!Number.isFinite(inspected.restartCount) || inspected.restartCount < policy.maxAttempts) {
    return;
  }
  const releaseId = record.currentRelease?.id;
  if (!releaseId) {
    return;
  }
  try {
    await writeUnavailableRoute(normaliseLifecycle(request, record));
    await recordReleaseFailure(
      request,
      releaseId,
      `Hosted Capsule runtime exhausted ${(policy as DockerRestartPolcy).dockerRestart} restart policy.`,
    );
  } catch {
    // Health should still return the observed stopped-container failure.
  }
}

async function stopCapsule(request: HostHelperRequest, options: LooseRecord = {}) {
  validateLifecycleRequest(request);
  await verifyRegisteredCapsule(request, "lifecycle");
  const lifecycle = normaliseLifecycle(request);
  stopAndRemoveContainer(lifecycle.container.name);
  await writeUnavailableRoute(lifecycle);
  await updateRegistryStatus(request, "stopped");
  const data: LooseRecord = {
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

async function restartCapsule(request: HostHelperRequest, options: LooseRecord = {}) {
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

async function statsCapsule(request: HostHelperRequest) {
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

  const data: LooseRecord = {
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

async function inspectCapsuleSsh(request: HostHelperRequest) {
  let registryRecord;
  try {
    registryRecord = await verifyRegisteredCapsule(request, "ssh");
  } catch (error) {
    if (errorDetails(error).message === "Hosted Capsule is not registered.") {
      writeEnvelope({
        ok: true,
        data: hostedCapsuleSshStateWithAudit(request, {
          enabled: false,
          running: false,
          reason: "no-hosted-capsule",
        }),
        error: null,
      });
      return;
    }
    throw error;
  }

  const ssh = currentReleaseSshIntent(registryRecord);
  if (ssh.reason) {
    writeEnvelope({
      ok: true,
      data: hostedCapsuleSshStateWithAudit(request, {
        enabled: false,
        running: false,
        reason: ssh.reason,
      }),
      error: null,
    });
    return;
  }

  const lifecycle = normaliseLifecycle(request, registryRecord);
  const inspected = inspectDockerContainerJson(lifecycle.container.name);
  if (!inspected) {
    writeEnvelope({
      ok: true,
      data: hostedCapsuleSshStateWithAudit(request, {
        enabled: true,
        running: false,
        keyCount: ssh.keyCount,
        fingerprints: ssh.fingerprints,
        reason: "capsule-stopped",
      }),
      error: null,
    });
    return;
  }

  const running = Boolean(inspected.State?.Running);
  const port = inspectedContainerPort(inspected, 22);
  writeEnvelope({
    ok: true,
    data: hostedCapsuleSshStateWithAudit(request, {
      enabled: true,
      running,
      host: port?.host ?? null,
      port: port?.port ?? null,
      keyCount: ssh.keyCount,
      fingerprints: ssh.fingerprints,
      reason: running ? (port ? null : "port-not-published") : "capsule-stopped",
    }),
    error: null,
  });
}

async function listReleases(request: HostHelperRequest) {
  validateReleaseListRequest(request);
  const record = await readRegistryRecordForCapsule(request, "releases");
  assertRegistryRecordMatchesRequest(request, record);
  const releases = normaliseReleaseHistory(record)
    .map((release: HostHelperRelease) => markCurrentReleaseEntry(release, record.currentRelease?.id ?? null))
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
      currentRelease: publicCurrentRelease(record),
      releases,
    },
    error: null,
  });
}

async function rollbackRelease(request: HostHelperRequest) {
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

  const releaseId = request.rollback?.releaseId;
  if (!releaseId) {
    throw helperError("Invalid Hosted Capsule rollback request.", "Update the Sporades CLI and retry `sporades host rollback`.");
  }
  const selectedRelease = releases.find((release: HostHelperRelease) => release.id === releaseId);
  if (!selectedRelease) {
    throw helperError(
      "Hosted Capsule release is not recorded.",
      `Run \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\` and choose a recorded release ID.`,
    );
  }

  const paths = canonicalRollbackPaths(request, releaseId);
  await assertRollbackReleaseFiles(request, paths.release, selectedRelease);
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

  const data: LooseRecord = {
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
      message: errorDetails(restartError).message ?? "Hosted Capsule rollback start failed.",
      hint:
        errorDetails(restartError).hint ??
        `Previous current release was ${previousCurrentRelease?.id ?? "none"}. Check Docker logs for ${normaliseLifecycle(request).container.name}; the route has been returned to the Hosted Capsule unavailable response.`,
    },
  });
}

async function statsHost(request: HostHelperRequest) {
  validateHostStatsRequest(request);
  const records = await readCapsuleRegistryRecords(request);
  const dockerAvailable = checkDockerAvailable();
  const caddyAvailable = checkCaddyAvailable();
  const dockerStates = dockerAvailable ? records.map((record: any) => lookupCapsuleDockerState(request, record)) : [];

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

async function logsHost(request: HostHelperRequest) {
  validateHostLogsRequest(request, hostHelperConfig.logs);
  const logs = normaliseHostLogs(request);
  if (logs.source === "stdout" || logs.source === "stderr") {
    const container = logs.container;
    if (!container) {
      throw helperError("Hosted Capsule log target is missing.", "Pass a Hosted Capsule subname when reading stdout or stderr logs.");
    }
    const entries = readDockerStreamLogs(logs);
    writeEnvelope({ ok: true, data: { lineCount: logs.lines, source: logs.source, container: container.name, entries }, error: null });
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

async function listCapsules(request: HostHelperRequest) {
  validateListRequest(request);
  const records = await readCapsuleRegistryRecords(request);
  const capsules = [];
  for (const record of records) {
    if (record.status === "unregistered") {
      continue;
    }
    const capsule: LooseRecord = {
      subname: record.subname,
      domain: record.domain,
      hostedUrl: record.hostedUrl ?? `${request.host.scheme ?? "https"}://${record.subname}.${request.host.domain}`,
      registry: {
        remoteCapsuleId: record.remoteCapsuleId ?? `${request.host.domain}/${record.subname}`,
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
        status: record.status ?? "registered",
        ...(record.sealedServerEnv ? { sealedServerEnv: publicRegistrySealedServerEnv(record.sealedServerEnv) } : {}),
      },
      currentRelease: publicCurrentRelease(record),
      docker: lookupCapsuleDockerState(request, record),
    };
    const sealedServerEnv = await inspectHostSealedEnvKey(record, request.host.remoteRoot);
    if (sealedServerEnv) {
      capsule.sealedServerEnv = sealedServerEnv;
    }
    capsule.baseImage = normaliseRecordBaseImage(record, capsule.docker);
    capsules.push(capsule);
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

function createUnregisterResult(
  request: HostHelperRequest,
  unregister: any,
  record: any,
  idempotent: any,
  route: HostedCapsuleRoute | null = null,
) {
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

function createDeleteResult(request: HostHelperRequest, deletion: any, removals: any) {
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

function canonicalReleasePaths(request: HostHelperRequest): ReleasePaths {
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

function canonicalRollbackPaths(request: HostHelperRequest, releaseId: string) {
  const paths = canonicalReleasePaths({ ...request, release: { id: releaseId, remoteArchive: "", files: [] } });
  return {
    ...paths,
    release: path.join(paths.releases, releaseId),
  };
}

function normaliseLifecycle(request: HostHelperRequest, registryRecord: any = null): HostedCapsuleLifecycle {
  const provided = (request.lifecycle ?? {}) as HostedCapsuleLifecycle;
  const paths = canonicalReleasePaths(request);
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  const hostedUrl =
    typeof provided.hostedUrl === "string"
      ? provided.hostedUrl
      : (request.release?.hostedUrl ?? `${request.host.scheme ?? "https"}://${subname}.${domain}`);
  const remoteCapsuleId = typeof provided.remoteCapsuleId === "string" ? provided.remoteCapsuleId : `${domain}/${subname}`;
  const containerName = provided.container?.name ?? createHostedContainerName(domain, subname);
  const routeFile = provided.routes?.running?.routeFile ?? path.join(request.host.remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`);
  const currentLink = typeof provided.currentLink === "string" ? provided.currentLink : paths.currentLink;
  const routeAccessLog = provided.routes as (LooseRecord & { accessLog?: string }) | undefined;
  const accessLog = routeAccessLog?.accessLog ?? provided.accessLog ?? defaultCapsuleHttpLogPath(request.host.remoteRoot, domain, subname);
  const sealedServerEnvPrivateKey = releaseSealedServerEnvPrivateKeyMount(registryRecord, paths);
  const sshAuthorizedKeysMount = releaseSshAuthorizedKeysMount(registryRecord, paths);
  const authoritativeBaseImage = request.release?.baseImage ?? registryRecord?.baseImage ?? null;
  const updatePolicyMode = normaliseBaseImageUpdatePolicy(
    authoritativeBaseImage?.updatePolicy ?? provided.container?.baseImage?.updatePolicy,
  );
  const baseImage = {
    ...baseImageMetadata(updatePolicyMode),
    name: authoritativeBaseImage?.name ?? provided.container?.baseImage?.name ?? SPORADES_BASE_IMAGE.name,
    image: authoritativeBaseImage?.image ?? provided.container?.baseImage?.image ?? provided.container?.image ?? hostHelperConfig.hostedCapsule.dockerImage,
    version: authoritativeBaseImage?.version ?? provided.container?.baseImage?.version ?? SPORADES_BASE_IMAGE.version,
  };
  const defaultMounts = {
    files: [
      { host: path.join(currentLink, "server.mjs"), container: "/app/server.mjs", mode: "ro" },
      { host: path.join(currentLink, "public"), container: "/app/public", mode: "ro" },
      { host: path.join(currentLink, "sporades.json"), container: "/app/sporades.json", mode: "ro" },
      { host: path.join(currentLink, ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
      {
        host: path.join(currentLink, ".sporades", "sealed-server-env", "server-env.sealed.json"),
        container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
        mode: "ro",
        optional: true,
      },
      {
        host: sealedServerEnvPrivateKey.host,
        container: "/app/.sporades/sealed-server-env/server-env.private.pem",
        mode: "ro",
        optional: !sealedServerEnvPrivateKey.fingerprint,
        fingerprint: sealedServerEnvPrivateKey.fingerprint,
      },
      ...(sshAuthorizedKeysMount ? [sshAuthorizedKeysMount] : []),
    ],
    data: { host: paths.data, container: "/app/data", mode: "rw" },
  };
  const fileMounts = authoritativeSshAuthorizedKeysMount(
    authoritativeSealedServerEnvPrivateKeyMount(
      provided.mounts?.files ?? defaultMounts.files,
      sealedServerEnvPrivateKey,
    ),
    sshAuthorizedKeysMount,
  );
  return {
    subname,
    domain,
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
    mounts: {
      ...provided.mounts,
      files: fileMounts,
      data: provided.mounts?.data ?? defaultMounts.data,
    },
    container: {
      name: containerName,
      network: provided.container?.network ?? hostHelperConfig.hostedCapsule.dockerNetwork,
      image: provided.container?.image ?? baseImage.image,
      user: provided.container?.user ?? baseImageRuntimeUser(),
      baseImage,
      graceCheckMs: provided.container?.graceCheckMs ?? hostHelperConfig.hostedCapsule.graceCheckMs,
      labels: {
        ...(provided.container?.labels ?? {}),
        "com.sporades.managed": "true",
        "com.sporades.hosted-domain": domain,
        "com.sporades.capsule-subname": subname,
        "com.sporades.capsule-id": remoteCapsuleId,
        ...baseImageLabels(updatePolicyMode),
      },
    },
    routes: {
      running: withRouteAccessLog(
        (provided.routes?.running as HostedCapsuleRoute | undefined) ?? {
          hostname: `${subname}.${domain}`,
          target: "container",
          containerName,
          port: 4000,
          routeFile,
        },
        accessLog,
      ),
      unavailable: withRouteAccessLog(
        (provided.routes?.unavailable as HostedCapsuleRoute | undefined) ?? {
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

function authoritativeSealedServerEnvPrivateKeyMount(fileMounts: any, sealedServerEnvPrivateKey: any) {
  const privateKeyContainerPath = "/app/.sporades/sealed-server-env/server-env.private.pem";
  let replaced = false;
  const next = fileMounts.map((mount: any) => {
    if (mount.container !== privateKeyContainerPath) {
      return mount;
    }
    replaced = true;
    return {
      ...mount,
      host: sealedServerEnvPrivateKey.host,
      mode: mount.mode ?? "ro",
      optional: !sealedServerEnvPrivateKey.fingerprint,
      fingerprint: sealedServerEnvPrivateKey.fingerprint,
    };
  });
  if (!replaced && sealedServerEnvPrivateKey.fingerprint) {
    next.push({
      host: sealedServerEnvPrivateKey.host,
      container: privateKeyContainerPath,
      mode: "ro",
      optional: false,
      fingerprint: sealedServerEnvPrivateKey.fingerprint,
    });
  }
  return next;
}

function authoritativeSshAuthorizedKeysMount(fileMounts: any, sshAuthorizedKeysMount: any) {
  const authorizedKeysContainerPath = "/run/sporades/ssh/authorized_keys";
  const withoutStaleSshMount = fileMounts.filter((mount: any) => mount.container !== authorizedKeysContainerPath);
  if (!sshAuthorizedKeysMount) {
    return withoutStaleSshMount;
  }
  return [...withoutStaleSshMount, sshAuthorizedKeysMount];
}

function withRouteAccessLog(route: HostedCapsuleRoute, accessLog: any) {
  if (route.log === null) {
    return route;
  }
  return {
    ...route,
    log: route.log ?? { file: accessLog },
  };
}

function normaliseStats(request: HostHelperRequest) {
  const provided = (request.stats ?? {}) as {
    hostedUrl?: string;
    remoteCapsuleId?: string;
    container?: { name?: string };
  };
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

function normaliseHealth(request: HostHelperRequest, record: any = null) {
  const provided = (request.health ?? {}) as { container?: { name?: string } };
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

async function ensureRuntimeProbeCredential(request: HostHelperRequest): Promise<any> {
  let probe = null;
  await mutateRegistryRecord(request, (record: any) => {
    probe = readRuntimeProbeCredential(record) ?? {
      header: RUNTIME_PROBE_HEADER,
      token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    return { ...record, runtimeProbe: probe };
  });
  return probe;
}

function readRuntimeProbeCredential(record: any) {
  const header = record?.runtimeProbe?.header;
  const token = record?.runtimeProbe?.token;
  if (header !== RUNTIME_PROBE_HEADER || typeof token !== "string" || token.length === 0) {
    return null;
  }
  return { header, token };
}

function normaliseRuntimeHealthBody(body: any) {
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

function healthFailure(request: HostHelperRequest, health: any, failure: any, message: string, hint: any, extra: any = {}) {
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

function unregisteredHealthFailure(request: HostHelperRequest, health: any) {
  return healthFailure(
    request,
    health,
    "unregistered-capsule",
    "Hosted Capsule is not registered.",
    `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before checking runtime health.`,
  );
}

function publicRouteData(route: HostedCapsuleRoute) {
  const { runtimeProbe, ...safeRoute } = route;
  return safeRoute;
}

async function readHostDiskStats(targetPath: string) {
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

function countHostedCapsules(records: any, dockerStates: any) {
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
    registered: records.filter((record: any) => (record.status ?? "registered") === "registered").length,
    running,
    stopped,
    unavailable: records.length - running,
  };
}

function readCapsuleLifecycle(_request: HostHelperRequest, registryRecord: any, containerName: string, running: any) {
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

function inspectContainerLifecycle(containerName: string) {
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

async function readCapsuleRegistryRecords(request: HostHelperRequest) {
  const registryDirectory = path.join(request.host.remoteRoot, "hosts", request.host.domain, "registry", "capsules");
  let entries;
  try {
    entries = await readdir(registryDirectory, { withFileTypes: true });
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = [];
  const files = entries
    .filter((entry: any) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry: any) => entry.name)
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

function lookupCapsuleDockerState(request: HostHelperRequest, record: any) {
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
  const match = containers.find((container: any) => dockerPsContainerMatches(container, containerName, remoteCapsuleId, subname));
  return match ? normaliseDockerPsContainer(match, containerName) : null;
}

function parseDockerPsJsonLines(output: string) {
  return String(output ?? "")
    .split("\n")
    .map((line: any) => line.trim())
    .filter(Boolean)
    .map((line: any) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function dockerPsContainerMatches(container: any, containerName: string, remoteCapsuleId: any, subname: any) {
  const names = String(container.Names ?? container.Name ?? "");
  const labels = parseDockerLabels(container.Labels);
  return (
    names.split(",").map((name: any) => name.trim()).includes(containerName) ||
    labels["com.sporades.capsule-id"] === remoteCapsuleId ||
    labels["com.sporades.capsule-subname"] === subname
  );
}

function parseDockerLabels(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, labelValue]) => [key, String(labelValue)]));
  }
  const labels: Record<string, string> = {};
  for (const label of String(value ?? "").split(",")) {
    const [key, ...rest] = label.split("=");
    if (key && rest.length > 0) {
      labels[key.trim()] = rest.join("=").trim();
    }
  }
  return labels;
}

function normaliseDockerPsContainer(container: any, fallbackContainerName: any) {
  const state = String(container.State ?? container.state ?? "").toLowerCase();
  const containerName = String(container.Names ?? container.Name ?? fallbackContainerName).split(",")[0].trim();
  const status = String(container.Status ?? container.status ?? "");
  const labels = parseDockerLabels(container.Labels);
  const normalised: LooseRecord = {
    containerId: String(container.ID ?? container.Id ?? container.id ?? ""),
    containerName,
    image: String(container.Image ?? container.image ?? ""),
    state: state || "unknown",
    status,
    running: state === "running",
  };
  const baseImage = normaliseDockerBaseImage(labels);
  if (baseImage) {
    normalised.baseImage = baseImage;
  }
  return normalised;
}

function normaliseDockerBaseImage(labels: any) {
  if (!labels["com.sporades.base-image.name"] && !labels["com.sporades.base-image.version"]) {
    return null;
  }
  return {
    name: labels["com.sporades.base-image.name"] ?? SPORADES_BASE_IMAGE.name,
    version: labels["com.sporades.base-image.version"] ?? "unknown",
    updatePolicy: {
      mode: normaliseBaseImageUpdatePolicy(labels["com.sporades.base-image.update-policy"]),
    },
  };
}

function normaliseRecordBaseImage(record: any, docker: any = null) {
  const provided = record.baseImage ?? {};
  const dockerBaseImage = docker?.baseImage ?? null;
  const hasKnownBaseImage = Boolean(record.baseImage || dockerBaseImage);
  const mode = normaliseBaseImageUpdatePolicy(provided.updatePolicy ?? dockerBaseImage?.updatePolicy);
  const metadata = baseImageMetadata(mode);
  if (!hasKnownBaseImage) {
    return {
      ...metadata,
      name: "unknown",
      image: docker?.image ?? "unknown",
      version: "unknown",
    };
  }
  return {
    ...metadata,
    image: provided.image ?? docker?.image ?? SPORADES_BASE_IMAGE.image,
    name: provided.name ?? dockerBaseImage?.name ?? SPORADES_BASE_IMAGE.name,
    version: provided.version ?? dockerBaseImage?.version ?? SPORADES_BASE_IMAGE.version,
  };
}

function normaliseProvidedBaseImage(value: unknown) {
  const provided: HostedCapsuleBaseImage =
    value && typeof value === "object" && !Array.isArray(value) ? (value as HostedCapsuleBaseImage) : {};
  const updatePolicy =
    provided.updatePolicy && typeof provided.updatePolicy === "object" && "mode" in provided.updatePolicy
      ? (provided.updatePolicy as { mode?: unknown }).mode
      : provided.updatePolicy;
  const mode = normaliseBaseImageUpdatePolicy((updatePolicy ?? "pinned") as string | { mode: string });
  return {
    ...baseImageMetadata(mode),
    image: provided.image ?? SPORADES_BASE_IMAGE.image,
    name: provided.name ?? SPORADES_BASE_IMAGE.name,
    version: provided.version ?? SPORADES_BASE_IMAGE.version,
  };
}

function normaliseRegistration(request: HostHelperRequest) {
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
    remoteRoot,
    hostedUrl,
    remoteCapsuleId,
    registryRecord: path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`),
    directories: {
      capsule: capsuleDirectory,
      releases: path.join(capsuleDirectory, "releases"),
      data: path.join(capsuleDirectory, "data"),
      logs: path.join(capsuleDirectory, "logs"),
    },
    baseImage: normaliseProvidedBaseImage(request.registration?.baseImage),
    route,
    lifecycle: {
      remoteRoot,
      routes: { unavailable: route },
    },
  };
}

function normaliseUnregister(request: HostHelperRequest) {
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

function normaliseDeletion(request: HostHelperRequest) {
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

function normaliseRegistrationTls(request: HostHelperRequest) {
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

async function ensureHostedDomainBootstrapped(request: HostHelperRequest, registration: any) {
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

function createRegistrationRecord(registration: any, sealedServerEnv: any = null): LooseRecord {
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
    baseImage: registration.baseImage,
    ...(sealedServerEnv ? { sealedServerEnv: { currentKeyFingerprint: sealedServerEnv.publicKeyFingerprint } } : {}),
  };
}

async function ensureHostSealedEnvKeyPair(registration: any, existingRecord: any = null) {
  const existingFingerprint = existingRecord?.sealedServerEnv?.currentKeyFingerprint;
  if (existingFingerprint) {
    const existing = await readPublicHostSealedEnvKey(
      {
        subname: registration.subname,
        domain: registration.domain,
        sealedServerEnv: { currentKeyFingerprint: existingFingerprint },
      },
      registration.remoteRoot,
    );
    if (existing) {
      return existing;
    }
  }

  return generateHostSealedEnvKeyPair(registration.directories.data);
}

async function generateHostSealedEnvKeyPair(dataDirectory: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKeyFingerprint = fingerprintPublicKey(publicKey);
  const paths = hostSealedEnvKeyPaths(dataDirectory, publicKeyFingerprint);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await mkdir(paths.keys, { recursive: true, mode: 0o700 });
  await chmod(paths.keys, 0o700);
  await writeFile(paths.privateKey, privateKey, { mode: 0o600 });
  await chmod(paths.privateKey, 0o600);
  await writeFile(paths.publicKey, publicKey, { mode: 0o644 });
  await chmod(paths.publicKey, 0o644);
  return {
    publicKey,
    publicKeyFingerprint,
    publicKeyPath: paths.publicKey,
  };
}

async function cleanupUnreferencedHostSealedEnvKeys(dataDirectory: string, referencedFingerprints: any) {
  const paths = hostSealedEnvKeyPaths(dataDirectory, "placeholder");
  let entries;
  try {
    entries = await readdir(paths.keys);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return {
        deletedKeyFingerprints: [],
        retainedKeyFingerprints: [...referencedFingerprints].sort(),
      };
    }
    throw error;
  }

  const deleted = new Set();
  for (const entry of entries) {
    const match = /^([a-f0-9]{16})\.(private|public)\.pem$/.exec(entry);
    if (!match) {
      continue;
    }
    const fingerprint = match[1];
    if (referencedFingerprints.has(fingerprint)) {
      continue;
    }
    await rm(path.join(paths.keys, entry), { force: true });
    deleted.add(fingerprint);
  }

  return {
    deletedKeyFingerprints: [...deleted].sort(),
    retainedKeyFingerprints: [...referencedFingerprints].sort(),
  };
}

function referencedSealedEnvKeyFingerprints(record: any) {
  const fingerprints = new Set();
  for (const release of normaliseReleaseHistory(record)) {
    const fingerprint = release?.source?.sealedServerEnv?.publicKeyFingerprint;
    if (typeof fingerprint === "string" && fingerprint.length > 0) {
      fingerprints.add(fingerprint);
    }
  }
  return fingerprints;
}

async function readPublicHostSealedEnvKey(record: any, remoteRoot: any) {
  const inspected: LooseRecord | null = await inspectHostSealedEnvKey(record, remoteRoot);
  if (!inspected?.publicKey || !inspected?.publicKeyFingerprint) {
    return null;
  }
  return {
    publicKey: inspected.publicKey,
    publicKeyFingerprint: inspected.publicKeyFingerprint,
    publicKeyPath: inspected.publicKeyPath,
  };
}

async function inspectHostSealedEnvKey(record: any, remoteRoot: any) {
  const publicKeyFingerprint = record?.sealedServerEnv?.currentKeyFingerprint;
  if (typeof publicKeyFingerprint !== "string" || publicKeyFingerprint.length === 0) {
    return null;
  }
  const dataDirectory = path.join(remoteRoot, "hosts", record.domain, "capsules", record.subname, "data");
  const paths = hostSealedEnvKeyPaths(dataDirectory, publicKeyFingerprint);
  const [publicKeyReadable, privateKeyReadable] = await Promise.all([
    pathReadable(paths.publicKey),
    pathReadable(paths.privateKey),
  ]);
  const keyStatus = hostSealedEnvKeyStatus(publicKeyReadable, privateKeyReadable);
  const base = {
    publicKeyFingerprint,
    publicKeyPath: paths.publicKey,
    status: keyStatus,
    publicKeyAvailable: publicKeyReadable,
    privateKeyAvailable: privateKeyReadable,
  };
  if (!publicKeyReadable) {
    return base;
  }
  try {
    return {
      ...base,
      publicKey: await readFile(paths.publicKey, "utf8"),
    };
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return { ...base, publicKeyAvailable: false, status: hostSealedEnvKeyStatus(false, privateKeyReadable) };
    }
    throw error;
  }
}

function hostSealedEnvKeyStatus(publicKeyReadable: any, privateKeyReadable: any) {
  if (publicKeyReadable && privateKeyReadable) {
    return "available";
  }
  if (!publicKeyReadable && !privateKeyReadable) {
    return "missing-key-material";
  }
  if (!publicKeyReadable) {
    return "missing-public-key";
  }
  return "missing-private-key";
}

function publicRegistrySealedServerEnv(sealedServerEnv: any) {
  return {
    currentKeyFingerprint: sealedServerEnv.currentKeyFingerprint ?? null,
  };
}

function publicCurrentRelease(record: any) {
  if (!record?.currentRelease) {
    return null;
  }
  const currentRelease = { ...record.currentRelease };
  const fingerprint = currentReleaseSealedServerEnvFingerprint(record);
  if (fingerprint) {
    currentRelease.sealedServerEnv = { publicKeyFingerprint: fingerprint };
  }
  return currentRelease;
}

function currentReleaseSealedServerEnvFingerprint(record: any) {
  const releaseId = record?.currentRelease?.id ?? null;
  if (!releaseId) {
    return null;
  }
  const release = normaliseReleaseHistory(record).find((entry: any) => entry.id === releaseId);
  const fingerprint = release?.source?.sealedServerEnv?.publicKeyFingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

function hostSealedEnvKeyPaths(dataDirectory: string, fingerprint: string) {
  const root = path.join(dataDirectory, "sealed-server-env");
  const keys = path.join(root, "keys");
  return {
    root,
    keys,
    privateKey: path.join(keys, `${fingerprint}.private.pem`),
    publicKey: path.join(keys, `${fingerprint}.public.pem`),
  };
}

function fingerprintPublicKey(publicKey: string) {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

function reactivateRegistrationRecord(record: any, sealedServerEnv: any = null) {
  const now = new Date().toISOString();
  const { unregistered, unregisteredAt, deleteAfter, ...activeRecord } = record;
  return {
    ...activeRecord,
    status: "registered",
    updatedAt: now,
    ...(sealedServerEnv ? { sealedServerEnv: { currentKeyFingerprint: sealedServerEnv.publicKeyFingerprint } } : {}),
  };
}

function normaliseHostLogs(request: HostHelperRequest) {
  const provided: HostLogsOptions = request.logs ?? {};
  const lines = provided.lines ?? hostHelperConfig.logs.defaultLines;
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

function normaliseDockerStats(raw: any) {
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

function percentage(numerator: any, denominator: any) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10000) / 100;
}

function normaliseBootstrap(request: HostHelperRequest) {
  const provided: HostBootstrapOptions = request.bootstrap ?? {};
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
    network: provided.network ?? hostHelperConfig.hostedCapsule.dockerNetwork,
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

async function ensureBootstrapDirectories(bootstrap: any) {
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

async function provisionCaddyAccessLog(request: HostHelperRequest, bootstrap: any) {
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

async function provisionRouteLogFile(route: HostedCapsuleRoute) {
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

async function validateBootstrapTls(request: HostHelperRequest, bootstrap: any) {
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

function ensureDockerNetwork(networkName: string) {
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

async function installCaddyBootstrapConfig(request: HostHelperRequest, bootstrap: any) {
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

function renderHostHealthRoute(domain: string, tls: any) {
  const route = {
    hostname: `host.${domain}`,
    routeFile: "",
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

async function writeManagedCaddyfile(caddyfile: string, importLine: string) {
  const begin = "# BEGIN Sporades hosted domains";
  const end = "# END Sporades hosted domains";
  const block = `${begin}\n${importLine}\n${end}\n`;
  let existing = "";
  try {
    existing = await readFile(caddyfile, "utf8");
  } catch (error) {
    if (errorDetails(error).code !== "ENOENT") {
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

function validateCaddyBootstrap(caddyfile: string) {
  const result = spawnSync("caddy", ["validate", "--config", caddyfile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to validate the Sporades Caddy bootstrap configuration.",
      `Check Caddy on the Host server, then rerun \`sporades host bootstrap\`. Caddy stderr: ${trimForHint(result.stderr)}`,
    );
  }
}

function reloadCaddyBootstrap(caddyfile: string) {
  const result = spawnSync("caddy", ["reload", "--config", caddyfile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to reload the Sporades Caddy bootstrap configuration.",
      `Check the Host server Caddy service, then rerun \`sporades host bootstrap\`. Caddy stderr: ${trimForHint(result.stderr)}`,
    );
  }
}

function parsePair(value: unknown, parser: any) {
  const [left, right] = String(value ?? "").split("/").map((part: any) => part.trim());
  return [parser(left), parser(right)];
}

function parseDockerPercent(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDockerInteger(value: unknown) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDockerByteSize(value: unknown) {
  const match = String(value ?? "").trim().match(/^([\d.]+)\s*([KMGTPE]?i?B|B)$/i);
  if (!match) {
    return null;
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
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

async function dockerRunArgs(lifecycle: HostedCapsuleLifecycle, releaseId: string) {
  const args = [
    "run",
    "--detach",
    "--name",
    lifecycle.container.name,
    "--network",
    lifecycle.container.network,
    "--restart",
    (restartPolicyForMode("hosted") as DockerRestartPolcy).dockerRestart,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    lifecycle.container.user,
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
    if (
      !mount.optional &&
      mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem" &&
      !(await pathReadable(mount.host))
    ) {
      throw missingHostSealedServerEnvPrivateKeyError(lifecycle, mount);
    }
    args.push("--volume", formatMount(mount));
    if (mount.container === "/app/.env.sporades.server") {
      args.push("--env-file", mount.host);
    }
    if (mount.container === "/app/.sporades/sealed-server-env/server-env.sealed.json") {
      args.push("--env", `SPORADES_SEALED_SERVER_ENV_PATH=${mount.container}`);
    }
    if (mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem") {
      args.push("--env", `SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH=${mount.container}`);
    }
    if (mount.container === "/run/sporades/ssh/authorized_keys") {
      args.push(
        "--env",
        "SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys",
        "--env",
        "SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys",
      );
    }
  }
  args.push(
    "--volume",
    formatMount(lifecycle.mounts.data),
    "--workdir",
    "/app",
    "--env",
    "PORT=4000",
    "--env",
    "SPORADES_LOG_STDOUT=1",
    "--env",
    "SPORADES_SECURITY_SESSION=hosted",
    "--env",
    `SPORADES_PUBLIC_ORIGIN=${lifecycle.hostedUrl}`,
    "--env",
    `SPORADES_RELEASE_ID=${releaseId}`,
  );
  args.push("--publish", `127.0.0.1::${lifecycle.routes.running.port ?? 4000}`);
  const sshEnabled = lifecycle.mounts.files.some((mount: any) => mount.container === "/run/sporades/ssh/authorized_keys");
  if (sshEnabled) {
    args.push("--publish", "127.0.0.1::22");
  }
  args.push(lifecycle.container.image, ...(sshEnabled ? ["/usr/local/bin/sporades-start"] : ["node", "/app/server.mjs"]));
  return args;
}

function missingHostSealedServerEnvPrivateKeyError(lifecycle: HostedCapsuleLifecycle, mount: any) {
  const fingerprint = mount.fingerprint ?? null;
  const expected = fingerprint ? ` Expected sealed-env key fingerprint: ${fingerprint}.` : "";
  return helperError(
    "Hosted Capsule Sealed Server env private key is missing.",
    `Host key material for ${lifecycle.remoteCapsuleId} is missing.${expected} Old Host-encrypted envelopes cannot be decrypted without that private key. To recover, re-key the Hosted Capsule, re-seal from source-of-truth Server env values, then push a new release.`,
    {
      capsule: {
        subname: lifecycle.subname,
        domain: lifecycle.domain,
        hostedUrl: lifecycle.hostedUrl,
        remoteCapsuleId: lifecycle.remoteCapsuleId,
      },
      sealedServerEnv: {
        expectedPublicKeyFingerprint: fingerprint,
        privateKeyPath: mount.host,
        recovery: "re-key-and-re-seal-from-source-of-truth",
      },
    },
  );
}

function stopAndRemoveContainer(containerName: string) {
  runDocker(["stop", containerName], { ignoreFailure: true });
  runDocker(["rm", containerName], { ignoreFailure: true });
}

function ensureHostedBaseImage(lifecycle: HostedCapsuleLifecycle) {
  const image = lifecycle.container.image;
  const inspect = runDocker(["image", "inspect", image], { ignoreFailure: true });
  if (inspect.ok) {
    return;
  }

  const pull = runDocker(["pull", image], { ignoreFailure: true });
  if (pull.ok) {
    return;
  }

  const dockerfilePath = path.join(lifecycle.remoteRoot, "Dockerfile.base");
  if (!pathExistsSync(dockerfilePath)) {
    throw helperError(
      "Unable to prepare the Sporades Base image.",
      `Docker could not pull ${image}, and ${dockerfilePath} is missing. Reinstall the Sporades Host helper files, then retry \`sporades host start ${lifecycle.subname} --host <alias>\`.`,
    );
  }

  const build = runDocker(["build", "-f", dockerfilePath, "-t", image, lifecycle.remoteRoot], { ignoreFailure: true });
  if (!build.ok) {
    throw helperError(
      "Unable to prepare the Sporades Base image.",
      `Docker could not pull or build ${image}. Check Docker and ${dockerfilePath} on the Host server, then retry \`sporades host start ${lifecycle.subname} --host <alias>\`.`,
    );
  }
}

function runDocker(args: any, options: LooseRecord = {}) {
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

function checkContainerRunning(containerName: string) {
  return inspectContainerRunning(containerName).running;
}

function inspectContainerRunning(containerName: string) {
  const result = runDocker(["inspect", "-f", "{{.State.Running}}", containerName]);
  if (!result.ok) {
    return { ok: false, running: false };
  }
  const value = result.stdout.trim();
  return { ok: true, running: value === "true" };
}

function inspectDockerContainerJson(containerName: string) {
  const result = runDocker(["inspect", "--format", "{{json .}}", containerName], { ignoreFailure: true });
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function inspectedContainerPort(inspected: any, targetPort: number) {
  const entries = inspected?.NetworkSettings?.Ports?.[`${targetPort}/tcp`];
  const entry = Array.isArray(entries) ? entries[0] : null;
  if (!entry || entry.HostIp !== "127.0.0.1" || !/^[1-9][0-9]*$/.test(String(entry.HostPort ?? ""))) {
    return null;
  }
  return { host: "127.0.0.1", port: Number(entry.HostPort), targetPort };
}

function inspectLoopbackPublishedPort(containerName: string, containerPort: any) {
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

async function currentReleaseId(currentLink: string, request: HostHelperRequest) {
  let target;
  try {
    target = await readlink(currentLink);
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === "ENOENT" || details.code === "EINVAL") {
      throw helperError(
        "No Hosted Capsule release has been pushed.",
        `Run \`sporades host push --host ${request.host.alias} --subname ${request.capsule.subname}\` before starting the Hosted Capsule.`,
      );
    }
    throw error;
  }
  return path.basename(target);
}

function loopbackRunningRoute(route: HostedCapsuleRoute, publishedPort: any) {
  return {
    ...route,
    target: "loopback",
    upstream: `${publishedPort.hostIp}:${publishedPort.hostPort}`,
    publishedPort,
  };
}

async function writeRunningRoute(lifecycle: HostedCapsuleLifecycle, route: HostedCapsuleRoute = lifecycle.routes.running) {
  await provisionRouteLogFile(route);
  const proxyLine = `reverse_proxy ${route.upstream ?? `${route.containerName}:${route.port ?? 4000}`}`;
  await applyManagedRoute(
    lifecycle,
    route.routeFile,
    renderRoute(route, renderRunningRouteHandler(route, proxyLine)),
  );
}

function renderRunningRouteHandler(route: HostedCapsuleRoute, proxyLine: string) {
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

async function writeUnavailableRoute(lifecycle: HostedCapsuleLifecycle) {
  const route = lifecycle.routes.unavailable;
  await provisionRouteLogFile(route);
  await applyManagedRoute(
    lifecycle,
    route.routeFile,
    renderRoute(route, renderUnavailableRouteHandler(route)),
  );
}

function renderUnavailableRouteHandler(route: HostedCapsuleRoute) {
  return [
    `@sporadesRuntimeHealth path ${CAPSULE_RUNTIME_HEALTH_PATH}`,
    "respond @sporadesRuntimeHealth 404",
    `respond "Hosted Capsule unavailable" ${route.statusCode ?? 503}`,
  ].join("\n  ");
}

function renderRoute(route: HostedCapsuleRoute, handlerLine: string) {
  const tlsLine = renderRouteTlsLine(route.tls);
  const logBlock = renderRouteLogBlock(route.log);
  return `${route.hostname} {\n${tlsLine}${logBlock}  ${handlerLine}\n}\n`;
}

function renderRouteTlsLine(tls: any) {
  if (tls?.mode !== "cloudflare-origin") {
    return "";
  }
  return `  tls ${tls.certificate} ${tls.key}\n`;
}

function renderRouteLogBlock(log: any) {
  if (!log?.file) {
    return "";
  }
  return `  log {\n    output file ${log.file} {\n      roll_size 10MiB\n      roll_keep 5\n      roll_keep_for 720h\n    }\n  }\n`;
}

async function applyManagedRoute(lifecycle: HostedCapsuleLifecycle, routeFile: string, contents: any) {
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

async function removeManagedRoute(lifecycle: HostedCapsuleLifecycle, routeFile: string) {
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

async function finalizeRemovedRoute(route: HostedCapsuleRoute) {
  if (route?.previousRouteFile) {
    await rm(route.previousRouteFile, { force: true });
  }
}

async function restoreRemovedRoute(lifecycle: HostedCapsuleLifecycle, route: HostedCapsuleRoute) {
  if (!route?.previousRouteFile) {
    return;
  }
  await rm(route.routeFile, { force: true });
  await rename(route.previousRouteFile, route.routeFile);
  reloadCaddy(lifecycle);
}

async function removePathIfPresent(targetPath: string, options: LooseRecord = {}) {
  const existed = await pathExists(targetPath);
  if (!existed) {
    return { path: targetPath, removed: false };
  }
  await rm(targetPath, { recursive: Boolean(options.recursive), force: true });
  return { path: targetPath, removed: true };
}

async function prepareWritableDataPath(targetPath: string) {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw helperError(
      "Hosted Capsule data path contains a symbolic link.",
      `Remove the symbolic link at ${targetPath}, then retry the Host lifecycle command.`,
    );
  }

  await prepareRuntimeDataOwnership(targetPath, stats);

  if (stats.isDirectory()) {
    await chmod(targetPath, 0o700);
    const entries = await readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await prepareWritableDataPath(path.join(targetPath, entry.name));
    }
    return;
  }

  if (stats.isFile()) {
    await chmod(targetPath, 0o600);
  }
}

async function prepareRuntimeDataOwnership(targetPath: string, stats: any) {
  const uid = SPORADES_BASE_IMAGE.runtimeUid;
  const gid = SPORADES_BASE_IMAGE.runtimeGid;
  if (process.env.SPORADES_TEST_FORCE_RUNTIME_DATA_CHOWN_FAILURE === "1") {
    throw runtimeDataOwnershipError(targetPath, uid, gid);
  }
  if (stats.uid === uid && stats.gid === gid) {
    return;
  }
  try {
    await chown(targetPath, uid, gid);
  } catch (error) {
    if (
      process.env.SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK === "1" &&
      ["EPERM", "EINVAL"].includes(String(errorDetails(error).code ?? ""))
    ) {
      return;
    }
    throw runtimeDataOwnershipError(targetPath, uid, gid);
  }
}

function runtimeDataOwnershipError(targetPath: string, uid: any, gid: any) {
  return helperError(
    "Unable to prepare Hosted Capsule data ownership for the non-root runtime user.",
    `Run the Host helper as a user that can chown Capsule data to ${uid}:${gid}, or repair ownership with \`sudo chown -R ${uid}:${gid} ${targetPath}\` and retry.`,
  );
}

function validateCaddyRoute(routeFile: string) {
  const result = spawnSync("caddy", ["validate", "--config", routeFile, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to validate Hosted Capsule route.",
      "Check the generated Caddy route for this Hosted Capsule, then retry the lifecycle command.",
    );
  }
}

function reloadCaddy(lifecycle: HostedCapsuleLifecycle) {
  const configPath = path.join(lifecycle.remoteRoot, "caddy", "Caddyfile");
  const result = spawnSync("caddy", ["reload", "--config", configPath, "--adapter", "caddyfile"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw helperError(
      "Failed to apply Hosted Capsule route.",
      "Check the Host server Caddy configuration, then retry the lifecycle command.",
    );
  }
}

async function updateRegistryStatus(request: HostHelperRequest, status: any) {
  await mutateRegistryRecord(request, (record: any) => {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return record;
  });
}

async function recordFailedStartAndUnavailableRoute(request: HostHelperRequest, lifecycle: HostedCapsuleLifecycle, releaseId: string, failureMessage: any) {
  try {
    await writeUnavailableRoute(lifecycle);
  } catch (error) {
    await recordReleaseFailure(request, releaseId, String(errorDetails(error).message ?? "Failed to apply Hosted Capsule route."));
    throw error;
  }
  await recordReleaseFailure(request, releaseId, failureMessage);
}

async function recordReleaseUploaded(request: HostHelperRequest, release: HostHelperRelease, fileInventory: ReleaseFileIdentity[]) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: release.id };
    record.baseImage = normaliseProvidedBaseImage(release.baseImage ?? record.baseImage);
    record.status = "released";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, release.id, (entry: any) => ({
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
        fileInventory: fileInventory.map((file) => ({ ...file })),
        serverEnvIncluded: Boolean(release.serverEnvIncluded),
        sealedServerEnvIncluded: Boolean(release.sealedServerEnvIncluded),
        sealedServerEnv: release.sealedServerEnv?.publicKeyFingerprint
          ? { publicKeyFingerprint: release.sealedServerEnv.publicKeyFingerprint }
          : undefined,
        ssh: release.ssh?.enabled
          ? {
            enabled: true,
            authorizedKeysPath: release.ssh.authorizedKeysPath ?? ".sporades/ssh/authorized_keys",
            keyCount: release.ssh.keyCount ?? 0,
            fingerprints: Array.isArray(release.ssh.fingerprints) ? [...release.ssh.fingerprints] : [],
          }
          : undefined,
      },
    }));
    return record;
  });
}

async function recordReleaseStartAttempt(request: HostHelperRequest, releaseId: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

async function recordReleaseStarted(request: HostHelperRequest, releaseId: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "running";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

async function recordReleaseVerified(request: HostHelperRequest, releaseId: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "running";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

async function recordReleaseVerificationFailed(request: HostHelperRequest, releaseId: string, message: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.status = "failed";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

async function recordReleaseVerificationFallback(request: HostHelperRequest, failedReleaseId: string, fallbackReleaseId: string, message: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: fallbackReleaseId };
    record.status = "running";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, failedReleaseId, (entry: any) => ({
      ...entry,
      id: failedReleaseId,
      state: "failed",
      current: false,
      fallbackAttempts: [
        ...normaliseReleaseEventList(entry.fallbackAttempts),
        { fallbackAt: now, releaseId: fallbackReleaseId, reason: message },
      ],
      failure: {
        failedAt: entry.failure?.failedAt ?? now,
        message,
      },
    }));
    record.releases = upsertReleaseEntry(record, fallbackReleaseId, (entry: any) => ({
      ...entry,
      id: fallbackReleaseId,
      current: true,
      fallbackSelectedAt: now,
      failure: null,
    }));
    return record;
  });
}

async function recordReleaseVerificationFallbackFailed(request: HostHelperRequest, failedReleaseId: string, fallbackReleaseId: string, fallbackMessage: any, verificationMessage: any) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: failedReleaseId };
    record.status = "failed";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, failedReleaseId, (entry: any) => ({
      ...entry,
      id: failedReleaseId,
      state: "failed",
      current: true,
      fallbackAttempts: [
        ...normaliseReleaseEventList(entry.fallbackAttempts),
        {
          failedAt: now,
          releaseId: fallbackReleaseId,
          reason: verificationMessage,
          failure: { message: fallbackMessage },
        },
      ],
      failure: {
        failedAt: entry.failure?.failedAt ?? now,
        message: verificationMessage,
      },
    }));
    record.releases = normaliseReleaseHistory(record).map((release: HostHelperRelease) =>
      release.id === fallbackReleaseId ? { ...release, current: false } : release,
    );
    return record;
  });
}

async function recordReleaseFailure(request: HostHelperRequest, releaseId: string, message: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.status = "failed";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

async function recordReleaseRollbackSelected(request: HostHelperRequest, releaseId: string) {
  await mutateRegistryRecord(request, (record: any) => {
    const now = new Date().toISOString();
    record.currentRelease = { ...(record.currentRelease ?? {}), id: releaseId };
    record.status = "released";
    record.updatedAt = now;
    record.releases = upsertReleaseEntry(record, releaseId, (entry: any) => ({
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

function upsertReleaseEntry(record: any, releaseId: string, mutateEntry: any) {
  const releases = normaliseReleaseHistory(record);
  const existing = releases.find((release: HostHelperRelease) => release.id === releaseId) ?? createLegacyReleaseEntry(releaseId, record);
  const next = mutateEntry(existing);
  const withoutRelease = releases.filter((release: HostHelperRelease) => release.id !== releaseId);
  return [...withoutRelease, next].map((release: HostHelperRelease) => markCurrentReleaseEntry(release, releaseId));
}

function normaliseReleaseHistory(record: any) {
  const currentReleaseId = record?.currentRelease?.id ?? null;
  const releases = Array.isArray(record?.releases)
    ? record.releases
      .filter((release: HostHelperRelease) => release && typeof release === "object" && typeof release.id === "string" && release.id.length > 0)
      .map((release: HostHelperRelease) => normaliseReleaseEntry(release, currentReleaseId))
    : [];
  if (releases.length === 0 && currentReleaseId) {
    releases.push(createLegacyReleaseEntry(currentReleaseId, record));
  }
  const seen = new Set();
  return releases.filter((release: HostHelperRelease) => {
    if (seen.has(release.id)) {
      return false;
    }
    seen.add(release.id);
    return true;
  });
}

function normaliseReleaseEntry(release: HostHelperRelease, currentReleaseId: string | null) {
  const releaseState = typeof release.state === "string" ? release.state : "uploaded";
  const state = ["uploaded", "started", "verified", "failed"].includes(releaseState) ? releaseState : "uploaded";
  return {
    id: release.id,
    createdAt: typeof release.createdAt === "string" ? release.createdAt : null,
    uploadedAt: typeof release.uploadedAt === "string" ? release.uploadedAt : null,
    state,
    current: release.id === currentReleaseId,
    source: normaliseReleaseSource(release.source),
    startAttempts: normaliseReleaseEventList(release.startAttempts),
    verificationAttempts: normaliseReleaseEventList(release.verificationAttempts),
    fallbackAttempts: normaliseReleaseEventList(release.fallbackAttempts),
    fallbackSelectedAt: typeof release.fallbackSelectedAt === "string" ? release.fallbackSelectedAt : null,
    failure: normaliseReleaseFailure(release.failure),
  };
}

function createLegacyReleaseEntry(releaseId: string, record: any): LooseRecord {
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

function markCurrentReleaseEntry(release: HostHelperRelease, currentReleaseId: any) {
  return {
    ...release,
    current: release.id === currentReleaseId,
  };
}

function normaliseReleaseSource(source: any) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  );
}

function releaseSealedServerEnvPrivateKeyMount(registryRecord: any, paths: any) {
  const releaseId = registryRecord?.currentRelease?.id ?? null;
  const release = normaliseReleaseHistory(registryRecord).find((entry: any) => entry.id === releaseId);
  const fingerprint = release?.source?.sealedServerEnv?.publicKeyFingerprint;
  if (typeof fingerprint === "string" && /^[a-f0-9]{16}$/.test(fingerprint)) {
    return {
      host: path.join(paths.data, "sealed-server-env", "keys", `${fingerprint}.private.pem`),
      fingerprint,
    };
  }
  return {
    host: path.join(paths.data, "sealed-server-env", "server-env.private.pem"),
    fingerprint: null,
  };
}

function releaseSshAuthorizedKeysMount(registryRecord: any, paths: any) {
  const releaseId = registryRecord?.currentRelease?.id ?? null;
  const release = normaliseReleaseHistory(registryRecord).find((entry: any) => entry.id === releaseId);
  const ssh = release?.source?.ssh;
  if (!ssh?.enabled || ssh.authorizedKeysPath !== ".sporades/ssh/authorized_keys") {
    return null;
  }
  return {
    host: path.join(paths.currentLink, ".sporades", "ssh", "authorized_keys"),
    container: "/run/sporades/ssh/authorized_keys",
    mode: "ro",
    optional: false,
  };
}

function currentReleaseSshIntent(registryRecord: any) {
  const releaseId = registryRecord?.currentRelease?.id ?? null;
  if (!releaseId) {
    return { reason: "no-current-release", keyCount: 0, fingerprints: [] };
  }
  const release = normaliseReleaseHistory(registryRecord).find((entry: any) => entry.id === releaseId);
  const ssh = release?.source?.ssh;
  if (!ssh?.enabled) {
    return { reason: "no-authorized-keys", keyCount: 0, fingerprints: [] };
  }
  return {
    reason: null,
    keyCount: Number.isInteger(ssh.keyCount) ? ssh.keyCount : 0,
    fingerprints: Array.isArray(ssh.fingerprints) ? ssh.fingerprints.filter((value: any) => typeof value === "string") : [],
  };
}

function hostedCapsuleSshState(request: HostHelperRequest, overrides: LooseRecord) {
  const subname = request.capsule.subname;
  const domain = request.host.domain;
  return {
    capsule: {
      subname,
      domain,
      hostedUrl: `${request.host.scheme ?? "https"}://${subname}.${domain}`,
      remoteCapsuleId: `${domain}/${subname}`,
    },
    enabled: false,
    running: false,
    user: SPORADES_BASE_IMAGE.runtimeUser,
    host: null,
    port: null,
    targetPort: 22,
    keyCount: 0,
    fingerprints: [],
    reason: "no-authorized-keys",
    ...overrides,
  };
}

function hostedCapsuleSshStateWithAudit(request: HostHelperRequest, overrides: LooseRecord) {
  const state = hostedCapsuleSshState(request, overrides);
  return {
    ...state,
    auditEvents: [
      hostedSshAuditEvent(request, {
        event: "ssh.state.inspected",
        operation: "ssh.hosted-capsule.inspect",
        surface: "sporades-host-helper/capsule.ssh",
        targetResourceKind: "hosted-capsule-ssh-state",
        outcome: "completed",
        message: "Hosted Capsule SSH state inspected.",
        metadata: hostedSshAuditMetadata(state),
      }),
    ],
  };
}

function hostedSshAuditEvent(request: HostHelperRequest, details: LooseRecord) {
  const input = createPrivilegedAuditLogInput({
    actorKind: "platform",
    source: "host-helper",
    ...details,
  });
  return createLogEnvelope({
    ...input,
    timestamp: null,
    config: {
      name: request.capsule.subname,
      id: `${request.host.domain}/${request.capsule.subname}`,
    },
    serverEnv: {},
  });
}

function hostedSshAuditMetadata(state: LooseRecord) {
  return {
    enabled: Boolean(state.enabled),
    running: Boolean(state.running),
    host: typeof state.host === "string" ? state.host : null,
    port: Number.isInteger(state.port) ? state.port : null,
    targetPort: Number.isInteger(state.targetPort) ? state.targetPort : 22,
    loopbackOnly: state.host === "127.0.0.1" || state.host === "localhost" || state.host === null,
    keyCount: Number.isInteger(state.keyCount) ? state.keyCount : 0,
    fingerprints: Array.isArray(state.fingerprints) ? state.fingerprints.filter((value: unknown) => typeof value === "string") : [],
    reason: typeof state.reason === "string" ? state.reason : null,
  };
}

function normaliseReleaseEventList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((event: any) => event && typeof event === "object" && !Array.isArray(event));
}

function normaliseReleaseFailure(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const failure = value as { failedAt?: unknown; message?: unknown };
  return {
    failedAt: typeof failure.failedAt === "string" ? failure.failedAt : null,
    message: typeof failure.message === "string" ? failure.message : "Hosted Capsule release failed.",
  };
}

function compareReleasesNewestFirst(left: any, right: any) {
  return String(right.createdAt ?? right.id).localeCompare(String(left.createdAt ?? left.id)) || right.id.localeCompare(left.id);
}

async function readRegistryRecordForCapsule(request: HostHelperRequest, purpose: any) {
  const registryRecordPath = registryPath(request);
  try {
    return JSON.parse(await readFile(registryRecordPath, "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
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

async function readOptionalRegistryRecordForCapsule(request: HostHelperRequest) {
  try {
    return await readRegistryRecordForCapsule(request, "delete");
  } catch (error) {
    if (errorDetails(error).message === "Hosted Capsule is not registered.") {
      return null;
    }
    throw error;
  }
}

function assertRegistryRecordMatchesRequest(request: HostHelperRequest, record: any) {
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

async function mutateRegistryRecord(request: HostHelperRequest, mutate: any) {
  return withRegistryLock(request, async () => {
    const registryRecordPath = registryPath(request);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    await writeRegistryRecordAtomic(registryRecordPath, mutate(record));
  });
}

async function writeRegistryRecordAtomic(registryRecordPath: any, record: any) {
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

async function withRegistryLock(request: HostHelperRequest, fn: any) {
  const lockDir = registryLockPath(request);
  const timeoutMs = Number(process.env.SPORADES_REGISTRY_LOCK_TIMEOUT_MS ?? "5000");
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if (errorDetails(error).code !== "EEXIST") {
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

function registryPath(request: HostHelperRequest) {
  return path.join(
    request.host.remoteRoot,
    "hosts",
    request.host.domain,
    "registry",
    "capsules",
    `${request.capsule.subname}.json`,
  );
}

function registryLockPath(request: HostHelperRequest) {
  return path.join(request.host.remoteRoot, "hosts", request.host.domain, "registry", ".lock");
}

function capsuleData(request: HostHelperRequest, lifecycle: HostedCapsuleLifecycle) {
  return {
    subname: request.capsule.subname,
    domain: request.host.domain,
    hostedUrl: lifecycle.hostedUrl,
    remoteCapsuleId: lifecycle.remoteCapsuleId,
  };
}

function formatMount(mount: any) {
  const mode = mount.mode === "ro" ? ":ro" : mount.mode === "rw" ? ":rw" : "";
  return `${mount.host}:${mount.container}${mode}`;
}

async function pathExists(filePath: any) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(filePath: any) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathReadable(filePath: any) {
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

async function readManagedCaddyAccessLog(logs: any) {
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

function readCaddyJournalLogs(logs: any) {
  const result = spawnSync("journalctl", ["-u", "caddy", "-n", String(logs.lines), "--no-pager", "-o", "cat"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return lastLogEntries(result.stdout ?? "", logs.lines);
}

function readDockerStreamLogs(logs: any) {
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

function lastLogEntries(contents: any, lines: any) {
  return String(contents ?? "")
    .split(/\r?\n/)
    .filter((line: any) => line.length > 0)
    .slice(-lines);
}

function unavailableCaddyLogsError(request: HostHelperRequest) {
  return helperError(
    "Host server Caddy combined logs are unavailable.",
    `Run \`sporades host bootstrap --host ${request.host.alias}\` and check Caddy on the Host server.`,
  );
}

function unavailableCapsuleHttpLogsError(logs: any) {
  return helperError(
    "Hosted Capsule HTTP logs are unavailable.",
    `Check that ${logs.file} exists and is readable, then retry \`sporades host logs http --subname ${logs.subname}\`.`,
  );
}

function trimForHint(value: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "no stderr output";
}

function escapeRegExp(value: unknown) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createHostedContainerName(domain: string, subname: any) {
  return `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`;
}

function defaultCaddyAccessLogPath(remoteRoot: any) {
  return path.join(remoteRoot, "caddy", "logs", "access.log");
}

function defaultCapsuleHttpLogPath(remoteRoot: any, domain: string, subname: any) {
  return path.join(remoteRoot, "hosts", domain, "capsules", subname, "logs", "http.log");
}

async function assertRollbackReleaseFiles(request: HostHelperRequest, releaseDirectory: string, recordedRelease: any = null) {
  try {
    const expected = await recordedReleaseFileClaims(releaseDirectory, recordedRelease);
    const actual = await validateExtractedReleaseTree(releaseDirectory, expected);
    const recordedInventory = recordedRelease?.source?.fileInventory;
    if (Array.isArray(recordedInventory)) {
      const actualByPath = new Map(actual.map((file) => [file.path, file]));
      for (const recorded of recordedInventory) {
        if (actualByPath.get(recorded.path)?.sha256 !== recorded.sha256) {
          throw helperError("Hosted Capsule release inventory changed.", "Preserve immutable release files and choose another recorded release.");
        }
      }
    }
  } catch (error) {
    if (errorDetails(error).message?.startsWith("Hosted Capsule release")) throw error;
    throw helperError(
      "Hosted Capsule release files are missing.",
      `The recorded release cannot be started from ${releaseDirectory}. Push a new release or choose another release from \`sporades host releases ${request.capsule.subname} --host ${request.host.alias} --json\`.`,
    );
  }
}

async function recordedReleaseFileClaims(releaseDirectory: string, recordedRelease: any): Promise<ReleaseArchiveFile[]> {
  const source = recordedRelease?.source ?? {};
  if (Object.hasOwn(source, "fileInventory")) {
    if (!Array.isArray(source.fileInventory) || source.fileInventory.length === 0) {
      throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
    }
    const canonical = new Set<string>();
    let totalBytes = 0;
    const claims = source.fileInventory.map((file: any) => {
      if (!validRecordedReleaseIdentity(file)) {
        throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
      }
      const normalized = file.path.normalize("NFC");
      if (canonical.has(normalized)) throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
      canonical.add(normalized);
      totalBytes += file.size;
      return { path: file.path, size: file.size };
    });
    if (claims.length > HOST_RELEASE_ARCHIVE_LIMITS.entries || totalBytes > HOST_RELEASE_ARCHIVE_LIMITS.totalBytes) {
      throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
    }
    return claims;
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    return deriveReleaseFileClaims(releaseDirectory);
  }
  const files = source.files;
  const claims: ReleaseArchiveFile[] = [];
  const canonical = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || !safeRecordedReleasePath(file)) {
      throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
    }
    const normalized = file.normalize("NFC");
    if (canonical.has(normalized)) throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
    canonical.add(normalized);
    const stats = await lstat(path.join(releaseDirectory, ...file.split("/")));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw helperError("Hosted Capsule release files are missing.", "Choose another complete immutable release.");
    }
    claims.push({ path: file, size: stats.size });
  }
  return claims;
}

async function deriveReleaseFileClaims(root: string) {
  const claims: ReleaseArchiveFile[] = [];
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRecordedReleasePath(relative)) {
        throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
      }
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
      }
      if (stats.isDirectory()) {
        await visit(entryPath, relative);
      } else if (stats.isFile() && stats.nlink === 1) {
        claims.push({ path: relative, size: stats.size });
      } else {
        throw helperError("Hosted Capsule release inventory is invalid.", "Choose another recorded release or push a replacement.");
      }
    }
  }
  await visit(root);
  const paths = new Set(claims.map((file) => file.path));
  const complete = paths.has("server.mjs")
    && paths.has("sporades.json")
    && paths.has("public/index.html");
  if (!complete) throw helperError("Hosted Capsule release files are missing.", "Choose another complete immutable release.");
  return claims;
}

function validRecordedReleaseIdentity(file: any) {
  return file
    && safeRecordedReleasePath(file.path)
    && Number.isSafeInteger(file.size)
    && file.size >= 0
    && typeof file.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(file.sha256);
}

function safeRecordedReleasePath(file: string) {
  return file.length > 0
    && !file.startsWith("/")
    && !file.includes("\\")
    && !file.includes("\0")
    && path.posix.normalize(file) === file
    && Buffer.byteLength(file, "utf8") <= HOST_RELEASE_ARCHIVE_LIMITS.pathBytes
    && file.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

async function verifyRegisteredCapsule(request: HostHelperRequest, purpose: any = "push") {
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
