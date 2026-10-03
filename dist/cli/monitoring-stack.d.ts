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
    notificationDelivery: string;
    nextSteps: string[];
}>;
//# sourceMappingURL=monitoring-stack.d.ts.map