export declare const STACK_SCHEMA = 4;
export declare const ASSETS: string[];
export declare function prerequisite(): void;
export declare function runMonitoringStack(action: 'init' | 'validate', directory: string, packageRoot: string): Promise<{
    path: string;
    schemaVersion: number;
    packageVersion: string;
    created: string[];
    overrides: string[];
    missingAssets: string[];
    versionDifference: {
        installed: string;
        available: string;
        schema: number | null;
    } | null;
    missing: string[];
    nextSteps: string[];
}>;
/** Redacted result of an operator-local sender credential command. */
export interface SenderCredentialResult {
    schemaVersion: 1;
    revision: number;
    changed: boolean;
    legacyIngestEnabled: boolean;
    legacyInventoryDisabled: string[];
    senders: {
        name: string;
        host: string | null;
        state: 'applied' | 'pending' | 'revoked';
        generation: number;
        pendingGeneration: number | null;
    }[];
}
//# sourceMappingURL=monitoring-stack.d.ts.map