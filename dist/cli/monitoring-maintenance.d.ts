export type MonitoringMaintenanceAction = 'upgrade' | 'rollback' | 'backup' | 'restore';
export interface MonitoringMaintenanceResult {
    path: string;
    action: MonitoringMaintenanceAction;
    changed: boolean;
    overrides: string[];
}
export declare function runMonitoringMaintenance(action: MonitoringMaintenanceAction, directory: string, packageRoot: string, options?: {
    backup?: string;
    baseline?: string;
}): Promise<MonitoringMaintenanceResult>;
//# sourceMappingURL=monitoring-maintenance.d.ts.map