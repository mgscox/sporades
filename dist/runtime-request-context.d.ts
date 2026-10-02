import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "@opentelemetry/api";
/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export declare const runtimeRequestScope: AsyncLocalStorage<{
    requestId: string;
    span?: Span;
    outboundFetch?: (original: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) => ReturnType<typeof fetch>;
}>;
/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export declare function withoutRuntimeRequestIdentity<T>(callback: () => T): T;
//# sourceMappingURL=runtime-request-context.d.ts.map