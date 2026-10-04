import type { RuntimeTelemetryConfig } from "../runtime-telemetry.js";
type Connection = {
    exportsDisabled?: boolean;
    tracePropagationOrigins?: string[];
    internalEndpoint: string;
    metricsIntervalMs?: number;
    eventLoopDelayResolutionMs?: number;
} | null;
type Capsule = {
    domain: string;
    subname: string;
    telemetry?: {
        disabled?: boolean;
    };
};
/** A Host-owned launch decision; project config and Server env never supply these fields. */
export declare function hostedTelemetryConfig(connection: Connection, capsule: Capsule): RuntimeTelemetryConfig | null;
export declare function hostedTelemetryCoverage(desired: boolean, running: boolean, runtime: {
    supported: boolean;
    enabled: boolean;
    serviceName?: string;
    configHash?: string;
} | null, expectedServiceName?: string, expectedConfigHash?: string): {
    state: string;
    restartRequired: boolean;
} | {
    state: string;
    restartRequired: null;
};
export {};
//# sourceMappingURL=hosted-telemetry-coverage.d.ts.map