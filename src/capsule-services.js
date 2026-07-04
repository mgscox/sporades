import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SERVICE_KEYS = new Set(["database"]);
const SUPPORTED_DATABASE_ENGINES = new Set(["libsql"]);
const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";

export const CAPSULE_SERVICES_COMPOSE_FILE = path.join(".sporades", "compose", "capsule-services.compose.yml");

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
        "The first supported Capsule service declaration is `services.database`.",
      );
    }
  }

  if (services.database !== undefined) {
    validateDatabaseServiceConfig(services.database);
  }

  return services;
}

export async function writeCapsuleServicesCompose(projectDir, config) {
  const composePath = path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE);
  if (!config.services?.database) {
    await rm(composePath, { force: true });
    return null;
  }

  validateCapsuleServicesConfig(config.services);
  await mkdir(path.dirname(composePath), { recursive: true });
  const model = capsuleServicesComposeModel(config);
  const source = renderCapsuleServicesCompose(model);
  await writeFile(composePath, source);
  return {
    path: composePath,
    relativePath: CAPSULE_SERVICES_COMPOSE_FILE,
    ...model,
  };
}

export function capsuleServicesComposeModel(config) {
  const projectSlug = slugify(config.name ?? "capsule");
  const serviceName = `sporades-${projectSlug}-database`;
  const networkName = `sporades-${projectSlug}-services`;
  const volumeName = `sporades-${projectSlug}-database-data`;

  return {
    projectSlug,
    composeProjectName: `sporades-${projectSlug}-services`,
    services: {
      database: {
        name: serviceName,
        image: LIBSQL_IMAGE,
        volume: volumeName,
      },
    },
    networks: {
      services: networkName,
    },
    volumes: {
      databaseData: volumeName,
    },
    labels: {
      "com.sporades.managed": "true",
      "com.sporades.runtime-state": "true",
      "com.sporades.project": projectSlug,
      "com.sporades.capsule-service.kind": "database",
      "com.sporades.capsule-service.engine": "libsql",
    },
  };
}

function validateDatabaseServiceConfig(database) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw commandError(
      "Invalid database Capsule service declaration.",
      "Set `services.database` to `{ \"kind\": \"database\", \"engine\": \"libsql\" }`.",
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
      "Use `services.database.engine` of `libsql`.",
    );
  }
}

function renderCapsuleServicesCompose(model) {
  return `# Sporades-owned runtime state. Do not edit by hand.
# Generated from sporades.json Capsule service declarations.
name: ${model.composeProjectName}

services:
  ${model.services.database.name}:
    image: ${model.services.database.image}
    container_name: ${model.services.database.name}
    labels:
${renderLabels(model.labels, 6)}
    networks:
      - ${model.networks.services}
    volumes:
      - ${model.volumes.databaseData}:/var/lib/sqld:rw

networks:
  ${model.networks.services}:
    name: ${model.networks.services}
    labels:
${renderLabels(model.labels, 6)}

volumes:
  ${model.volumes.databaseData}:
    name: ${model.volumes.databaseData}
    labels:
${renderLabels(model.labels, 6)}
`;
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

function commandError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}
