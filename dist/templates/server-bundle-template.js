import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../server-runtime-source.js";
import { PUBLIC_TREE_LIMITS, normalizePublicTreePath, publicTreePathFromRequest } from "../public-tree-contract.js";
export function createServerBundleSource({ config, serverEnv, sealedServerEnv = { enabled: false }, serverSource, serverModuleSource }) {
    const runtimeFunctions = SERVER_RUNTIME_SOURCE_FUNCTIONS
        .map((fn) => fn.toString())
        .join("\n\n");
    const publicTreeContract = [
        `const PUBLIC_TREE_LIMITS = ${JSON.stringify(PUBLIC_TREE_LIMITS)};`,
        normalizePublicTreePath.toString(),
        publicTreePathFromRequest.toString(),
    ].join("\n\n");
    const serverModuleDataUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}`;
    return `// Sporades server bundle
import { createDecipheriv, createHash, createHash as createHash2, createHmac, privateDecrypt, randomBytes, randomBytes as randomBytes2, randomUUID, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readFileSync as readFileSync2 } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const sporadesConfig = ${JSON.stringify(config, null, 2)};
export const sporadesServerEnv = ${JSON.stringify(serverEnv, null, 2)};
export const sporadesSealedServerEnv = ${JSON.stringify(sealedServerEnv, null, 2)};
export const sporadesServerSource = ${JSON.stringify(serverSource)};
const sporadesActionIndex = process.argv.indexOf("--sporades-action");
const sporadesAction = sporadesActionIndex < 0 ? null : process.argv[sporadesActionIndex + 1];
const sporadesCapsuleModule = sporadesAction ? null : await import(${JSON.stringify(serverModuleDataUrl)});
const sporadesCapsuleDefinition = sporadesCapsuleModule?.default ?? null;
const PRIVILEGED_AUTH_USER_ID = "__privileged__";
const EMAIL_SIGN_IN_FAILURE_LIMIT = 5;
const EMAIL_SIGN_IN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES = 256;
const PRIVILEGED_AUDIT_SCHEMA = "sporades.privileged-audit.v1";
const PRIVILEGED_AUDIT_ACTOR_KINDS = new Set(["privileged-server-role", "captured-user", "platform", "unknown"]);
const PRIVILEGED_AUDIT_OUTCOMES = new Set(["started", "completed", "errored", "finished"]);
const ACL_HELPER_STATE = Symbol("sporades.aclHelperState");
${runtimeFunctions}
${publicTreeContract}

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const runtimeConfig = {
  ...sporadesConfig,
  __sporadesSession: process.env.SPORADES_SECURITY_SESSION ?? sporadesConfig.__sporadesSession,
  __sporadesPublicOrigin: process.env.SPORADES_PUBLIC_ORIGIN ?? sporadesConfig.__sporadesPublicOrigin,
};
const runtimeServerEnv = await readRuntimeServerEnv(sporadesServerEnv, sporadesSealedServerEnv);
const runtimeServiceEnv = readRuntimeServiceEnv();
if (sporadesAction) {
  if (!['jobs.inspect', 'schedules.inspect'].includes(sporadesAction)) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\\n");
    process.exit(1);
  }
  const adapter = await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
  try {
    const items = adapter ? await (sporadesAction === 'jobs.inspect' ? inspectRuntimeJobs(adapter) : inspectRuntimeSchedules(adapter)) : [];
    const key = sporadesAction === 'jobs.inspect' ? 'jobs' : 'schedules';
    process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, [key]: items }, error: null }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { code: error.code ?? (sporadesAction === 'jobs.inspect' ? "JOB_INSPECTION_FAILED" : "SCHEDULE_INSPECTION_FAILED"), message: error.message, hint: error.hint, ...(error.jobId ? { jobId: error.jobId, field: error.field } : {}), ...(error.scheduleName ? { scheduleName: error.scheduleName, field: error.field } : {}) } }) + "\\n");
    process.exitCode = 1;
  } finally { await adapter?.close(); }
  process.exit();
}
const database = await openDevDatabase(databasePath, sporadesServerSource, runtimeServerEnv, runtimeConfig, sporadesCapsuleDefinition, {
  serviceEnv: runtimeServiceEnv,
});
await database.init();
database.log.emit({
  category: "platform",
  event: "runtime.started",
  level: "info",
  message: "Capsule runtime started",
  data: { diagnostics: database.runtimeDiagnostics },
  release: process.env.SPORADES_RELEASE_ID ? { id: process.env.SPORADES_RELEASE_ID } : null,
});
const websocketHub = createWebSocketHub(() => database);
const runtimePublicRoot = resolveRuntimePublicRoot();

const server = createServer(async (request, response) => {
  try {
    if (prepareHttpSecurity(database, request, response)) {
      return;
    }

    if (await routeRuntimeHealth(database, request, response)) {
      return;
    }

    if (await routeSporadesAuth(database, request, response)) {
      return;
    }

    if (await handleFileHttpRoute(database, request, response, websocketHub)) {
      return;
    }

    if (await routeEndpoint(database, request, response)) {
      return;
    }

    if (await routePublicAsset(request, response, runtimePublicRoot, websocketHub)) {
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    writeUnhandledHttpError(database, request, response, error);
  }
});

server.on("upgrade", (request, socket) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (requestUrl.pathname !== "/__sporades/ws") {
    socket.destroy();
    return;
  }
  websocketHub.accept(request, socket);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  websocketHub.disconnectAll();
  await database.shutdown();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function resolveRuntimePublicRoot() {
  const mounted = path.join(process.cwd(), "public");
  if (process.cwd() === "/app") return mounted;
  return resolveActiveRuntimePublicRoot() ?? mounted;
}

function resolveActiveRuntimePublicRoot() {
  try {
    const treesDir = path.join(process.cwd(), ".sporades", "build", ".public-trees");
    const treesStats = lstatSync(treesDir);
    const referencePath = path.join(treesDir, "active.json");
    const referenceStats = lstatSync(referencePath);
    const tree = JSON.parse(readFileSync(path.join(treesDir, "active.json"), "utf8"))?.tree;
    if (!/^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(tree)) return null;
    const candidate = path.join(treesDir, tree);
    const candidateStats = lstatSync(candidate);
    const indexStats = lstatSync(path.join(candidate, "index.html"));
    if (
      treesStats.isDirectory() && !treesStats.isSymbolicLink()
      && referenceStats.isFile() && !referenceStats.isSymbolicLink()
      && candidateStats.isDirectory() && !candidateStats.isSymbolicLink()
      && indexStats.isFile() && !indexStats.isSymbolicLink()
    ) return candidate;
  } catch {}
  return null;
}

async function routePublicAsset(request, response, publicRoot, hub) {
  const rawPathname = String(request.url ?? "/").split("?", 1)[0];
  const relativePath = publicTreePathFromRequest(rawPathname);
  if (relativePath === null) return false;
  const filePath = path.join(publicRoot, ...relativePath.split("/"));
  const stats = await lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  const body = await readFile(filePath);
  const html = relativePath === "index.html";
  response.writeHead(200, { "content-type": publicContentType(relativePath) });
  response.end(html ? injectPageConnectionToken(body.toString("utf8"), hub.createConnectionToken()) : body);
  return true;
}

function publicContentType(relativePath) {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRuntimeServerEnv(fallbackEnv, sealed) {
  let env;
  if (!sealed?.enabled) {
    env = fallbackEnv;
  } else {
    const envelopePath = process.env.SPORADES_SEALED_SERVER_ENV_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.sealed.json");
    const privateKeyPath = process.env.SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.private.pem");
    const [envelopeRaw, privateKey] = await Promise.all([readFile(envelopePath, "utf8"), readFile(privateKeyPath, "utf8")]);
    env = unsealRuntimeServerEnv(JSON.parse(envelopeRaw), privateKey);
  }
  return env;
}

function readRuntimeServiceEnv() {
  const keys = [
    "SPORADES_SERVICE_DATABASE_ENGINE",
    "SPORADES_SERVICE_DATABASE_URL",
    "SPORADES_SERVICE_DATABASE_AUTH_TOKEN",
    "SPORADES_SERVICE_STORAGE_ENGINE",
    "SPORADES_SERVICE_STORAGE_ENDPOINT",
    "SPORADES_SERVICE_STORAGE_ACCESS_KEY",
    "SPORADES_SERVICE_STORAGE_SECRET_KEY",
    "SPORADES_SERVICE_STORAGE_BUCKET",
    "SPORADES_SERVICE_STORAGE_REGION",
    "SPORADES_SERVICE_STORAGE_NAMESPACE",
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function unsealRuntimeServerEnv(envelope, privateKey) {
  const values = {};
  for (const [key, entry] of Object.entries(envelope.entries ?? {})) {
    const dataKey = privateDecrypt(privateKey, Buffer.from(entry.encryptedKey, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    values[key] = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
  return values;
}
`;
}
//# sourceMappingURL=server-bundle-template.js.map