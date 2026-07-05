import type { JsonObject } from "./host-helper-json.js";
export type HostTlsMode = "automatic" | "cloudflare-origin";
export type HostTlsConfig = JsonObject & {
    mode: HostTlsMode | string;
    certificateFile?: string | null;
    keyFile?: string | null;
};
export type HostHelperHost = JsonObject & {
    alias: string;
    server?: string;
    domain: string;
    scheme: string;
    remoteRoot: string;
    tls?: HostTlsConfig;
};
export type HostHelperCapsuleTarget = JsonObject & {
    subname: string;
};
export type HostedCapsuleBaseImage = JsonObject & {
    image?: string;
    name?: string;
    version?: string;
    updatePolicy?: unknown;
};
export type HostHelperSealedServerEnv = JsonObject & {
    publicKey?: string;
    publicKeyFingerprint?: string;
    publicKeyPath?: string;
    privateKey?: string;
    privateKeyPath?: string;
    currentKeyFingerprint?: string;
};
export type HostedCapsuleStatus = "registered" | "started" | "stopped" | "failed" | "unregistered";
export type HostedCapsuleReleaseState = "uploaded" | "starting" | "started" | "verified" | "failed" | "verification-failed";
export type HostedCapsuleReleaseEntry = JsonObject & {
    id: string;
    state: HostedCapsuleReleaseState | string;
    createdAt?: string;
    updatedAt?: string;
    current?: boolean;
};
export type HostedCapsuleRegistryRecord = JsonObject & {
    subname: string;
    domain: string;
    hostedUrl: string;
    remoteCapsuleId: string;
    status?: HostedCapsuleStatus | string;
    currentRelease?: {
        id: string;
    } | null;
    releases?: HostedCapsuleReleaseEntry[];
    sealedServerEnv?: HostHelperSealedServerEnv | null;
};
export type HostedCapsuleRoute = JsonObject & {
    url?: string;
    routeFile: string;
    previousRouteFile?: string;
    port?: number;
    containerName?: string;
    upstream?: string;
    accessLog?: string;
    log?: {
        file?: string;
    } | null;
    runtimeProbe?: RuntimeProbeCredential;
};
export type RuntimeProbeCredential = JsonObject & {
    header: string;
    token: string;
};
export type HostedCapsuleContainer = JsonObject & {
    name: string;
    image: string;
    network: string;
    user?: string;
    labels?: Record<string, string>;
    baseImage?: HostedCapsuleBaseImage;
};
export type HostedCapsuleMount = JsonObject & {
    host: string;
    container: string;
    mode: string;
    optional?: boolean;
    fingerprint?: string | null;
    source?: string;
    target?: string;
    readonly?: boolean;
};
export type HostedCapsuleLifecycle = JsonObject & {
    capsule?: HostHelperCapsuleTarget;
    host?: HostHelperHost;
    subname?: string;
    domain?: string;
    hostedUrl?: string;
    remoteCapsuleId?: string;
    currentLink?: string;
    remoteRoot: string;
    directories?: {
        capsule?: string;
        releases?: string;
        data?: string;
        logs?: string;
    };
    mounts: {
        files: HostedCapsuleMount[];
        data: HostedCapsuleMount;
        [key: string]: unknown;
    };
    container: HostedCapsuleContainer;
    routes: {
        running: HostedCapsuleRoute;
        unavailable: HostedCapsuleRoute;
    };
};
export type HostLifecycleOptions = JsonObject & Partial<Omit<HostedCapsuleLifecycle, "container" | "routes" | "mounts">> & {
    container?: Partial<HostedCapsuleContainer>;
    routes?: {
        running?: Partial<HostedCapsuleRoute>;
        unavailable?: Partial<HostedCapsuleRoute>;
        accessLog?: string;
    };
    mounts?: {
        files?: HostedCapsuleMount[];
        data?: HostedCapsuleMount;
        [key: string]: unknown;
    };
};
//# sourceMappingURL=hosted-capsule-contract.d.ts.map