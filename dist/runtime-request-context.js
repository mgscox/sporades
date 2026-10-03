import { AsyncLocalStorage } from "node:async_hooks";
/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export const runtimeRequestScope = new AsyncLocalStorage();
/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export function withoutRuntimeRequestIdentity(callback) {
    return runtimeRequestScope.exit(() => runtimeJobScope.exit(callback));
}
/** Attempt context is separate from HTTP identity; Job logs never inherit a request. */
export const runtimeJobScope = new AsyncLocalStorage();
/** Persist only W3C v00 IDs and one sampling bit, never tracestate or baggage. */
export function captureJobTraceContext() {
    try {
        const job = runtimeJobScope.getStore();
        const request = runtimeRequestScope.getStore();
        const span = job?.isOpen() ? job.span : request?.isOpen?.() ? request.span : undefined;
        const context = span?.spanContext();
        if (!context || !/^[0-9a-f]{32}$/.test(context.traceId) || /^0+$/.test(context.traceId)
            || !/^[0-9a-f]{16}$/.test(context.spanId) || /^0+$/.test(context.spanId))
            return null;
        return `00-${context.traceId}-${context.spanId}-${context.traceFlags & 1 ? "01" : "00"}`;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=runtime-request-context.js.map