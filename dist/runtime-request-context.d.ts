import { AsyncLocalStorage } from "node:async_hooks";
import type { Span, Tracer } from "@opentelemetry/api";
/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export type RuntimeOperation = "sporades.auth.session.resolve" | "sporades.auth.access_key.resolve" | "sporades.auth.admit" | "sporades.file.authorize" | "sporades.file.upload.prepare" | "sporades.file.upload" | "sporades.file.private_url" | "sporades.file.public_url.create" | "sporades.file.public_url.revoke" | "sporades.file.delete" | "sporades.file.read" | "sporades.file.bytes.write" | "sporades.file.bytes.delete" | "sporades.file.stream" | "sporades.file.ingress.stage";
export type RuntimeOperationOutcome = "success" | "denied" | "error" | "cancelled";
export type RuntimeOperationRunner = <T>(operation: RuntimeOperation, callback: () => T, outcome?: (result: Awaited<T>) => RuntimeOperationOutcome) => T;
export declare const runtimeRequestScope: AsyncLocalStorage<{
    requestId: string;
    span?: Span;
    operation?: RuntimeOperationRunner;
    tracer?: Tracer;
    isOpen?: () => boolean;
}>;
/** Internal runtime boundary: no request/exporter means the original callback alone runs. */
export declare function traceRuntimeOperation<T>(operation: RuntimeOperation, callback: () => T, outcome?: (result: Awaited<T>) => RuntimeOperationOutcome): T;
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