// The Capsule runtime's HTTP and security policy domain: the CORS and CSP posture every response
// carries, the origin and host-header validation behind it, the request body reader and its size
// limit, the generic response writers, and the two routes the runtime owns outright — the health
// probe and the File route. Batch 8 of the migration ADR-0041 records. Every body here is
// byte-identical to the one that stood in `server-runtime-source.ts`.
//
// **The domain is 32 declarations and two type aliases, established by closing the reference graph
// rather than by matching names.** Ticket 04 estimated ~17 from a name sweep — the smallest
// remaining estimate — and the real set is close to twice that. The error is in shape rather than
// in size, and in one direction only for once: nothing a name sweep collects here belongs to
// another domain, but ten declarations of this domain answer to no HTTP-shaped name.
//
// Three of those ten are the reason the estimate was low rather than merely imprecise.
// `writeEndpointResult`, `writeEndpointError` and `endpointResponseError` are named for the
// endpoint layer and are pure HTTP response plumbing: between them they set a status code, choose a
// content type, serialize an error envelope and refuse a malformed handler response, and they
// reference nothing outside this file but `isPayloadTooLargeError`, which is also this domain's. A
// name sweep for `*Http*`, `cors` or `csp` takes none of them. A *content* sweep — which top-level
// declarations touch `writeHead`, `response.end`, a `content-type` literal or an HTTP status — takes
// all three and finds nothing else this domain does not already have, which is what settled the
// boundary. Leaving them would have stranded `routeSporadesAuth` a second time, for the same reason
// batch 6's two file routes were stranded here: the writer, not the route, is the blocker.
//
// **The reverse-graph pass flagged twelve seeds with no in-domain caller and rejected none of
// them.** Batch 6 established that pass and batch 7 sharpened it — it flags entry points and
// foreigners alike, and only reading the body separates them. Every one of the twelve here is an
// entry point: `prepareHttpSecurity`, `readJsonRequest`, `writeUnhandledHttpError`,
// `injectPageConnectionToken`, `routeRuntimeHealth` and `handleFileHttpRoute` are called by the two
// servers (`src/cli/sporades.ts` and the generated bundle's boot program); `websocketOriginAllowed`
// and `resolveOAuthRequestOrigin` by `createWebSocketHub`; `writeEndpointResult` by `routeEndpoint`;
// and the four OAuth entry points below travel on to `auth-runtime.ts`. That the pass rejected
// nothing is not evidence it was unnecessary: it is the pass that proved `checkRuntimeSqlite` is
// this domain's rather than the adapters', because its one caller is `createRuntimeHealthResult`
// and nothing else in the repository reaches it except a test.
//
// **What could not leave, and what holds it.** One function of this domain is still in the
// monolith: `routeEndpoint`. It reaches `runEndpoint`, and `runEndpoint` reaches
// `createMutationContext`, `createContextHolder` and `createEndpointDatabaseApi` by three
// independent two- and three-step paths — the composition core that ticket 04 names as what
// `server-runtime-source.ts` retains. That is batch 4's case rather than batch 5's: the chain closes
// at ticket 05 and at no batch on the list, so batch 9 should not expect to clear it. The three
// writers it calls moved anyway and it imports them back, which is the same trade batch 6 made in
// the other direction when it left `handleFileHttpRoute` behind.
//
// **The five OAuth functions batch 3 left behind are freed by this move, and four of them are not
// here.** ADR-0041 records six auth functions blocked by the HTTP layer. All six leave the monolith
// in this batch, which makes this batch 5's case rather than batch 4's — a named blocker that did
// clear. Five go to `auth-runtime.ts` as riders, where the rest of their domain already is:
// `routeSporadesAuth`, `beginOAuthSignIn`, `readOAuthCallbackParameters`,
// `oauthFormContentTypeValid` and `resolvePasswordResetConfig`. They import four names from this
// module and nothing else of it.
//
// The sixth, `resolveOAuthRequestOrigin`, is here rather than there, and the reason is content
// rather than convenience. Its body resolves and validates a request origin against the CORS
// policy's `publicOrigin`, the `Host` header and the two `X-Forwarded-*` headers; it references
// `normalizeOrigin`, `singleHttpHeader` and `validatedRequestHost` and not one auth name. The
// "OAuth" in its name records its first caller, not its subject, and its second caller is
// `createWebSocketHub`, which is not an auth path at all. Batch 6's rule applies to a function's
// own body as well as to its neighbours: layout is not membership, and neither is a name.
//
// **This module and `auth-runtime.ts` import each other, and that is a real domain edge rather than
// an accident of the split.** `handleFileHttpRoute` serves the private File route, which means it
// authenticates: it reads the session token header and calls `resolveAnonymousSession` before it
// will hand back a row. Auth in turn needs this module's four HTTP primitives. The cycle is safe
// for the reason ES module cycles usually are not a problem and is worth stating rather than
// leaving to be rediscovered: every binding across it is a hoisted `function` declaration, and
// every use is inside a body that runs on a request rather than at module initialization, so
// neither module reads a name of the other's before both are initialized. esbuild resolves the
// cycle when it bundles the migrated set into the carried IIFE and again when it builds `bin/`.
//
// **What is exported and what is not.** 17 of the 32 are exported and 15 are private, against 7
// exported and all 32 registered before the move. Under the emitted list every one of the 32 had to be
// an entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a `ReferenceError` in a deployed Capsule,
// so "private" was not available to this domain. It is now: the whole CSP construction
// (`defaultRuntimeCspDirectives`, `serializeCspDirectives`), the origin and header predicates
// (`requestOriginAllowed`, `isSameOriginRequest`, `validatedRequestHost`, `isLocalDevOrigin`,
// `appendVaryHeader`, `sanitizeResponseHeaders`), the payload-limit error pair, the health-result
// builder and the three low-level response writers are named in no list at all.
// `serializeCspDirectives` is this module's census sentinel in
// `test/database-adapter-engine-seam.test.js` for that reason — it is private, and no honest edit
// removes it while `prepareHttpSecurity` still sets a CSP header.
//
// The exports are not a designed interface. They are the names something outside this file still
// resolves, in three groups:
//
//   - What the two servers call: `prepareHttpSecurity`, `readJsonRequest`, `writeUnhandledHttpError`,
//     `injectPageConnectionToken`, `routeRuntimeHealth` and `handleFileHttpRoute`.
//   - What the monolith calls: `emitHttpFailureLog`, `writeEndpointError` and `writeEndpointResult`
//     (`routeEndpoint`), `readLimitedRequestBody` (`readEndpointBody`), `resolveHttpMaxBodyBytes`
//     and `resolveRuntimeSecurityPolicy` (`openDevDatabase`), and `resolveRuntimeSecurityPolicy`,
//     `websocketOriginAllowed` and `resolveOAuthRequestOrigin` (`createWebSocketHub`).
//   - What `auth-runtime.ts` imports: `normalizeOrigin`, `readLimitedRequestBody`,
//     `singleHttpHeader` and `writeEndpointError`.
//
// `checkRuntimeSqlite` is exported for a test rather than for a caller, as it was before the move.
//
// This module reaches no Node builtin, so ADR-0042's `process.getBuiltinModule` accessor does not
// appear in it. `Buffer` and `URL` are globals.
import { resolveAnonymousSession } from "./auth-runtime.js";
import { checkRuntimeFileStorage, completePendingFileUpload, contentTypeForFile, fileRowForActor, } from "./file-storage-runtime.js";
const CLIENT_REQUEST_ERROR_CODES = new Set([
    "INVALID_JSON_REQUEST",
    "OAUTH_INVALID_CALLBACK",
    "OAUTH_INVALID_STATE",
    "OAUTH_PROVIDER_MISMATCH",
    "OAUTH_UNKNOWN_PROVIDER",
]);
export async function readJsonRequest(request, limitSource = null) {
    const raw = (await readLimitedRequestBody(request, limitSource)).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}
export async function readLimitedRequestBody(request, limitSource = null) {
    const maxBytes = resolveHttpMaxBodyBytes(limitSource);
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw createPayloadTooLargeError(maxBytes);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
export function resolveHttpMaxBodyBytes(source = null) {
    const configured = typeof source === "number"
        ? source
        : Number(source?.httpMaxBodyBytes ?? source?.http?.maxBodyBytes ?? source?.config?.http?.maxBodyBytes);
    return Number.isInteger(configured) && configured > 0 ? configured : 1024 * 1024;
}
function createPayloadTooLargeError(maxBytes) {
    const error = new Error("Request body is too large.");
    error.code = "PAYLOAD_TOO_LARGE";
    error.hint = `Send a request body at or below ${maxBytes} bytes, or raise http.maxBodyBytes in sporades.json.`;
    return error;
}
function isPayloadTooLargeError(error) {
    return error?.code === "PAYLOAD_TOO_LARGE";
}
export function writeUnhandledHttpError(database, request, response, error) {
    emitHttpFailureLog(database, request, error);
    if (isPayloadTooLargeError(error)) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(`${JSON.stringify({ ok: false, data: null, error: { code: error.code, message: error.message, hint: error.hint } })}\n`);
        return;
    }
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
        ok: false,
        data: null,
        error: {
            message: "Internal server error.",
            hint: "Check server logs and retry the request.",
        },
    })}\n`);
}
export function emitHttpFailureLog(database, request, error, context = {}) {
    const requestUrl = new URL(request.url ?? context.path ?? "/", "http://127.0.0.1");
    database.log?.emit?.({
        category: "platform",
        event: "http.request.failed",
        level: "error",
        message: isPayloadTooLargeError(error) ? "HTTP request body exceeded the configured limit." : "HTTP request failed.",
        request: {
            method: request.method ?? context.method ?? null,
            path: requestUrl.pathname,
        },
        data: {
            code: error?.code ?? null,
            message: error?.message ?? String(error),
            hint: error?.hint ?? null,
            stack: error?.stack ?? null,
            ...(context.attribution ?? request.__sporadesAccessKeyAttribution ?? {}),
        },
    });
}
export function prepareHttpSecurity(database, request, response) {
    const policy = database.securityPolicy ?? resolveRuntimeSecurityPolicy({});
    const originalWriteHead = response.writeHead.bind(response);
    response.writeHead = ((statusCode, statusMessageOrHeaders, maybeHeaders) => {
        const statusMessage = typeof statusMessageOrHeaders === "string" ? statusMessageOrHeaders : undefined;
        const inputHeaders = statusMessage ? maybeHeaders : typeof statusMessageOrHeaders === "string" ? {} : statusMessageOrHeaders;
        const headers = {
            ...sanitizeResponseHeaders(inputHeaders ?? {}),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
            "cross-origin-opener-policy": "same-origin",
            [policy.csp.header]: serializeCspDirectives(policy.csp.directives),
        };
        const origin = request.headers.origin;
        if (requestOriginAllowed(policy, request)) {
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : String(origin);
            if (!policy.cors.publicDev) {
                headers.vary = appendVaryHeader(headers.vary, "Origin");
            }
        }
        if (statusMessage) {
            return originalWriteHead(statusCode, statusMessage, headers);
        }
        return originalWriteHead(statusCode, headers);
    });
    if (request.method === "OPTIONS" && request.headers.origin && request.headers["access-control-request-method"]) {
        const headers = {
            "content-length": "0",
        };
        if (requestOriginAllowed(policy, request)) {
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : String(request.headers.origin);
            headers["access-control-allow-methods"] = "GET,POST,PUT,DELETE,OPTIONS";
            headers["access-control-allow-headers"] = String(request.headers["access-control-request-headers"] ?? "content-type,x-sporades-session-token");
            headers["access-control-max-age"] = "600";
            if (!policy.cors.publicDev) {
                headers.vary = "Origin";
            }
        }
        response.writeHead(204, headers);
        response.end();
        return true;
    }
    return false;
}
export function resolveRuntimeSecurityPolicy(config = {}) {
    const security = config.security ?? {};
    const cors = security.cors ?? {};
    const csp = security.csp ?? {};
    const session = config.__sporadesSession ?? "container";
    const publicDev = session === "public-dev";
    const dev = session === "dev" || publicDev;
    const configuredOrigins = Array.isArray(cors.allowedOrigins) ? cors.allowedOrigins.filter((origin) => typeof origin === "string") : [];
    const publicOrigin = normalizeOrigin(config.__sporadesPublicOrigin);
    const directives = {
        ...defaultRuntimeCspDirectives(),
        ...(csp.directives && typeof csp.directives === "object" && !Array.isArray(csp.directives) ? csp.directives : {}),
    };
    const mode = csp.mode === "enforce" ? "enforce" : "report-only";
    return {
        cors: {
            sameOrigin: !publicDev,
            publicDev,
            allowedOrigins: publicDev ? ["*"] : configuredOrigins,
            allowedOriginPatterns: dev && !publicDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [],
            requireExplicitCrossOrigin: !dev && configuredOrigins.length === 0,
            publicOrigin,
        },
        csp: {
            mode,
            header: mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only",
            directives,
        },
    };
}
function defaultRuntimeCspDirectives() {
    return {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
    };
}
function serializeCspDirectives(directives) {
    return Object.entries(directives)
        .map(([name, values]) => `${name} ${Array.isArray(values) ? values.join(" ") : String(values)}`)
        .join("; ");
}
export function injectPageConnectionToken(html, token) {
    const script = `<script>window.__SPORADES_CONNECTION_TOKEN=${JSON.stringify(token)};</script>`;
    if (/<head(\s[^>]*)?>/i.test(html)) {
        return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${script}`);
    }
    return `${script}\n${html}`;
}
function requestOriginAllowed(policy, request) {
    const origin = request.headers.origin;
    if (!origin) {
        return false;
    }
    if (policy.cors.publicDev) {
        return true;
    }
    if (policy.cors.publicOrigin && normalizeOrigin(origin) === policy.cors.publicOrigin) {
        return true;
    }
    if (policy.cors.allowedOrigins.includes("*") || policy.cors.allowedOrigins.includes(origin)) {
        return true;
    }
    if (!policy.cors.publicOrigin && policy.cors.sameOrigin && isSameOriginRequest(request, origin)) {
        return true;
    }
    return policy.cors.allowedOriginPatterns.length > 0 && isLocalDevOrigin(origin);
}
export function websocketOriginAllowed(policy, request) {
    if (!request.headers.origin) {
        return !policy.cors.publicOrigin;
    }
    return requestOriginAllowed(policy, request);
}
function isSameOriginRequest(request, origin) {
    const host = request.headers["x-forwarded-host"] ?? request.headers.host;
    if (!host) {
        return false;
    }
    const protocol = request.headers["x-forwarded-proto"] ?? (request.socket?.encrypted ? "https" : "http");
    return origin === `${protocol}://${host}`;
}
export function normalizeOrigin(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }
    try {
        return new URL(value).origin;
    }
    catch {
        return null;
    }
}
export function resolveOAuthRequestOrigin(policy, request) {
    const configuredOrigin = normalizeOrigin(policy?.cors?.publicOrigin);
    const originHeader = normalizeOrigin(singleHttpHeader(request.headers.origin));
    const hostHeader = singleHttpHeader(request.headers.host);
    const forwardedHost = singleHttpHeader(request.headers["x-forwarded-host"]);
    const forwardedProto = singleHttpHeader(request.headers["x-forwarded-proto"])?.toLowerCase() ?? null;
    if ((request.headers.host !== undefined && !hostHeader) ||
        (request.headers.origin !== undefined && !singleHttpHeader(request.headers.origin)) ||
        (request.headers["x-forwarded-host"] !== undefined && !forwardedHost) ||
        (request.headers["x-forwarded-proto"] !== undefined && !forwardedProto))
        return null;
    if (configuredOrigin) {
        const configured = new URL(configuredOrigin);
        if (originHeader && originHeader !== configuredOrigin)
            return null;
        if (validatedRequestHost(hostHeader, configured.protocol) !== configured.host)
            return null;
        if (forwardedHost && validatedRequestHost(forwardedHost, configured.protocol) !== configured.host)
            return null;
        if (forwardedProto && `${forwardedProto}:` !== configured.protocol)
            return null;
        return configuredOrigin;
    }
    if (forwardedHost || forwardedProto)
        return null;
    const protocol = request.socket?.encrypted === true ? "https:" : "http:";
    const host = validatedRequestHost(hostHeader, protocol);
    if (!host)
        return null;
    const actualOrigin = `${protocol}//${host}`;
    if (originHeader && originHeader !== actualOrigin)
        return null;
    return actualOrigin;
}
export function singleHttpHeader(value) {
    if (Array.isArray(value)) {
        if (value.length !== 1)
            return null;
        value = value[0];
    }
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes(","))
        return null;
    return trimmed;
}
function validatedRequestHost(value, protocol) {
    if (typeof value !== "string" || !/^[A-Za-z0-9.:[\]-]+$/.test(value))
        return null;
    try {
        const url = new URL(`${protocol}//${value}`);
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
            return null;
        return url.host.toLowerCase();
    }
    catch {
        return null;
    }
}
function isLocalDevOrigin(origin) {
    try {
        const parsed = new URL(origin);
        return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    }
    catch {
        return false;
    }
}
function appendVaryHeader(existing, value) {
    if (!existing) {
        return value;
    }
    const parts = String(existing)
        .split(",")
        .map((part) => part.trim().toLowerCase());
    return parts.includes(value.toLowerCase()) ? String(existing) : `${existing}, ${value}`;
}
function sanitizeResponseHeaders(headers) {
    const entries = headers instanceof Map ? headers.entries() : Object.entries(headers ?? {});
    return Object.fromEntries([...entries].filter(([name]) => {
        const normalized = String(name).toLowerCase();
        return normalized !== "x-powered-by" && normalized !== "server";
    }));
}
export async function handleFileHttpRoute(database, request, response, websocketHub = null) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const uploadMatch = requestUrl.pathname.match(/^\/__sporades\/uploads\/([^/]+)$/);
    if (uploadMatch && request.method === "PUT") {
        const result = await completePendingFileUpload(database, uploadMatch[1], request, websocketHub);
        writeJsonHttpResponse(response, result.ok ? 200 : 400, result);
        return true;
    }
    const privateMatch = requestUrl.pathname.match(/^\/__sporades\/files\/private\/([^/]+)$/);
    if (privateMatch && request.method === "GET") {
        const token = request.headers["x-sporades-session-token"];
        const session = await resolveAnonymousSession(database, Array.isArray(token) ? token[0] : (token ?? null));
        const row = await fileRowForActor(database, session.auth, privateMatch[1]);
        if (!row || row.version !== requestUrl.searchParams.get("v")) {
            writeNotFound(response);
            return true;
        }
        await sendFileHttpResponse(database, response, row);
        return true;
    }
    const publicMatch = requestUrl.pathname.match(/^\/__sporades\/files\/public\/([^/]+)$/);
    if (publicMatch && request.method === "GET") {
        const publicRow = await database.adapter.selectPublicFileRow(publicMatch[1]);
        if (!publicRow ||
            publicRow.revokedAt ||
            publicRow.deletedAt ||
            (publicRow.expiresAt && Date.parse(publicRow.expiresAt) <= Date.now()) ||
            publicRow.publicVersion !== requestUrl.searchParams.get("v") ||
            publicRow.publicVersion !== publicRow.version) {
            writeNotFound(response);
            return true;
        }
        await sendFileHttpResponse(database, response, publicRow);
        return true;
    }
    return false;
}
export async function routeRuntimeHealth(database, request, response) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/__sporades/health/runtime") {
        return false;
    }
    const probe = request.headers["x-sporades-host-probe"];
    if (typeof probe !== "string" || probe.length === 0) {
        writeNotFound(response);
        return true;
    }
    const result = await createRuntimeHealthResult(database);
    writeJsonHttpResponse(response, result.ok ? 200 : 503, result);
    return true;
}
async function createRuntimeHealthResult(database) {
    const checks = {
        sqlite: await checkRuntimeSqlite(database),
        fileStorage: await checkRuntimeFileStorage(database),
    };
    const ready = checks.sqlite.ok && checks.fileStorage.ok;
    return {
        ok: ready,
        data: {
            runtime: { ready },
            checks,
        },
        error: ready
            ? null
            : {
                message: "Sporades runtime is not ready.",
                hint: "Check Hosted Capsule logs and data volume permissions.",
            },
    };
}
export async function checkRuntimeSqlite(database) {
    return await (database.adapter ?? database.adapter).checkHealth();
}
function writeJsonHttpResponse(response, status, result) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(result)}\n`);
}
function writeNotFound(response) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
}
async function sendFileHttpResponse(database, response, row) {
    try {
        const bytes = await database.fileStorage.readFileVersion({ fileId: row.id, version: row.version });
        response.writeHead(200, {
            "content-type": contentTypeForFile(row.type),
            "cache-control": "private, max-age=31536000, immutable",
        });
        response.end(bytes);
    }
    catch {
        writeNotFound(response);
    }
}
export function writeEndpointResult(response, result) {
    if (result && typeof result === "object" && !Buffer.isBuffer(result) && "body" in result) {
        const status = result.status ?? 200;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw endpointResponseError();
        }
        if (result.headers !== undefined &&
            (result.headers === null || typeof result.headers !== "object" || Array.isArray(result.headers))) {
            throw endpointResponseError();
        }
        const headers = { ...(result.headers ?? {}) };
        const body = result.body ?? null;
        if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
            headers["content-type"] ??= "application/json; charset=utf-8";
            let payload;
            try {
                payload = JSON.stringify(body);
            }
            catch {
                throw endpointResponseError();
            }
            response.writeHead(status, headers);
            response.end(payload);
            return;
        }
        headers["content-type"] ??= "text/plain; charset=utf-8";
        response.writeHead(status, headers);
        response.end(String(body ?? ""));
        return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(result ?? ""));
}
export function writeEndpointError(response, error) {
    const headers = { "content-type": "application/json; charset=utf-8" };
    if (error?.code === "UNAUTHENTICATED" && error?.sporadesAccessKeyFailure) {
        headers["www-authenticate"] = error?.sporadesAccessKeyFailure === "invalid"
            ? 'Bearer realm="sporades", error="invalid_token"'
            : 'Bearer realm="sporades"';
    }
    if (error?.sporadesAccessKeyFailure) {
        headers["cache-control"] = "no-store";
        headers.pragma = "no-cache";
    }
    response.writeHead(endpointErrorStatus(error), headers);
    response.end(`${JSON.stringify({
        ok: false,
        data: null,
        error: {
            ...(error?.code ? { code: error.code } : {}),
            message: isPayloadTooLargeError(error)
                ? error.message
                : error?.hint
                    ? error.message
                    : error?.sporadesEndpointResponse
                        ? "Invalid endpoint response."
                        : "Endpoint handler failed.",
            hint: error?.sporadesEndpointResponse
                ? "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body."
                : isPayloadTooLargeError(error)
                    ? error.hint
                    : error?.hint
                        ? error.hint
                        : "Check the endpoint handler and retry the request.",
        },
    })}\n`);
}
function endpointErrorStatus(error) {
    if (error?.code === "UNAUTHENTICATED")
        return 401;
    if (error?.code === "FORBIDDEN")
        return 403;
    if (error?.code === "AUTH_RATE_LIMITED")
        return 429;
    if (isPayloadTooLargeError(error))
        return 413;
    if (isClientRequestError(error))
        return 400;
    return 500;
}
// Routes surface a small set of runtime-owned request errors through the same writer as Capsule
// handler failures. Keep their HTTP classification here, rather than teaching each route its own
// status-code special case.
function isClientRequestError(error) {
    return CLIENT_REQUEST_ERROR_CODES.has(error?.code);
}
function endpointResponseError() {
    const error = new Error("Invalid endpoint response.");
    error.sporadesEndpointResponse = true;
    return error;
}
//# sourceMappingURL=http-runtime.js.map