export type JsonRecord = Record<string, unknown>;
export type DatabaseEngine = "libsql" | "postgres";
export type StorageEngine = "minio";
export type CapsuleServiceKind = "database" | "storage";
export type CapsuleServiceCredentials = {
    databaseUser: string;
    databasePassword: string;
    storageAccessKey: string;
    storageSecretKey: string;
};
export type CapsuleServiceOptions = {
    credentials?: Partial<CapsuleServiceCredentials>;
    publishPorts?: boolean;
};
export type DatabaseServiceDeclaration = {
    kind: "database";
    engine: DatabaseEngine;
};
export type StorageServiceDeclaration = {
    kind: "storage";
    engine: StorageEngine;
};
export type CapsuleServicesDeclaration = JsonRecord & {
    database?: DatabaseServiceDeclaration;
    storage?: StorageServiceDeclaration;
};
export type CapsuleProjectConfig = JsonRecord & {
    name?: unknown;
    services?: CapsuleServicesDeclaration;
};
export type CapsuleServiceBase = {
    kind: CapsuleServiceKind;
    name: string;
    engine: string;
    image: string;
    stateDir: string;
    targetPort: number;
    volumeTarget: string;
    environment: Record<string, string>;
    healthcheck: string[];
    command: string | null;
    labels: Record<string, string>;
};
export type CapsuleDatabaseService = CapsuleServiceBase & {
    kind: "database";
    engine: DatabaseEngine;
    user: string;
    password: string;
    databaseName: string;
};
export type CapsuleStorageService = CapsuleServiceBase & {
    kind: "storage";
    engine: StorageEngine;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    namespace: string;
};
export type CapsuleService = CapsuleDatabaseService | CapsuleStorageService;
export type CapsuleServices = {
    database?: CapsuleDatabaseService;
    storage?: CapsuleStorageService;
};
export type CapsuleServicesComposeModel = {
    projectSlug: string;
    composeProjectName: string;
    publishPorts: boolean;
    credentials: CapsuleServiceCredentials;
    services: CapsuleServices;
    networks: {
        services: string;
    };
    labels: Record<string, string>;
};
export type DatabaseEngineModel = {
    engine: DatabaseEngine;
    image: string;
    targetPort: number;
    volumeTarget: string;
    environment: Record<string, string>;
    healthcheck: string[];
};
export type WrittenCapsuleServicesCompose = CapsuleServicesComposeModel & {
    path: string;
    relativePath: string;
};
export declare const CAPSULE_SERVICES_COMPOSE_FILE: string;
export declare const CAPSULE_SERVICES_STATE_DIR: string;
export declare const CAPSULE_SERVICES_CREDENTIALS_FILE: string;
export declare function validateCapsuleServicesConfig(services: unknown): CapsuleServicesDeclaration | null;
export declare function writeCapsuleServicesCompose(projectDir: string, config: CapsuleProjectConfig, options?: CapsuleServiceOptions): Promise<WrittenCapsuleServicesCompose | null>;
export declare function capsuleServicesComposeModel(config: CapsuleProjectConfig, projectDir?: string, options?: CapsuleServiceOptions): CapsuleServicesComposeModel;
//# sourceMappingURL=capsule-services.d.ts.map