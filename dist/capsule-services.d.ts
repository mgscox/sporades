import { type ContainerServiceDeclaration } from "./container-services.js";
export type JsonRecord = Record<string, unknown>;
export type DatabaseEngine = "libsql" | "postgres";
export type StorageEngine = "minio";
export type CapsuleServiceKind = "database" | "storage" | "container";
export type CapsuleServiceCredentials = {
    databaseUser: string;
    databasePassword: string;
    storageAccessKey: string;
    storageSecretKey: string;
    container?: Record<string, Record<string, string>>;
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
export type CapsuleServicesDeclaration = Record<string, DatabaseServiceDeclaration | StorageServiceDeclaration | ContainerServiceDeclaration> & {
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
export type CapsuleContainerService = Omit<CapsuleServiceBase, "command"> & {
    kind: "container";
    command: string[];
    declaration: ContainerServiceDeclaration;
    rendered: JsonRecord;
};
export type CapsuleService = CapsuleDatabaseService | CapsuleStorageService | CapsuleContainerService;
export type CapsuleServices = Record<string, CapsuleService> & {
    database?: CapsuleDatabaseService;
    storage?: CapsuleStorageService;
};
export type CapsuleServicesComposeModel = {
    projectSlug: string;
    composeProjectName: string;
    publishPorts: boolean;
    credentials: CapsuleServiceCredentials;
    services: CapsuleServices;
    composeDocument?: JsonRecord;
    retired?: boolean;
    declarations: Record<string, any>;
    nameMapping: Record<string, string>;
    networks: {
        services: string;
        internal: string;
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
export declare function validateCapsuleServicesConfig(services: unknown, projectDir?: string): CapsuleServicesDeclaration | null;
export declare function writeCapsuleServicesCompose(projectDir: string, config: CapsuleProjectConfig, options?: CapsuleServiceOptions & {
    prepareState?: boolean;
}): Promise<WrittenCapsuleServicesCompose | null>;
export declare function capsuleServicesComposeModel(config: CapsuleProjectConfig, projectDir?: string, options?: CapsuleServiceOptions): CapsuleServicesComposeModel;
export declare function renderCapsuleServicesCompose(model: CapsuleServicesComposeModel): string;
//# sourceMappingURL=capsule-services.d.ts.map