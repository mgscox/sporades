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
import { runtimeJobScope, runtimeRequestScope, withoutRuntimeRequestIdentity } from "./runtime-request-context.js";
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
function validatedRemoteParentValue(value) {
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
function validatedRemoteParent(request) {
    return validatedRemoteParentValue(request.headers.traceparent);
}
const disabledWebSocketOperation = {
    run: withoutRuntimeRequestIdentity,
    end: () => { },
};
const disabledWebSocketTelemetry = {
    connectionOpened: () => () => { },
    startOperation: () => disabledWebSocketOperation,
};
function exportFailureReason(error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === 401 || code === 403)
        return "AUTH_REJECTED";
    if (typeof code === "string") {
        if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code))
            return "DESTINATION_UNAVAILABLE";
        if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.startsWith("CERT_") || [
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
            "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "INVALID_CA",
            "EPROTO",
        ].includes(code))
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
        return { websocket: disabledWebSocketTelemetry, bindJobQueue: (_database) => { }, run: (_request, _response, _endpoints, handle) => runtimeRequestScope.run({ requestId: randomUUID() }, handle), shutdown: async () => { } };
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
    const httpAgentOptions = { ...(config.tls.caFile ? { ca: readFileSync(config.tls.caFile) } : {}), rejectUnauthorized: true, keepAlive: false };
    const compression = "none";
    const { trace: exporter, metrics: metricExporter } = createProfileExporters({
        // Shutdown may flush four queued 32-span batches beside one scheduled batch.
        url: endpoint, headers, compression, timeoutMillis: 600, concurrencyLimit: 5, httpAgentOptions: { ...httpAgentOptions, maxSockets: 5 },
    }, {
        url: new URL("/v1/metrics", url).toString(), headers, compression, temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
        timeoutMillis: 600, concurrencyLimit: 1, httpAgentOptions: { ...httpAgentOptions, maxSockets: 1 },
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
        // Inventory and Host readiness use the full identity. Truncating it can
        // both lose healthy targets and merge unrelated Capsules with a shared prefix.
        "service.name": config.serviceName,
        "service.instance.id": processInstanceId,
        "deployment.environment.name": config.environment ?? "unknown",
    });
    const meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
        views: [
            { instrumentName: "sporades.job.execution.duration", aggregationCardinalityLimit: 1024, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300] } } },
            { instrumentName: "sporades.job.retry.count", aggregationCardinalityLimit: 129 },
            { instrumentName: "sporades.job.failure.count", aggregationCardinalityLimit: 129 },
            { instrumentName: "http.server.request.count", aggregationCardinalityLimit: 512 },
            { instrumentName: "http.server.active_requests", aggregationCardinalityLimit: 128 },
            { instrumentName: "http.server.request.duration", aggregationCardinalityLimit: 512, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] } } },
            { instrumentName: "sporades.websocket.operation.count", aggregationCardinalityLimit: 1024 },
            { instrumentName: "sporades.websocket.operation.duration", aggregationCardinalityLimit: 1024, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] } } },
        ],
    });
    const meter = meterProvider.getMeter("sporades-runtime-http", "1");
    const requestCount = meter.createCounter("http.server.request.count", { unit: "1" });
    const requestDuration = meter.createHistogram("http.server.request.duration", { unit: "s" });
    const activeRequests = meter.createUpDownCounter("http.server.active_requests", { unit: "1" });
    const websocketMeter = meterProvider.getMeter("sporades-runtime-websocket", "1");
    const websocketCount = websocketMeter.createCounter("sporades.websocket.operation.count", { unit: "1" });
    const websocketDuration = websocketMeter.createHistogram("sporades.websocket.operation.duration", { unit: "s" });
    let connectionCount = 0;
    websocketMeter.createObservableGauge("sporades.websocket.active_connections", { unit: "1" })
        .addCallback(result => result.observe(connectionCount));
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
    const delayResolutionMs = config.eventLoopDelayResolutionMs ?? 20;
    const loopDelay = monitorEventLoopDelay({ resolution: delayResolutionMs });
    loopDelay.enable();
    let lastDelayResetAt = performance.now();
    let delayMonitorStoppedAt;
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
    processMeter.addBatchObservableCallback(async (result) => {
        // A resumed collection timer may run before the delay monitor's overdue tick.
        // Yield once so that tick can record the stall before this window is reset.
        await new Promise((resolve) => setImmediate(resolve));
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
        const rawMaxMs = loopDelay.count > 0 ? loopDelay.max / 1e6 : 0;
        const elapsedMs = Math.max(0, (delayMonitorStoppedAt ?? performance.now()) - lastDelayResetAt);
        // Reset drops the first monitor interval. The unrecorded time can lie at
        // either edge of this window, so half its lower bound belongs to at least
        // one edge. Histogram max bounds each recorded interval from above.
        const unrecordedMaxLowerBoundMs = Math.max(0, (elapsedMs - loopDelay.count * rawMaxMs) / 2 - delayResolutionMs);
        if (loopDelay.count > 0 || unrecordedMaxLowerBoundMs > 0) {
            result.observe(delayMax, Math.max(0, rawMaxMs - delayResolutionMs, unrecordedMaxLowerBoundMs));
        }
        if (loopDelay.count > 0) {
            result.observe(delayMean, Math.max(0, loopDelay.mean / 1e6 - delayResolutionMs));
            result.observe(delayP99, Math.max(0, loopDelay.percentile(99) / 1e6 - delayResolutionMs));
        }
        loopDelay.reset();
        lastDelayResetAt = delayMonitorStoppedAt ?? performance.now();
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
    const websocketTracer = provider.getTracer("sporades-runtime-websocket", "1");
    const websocketNames = new Set();
    const websocketEnds = new Set();
    let closing = false;
    const websocket = {
        connectionOpened() {
            if (closing)
                return () => { };
            connectionCount++;
            let closed = false;
            return () => { if (!closed) {
                closed = true;
                connectionCount--;
            } };
        },
        startOperation(type, rawName, declared, traceparent) {
            if (closing)
                return disabledWebSocketOperation;
            let name = declared && typeof rawName === "string" && /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,79}$/.test(rawName) ? rawName : "__unknown";
            if (!websocketNames.has(name)) {
                if (websocketNames.size < 64)
                    websocketNames.add(name);
                else
                    name = "__other";
            }
            const labels = { "sporades.websocket.operation.type": type, "sporades.websocket.operation.name": name };
            const started = process.hrtime.bigint();
            let span;
            try {
                span = websocketTracer.startSpan(`websocket.${type}`, { kind: SpanKind.SERVER, attributes: labels }, validatedRemoteParentValue(traceparent));
            }
            catch { /* Metrics and business work remain independent of trace creation. */ }
            let ended = false;
            const end = (outcome) => {
                if (ended)
                    return;
                ended = true;
                websocketEnds.delete(end);
                const terminalLabels = { ...labels, "sporades.websocket.outcome": outcome };
                try {
                    websocketCount.add(1, terminalLabels);
                }
                catch { }
                try {
                    websocketDuration.record(Number(process.hrtime.bigint() - started) / 1e9, terminalLabels);
                }
                catch { }
                try {
                    span?.setAttribute("sporades.websocket.outcome", outcome);
                    if (outcome !== "success")
                        span?.setStatus({ code: SpanStatusCode.ERROR });
                    span?.end();
                }
                catch { /* Telemetry cannot change operation settlement. */ }
            };
            websocketEnds.add(end);
            const scope = { requestId: randomUUID(), span, tracer: websocketTracer, isOpen: () => !ended && !closing };
            return { run: handle => runtimeRequestScope.run(scope, handle), end };
        },
    };
    const jobMeter = meterProvider.getMeter("sporades-runtime-jobs", "1");
    const jobDuration = jobMeter.createHistogram("sporades.job.execution.duration", { unit: "s" });
    const jobRetries = jobMeter.createCounter("sporades.job.retry.count", { unit: "1" });
    const jobFailures = jobMeter.createCounter("sporades.job.failure.count", { unit: "1" });
    const queueDepth = jobMeter.createObservableGauge("sporades.job.queue.depth", { unit: "1" });
    const queueAge = jobMeter.createObservableGauge("sporades.job.queue.oldest_pending_age", { unit: "s" });
    let jobQueueDatabase;
    let reading = false;
    const seenJobNames = new Set();
    jobMeter.addBatchObservableCallback(async (result) => {
        const database = jobQueueDatabase;
        if (!database || reading || closing || database.__jobStopped)
            return;
        reading = true;
        try {
            // One aggregate query per export, never one query/allocation per request or Job.
            // A failed read omits the observation rather than reporting a healthy zero.
            const row = await withoutRuntimeRequestIdentity(() => database.adapter.prepare(database.adapter.dialect.sql("SELECT COUNT(*) AS [depth], MIN([createdAt]) AS [oldest] FROM [sporades_jobs] WHERE [status] IN ('queued', 'delayed')")).get());
            if (closing || database.__jobStopped || jobQueueDatabase !== database)
                return;
            const depth = Number(row?.depth);
            const oldest = row?.oldest == null ? null : Date.parse(row.oldest);
            if (!Number.isSafeInteger(depth) || depth < 0 || (depth > 0 && (oldest === null || !Number.isFinite(oldest))))
                return;
            result.observe(queueDepth, depth);
            result.observe(queueAge, oldest === null ? 0 : Math.max(0, (database.clock.now().getTime() - oldest) / 1000));
        }
        catch { /* A monitoring read cannot stop the worker or its transactions. */ }
        finally {
            reading = false;
        }
    }, [queueDepth, queueAge]);
    return {
        websocket,
        /** Internal generated-runtime seam. Only declared names can become labels. */
        bindJobQueue(database) {
            const names = new Set();
            for (const job of database.jobs ?? []) {
                if (names.size >= 128)
                    break;
                if (typeof job.name === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(job.name)
                    && (seenJobNames.has(job.name) || seenJobNames.size < 128)) {
                    names.add(job.name);
                    seenJobNames.add(job.name);
                }
            }
            jobQueueDatabase = database;
            const transition = (name, outcome) => {
                try {
                    const labels = { "sporades.job.handler": typeof name === "string" && names.has(name) ? name : "__other" };
                    if (outcome === "retry")
                        jobRetries.add(1, labels);
                    jobFailures.add(1, labels);
                }
                catch { /* Telemetry cannot affect a durable transition. */ }
            };
            database.__jobTelemetry = {
                transition,
                start(row) {
                    if (closing)
                        return undefined;
                    const handler = names.has(row.handler) ? row.handler : "__other";
                    const started = process.hrtime.bigint();
                    const labels = { "sporades.job.handler": handler };
                    let span;
                    try {
                        const value = row.enqueueTraceContext;
                        const match = typeof value === "string" && value.length === 55
                            ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-(00|01)$/.exec(value) : null;
                        const link = match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
                            ? { traceId: match[1], spanId: match[2], traceFlags: match[3] === "01" ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true } : undefined;
                        span = tracer.startSpan(`job ${handler}`, {
                            kind: SpanKind.CONSUMER,
                            attributes: { "sporades.job.handler": handler, "sporades.job.attempt": Number(row.attempts) + 1 },
                            ...(link ? { links: [{ context: link }] } : {}),
                        }, ROOT_CONTEXT);
                    }
                    catch { /* Metrics remain independent of trace creation. */ }
                    let ended = false;
                    return {
                        run(handle) {
                            return withoutRuntimeRequestIdentity(() => span ? runtimeJobScope.run({ span, isOpen: () => !ended && !closing }, handle) : handle());
                        },
                        end(outcome) {
                            if (ended)
                                return;
                            ended = true;
                            try {
                                jobDuration.record(Number(process.hrtime.bigint() - started) / 1e9, { ...labels, "sporades.job.outcome": outcome });
                                if (outcome === "failed" || outcome === "retry")
                                    transition(handler, outcome);
                            }
                            catch { /* Metrics cannot affect claim settlement. */ }
                            try {
                                span?.setAttribute("sporades.job.outcome", outcome);
                                if (outcome === "failed" || outcome === "retry")
                                    span?.setStatus({ code: SpanStatusCode.ERROR });
                                span?.end();
                            }
                            catch { /* Instrumentation cannot affect claim settlement. */ }
                        },
                    };
                },
            };
        },
        run(request, response, endpoints, handle) {
            if (closing || (request.method === "GET" && (request.url === "/__sporades/probe" || request.url?.startsWith("/__sporades/probe?"))))
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
            let operationBudget = 32;
            const activeOperations = new Set();
            const operation = (name, callback, resultOutcome) => {
                if (ended || !span.isRecording() || operationBudget === 0)
                    return callback();
                operationBudget--;
                const child = tracer.startSpan(name, { kind: SpanKind.INTERNAL }, trace.setSpan(ROOT_CONTEXT, span));
                let completed = false;
                const finish = (outcome) => {
                    if (completed)
                        return;
                    completed = true;
                    activeOperations.delete(finish);
                    child.setAttribute("sporades.operation.outcome", outcome);
                    if (outcome !== "success")
                        child.setStatus({ code: SpanStatusCode.ERROR });
                    child.end();
                };
                activeOperations.add(finish);
                const succeeded = (result) => {
                    let outcome = "success";
                    try {
                        outcome = resultOutcome?.(result) ?? "success";
                    }
                    catch { /* Observability cannot change results. */ }
                    finish(["success", "denied", "error", "cancelled"].includes(outcome) ? outcome : "error");
                    return result;
                };
                const failed = (error) => {
                    let outcome = "error";
                    // Never record exception text, stack, cause, arbitrary codes or actor/resource data.
                    try {
                        const code = error?.code;
                        if (["UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"].includes(code))
                            outcome = "denied";
                        else if (code === "ABORT_ERR" || error?.name === "AbortError")
                            outcome = "cancelled";
                    }
                    catch { /* Even hostile exception getters stay opaque. */ }
                    finish(outcome);
                    throw error;
                };
                try {
                    const result = callback();
                    return (result && typeof result.then === "function"
                        ? Promise.resolve(result).then(succeeded, failed) : succeeded(result));
                }
                catch (error) {
                    return failed(error);
                }
            };
            const end = (outcome) => {
                if (ended)
                    return;
                ended = true;
                for (const finish of activeOperations)
                    finish(outcome === "error" ? "error" : "cancelled");
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
                if (outcome === "error" || outcome === "abort")
                    span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            };
            response.once("finish", () => end(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "failure" : "success"));
            response.once("close", () => { if (!response.writableFinished)
                end("abort"); });
            response.once("error", () => end("error"));
            request.once("aborted", () => end("abort"));
            try {
                const result = runtimeRequestScope.run({ requestId: randomUUID(), span, operation, tracer, isOpen: () => !ended && !closing }, handle);
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
            for (const end of websocketEnds)
                end("cancelled");
            closing = true;
            gcObserver.disconnect();
            delayMonitorStoppedAt = performance.now();
            loopDelay.disable();
            await Promise.race([Promise.allSettled([provider.shutdown(), meterProvider.shutdown()]), new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref(); })]);
        },
    };
}
//# sourceMappingURL=runtime-telemetry.js.map