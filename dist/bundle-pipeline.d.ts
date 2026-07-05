import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
export type JsonRecord = Record<string, unknown>;
export type ServerEnv = Record<string, string>;
export type ServerEnvFile = {
    exists: boolean;
    raw: string;
};
export type ProjectConfig = JsonRecord & {
    auth?: AuthConfig;
    client?: {
        framework?: unknown;
    };
};
export type AuthConfig = JsonRecord & {
    mode?: unknown;
    providers?: unknown;
    google?: unknown;
};
export type NormalizedProviderConfig = {
    enabled: boolean;
    clientIdEnv: string | null;
    clientSecretEnv: string | null;
};
export type NormalizedAuthConfig = {
    mode: string;
    providers: {
        anonymous: {
            enabled: boolean;
        };
        google: NormalizedProviderConfig;
        email: {
            enabled: boolean;
        };
    };
};
export type FrameworkBundleConfig = {
    jsxImportSource: string;
    jsxRuntimeImport: string;
};
export declare function createBundle(projectDir: string, config: ProjectConfig): Promise<{
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
        env: Record<string, string>;
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
        } | null;
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
        } | null;
    };
}>;
export declare function readServerEnvFile(envPath: PathLike | FileHandle): Promise<ServerEnvFile>;
export declare function parseServerEnv(envFile: ServerEnvFile): ServerEnv;
export declare function authStatus(config: ProjectConfig, serverEnv: ServerEnv): {
    mode: string;
    providers: {
        anonymous: {
            enabled: boolean;
        };
        google: {
            enabled: boolean;
            configured: boolean;
            clientIdEnv: string | null;
            clientSecretEnv: string | null;
        };
        email?: {
            enabled: boolean;
        };
    };
    google: {
        configured: boolean;
        clientIdEnv: string | null;
        clientSecretEnv: string | null;
    };
};
//# sourceMappingURL=bundle-pipeline.d.ts.map