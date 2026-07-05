import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type JsonRecord = Record<string, unknown>;
type HelperError = Error & { hint?: string };
export type DatabaseEngine = "libsql" | "postgres";
export type StorageEngine = "minio";
export type CapsuleServiceKind = "database" | "storage";
export type CapsuleServiceCredentials = {
  databaseUser: string;
  databasePassword: string;
  storageAccessKey: string;
  storageSecretKey: string;
};
export type CapsuleServiceOptions = {
  credentials?: Partial<CapsuleServiceCredentials>;
  publishPorts?: boolean;
};
export type DatabaseServiceDeclaration = {
  kind: "database";
  engine: DatabaseEngine;
};
export type StorageServiceDeclaration = {
  kind: "storage";
  engine: StorageEngine;
};
export type CapsuleServicesDeclaration = JsonRecord & {
  database?: DatabaseServiceDeclaration;
  storage?: StorageServiceDeclaration;
};
export type CapsuleProjectConfig = JsonRecord & {
  name?: unknown;
  services?: CapsuleServicesDeclaration;
};
export type CapsuleServiceBase = {
  kind: CapsuleServiceKind;
  name: string;
  engine: string;
  image: string;
  stateDir: string;
  targetPort: number;
  volumeTarget: string;
  environment: Record<string, string>;
  healthcheck: string[];
  command: string | null;
  labels: Record<string, string>;
};
export type CapsuleDatabaseService = CapsuleServiceBase & {
  kind: "database";
  engine: DatabaseEngine;
  user: string;
  password: string;
  databaseName: string;
};
export type CapsuleStorageService = CapsuleServiceBase & {
  kind: "storage";
  engine: StorageEngine;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  namespace: string;
};
export type CapsuleService = CapsuleDatabaseService | CapsuleStorageService;
export type CapsuleServices = {
  database?: CapsuleDatabaseService;
  storage?: CapsuleStorageService;
};
export type CapsuleServicesComposeModel = {
  projectSlug: string;
  composeProjectName: string;
  publishPorts: boolean;
  credentials: CapsuleServiceCredentials;
  services: CapsuleServices;
  networks: { services: string };
  labels: Record<string, string>;
};
export type DatabaseEngineModel = {
  engine: DatabaseEngine;
  image: string;
  targetPort: number;
  volumeTarget: string;
  environment: Record<string, string>;
  healthcheck: string[];
};
export type WrittenCapsuleServicesCompose = CapsuleServicesComposeModel & {
  path: string;
  relativePath: string;
};

const SUPPORTED_SERVICE_KEYS = new Set(["database", "storage"]);
const SUPPORTED_DATABASE_ENGINES = new Set(["libsql", "postgres"]);
const SUPPORTED_STORAGE_ENGINES = new Set(["minio"]);
const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_USER = "sporades";
const POSTGRES_DATABASE = "sporades";
const MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z";
const MINIO_ROOT_USER = "sporades";
const MINIO_BUCKET = "sporades-files";
const MINIO_REGION = "us-east-1";

export const CAPSULE_SERVICES_COMPOSE_FILE = path.join(".sporades", "compose", "capsule-services.compose.yml");
export const CAPSULE_SERVICES_STATE_DIR = path.join(".sporades", "services");
export const CAPSULE_SERVICES_CREDENTIALS_FILE = path.join(".sporades", "services", "credentials.json");

export function validateCapsuleServicesConfig(services: unknown): CapsuleServicesDeclaration | null {
  if (services === undefined) {
    return null;
  }
  if (!isRecord(services)) {
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

export async function writeCapsuleServicesCompose(
  projectDir: string,
  config: CapsuleProjectConfig,
  options: CapsuleServiceOptions = {},
): Promise<WrittenCapsuleServicesCompose | null> {
  const composePath = path.join(projectDir, CAPSULE_SERVICES_COMPOSE_FILE);
  if (!hasDeclaredCapsuleServices(config)) {
    await rm(composePath, { force: true });
    return null;
  }

  validateCapsuleServicesConfig(config.services);
  await mkdir(path.dirname(composePath), { recursive: true });
  const credentials = await loadOrCreateCapsuleServiceCredentials(projectDir);
  const model = capsuleServicesComposeModel(config, projectDir, {
    credentials,
    publishPorts: options.publishPorts === true,
  });
  await Promise.all(Object.values(model.services).map((service) => mkdir(service.stateDir, { recursive: true })));
  const source = renderCapsuleServicesCompose(model);
  await writeFile(composePath, source);
  return {
    path: composePath,
    relativePath: CAPSULE_SERVICES_COMPOSE_FILE,
    ...model,
  };
}

async function loadOrCreateCapsuleServiceCredentials(projectDir: string): Promise<CapsuleServiceCredentials> {
  const credentialsPath = path.join(projectDir, CAPSULE_SERVICES_CREDENTIALS_FILE);
  let existing: JsonRecord = {};
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, "utf8"));
    if (isRecord(parsed)) {
      existing = parsed;
    }
  } catch {
    // Missing or unreadable credentials are regenerated below.
  }
  const credentials = {
    databaseUser: typeof existing.databaseUser === "string" && existing.databaseUser ? existing.databaseUser : POSTGRES_USER,
    databasePassword:
      typeof existing.databasePassword === "string" && existing.databasePassword
        ? existing.databasePassword
        : randomBytes(24).toString("base64url"),
    storageAccessKey:
      typeof existing.storageAccessKey === "string" && existing.storageAccessKey ? existing.storageAccessKey : MINIO_ROOT_USER,
    storageSecretKey:
      typeof existing.storageSecretKey === "string" && existing.storageSecretKey
        ? existing.storageSecretKey
        : randomBytes(24).toString("base64url"),
  };
  if (
    credentials.databaseUser !== existing.databaseUser ||
    credentials.databasePassword !== existing.databasePassword ||
    credentials.storageAccessKey !== existing.storageAccessKey ||
    credentials.storageSecretKey !== existing.storageSecretKey
  ) {
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  }
  return credentials;
}

export function capsuleServicesComposeModel(
  config: CapsuleProjectConfig,
  projectDir = process.cwd(),
  options: CapsuleServiceOptions = {},
): CapsuleServicesComposeModel {
  const credentials = options.credentials ?? {};
  const databaseUser = credentials.databaseUser ?? POSTGRES_USER;
  const databasePassword = credentials.databasePassword ?? "";
  const storageAccessKey = credentials.storageAccessKey ?? MINIO_ROOT_USER;
  const storageSecretKey = credentials.storageSecretKey ?? "";
  const projectSlug = slugify(config.name ?? "capsule");
  const networkName = `sporades-${projectSlug}-services`;
  const services: CapsuleServices = {};
  const database = config.services?.database;
  const storage = config.services?.storage;
  const labels = {
    "com.sporades.managed": "true",
    "com.sporades.runtime-state": "true",
    "com.sporades.project": projectSlug,
  };

  if (database) {
    const engine = database.engine ?? "libsql";
    const engineModel: DatabaseEngineModel =
      engine === "postgres"
        ? {
            engine,
            image: POSTGRES_IMAGE,
            targetPort: 5432,
            volumeTarget: "/var/lib/postgresql/data",
            environment: {
              POSTGRES_USER: databaseUser,
              POSTGRES_PASSWORD: databasePassword,
              POSTGRES_DB: POSTGRES_DATABASE,
            },
            healthcheck: ["CMD", "pg_isready", "-U", databaseUser, "-d", POSTGRES_DATABASE],
          }
        : {
            engine: "libsql",
            image: LIBSQL_IMAGE,
            targetPort: 8080,
            volumeTarget: "/var/lib/sqld",
            environment: {},
            healthcheck: ["CMD", "/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
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
      healthcheck: engineModel.healthcheck,
      command: null,
      labels: serviceLabels(labels, "database", engineModel.engine),
      user: databaseUser,
      password: databasePassword,
      databaseName: POSTGRES_DATABASE,
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
        MINIO_ROOT_USER: storageAccessKey,
        MINIO_ROOT_PASSWORD: storageSecretKey,
      },
      healthcheck: ["CMD", "curl", "-fsS", "http://127.0.0.1:9000/minio/health/ready"],
      command: 'server /data --console-address ":9001"',
      labels: serviceLabels(labels, "storage", "minio"),
      accessKey: storageAccessKey,
      secretKey: storageSecretKey,
      bucket: MINIO_BUCKET,
      region: MINIO_REGION,
      namespace: projectSlug,
    };
  }

  const model = {
    projectSlug,
    composeProjectName: `sporades-${projectSlug}-services`,
    publishPorts: options.publishPorts === true,
    credentials: {
      databaseUser,
      databasePassword,
      storageAccessKey,
      storageSecretKey,
    },
    services,
    networks: {
      services: networkName,
    },
    labels,
  };
  return model;
}

function validateDatabaseServiceConfig(database: unknown): asserts database is DatabaseServiceDeclaration {
  if (!isRecord(database)) {
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
  if (typeof database.engine !== "string" || !SUPPORTED_DATABASE_ENGINES.has(database.engine)) {
    throw commandError(
      `Unsupported database Capsule service engine: ${database.engine ?? "missing"}`,
      "Use `services.database.engine` of `libsql` or `postgres`.",
    );
  }
}

function validateStorageServiceConfig(storage: unknown): asserts storage is StorageServiceDeclaration {
  if (!isRecord(storage)) {
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
  if (typeof storage.engine !== "string" || !SUPPORTED_STORAGE_ENGINES.has(storage.engine)) {
    throw commandError(
      `Unsupported storage Capsule service engine: ${storage.engine ?? "missing"}`,
      "Use `services.storage.engine` of `minio`.",
    );
  }
}

function renderCapsuleServicesCompose(model: CapsuleServicesComposeModel): string {
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

function renderServiceCompose(service: CapsuleService, model: CapsuleServicesComposeModel): string {
  // Ports are published (loopback-only) solely for local dev sessions, where the
  // Capsule runs as a host process. Container sessions reach services by name on
  // the project network; publishing a port would also open it to containers on
  // other Docker networks.
  const ports = model.publishPorts
    ? `    ports:
      - "127.0.0.1::${service.targetPort}"
`
    : "";
  return `  ${service.name}:
    image: ${service.image}
    container_name: ${service.name}
    labels:
${renderLabels(service.labels, 6)}
${renderEnvironment(service.environment, 4)}${renderCommand(service.command, 4)}${renderHealthcheck(service.healthcheck, 4)}
    networks:
      - ${model.networks.services}
${ports}    volumes:
      - ${JSON.stringify(`${service.stateDir}:${service.volumeTarget}:rw`)}
`;
}

function renderHealthcheck(healthcheck: string[] | null, indent: number): string {
  if (!healthcheck) {
    return "";
  }
  const padding = " ".repeat(indent);
  return `${padding}healthcheck:
${padding}  test: ${JSON.stringify(healthcheck)}
${padding}  interval: 5s
${padding}  timeout: 3s
${padding}  retries: 3
${padding}  start_period: 60s
${padding}  start_interval: 1s
`;
}

function renderCommand(command: string | null, indent: number): string {
  if (!command) {
    return "";
  }
  const padding = " ".repeat(indent);
  return `${padding}command: ${JSON.stringify(command)}\n`;
}

function renderEnvironment(environment: Record<string, string>, indent: number): string {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) {
    return "";
  }
  const padding = " ".repeat(indent);
  return `${padding}environment:\n${entries.map(([key, value]) => `${padding}  ${key}: ${JSON.stringify(value)}`).join("\n")}\n`;
}

function renderLabels(labels: Record<string, string>, indent: number): string {
  const padding = " ".repeat(indent);
  return Object.entries(labels)
    .map(([key, value]) => `${padding}${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

function slugify(value: unknown): string {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "capsule";
}

function hasDeclaredCapsuleServices(config: CapsuleProjectConfig): boolean {
  return Boolean(config.services?.database || config.services?.storage);
}

function serviceLabels(labels: Record<string, string>, kind: CapsuleServiceKind, engine: string): Record<string, string> {
  return {
    ...labels,
    "com.sporades.capsule-service.kind": kind,
    "com.sporades.capsule-service.engine": engine,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function commandError(message: string, hint: string): HelperError {
  const error: HelperError = new Error(message);
  error.hint = hint;
  return error;
}
