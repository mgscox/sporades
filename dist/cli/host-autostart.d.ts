import type { HostHelperHost } from "./hosted-capsule-contract.js";
export declare function hostRouteRecoveryUnits(host: HostHelperHost): {
    unit: string;
    service: string;
    timer: string;
};
export declare function installHostAutostart(host: HostHelperHost): Promise<{
    installed: boolean;
    reason: string;
    unit?: undefined;
    shutdownUnit?: undefined;
    routeRecoveryTimer?: undefined;
    startsExistingCapsules?: undefined;
} | {
    installed: boolean;
    unit: string;
    shutdownUnit: string;
    routeRecoveryTimer: string;
    startsExistingCapsules: boolean;
    reason?: undefined;
}>;
//# sourceMappingURL=host-autostart.d.ts.map