import type { IncomingMessage, ServerResponse } from "node:http";
import type { Span } from "@opentelemetry/api";
export type RuntimeTelemetryConfig = {
    endpoint: string;
    tls: {
        mode: "verified" | "loopback";
        caFile?: string;
    };
    credentialEnv?: string;
    serviceName: string;
    samplingRatio?: number;
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
export declare function createHttpRequestTelemetry(config?: RuntimeTelemetryConfig | null, onDiagnostic?: (diagnostic: TelemetryExportDiagnostic) => void | Promise<void>): {
    run: (_request: IncomingMessage, _response: ServerResponse, _endpoints: readonly EndpointLike[], handle: () => unknown) => unknown;
    shutdown: () => Promise<void>;
};
export {};
//# sourceMappingURL=runtime-telemetry.d.ts.map