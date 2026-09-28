export type HostRelayConnection = {
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
}): string;
export declare function readHostTelemetryConnection(remoteRoot: string): Promise<{
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
    connected: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function connectHostTelemetryRelay(remoteRoot: string, network: string, input: unknown): Promise<{
    eventLoopDelayResolutionMs?: number | undefined;
    metricsIntervalMs?: number | undefined;
    endpoint?: string | undefined;
    internalEndpoint?: string | undefined;
    network?: string | undefined;
    caConfigured?: boolean | undefined;
    connectedAt?: string | undefined;
    connected: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function reconcileHostTelemetryRelay(remoteRoot: string): Promise<{
    eventLoopDelayResolutionMs?: number | undefined;
    metricsIntervalMs?: number | undefined;
    endpoint?: string | undefined;
    internalEndpoint?: string | undefined;
    network?: string | undefined;
    caConfigured?: boolean | undefined;
    connectedAt?: string | undefined;
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