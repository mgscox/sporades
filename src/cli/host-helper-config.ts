import { readFile } from "node:fs/promises";
import path from "node:path";

import { SPORADES_BASE_IMAGE } from "../base-image.js";
import { errorDetails, helperError, type LooseRecord } from "./cli-support.js";
import type { HostHelperRequest } from "./host-helper-contract.js";

const HOST_HELPER_CONFIG_FILE = "sporades-host-helper.json";
const DEFAULT_HOSTED_CAPSULE_DOCKER_IMAGE = SPORADES_BASE_IMAGE.image;
const DEFAULT_HOSTED_CAPSULE_DOCKER_NETWORK = "sporades-hosted-capsules";
const DEFAULT_HOSTED_CAPSULE_GRACE_CHECK_MS = 500;
const DEFAULT_HOST_LOG_LINES = 200;
const DEFAULT_MAX_HOST_LOG_LINES = 10000;

export type HostHelperConfig = {
  hostedCapsule: {
    dockerImage: string;
    dockerNetwork: string;
    graceCheckMs: number;
  };
  logs: {
    defaultLines: number;
    maxLines: number;
  };
};

export function defaultHostHelperConfig(): HostHelperConfig {
  return {
    hostedCapsule: {
      dockerImage: DEFAULT_HOSTED_CAPSULE_DOCKER_IMAGE,
      dockerNetwork: DEFAULT_HOSTED_CAPSULE_DOCKER_NETWORK,
      graceCheckMs: DEFAULT_HOSTED_CAPSULE_GRACE_CHECK_MS,
    },
    logs: {
      defaultLines: DEFAULT_HOST_LOG_LINES,
      maxLines: DEFAULT_MAX_HOST_LOG_LINES,
    },
  };
}

export async function loadHostHelperConfig(request: HostHelperRequest): Promise<HostHelperConfig> {
  const loaded = defaultHostHelperConfig();
  const configPath = hostHelperConfigPath(request);
  if (!configPath) {
    return loaded;
  }

  let contents;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (errorDetails(error).code === "ENOENT" && !process.env.SPORADES_HOST_HELPER_CONFIG) {
      return loaded;
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

  return applyHostHelperConfig(loaded, config, configPath);
}

function hostHelperConfigPath(request: HostHelperRequest) {
  if (process.env.SPORADES_HOST_HELPER_CONFIG) {
    return process.env.SPORADES_HOST_HELPER_CONFIG;
  }
  if (typeof request.host?.remoteRoot !== "string" || request.host.remoteRoot.length === 0) {
    return null;
  }
  return path.join(request.host.remoteRoot, HOST_HELPER_CONFIG_FILE);
}

function applyHostHelperConfig(loaded: HostHelperConfig, config: unknown, configPath: string) {
  assertPlainObject(config, "Host helper config", configPath);
  assertKnownKeys(config, ["hostedCapsule", "logs"], "Host helper config", configPath);

  const hostedCapsule = config.hostedCapsule ?? {};
  assertPlainObject(hostedCapsule, "Host helper hostedCapsule config", configPath);
  assertKnownKeys(hostedCapsule, ["dockerImage", "dockerNetwork", "graceCheckMs"], "Host helper hostedCapsule config", configPath);

  const logs = config.logs ?? {};
  assertPlainObject(logs, "Host helper logs config", configPath);
  assertKnownKeys(logs, ["defaultLines", "maxLines"], "Host helper logs config", configPath);

  if (Object.hasOwn(hostedCapsule, "dockerImage")) {
    loaded.hostedCapsule.dockerImage = readConfigString(hostedCapsule.dockerImage, "hostedCapsule.dockerImage", configPath);
  }
  if (Object.hasOwn(hostedCapsule, "dockerNetwork")) {
    loaded.hostedCapsule.dockerNetwork = readConfigString(hostedCapsule.dockerNetwork, "hostedCapsule.dockerNetwork", configPath);
  }
  if (Object.hasOwn(hostedCapsule, "graceCheckMs")) {
    loaded.hostedCapsule.graceCheckMs = readConfigPositiveInteger(hostedCapsule.graceCheckMs, "hostedCapsule.graceCheckMs", configPath);
  }
  if (Object.hasOwn(logs, "defaultLines")) {
    loaded.logs.defaultLines = readConfigPositiveInteger(logs.defaultLines, "logs.defaultLines", configPath);
  }
  if (Object.hasOwn(logs, "maxLines")) {
    loaded.logs.maxLines = readConfigPositiveInteger(logs.maxLines, "logs.maxLines", configPath);
  }
  if (loaded.logs.defaultLines > loaded.logs.maxLines) {
    throw helperError(
      "Host helper config is invalid.",
      `Set logs.defaultLines less than or equal to logs.maxLines in ${configPath}.`,
    );
  }
  return loaded;
}

function assertPlainObject(value: unknown, label: string, configPath: string): asserts value is LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw helperError(
      "Host helper config is invalid.",
      `${label} must be a JSON object in ${configPath}.`,
    );
  }
}

function assertKnownKeys(value: LooseRecord, knownKeys: readonly string[], label: string, configPath: string) {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      throw helperError(
        "Host helper config is invalid.",
        `${label} contains unsupported key "${key}" in ${configPath}.`,
      );
    }
  }
}

function readConfigString(value: unknown, key: string, configPath: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw helperError(
      "Host helper config is invalid.",
      `Set ${key} to a non-empty string in ${configPath}.`,
    );
  }
  return value;
}

function readConfigPositiveInteger(value: unknown, key: string, configPath: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw helperError(
      "Host helper config is invalid.",
      `Set ${key} to a positive whole number in ${configPath}.`,
    );
  }
  return value;
}
