import { collectionLoaderSource } from "./templates/observability-loader.js";
import { randomUUID } from "node:crypto";
import { expectedDiagnosticErrorCodes } from "./runtime-errors.js";
import { redactDiagnosticText } from "./runtime-log-policy.js";
import { trustedClientAddress } from "./client-address.js";
import { CSP_REPORT_PATH } from "./http-security-config.js";
/** Configuration contains env names only; resolved provider credentials stay server-side. */
export function validateObservabilityConfig(config) {
    const fail = () => { const error = new Error("Invalid observability or analytics configuration."); Object.assign(error, { code: "INVALID_OBSERVABILITY_CONFIG" }); throw error; };
    const object = (value, keys) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
            fail();
    };
    const envName = (value) => typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/i.test(value);
    if (config.observability !== undefined) {
        object(config.observability, ["errors"]);
        if (config.observability.errors !== undefined) {
            const errors = config.observability.errors;
            object(errors, ["protocol", "dsnEnv", "environment", "sampleRate", "client"]);
            if (errors.protocol !== "sentry" || !envName(errors.dsnEnv)
                || (errors.client !== undefined && typeof errors.client !== "boolean")
                || (errors.environment !== undefined && (typeof errors.environment !== "string" || !/^[\w.-]{1,64}$/.test(errors.environment)))
                || (errors.sampleRate !== undefined && (typeof errors.sampleRate !== "number" || !Number.isFinite(errors.sampleRate) || errors.sampleRate < 0 || errors.sampleRate > 1)))
                fail();
        }
    }
    if (config.analytics !== undefined) {
        const analytics = config.analytics;
        object(analytics, ["provider", "endpointEnv", "websiteIdEnv", "redactQuery"]);
        if (!["umami", "plausible"].includes(analytics.provider) || !envName(analytics.endpointEnv) || !envName(analytics.websiteIdEnv)
            || (analytics.redactQuery !== undefined && analytics.redactQuery !== true))
            fail();
    }
}
function providerUrl(value) {
    try {
        if (typeof value !== "string" || value.length > 2048)
            throw new Error();
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
            throw new Error();
        return url;
    }
    catch {
        throw Object.assign(new Error("Invalid collection provider configuration."), { code: "INVALID_OBSERVABILITY_CONFIG" });
    }
}
/** Always remove queries/fragments, including from callers bypassing the loader. */
function pageUrl(value, origin) {
    if (typeof value !== "string" || value.length > 4096)
        throw new Error();
    const url = new URL(value, origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error();
    url.search = "";
    url.hash = "";
    return url;
}
export function createRuntimeObservability(config = {}, env = {}) {
    validateObservabilityConfig(config);
    const analytics = config.analytics;
    // A missing env value leaves the integration dormant, useful in existing Dev sessions.
    const analyticsUrl = analytics && env[analytics.endpointEnv] && env[analytics.websiteIdEnv] ? providerUrl(env[analytics.endpointEnv]) : null;
    const website = analyticsUrl ? env[analytics.websiteIdEnv] : null;
    if (website && (typeof website !== "string" || website.length > 255 || /[\s?#\/]/.test(website)))
        throw new Error("Invalid collection provider configuration.");
    const errors = config.observability?.errors;
    let sentryUrl = null;
    let dsn = null;
    if (errors && env[errors.dsnEnv]) {
        try {
            const parsed = new URL(env[errors.dsnEnv]);
            const key = parsed.username;
            if (!key || !/^[a-zA-Z0-9_-]+$/.test(key) || parsed.password || parsed.search || parsed.hash)
                throw new Error();
            parsed.username = "";
            const segments = parsed.pathname.split("/").filter(Boolean);
            const project = segments.pop();
            if (!project || !/^\d+$/.test(project))
                throw new Error();
            sentryUrl = providerUrl(parsed.href);
            sentryUrl.pathname = `/${[...segments, "api", project, "envelope", ""].join("/")}`;
            dsn = String(env[errors.dsnEnv]);
        }
        catch {
            throw Object.assign(new Error("Invalid collection provider configuration."), { code: "INVALID_OBSERVABILITY_CONFIG" });
        }
    }
    const stopped = new AbortController();
    const pending = new Set();
    let active = 0, count = 0, windowStart = performance.now();
    const enter = () => {
        const now = performance.now();
        if (now - windowStart >= 60000) {
            count = 0;
            windowStart = now;
        }
        if (stopped.signal.aborted || active >= 8 || count >= 120)
            return false;
        active++;
        count++;
        return true;
    };
    const safeText = (value, limit) => redactDiagnosticText(typeof value === "string" ? value : "Error", env).slice(0, limit);
    const send = async (url, body, headers) => {
        const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(2000)]) });
        // Provider bodies/headers never flow back to the browser or logs.
        await response.body?.cancel();
    };
    const eventBase = (platform) => ({
        event_id: randomUUID().replaceAll("-", ""), timestamp: Date.now() / 1000, platform,
        environment: errors.environment, release: typeof config.release === "string" ? safeText(config.release, 128) : typeof config.release?.id === "string" ? safeText(config.release.id, 128) : undefined,
    });
    const deliver = (event) => {
        const payload = JSON.stringify(event);
        const body = `${JSON.stringify({ event_id: event.event_id, dsn })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
        if (!sentryUrl || !enter())
            return;
        const task = send(sentryUrl, body, { "content-type": "application/x-sentry-envelope" }).catch(() => { }).finally(() => { active--; pending.delete(task); });
        pending.add(task);
    };
    return {
        enabled: !!analyticsUrl || !!(sentryUrl && errors.client),
        clientErrors: !!(sentryUrl && errors.client),
        analytics: !!analyticsUrl,
        capture(error, surface, address) {
            try {
                if (!sentryUrl || error?.sporadesAuthDenialLogData || error?.sporadesAclDenialLogData
                    || expectedDiagnosticErrorCodes.includes(error?.code)
                    || Math.random() >= (errors.sampleRate ?? 1))
                    return;
                const frames = typeof error?.stack === "string" ? error.stack.slice(0, 8192).split("\n").slice(1, 21).flatMap((line) => {
                    const match = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
                    return match ? [{ filename: safeText(match[2], 512), function: safeText(match[1] || "<anonymous>", 128), lineno: Number(match[3]), colno: Number(match[4]) }] : [];
                }).reverse() : [];
                const event = {
                    ...eventBase(surface === "client" ? "javascript" : "node"), level: "error",
                    tags: { capsule: safeText(config.name ?? "capsule", 128), surface },
                    exception: { values: [{ type: "Error", value: safeText(error?.message ?? error, 2048), stacktrace: { frames } }] },
                    ...(address ? { user: { ip_address: address } } : {}),
                };
                deliver(event);
            }
            catch { /* Error reporting must never replace the original failure. */ }
        },
        /** Values arrive already reduced by `cspViolations`; no document, sample, policy or client address is sent. */
        captureCspViolation(violation) {
            try {
                if (!sentryUrl || Math.random() >= (errors.sampleRate ?? 1))
                    return;
                deliver({
                    ...eventBase("javascript"), level: "warning", logger: "csp",
                    message: `CSP violation: ${violation.directive} blocked ${violation.blocked}`,
                    tags: { capsule: safeText(config.name ?? "capsule", 128), surface: "csp", csp_directive: violation.directive, csp_blocked: violation.blocked, ...(violation.disposition ? { csp_disposition: violation.disposition } : {}) },
                });
            }
            catch { /* Reports are best effort. */ }
        },
        close() { stopped.abort(); },
        async flush() { await Promise.allSettled([...pending]); },
        async collect(input, origin, request, database) {
            if (input.type === "error") {
                if (!sentryUrl || !errors.client || typeof input.message !== "string" || (input.stack !== undefined && typeof input.stack !== "string"))
                    throw new Error();
                this.capture({ message: input.message, stack: input.stack }, "client", trustedClientAddress(database, request));
                return;
            }
            if (!analyticsUrl || input.type !== "pageview")
                throw new Error();
            const url = pageUrl(input.url, origin);
            if (url.origin !== origin)
                throw new Error();
            const referrer = input.referrer ? pageUrl(input.referrer, origin).href : "";
            const address = trustedClientAddress(database, request);
            const headers = { "content-type": "application/json", "user-agent": safeText(request.headers["user-agent"] ?? "Sporades", 512) };
            if (address)
                headers["x-forwarded-for"] = address;
            const body = analytics.provider === "umami"
                ? { type: "event", payload: { website, hostname: url.hostname, url: url.pathname, referrer } }
                : { name: "pageview", domain: website, url: url.href, referrer };
            await send(analyticsUrl, JSON.stringify(body), headers);
        },
        enter,
        leave() { active--; },
    };
}
export async function routeCollection(database, request, response) {
    const pathname = request.url?.split("?")[0];
    if (pathname === CSP_REPORT_PATH && database.securityPolicy?.csp?.reportTo === "observability" && database.observability) {
        await routeCspReport(database, request, response);
        return true;
    }
    if (!database.observability?.enabled)
        return false;
    if (pathname === "/__sporades/observe.js" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(collectionLoaderSource(database.observability.clientErrors, database.observability.analytics));
        return true;
    }
    if (pathname !== "/__sporades/collect")
        return false;
    const reply = (code) => { response.writeHead(code, { "cache-control": "no-store" }); response.end(); };
    const origin = request.headers.origin;
    try {
        if (request.method !== "POST" || typeof origin !== "string" || new URL(origin).origin !== origin || !["http:", "https:"].includes(new URL(origin).protocol)
            || new URL(origin).host !== request.headers.host || request.headers["sec-fetch-site"] === "cross-site"
            || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            reply(403);
            return true;
        }
        const allowed = database.securityPolicy?.cors?.publicOrigin;
        if (allowed && ![allowed, ...(database.securityPolicy.cors.publicAliases ?? [])].includes(origin)) {
            reply(403);
            return true;
        }
    }
    catch {
        reply(403);
        return true;
    }
    if (!database.observability.enter()) {
        reply(429);
        return true;
    }
    let timer;
    try {
        const body = await Promise.race([
            (async () => { const chunks = []; let size = 0; for await (const chunk of request) {
                size += Buffer.byteLength(chunk);
                if (size > 16384)
                    throw new Error();
                chunks.push(Buffer.from(chunk));
            } return Buffer.concat(chunks).toString("utf8"); })(),
            new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error()); request.destroy(); }, 2000); }),
        ]);
        clearTimeout(timer);
        const input = JSON.parse(body);
        if (!input || Array.isArray(input) || typeof input !== "object")
            throw new Error();
        await database.observability.collect(input, origin, request, database);
        reply(204);
    }
    catch {
        if (!response.destroyed)
            reply(400);
    }
    finally {
        clearTimeout(timer);
        database.observability.leave();
    }
    return true;
}
const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json", "application/json"];
const CSP_BLOCKED_KEYWORDS = ["inline", "eval", "wasm-eval", "self", "trusted-types-policy", "trusted-types-sink"];
const CSP_REPORTS_PER_REQUEST = 5;
/** Reduce one browser report to a directive name and blocked origin or keyword. Everything else is discarded. */
function cspViolation(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    const report = input;
    const raw = report["effective-directive"] ?? report.effectiveDirective ?? report["violated-directive"];
    const directive = typeof raw === "string" ? raw.trim().split(/\s+/)[0] : "";
    if (!/^[a-z][a-z-]{0,63}$/.test(directive))
        return null;
    const value = report["blocked-uri"] ?? report.blockedURL;
    let blocked = "unknown";
    if (typeof value === "string" && CSP_BLOCKED_KEYWORDS.includes(value))
        blocked = value;
    else if (typeof value === "string" && value.length <= 8192) {
        try {
            const url = new URL(value);
            blocked = /^(https?|wss?):$/.test(url.protocol) ? url.origin : /^[a-z][a-z0-9+.-]{0,31}:$/.test(url.protocol) ? url.protocol : "unknown";
        }
        catch { /* Opaque or relative values stay unknown. */ }
    }
    const disposition = report.disposition === "enforce" || report.disposition === "report" ? report.disposition : undefined;
    return { directive, blocked, ...(disposition ? { disposition } : {}) };
}
function cspViolations(input) {
    if (Array.isArray(input)) {
        return input.slice(0, 100)
            .filter(entry => entry && typeof entry === "object" && entry.type === "csp-violation")
            .slice(0, CSP_REPORTS_PER_REQUEST)
            .map(entry => cspViolation(entry.body))
            .filter((entry) => entry !== null);
    }
    const report = input && typeof input === "object" ? cspViolation(input["csp-report"]) : null;
    return report ? [report] : [];
}
/** Browser CSP reports carry no credentials, so the route accepts only bounded, same-origin-compatible input. */
async function routeCspReport(database, request, response) {
    const reply = (code) => { if (!response.headersSent) {
        response.writeHead(code, { "cache-control": "no-store" });
        response.end();
    } };
    if (request.method !== "POST")
        return reply(405);
    const origin = request.headers.origin;
    try {
        if (request.headers["sec-fetch-site"] === "cross-site"
            || (origin !== undefined && (typeof origin !== "string" || new URL(origin).host !== request.headers.host)))
            return reply(403);
    }
    catch {
        return reply(403);
    }
    const type = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!CSP_REPORT_TYPES.includes(type))
        return reply(415);
    if (!database.observability.enter())
        return reply(429);
    let timer;
    try {
        const body = await Promise.race([
            (async () => {
                const chunks = [];
                let size = 0;
                for await (const chunk of request) {
                    size += Buffer.byteLength(chunk);
                    if (size > 16384)
                        throw Object.assign(new Error(), { status: 413 });
                    chunks.push(Buffer.from(chunk));
                }
                return Buffer.concat(chunks).toString("utf8");
            })(),
            new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error()); request.destroy(); }, 2000); }),
        ]);
        const violations = cspViolations(JSON.parse(body));
        if (!violations.length)
            throw new Error();
        for (const violation of violations)
            database.observability.captureCspViolation(violation);
        reply(204);
    }
    catch (error) {
        if (!response.destroyed)
            reply(error?.status === 413 ? 413 : 400);
    }
    finally {
        clearTimeout(timer);
        database.observability.leave();
    }
}
//# sourceMappingURL=observability-runtime.js.map