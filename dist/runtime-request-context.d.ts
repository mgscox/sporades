import { AsyncLocalStorage } from "node:async_hooks";
import type { Span, Tracer } from "@opentelemetry/api";
/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export declare const runtimeRequestScope: AsyncLocalStorage<{
    requestId: string;
    span?: Span;
    tracer?: Tracer;
    isOpen?: () => boolean;
}>;
/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export declare function withoutRuntimeRequestIdentity<T>(callback: () => T): T;
/** Attempt context is separate from HTTP identity; Job logs never inherit a request. */
export declare const runtimeJobScope: AsyncLocalStorage<{
    span: Span;
    isOpen: () => boolean;
}>;
/** Persist only W3C v00 IDs and one sampling bit, never tracestate or baggage. */
export declare function captureJobTraceContext(): string | null;
//# sourceMappingURL=runtime-request-context.d.ts.map