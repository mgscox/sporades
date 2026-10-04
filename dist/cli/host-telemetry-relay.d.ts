import { type TelemetryDeliveryChecks } from "./telemetry-diagnostics.js";
import { type HostMetrics } from "./host-metrics.js";
export type HostRelayConnection = {
    tracePropagationOrigins?: string[];
    endpoint: string;
    credential: string;
    inventoryCredential?: string;
    inventoryHost?: string;
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
    exportsDisabled?: boolean;
    schemaVersion: 1;
    endpoint: string;
    network: string;
    internalEndpoint: string;
    caConfigured: boolean;
    connectedAt: string;
    inventoryHost?: string;
    tracePropagationOrigins?: string[];
    metricsIntervalMs?: number;
    eventLoopDelayResolutionMs?: number;
} | null>;
export type HostInventoryConnection = {
    generation: string;
    endpoint: string;
    host: string;
    credential: string;
    caPem?: string;
};
/** Call only while holding withHostTelemetryLock; legacy split state needs it too. */
export declare function readHostInventoryConnection(remoteRoot: string): Promise<HostInventoryConnection | null>;
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
    exportsDisabled: boolean;
    connected: boolean;
    activationPending: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export declare function connectHostTelemetryRelay(remoteRoot: string, network: string, input: unknown, host?: string, expectedBinding?: string): Promise<{
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
    exportsDisabled: boolean;
    connected: boolean;
    activationPending: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
/** Host-owned inventory timer also repairs an interrupted activation. */
export declare function recoverHostTelemetryActivation(remoteRoot: string): Promise<void>;
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
    exportsDisabled: boolean;
    connected: boolean;
    activationPending: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
export type HostTelemetryDiagnostic = {
    origin: "host";
    accepted: boolean;
    stage: string;
    traceId?: string;
    relayTraceId?: string;
    relayReady: boolean;
    relayAccepted: boolean;
    backendStorage: string;
    checks: TelemetryDeliveryChecks;
    capsuleCoverage: string;
    statusCode?: number;
};
export declare function checkHostTelemetryDelivery(remoteRoot: string, queryCredential?: string): Promise<HostTelemetryDiagnostic>;
/** Verifies the destination on the actual Host before changing saved authority.
 * Old inventory is deliberately untouched: retiring its expectations is an
 * explicit Monitoring operator step, independent of retained trace history.
 */
export declare function migrateHostTelemetryRelay(remoteRoot: string, network: string, input: unknown, host: string, queryCredential?: string): Promise<{
    activation: string;
    rollback: string;
    origin: string;
    previousEndpoint: unknown;
    destination: {
        checks: {
            dns: import("./telemetry-diagnostics.js").DiagnosticCheck;
            tls: import("./telemetry-diagnostics.js").DiagnosticCheck;
            authentication: import("./telemetry-diagnostics.js").DiagnosticCheck;
            otlpAcceptance: import("./telemetry-diagnostics.js").DiagnosticCheck;
        };
        statusCode?: number | undefined;
        traceId: string;
        accepted: boolean;
        stage: string;
    };
    storage: {
        backendQuery: import("./telemetry-diagnostics.js").DiagnosticCheck;
        recentIngestion: import("./telemetry-diagnostics.js").DiagnosticCheck;
    };
    inventoryAuthority: import("./telemetry-diagnostics.js").DiagnosticCheck;
    relayRestarted: boolean;
    oldInventory: string;
    history: string;
} | {
    activation: string;
    relayRestarted: boolean;
    rollback: string;
    connection: {
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
        exportsDisabled: boolean;
        connected: boolean;
        activationPending: boolean;
        relayReady: boolean;
        capsuleCoverage: string;
        backendVerification: string;
    };
    origin: string;
    previousEndpoint: unknown;
    destination: {
        checks: {
            dns: import("./telemetry-diagnostics.js").DiagnosticCheck;
            tls: import("./telemetry-diagnostics.js").DiagnosticCheck;
            authentication: import("./telemetry-diagnostics.js").DiagnosticCheck;
            otlpAcceptance: import("./telemetry-diagnostics.js").DiagnosticCheck;
        };
        statusCode?: number | undefined;
        traceId: string;
        accepted: boolean;
        stage: string;
    };
    storage: {
        backendQuery: import("./telemetry-diagnostics.js").DiagnosticCheck;
        recentIngestion: import("./telemetry-diagnostics.js").DiagnosticCheck;
    };
    inventoryAuthority: import("./telemetry-diagnostics.js").DiagnosticCheck;
    oldInventory: string;
    history: string;
}>;
export type HostTelemetryMigration = Awaited<ReturnType<typeof migrateHostTelemetryRelay>>;
/** Durable opt-out keeps inventory authority and credentials for acknowledgement/recovery. */
export declare function disableHostTelemetryExports(remoteRoot: string, host: string): Promise<{
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
    exportsDisabled: boolean;
    connected: boolean;
    activationPending: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
/** Caller must first acknowledge the exact disabled inventory revision. */
export declare function removeHostTelemetryAgents(remoteRoot: string, host: string): Promise<{
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
    exportsDisabled: boolean;
    connected: boolean;
    activationPending: boolean;
    relayReady: boolean;
    capsuleCoverage: string;
    backendVerification: string;
}>;
//# sourceMappingURL=host-telemetry-relay.d.ts.map