import { type HostMetrics } from "./host-metrics.js";
export type HostRelayConnection = {
    tracePropagationOrigins?: string[];
    endpoint: string;
    credential: string;
    caPem?: string;
    metricsIntervalMs?: number;
    eventLoopDelayResolutionMs?: number;
};
export declare function validateHostRelayConnection(value: unknown): HostRelayConnection;
export declare function renderHostRelayCollectorConfig(options: {
    endpoint: string;
    caFile: boolean;
    resources?: HostMetrics | null;
}): string;
export declare function readHostTelemetryConnection(remoteRoot: string): Promise<{
    tracePropagationOrigins?: string[];
    schemaVersion: 1;
    endpoint: string;
    network: string;
    internalEndpoint: string;
    caConfigured: boolean;
    connectedAt: string;
    metricsIntervalMs?: number;
    eventLoopDelayResolutionMs?: number;
} | null>;
export declare function statusHostTelemetryRelay(remoteRoot: string): Promise<{
    eventLoopDelayResolutionMs?: number | undefined;
    metricsIntervalMs?: number | undefined;
    endpoint?: string | undefined;
    internalEndpoint?: string | undefined;
    network?: string | undefined;
    caConfigured?: boolean | undefined;
    connectedAt?: string | undefined;
    tracePropagationOrigins?: string[] | undefined;
    resources: {
        configured: boolean;
        enabled: boolean;
        backendVerification: string;
        host?: undefined;
        exporterRunning?: undefined;
        psi?: undefined;
    } | {
        configured: boolean;
        enabled: boolean;
        host: string;
        exporterRunning: boolean;
        psi: string;
        backendVerification: string;
    };
    connected: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function connectHostTelemetryRelay(remoteRoot: string, network: string, input: unknown, host?: string): Promise<{
    eventLoopDelayResolutionMs?: number | undefined;
    metricsIntervalMs?: number | undefined;
    endpoint?: string | undefined;
    internalEndpoint?: string | undefined;
    network?: string | undefined;
    caConfigured?: boolean | undefined;
    connectedAt?: string | undefined;
    tracePropagationOrigins?: string[] | undefined;
    resources: {
        configured: boolean;
        enabled: boolean;
        backendVerification: string;
        host?: undefined;
        exporterRunning?: undefined;
        psi?: undefined;
    } | {
        configured: boolean;
        enabled: boolean;
        host: string;
        exporterRunning: boolean;
        psi: string;
        backendVerification: string;
    };
    connected: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function reconcileHostTelemetryRelay(remoteRoot: string, host?: string, operation?: "reconcile" | "enable" | "disable" | "remove"): Promise<{
    eventLoopDelayResolutionMs?: number | undefined;
    metricsIntervalMs?: number | undefined;
    endpoint?: string | undefined;
    internalEndpoint?: string | undefined;
    network?: string | undefined;
    caConfigured?: boolean | undefined;
    connectedAt?: string | undefined;
    tracePropagationOrigins?: string[] | undefined;
    resources: {
        configured: boolean;
        enabled: boolean;
        backendVerification: string;
        host?: undefined;
        exporterRunning?: undefined;
        psi?: undefined;
    } | {
        configured: boolean;
        enabled: boolean;
        host: string;
        exporterRunning: boolean;
        psi: string;
        backendVerification: string;
    };
    connected: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function checkHostTelemetryDelivery(remoteRoot: string): Promise<{
    origin: string;
    traceId: string;
    relayReady: boolean;
    relayAccepted: boolean;
    backendStorage: string;
    capsuleCoverage: string;
    stage: string;
    accepted: boolean;
    statusCode?: number;
}>;
//# sourceMappingURL=host-telemetry-relay.d.ts.map