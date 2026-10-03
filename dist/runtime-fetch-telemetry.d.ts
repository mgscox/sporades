import type { Span, Tracer } from "@opentelemetry/api";
type FetchCall = (original: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) => ReturnType<typeof fetch>;
/** Shared across generated Bundles: dispatch to exactly one active request owner. */
export declare function installRuntimeFetchTelemetry(): () => void;
/** Native fetch latency ends at response headers; response body ownership stays with callers. */
export declare function outboundFetchTelemetry(tracer: Tracer, parent: Span, origins: ReadonlySet<string>, active: () => boolean): FetchCall;
export {};
//# sourceMappingURL=runtime-fetch-telemetry.d.ts.map