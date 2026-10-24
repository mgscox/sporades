import { routeCollection } from "../observability-runtime.js";
import { routeMcp } from "../mcp-runtime.js";
import { openAdmissionPolicy, resolveAdmissionPolicy, type AdmissionHealth, type AdmissionReloadEvent } from "../admission-policy.js";
import { preservedDeployFilePath } from "../deploy-files.js";
// The generated Capsule server bundle: the boot program a deployed Capsule runs, written as
// ordinary imports so that esbuild resolves every name.
//
// `server-bundle-template.ts` built the same program until ticket 05, by writing out `fn.toString()`
// for every entry in a registry of 528 runtime functions, next to a hand-assembled preamble that
// re-declared the runtime's module constants. That mechanism decided the runtime's shape rather than
// serving it: a function could not call a helper unless the helper was also registered, could not
// close over a module constant, and a name that failed to travel was a `ReferenceError` in a
// deployed Capsule rather than a build error. This file was the expand half of an expand–contract
// sequence; the contract half deleted the other builder, and this is the only one now.
//
// Only the entry points the boot program actually calls are imported, so esbuild's reachability
// analysis decides what a Capsule carries. That was worth stating while a registry existed —
// importing it would have pinned all 528 functions into the graph — and it is still the rule: an
// import added here for convenience carries its whole subgraph into every deployed Capsule.
import { createDecipheriv, createHash, privateDecrypt } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
  createRuntimeInspectionAdapter,
  createWebSocketHub,
  dumpDatabase,
  handleFileHttpRoute,
  renderPageHtml,
  isDocumentNavigationRequest,
  inspectRuntimeJobs,
  inspectRuntimeSchedules,
  interpretHttpRequestTarget,
  listDatabaseTables,
  openDevDatabase,
  prepareHttpSecurity,
  runRuntimeAccessKeyOperatorAction,
  routeConnectionToken,
  routeEndpoint,
  routeHttpAdmission,
  routeWebSocketAdmission,
  routeRuntimeHealth,
  routeSporadesAuth,
  runReadOnlyQuery,
  shutdownAndCloseDatabase,
  shutdownHttpServerAndRuntime,
  writeUnhandledHttpError,
  writeInvalidHttpRequestTarget,
} from "../server-runtime-source.js";
import { publicTreePathFromRequest } from "../public-tree-contract.js";
import { publicAccessKeyManagementError } from "../access-keys-runtime.js";
import { ACCESS_KEY_OPERATOR_ACTIONS, validateAccessKeyOperatorActionInput } from "../cli/access-key-operator-envelope.js";
import { DATABASE_INSPECTION_ACTIONS } from "../cli/database-inspection-envelope.js";
import { createStripeCallbackEndpoint } from "../stripe-webhook-runtime.js";
import { createStripeTeamBillingProvider } from "../stripe-team-billing-provider.js";
import { createHttpRequestTelemetry } from "../runtime-telemetry.js";
import {
  sporadesCapsuleModuleUrl,
  sporadesConfig,
  sporadesSealedServerEnv,
  sporadesServerEnv,
  sporadesServerSource,
} from "sporades:server-bundle-inputs";

// The emitted-list bundle exposes these four as module exports. Kept so the two artifacts present
// the same module interface, not because a deployed Capsule imports itself: `server.mjs` is
// executed by the container's `CMD`, never imported.
export { sporadesConfig, sporadesServerEnv, sporadesSealedServerEnv, sporadesServerSource };

const sporadesActionIndex = process.argv.indexOf("--sporades-action");
const sporadesAction = sporadesActionIndex < 0 ? null : process.argv[sporadesActionIndex + 1];
const sporadesActionInputIndex = process.argv.indexOf("--sporades-action-input");
let sporadesActionInput: any = {};
if (sporadesActionInputIndex >= 0) {
  try {
    const encoded = process.argv[sporadesActionInputIndex + 1] ?? "";
    if (Buffer.byteLength(encoded, "utf8") > 24 * 1024) throw new Error("oversized");
    sporadesActionInput = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  }
  catch { sporadesActionInput = null; }
}
// Loaded through a variable rather than a literal so esbuild leaves the import for the runtime to
// perform. Resolving it at build time would both inline the Capsule into the graph and evaluate it
// on the one-shot action path, which ADR-0028 requires stay unevaluated.
const admissionLaunchPath = process.env.SPORADES_ADMISSION_POLICY_PATH;
const admissionPath = sporadesAction ? null : admissionLaunchPath !== undefined
  ? (admissionLaunchPath ? resolveAdmissionPolicy({ path: admissionLaunchPath }) : null)
  : resolveAdmissionPolicy(sporadesConfig.admissionPolicy, sporadesConfig.deploy?.files);
const admissionDeployed = ["container", "hosted"].includes(process.env.SPORADES_SECURITY_SESSION ?? sporadesConfig.__sporadesSession);
let admissionLog: ((health: AdmissionHealth, event: AdmissionReloadEvent) => void) | undefined;
const admissionPolicyRuntime = admissionPath ? await openAdmissionPolicy(
  admissionDeployed ? "/run/sporades-admission" : process.cwd(),
  admissionDeployed ? path.basename(preservedDeployFilePath("/run/sporades-admission", admissionPath)) : admissionPath,
  (health, event) => {
    if (admissionLog) admissionLog(health, event);
    else if (event === "failure" || event === "recovery") process.stderr.write(JSON.stringify({ event: `admission.policy.${event}`, data: health }) + "\n");
  },
) : null;
const sporadesCapsuleModule = sporadesAction ? null : await import(sporadesCapsuleModuleUrl);
const sporadesCapsuleDefinition = sporadesCapsuleModule?.default ?? null;

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const launchSession = process.env.SPORADES_SECURITY_SESSION ?? sporadesConfig.__sporadesSession;
const containerPublicOrigin = launchSession === "container" ? process.env.SPORADES_CONTAINER_PUBLIC_ORIGIN : undefined;
const launchPublicOrigin = launchSession === "hosted" ? process.env.SPORADES_PUBLIC_ORIGIN
  : containerPublicOrigin ?? sporadesConfig.deploy?.publicOrigin ?? process.env.SPORADES_PUBLIC_ORIGIN ?? sporadesConfig.__sporadesPublicOrigin;
const runtimeConfig = {
  ...sporadesConfig,
  __sporadesSession: launchSession,
  // Keep a deployed Container's origin stable when Dev rebuilds the shared Bundle.
  ...(containerPublicOrigin !== undefined ? { deploy: { ...sporadesConfig.deploy, publicOrigin: containerPublicOrigin } } : {}),
  // Local Containers keep their selection in Docker's immutable launch environment. Dev may
  // rebuild the shared server.mjs while a stopped Container is waiting to restart.
  __sporadesTelemetry: process.env.SPORADES_SECURITY_SESSION === "hosted"
    && process.env.SPORADES_HOSTED_TELEMETRY_CONFIG !== undefined
    ? JSON.parse(process.env.SPORADES_HOSTED_TELEMETRY_CONFIG)
    : process.env.SPORADES_SECURITY_SESSION === "container"
    && process.env.SPORADES_CONTAINER_TELEMETRY_CONFIG !== undefined
    ? JSON.parse(process.env.SPORADES_CONTAINER_TELEMETRY_CONFIG)
    : sporadesConfig.__sporadesTelemetry,
  __sporadesPublicOrigin: launchPublicOrigin,
  __sporadesPublicAliases: JSON.parse(process.env.SPORADES_PUBLIC_ALIASES ?? "[]"),
};
const runtimeServerEnv = await readRuntimeServerEnv(sporadesServerEnv, sporadesSealedServerEnv);
const runtimeServiceEnv = readRuntimeServiceEnv();
if (sporadesAction) {
  // The action protocol owns stdout as one JSON envelope. Container runtimes normally mirror
  // structured logs to stdout, but action-owned audits still persist to the JSONL/index sinks and
  // must not corrupt the CLI/Host-helper response frame.
  process.env.SPORADES_LOG_STDOUT = "0";
  const accessKeyActions: readonly string[] = ACCESS_KEY_OPERATOR_ACTIONS;
  const databaseActions: readonly string[] = DATABASE_INSPECTION_ACTIONS;
  if (!["jobs.inspect", "schedules.inspect", ...accessKeyActions, ...databaseActions].includes(sporadesAction)) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\n");
    process.exit(1);
  }
  if (databaseActions.includes(sporadesAction)) {
    const envelope = await runDatabaseInspectionAction(sporadesAction, sporadesActionInput);
    // A large dump can outlast a synchronous write on a pipe; exit only once stdout has it.
    await new Promise((resolve) => process.stdout.write(JSON.stringify(envelope) + "\n", resolve));
    process.exit(envelope.ok ? 0 : 1);
  }
  if (accessKeyActions.includes(sporadesAction)) {
    sporadesActionInput = validateAccessKeyOperatorActionInput(sporadesAction, sporadesActionInput, () => {
      process.stdout.write(JSON.stringify({ ok: false, data: null, error: { code: "INVALID_ACCESS_KEY_ACTION_INPUT", message: "Invalid Access-key operator action input.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\n");
      process.exit(1);
      throw new Error("unreachable");
    });
  }
  const adapter = accessKeyActions.includes(sporadesAction) ? null : await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
  let actionDatabase: any = null;
  try {
    if (accessKeyActions.includes(sporadesAction)) {
      actionDatabase = await openDevDatabase(databasePath, "", runtimeServerEnv, runtimeConfig, {
        accessKeys: { scopes: sporadesConfig.accessKeys?.scopes ?? [] },
      }, { serviceEnv: runtimeServiceEnv, runtimeActionOnly: true });
      const session = runtimeConfig.__sporadesSession;
      const executionSource = session === "hosted" ? "operator-cli-hosted" : session === "container" ? "operator-cli-container" : session === "dev" || session === "public-dev" ? "operator-cli-dev" : "runtime-action";
      const result = await runRuntimeAccessKeyOperatorAction(actionDatabase, sporadesAction, sporadesActionInput, executionSource);
      process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, ...result }, error: null }) + "\n");
    } else {
      const items = adapter ? await (sporadesAction === "jobs.inspect" ? inspectRuntimeJobs(adapter) : inspectRuntimeSchedules(adapter)) : [];
      const key = sporadesAction === "jobs.inspect" ? "jobs" : "schedules";
      process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, [key]: items }, error: null }) + "\n");
    }
  } catch (error: any) {
    const fallbackCode = sporadesAction === "jobs.inspect" ? "JOB_INSPECTION_FAILED" : sporadesAction === "schedules.inspect" ? "SCHEDULE_INSPECTION_FAILED" : "ACCESS_KEY_ACTION_FAILED";
    const accessKeyError = accessKeyActions.includes(sporadesAction) ? publicAccessKeyManagementError(error) : null;
    const publicError = accessKeyActions.includes(sporadesAction)
      ? accessKeyError ?? { code: fallbackCode, message: "Access-key operator action failed.", hint: "Check the Privileged audit events and retry the operation." }
      : { code: error.code ?? fallbackCode, message: error.message, hint: error.hint, ...(error.jobId ? { jobId: error.jobId, field: error.field } : {}), ...(error.scheduleName ? { scheduleName: error.scheduleName, field: error.field } : {}) };
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: publicError }) + "\n");
    process.exitCode = 1;
  } finally {
    if (actionDatabase) await shutdownAndCloseDatabase(actionDatabase).catch(() => {});
    await adapter?.close();
  }
  process.exit();
}
let jobTelemetryLifecycle: ReturnType<typeof createHttpRequestTelemetry> | undefined;
let database: any;
try {
  database = await openDevDatabase(databasePath, sporadesServerSource, runtimeServerEnv, runtimeConfig, sporadesCapsuleDefinition, {
    serviceEnv: runtimeServiceEnv,
    createStripeCallbackEndpoint,
    createStripeTeamBillingProvider,
    // Bind after storage/definitions are ready, before the existing recovery scan.
    onJobQueueReady(queueDatabase: any) {
      jobTelemetryLifecycle = createHttpRequestTelemetry(runtimeConfig.__sporadesTelemetry, (diagnostic) => queueDatabase.log.emit({
        category: "platform",
        event: diagnostic.event,
        level: diagnostic.event === "telemetry.export.failed" ? "warn" : "info",
        message: diagnostic.event === "telemetry.export.failed" ? "Telemetry export failed" : "Telemetry export recovered",
        data: diagnostic.event === "telemetry.export.failed" ? { reason: diagnostic.reason } : null,
      }));
      jobTelemetryLifecycle.bindJobQueue(queueDatabase);
    },
  });
  database.runtimeProbeToken = process.env.SPORADES_RUNTIME_PROBE_TOKEN ?? null;
  await database.init();
} catch (error) {
  await jobTelemetryLifecycle?.shutdown();
  throw error;
}
const telemetry = jobTelemetryLifecycle!;
if (admissionPolicyRuntime) {
  database.admissionPolicy = admissionPolicyRuntime;
  admissionLog = (health, event) => database.log.emit({ category: "platform", event: `admission.policy.${event}`, level: event === "failure" ? "warn" : "info", message: "Admission policy reload health changed", data: health });
  admissionLog(admissionPolicyRuntime.health(), "loaded");
}
database.log.emit({
  category: "platform",
  event: "runtime.started",
  level: "info",
  message: "Capsule runtime started",
  data: { diagnostics: database.runtimeDiagnostics },
  release: process.env.SPORADES_RELEASE_ID ? { id: process.env.SPORADES_RELEASE_ID } : null,
});
const runtimePublicRoot = resolveRuntimePublicRoot();
const websocketHub = createWebSocketHub(() => database, null, { telemetry: runtimeConfig.__sporadesTelemetry ? telemetry.websocket : undefined });
database.runtimeTelemetry = {
  supported: true,
  enabled: runtimeConfig.__sporadesTelemetry !== null && runtimeConfig.__sporadesTelemetry !== undefined,
  serviceName: runtimeConfig.__sporadesTelemetry?.serviceName ?? null,
  configHash: createHash("sha256").update(JSON.stringify(runtimeConfig.__sporadesTelemetry ?? null)).digest("hex"),
};

const server = createServer(async (request, response) => telemetry.run(request, response, database.endpoints, async () => {
  try {
    if (prepareHttpSecurity(database, request, response, () => routeHttpAdmission(database, request, response))) {
      return;
    }
    if (!interpretHttpRequestTarget(request.url ?? "/", request.method)) {
      if (routeHttpAdmission(database, request, response)) return;
      writeInvalidHttpRequestTarget(database, request, response);
      return;
    }

    if (routeConnectionToken(request, response, (currentToken) => websocketHub.createConnectionToken(currentToken))) {
      return;
    }

    if (await routeRuntimeHealth(database, request as any, response)) {
      return;
    }

    if (routeHttpAdmission(database, request, response)) {
      return;
    }

    if (await routeMcp(database, request, response)) return;

    if (await routeCollection(database, request, response)) return;

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
}));

server.on("upgrade", (request, socket) => {
  if (routeWebSocketAdmission(database, request, socket)) return;
  const target = interpretHttpRequestTarget(request.url ?? "/", request.method);
  if (!target) {
    socket.destroy();
    return;
  }
  if (target.pathname !== "/__sporades/ws") {
    socket.destroy();
    return;
  }
  websocketHub.accept(request, socket);
});

server.on("connect", (_request, socket) => {
  socket.destroy();
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", () => resolve());
});

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await admissionPolicyRuntime?.close();
  websocketHub.disconnectAll();
  let shutdownError: unknown;
  try { await shutdownHttpServerAndRuntime(server, async () => {
    try { await shutdownAndCloseDatabase(database); }
    finally { await telemetry.shutdown(); }
  }); }
  catch (error) { shutdownError = error; }
  if (shutdownError) process.stderr.write(`${shutdownError instanceof Error ? shutdownError.stack ?? shutdownError.message : String(shutdownError)}\n`);
  process.exit(shutdownError ? 1 : 0);
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

async function routePublicAsset(request: IncomingMessage, response: ServerResponse, publicRoot: string, hub: any) {
  const requestTarget = interpretHttpRequestTarget(request.url ?? "/", request.method);
  if (!requestTarget) return false;
  const relativePath = publicTreePathFromRequest(requestTarget.pathname);
  if (relativePath === null) return false;
  const filePath = path.join(publicRoot, ...relativePath.split("/"));
  const stats = await lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  const body = await readFile(filePath);
  const htmlAsset = path.extname(relativePath).toLowerCase() === ".html";
  // The Vite pipeline emits assets/[name]-[hash][extname] with an eight-character
  // URL-safe hash. Directory membership alone does not make a file immutable.
  const immutable = relativePath.startsWith("assets/")
    && /-[A-Za-z0-9_-]{8}\.[^.\/]+(?:\.map)?$/.test(path.basename(relativePath))
    && !htmlAsset;
  response.writeHead(200, {
    "content-type": publicContentType(relativePath),
    ...(htmlAsset ? { "cache-control": "no-store", pragma: "no-cache" }
      : { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" }),
  });
  response.end(htmlAsset
    ? renderPageHtml(body, response, isDocumentNavigationRequest(request) ? hub.createConnectionToken() : undefined, database)
    : body);
  return true;
}

function publicContentType(relativePath: string) {
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
    case ".xml": return "application/xml; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRuntimeServerEnv(fallbackEnv: any, sealed: any) {
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
    "SPORADES_CONTAINER_SERVICES",
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

function unsealRuntimeServerEnv(envelope: any, privateKey: string) {
  const values: Record<string, string> = {};
  for (const [key, entry] of Object.entries<any>(envelope.entries ?? {})) {
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

// `sporades host db` (#285). The Dev debug routes' own functions answer, so a Hosted Capsule gives
// the same JSON and `db.query` keeps the same read-only gate. The connection is read-only and
// query-only, and it is opened by this one-shot process as the container's runtime user: the live
// Capsule keeps running, and no WAL or shared-memory file changes owner.
async function runDatabaseInspectionAction(action: string, input: any) {
  const invalidInput = action === "db.query"
    ? !input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "sql" || typeof input.sql !== "string"
    : !input || typeof input !== "object" || Object.keys(input).length > 0;
  if (invalidInput) {
    return { ok: false, data: null, error: { message: "Invalid database inspection input.", hint: "Upgrade the Sporades CLI and generated Bundle together." } };
  }
  let adapter: any = null;
  try {
    adapter = await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
    if (!adapter) {
      return { ok: false, data: null, error: { message: "The Capsule database does not exist yet.", hint: "Start the Capsule so it creates its database, then retry the command." } };
    }
    if (adapter.engine === "sqlite") {
      await adapter.exec("PRAGMA busy_timeout = 1000");
      await adapter.exec("PRAGMA query_only = ON");
    }
    const database = { adapter, sqlite: adapter };
    if (action === "db.list") return { ok: true, data: { tables: await listDatabaseTables(database) }, error: null };
    if (action === "db.dump") return { ok: true, data: { tables: await dumpDatabase(database) }, error: null };
    return await runReadOnlyQuery(database, input.sql);
  } catch {
    return { ok: false, data: null, error: { message: "Capsule database inspection failed.", hint: "Retry the command. If it keeps failing, check the Capsule logs." } };
  } finally {
    // The answer is already decided; a failed close must not replace it with an empty frame.
    try { await adapter?.close(); } catch { /* the reported result stands */ }
  }
}
