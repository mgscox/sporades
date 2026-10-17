type Config = Record<string, any>;
export type RequiredServerEnvConfig = Readonly<{
    required?: readonly string[];
    failClosed?: boolean;
}>;
/** Validate names before using them in operator diagnostics. Never echo invalid input. */
export declare function validateRequiredServerEnvConfig(env: unknown): asserts env is RequiredServerEnvConfig | undefined;
export declare function requiredServerEnvKeys(config: Config): string[];
export declare function missingRequiredServerEnv(config: Config, values: Readonly<Record<string, unknown>>): string[];
export {};
//# sourceMappingURL=required-server-env.d.ts.map