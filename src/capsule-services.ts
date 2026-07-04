// @ts-nocheck
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SERVICE_KEYS = new Set(["database", "storage"]);
const SUPPORTED_DATABASE_ENGINES = new Set(["libsql", "postgres"]);
const SUPPORTED_STORAGE_ENGINES = new Set(["minio"]);
const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_USER = "sporades";
const POSTGRES_PASSWORD = "sporades";
const POSTGRES_DATABASE = "sporades";
const MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z";
const MINIO_ROOT_USER = "sporades";
const MINIO_ROOT_PASSWORD = "sporades-minio-local-secret";
const MINIO_BUCKET = "sporades-files";
const MINIO_REGION = "us-east-1";

export const CAPSULE_SERVICES_COMPOSE_FILE = path.join(".sporades", "compose", "capsule-services.compose.yml");
export const CAPSULE_SERVICES_STATE_DIR = path.join(".sporades", "services");

export function validateCapsuleServicesConfig(services) {
  if (services === undefined) {
    return null;
  }
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw commandError("Invalid Capsule services declaration.", "Set `services` in sporades.json to an object.");
  }

  for (const key of Object.keys(services)) {
    if (!SUPPORTED_SERVICE_KEYS.has(key)) {
      throw commandError(
        `Unsupported Capsule service: ${key}`,
        "Use supported Capsule service declarations: `services.database` or `services.storage`.",
      );
    }
  }

  if (services.database !== undefined) {
    validateDatabaseServiceConfig(services.database);
  }
  if (services.storage !== undefined) {
    validateStorageServiceConfig(services.storage);
  }

  return services;
}

export async function writeCapsuleServicesCompose(projectDir, config) {
  const composePath = path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE);
  if (!hasDeclaredCapsuleServices(config)) {
    await rm(composePath, { force: true });
    return null;
  }

  validateCapsuleServicesConfig(config.services);
  await mkdir(path.dirname(composePath), { recursive: true });
  const model = capsuleServicesComposeModel(config, projectDir);
  await Promise.all(Object.values(model.services).map((service) => mkdir(service.stateDir, { recursive: true })));
  const source = renderCapsuleServicesCompose(model);
  await writeFile(composePath, source);
  return {
    path: composePath,
    relativePath: CAPSULE_SERVICES_COMPOSE_FILE,
    ...model,
  };
}

export function capsuleServicesComposeModel(config, projectDir = process.cwd()) {
  const projectSlug = slugify(config.name ?? "capsule");
  const networkName = `sporades-${projectSlug}-services`;
  const services = {};
  const database = config.services?.database;
  const storage = config.services?.storage;

  if (database) {
    const engine = database.engine ?? "libsql";
    const engineModel =
      engine === "postgres"
        ? {
            engine,
            image: POSTGRES_IMAGE,
            targetPort: 5432,
            volumeTarget: "/var/lib/postgresql/data",
            environment: {
              POSTGRES_USER,
              POSTGRES_PASSWORD,
              POSTGRES_DB: POSTGRES_DATABASE,
              POSTGRES_HOST_AUTH_METHOD: "trust",
            },
          }
        : {
            engine: "libsql",
            image: LIBSQL_IMAGE,
            targetPort: 8080,
            volumeTarget: "/var/lib/sqld",
            environment: {},
          };
    services.database = {
      kind: "database",
      name: `sporades-${projectSlug}-database`,
      engine: engineModel.engine,
      image: engineModel.image,
      stateDir: path.join(projectDir, CAPSULE_SERVICES_STATE_DIR, "database"),
      targetPort: engineModel.targetPort,
      volumeTarget: engineModel.volumeTarget,
      environment: engineModel.environment,
      command: null,
    };
  }

  if (storage) {
    services.storage = {
      kind: "storage",
      name: `sporades-${projectSlug}-storage`,
      engine: "minio",
      image: MINIO_IMAGE,
      stateDir: path.join(projectDir, CAPSULE_SERVICES_STATE_DIR, "storage"),
      targetPort: 9000,
      volumeTarget: "/data",
      environment: {
        MINIO_ROOT_USER,
        MINIO_ROOT_PASSWORD,
      },
      command: 'server /data --console-address ":9001"',
      accessKey: MINIO_ROOT_USER,
      secretKey: MINIO_ROOT_PASSWORD,
      bucket: MINIO_BUCKET,
      region: MINIO_REGION,
    };
  }

  const model = {
    projectSlug,
    composeProjectName: `sporades-${projectSlug}-services`,
    services,
    networks: {
      services: networkName,
    },
    labels: {
      "com.sporades.managed": "true",
      "com.sporades.runtime-state": "true",
      "com.sporades.project": projectSlug,
    },
  };
  for (const service of Object.values(model.services)) {
    service.labels = {
      ...model.labels,
      "com.sporades.capsule-service.kind": service.kind,
      "com.sporades.capsule-service.engine": service.engine,
    };
  }
  return model;
}

function validateDatabaseServiceConfig(database) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw commandError(
      "Invalid database Capsule service declaration.",
      "Set `services.database` to `{ \"kind\": \"database\", \"engine\": \"libsql\" }` or `{ \"kind\": \"database\", \"engine\": \"postgres\" }`.",
    );
  }
  if (database.kind !== "database") {
    throw commandError(
      "Unsupported database Capsule service kind.",
      "Use `services.database.kind` of `database`.",
    );
  }
  if (!SUPPORTED_DATABASE_ENGINES.has(database.engine)) {
    throw commandError(
      `Unsupported database Capsule service engine: ${database.engine ?? "missing"}`,
      "Use `services.database.engine` of `libsql` or `postgres`.",
    );
  }
}

function validateStorageServiceConfig(storage) {
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    throw commandError(
      "Invalid storage Capsule service declaration.",
      "Set `services.storage` to `{ \"kind\": \"storage\", \"engine\": \"minio\" }`.",
    );
  }
  if (storage.kind !== "storage") {
    throw commandError(
      "Unsupported storage Capsule service kind.",
      "Use `services.storage.kind` of `storage`.",
    );
  }
  if (!SUPPORTED_STORAGE_ENGINES.has(storage.engine)) {
    throw commandError(
      `Unsupported storage Capsule service engine: ${storage.engine ?? "missing"}`,
      "Use `services.storage.engine` of `minio`.",
    );
  }
}

function renderCapsuleServicesCompose(model) {
  const services = Object.values(model.services)
    .map((service) => renderServiceCompose(service, model))
    .join("\n");

  return `# Sporades-owned runtime state. Do not edit by hand.
# Generated from sporades.json Capsule service declarations.
name: ${model.composeProjectName}

services:
${services}

networks:
  ${model.networks.services}:
    name: ${model.networks.services}
    labels:
${renderLabels(model.labels, 6)}
`;
}

function renderServiceCompose(service, model) {
  return `  ${service.name}:
    image: ${service.image}
    container_name: ${service.name}
    labels:
${renderLabels(service.labels, 6)}
${renderEnvironment(service.environment, 4)}${renderCommand(service.command, 4)}
    networks:
      - ${model.networks.services}
    ports:
      - "127.0.0.1::${service.targetPort}"
    volumes:
      - ${JSON.stringify(`${service.stateDir}:${service.volumeTarget}:rw`)}
`;
}

function renderCommand(command, indent) {
  if (!command) {
    return "";
  }
  const padding = " ".repeat(indent);
  return `${padding}command: ${JSON.stringify(command)}\n`;
}

function renderEnvironment(environment, indent) {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) {
    return "";
  }
  const padding = " ".repeat(indent);
  return `${padding}environment:\n${entries.map(([key, value]) => `${padding}  ${key}: ${JSON.stringify(value)}`).join("\n")}\n`;
}

function renderLabels(labels, indent) {
  const padding = " ".repeat(indent);
  return Object.entries(labels)
    .map(([key, value]) => `${padding}${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "capsule";
}

function hasDeclaredCapsuleServices(config) {
  return Boolean(config.services?.database || config.services?.storage);
}

function commandError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}
