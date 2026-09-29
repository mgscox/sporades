export declare const HOST_METRICS_NETWORK = "sporades-host-metrics";
export type HostMetrics = {
    host: string;
    address: string;
    enabled: boolean;
    psi: boolean;
    caddyMetricsServer?: string;
};
export declare function readHostMetrics(root: string): Promise<HostMetrics | null>;
export declare function configureHostMetrics(root: string, host: string, operation?: "reconcile" | "enable" | "disable" | "remove"): Promise<HostMetrics>;
export declare function hostScrapeConfig(state: HostMetrics): string;
export declare function hostMetricsStatus(root: string): Promise<{
    configured: boolean;
    enabled: boolean;
    backendVerification: string;
    host?: undefined;
    exporterRunning?: undefined;
    psi?: undefined;
} | {
    configured: boolean;
    enabled: boolean;
    host: string;
    exporterRunning: boolean;
    psi: string;
    backendVerification: string;
}>;
//# sourceMappingURL=host-metrics.d.ts.map