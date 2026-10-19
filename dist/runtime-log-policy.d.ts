type LooseRecord = Record<string, any>;
export declare function logIndexLimit(config?: LooseRecord): number;
export declare function isSensitiveLogKey(key: string): boolean;
/** Shared diagnostic text policy. Stack frames are admitted separately by error collection. */
export declare function redactDiagnosticText(value: string, serverEnv?: LooseRecord): string;
export {};
//# sourceMappingURL=runtime-log-policy.d.ts.map