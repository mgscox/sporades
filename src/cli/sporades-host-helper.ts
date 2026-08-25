#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream, statSync } from "node:fs";
import { access, chmod, chown, lstat, mkdir, open, opendir, readdir, readFile, readlink, rename, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { ACCESS_KEY_OPERATOR_PROCESS_MAX_BUFFER, sanitizeAccessKeyOperatorEnvelope, validateAccessKeyOperatorActionInput } from "./access-key-operator-envelope.js";
import { ACCESS_KEY_CLIENT_ADDRESS_HEADER } from "../access-key-contract.js";
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
// Published by Cloudflare at https://www.cloudflare.com/ips/ and checked on 2026-08-21.
// cloudflare-origin routes reject every other peer before trusting CF-Connecting-IP.
const CLOUDFLARE_ORIGIN_IP_RANGES = Object.freeze([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32",
  "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
]);

let hostHelperConfig: HostHelperConfig = defaultHostHelperConfig();
let activeManagedRouteTrust: ManagedRouteTrust | null = null;
type TrustedOwner = { uid: number; gid: number };
type TrustedPathIdentity = { path: string; dev: number | bigint; ino: number | bigint; expectedOwner?: TrustedOwner };
type ManagedRouteTrust = {
  directories: TrustedPathIdentity[];
  managedRoot: string;
  finalFiles: Array<{ path: string; expectedOwner?: TrustedOwner; caddyOwned: boolean; identity?: TrustedPathIdentity }>;
  globalLockFile: string;
  routeLockFile: string | null;
  routeFile: string | null;
};
type ManagedRouteLockIdentity = {
  globalLockFile: string;
  routeLockFile: string | null;
  domainDirectory: string;
  bootstrapTrust?: {
    directories: Array<{ path: string; caddyOwned?: boolean }>;
    finalFiles: Array<{ path: string; caddyOwned?: boolean }>;
  };
  routeLogTrust?: {
    directories: Array<{ path: string; caddyOwned?: boolean }>;
    finalFiles: Array<{ path: string; caddyOwned?: boolean }>;
  };
};
const HOSTED_ACCESS_KEY_ACTIONS = new Set([
  "access-keys.list", "access-keys.inspect", "access-keys.revoke", "access-keys.revoke-all", "access-keys.delete",
]);

const HOST_HELPER_INSTALL_MODE = process.argv[2] === "--install-host-helper" || process.argv[2] === "--install-host-helper-internal";

runHostHelperEntry().catch((error: HelperError) => {
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
  if (HOST_HELPER_INSTALL_MODE) process.exitCode = 1;
});

async function runHostHelperEntry() {
  if (process.argv[2] === "--install-host-helper" || process.argv[2] === "--install-host-helper-internal") {
    await runHostHelperInstaller();
    return;
  }
  await runHostHelperProcess();
}

const HOST_HELPER_DISPATCHER_MARKER = "SPORADES_HOST_HELPER_DISPATCHER_V1";
const HOST_HELPER_DISPATCHER = `#!/bin/sh
# ${HOST_HELPER_DISPATCHER_MARKER}
set -eu
self=$0
dir=\${self%/*}
lock=\"$dir/.sporades-host-helper.upgrade.lock\"
if [ \"\${SPORADES_HOST_DISPATCH_LOCK_HELD:-}\" != \"1\" ]; then
  flock=\${SPORADES_TEST_FLOCK_PATH:-/usr/bin/flock}
  exec env SPORADES_HOST_DISPATCH_LOCK_HELD=1 \"$flock\" --shared --timeout 60 --conflict-exit-code 75 --no-fork \"$lock\" \"$self\" \"$@\"
fi
if [ -e \"$dir/.sporades-host-helper.upgrade-blocked\" ]; then
  printf '%s\\n' '{"ok":false,"data":null,"error":{"message":"Host helper upgrade requires recovery.","hint":"Retry sporades host upgrade before running Host commands."}}'
  exit 0
fi
payload=\$(cat \"$dir/.sporades-host-helper.active\")
if ! printf '%s\\n' \"$payload\" | grep -Eq '^\\.sporades-host-helper-payload-[0-9a-f]{64}\\.mjs$'; then
  printf '%s\\n' '{"ok":false,"data":null,"error":{"message":"Host helper dispatcher state is invalid.","hint":"Retry sporades host upgrade before running Host commands."}}'
  exit 0
fi
expected=\${payload%.mjs}
expected=\${expected##*-}
checksum=\${SPORADES_TEST_SHA256_PATH:-/usr/bin/sha256sum}
set -- \$(\"$checksum\" \"$dir/$payload\")
if [ \"\${1:-}\" != \"$expected\" ]; then
  printf '%s\\n' '{"ok":false,"data":null,"error":{"message":"Host helper payload integrity check failed.","hint":"Retry sporades host upgrade before running Host commands."}}'
  exit 0
fi
exec \"$dir/$payload\" \"$@\"
`;

async function runHostHelperInstaller() {
  const internal = process.argv[2] === "--install-host-helper-internal";
  const target = process.argv[3];
  const expectedChecksum = process.argv[4];
  if (
    process.argv.length !== 5
    || typeof target !== "string"
    || !path.isAbsolute(target)
    || path.basename(target) !== "sporades-host-helper"
    || !/^[a-f0-9]{64}$/.test(expectedChecksum ?? "")
  ) {
    throw helperError("Invalid Host helper upgrade request.", "Retry with `sporades host upgrade --host <alias>`.");
  }
  const stage = process.argv[1];
  const directory = path.dirname(target);
  const expectedStage = path.join(directory, `.sporades-host-helper-stage-${expectedChecksum}.mjs`);
  if (stage !== expectedStage) {
    throw helperError("Invalid staged Host helper path.", "Retry with `sporades host upgrade --host <alias>`.");
  }
  if (!internal) {
    const timeoutMs = hostHelperUpgradeTimeoutMs("SPORADES_HOST_UPGRADE_LOCK_TIMEOUT_MS", 60_000);
    const flock = process.env.SPORADES_TEST_FLOCK_PATH || "/usr/bin/flock";
    const result = spawnSync(flock, [
      "--exclusive",
      "--timeout",
      String(timeoutMs / 1000),
      "--conflict-exit-code",
      "75",
      "--no-fork",
      path.join(directory, ".sporades-host-helper.upgrade.lock"),
      process.execPath,
      stage,
      "--install-host-helper-internal",
      target,
      expectedChecksum,
    ], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SPORADES_HOST_UPGRADE_LOCK_HELD: "1" },
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status === 0) return;
    if (result.status === 75) {
      throw helperError("Host helper upgrade is locked.", "Wait for the active Host helper upgrade to finish, then retry.");
    }
    if (result.status !== null) {
      process.exitCode = result.status;
      return;
    }
    throw helperError("Host helper upgrade process terminated.", "Inspect Host process health, then retry the upgrade.");
  }
  if (process.env.SPORADES_HOST_UPGRADE_LOCK_HELD !== "1") {
    throw helperError("Host helper upgrade lock was not retained.", "Retry the Host helper upgrade.");
  }
  await installHostHelperPayload(stage, target, expectedChecksum);
}

function hostHelperUpgradeTimeoutMs(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw helperError("Invalid Host helper upgrade timeout.", `Set ${name} to a whole number from 1 through 60000.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 60_000) {
    throw helperError("Invalid Host helper upgrade timeout.", `Set ${name} to a whole number from 1 through 60000.`);
  }
  return value;
}

async function installHostHelperPayload(stage: string, target: string, expectedChecksum: string) {
  const directory = path.dirname(target);
  const pointer = path.join(directory, ".sporades-host-helper.active");
  const blocked = path.join(directory, ".sporades-host-helper.upgrade-blocked");
  const needsDrain = path.join(directory, ".sporades-host-helper.needs-drain");
  const newPayloadName = `.sporades-host-helper-payload-${expectedChecksum}.mjs`;
  const newPayload = path.join(directory, newPayloadName);
  await mkdir(directory, { recursive: true });
  if (createHash("sha256").update(await readFile(stage)).digest("hex") !== expectedChecksum) {
    throw helperError("Staged Host helper checksum did not match.", "Upload the immutable Host helper again, then retry the upgrade.");
  }
  await publishHostHelperFile(stage, newPayload, 0o755);

  let previousPayloadName: string;
  let firstCooperativeUpgrade = true;
  let currentTarget: Buffer;
  try {
    currentTarget = await readFile(target);
  } catch {
    throw helperError("Current Host helper was not found.", "Install the current Host helper before retrying the upgrade.");
  }
  if (currentTarget.toString("utf8").includes(HOST_HELPER_DISPATCHER_MARKER)) {
    firstCooperativeUpgrade = false;
    previousPayloadName = (await readFile(pointer, "utf8")).trim();
    await validateHostHelperPayload(directory, previousPayloadName);
  } else {
    const previousChecksum = createHash("sha256").update(currentTarget).digest("hex");
    previousPayloadName = `.sporades-host-helper-payload-${previousChecksum}.mjs`;
    await publishHostHelperFile(target, path.join(directory, previousPayloadName), 0o755);
    await writeHostHelperPointer(pointer, previousPayloadName);
    await writeFile(needsDrain, "legacy-helper-drain-required\n", { mode: 0o600 });
  }

  await writeFile(blocked, "upgrade-in-progress\n", { mode: 0o600 });
  await publishHostHelperBytes(Buffer.from(HOST_HELPER_DISPATCHER, "utf8"), target, 0o755);
  await fakeManagedRouteLockPause("SPORADES_FAKE_HOST_UPGRADE_PAUSE_AFTER_DISPATCHER_MS");
  try {
    if (firstCooperativeUpgrade || await pathExists(needsDrain)) await drainUncooperativeHostHelpers(target);
    await writeHostHelperPointer(pointer, newPayloadName);
    await rm(needsDrain, { force: true });
    await rm(blocked, { force: true });
    await rm(stage, { force: true });
  } catch (error) {
    await writeFile(blocked, "upgrade-recovery-required\n", { mode: 0o600 });
    throw error;
  }
}

async function publishHostHelperFile(source: string, target: string, mode: number) {
  const contents = await readFile(source);
  await publishHostHelperBytes(contents, target, mode);
}

async function publishHostHelperBytes(contents: Buffer, target: string, mode: number) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeHostHelperPointer(pointer: string, payloadName: string) {
  await validateHostHelperPayload(path.dirname(pointer), payloadName);
  await publishHostHelperBytes(Buffer.from(`${payloadName}\n`, "utf8"), pointer, 0o600);
}

async function validateHostHelperPayload(directory: string, payloadName: string) {
  const match = /^\.sporades-host-helper-payload-([a-f0-9]{64})\.mjs$/.exec(payloadName);
  if (!match) throw helperError("Host helper payload pointer was invalid.", "Retry the Host helper upgrade.");
  const payload = path.join(directory, payloadName);
  const actual = createHash("sha256").update(await readFile(payload)).digest("hex");
  if (actual !== match[1]) throw helperError("Host helper payload checksum did not match.", "Retry the Host helper upgrade.");
}

async function drainUncooperativeHostHelpers(target: string) {
  const timeoutMs = hostHelperUpgradeTimeoutMs("SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS", 60_000);
  const deadline = monotonicNowNs() + BigInt(timeoutMs) * 1_000_000n;
  const emptyGraceNs = 100_000_000n;
  let emptySince: bigint | null = null;
  let emptyScans = 0;
  while (true) {
    const active = await findUncooperativeHostHelperProcesses(target, deadline);
    const now = monotonicNowNs();
    if (active.length === 0) {
      emptySince ??= now;
      emptyScans += 1;
      if (emptyScans >= 3 && now - emptySince >= emptyGraceNs) return;
    } else {
      emptySince = null;
      emptyScans = 0;
    }
    assertHostHelperDrainDeadline(deadline);
    await delay(25);
  }
}

function monotonicNowNs() {
  return process.hrtime.bigint();
}

function assertHostHelperDrainDeadline(deadline: bigint) {
  if (monotonicNowNs() >= deadline) {
    throw helperError(
      "Existing Host helper actions did not drain before the upgrade timeout.",
      "Let the existing Host command finish, then retry `sporades host upgrade`.",
    );
  }
}

function hostHelperProcScanMaxEntries() {
  const raw = process.env.SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES;
  if (raw === undefined) return 16_384;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw helperError("Invalid Host process inspection bound.", "Set SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES to a whole number from 1 through 65536.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_536) {
    throw helperError("Invalid Host process inspection bound.", "Set SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES to a whole number from 1 through 65536.");
  }
  return value;
}

async function findUncooperativeHostHelperProcesses(target: string, deadline: bigint) {
  const procRoot = process.env.SPORADES_TEST_PROC_ROOT || "/proc";
  const maxEntries = hostHelperProcScanMaxEntries();
  let directory;
  try {
    directory = await opendir(procRoot);
  } catch {
    throw helperError("Host process inspection is unavailable.", "Mount Linux procfs at /proc, then retry the Host helper upgrade.");
  }
  const active: number[] = [];
  let inspected = 0;
  try {
    for await (const entry of directory) {
      assertHostHelperDrainDeadline(deadline);
      if (!/^[1-9][0-9]*$/.test(entry.name) || Number(entry.name) === process.pid) continue;
      inspected += 1;
      if (inspected > maxEntries) {
        throw helperError(
          "Host process inspection exceeded its safe work bound.",
          "Reduce the Host process-table load or raise SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES within its documented bound, then retry.",
        );
      }
      try {
        const processDir = path.join(procRoot, entry.name);
        const argv = (await readFile(path.join(processDir, "cmdline"))).toString("utf8").split("\0").filter(Boolean);
        assertHostHelperDrainDeadline(deadline);
        if (argv[1] !== target) continue;
        const environment = (await readFile(path.join(processDir, "environ"))).toString("utf8").split("\0");
        assertHostHelperDrainDeadline(deadline);
        if (environment.includes("SPORADES_HOST_DISPATCH_LOCK_HELD=1")) continue;
        active.push(Number(entry.name));
      } catch (error) {
        if (errorDetails(error).code !== "ENOENT") throw error;
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return active;
}

async function runHostHelperProcess() {
  const input = await readStdin();
  const request = JSON.parse(input) as HostHelperRequest;
  const lockIdentity = managedRouteMutationLockIdentity(request);
  if (!lockIdentity) {
    await main(request);
    return;
  }
  const claimsHeldLock = process.env.SPORADES_HOST_GLOBAL_ROUTE_LOCK_FILE !== undefined
    || process.env.SPORADES_HOST_ROUTE_LOCK_FILE !== undefined;
  const retainsGlobalLock = process.env.SPORADES_HOST_GLOBAL_ROUTE_LOCK_FILE === lockIdentity.globalLockFile
    && await processRetainsOsFlock(lockIdentity.globalLockFile);
  const retainsRouteLock = lockIdentity.routeLockFile === null
    || (process.env.SPORADES_HOST_ROUTE_LOCK_FILE === lockIdentity.routeLockFile
      && await processRetainsOsFlock(lockIdentity.routeLockFile));
  if (!retainsGlobalLock || !retainsRouteLock) {
    if (claimsHeldLock) {
      throw helperError(
        "Hosted Capsule route lock identity was not retained by the action process.",
        "Upgrade the Host helper and retry the lifecycle command.",
      );
    }
    await runManagedRouteActionProcess(request, input, lockIdentity);
    return;
  }
  activeManagedRouteTrust = await captureManagedRouteTrust(lockIdentity, false);
  await fakeManagedRouteLockPause("SPORADES_FAKE_HOST_GLOBAL_ROUTE_LOCK_PAUSE_MS");
  await assertActiveManagedRouteTrust(lockIdentity.routeLockFile ? lockIdentity.routeLockFile.slice(0, -5) : null);
  await main(request);
}

async function runManagedRouteActionProcess(
  request: HostHelperRequest,
  input: string,
  lockIdentity: ManagedRouteLockIdentity,
) {
  await captureManagedRouteTrust(lockIdentity, true);
  const timeoutMs = managedRouteLockTimeoutMs();
  const flock = process.env.SPORADES_TEST_FLOCK_PATH || "/usr/bin/flock";
  const command = lockIdentity.routeLockFile ? [
    flock,
    "--exclusive",
    "--timeout",
    String(timeoutMs / 1000),
    "--conflict-exit-code",
    "75",
    "--no-fork",
    lockIdentity.routeLockFile,
    process.execPath,
    process.argv[1],
  ] : [process.execPath, process.argv[1]];
  const result = spawnSync(flock, [
    lockIdentity.routeLockFile ? "--shared" : "--exclusive",
    "--timeout",
    String(timeoutMs / 1000),
    "--conflict-exit-code",
    "75",
    "--no-fork",
    lockIdentity.globalLockFile,
    ...command,
  ], {
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      SPORADES_HOST_GLOBAL_ROUTE_LOCK_FILE: lockIdentity.globalLockFile,
      ...(lockIdentity.routeLockFile ? { SPORADES_HOST_ROUTE_LOCK_FILE: lockIdentity.routeLockFile } : {}),
    },
  });
  if (result.status === 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    return;
  }
  if (result.status === 75) {
    throw helperError(
      "Hosted Capsule route is locked.",
      "Wait for the other Host server operation to finish, then retry the lifecycle command.",
    );
  }
  if (result.status !== null) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status;
    return;
  }
  throw helperError(
    "Hosted Capsule route action terminated before settlement.",
    "Check the Host server process health and retry the lifecycle command.",
  );
}

function managedRouteMutationLockIdentity(request: HostHelperRequest) {
  switch (request?.action) {
    case "capsule.register": validateRegisterRequest(request); break;
    case "capsule.unregister": validateUnregisterRequest(request); break;
    case "capsule.delete": validateDeleteRequest(request); break;
    case "capsule.release.install": validateInstallRequest(request); break;
    case "capsule.release.rollback": validateRollbackRequest(request); break;
    case "capsule.start":
    case "capsule.stop":
    case "capsule.restart": validateLifecycleRequest(request); break;
    case "capsule.sealed-env.rotate-key": validateSealedEnvRotationRequest(request); break;
    case "capsule.health": validateHealthRequest(request); break;
    case "host.bootstrap":
      validateBootstrapRequest(request);
      {
        const remoteRoot = validateCanonicalHostRouteRoot(request);
        const domainDirectory = canonicalManagedRouteDomainDirectory(request, remoteRoot);
        const bootstrapTrust = bootstrapTrustManifest(request);
      return {
        globalLockFile: path.join(remoteRoot, "bin", ".sporades-host-helper.host-route.lock"),
        routeLockFile: null,
        domainDirectory,
        bootstrapTrust,
      };
      }
    default: return null;
  }
  const remoteRoot = validateCanonicalHostRouteRoot(request);
  return {
    globalLockFile: path.join(remoteRoot, "bin", ".sporades-host-helper.host-route.lock"),
    routeLockFile: `${canonicalManagedRouteFile(request, remoteRoot)}.lock`,
    domainDirectory: canonicalManagedRouteDomainDirectory(request, remoteRoot),
    ...(actionCanProvisionCapsuleHttpLog(request.action)
      ? { routeLogTrust: capsuleHttpLogTrustManifest(request, remoteRoot) }
      : {}),
  };
}

function actionCanProvisionCapsuleHttpLog(action: string) {
  return action === "capsule.register"
    || action === "capsule.release.install"
    || action === "capsule.release.rollback"
    || action === "capsule.start"
    || action === "capsule.stop"
    || action === "capsule.restart"
    || action === "capsule.sealed-env.rotate-key"
    || action === "capsule.health";
}

function validateCanonicalHostRouteRoot(request: HostHelperRequest) {
  const remoteRoot = request.host.remoteRoot;
  if (
    typeof remoteRoot !== "string"
    || remoteRoot.length < 2
    || remoteRoot.length > 4096
    || !path.isAbsolute(remoteRoot)
    || /[\0\r\n]/.test(remoteRoot)
    || path.normalize(remoteRoot) !== remoteRoot
    || remoteRoot === path.parse(remoteRoot).root
  ) {
    throw helperError("Invalid Hosted Capsule route identity.", "Use a bounded absolute canonical Host remote root and retry.");
  }
  const domain = request.host.domain;
  const portMatch = typeof domain === "string" ? /:([0-9]+)$/.exec(domain) : null;
  const port = portMatch ? Number(portMatch[1]) : null;
  const domainWithoutPort = typeof domain === "string" && portMatch ? domain.slice(0, -portMatch[0].length) : domain;
  const domainValid = typeof domain === "string"
    && domain.length <= 259
    && (!domain.includes(":") || (port !== null && Number.isInteger(port) && port >= 1 && port <= 65_535))
    && domainWithoutPort.length <= 253
    && domainWithoutPort.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!domainValid) {
    throw helperError("Invalid Hosted Capsule route identity.", "Use a canonical lowercase Hosted domain and retry.");
  }
  return remoteRoot;
}

function canonicalManagedRouteFile(request: HostHelperRequest, validatedRemoteRoot = validateCanonicalHostRouteRoot(request)) {
  const subname = request.capsule?.subname;
  if (typeof subname !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subname)) {
    throw helperError("Invalid Hosted Capsule route identity.", "Use a canonical DNS-safe Capsule subname and retry.");
  }
  const domainDirectory = canonicalManagedRouteDomainDirectory(request, validatedRemoteRoot);
  const routeFile = path.resolve(domainDirectory, `${subname}.caddy`);
  if (path.dirname(routeFile) !== domainDirectory) {
    throw helperError("Invalid Hosted Capsule route identity.", "Use a route identity within the configured Hosted domain directory and retry.");
  }
  return routeFile;
}

function canonicalManagedRouteDomainDirectory(request: HostHelperRequest, validatedRemoteRoot = validateCanonicalHostRouteRoot(request)) {
  const hostsDirectory = path.resolve(validatedRemoteRoot, "caddy", "hosts");
  const domainDirectory = path.resolve(hostsDirectory, request.host.domain);
  if (path.dirname(domainDirectory) !== hostsDirectory) {
    throw helperError("Invalid Hosted Capsule route identity.", "Use a route identity within the configured Hosted domain directory and retry.");
  }
  return domainDirectory;
}

async function captureManagedRouteTrust(
  lockIdentity: ManagedRouteLockIdentity,
  createMissing: boolean,
): Promise<ManagedRouteTrust> {
  const remoteRoot = path.dirname(path.dirname(lockIdentity.globalLockFile));
  const canonicalRemoteRoot = await canonicalTrustedTarget(remoteRoot);
  const directoryIdentities = new Map<string, TrustedPathIdentity>();
  const captureDirectory = async (directory: string, caddyOwned = false) => {
    const expectedOwner = caddyOwned ? await expectedCaddyOwnerForExistingPath(directory) : undefined;
    for (const identity of await trustedDirectoryChain(directory, createMissing, canonicalRemoteRoot, expectedOwner)) {
      directoryIdentities.set(identity.path, identity);
    }
  };
  await captureDirectory(remoteRoot);
  await captureDirectory(path.join(canonicalRemoteRoot, "bin"));
  let routeFile: string | null = null;
  if (lockIdentity.routeLockFile) {
    routeFile = lockIdentity.routeLockFile.slice(0, -5);
    const domainDirectory = path.dirname(routeFile);
    await captureDirectory(path.join(canonicalRemoteRoot, "caddy"));
    await captureDirectory(path.join(canonicalRemoteRoot, "caddy", "hosts"));
    await captureDirectory(await canonicalTrustedTarget(domainDirectory));
    await assertTrustedRegularFileIfExists(routeFile);
  } else {
    await captureDirectory(path.join(canonicalRemoteRoot, "caddy"));
    await captureDirectory(path.join(canonicalRemoteRoot, "caddy", "hosts"));
    await captureDirectory(await canonicalTrustedTarget(lockIdentity.domainDirectory));
    for (const directory of lockIdentity.bootstrapTrust?.directories ?? []) await captureDirectory(directory.path, directory.caddyOwned === true);
  }
  for (const directory of lockIdentity.routeLogTrust?.directories ?? []) await captureDirectory(directory.path, directory.caddyOwned === true);
  await assertTrustedRegularFileIfExists(lockIdentity.globalLockFile);
  if (lockIdentity.routeLockFile) await assertTrustedRegularFileIfExists(lockIdentity.routeLockFile);
  const finalFiles = [];
  for (const entry of [
    ...(lockIdentity.bootstrapTrust?.finalFiles ?? []),
    ...(lockIdentity.routeLogTrust?.finalFiles ?? []),
  ]) {
    const expectedOwner = entry.caddyOwned ? await expectedCaddyOwnerForExistingPath(entry.path) : undefined;
    const details = await assertTrustedRegularFileIfExists(entry.path, expectedOwner);
    finalFiles.push({
      path: entry.path,
      expectedOwner,
      caddyOwned: entry.caddyOwned === true,
      ...(details ? { identity: { path: entry.path, dev: details.dev, ino: details.ino, expectedOwner } } : {}),
    });
  }
  return { directories: [...directoryIdentities.values()], managedRoot: canonicalRemoteRoot, finalFiles, globalLockFile: lockIdentity.globalLockFile, routeLockFile: lockIdentity.routeLockFile, routeFile };
}

async function canonicalTrustedTarget(target: string) {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw routeTrustError();
  return target;
}

async function trustedDirectoryChain(target: string, createMissing: boolean, managedRoot: string, targetOwner?: TrustedOwner) {
  const canonicalTarget = await canonicalTrustedTarget(target);
  const parsed = path.parse(canonicalTarget);
  const components = canonicalTarget.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const identities: TrustedPathIdentity[] = [];
  let current = parsed.root;
  for (const component of [null, ...components]) {
    if (component !== null) current = path.join(current, component);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (!createMissing || errorDetails(error).code !== "ENOENT") throw routeTrustError();
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (errorDetails(mkdirError).code !== "EEXIST") throw routeTrustError();
      }
      try {
        details = await lstat(current);
      } catch {
        throw routeTrustError();
      }
    }
    const managed = current === managedRoot || current.startsWith(`${managedRoot}${path.sep}`);
    const expectedOwner = current === canonicalTarget ? targetOwner : undefined;
    if (!details.isDirectory() || details.isSymbolicLink()
      || !(expectedOwner ? trustedExactOwnerMetadata(details, expectedOwner)
        : managed ? trustedHostPathMetadata(details) : trustedAnchorPathMetadata(details))) throw routeTrustError();
    identities.push({ path: current, dev: details.dev, ino: details.ino, ...(expectedOwner ? { expectedOwner } : {}) });
  }
  return identities;
}

function trustedExactOwnerMetadata(details: Awaited<ReturnType<typeof lstat>>, owner: TrustedOwner) {
  return Number(details.uid) === owner.uid && Number(details.gid) === owner.gid && (Number(details.mode) & 0o022) === 0;
}

async function expectedCaddyOwnerForExistingPath(target: string): Promise<TrustedOwner | undefined> {
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") return undefined;
    throw routeTrustError();
  }
  const effectiveUser = process.geteuid?.();
  if (effectiveUser === undefined || Number(details.uid) === effectiveUser) return undefined;
  const caddy = resolveCaddyServiceUser();
  const uid = Number(caddy?.uid);
  const gid = Number(caddy?.gid);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw routeTrustError();
  const expectedOwner = { uid, gid };
  if (!trustedExactOwnerMetadata(details, expectedOwner)) throw routeTrustError();
  return expectedOwner;
}

function trustedHostPathMetadata(details: Awaited<ReturnType<typeof lstat>>) {
  const effectiveUser = process.geteuid?.();
  // The Host trust boundary excludes an attacker with this helper's uid (root in
  // production): every managed ancestor is owned by that uid and cannot be
  // replaced by group/other users while its captured device/inode is fenced.
  return (effectiveUser === undefined || Number(details.uid) === effectiveUser) && (Number(details.mode) & 0o022) === 0;
}

function trustedAnchorPathMetadata(details: Awaited<ReturnType<typeof lstat>>) {
  const effectiveUser = process.geteuid?.();
  const owner = Number(details.uid);
  const mode = Number(details.mode);
  const trustedOwner = effectiveUser === undefined || owner === 0 || owner === effectiveUser;
  const writable = (mode & 0o022) !== 0;
  return trustedOwner && (!writable || (owner === 0 && (mode & 0o1000) !== 0));
}

async function assertTrustedRegularFileIfExists(file: string, expectedOwner?: TrustedOwner) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") return null;
    throw routeTrustError();
  }
  if (!details.isFile() || details.isSymbolicLink()
    || !(expectedOwner ? trustedExactOwnerMetadata(details, expectedOwner) : trustedHostPathMetadata(details))) throw routeTrustError();
  return details;
}

async function assertActiveManagedRouteTrust(routeFile: string | null) {
  const trust = activeManagedRouteTrust;
  if (!trust || trust.routeFile !== routeFile) throw routeTrustError();
  for (const expected of trust.directories) {
    let current;
    try {
      current = await lstat(expected.path);
    } catch {
      throw routeTrustError();
    }
    const managed = expected.path === trust.managedRoot || expected.path.startsWith(`${trust.managedRoot}${path.sep}`);
    if (!current.isDirectory() || current.isSymbolicLink()
      || !(expected.expectedOwner ? trustedExactOwnerMetadata(current, expected.expectedOwner)
        : managed ? trustedHostPathMetadata(current) : trustedAnchorPathMetadata(current))
      || current.dev !== expected.dev || current.ino !== expected.ino) throw routeTrustError();
  }
  await assertTrustedRegularFileIfExists(trust.globalLockFile);
  if (trust.routeLockFile) await assertTrustedRegularFileIfExists(trust.routeLockFile);
  if (routeFile) await assertTrustedRegularFileIfExists(routeFile);
  for (const entry of trust.finalFiles) {
    const details = await assertTrustedRegularFileIfExists(entry.path, entry.expectedOwner);
    if (entry.identity && (!details || details.dev !== entry.identity.dev || details.ino !== entry.identity.ino)) throw routeTrustError();
  }
}

function routeTrustError() {
  return helperError(
    "Hosted Capsule route trust validation failed.",
    "Require helper-owned, non-writable, non-symlink Host route directories and retry the command.",
  );
}

async function main(request: HostHelperRequest) {
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
  const result = runDocker(["exec", containerName, "node", "/app/server.mjs", "--sporades-action", action, ...extraArgs], {
    maxBuffer: label === "Access-key" ? ACCESS_KEY_OPERATOR_PROCESS_MAX_BUFFER : undefined,
  });
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
  let priorRuntime: CapsuleRuntimeSettlement | null = null;
  let admissionError: unknown = null;
  try {
    await mkdir(path.dirname(registryLockPath(request)), { recursive: true });
    await withRegistryLock(request, async () => {
      if (await pathExists(registration.registryRecord)) {
        const existing = await readRegistryRecordForCapsule(request, "register");
        assertRegistryRecordMatchesRequest(request, existing);
        if (existing.status === "unregistered") {
          priorRuntime = captureCapsuleRuntimeSettlement(request, existing);
          quiesceCapsuleRuntime(priorRuntime);
          await mkdir(path.dirname(registration.registryRecord), { recursive: true });
          await mkdir(registration.directories.releases, { recursive: true });
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
      await mkdir(registration.directories.logs, { recursive: true });
      await writeUnavailableRoute(registration.lifecycle as unknown as HostedCapsuleLifecycle);
      sealedServerEnv = await ensureHostSealedEnvKeyPair(registration);
      await writeRegistryRecordAtomic(registration.registryRecord, createRegistrationRecord(registration, sealedServerEnv));
    });
  } catch (error) {
    admissionError = error;
  }
  await settleCapsuleRuntime(request, priorRuntime, admissionError);
  if (admissionError) throw admissionError;

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
  let priorRuntime: CapsuleRuntimeSettlement | null = null;
  let rotationError: unknown = null;
  try {
    await withRegistryLock(request, async () => {
      const record = await readRegistryRecordForCapsule(request, "rotate-key");
      assertRegistryRecordMatchesRequest(request, record);
      if (record.status === "unregistered") {
        throw helperError(
          "Hosted Capsule is unregistered.",
          `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before rotating the sealed-env key.`,
        );
      }

      priorRuntime = captureCapsuleRuntimeSettlement(request, record);
      quiesceCapsuleRuntime(priorRuntime);
      const dataDirectory = path.join(request.host.remoteRoot, "hosts", request.host.domain, "capsules", request.capsule.subname, "data");
      const previousPublicKeyFingerprint = record.sealedServerEnv?.currentKeyFingerprint ?? null;
      const sealedServerEnv = await generateHostSealedEnvKeyPair(dataDirectory);
      const now = new Date().toISOString();
      const nextRecord = {
        ...record,
        sealedServerEnv: { ...(record.sealedServerEnv ?? {}), currentKeyFingerprint: sealedServerEnv.publicKeyFingerprint },
        updatedAt: now,
      };
      const referenced = new Set([
        ...referencedSealedEnvKeyFingerprints(record),
        ...referencedSealedEnvKeyFingerprints(nextRecord),
      ]);
      if (record.sealedServerEnv?.currentKeyFingerprint) referenced.add(record.sealedServerEnv.currentKeyFingerprint);
      referenced.add(sealedServerEnv.publicKeyFingerprint);
      const cleanup = await cleanupUnreferencedHostSealedEnvKeys(dataDirectory, referenced);
      await writeRegistryRecordAtomic(registryPath(request), nextRecord);
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
  } catch (error) {
    rotationError = error;
  }
  await settleCapsuleRuntime(request, priorRuntime, rotationError);
  if (rotationError) throw rotationError;

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
    await withManagedRouteLock(unregister.route.routeFile, async () => {
      const route = await removeManagedRouteLocked(unregister.lifecycle as HostedCapsuleLifecycle, unregister.route.routeFile);
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
        await restoreRemovedRouteLocked(unregister.lifecycle as HostedCapsuleLifecycle, route);
        throw error;
      }
      await finalizeRemovedRouteLocked(route);
      data = createUnregisterResult(request, unregister, nextRecord, false, route);
    });
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

    await withManagedRouteLock(deletion.route.routeFile, async () => {
      const route = await removeManagedRouteLocked(deletion.lifecycle as HostedCapsuleLifecycle, deletion.route.routeFile);
      const capsuleDirectory = await removePathIfPresent(deletion.directories.capsule, { recursive: true });
      const registryRecord = await removePathIfPresent(deletion.registryRecord);
      await finalizeRemovedRouteLocked(route);
      data = createDeleteResult(request, deletion, {
        route,
        capsuleDirectory,
        registryRecord,
        idempotent: !record && !route.removed && !capsuleDirectory.removed && !registryRecord.removed,
      });
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
  const dataRoot = await openCanonicalRuntimeDataDirectory(paths.data, true);
  await dataRoot.close();
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

  let privateKeyRuntime: CapsuleRuntimeSettlement | null = null;
  if (releaseIncludesSealedServerEnvPrivateKey(release)) {
    privateKeyRuntime = captureCapsuleRuntimeSettlement(request, previousRecord);
    quiesceCapsuleRuntime(privateKeyRuntime);
    try {
      await installSealedServerEnvPrivateKey(release, paths.data);
      if (!release.restart) await settleCapsuleRuntime(request, privateKeyRuntime);
    } catch (error) {
      let settlementError: unknown = null;
      try {
        await settleCapsuleRuntime(request, privateKeyRuntime, error);
      } catch (failure) {
        settlementError = failure;
      }
      await rm(paths.release, { recursive: true, force: true });
      throw settlementError ?? error;
    }
  }

  await symlink(paths.release, tempCurrentLink);
  await rename(tempCurrentLink, paths.currentLink);
  await recordReleaseUploaded(request, release, installedInventory);

  let restartResult = null;
  let restartError = null;
  if (release.restart) {
    try {
      restartResult = await restartCapsule(request, { write: false, containerQuiesced: privateKeyRuntime?.wasRunning === true });
    } catch (error) {
      restartError = error;
    }
    if (!restartResult && privateKeyRuntime?.wasRunning) {
      await restorePreviousCurrentReleasePointer(paths, previousCurrentRelease?.id ?? null);
      try {
        await settleCapsuleRuntime(request, privateKeyRuntime, restartError ?? new Error("restart failed"));
      } catch (error) {
        restartError = error;
      }
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

async function verifyInstalledPublicTree(request: HostHelperRequest, timeoutMs: number): Promise<
  | { ok: true; data: { url: string; path: string; responding: true; statusCode: number; html: true } }
  | { ok: false; data: { url: string; path: string; responding: boolean; statusCode: number | null; html: false }; error: { message: string } }
> {
  const url = new URL("/", `${request.host.scheme ?? "https"}://${request.capsule.subname}.${request.host.domain}`).toString();
  const deadline = Date.now() + timeoutMs;
  let lastFailure: { ok: false; data: { url: string; path: string; responding: boolean; statusCode: number | null; html: false }; error: { message: string } } = {
    ok: false,
    data: { url, path: "/", responding: false, statusCode: null as number | null, html: false },
    error: { message: "Hosted Capsule installed public tree did not respond." },
  };

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.toLowerCase().startsWith("text/html")) {
        await response.body?.cancel();
        return { ok: true, data: { url, path: "/", responding: true, statusCode: response.status, html: true } };
      }
      await response.body?.cancel();
      lastFailure = {
        ok: false,
        data: { url, path: "/", responding: response.ok, statusCode: response.status, html: false },
        error: { message: "Hosted Capsule installed public tree did not serve its HTML entry." },
      };
    } catch {
      lastFailure = {
        ok: false,
        data: { url, path: "/", responding: false, statusCode: null, html: false },
        error: { message: "Hosted Capsule installed public tree did not respond." },
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(100, remainingMs));
    }
  }

  return lastFailure;
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
  if (options.containerQuiesced !== true) stopAndRemoveContainer(lifecycle.container.name);
  await prepareWritableDataPath(paths.data);
  await recordReleaseStartAttempt(request, releaseId);

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

function releaseIncludesSealedServerEnvPrivateKey(release: HostHelperRelease) {
  const privateKey = release.sealedServerEnv?.privateKey;
  const privateKeyPath = release.sealedServerEnv?.privateKeyPath;
  return Boolean(release.sealedServerEnvIncluded && privateKey && privateKeyPath);
}

async function installSealedServerEnvPrivateKey(release: HostHelperRelease, dataDirectory: string) {
  if (!releaseIncludesSealedServerEnvPrivateKey(release)) return;
  const privateKey = release.sealedServerEnv!.privateKey!;
  const privateKeyPath = release.sealedServerEnv!.privateKeyPath!;
  const dataHandle = await openCanonicalRuntimeDataDirectory(dataDirectory, true);
  try {
    const rootHandle = await openOrCreateRuntimeDirectory(dataHandle, path.dirname(privateKeyPath));
    try {
      await publishRuntimeFile(rootHandle, privateKeyPath, privateKey, 0o600, "release-private-key-publish");
    } finally {
      await rootHandle.close();
    }
  } finally {
    await dataHandle.close();
  }
}

async function restorePreviousCurrentReleasePointer(paths: ReleasePaths, previousReleaseId: string | null) {
  const temporary = `${paths.currentLink}.restore-${process.pid}-${randomBytes(8).toString("hex")}`;
  await rm(temporary, { force: true });
  if (!previousReleaseId) {
    await rm(paths.currentLink, { force: true });
    return;
  }
  await symlink(path.join(paths.releases, previousReleaseId), temporary);
  await rename(temporary, paths.currentLink);
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

  const routeRefresh = await refreshLoopbackRunningRoute(request, record, health.container.name);
  if (!routeRefresh.ok) {
    return healthFailure(
      request,
      health,
      "route-failure",
      "Docker did not report the Hosted Capsule's current loopback published port.",
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
  if (options.containerQuiesced !== true) stopAndRemoveContainer(lifecycle.container.name);
  const startResult = await startCapsule(request, { write: false, containerQuiesced: true });
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
  const hostedUrl = registryRecord?.hostedUrl ?? request.release?.hostedUrl ?? `${request.host.scheme ?? "https"}://${subname}.${domain}`;
  const remoteCapsuleId = registryRecord?.remoteCapsuleId ?? request.release?.remoteCapsuleId ?? `${domain}/${subname}`;
  const containerName = createHostedContainerName(domain, subname);
  const routeFile = canonicalManagedRouteFile(request);
  assertCanonicalLifecycleRoutePaths(provided, routeFile);
  const currentLink = paths.currentLink;
  const accessLog = canonicalCapsuleHttpLogPath(request);
  const sealedServerEnvPrivateKey = releaseSealedServerEnvPrivateKeyMount(registryRecord, paths);
  const sshAuthorizedKeysMount = releaseSshAuthorizedKeysMount(registryRecord, paths);
  const authoritativeBaseImage = request.release?.baseImage ?? registryRecord?.baseImage ?? null;
  const updatePolicyMode = normaliseBaseImageUpdatePolicy(authoritativeBaseImage?.updatePolicy);
  const baseImage = {
    ...baseImageMetadata(updatePolicyMode),
    name: authoritativeBaseImage?.name ?? SPORADES_BASE_IMAGE.name,
    image: authoritativeBaseImage?.image ?? hostHelperConfig.hostedCapsule.dockerImage,
    version: authoritativeBaseImage?.version ?? SPORADES_BASE_IMAGE.version,
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
  const canonicalContainer = {
    name: containerName,
    network: hostHelperConfig.hostedCapsule.dockerNetwork,
    image: baseImage.image,
    user: baseImageRuntimeUser(),
    baseImage,
    graceCheckMs: hostHelperConfig.hostedCapsule.graceCheckMs,
    labels: {
      "com.sporades.managed": "true",
      "com.sporades.hosted-domain": domain,
      "com.sporades.capsule-subname": subname,
      "com.sporades.capsule-id": remoteCapsuleId,
      ...baseImageLabels(updatePolicyMode),
    },
  };
  assertCanonicalLifecycleAuthority(provided, {
    hostedUrl,
    remoteCapsuleId,
    currentLink,
    paths,
    defaultMounts,
    container: canonicalContainer,
  });
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
      files: fileMounts,
      data: defaultMounts.data,
    },
    container: canonicalContainer,
    routes: {
      running: withRouteAccessLog(
        provided.routes?.running ? {
          ...provided.routes.running,
          routeFile,
        } : {
          hostname: `${subname}.${domain}`,
          target: "container",
          containerName,
          port: 4000,
          routeFile,
        },
        accessLog,
      ),
      unavailable: withRouteAccessLog(
        provided.routes?.unavailable ? {
          ...provided.routes.unavailable,
          routeFile,
        } : {
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

function assertCanonicalLifecycleAuthority(provided: HostedCapsuleLifecycle, canonical: any) {
  const reject = () => {
    throw helperError(
      "Invalid Hosted Capsule lifecycle authority.",
      "Upgrade the local Sporades CLI and Host helper together, then retry the lifecycle command.",
    );
  };
  const exactWhenSupplied = (supplied: any, expected: any) => {
    if (supplied !== undefined && !isDeepStrictEqual(supplied, expected)) reject();
  };
  exactWhenSupplied(provided.hostedUrl, canonical.hostedUrl);
  exactWhenSupplied(provided.remoteCapsuleId, canonical.remoteCapsuleId);
  exactWhenSupplied(provided.currentLink, canonical.currentLink);
  if (provided.directories) {
    const permitted = {
      capsule: canonical.paths.capsule,
      releases: canonical.paths.releases,
      release: canonical.paths.release,
      data: canonical.paths.data,
      logs: canonical.paths.logs,
    };
    for (const [key, value] of Object.entries(provided.directories)) {
      if (!(key in permitted) || !isDeepStrictEqual(value, (permitted as any)[key])) reject();
    }
  }
  if (provided.mounts) {
    if (Object.keys(provided.mounts).some((key) => !["files", "data"].includes(key))) reject();
    exactWhenSupplied(provided.mounts.data, canonical.defaultMounts.data);
    if (provided.mounts.files) {
      const allowedByContainer = new Map(canonical.defaultMounts.files.map((mount: any) => [mount.container, mount]));
      const legacyAllowed = [
        { host: path.join(canonical.currentLink, "client.js"), container: "/app/client.js", mode: "ro" },
        { host: path.join(canonical.currentLink, "index.html"), container: "/app/index.html", mode: "ro" },
      ];
      for (const mount of legacyAllowed) allowedByContainer.set(mount.container, mount);
      const seen = new Set<string>();
      for (const mount of provided.mounts.files) {
        if (!mount || typeof mount.container !== "string" || seen.has(mount.container)) reject();
        seen.add(mount.container);
        const expected = allowedByContainer.get(mount.container);
        if (!expected || !isDeepStrictEqual(mount, expected)) reject();
      }
    }
  }
  if (provided.container) {
    for (const [key, value] of Object.entries(provided.container)) {
      if (!(key in canonical.container)) reject();
      if (key === "labels" && value && typeof value === "object") {
        for (const [label, labelValue] of Object.entries(value)) {
          if (!isDeepStrictEqual(labelValue, canonical.container.labels[label])) reject();
        }
        continue;
      }
      if (key === "baseImage" && value && typeof value === "object") {
        for (const [field, fieldValue] of Object.entries(value)) {
          if (!isDeepStrictEqual(fieldValue, canonical.container.baseImage[field])) reject();
        }
        continue;
      }
      if (!isDeepStrictEqual(value, canonical.container[key])) reject();
    }
  }
  const expectedRunning = {
    hostname: `${canonical.paths.capsule.split(path.sep).at(-1)}.${canonical.paths.capsule.split(path.sep).at(-3)}`,
    target: "container",
    containerName: canonical.container.name,
    port: 4000,
  };
  const expectedUnavailable = {
    hostname: expectedRunning.hostname,
    target: "hosted-capsule-unavailable",
  };
  for (const [route, expected] of [[provided.routes?.running, expectedRunning], [provided.routes?.unavailable, expectedUnavailable]] as const) {
    if (!route) continue;
    for (const [key, value] of Object.entries(expected)) exactWhenSupplied((route as any)[key], value);
  }
  const unavailableStatus = provided.routes?.unavailable?.statusCode;
  if (unavailableStatus !== undefined
    && (!Number.isInteger(unavailableStatus) || Number(unavailableStatus) < 500 || Number(unavailableStatus) > 599)) reject();
}

function assertCanonicalLifecycleRoutePaths(provided: HostedCapsuleLifecycle, canonicalRouteFile: string) {
  const supplied = [provided.routes?.running?.routeFile, provided.routes?.unavailable?.routeFile]
    .filter((value): value is string => typeof value === "string");
  if (supplied.some((value) => path.resolve(value) !== canonicalRouteFile)) {
    throw helperError(
      "Hosted Capsule lifecycle route did not match its canonical route path.",
      "Upgrade the local Sporades CLI and Host helper together, then retry the lifecycle command.",
    );
  }
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
  const accessLog = canonicalCapsuleHttpLogPath(request, remoteRoot);
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
  await prepareWritableDataPath(dataDirectory);
  const dataHandle = await openCanonicalRuntimeDataDirectory(dataDirectory, false);
  try {
    const rootHandle = await openOrCreateRuntimeDirectory(dataHandle, paths.root);
    try {
      const keysHandle = await openOrCreateRuntimeDirectory(rootHandle, paths.keys);
      try {
        await writeExclusiveRuntimeFile(keysHandle, paths.privateKey, privateKey, 0o600);
        await writeExclusiveRuntimeFile(keysHandle, paths.publicKey, publicKey, 0o644);
      } finally {
        await keysHandle.close();
      }
    } finally {
      await rootHandle.close();
    }
  } finally {
    await dataHandle.close();
  }
  return {
    publicKey,
    publicKeyFingerprint,
    publicKeyPath: paths.publicKey,
  };
}

async function openOrCreateRuntimeDirectory(parentHandle: any, targetPath: string) {
  const descriptorPath = descriptorChildPath(parentHandle.fd, path.basename(targetPath), targetPath);
  await mkdir(descriptorPath, { mode: 0o700 }).catch((error) => {
    if (errorDetails(error).code !== "EEXIST") throw runtimeDataTrustError(targetPath);
  });
  const handle = await open(
    descriptorPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0),
  ).catch(() => { throw runtimeDataTrustError(targetPath); });
  const details = await handle.stat();
  if (!details.isDirectory()) {
    await handle.close();
    throw runtimeDataTrustError(targetPath);
  }
  await prepareRuntimeDataOwnershipHandle(handle, targetPath, details);
  if ((Number(details.mode) & 0o777) !== 0o700) await handle.chmod(0o700);
  await assertRuntimeDataPathIdentity(targetPath, { dev: details.dev, ino: details.ino }, true);
  return handle;
}

async function writeExclusiveRuntimeFile(parentHandle: any, targetPath: string, contents: string, mode: number) {
  const descriptorPath = descriptorChildPath(parentHandle.fd, path.basename(targetPath), targetPath);
  const handle = await open(
    descriptorPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  ).catch(() => { throw runtimeDataTrustError(targetPath); });
  try {
    const identity = await handle.stat();
    if (!identity.isFile()) throw runtimeDataTrustError(targetPath);
    await pauseRuntimeDataDescriptorMutation(targetPath);
    await prepareRuntimeDataOwnershipHandle(handle, targetPath, identity);
    await handle.writeFile(contents);
    await handle.chmod(mode);
    const final = await handle.stat();
    if (final.dev !== identity.dev || final.ino !== identity.ino) throw runtimeDataTrustError(targetPath);
    await assertRuntimeDataPathIdentity(targetPath, { dev: final.dev, ino: final.ino }, false);
  } finally {
    await handle.close();
  }
}

async function publishRuntimeFile(
  parentHandle: any,
  targetPath: string,
  contents: string,
  mode: number,
  boundary: string,
) {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  await writeExclusiveRuntimeFile(parentHandle, temporaryPath, contents, mode);
  const temporaryDescriptor = descriptorChildPath(parentHandle.fd, path.basename(temporaryPath), temporaryPath);
  const targetDescriptor = descriptorChildPath(parentHandle.fd, path.basename(targetPath), targetPath);
  try {
    await pauseRuntimeTreePublication(boundary, targetPath);
    const parentIdentity = await parentHandle.stat();
    await assertRuntimeDataPathIdentity(path.dirname(targetPath), { dev: parentIdentity.dev, ino: parentIdentity.ino }, true);
    try {
      const existing = await lstat(targetPath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw runtimeDataTrustError(targetPath);
    } catch (error) {
      if (errorDetails(error).code !== "ENOENT") throw error;
    }
    await rename(temporaryDescriptor, targetDescriptor).catch(() => { throw runtimeDataTrustError(targetPath); });
    const installed = await open(targetDescriptor, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw runtimeDataTrustError(targetPath); });
    try {
      const details = await installed.stat();
      if (!details.isFile()) throw runtimeDataTrustError(targetPath);
      await assertRuntimeDataPathIdentity(targetPath, { dev: details.dev, ino: details.ino }, false);
    } finally {
      await installed.close();
    }
  } finally {
    await rm(temporaryDescriptor, { force: true }).catch(() => {});
  }
}

async function pauseRuntimeTreePublication(boundary: string, targetPath: string) {
  if (process.env.SPORADES_TEST_RUNTIME_TREE_PUBLICATION_BOUNDARY !== boundary) return;
  const marker = process.env.SPORADES_TEST_RUNTIME_TREE_PUBLICATION_MARKER;
  if (marker) await writeFile(marker, `${targetPath}\n`, { flag: "wx", mode: 0o600 });
  await fakeManagedRouteLockPause("SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS");
}

async function cleanupUnreferencedHostSealedEnvKeys(dataDirectory: string, referencedFingerprints: any) {
  const paths = hostSealedEnvKeyPaths(dataDirectory, "placeholder");
  const dataHandle = await openCanonicalRuntimeDataDirectory(dataDirectory, false);
  const deleted = new Set();
  try {
    const rootHandle = await openOrCreateRuntimeDirectory(dataHandle, paths.root);
    try {
      const keysHandle = await openOrCreateRuntimeDirectory(rootHandle, paths.keys);
      try {
        const keysIdentity = await keysHandle.stat();
        const descriptorDirectory = process.platform === "linux" ? `/proc/self/fd/${keysHandle.fd}` : paths.keys;
        const entries = await readdir(descriptorDirectory);
        for (const entry of entries) {
          const match = /^([a-f0-9]{16})\.(private|public)\.pem$/.exec(entry);
          if (!match || referencedFingerprints.has(match[1])) continue;
          const targetPath = path.join(paths.keys, entry);
          const descriptorPath = descriptorChildPath(keysHandle.fd, entry, targetPath);
          const retained = await open(descriptorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
            .catch(() => { throw runtimeDataTrustError(targetPath); });
          try {
            const details = await retained.stat();
            if (!details.isFile()) throw runtimeDataTrustError(targetPath);
            await pauseRuntimeTreePublication("sealed-key-cleanup", targetPath);
            await assertRuntimeDataPathIdentity(paths.keys, { dev: keysIdentity.dev, ino: keysIdentity.ino }, true);
            await assertRuntimeDataPathIdentity(targetPath, { dev: details.dev, ino: details.ino }, false);
            await rm(descriptorPath, { force: true });
          } finally {
            await retained.close();
          }
          deleted.add(match[1]);
        }
        await assertRuntimeDataPathIdentity(paths.keys, { dev: keysIdentity.dev, ino: keysIdentity.ino }, true);
      } finally {
        await keysHandle.close();
      }
    } finally {
      await rootHandle.close();
    }
  } finally {
    await dataHandle.close();
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
  const expectedDirectories = {
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
  };
  for (const [name, value] of Object.entries(provided.directories ?? {})) {
    if (!(name in expectedDirectories) || value !== expectedDirectories[name as keyof typeof expectedDirectories]) throw bootstrapPathError();
  }
  if (provided.domainDirectory !== undefined && provided.domainDirectory !== expectedDirectories.domain) throw bootstrapPathError();
  const tlsMode = provided.tls?.mode ?? "automatic";
  const directories = {
    ...expectedDirectories,
  };
  const expectedCertificate = path.join(directories.tls, "origin.crt");
  const expectedKey = path.join(directories.tls, "origin.key");
  if (provided.tls?.directory !== undefined && provided.tls.directory !== directories.tls) throw bootstrapPathError();
  if (provided.tls?.certificate != null && provided.tls.certificate !== expectedCertificate) throw bootstrapPathError();
  if (provided.tls?.key != null && provided.tls.key !== expectedKey) throw bootstrapPathError();
  const tls = {
    mode: tlsMode,
    directory: provided.tls?.directory ?? directories.tls,
    certificate: tlsMode === "cloudflare-origin" ? expectedCertificate : null,
    key: tlsMode === "cloudflare-origin" ? expectedKey : null,
  };
  const expectedManagedInclude = path.join(directories.caddy, "sporades-hosted-domains.caddy");
  const expectedDomainInclude = path.join(directories.caddyHosts, `${domain}.caddy`);
  const expectedAccessLog = defaultCaddyAccessLogPath(remoteRoot);
  if (provided.caddy?.managedInclude !== undefined && provided.caddy.managedInclude !== expectedManagedInclude) throw bootstrapPathError();
  if (provided.caddy?.domainInclude !== undefined && provided.caddy.domainInclude !== expectedDomainInclude) throw bootstrapPathError();
  if (provided.caddy?.accessLog !== undefined && provided.caddy.accessLog !== expectedAccessLog) throw bootstrapPathError();
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
      managedInclude: expectedManagedInclude,
      domainInclude: expectedDomainInclude,
      routesDirectory: path.join(directories.caddyHosts, domain),
      healthRoute: path.join(directories.caddyHosts, domain, "host.caddy"),
      accessLog: expectedAccessLog,
    },
  };
}

function bootstrapPathError() {
  return helperError(
    "Invalid Host bootstrap path.",
    "Use the canonical paths beneath the configured Host remote root and retry bootstrap.",
  );
}

function bootstrapTrustManifest(request: HostHelperRequest) {
  const bootstrap = normaliseBootstrap(request);
  const placeholder = path.join(bootstrap.caddy.routesDirectory, ".sporades-placeholder.caddy");
  const finalFiles: Array<{ path: string; caddyOwned?: boolean }> = [
    { path: bootstrap.caddy.caddyfile },
    { path: bootstrap.caddy.managedInclude },
    { path: bootstrap.caddy.domainInclude },
    { path: bootstrap.caddy.healthRoute },
    { path: placeholder },
    { path: bootstrap.caddy.accessLog, caddyOwned: true },
  ];
  if (bootstrap.tls.certificate && bootstrap.tls.key) {
    finalFiles.push({ path: bootstrap.tls.certificate }, { path: bootstrap.tls.key });
  }
  return {
    directories: [
      ...Object.values(bootstrap.directories).map((entry) => ({ path: entry })),
      { path: path.dirname(bootstrap.caddy.accessLog), caddyOwned: true },
      { path: path.join(bootstrap.directories.registry, "capsules") },
      { path: bootstrap.caddy.routesDirectory },
    ],
    finalFiles,
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
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw routeTrustError();
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
  await provisionCaddyOwnedLogDescriptors({
    logDirectory,
    logFile,
    owner: caddyUser,
    mutationBoundary: "bootstrap-access-log-descriptor-mutate",
    failureMessage: "Failed to provision the Caddy access log for the service user.",
    failureHint: `Ensure the Host helper runs with permission to provision ${logDirectory} and ${logFile}, then rerun \`sporades host bootstrap --host ${request.host.alias}\`.`,
  });

  return {
    file: logFile,
    directory: logDirectory,
    owner: caddyUser.name,
    writableByService: true,
  };
}

async function provisionCaddyOwnedLogDescriptors(options: {
  logDirectory: string;
  logFile: string;
  owner: { uid: string; gid: string };
  mutationBoundary: string;
  failureMessage: string;
  failureHint: string;
}) {
  const { logDirectory, logFile } = options;
  const uid = Number(options.owner.uid);
  const gid = Number(options.owner.gid);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw routeTrustError();
  const owner = { uid, gid };
  const trust = activeManagedRouteTrust;
  if (!trust) throw routeTrustError();
  const directoryIdentity = trust.directories.find((entry) => entry.path === logDirectory);
  const fileIdentity = trust.finalFiles.find((entry) => entry.path === logFile && entry.caddyOwned);
  if (!directoryIdentity || !fileIdentity) throw routeTrustError();
  await assertManagedLogMutationBoundary(logFile);
  const directoryHandle = await open(
    logDirectory,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0),
  ).catch(() => { throw routeTrustError(); });
  try {
    let directoryDetails = await directoryHandle.stat();
    if (!directoryDetails.isDirectory()
      || directoryDetails.dev !== directoryIdentity.dev || directoryDetails.ino !== directoryIdentity.ino
      || !(directoryIdentity.expectedOwner
        ? trustedExactOwnerMetadata(directoryDetails as Awaited<ReturnType<typeof lstat>>, directoryIdentity.expectedOwner)
        : trustedHostPathMetadata(directoryDetails as Awaited<ReturnType<typeof lstat>>))) throw routeTrustError();

    const descriptorFile = process.platform === "linux"
      ? `/proc/self/fd/${directoryHandle.fd}/${path.basename(logFile)}`
      : logFile;
    let fileHandle;
    try {
      fileHandle = await open(
        descriptorFile,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o640,
      );
    } catch (error) {
      if (errorDetails(error).code !== "EEXIST") throw routeTrustError();
      fileHandle = await open(descriptorFile, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW).catch(() => { throw routeTrustError(); });
    }
    try {
      let fileDetails = await fileHandle.stat();
      if (!fileDetails.isFile()
        || (fileIdentity.identity && (fileDetails.dev !== fileIdentity.identity.dev || fileDetails.ino !== fileIdentity.identity.ino))
        || !(fileIdentity.expectedOwner
          ? trustedExactOwnerMetadata(fileDetails as Awaited<ReturnType<typeof lstat>>, fileIdentity.expectedOwner)
          : trustedHostPathMetadata(fileDetails as Awaited<ReturnType<typeof lstat>>))) throw routeTrustError();

      const directoryNeedsMutation = !trustedExactOwnerMetadata(directoryDetails as Awaited<ReturnType<typeof lstat>>, owner)
        || (Number(directoryDetails.mode) & 0o777) !== 0o750;
      const fileNeedsMutation = !trustedExactOwnerMetadata(fileDetails as Awaited<ReturnType<typeof lstat>>, owner)
        || (Number(fileDetails.mode) & 0o777) !== 0o640;
      if (directoryNeedsMutation || fileNeedsMutation) {
        await pauseCaddyLogDescriptorMutation(options.mutationBoundary);
        directoryDetails = await directoryHandle.stat();
        fileDetails = await fileHandle.stat();
        if (directoryDetails.dev !== directoryIdentity.dev || directoryDetails.ino !== directoryIdentity.ino
          || (fileIdentity.identity && (fileDetails.dev !== fileIdentity.identity.dev || fileDetails.ino !== fileIdentity.identity.ino))) throw routeTrustError();
        try {
          if (directoryNeedsMutation) {
            if (Number(directoryDetails.uid) !== uid || Number(directoryDetails.gid) !== gid) await directoryHandle.chown(uid, gid);
            if ((Number(directoryDetails.mode) & 0o777) !== 0o750) await directoryHandle.chmod(0o750);
          }
          if (fileNeedsMutation) {
            if (Number(fileDetails.uid) !== uid || Number(fileDetails.gid) !== gid) await fileHandle.chown(uid, gid);
            if ((Number(fileDetails.mode) & 0o777) !== 0o640) await fileHandle.chmod(0o640);
          }
        } catch {
          throw helperError(
            options.failureMessage,
            options.failureHint,
          );
        }
        directoryDetails = await directoryHandle.stat();
        fileDetails = await fileHandle.stat();
      }

      const directoryPathDetails = await lstat(logDirectory).catch(() => { throw routeTrustError(); });
      const filePathDetails = await lstat(logFile).catch(() => { throw routeTrustError(); });
      if (!directoryPathDetails.isDirectory() || directoryPathDetails.isSymbolicLink()
        || !filePathDetails.isFile() || filePathDetails.isSymbolicLink()
        || directoryPathDetails.dev !== directoryDetails.dev || directoryPathDetails.ino !== directoryDetails.ino
        || filePathDetails.dev !== fileDetails.dev || filePathDetails.ino !== fileDetails.ino
        || !trustedExactOwnerMetadata(directoryDetails as Awaited<ReturnType<typeof lstat>>, owner)
        || !trustedExactOwnerMetadata(fileDetails as Awaited<ReturnType<typeof lstat>>, owner)
        || (Number(directoryDetails.mode) & 0o777) !== 0o750
        || (Number(fileDetails.mode) & 0o777) !== 0o640) throw routeTrustError();
      directoryIdentity.expectedOwner = owner;
      fileIdentity.expectedOwner = owner;
      fileIdentity.identity = { path: logFile, dev: fileDetails.dev, ino: fileDetails.ino, expectedOwner: owner };
      await assertActiveManagedRouteTrust(trust.routeFile);
    } finally {
      await fileHandle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

async function assertManagedLogMutationBoundary(logFile: string) {
  const routeFile = activeManagedRouteTrust?.routeFile ?? null;
  await assertActiveManagedRouteTrust(routeFile);
  await assertTrustedRegularFileIfExists(logFile, trustedBootstrapFinalFileOwner(logFile));
}

async function pauseCaddyLogDescriptorMutation(boundary: string) {
  if (process.env.SPORADES_TEST_ROUTE_MUTATION_BOUNDARY !== boundary) return;
  const marker = process.env.SPORADES_TEST_ROUTE_MUTATION_MARKER;
  if (marker) await writeFile(marker, `${boundary}\n`, { flag: "wx", mode: 0o600 });
  await fakeManagedRouteLockPause("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
}

async function provisionRouteLogFile(route: HostedCapsuleRoute, mutationBoundary: string) {
  const logFile = route.log?.file;
  if (!logFile) {
    return;
  }
  const logDirectory = path.dirname(logFile);
  const caddyUser = resolveCaddyServiceUser() ?? {
    uid: String(process.geteuid?.() ?? process.getuid?.() ?? 0),
    gid: String(process.getegid?.() ?? process.getgid?.() ?? 0),
  };
  await provisionCaddyOwnedLogDescriptors({
    logDirectory,
    logFile,
    owner: caddyUser,
    mutationBoundary,
    failureMessage: "Failed to provision the Hosted Capsule HTTP log for the Caddy service user.",
    failureHint: `Ensure the Host helper runs with permission to provision ${logDirectory} and ${logFile}, then retry the Hosted Capsule command.`,
  });
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
  await assertActiveManagedRouteTrust(null);
  const caddyfile = bootstrap.caddy.caddyfile;
  const managedInclude = bootstrap.caddy.managedInclude;
  const domainInclude = bootstrap.caddy.domainInclude;
  const placeholderRoute = path.join(bootstrap.caddy.routesDirectory, ".sporades-placeholder.caddy");
  await atomicPublishBootstrapFile(placeholderRoute, "# Sporades keeps this placeholder so Caddy route imports are valid before Capsules are registered.\n", "bootstrap-placeholder");
  await atomicPublishBootstrapFile(bootstrap.caddy.healthRoute, renderHostHealthRoute(request.host.domain, bootstrap.tls), "bootstrap-health-route");
  await writeManagedCaddyfile(caddyfile, `import ${managedInclude}`);
  await atomicPublishBootstrapFile(managedInclude, `# Sporades-managed Hosted domain include list.\nimport ${path.join(bootstrap.directories.caddyHosts, "*.caddy")}\n`, "bootstrap-managed-include");
  await atomicPublishBootstrapFile(domainInclude, `# Sporades-managed routes for ${request.host.domain}.\nimport ${path.join(bootstrap.caddy.routesDirectory, "*.caddy")}\n`, "bootstrap-domain-include");

  await assertActiveManagedRouteTrust(null);
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
  await assertBootstrapMutationBoundary("bootstrap-caddyfile-read", [caddyfile]);
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
  await atomicPublishBootstrapFile(caddyfile, next, "bootstrap-caddyfile");
}

async function atomicPublishBootstrapFile(target: string, contents: string, boundary: string) {
  const temporary = `${target}.sporades-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  await assertBootstrapMutationBoundary(`${boundary}-write`, [target, temporary]);
  await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
  try {
    await assertBootstrapMutationBoundary(`${boundary}-publish`, [target, temporary]);
    await rename(temporary, target);
    await refreshTrustedBootstrapFinalFileIdentity(target);
  } catch (error) {
    await assertBootstrapMutationBoundary(`${boundary}-cleanup`, [target, temporary]);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function refreshTrustedBootstrapFinalFileIdentity(target: string) {
  const trust = activeManagedRouteTrust;
  const entry = trust?.finalFiles.find((candidate) => candidate.path === target);
  if (!entry) throw routeTrustError();
  const details = await assertTrustedRegularFileIfExists(target, entry.expectedOwner);
  if (!details) throw routeTrustError();
  entry.identity = { path: target, dev: details.dev, ino: details.ino, expectedOwner: entry.expectedOwner };
}

async function assertBootstrapMutationBoundary(boundary: string, relatedFiles: string[] = []) {
  await assertActiveManagedRouteTrust(null);
  for (const file of relatedFiles) await assertTrustedRegularFileIfExists(file, trustedBootstrapFinalFileOwner(file));
  if (process.env.SPORADES_TEST_ROUTE_MUTATION_BOUNDARY === boundary) {
    const marker = process.env.SPORADES_TEST_ROUTE_MUTATION_MARKER;
    if (marker) await writeFile(marker, `${boundary}\n`, { flag: "wx", mode: 0o600 });
    await fakeManagedRouteLockPause("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
  }
  await assertActiveManagedRouteTrust(null);
  for (const file of relatedFiles) await assertTrustedRegularFileIfExists(file, trustedBootstrapFinalFileOwner(file));
}

function trustedBootstrapFinalFileOwner(file: string) {
  return activeManagedRouteTrust?.finalFiles.find((entry) => entry.path === file)?.expectedOwner;
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

type CapsuleRuntimeSettlement = {
  containerName: string;
  wasRunning: boolean;
  registryWasRunning: boolean;
};

function captureCapsuleRuntimeSettlement(request: HostHelperRequest, record: any = null): CapsuleRuntimeSettlement {
  const containerName = createHostedContainerName(request.host.domain, request.capsule.subname);
  return { containerName, wasRunning: checkContainerRunning(containerName), registryWasRunning: record?.status === "running" };
}

function quiesceCapsuleRuntime(settlement: CapsuleRuntimeSettlement | null) {
  if (settlement?.wasRunning) stopAndRemoveContainer(settlement.containerName);
}

async function settleCapsuleRuntime(
  request: HostHelperRequest,
  settlement: CapsuleRuntimeSettlement | null,
  actionError: unknown = null,
) {
  if (!settlement) return;
  if (!settlement.wasRunning) {
    if (settlement.registryWasRunning) {
      const record = await readRegistryRecordForCapsule(request, "lifecycle");
      await writeUnavailableRoute(normaliseLifecycle(request, record));
      await updateRegistryStatus(request, "stopped");
    }
    return;
  }
  try {
    const restored = await startCapsule(request, { write: false, containerQuiesced: true });
    if (!restored) throw helperError("Hosted Capsule runtime restoration failed.", "Check the stopped Capsule and retry the Host operation.");
  } catch (error) {
    try {
      const record = await readRegistryRecordForCapsule(request, "lifecycle");
      await writeUnavailableRoute(normaliseLifecycle(request, record));
      await updateRegistryStatus(request, "stopped");
    } catch {
      // The original action and restoration failure remain authoritative; never claim the Capsule is running.
    }
    throw helperError(
      "Hosted Capsule runtime restoration failed.",
      actionError
        ? "The Host operation failed and the previous runtime could not be restored; repair the Capsule data path and start it explicitly."
        : "The Host operation settled its provider-free state but could not restore the previous runtime; start the Capsule explicitly.",
    );
  }
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
  const result = spawnSync("docker", args, { encoding: "utf8", ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}) });
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

async function refreshLoopbackRunningRoute(request: HostHelperRequest, registryRecord: any, containerName: string) {
  const lifecycle = normaliseLifecycle(request, registryRecord);
  const routeFile = lifecycle.routes.running.routeFile;
  return withManagedRouteLock(routeFile, async () => {
    let currentRoute;
    try {
      currentRoute = await readFile(routeFile, "utf8");
    } catch (error) {
      if (errorDetails(error).code === "ENOENT") {
        return { ok: true, refreshed: false };
      }
      throw error;
    }

    const loopbackUpstream = /(reverse_proxy\s+)127\.0\.0\.1:[1-9][0-9]*(\s+\{)/g;
    if (!loopbackUpstream.test(currentRoute)) {
      return { ok: true, refreshed: false };
    }
    loopbackUpstream.lastIndex = 0;

    const publishedPort = inspectLoopbackPublishedPort(containerName, lifecycle.routes.running.port ?? 4000);
    if (!publishedPort) {
      return { ok: false, refreshed: false };
    }
    const currentUpstream = `${publishedPort.hostIp}:${publishedPort.hostPort}`;
    const refreshedRoute = currentRoute.replace(loopbackUpstream, `$1${currentUpstream}$2`);
    if (refreshedRoute === currentRoute) {
      return { ok: true, refreshed: false, publishedPort };
    }

    await applyManagedRouteLocked(lifecycle, routeFile, refreshedRoute);
    return { ok: true, refreshed: true, publishedPort };
  });
}

async function writeRunningRoute(lifecycle: HostedCapsuleLifecycle, route: HostedCapsuleRoute = lifecycle.routes.running) {
  await provisionRouteLogFile(route, "capsule-running-http-log-descriptor-mutate");
  const cloudflareOrigin = (route.tls as LooseRecord | undefined)?.mode === "cloudflare-origin";
  const proxyLine = [
    `reverse_proxy ${route.upstream ?? `${route.containerName}:${route.port ?? 4000}`} {`,
    `    header_up ${ACCESS_KEY_CLIENT_ADDRESS_HEADER} ${cloudflareOrigin
      ? "{http.request.header.CF-Connecting-IP}"
      : "{http.request.remote.host}"}`,
    "  }",
  ].join("\n");
  const routeHandler = renderRunningRouteHandler(route, proxyLine);
  const guardedHandler = cloudflareOrigin
    ? [
      `@sporadesUntrustedCloudflareSource not remote_ip ${CLOUDFLARE_ORIGIN_IP_RANGES.join(" ")}`,
      "respond @sporadesUntrustedCloudflareSource 403",
      routeHandler,
    ].join("\n  ")
    : routeHandler;
  await applyManagedRoute(
    lifecycle,
    route.routeFile,
    renderRoute(route, guardedHandler),
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
  await provisionRouteLogFile(route, "capsule-unavailable-http-log-descriptor-mutate");
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
  return withManagedRouteLock(routeFile, () => applyManagedRouteLocked(lifecycle, routeFile, contents));
}

async function applyManagedRouteLocked(lifecycle: HostedCapsuleLifecycle, routeFile: string, contents: any) {
  const tempRouteFile = `${routeFile}.tmp`;
  const previousRouteFile = `${routeFile}.previous-${process.pid}`;
  await assertManagedRouteMutationBoundary(routeFile, "apply-remove-temp", [tempRouteFile, previousRouteFile]);
  await rm(tempRouteFile, { force: true });
  await assertManagedRouteMutationBoundary(routeFile, "apply-remove-previous", [previousRouteFile]);
  await rm(previousRouteFile, { force: true });
  await assertManagedRouteMutationBoundary(routeFile, "apply-write-temp", [tempRouteFile]);
  await writeFile(tempRouteFile, contents, { flag: "wx", mode: 0o644 });
  try {
    validateCaddyRoute(tempRouteFile);
  } catch (error) {
    await assertManagedRouteMutationBoundary(routeFile, "apply-validation-cleanup", [tempRouteFile]);
    await rm(tempRouteFile, { force: true });
    throw error;
  }

  const hadPreviousRoute = await pathExists(routeFile);
  let previousRouteMoved = false;
  try {
    if (hadPreviousRoute) {
      await assertManagedRouteMutationBoundary(routeFile, "apply-move-current", [previousRouteFile]);
      await rename(routeFile, previousRouteFile);
      previousRouteMoved = true;
    }
    await assertManagedRouteMutationBoundary(routeFile, "apply-publish-temp", [tempRouteFile, previousRouteFile]);
    await rename(tempRouteFile, routeFile);
    reloadCaddy(lifecycle);
  } catch (error) {
    await assertManagedRouteMutationBoundary(routeFile, "apply-rollback-remove-temp", [tempRouteFile, previousRouteFile]);
    await rm(tempRouteFile, { force: true });
    await assertManagedRouteMutationBoundary(routeFile, "apply-rollback-remove-current", [previousRouteFile]);
    await rm(routeFile, { force: true });
    if (previousRouteMoved) {
      await assertManagedRouteMutationBoundary(routeFile, "apply-rollback-restore", [previousRouteFile]);
      await rename(previousRouteFile, routeFile);
    }
    if (previousRouteMoved) {
      try {
        reloadCaddy(lifecycle);
      } catch (rollbackError) {
        throw helperError(
          "Failed to apply Hosted Capsule route and failed to reload the restored Caddy config.",
          "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry the lifecycle command.",
        );
      }
    }
    throw error;
  }

  await assertManagedRouteMutationBoundary(routeFile, "apply-finalize-previous", [previousRouteFile]);
  await rm(previousRouteFile, { force: true });
}

async function removeManagedRouteLocked(lifecycle: HostedCapsuleLifecycle, routeFile: string) {
  const previousRouteFile = `${routeFile}.previous-${process.pid}`;
  await assertManagedRouteMutationBoundary(routeFile, "remove-remove-previous", [previousRouteFile]);
  await rm(previousRouteFile, { force: true });
  const hadRoute = await pathExists(routeFile);
  if (!hadRoute) {
    return { routeFile, removed: false };
  }

  await assertManagedRouteMutationBoundary(routeFile, "remove-move-current", [previousRouteFile]);
  await rename(routeFile, previousRouteFile);
  try {
    reloadCaddy(lifecycle);
  } catch (error) {
    await assertManagedRouteMutationBoundary(routeFile, "remove-rollback-restore", [previousRouteFile]);
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

async function finalizeRemovedRouteLocked(route: HostedCapsuleRoute) {
  if (route?.previousRouteFile) {
    await assertManagedRouteMutationBoundary(route.routeFile, "remove-finalize-previous", [route.previousRouteFile]);
    await rm(route.previousRouteFile, { force: true });
  }
}

async function restoreRemovedRouteLocked(lifecycle: HostedCapsuleLifecycle, route: HostedCapsuleRoute) {
  if (!route?.previousRouteFile) {
    return;
  }
  await assertManagedRouteMutationBoundary(route.routeFile, "restore-remove-current", [route.previousRouteFile]);
  await rm(route.routeFile, { force: true });
  await assertManagedRouteMutationBoundary(route.routeFile, "restore-publish-previous", [route.previousRouteFile]);
  await rename(route.previousRouteFile, route.routeFile);
  reloadCaddy(lifecycle);
}

async function assertManagedRouteMutationBoundary(routeFile: string, boundary: string, relatedFiles: string[] = []) {
  await assertActiveManagedRouteTrust(routeFile);
  for (const file of relatedFiles) await assertTrustedRegularFileIfExists(file);
  if (process.env.SPORADES_TEST_ROUTE_MUTATION_BOUNDARY === boundary) {
    const marker = process.env.SPORADES_TEST_ROUTE_MUTATION_MARKER;
    if (marker) await writeFile(marker, `${boundary}\n`, { flag: "wx", mode: 0o600 });
    await fakeManagedRouteLockPause("SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS");
  }
  await assertActiveManagedRouteTrust(routeFile);
  for (const file of relatedFiles) await assertTrustedRegularFileIfExists(file);
}

async function withManagedRouteLock(routeFile: string, fn: any) {
  const lockFile = `${routeFile}.lock`;
  if (process.env.SPORADES_HOST_ROUTE_LOCK_FILE !== lockFile || !(await processRetainsOsFlock(lockFile))) {
    throw helperError(
      "Hosted Capsule route lock identity was not retained by the action process.",
      "Upgrade the Host helper and retry the lifecycle command.",
    );
  }
  await assertActiveManagedRouteTrust(routeFile);
  await cleanupManagedRouteProtocolArtifacts(lockFile);
  if (process.env.SPORADES_TEST_FLOCK_PATH && process.env.SPORADES_TEST_ROUTE_LOCK_PROOF_MARKER) {
    await writeFile(process.env.SPORADES_TEST_ROUTE_LOCK_PROOF_MARKER, "route-lock-proof-retained\n", { mode: 0o600 });
  }
  await fakeManagedRouteLockPause("SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS");
  if (!(await processRetainsOsFlock(lockFile))) throw routeTrustError();
  await assertActiveManagedRouteTrust(routeFile);
  return fn();
}

async function processRetainsOsFlock(lockFile: string) {
  let expected;
  try {
    expected = await stat(lockFile);
  } catch {
    return false;
  }
  const descriptorNumbers = new Set<string>();
  const testDescriptor = process.env.SPORADES_TEST_FLOCK_PATH ? process.env.SPORADES_TEST_OS_LOCK_FD : undefined;
  if (testDescriptor && /^[0-9]+$/.test(testDescriptor)) descriptorNumbers.add(testDescriptor);
  for (const descriptorRoot of ["/proc/self/fd", "/dev/fd"]) {
    let entries;
    try {
      entries = await readdir(descriptorRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      descriptorNumbers.add(entry);
    }
  }
  for (const descriptor of descriptorNumbers) {
    for (const descriptorRoot of ["/proc/self/fd", "/dev/fd"]) {
      try {
        const descriptorStat = await stat(path.join(descriptorRoot, descriptor));
        if (!routeLockFileIdentityMatches(descriptorStat, expected)) continue;
        if (process.platform === "linux") {
          if (descriptorStat.dev !== expected.dev) continue;
          if (await linuxDescriptorOwnsFlock(descriptor, expected)) return true;
        } else if (process.env.SPORADES_TEST_FLOCK_PATH && testDescriptorOwnsFlock(lockFile)) {
          return true;
        }
      } catch {
        // File descriptors may close while they are inspected.
      }
    }
  }
  return false;
}

async function linuxDescriptorOwnsFlock(descriptor: string, expected: Awaited<ReturnType<typeof stat>>) {
  let fdinfo;
  try {
    fdinfo = await readFile(`/proc/self/fdinfo/${descriptor}`, "utf8");
  } catch {
    return false;
  }
  const device = linuxDeviceMajorMinor(expected.dev);
  const locks = [...fdinfo.matchAll(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+(?:READ|WRITE)\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/mg)];
  return locks.some((match) => Number(match[1]) === process.pid
    && Number.parseInt(match[2], 16) === device.major
    && Number.parseInt(match[3], 16) === device.minor
    && BigInt(match[4]) === BigInt(expected.ino));
}

function linuxDeviceMajorMinor(deviceNumber: number | bigint) {
  const device = BigInt(deviceNumber);
  return {
    major: Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)),
    minor: Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n)),
  };
}

function testDescriptorOwnsFlock(lockFile: string) {
  const flock = process.env.SPORADES_TEST_FLOCK_PATH;
  if (!flock) return false;
  const result = spawnSync(flock, [
    "--exclusive", "--timeout", "0", "--conflict-exit-code", "75", "--no-fork",
    lockFile, process.execPath, "-e", "",
  ], { encoding: "utf8", env: process.env });
  return result.status === 75;
}

function routeLockFileIdentityMatches(descriptor: Awaited<ReturnType<typeof stat>>, expected: Awaited<ReturnType<typeof stat>>) {
  // macOS fdesc reports a synthetic device for /dev/fd while preserving the underlying inode.
  return descriptor.ino === expected.ino
    && descriptor.uid === expected.uid
    && descriptor.gid === expected.gid
    && descriptor.mode === expected.mode;
}

function managedRouteLockTimeoutMs() {
  const raw = process.env.SPORADES_ROUTE_LOCK_TIMEOUT_MS;
  if (raw === undefined) {
    return 5000;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw helperError(
      "Invalid Hosted Capsule route lock timeout.",
      "Set SPORADES_ROUTE_LOCK_TIMEOUT_MS to a whole number from 1 through 60000.",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 60_000) {
    throw helperError(
      "Invalid Hosted Capsule route lock timeout.",
      "Set SPORADES_ROUTE_LOCK_TIMEOUT_MS to a whole number from 1 through 60000.",
    );
  }
  return value;
}

async function readManagedRouteProtocolOwner(protocolFile: string) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(protocolFile, "utf8"));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return { state: "absent", owner: null };
    }
    if (errorDetails(error).code === "EISDIR" || error instanceof SyntaxError) {
      return { state: "malformed", owner: null };
    }
    throw error;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !/^[a-f0-9]{32}$/.test(parsed.token) ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid < 1 ||
    (parsed.processIdentity !== null && typeof parsed.processIdentity !== "string") ||
    !Number.isSafeInteger(parsed.createdAt) ||
    parsed.createdAt < 0
  ) {
    return { state: "malformed", owner: null };
  }
  return { state: "owner", owner: parsed };
}

function managedRouteProtocolOwnerIsLive(owner: any) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorDetails(error).code === "EPERM";
  }
  if (owner.processIdentity === null) {
    return true;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(owner.pid)], { encoding: "utf8" });
  const currentIdentity = result.status === 0 ? result.stdout.trim() || null : null;
  return currentIdentity === null || currentIdentity === owner.processIdentity;
}

async function cleanupManagedRouteProtocolArtifacts(lockFile: string) {
  const directory = path.dirname(lockFile);
  const base = path.basename(lockFile);
  const artifact = new RegExp(`^${escapeRegExp(base)}\\.(?:claim|stale|reclaim)-[a-f0-9]{32}$`);
  const entries = (await readdir(directory)).filter((entry) => artifact.test(entry)).sort().slice(0, 100);
  for (const entry of entries) {
    const artifactPath = path.join(directory, entry);
    const owner = await readManagedRouteProtocolOwner(artifactPath);
    if (owner.state === "owner" && !managedRouteProtocolOwnerIsLive(owner.owner)) {
      await rm(artifactPath, { force: true });
    }
  }
}

async function fakeManagedRouteLockPause(name: string) {
  const raw = process.env[name];
  if (raw && /^[1-9][0-9]*$/.test(raw)) {
    await delay(Math.min(Number(raw), 60_000));
  }
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
  await assertActiveManagedRouteTrust(activeManagedRouteTrust?.routeFile ?? null);
  const dataHandle = await openCanonicalRuntimeDataDirectory(targetPath, true);
  try {
    await prepareWritableDataHandle(dataHandle, targetPath, true);
  } finally {
    await dataHandle.close();
  }
  await assertActiveManagedRouteTrust(activeManagedRouteTrust?.routeFile ?? null);
}

async function openCanonicalRuntimeDataDirectory(targetPath: string, createData: boolean) {
  const managedRoot = activeManagedRouteTrust?.managedRoot;
  if (!managedRoot || !path.isAbsolute(targetPath) || path.normalize(targetPath) !== targetPath) throw runtimeDataTrustError(targetPath);
  const relative = path.relative(managedRoot, targetPath);
  const components = relative.split(path.sep).filter(Boolean);
  if (relative.startsWith("..") || path.isAbsolute(relative)
    || components.length !== 5
    || components[0] !== "hosts" || components[2] !== "capsules" || components[4] !== "data"
    || !/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/.test(components[1])
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(components[3])) throw runtimeDataTrustError(targetPath);
  let handle = await open(
    managedRoot,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0),
  ).catch(() => { throw runtimeDataTrustError(targetPath); });
  let logical = managedRoot;
  try {
    for (let index = 0; index < components.length; index += 1) {
      logical = path.join(logical, components[index]);
      const descriptorPath = descriptorChildPath(handle.fd, components[index], logical);
      if (createData && index === components.length - 1) {
        await mkdir(descriptorPath, { mode: 0o700 }).catch((error) => {
          if (errorDetails(error).code !== "EEXIST") throw runtimeDataTrustError(logical);
        });
      }
      const child = await open(
        descriptorPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0),
      ).catch(() => { throw runtimeDataTrustError(logical); });
      const details = await child.stat();
      if (!details.isDirectory()) {
        await child.close();
        throw runtimeDataTrustError(logical);
      }
      await assertRuntimeDataPathIdentity(logical, { dev: details.dev, ino: details.ino }, true);
      await handle.close();
      handle = child;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function descriptorChildPath(parentFd: number, name: string, fallbackPath: string) {
  if (name.length === 0 || name === "." || name === ".." || name.includes(path.sep)) throw runtimeDataTrustError(fallbackPath);
  return process.platform === "linux" ? `/proc/self/fd/${parentFd}/${name}` : fallbackPath;
}

async function prepareWritableDataHandle(handle: any, targetPath: string, directory: boolean) {
  let details = await handle.stat();
  if ((directory && !details.isDirectory()) || (!directory && !details.isFile())) throw runtimeDataTrustError(targetPath);
  const identity = { dev: details.dev, ino: details.ino };
  await pauseRuntimeDataDescriptorMutation(targetPath);
  await prepareRuntimeDataOwnershipHandle(handle, targetPath, details);
  const wantedMode = directory ? 0o700 : 0o600;
  if ((Number(details.mode) & 0o777) !== wantedMode) await handle.chmod(wantedMode);
  details = await handle.stat();
  if (details.dev !== identity.dev || details.ino !== identity.ino) throw runtimeDataTrustError(targetPath);
  await assertRuntimeDataPathIdentity(targetPath, identity, directory);
  if (!directory) return;

  const descriptorDirectory = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : targetPath;
  const entries = await readdir(descriptorDirectory, { withFileTypes: true }).catch(() => { throw runtimeDataTrustError(targetPath); });
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes(path.sep)) throw runtimeDataTrustError(targetPath);
    const childPath = path.join(targetPath, entry.name);
    const descriptorPath = descriptorChildPath(handle.fd, entry.name, childPath);
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (entry.isDirectory() ? (fsConstants.O_DIRECTORY ?? 0) : 0);
    const child = await open(descriptorPath, flags).catch(() => { throw runtimeDataTrustError(childPath); });
    try {
      await prepareWritableDataHandle(child, childPath, entry.isDirectory());
    } finally {
      await child.close();
    }
  }
}

async function assertRuntimeDataPathIdentity(targetPath: string, identity: any, directory: boolean) {
  const details = await lstat(targetPath).catch(() => { throw runtimeDataTrustError(targetPath); });
  if (details.isSymbolicLink()
    || details.dev !== identity.dev || details.ino !== identity.ino
    || (directory ? !details.isDirectory() : !details.isFile())) throw runtimeDataTrustError(targetPath);
}

async function pauseRuntimeDataDescriptorMutation(targetPath: string) {
  if (process.env.SPORADES_TEST_RUNTIME_DATA_MUTATION_BOUNDARY !== "runtime-data-descriptor-mutate") return;
  const targetSuffix = process.env.SPORADES_TEST_RUNTIME_DATA_MUTATION_TARGET_SUFFIX;
  if (targetSuffix && !targetPath.endsWith(targetSuffix)) return;
  const marker = process.env.SPORADES_TEST_RUNTIME_DATA_MUTATION_MARKER;
  if (marker) await writeFile(marker, `${targetPath}\n`, { flag: "wx", mode: 0o600 });
  await fakeManagedRouteLockPause("SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS");
}

function runtimeDataTrustError(targetPath: string) {
  return helperError(
    "Hosted Capsule data path failed its no-follow trust check.",
    `Stop the Capsule, remove symbolic links or replaced entries beneath ${targetPath}, then retry the Host lifecycle command.`,
  );
}

async function prepareRuntimeDataOwnershipHandle(handle: any, targetPath: string, stats: any) {
  const uid = SPORADES_BASE_IMAGE.runtimeUid;
  const gid = SPORADES_BASE_IMAGE.runtimeGid;
  if (process.env.SPORADES_TEST_FORCE_RUNTIME_DATA_CHOWN_FAILURE === "1") {
    throw runtimeDataOwnershipError(targetPath, uid, gid);
  }
  if (stats.uid === uid && stats.gid === gid) {
    return;
  }
  try {
    await handle.chown(uid, gid);
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

function canonicalCapsuleHttpLogPath(request: HostHelperRequest, validatedRemoteRoot = validateCanonicalHostRouteRoot(request)) {
  canonicalManagedRouteFile(request, validatedRemoteRoot);
  const expectedDirectory = path.resolve(
    validatedRemoteRoot,
    "hosts",
    request.host.domain,
    "capsules",
    request.capsule.subname,
    "logs",
  );
  const expected = path.resolve(expectedDirectory, "http.log");
  if (path.dirname(expected) !== expectedDirectory) throw invalidCapsuleHttpLogPathError();
  const lifecycle = request.lifecycle as any;
  const supplied = [
    request.registration?.route?.log?.file,
    lifecycle?.accessLog,
    lifecycle?.routes?.accessLog,
    lifecycle?.routes?.running?.log?.file,
    lifecycle?.routes?.unavailable?.log?.file,
  ].filter((value) => value !== undefined);
  if (supplied.some((value) => typeof value !== "string" || value !== expected)) throw invalidCapsuleHttpLogPathError();
  return expected;
}

function capsuleHttpLogTrustManifest(request: HostHelperRequest, validatedRemoteRoot: string) {
  const logFile = canonicalCapsuleHttpLogPath(request, validatedRemoteRoot);
  return {
    directories: [{ path: path.dirname(logFile), caddyOwned: true }],
    finalFiles: [{ path: logFile, caddyOwned: true }],
  };
}

function invalidCapsuleHttpLogPathError() {
  return helperError(
    "Invalid Hosted Capsule HTTP log path.",
    "Use the canonical Capsule-scoped Host HTTP log path and retry the lifecycle command.",
  );
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
