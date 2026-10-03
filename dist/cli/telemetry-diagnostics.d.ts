import type { HostRelayConnection } from "./host-telemetry-relay.js";
export type DiagnosticCheck = {
    state: "passed" | "failed" | "unavailable" | "unsupported";
    reason?: string;
};
export type TelemetryDeliveryChecks = Record<"configuration" | "agentReadiness" | "dns" | "tls" | "authentication" | "otlpAcceptance" | "relayAcceptance" | "recentIngestion" | "backendQuery", DiagnosticCheck>;
export declare const unavailable: (reason: string) => DiagnosticCheck;
export declare const passed: () => DiagnosticCheck;
export declare const failed: (reason: string) => DiagnosticCheck;
export declare function validateQueryCredential(value: unknown): string | undefined;
export declare function diagnosticTrace(): {
    traceId: string;
    body: string;
};
/** Portable: also serialized into the Node diagnostic probe on the Host network. */
export declare function otlpTraceAccepted(data: unknown): boolean;
export declare function probeTelemetryDestination(connection: HostRelayConnection): Promise<{
    checks: {
        dns: DiagnosticCheck;
        tls: DiagnosticCheck;
        authentication: DiagnosticCheck;
        otlpAcceptance: DiagnosticCheck;
    };
    statusCode?: number | undefined;
    traceId: string;
    accepted: boolean;
    stage: string;
}>;
export declare function queryDiagnosticTrace(connection: Pick<HostRelayConnection, "endpoint" | "caPem">, traceId: string, queryCredential?: string): Promise<{
    backendQuery: DiagnosticCheck;
    recentIngestion: DiagnosticCheck;
}>;
export declare function probeInventoryDestination(connection: HostRelayConnection, host: string): Promise<DiagnosticCheck>;
//# sourceMappingURL=telemetry-diagnostics.d.ts.map