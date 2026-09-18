type RecordValue = Record<string, any>;
/** Public errors never include caller data or engine diagnostics. */
export declare function resourceError(code: string): Error & {
    retryable?: boolean | undefined;
    code: string;
};
export declare function resourceCanonicalJson(value: unknown): string;
export declare const unsupportedResources: Readonly<{
    run(): Promise<never>;
    status(): Promise<never>;
}>;
export declare function bindJobResources(database: RecordValue, context: RecordValue, claim: RecordValue, hooks: RecordValue): () => void;
export {};
//# sourceMappingURL=resource-runtime.d.ts.map