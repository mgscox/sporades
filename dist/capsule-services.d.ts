export declare const CAPSULE_SERVICES_COMPOSE_FILE: string;
export declare const CAPSULE_SERVICES_STATE_DIR: string;
export declare function validateCapsuleServicesConfig(services: any): any;
export declare function writeCapsuleServicesCompose(projectDir: any, config: any): Promise<{
    projectSlug: string;
    composeProjectName: string;
    services: {
        database: {
            name: string;
            engine: any;
            image: string;
            stateDir: string;
            targetPort: number;
            volumeTarget: string;
            environment: {
                POSTGRES_USER: string;
                POSTGRES_PASSWORD: string;
                POSTGRES_DB: string;
                POSTGRES_HOST_AUTH_METHOD: string;
            } | {
                POSTGRES_USER?: undefined;
                POSTGRES_PASSWORD?: undefined;
                POSTGRES_DB?: undefined;
                POSTGRES_HOST_AUTH_METHOD?: undefined;
            };
        };
    };
    networks: {
        services: string;
    };
    labels: {
        "com.sporades.managed": string;
        "com.sporades.runtime-state": string;
        "com.sporades.project": string;
        "com.sporades.capsule-service.kind": string;
        "com.sporades.capsule-service.engine": any;
    };
    path: string;
    relativePath: string;
}>;
export declare function capsuleServicesComposeModel(config: any, projectDir?: string): {
    projectSlug: string;
    composeProjectName: string;
    services: {
        database: {
            name: string;
            engine: any;
            image: string;
            stateDir: string;
            targetPort: number;
            volumeTarget: string;
            environment: {
                POSTGRES_USER: string;
                POSTGRES_PASSWORD: string;
                POSTGRES_DB: string;
                POSTGRES_HOST_AUTH_METHOD: string;
            } | {
                POSTGRES_USER?: undefined;
                POSTGRES_PASSWORD?: undefined;
                POSTGRES_DB?: undefined;
                POSTGRES_HOST_AUTH_METHOD?: undefined;
            };
        };
    };
    networks: {
        services: string;
    };
    labels: {
        "com.sporades.managed": string;
        "com.sporades.runtime-state": string;
        "com.sporades.project": string;
        "com.sporades.capsule-service.kind": string;
        "com.sporades.capsule-service.engine": any;
    };
};
//# sourceMappingURL=capsule-services.d.ts.map