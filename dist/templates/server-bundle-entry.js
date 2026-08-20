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
import { createDecipheriv, privateDecrypt } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRuntimeInspectionAdapter, createWebSocketHub, handleFileHttpRoute, injectPageConnectionToken, inspectRuntimeJobs, inspectRuntimeSchedules, openDevDatabase, prepareHttpSecurity, runRuntimeAccessKeyOperatorAction, routeEndpoint, routeRuntimeHealth, routeSporadesAuth, shutdownAndCloseDatabase, shutdownHttpServerAndRuntime, writeUnhandledHttpError, } from "../server-runtime-source.js";
import { publicTreePathFromRequest } from "../public-tree-contract.js";
import { publicAccessKeyManagementError } from "../access-keys-runtime.js";
import { sporadesCapsuleModuleUrl, sporadesConfig, sporadesSealedServerEnv, sporadesServerEnv, sporadesServerSource, } from "sporades:server-bundle-inputs";
// The emitted-list bundle exposes these four as module exports. Kept so the two artifacts present
// the same module interface, not because a deployed Capsule imports itself: `server.mjs` is
// executed by the container's `CMD`, never imported.
export { sporadesConfig, sporadesServerEnv, sporadesSealedServerEnv, sporadesServerSource };
const sporadesActionIndex = process.argv.indexOf("--sporades-action");
const sporadesAction = sporadesActionIndex < 0 ? null : process.argv[sporadesActionIndex + 1];
const sporadesActionInputIndex = process.argv.indexOf("--sporades-action-input");
let sporadesActionInput = {};
if (sporadesActionInputIndex >= 0) {
    try {
        sporadesActionInput = JSON.parse(Buffer.from(process.argv[sporadesActionInputIndex + 1] ?? "", "base64url").toString("utf8"));
    }
    catch {
        sporadesActionInput = null;
    }
}
// Loaded through a variable rather than a literal so esbuild leaves the import for the runtime to
// perform. Resolving it at build time would both inline the Capsule into the graph and evaluate it
// on the one-shot action path, which ADR-0028 requires stay unevaluated.
const sporadesCapsuleModule = sporadesAction ? null : await import(sporadesCapsuleModuleUrl);
const sporadesCapsuleDefinition = sporadesCapsuleModule?.default ?? null;
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
    const accessKeyActions = ["access-keys.list", "access-keys.inspect", "access-keys.revoke", "access-keys.revoke-all", "access-keys.delete"];
    if (!["jobs.inspect", "schedules.inspect", ...accessKeyActions].includes(sporadesAction)) {
        process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\n");
        process.exit(1);
    }
    if (accessKeyActions.includes(sporadesAction) && (!sporadesActionInput || typeof sporadesActionInput !== "object" || Array.isArray(sporadesActionInput))) {
        process.stdout.write(JSON.stringify({ ok: false, data: null, error: { code: "INVALID_ACCESS_KEY_ACTION_INPUT", message: "Invalid Access-key operator action input.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\n");
        process.exit(1);
    }
    const adapter = accessKeyActions.includes(sporadesAction) ? null : await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
    let actionDatabase = null;
    try {
        if (accessKeyActions.includes(sporadesAction)) {
            actionDatabase = await openDevDatabase(databasePath, "", runtimeServerEnv, runtimeConfig, {
                accessKeys: { scopes: sporadesConfig.accessKeys?.scopes ?? [] },
            }, { serviceEnv: runtimeServiceEnv, runtimeActionOnly: true });
            const result = await runRuntimeAccessKeyOperatorAction(actionDatabase, sporadesAction, sporadesActionInput, sporadesActionInput.executionSource ?? "runtime-action");
            process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, ...result }, error: null }) + "\n");
        }
        else {
            const items = adapter ? await (sporadesAction === "jobs.inspect" ? inspectRuntimeJobs(adapter) : inspectRuntimeSchedules(adapter)) : [];
            const key = sporadesAction === "jobs.inspect" ? "jobs" : "schedules";
            process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, [key]: items }, error: null }) + "\n");
        }
    }
    catch (error) {
        const fallbackCode = sporadesAction === "jobs.inspect" ? "JOB_INSPECTION_FAILED" : sporadesAction === "schedules.inspect" ? "SCHEDULE_INSPECTION_FAILED" : "ACCESS_KEY_ACTION_FAILED";
        const accessKeyError = accessKeyActions.includes(sporadesAction) ? publicAccessKeyManagementError(error) : null;
        const publicError = accessKeyActions.includes(sporadesAction)
            ? accessKeyError ?? { code: fallbackCode, message: "Access-key operator action failed.", hint: "Check the Privileged audit events and retry the operation." }
            : { code: error.code ?? fallbackCode, message: error.message, hint: error.hint, ...(error.jobId ? { jobId: error.jobId, field: error.field } : {}), ...(error.scheduleName ? { scheduleName: error.scheduleName, field: error.field } : {}) };
        process.stdout.write(JSON.stringify({ ok: false, data: null, error: publicError }) + "\n");
        process.exitCode = 1;
    }
    finally {
        if (actionDatabase)
            await shutdownAndCloseDatabase(actionDatabase).catch(() => { });
        await adapter?.close();
    }
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
    }
    catch (error) {
        writeUnhandledHttpError(database, request, response, error);
    }
});
server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/__sporades/ws") {
        socket.destroy();
        return;
    }
    websocketHub.accept(request, socket);
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
});
let shutdownStarted = false;
const shutdown = async () => {
    if (shutdownStarted)
        return;
    shutdownStarted = true;
    websocketHub.disconnectAll();
    let shutdownError;
    try {
        await shutdownHttpServerAndRuntime(server, () => shutdownAndCloseDatabase(database));
    }
    catch (error) {
        shutdownError = error;
    }
    if (shutdownError)
        process.stderr.write(`${shutdownError instanceof Error ? shutdownError.stack ?? shutdownError.message : String(shutdownError)}\n`);
    process.exit(shutdownError ? 1 : 0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
function resolveRuntimePublicRoot() {
    const mounted = path.join(process.cwd(), "public");
    if (process.cwd() === "/app")
        return mounted;
    return resolveActiveRuntimePublicRoot() ?? mounted;
}
function resolveActiveRuntimePublicRoot() {
    try {
        const treesDir = path.join(process.cwd(), ".sporades", "build", ".public-trees");
        const treesStats = lstatSync(treesDir);
        const referencePath = path.join(treesDir, "active.json");
        const referenceStats = lstatSync(referencePath);
        const tree = JSON.parse(readFileSync(path.join(treesDir, "active.json"), "utf8"))?.tree;
        if (!/^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(tree))
            return null;
        const candidate = path.join(treesDir, tree);
        const candidateStats = lstatSync(candidate);
        const indexStats = lstatSync(path.join(candidate, "index.html"));
        if (treesStats.isDirectory() && !treesStats.isSymbolicLink()
            && referenceStats.isFile() && !referenceStats.isSymbolicLink()
            && candidateStats.isDirectory() && !candidateStats.isSymbolicLink()
            && indexStats.isFile() && !indexStats.isSymbolicLink())
            return candidate;
    }
    catch { }
    return null;
}
async function routePublicAsset(request, response, publicRoot, hub) {
    const rawPathname = String(request.url ?? "/").split("?", 1)[0];
    const relativePath = publicTreePathFromRequest(rawPathname);
    if (relativePath === null)
        return false;
    const filePath = path.join(publicRoot, ...relativePath.split("/"));
    const stats = await lstat(filePath).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink())
        return false;
    const body = await readFile(filePath);
    const html = relativePath === "index.html";
    response.writeHead(200, { "content-type": publicContentType(relativePath) });
    response.end(html ? injectPageConnectionToken(body.toString("utf8"), hub.createConnectionToken()) : body);
    return true;
}
function publicContentType(relativePath) {
    switch (path.extname(relativePath).toLowerCase()) {
        case ".html": return "text/html; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".json":
        case ".map": return "application/json; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
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
    }
    else {
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
//# sourceMappingURL=server-bundle-entry.js.map