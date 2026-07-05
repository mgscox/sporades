import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
type JsonRecord = Record<string, unknown>;
type ServerEnv = Record<string, string>;
type ServerEnvFile = {
    exists: boolean;
    raw: string;
};
type ProjectConfig = JsonRecord & {
    auth?: AuthConfig;
    client?: {
        framework?: unknown;
    };
};
type AuthConfig = JsonRecord & {
    mode?: unknown;
    providers?: unknown;
    google?: unknown;
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
export {};
//# sourceMappingURL=bundle-pipeline.d.ts.map