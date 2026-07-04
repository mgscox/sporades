export declare function createBundle(projectDir: any, config: any): Promise<{
    paths: {
        config: string;
        serverEntry: string;
        clientEntry: string;
        indexHtml: string;
        serverEnv: string;
        serverBundle: string;
        clientBundle: string;
    };
    buildDir: string;
    serverRuntime: {
        source: string;
        env: {};
        capsuleModuleSource: string;
    };
    staticFiles: {
        indexHtml: string;
        clientBundle: string;
    };
    containerMounts: {
        files: {
            host: string;
            container: string;
            mode: string;
        }[];
        serverEnv: {
            host: string;
            container: string;
            mode: string;
        };
        sealedServerEnv: {
            envelope: {
                host: string;
                container: string;
                mode: string;
            };
            privateKey: {
                host: string;
                container: string;
                mode: string;
            };
        };
    };
}>;
export declare function readServerEnvFile(envPath: any): Promise<{
    exists: boolean;
    raw: string;
}>;
export declare function parseServerEnv(envFile: any): {};
export declare function authStatus(config: any, serverEnv: any): {
    mode: any;
    providers: {
        anonymous: {
            enabled: boolean;
        };
        google: {
            enabled: boolean;
            configured: boolean;
            clientIdEnv: any;
            clientSecretEnv: any;
        };
    };
    google: {
        configured: boolean;
        clientIdEnv: any;
        clientSecretEnv: any;
    };
};
//# sourceMappingURL=bundle-pipeline.d.ts.map