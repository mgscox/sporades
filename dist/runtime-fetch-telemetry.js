import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { runtimeRequestScope } from "./runtime-request-context.js";
const fetchStateKey = Symbol.for("sporades.runtime.fetch-telemetry.v1");
/** Shared across generated Bundles: dispatch to exactly one active request owner. */
export function installRuntimeFetchTelemetry() {
    const globals = globalThis;
    let state = globals[fetchStateKey];
    if (!state) {
        const original = globalThis.fetch;
        state = { original, wrapper: original, owners: new Set() };
        const current = state;
        const invoke = (input, init) => current.original.call(globalThis, input, init);
        state.wrapper = function (input, init) {
            for (const owner of current.owners) {
                const call = owner();
                if (call)
                    return call(invoke, input, init);
            }
            return invoke(input, init);
        };
        globals[fetchStateKey] = state;
        globalThis.fetch = state.wrapper;
    }
    const owner = () => runtimeRequestScope.getStore()?.outboundFetch;
    state.owners.add(owner);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        state.owners.delete(owner);
        if (state.owners.size === 0) {
            if (globalThis.fetch === state.wrapper)
                globalThis.fetch = state.original;
            delete globals[fetchStateKey];
        }
    };
}
/** Native fetch latency ends at response headers; response body ownership stays with callers. */
export function outboundFetchTelemetry(tracer, parent, origins, active) {
    return async (original, input, init) => {
        if (!active())
            return original(input, init);
        let url;
        let request;
        let method;
        let signal;
        let redirect;
        try {
            request = input instanceof Request ? input : undefined;
            if (!request && typeof input !== "string" && !(input instanceof URL))
                return original(input, init);
            url = new URL(request ? request.url : String(input));
            if (!["http:", "https:"].includes(url.protocol))
                return original(input, init);
            const rawMethod = init?.method ?? request?.method ?? "GET";
            method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(rawMethod.toUpperCase()) ? rawMethod.toUpperCase() : "_OTHER";
            signal = init?.signal === undefined ? request?.signal : init.signal;
            redirect = init?.redirect ?? request?.redirect ?? "follow";
        }
        catch {
            return original(input, init);
        }
        const span = tracer.startSpan(`HTTP ${method}`, {
            kind: SpanKind.CLIENT, attributes: { "http.request.method": method },
        }, trace.setSpan(ROOT_CONTEXT, parent));
        let forwarded = init;
        // Following redirects can carry a custom traceparent across origins. Only propagate
        // when the caller already chose manual/error; never change its redirect semantics.
        if (origins.has(url.origin) && (redirect === "manual" || redirect === "error")) {
            const context = span.spanContext();
            if (/^[0-9a-f]{32}$/.test(context.traceId) && !/^0+$/.test(context.traceId) && /^[0-9a-f]{16}$/.test(context.spanId) && !/^0+$/.test(context.spanId)) {
                try {
                    const headers = new Headers(init?.headers === undefined ? request?.headers : init.headers);
                    headers.set("traceparent", `00-${context.traceId}-${context.spanId}-${context.traceFlags & TraceFlags.SAMPLED ? "01" : "00"}`);
                    forwarded = { ...init, headers };
                }
                catch { /* Invalid caller input must retain native fetch's rejection. */ }
            }
        }
        try {
            const response = await original(input, forwarded);
            span.setAttribute("http.response.status_code", response.status);
            span.setAttribute("sporades.http.outcome", response.status >= 400 ? "failure" : "success");
            if (response.status >= 400)
                span.setStatus({ code: SpanStatusCode.ERROR });
            return response;
        }
        catch (error) {
            let outcome = "network_error";
            try {
                if (signal?.aborted) {
                    outcome = "cancelled";
                    if (signal.reason?.name === "TimeoutError")
                        outcome = "timeout";
                }
            }
            catch { /* Invalid signals and caller-owned abort reasons are opaque. */ }
            span.setAttribute("sporades.http.outcome", outcome);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        }
        finally {
            span.end();
        }
    };
}
//# sourceMappingURL=runtime-fetch-telemetry.js.map