import type { HostHelperHost } from "./hosted-capsule-contract.js";
export declare const OBSERVABILITY_IMAGES: Readonly<{
    glitchtip: "glitchtip/glitchtip:v5.2.1";
    umami: "ghcr.io/umami-software/umami:postgresql-v2.20.2";
    postgres: "postgres:16.10-alpine";
    valkey: "valkey/valkey:8.1.3-alpine";
}>;
export declare const OBSERVABILITY_MINIMUM: Readonly<{
    cpus: 2;
    memoryBytes: number;
    freeDiskBytes: number;
}>;
type State = {
    version: 1;
    enabled: boolean;
    ready: boolean;
    disclosed: boolean;
    secrets: {
        database: string;
        umamiDatabase: string;
        django: string;
        app: string;
        errorsPassword: string;
        analyticsPassword: string;
        token: string;
    };
};
export type ObservabilityTarget = {
    domain: string;
    subname: string;
    publicKey: string;
    errors: boolean;
    analytics: boolean;
};
export declare const OBSERVABILITY_ROUTE_FILE = "__sporades-observability.caddy";
export declare function renderObservabilityRoutes(host: HostHelperHost, ports: {
    errors: number;
    analytics: number;
} | null): string;
export declare function observabilityDirectory(host: HostHelperHost): string;
export declare function observabilityProject(host: HostHelperHost): string;
export declare function readObservabilityState(host: HostHelperHost): Promise<State | null>;
export declare function assertObservabilityResources(cpus: number, memoryBytes: number, freeDiskBytes: number): void;
export declare function observabilityCompose(host: HostHelperHost, state: State): {
    name: string;
    services: {
        "errors-db": {
            image: "postgres:16.10-alpine";
            environment: {
                POSTGRES_USER: string;
                POSTGRES_DB: string;
                POSTGRES_PASSWORD: string;
            };
            volumes: string[];
            healthcheck: {
                test: string[];
                interval: string;
                timeout: string;
                retries: number;
            };
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
        "analytics-db": {
            image: "postgres:16.10-alpine";
            environment: {
                POSTGRES_USER: string;
                POSTGRES_DB: string;
                POSTGRES_PASSWORD: string;
            };
            volumes: string[];
            healthcheck: {
                test: string[];
                interval: string;
                timeout: string;
                retries: number;
            };
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
        valkey: {
            image: "valkey/valkey:8.1.3-alpine";
            command: string[];
            cap_drop: string[];
            user: string;
            read_only: boolean;
            tmpfs: string[];
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
        web: {
            image: "glitchtip/glitchtip:v5.2.1";
            environment: {
                DATABASE_URL: string;
                REDIS_URL: string;
                SECRET_KEY: string;
                GLITCHTIP_DOMAIN: string;
                CSRF_TRUSTED_ORIGINS: string;
                ALLOWED_HOSTS: string;
                DEFAULT_FROM_EMAIL: string;
                EMAIL_URL: string;
                ENABLE_USER_REGISTRATION: string;
                ENABLE_SOCIAL_APPS_USER_REGISTRATION: string;
                ENABLE_ORGANIZATION_CREATION: string;
                PORT: string;
                UWSGI_WORKERS: string;
                CELERY_WORKER_CONCURRENCY: string;
                CELERY_WORKER_POOL: string;
            };
            depends_on: {
                "errors-db": {
                    condition: string;
                };
                valkey: {
                    condition: string;
                };
            };
            volumes: string[];
            ports: string[];
            cap_drop: string[];
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
        worker: {
            image: "glitchtip/glitchtip:v5.2.1";
            environment: {
                SERVER_ROLE: string;
                DATABASE_URL: string;
                REDIS_URL: string;
                SECRET_KEY: string;
                GLITCHTIP_DOMAIN: string;
                CSRF_TRUSTED_ORIGINS: string;
                ALLOWED_HOSTS: string;
                DEFAULT_FROM_EMAIL: string;
                EMAIL_URL: string;
                ENABLE_USER_REGISTRATION: string;
                ENABLE_SOCIAL_APPS_USER_REGISTRATION: string;
                ENABLE_ORGANIZATION_CREATION: string;
                PORT: string;
                UWSGI_WORKERS: string;
                CELERY_WORKER_CONCURRENCY: string;
                CELERY_WORKER_POOL: string;
            };
            depends_on: {
                "errors-db": {
                    condition: string;
                };
                valkey: {
                    condition: string;
                };
            };
            volumes: string[];
            cap_drop: string[];
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
        umami: {
            image: "ghcr.io/umami-software/umami:postgresql-v2.20.2";
            environment: {
                DATABASE_URL: string;
                DATABASE_TYPE: string;
                APP_SECRET: string;
                DISABLE_TELEMETRY: string;
            };
            depends_on: {
                "analytics-db": {
                    condition: string;
                };
            };
            ports: string[];
            cap_drop: string[];
            init: boolean;
            restart: string;
            security_opt: string[];
            logging: {
                driver: string;
                options: {
                    "max-size": string;
                    "max-file": string;
                };
            };
        };
    };
    volumes: {
        "glitchtip-db": {};
        "umami-db": {};
        uploads: {};
    };
};
export declare function observabilityDocker(host: HostHelperHost, args: string[], input?: string | Buffer, maxBuffer?: number): Buffer<ArrayBufferLike>;
export declare function observabilityPort(host: HostHelperHost, service: "web" | "umami"): number;
export declare function enableObservability(host: HostHelperHost, applyRoutes: (ports: {
    errors: number;
    analytics: number;
}) => Promise<void>): Promise<{
    credentials?: {
        errors: {
            username: string;
            password: string;
        };
        analytics: {
            username: string;
            password: string;
        };
    } | undefined;
    enabled: boolean;
    ready: boolean;
    urls: {
        errors: string;
        analytics: string;
    };
}>;
export declare function observabilityUrls(host: HostHelperHost): {
    errors: string;
    analytics: string;
};
export declare function disableObservability(host: HostHelperHost, applyRoutes: () => Promise<void>, uninstall?: boolean): Promise<{
    enabled: boolean;
    installed: boolean;
    dataRetained?: undefined;
    credentialsRetained?: undefined;
    uninstalled?: undefined;
} | {
    enabled: boolean;
    dataRetained: boolean;
    credentialsRetained: boolean;
    uninstalled: boolean;
    installed?: undefined;
}>;
export declare function statusObservability(host: HostHelperHost): Promise<{
    installed: boolean;
    enabled: boolean;
    ready?: undefined;
    healthy?: undefined;
    urls?: undefined;
    images?: undefined;
} | {
    installed: boolean;
    enabled: boolean;
    ready: boolean;
    healthy: boolean;
    urls: {
        errors: string;
        analytics: string;
    };
    images: Readonly<{
        glitchtip: "glitchtip/glitchtip:v5.2.1";
        umami: "ghcr.io/umami-software/umami:postgresql-v2.20.2";
        postgres: "postgres:16.10-alpine";
        valkey: "valkey/valkey:8.1.3-alpine";
    }>;
}>;
export declare function provisionObservability(host: HostHelperHost, target: ObservabilityTarget): Promise<{
    connected: boolean;
    reason: string;
    identity?: undefined;
    env?: undefined;
} | {
    connected: boolean;
    identity: string;
    env: import("../sealed-server-env.js").SealedServerEnvEnvelope;
    reason?: undefined;
}>;
export declare function publishObservabilityMetric(host: HostHelperHost, up: number, enabled?: boolean): Promise<void>;
export declare function backupObservability(host: HostHelperHost): Promise<{
    id: any;
    createdAt: string;
}>;
export declare function listObservabilityBackups(host: HostHelperHost): Promise<{
    snapshots: {
        id: string;
        time: string;
        tags: string[];
    }[];
}>;
export declare function pruneObservabilityBackups(host: HostHelperHost): Promise<{
    retentionDays?: number | undefined;
    pruned: boolean;
    retention: number;
}>;
export declare function restoreObservability(host: HostHelperHost, id: string | undefined, confirm: string | undefined): Promise<{
    restored: boolean;
    id: string;
    enabled: boolean;
    enableRequired: boolean;
}>;
export declare function observabilityMonitorUnits(host: HostHelperHost): {
    name: string;
    service: string;
    timer: string;
};
export declare function installObservabilityMonitor(host: HostHelperHost, enabled: boolean, directory?: string): Promise<void>;
export {};
//# sourceMappingURL=host-observability.d.ts.map