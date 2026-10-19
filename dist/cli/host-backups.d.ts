import type { HostHelperHost } from "./hosted-capsule-contract.js";
export type HostBackupPolicy = {
    repository: string;
    passwordFile: string;
    credentialsFile?: string;
    schedule: "hourly" | "daily" | "weekly" | null;
    retention: number;
    maxAgeHours: number;
};
type Snapshot = {
    id: string;
    time: string;
    tags: string[];
};
export type HostBackupManifest = {
    version: 1;
    domain: string;
    subname: string;
    releaseId: string;
    createdAt: string;
    schemaHash: string;
    checksums: Record<string, string>;
    directories: string[];
};
export type BackupTarget = {
    host: HostHelperHost;
    subname: string;
    releaseId: string;
    data: string;
};
export declare function validateHostBackupPolicy(value: unknown): HostBackupPolicy;
export declare function trustedBackupPath(file: string, secret?: boolean): Promise<void>;
export declare function hostBackupDirectory(host: HostHelperHost): string;
export declare function atomicBackupJson(file: string, value: unknown): Promise<void>;
export declare function readHostBackupPolicy(host: HostHelperHost): Promise<HostBackupPolicy | null>;
export declare function listHostBackups(policy: HostBackupPolicy, host: HostHelperHost, subname: string): Promise<Snapshot[]>;
export declare function pruneHostBackups(policy: HostBackupPolicy, host: HostHelperHost, subname: string): Promise<{
    pruned: boolean;
    retention: number;
}>;
export declare function createHostBackup(policy: HostBackupPolicy, target: BackupTarget, afterCapture?: () => Promise<void>): Promise<{
    id: any;
    manifest: {
        fileCount: number;
        directoryCount: number;
        version: 1;
        domain: string;
        subname: string;
        releaseId: string;
        createdAt: string;
        schemaHash: string;
    };
}>;
export declare function publishHostBackupMetric(host: HostHelperHost, subname: string, removed?: boolean): Promise<void>;
export declare function recoverHostBackupRestore(data: string): Promise<void>;
export declare function restoreHostBackup(policy: HostBackupPolicy, target: BackupTarget, sourceSubname: string, id: string): Promise<{
    restored: boolean;
    id: string;
    sourceSubname: string;
    subname: string;
    manifest: {
        fileCount: number;
        directoryCount: number;
        version: 1;
        domain: string;
        subname: string;
        releaseId: string;
        createdAt: string;
        schemaHash: string;
    };
    restartRequired: boolean;
}>;
export declare function hostBackupStatus(host: HostHelperHost, subname: string): Promise<{
    configured: boolean;
    lastBackupAt?: undefined;
    ageSeconds?: undefined;
    maxAgeSeconds?: undefined;
    stale?: undefined;
} | {
    configured: boolean;
    lastBackupAt: string | null;
    ageSeconds: number | null;
    maxAgeSeconds: number;
    stale: boolean;
}>;
export declare function backupTimerUnits(host: HostHelperHost, policy: HostBackupPolicy): {
    name: string;
    service: string;
    timer: string;
};
export declare function configureHostBackups(host: HostHelperHost, input: unknown, systemdDirectory?: string): Promise<{
    configured: boolean;
    schedule: "hourly" | "daily" | "weekly" | null;
    timer: string | null;
}>;
export {};
//# sourceMappingURL=host-backups.d.ts.map