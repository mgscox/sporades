import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { interpretHttpRequestTarget } from "./http-runtime.js";
const builtinRoutes = [
    ["GET", "/__sporades/connection-token"],
    ["GET", "/__sporades/health/runtime"],
    ["GET", "/__sporades/debug/logs"],
    ["GET", "/__sporades/debug/logs/tail"],
    ["GET", "/__sporades/debug/db/list"],
    ["GET", "/__sporades/debug/db/dump"],
    ["POST", "/__sporades/debug/db/query"],
    ["POST", "/__sporades/debug/ctx-log"],
    ["POST", "/__sporades/debug/privileged-audit"],
    ["POST", "/__sporades/debug/auth/as"],
    ["GET", "/__sporades/debug/auth/clients"],
];
/** Only declared routes and explicit platform templates may become trace labels. */
export function resolveTelemetryRoute(request, endpoints) {
    const method = safeMethod(request.method);
    const target = interpretHttpRequestTarget(request.url, request.method);
    if (!target)
        return "/__unknown";
    const pathname = target.pathname;
    const custom = endpoints.find((endpoint) => endpoint.method === method && endpoint.path === pathname);
    if (custom && /^\/[a-zA-Z0-9/_%.:-]{0,120}$/.test(custom.path))
        return custom.path;
    if (builtinRoutes.some(([routeMethod, routePath]) => routeMethod === method && routePath === pathname))
        return pathname;
    if (method === "GET" && /^\/__sporades\/files\/private\/[^/]+$/.test(pathname))
        return "/__sporades/files/private/:id";
    if (method === "PUT" && /^\/__sporades\/uploads\/[^/]+$/.test(pathname))
        return "/__sporades/uploads/:id";
    if (pathname.startsWith("/__sporades/auth/"))
        return "/__sporades/auth/*";
    return "/__unknown";
}
function safeMethod(method) {
    const value = typeof method === "string" ? method.toUpperCase() : "OTHER";
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value) ? value : "OTHER";
}
const requestSpan = new AsyncLocalStorage();
/** Internal seam for later operation spans; no Capsule-facing API is exported. */
export function activeRuntimeRequestSpan() { return requestSpan.getStore(); }
function validatedRemoteParent(request) {
    const value = request.headers.traceparent;
    if (typeof value !== "string" || value.length !== 55)
        return ROOT_CONTEXT;
    const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-(00|01)$/.exec(value);
    if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
        return ROOT_CONTEXT;
    return trace.setSpanContext(ROOT_CONTEXT, {
        traceId: match[1],
        spanId: match[2],
        traceFlags: match[3] === "01" ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: true,
    });
}
function exportFailureReason(error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === 401 || code === 403)
        return "AUTH_REJECTED";
    if (typeof code === "string") {
        if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code))
            return "DESTINATION_UNAVAILABLE";
        if (code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code))
            return "TLS_FAILED";
    }
    return "EXPORT_FAILED";
}
export function createHttpRequestTelemetry(config, onDiagnostic) {
    if (!config)
        return { run: (_request, _response, _endpoints, handle) => handle(), shutdown: async () => { } };
    const url = new URL(config.endpoint);
    const endpoint = new URL("/v1/traces", url).toString();
    const token = config.credentialEnv ? process.env[config.credentialEnv] : undefined;
    if (config.credentialEnv && !token)
        throw new Error("Telemetry ingestion credential is unavailable.");
    if (config.tls.caFile && statSync(config.tls.caFile).size > 1024 * 1024)
        throw new Error("Telemetry CA file is too large.");
    const exporter = new OTLPTraceExporter({
        url: endpoint,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeoutMillis: 600,
        concurrencyLimit: 1,
        httpAgentOptions: config.tls.caFile ? { ca: readFileSync(config.tls.caFile), keepAlive: false, maxSockets: 1 } : { keepAlive: false, maxSockets: 1 },
    });
    let failedReason = null;
    let lastFailureLoggedAt = 0;
    const emitDiagnostic = (diagnostic) => {
        try {
            const recorded = onDiagnostic?.(diagnostic);
            if (recorded && typeof recorded.then === "function")
                void Promise.resolve(recorded).catch(() => { });
        }
        catch { /* Telemetry diagnostics cannot affect exports or application work. */ }
    };
    const observedExporter = {
        export(spans, callback) {
            exporter.export(spans, (result) => {
                try {
                    if (result.code === 0) {
                        if (failedReason)
                            emitDiagnostic({ event: "telemetry.export.recovered" });
                        failedReason = null;
                    }
                    else {
                        const reason = exportFailureReason(result.error);
                        const now = Date.now();
                        if (reason !== failedReason || now - lastFailureLoggedAt >= 60_000) {
                            emitDiagnostic({ event: "telemetry.export.failed", reason });
                            lastFailureLoggedAt = now;
                        }
                        failedReason = reason;
                    }
                }
                catch { /* A malformed exporter result must not change SDK completion. */ }
                callback(result);
            });
        },
        forceFlush: () => exporter.forceFlush(),
        shutdown: () => exporter.shutdown(),
    };
    const processor = new BatchSpanProcessor(observedExporter, {
        maxQueueSize: 128,
        maxExportBatchSize: 32,
        scheduledDelayMillis: 500,
        exportTimeoutMillis: 800,
    });
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ "service.name": config.serviceName.slice(0, 80) }),
        sampler: new TraceIdRatioBasedSampler(config.samplingRatio ?? 1),
        spanProcessors: [processor],
    });
    const tracer = provider.getTracer("sporades-runtime-http", "1");
    let closing = false;
    return {
        run(request, response, endpoints, handle) {
            if (closing)
                return handle();
            const method = safeMethod(request.method);
            const route = resolveTelemetryRoute(request, endpoints);
            const span = tracer.startSpan(`${method} ${route}`, { kind: SpanKind.SERVER, attributes: { "http.request.method": method, "http.route": route } }, validatedRemoteParent(request));
            let ended = false;
            const end = (outcome) => {
                if (ended)
                    return;
                ended = true;
                const status = Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : 500;
                span.setAttribute("http.response.status_code", status);
                span.setAttribute("sporades.http.outcome", outcome);
                if (outcome !== "success")
                    span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            };
            response.once("finish", () => end(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "failure" : "success"));
            response.once("close", () => { if (!response.writableFinished)
                end("abort"); });
            response.once("error", () => end("error"));
            request.once("aborted", () => end("abort"));
            try {
                const result = requestSpan.run(span, handle);
                if (result && typeof result.then === "function") {
                    return Promise.resolve(result).catch((error) => { end("error"); throw error; });
                }
                return result;
            }
            catch (error) {
                end("error");
                throw error;
            }
        },
        async shutdown() {
            if (closing)
                return;
            closing = true;
            await Promise.race([provider.shutdown().catch(() => { }), new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref(); })]);
        },
    };
}
//# sourceMappingURL=runtime-telemetry.js.map