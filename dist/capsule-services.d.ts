type JsonRecord = Record<string, unknown>;
type DatabaseEngine = "libsql" | "postgres";
type StorageEngine = "minio";
type CapsuleServiceKind = "database" | "storage";
type CapsuleServiceCredentials = {
    databaseUser: string;
    databasePassword: string;
    storageAccessKey: string;
    storageSecretKey: string;
};
type CapsuleServiceOptions = {
    credentials?: Partial<CapsuleServiceCredentials>;
    publishPorts?: boolean;
};
type DatabaseServiceDeclaration = {
    kind: "database";
    engine: DatabaseEngine;
};
type StorageServiceDeclaration = {
    kind: "storage";
    engine: StorageEngine;
};
type CapsuleServicesDeclaration = JsonRecord & {
    database?: DatabaseServiceDeclaration;
    storage?: StorageServiceDeclaration;
};
type CapsuleProjectConfig = JsonRecord & {
    name?: unknown;
    services?: CapsuleServicesDeclaration;
};
type CapsuleServiceBase = {
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
type CapsuleDatabaseService = CapsuleServiceBase & {
    kind: "database";
    engine: DatabaseEngine;
    user: string;
    password: string;
    databaseName: string;
};
type CapsuleStorageService = CapsuleServiceBase & {
    kind: "storage";
    engine: StorageEngine;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    namespace: string;
};
type CapsuleServices = {
    database?: CapsuleDatabaseService;
    storage?: CapsuleStorageService;
};
type CapsuleServicesComposeModel = {
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
type WrittenCapsuleServicesCompose = CapsuleServicesComposeModel & {
    path: string;
    relativePath: string;
};
export declare const CAPSULE_SERVICES_COMPOSE_FILE: string;
export declare const CAPSULE_SERVICES_STATE_DIR: string;
export declare const CAPSULE_SERVICES_CREDENTIALS_FILE: string;
export declare function validateCapsuleServicesConfig(services: unknown): CapsuleServicesDeclaration | null;
export declare function writeCapsuleServicesCompose(projectDir: string, config: CapsuleProjectConfig, options?: CapsuleServiceOptions): Promise<WrittenCapsuleServicesCompose | null>;
export declare function capsuleServicesComposeModel(config: CapsuleProjectConfig, projectDir?: string, options?: CapsuleServiceOptions): CapsuleServicesComposeModel;
export {};
//# sourceMappingURL=capsule-services.d.ts.map