import type { HostHelperRequest } from "./host-helper-contract.js";
export type HostHelperConfig = {
    hostedCapsule: {
        dockerImage: string;
        dockerNetwork: string;
        graceCheckMs: number;
    };
    logs: {
        defaultLines: number;
        maxLines: number;
    };
};
export declare function defaultHostHelperConfig(): HostHelperConfig;
export declare function loadHostHelperConfig(request: HostHelperRequest): Promise<HostHelperConfig>;
//# sourceMappingURL=host-helper-config.d.ts.map