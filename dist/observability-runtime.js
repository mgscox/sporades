import { exceptionFrames } from "./exception-stack.js";
import { safePrivilegedAuditErrorCode } from "./acl-runtime.js";
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
    let sentryKey = null;
    if (errors && env[errors.dsnEnv]) {
        try {
            const parsed = new URL(env[errors.dsnEnv]);
            const key = parsed.username;
            if (!key || !/^[a-zA-Z0-9_-]+$/.test(key) || parsed.password || parsed.search || parsed.hash)
                throw new Error();
            sentryKey = key;
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
    // All lanes use one process-local fixed-window epoch, but never share capacity.
    const epoch = performance.now();
    const budget = (maxActive, maxCount) => {
        let active = 0, count = 0, window = 0;
        return () => {
            const currentWindow = Math.floor((performance.now() - epoch) / 60000);
            if (currentWindow !== window) {
                count = 0;
                window = currentWindow;
            }
            if (stopped.signal.aborted || active >= maxActive || count >= maxCount)
                return null;
            active++;
            count++;
            let released = false;
            return () => { if (!released) {
                released = true;
                active--;
            } };
        };
    };
    const acquireIngress = budget(8, 120);
    const acquirePublicDelivery = budget(4, 60);
    const acquireServerDelivery = budget(4, 60);
    // Include URL forms that can survive parsing before diagnostic redaction runs.
    const secretForms = [...new Set(Object.values(env)
            .filter((value) => typeof value === "string" && value.length > 0)
            .flatMap(value => {
            const forms = [value, redactDiagnosticText(value)];
            if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value)) {
                forms.push(value.split(/[?#]|%(?:3f|23)/i, 1)[0]);
                try {
                    const url = new URL(value, "https://redacted.invalid");
                    if (url.pathname !== "/")
                        forms.push(url.pathname);
                    if (url.search)
                        forms.push(url.search, url.search.slice(1));
                    forms.push(url.hash.slice(1), url.username, url.password);
                }
                catch { /* Malformed URL secrets still receive literal matching. */ }
            }
            return forms.filter(Boolean).flatMap(form => [form, form.toUpperCase(), form.toLowerCase(),
                // Pattern matching needs the whole normalized secret, as well as capped audit codes.
                form.trim().toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_"), safePrivilegedAuditErrorCode({ code: form })]);
        })
            .filter((value) => value !== null && value.length > 0))]
        .sort((a, b) => b.length - a.length);
    const secretPattern = secretForms.length ? new RegExp(secretForms.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;
    const overlappingSecrets = secretPattern ? new RegExp(`(?=(${secretPattern.source}))`, "gi") : null;
    const safeText = (value, limit) => {
        const text = (typeof value === "string" ? value : "Error").slice(0, 65536);
        // Identify overlapping secrets before transformations can split their bytes.
        const spans = [];
        if (overlappingSecrets)
            for (const match of text.matchAll(overlappingSecrets)) {
                const start = match.index, end = start + match[1].length, last = spans.at(-1);
                if (last && start <= last.end)
                    last.end = Math.max(last.end, end);
                else
                    spans.push({ start, end });
            }
        // The shared policy must see original URL, header and inline-source syntax.
        const safe = redactDiagnosticText(text.replace(/data:[^\s)]+/gi, "[embedded source]"));
        if (!spans.length)
            return (secretPattern ? safe.replace(secretPattern, "[REDACTED]") : safe).slice(0, limit);
        const rawLines = text.split("\n"), safeLines = safe.split("\n");
        if (rawLines.length !== safeLines.length)
            return "[REDACTED]".slice(0, limit);
        let offset = 0, spanIndex = 0, result = "";
        for (let index = 0; index < rawLines.length; index++) {
            const raw = rawLines[index], line = safeLines[index], end = offset + raw.length;
            let prefix = 0;
            while (prefix < raw.length && prefix < line.length && raw[prefix] === line[prefix])
                prefix++;
            while (spanIndex < spans.length && spans[spanIndex].end <= offset)
                spanIndex++;
            const local = [];
            let cutoff = line.length, privateNewline = false;
            for (let cursor = spanIndex; cursor < spans.length && spans[cursor].start <= end; cursor++) {
                const span = spans[cursor], start = Math.max(0, span.start - offset), stop = Math.min(raw.length, span.end - offset);
                if (start < stop) {
                    local.push({ start, end: stop });
                    // A transformed suffix cannot be mapped back safely: conceal it as a unit.
                    if (stop > prefix)
                        cutoff = Math.min(cutoff, start, prefix);
                }
                if (span.start <= end && span.end > end)
                    privateNewline = true;
            }
            let copied = 0;
            for (const span of local) {
                if (span.start >= Math.min(prefix, cutoff))
                    break;
                result += line.slice(copied, span.start) + "[REDACTED]";
                copied = Math.min(span.end, prefix, cutoff);
            }
            result += line.slice(copied, cutoff) + (cutoff < line.length ? "[REDACTED]" : "");
            if (index < rawLines.length - 1)
                result += privateNewline ? "[REDACTED]" : "\n";
            offset = end + 1;
        }
        if (secretPattern)
            result = result.replace(secretPattern, "[REDACTED]");
        return result.replace(/(?:\[REDACTED\]){2,}/g, "[REDACTED]").slice(0, limit);
    };
    const privilegedCauseCode = (cause) => {
        const candidate = cause && typeof cause === "object" ? cause.code : undefined;
        if (typeof candidate !== "string" || candidate.length > 65536)
            return "UNKNOWN_ERROR";
        // Redaction must see the original bytes before audit-code normalization changes them.
        const redacted = safeText(candidate, 65536);
        if (redacted !== candidate)
            return "UNKNOWN_ERROR";
        const normalized = safePrivilegedAuditErrorCode({ code: redacted }, "errored");
        return safeText(normalized, 64) === normalized ? normalized : "UNKNOWN_ERROR";
    };
    const send = async (url, body, headers) => {
        const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(2000)]) });
        // Provider bodies/headers never flow back to the browser or logs.
        await response.body?.cancel();
    };
    const transmit = (acquire, url, body, headers) => {
        const release = acquire();
        if (!release)
            return Promise.resolve();
        const task = send(url, body, headers).finally(() => { release(); pending.delete(task); });
        pending.add(task);
        return task;
    };
    const eventBase = (platform) => ({
        event_id: randomUUID().replaceAll("-", ""), timestamp: Date.now() / 1000, platform,
        environment: errors.environment, release: typeof config.release === "string" ? safeText(config.release, 128) : typeof config.release?.id === "string" ? safeText(config.release.id, 128) : undefined,
    });
    const deliver = (event, acquire) => {
        const payload = JSON.stringify(event);
        const body = `${JSON.stringify({ event_id: event.event_id, dsn })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
        if (!sentryUrl)
            return;
        void transmit(acquire, sentryUrl, body, { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${sentryKey}, sentry_client=sporades` }).catch(() => { });
    };
    const captureError = (error, surface, address, acquire, context = {}) => {
        try {
            if (!sentryUrl || error?.sporadesAuthDenialLogData || error?.sporadesAclDenialLogData
                || expectedDiagnosticErrorCodes.includes(error?.code)
                || Math.random() >= (errors.sampleRate ?? 1))
                return;
            const values = [], seen = new Set();
            let current = error, frameBudget = 20, textBudget = 2048;
            const privileged = error?.code === "PRIVILEGED_RUN_FAILED" || error?.code === "PRIVILEGED_AUDIT_EMISSION_FAILED";
            for (let depth = 0; depth < 4 && !seen.has(current); depth++) {
                seen.add(current);
                const currentPrivileged = current?.code === "PRIVILEGED_RUN_FAILED" || current?.code === "PRIVILEGED_AUDIT_EMISSION_FAILED";
                const fallback = surface === "client" && depth === 0 && !current?.stack && current?.location;
                const parsed = exceptionFrames(current?.stack, surface === "client" ? "sporades://embedded/module" : "sporades://capsule/server.mjs");
                if (fallback && typeof fallback.filename === "string" && fallback.filename && fallback.filename.length <= 4096) {
                    const filename = /^(data|blob):/i.test(fallback.filename) ? "sporades://embedded/module" : fallback.filename.split(/[?#]/, 1)[0];
                    parsed.push({ filename, function: "<anonymous>",
                        ...(Number.isInteger(fallback.lineno) && fallback.lineno > 0 ? { lineno: fallback.lineno } : {}),
                        ...(Number.isInteger(fallback.colno) && fallback.colno > 0 ? { colno: fallback.colno } : {}),
                    });
                }
                const frames = (frameBudget ? parsed.slice(-frameBudget) : [])
                    .map(frame => ({ ...frame, filename: safeText(frame.filename, 512), function: safeText(frame.function, 128) }));
                frameBudget -= frames.length;
                const message = current?.message ?? (typeof current === "object" && current !== null ? "Non-Error exception" : String(current));
                const value = safeText(message, textBudget);
                textBudget -= value.length;
                const errorCode = typeof current?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(current.code) ? safeText(current.code, 64) : undefined;
                values.unshift({
                    type: safeText(current?.name ?? (typeof current === "object" ? "Error" : "NonError"), 64), value, stacktrace: { frames },
                    mechanism: { type: "generic", data: {
                            stack_source: frames.length ? fallback ? "error_event" : "original" : "absent",
                            ...(errorCode ? { error_code: errorCode } : {}),
                            ...(currentPrivileged ? { cause_code: safeText(privilegedCauseCode(current.cause), 64) } : {}),
                        } },
                });
                // Privileged causes are opaque: only explicit, redacted audit codes may be exported.
                if (currentPrivileged || !current || (typeof current !== "object" && typeof current !== "function") || current.cause === undefined)
                    break;
                current = current.cause;
            }
            const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
            const event = {
                ...eventBase(surface === "client" ? "javascript" : "node"), level: "error",
                tags: { capsule: safeText(config.name ?? "capsule", 128), surface,
                    ...(surface !== "client" && typeof context.handler === "string" ? { handler: safeText(context.handler, 128) } : {}),
                    ...(code ? { error_code: safeText(code, 64) } : {}),
                    ...(privileged ? { cause_code: safeText(privilegedCauseCode(error.cause), 64) }
                        : typeof error?.cause?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.cause.code) ? { cause_code: safeText(error.cause.code, 64) } : {}),
                },
                exception: { values },
                ...(address ? { user: { ip_address: address } } : {}),
            };
            event.tags.correlation_id = event.event_id;
            deliver(event, acquire);
            return event.event_id;
        }
        catch { /* Error reporting must never replace the original failure. */ }
    };
    return {
        enabled: !!analyticsUrl || !!(sentryUrl && errors.client),
        clientErrors: !!(sentryUrl && errors.client),
        analytics: !!analyticsUrl,
        capture(error, surface, address, context = {}) {
            return captureError(error, surface, address, acquireServerDelivery, context);
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
                }, acquirePublicDelivery);
            }
            catch { /* Reports are best effort. */ }
        },
        close() { stopped.abort(); },
        async flush() { await Promise.allSettled([...pending]); },
        async collect(input, origin, request, database) {
            if (input.type === "error") {
                if (!sentryUrl || !errors.client || typeof input.message !== "string" || (input.stack !== undefined && typeof input.stack !== "string"))
                    throw new Error();
                // Public DTOs cannot supply handler, codes, release, surface or correlation IDs.
                const clientError = { name: typeof input.name === "string" ? input.name : "Error", message: input.message, stack: input.stack, location: input.location };
                let target = clientError;
                if (Array.isArray(input.causes))
                    for (const cause of input.causes.slice(0, 3)) {
                        if (!cause || typeof cause.message !== "string")
                            break;
                        target.cause = { name: typeof cause.name === "string" ? cause.name : "Error", message: cause.message, stack: typeof cause.stack === "string" ? cause.stack : undefined };
                        target = target.cause;
                    }
                captureError(clientError, "client", trustedClientAddress(database, request), acquirePublicDelivery);
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
            await transmit(acquirePublicDelivery, analyticsUrl, JSON.stringify(body), headers);
        },
        acquireIngress,
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
    const release = database.observability.acquireIngress();
    if (!release) {
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
        release();
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
    const release = database.observability.acquireIngress();
    if (!release)
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
        release();
    }
}
//# sourceMappingURL=observability-runtime.js.map