import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { constants as performanceConstants, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AggregationTemporalityPreference, OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { interpretHttpRequestTarget } from "./http-runtime.js";
import { runtimeRequestScope, withoutRuntimeRequestIdentity } from "./runtime-request-context.js";
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
const processInstanceId = randomUUID();
/** Internal seam for later operation spans; no Capsule-facing API is exported. */
export function activeRuntimeRequestSpan() { return runtimeRequestScope.getStore()?.span; }
/** Only runtime-created identities may be attached to the existing log envelope. */
export function activeRuntimeLogIdentity() {
    const scope = runtimeRequestScope.getStore();
    if (!scope)
        return undefined;
    const context = scope.span?.spanContext();
    const traceId = context && /^[0-9a-f]{32}$/.test(context.traceId) && !/^0+$/.test(context.traceId) ? context.traceId : null;
    const spanId = traceId && context && /^[0-9a-f]{16}$/.test(context.spanId) && !/^0+$/.test(context.spanId) ? context.spanId : null;
    return { requestId: scope.requestId, traceId, spanId };
}
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
/** The pinned OTLP SDK merges process OTLP headers even when headers are supplied.
 * It snapshots those fallbacks during synchronous construction; export callbacks
 * use only that snapshot. Keep this isolation scoped to the two constructors. */
function createProfileExporters(traceOptions, metricOptions) {
    const ambient = Object.entries(process.env).filter(([key]) => key.startsWith("OTEL_EXPORTER_OTLP_"));
    try {
        for (const [key] of ambient)
            delete process.env[key];
        return { trace: new OTLPTraceExporter(traceOptions), metrics: new OTLPMetricExporter(metricOptions) };
    }
    finally {
        for (const [key, value] of ambient)
            process.env[key] = value;
    }
}
export function createHttpRequestTelemetry(config, onDiagnostic) {
    if (!config)
        return { run: (_request, _response, _endpoints, handle) => runtimeRequestScope.run({ requestId: randomUUID() }, handle), shutdown: async () => { } };
    if (config.eventLoopDelayResolutionMs !== undefined && (!Number.isSafeInteger(config.eventLoopDelayResolutionMs) || config.eventLoopDelayResolutionMs < 10 || config.eventLoopDelayResolutionMs > 1000))
        throw new Error("Event-loop delay resolution must be an integer from 10 to 1000 milliseconds.");
    const url = new URL(config.endpoint);
    const endpoint = new URL("/v1/traces", url).toString();
    const token = config.credentialEnv ? process.env[config.credentialEnv] : undefined;
    if (config.credentialEnv && !token)
        throw new Error("Telemetry ingestion credential is unavailable.");
    if (config.tls.caFile && statSync(config.tls.caFile).size > 1024 * 1024)
        throw new Error("Telemetry CA file is too large.");
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const httpAgentOptions = { ...(config.tls.caFile ? { ca: readFileSync(config.tls.caFile) } : {}), rejectUnauthorized: true, keepAlive: false, maxSockets: 1 };
    const compression = "none";
    const { trace: exporter, metrics: metricExporter } = createProfileExporters({
        url: endpoint, headers, compression, timeoutMillis: 600, concurrencyLimit: 1, httpAgentOptions,
    }, {
        url: new URL("/v1/metrics", url).toString(), headers, compression, temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
        timeoutMillis: 600, concurrencyLimit: 1, httpAgentOptions,
    });
    const failedExports = { traces: false, metrics: false };
    const lastFailureLoggedAt = new Map();
    let reportedOutage = false;
    const emitDiagnostic = (diagnostic) => {
        try {
            const recorded = withoutRuntimeRequestIdentity(() => onDiagnostic?.(diagnostic));
            if (recorded && typeof recorded.then === "function")
                void Promise.resolve(recorded).catch(() => { });
        }
        catch { /* Telemetry diagnostics cannot affect exports or application work. */ }
    };
    const observeExport = (signal, result) => {
        try {
            if (result.code === 0) {
                const wasFailed = failedExports.traces || failedExports.metrics;
                failedExports[signal] = false;
                if (wasFailed && !failedExports.traces && !failedExports.metrics && reportedOutage) {
                    emitDiagnostic({ event: "telemetry.export.recovered" });
                    reportedOutage = false;
                }
            }
            else {
                failedExports[signal] = true;
                const reason = exportFailureReason(result.error);
                const now = Date.now();
                if (!lastFailureLoggedAt.has(reason) || now - lastFailureLoggedAt.get(reason) >= 60_000) {
                    emitDiagnostic({ event: "telemetry.export.failed", reason });
                    lastFailureLoggedAt.set(reason, now);
                    reportedOutage = true;
                }
            }
        }
        catch { /* A malformed exporter result must not change SDK completion. */ }
    };
    const observedMetricExporter = {
        export(metrics, callback) {
            metricExporter.export(metrics, (result) => {
                observeExport("metrics", result);
                callback(result);
            });
        },
        forceFlush: () => metricExporter.forceFlush(),
        shutdown: () => metricExporter.shutdown(),
        selectAggregation: metricExporter.selectAggregation?.bind(metricExporter),
        selectAggregationTemporality: metricExporter.selectAggregationTemporality?.bind(metricExporter),
    };
    const metricReader = new PeriodicExportingMetricReader({
        exporter: observedMetricExporter,
        exportIntervalMillis: config.metricsIntervalMs ?? 15_000,
        exportTimeoutMillis: 800,
    });
    const resource = resourceFromAttributes({
        "service.name": config.serviceName.slice(0, 80),
        "service.instance.id": processInstanceId,
        "deployment.environment.name": config.environment ?? "unknown",
    });
    const meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
        views: [
            { instrumentName: "http.server.request.count", aggregationCardinalityLimit: 512 },
            { instrumentName: "http.server.active_requests", aggregationCardinalityLimit: 128 },
            { instrumentName: "http.server.request.duration", aggregationCardinalityLimit: 512, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] } } },
        ],
    });
    const meter = meterProvider.getMeter("sporades-runtime-http", "1");
    const requestCount = meter.createCounter("http.server.request.count", { unit: "1" });
    const requestDuration = meter.createHistogram("http.server.request.duration", { unit: "s" });
    const activeRequests = meter.createUpDownCounter("http.server.active_requests", { unit: "1" });
    const processMeter = meterProvider.getMeter("sporades-runtime-process", "1");
    const gcKinds = new Map([
        [performanceConstants.NODE_PERFORMANCE_GC_MAJOR, "major"],
        [performanceConstants.NODE_PERFORMANCE_GC_MINOR, "minor"],
        [performanceConstants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
        [performanceConstants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
    ]);
    const gcTotals = new Map();
    const recordGc = (entries) => {
        for (const entry of entries) {
            if (!Number.isFinite(entry.duration) || entry.duration < 0)
                continue;
            const kind = gcKinds.get(entry.detail?.kind ?? -1) ?? "other";
            const total = gcTotals.get(kind) ?? { count: 0, durationSeconds: 0 };
            total.count += 1;
            total.durationSeconds += entry.duration / 1000;
            gcTotals.set(kind, total);
        }
    };
    const gcObserver = new PerformanceObserver((list) => recordGc(list.getEntries()));
    gcObserver.observe({ entryTypes: ["gc"] });
    const loopDelay = monitorEventLoopDelay({ resolution: config.eventLoopDelayResolutionMs ?? 20 });
    loopDelay.enable();
    let previousElu = performance.eventLoopUtilization();
    const cpuTime = processMeter.createObservableCounter("process.cpu.time", { unit: "s" });
    const rss = processMeter.createObservableGauge("process.memory.rss", { unit: "By" });
    const heapUsed = processMeter.createObservableGauge("process.memory.heap.used", { unit: "By" });
    const heapAllocated = processMeter.createObservableGauge("process.memory.heap.allocated", { unit: "By" });
    const heapLimit = processMeter.createObservableGauge("process.memory.heap.limit", { unit: "By" });
    const external = processMeter.createObservableGauge("process.memory.external", { unit: "By" });
    const arrayBuffers = processMeter.createObservableGauge("process.memory.array_buffers", { unit: "By" });
    const uptime = processMeter.createObservableGauge("process.uptime", { unit: "s" });
    const gcCount = processMeter.createObservableCounter("process.gc.count", { unit: "1" });
    const gcDuration = processMeter.createObservableCounter("process.gc.duration", { unit: "s" });
    const delayMax = processMeter.createObservableGauge("process.event_loop.delay.max", { unit: "ms" });
    const delayMean = processMeter.createObservableGauge("process.event_loop.delay.mean", { unit: "ms" });
    const delayP99 = processMeter.createObservableGauge("process.event_loop.delay.p99", { unit: "ms" });
    const loopUtilization = processMeter.createObservableGauge("process.event_loop.utilization", { unit: "1" });
    // The metric reader owns the only collection interval. No process API runs per request.
    processMeter.addBatchObservableCallback((result) => {
        const cpu = process.cpuUsage();
        const memory = process.memoryUsage();
        result.observe(cpuTime, cpu.user / 1e6, { state: "user" });
        result.observe(cpuTime, cpu.system / 1e6, { state: "system" });
        result.observe(rss, memory.rss);
        result.observe(heapUsed, memory.heapUsed);
        result.observe(heapAllocated, memory.heapTotal);
        result.observe(heapLimit, getHeapStatistics().heap_size_limit);
        result.observe(external, memory.external);
        result.observe(arrayBuffers, memory.arrayBuffers);
        result.observe(uptime, process.uptime());
        recordGc(gcObserver.takeRecords());
        for (const [kind, total] of gcTotals) {
            result.observe(gcCount, total.count, { kind });
            result.observe(gcDuration, total.durationSeconds, { kind });
        }
        if (loopDelay.count > 0) {
            result.observe(delayMax, loopDelay.max / 1e6);
            result.observe(delayMean, loopDelay.mean / 1e6);
            result.observe(delayP99, loopDelay.percentile(99) / 1e6);
        }
        loopDelay.reset();
        const currentElu = performance.eventLoopUtilization();
        const intervalElu = performance.eventLoopUtilization(previousElu);
        previousElu = currentElu;
        if (Number.isFinite(intervalElu.utilization) && intervalElu.active + intervalElu.idle > 0)
            result.observe(loopUtilization, intervalElu.utilization);
    }, [cpuTime, rss, heapUsed, heapAllocated, heapLimit, external, arrayBuffers, uptime, gcCount, gcDuration, delayMax, delayMean, delayP99, loopUtilization]);
    const seenRoutes = new Set();
    const observedExporter = {
        export(spans, callback) {
            exporter.export(spans, (result) => {
                observeExport("traces", result);
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
        resource,
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
            let route = resolveTelemetryRoute(request, endpoints);
            if (!seenRoutes.has(route)) {
                if (seenRoutes.size < 128)
                    seenRoutes.add(route);
                else
                    route = "/__other";
            }
            const started = process.hrtime.bigint();
            const activeLabels = { "http.request.method": method, "http.route": route };
            activeRequests.add(1, activeLabels);
            const span = tracer.startSpan(`${method} ${route}`, { kind: SpanKind.SERVER, attributes: { "http.request.method": method, "http.route": route } }, validatedRemoteParent(request));
            let ended = false;
            const end = (outcome) => {
                if (ended)
                    return;
                ended = true;
                const status = outcome === "abort" && !response.headersSent ? null
                    : outcome === "error" && !response.headersSent ? 500
                        : Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : 500;
                const labels = { ...activeLabels, "http.response.status_code": status === null ? "none" : `${Math.floor(status / 100)}xx`, "sporades.http.outcome": outcome };
                requestCount.add(1, labels);
                requestDuration.record(Number(process.hrtime.bigint() - started) / 1e9, labels);
                activeRequests.add(-1, activeLabels);
                if (status !== null)
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
                const result = runtimeRequestScope.run({ requestId: randomUUID(), span }, handle);
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
            gcObserver.disconnect();
            loopDelay.disable();
            await Promise.race([Promise.allSettled([provider.shutdown(), meterProvider.shutdown()]), new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref(); })]);
        },
    };
}
//# sourceMappingURL=runtime-telemetry.js.map