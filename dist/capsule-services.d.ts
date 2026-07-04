export declare const CAPSULE_SERVICES_COMPOSE_FILE: string;
export declare const CAPSULE_SERVICES_STATE_DIR: string;
export declare function validateCapsuleServicesConfig(services: any): any;
export declare function writeCapsuleServicesCompose(projectDir: any, config: any): Promise<{
    projectSlug: string;
    composeProjectName: string;
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
export declare function capsuleServicesComposeModel(config: any, projectDir?: string): {
    projectSlug: string;
    composeProjectName: string;
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