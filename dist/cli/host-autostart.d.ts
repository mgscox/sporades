import type { HostHelperHost } from "./hosted-capsule-contract.js";
export declare function installHostAutostart(host: HostHelperHost): Promise<{
    installed: boolean;
    reason: string;
    unit?: undefined;
    shutdownUnit?: undefined;
    startsExistingCapsules?: undefined;
} | {
    installed: boolean;
    unit: string;
    shutdownUnit: string;
    startsExistingCapsules: boolean;
    reason?: undefined;
}>;
//# sourceMappingURL=host-autostart.d.ts.map