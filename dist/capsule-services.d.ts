export declare const CAPSULE_SERVICES_COMPOSE_FILE: string;
export declare const CAPSULE_SERVICES_STATE_DIR: string;
export declare const CAPSULE_SERVICES_CREDENTIALS_FILE: string;
export declare function validateCapsuleServicesConfig(services: any): any;
export declare function writeCapsuleServicesCompose(projectDir: any, config: any, options?: {}): Promise<{
    projectSlug: string;
    composeProjectName: string;
    publishPorts: boolean;
    credentials: {
        databaseUser: any;
        databasePassword: any;
        storageAccessKey: any;
        storageSecretKey: any;
    };
    services: {};
    networks: {
        services: string;
    };
    labels: {
        "com.sporades.managed": string;
        "com.sporades.runtime-state": string;
        "com.sporades.project": string;
    };
    path: string;
    relativePath: string;
}>;
export declare function capsuleServicesComposeModel(config: any, projectDir?: string, options?: {}): {
    projectSlug: string;
    composeProjectName: string;
    publishPorts: boolean;
    credentials: {
        databaseUser: any;
        databasePassword: any;
        storageAccessKey: any;
        storageSecretKey: any;
    };
    services: {};
    networks: {
        services: string;
    };
    labels: {
        "com.sporades.managed": string;
        "com.sporades.runtime-state": string;
        "com.sporades.project": string;
    };
};
//# sourceMappingURL=capsule-services.d.ts.map