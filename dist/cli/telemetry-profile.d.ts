import type { RuntimeTelemetryConfig } from "../runtime-telemetry.js";
export type TelemetryProfile = {
    endpoint: string;
    dashboard?: string;
    tls: {
        mode: "verified" | "loopback";
        caFile?: string;
    };
    credentialEnv?: string;
};
export declare function validateTelemetryProjectConfig(value: unknown): void;
export declare function validateTelemetryProfile(value: unknown): TelemetryProfile;
export declare function readTelemetryProfiles(): Promise<Record<string, TelemetryProfile>>;
export declare function changeTelemetryProfile(operation: "add" | "remove", name: string, profile?: TelemetryProfile): Promise<TelemetryProfile | null>;
export declare function resolveLocalTelemetryConfig(config: {
    name?: string;
    telemetry?: {
        profile?: string;
    };
}, sessionProfile?: string | null): Promise<RuntimeTelemetryConfig | null>;
/** Docker loopback is the Capsule itself; route an explicitly local profile to its Host. */
export declare function resolveContainerTelemetryConfig(config: {
    name?: string;
    telemetry?: {
        profile?: string;
    };
}, sessionProfile?: string | null): Promise<RuntimeTelemetryConfig | null>;
//# sourceMappingURL=telemetry-profile.d.ts.map