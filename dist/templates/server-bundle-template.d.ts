export declare const MIGRATED_RUNTIME_MODULE_FILES: string[];
export declare const MIGRATED_MODULE_SKEW_PROBE: string[];
export declare const MIGRATED_MODULE_ROW_SKEW_PROBE: [Record<string, any>, string][];
export declare const MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE: any[];
export declare const MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE: any[];
export declare const MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE: [string, string, string][];
export declare const MIGRATED_MODULE_AUTH_SKEW_PROBE: [string, any[]][];
export declare const MIGRATED_MODULE_PREFERENCES_PATCH_SKEW_PROBE: [string, unknown][];
export declare const MIGRATED_MODULE_STORAGE_SIGNATURE_SKEW_PROBE: [string, Record<string, unknown>][];
export declare const MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE: [string, unknown[]][];
export declare const MIGRATED_MODULE_STORAGE_ENGINE_SKEW_PROBE: [string, Record<string, unknown>][];
export declare const MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE: [string, unknown][];
export declare const MIGRATED_MODULE_LOG_POLICY_SKEW_PROBE: [string, unknown[]][];
export declare const MIGRATED_MODULE_ROW_DECODING_SKEW_PROBE: [string, unknown[]][];
export declare function migratedRuntimeModulesBlockFrom(distDir: string): string;
export declare function createServerBundleSource({ config, serverEnv, sealedServerEnv, serverSource, serverModuleSource }: {
    config: any;
    serverEnv: any;
    sealedServerEnv?: any;
    serverSource: string;
    serverModuleSource: string;
}): string;
//# sourceMappingURL=server-bundle-template.d.ts.map