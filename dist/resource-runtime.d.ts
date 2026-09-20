type RecordValue = Record<string, any>;
/** V1 resource scopes are an explicit allowlist; SQL-dialect similarity is not support. */
export declare const RESOURCE_ADAPTER_SUPPORT: Readonly<{
    readonly sqlite: "supported";
    readonly postgres: "supported";
    readonly libsql: "unsupported";
}>;
/** Internal signal: settlement must also verify the exact claim's durable cancellation marker. */
export declare function isResourceAbortError(error: any): boolean;
/** Public errors never include caller data or engine diagnostics. */
export declare function resourceError(code: string): Error & {
    retryable?: boolean | undefined;
    code: string;
};
export declare function acquirePostgresResourceBootstrapLock(adapter: RecordValue): Promise<void>;
export declare function resourceCanonicalJson(value: unknown): string;
export declare const unsupportedResources: Readonly<{
    run(): Promise<never>;
    status(): Promise<never>;
}>;
/**
 * Binds the same receipt protocol to a transaction which was opened by a
 * mutation or Custom endpoint.  It deliberately does not open another writer:
 * the enclosing handler owns commit/rollback, so a returned value is provisional
 * until that handler's transaction commits.
 */
export declare function bindOuterResources(database: RecordValue, context: RecordValue, hooks: RecordValue): any;
export declare function bindJobResources(database: RecordValue, context: RecordValue, claim: RecordValue, hooks: RecordValue): () => void;
export {};
//# sourceMappingURL=resource-runtime.d.ts.map