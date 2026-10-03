import type { IncomingMessage, ServerResponse } from "node:http";
import type { Span } from "@opentelemetry/api";
export type RuntimeTelemetryConfig = {
    tracePropagationOrigins?: string[];
    endpoint: string;
    tls: {
        mode: "verified" | "loopback";
        caFile?: string;
    };
    credentialEnv?: string;
    serviceName: string;
    samplingRatio?: number;
    environment?: "dev" | "container" | "hosted";
    metricsIntervalMs?: number;
    eventLoopDelayResolutionMs?: number;
};
export type TelemetryExportDiagnostic = {
    event: "telemetry.export.failed";
    reason: "AUTH_REJECTED" | "DESTINATION_UNAVAILABLE" | "TLS_FAILED" | "EXPORT_FAILED";
} | {
    event: "telemetry.export.recovered";
};
type RequestLike = Pick<IncomingMessage, "method" | "url">;
type EndpointLike = {
    method: string;
    path: string;
};
/** Only declared routes and explicit platform templates may become trace labels. */
export declare function resolveTelemetryRoute(request: RequestLike, endpoints: readonly EndpointLike[]): string;
/** Internal seam for later operation spans; no Capsule-facing API is exported. */
export declare function activeRuntimeRequestSpan(): Span | undefined;
/** Only runtime-created identities may be attached to the existing log envelope. */
export declare function activeRuntimeLogIdentity(): {
    requestId: string;
    traceId: string | null;
    spanId: string | null;
} | undefined;
export type WebSocketOperationOutcome = "success" | "denied" | "error" | "cancelled";
export type RuntimeWebSocketOperation = {
    run<T>(handle: () => T): T;
    end(outcome: WebSocketOperationOutcome): void;
};
export type RuntimeWebSocketTelemetry = {
    connectionOpened(): () => void;
    startOperation(type: "query" | "mutation", name: unknown, declared: boolean, traceparent?: unknown): RuntimeWebSocketOperation;
};
export declare function createHttpRequestTelemetry(config?: RuntimeTelemetryConfig | null, onDiagnostic?: (diagnostic: TelemetryExportDiagnostic) => void | Promise<void>): {
    websocket: RuntimeWebSocketTelemetry;
    bindJobQueue: (_database: any) => void;
    run: (_request: IncomingMessage, _response: ServerResponse, _endpoints: readonly EndpointLike[], handle: () => unknown) => unknown;
    shutdown: () => Promise<void>;
};
export {};
//# sourceMappingURL=runtime-telemetry.d.ts.map