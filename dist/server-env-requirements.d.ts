/** Opt-in sporades.json Server env enforcement. Omission preserves 0.9.x behavior. */
export type ServerEnvConfig = Readonly<{
    required?: readonly string[];
    failClosed?: boolean;
}>;
type Config = Record<string, any>;
export declare function validateServerEnvConfig(value: unknown): ServerEnvConfig | undefined;
/** Call with validated mail/payment config. Never resolve values from process.env. */
export declare function requiredServerEnvKeys(config: Config): string[];
export declare function missingServerEnvKeys(config: Config, values: Record<string, unknown>): string[];
export declare function missingServerEnvError(keys: readonly string[]): import("./runtime-errors.js").HelperError;
export {};
//# sourceMappingURL=server-env-requirements.d.ts.map