import type { HostHelperRelease, HostHelperRequest as HostHelperContractRequest, HostHelperCapsuleTarget } from "./host-helper-contract.js";
export type HostHelperRequest = HostHelperContractRequest & {
    capsule: HostHelperCapsuleTarget;
    release: HostHelperRelease;
};
export type HostLogLineLimits = {
    defaultLines: number;
    maxLines: number;
};
export declare function missingCapsuleHint(request: HostHelperRequest, purpose: string): string;
export declare function hostRegistryRetryCommand(request: HostHelperRequest): string;
export declare function validateLifecycleRequest(request: HostHelperRequest): void;
export declare function validateSealedEnvRotationRequest(request: HostHelperRequest): void;
export declare function validateStatsRequest(request: HostHelperRequest): void;
export declare function validateReleaseListRequest(request: HostHelperRequest): void;
export declare function validateHealthRequest(request: HostHelperRequest): void;
export declare function validateHostStatsRequest(request: HostHelperRequest): void;
export declare function validateRollbackRequest(request: HostHelperRequest): void;
export declare function validateHostLogsRequest(request: HostHelperRequest, limits: HostLogLineLimits): void;
export declare function validateListRequest(request: HostHelperRequest): void;
export declare function validateListRegistryRecord(request: HostHelperRequest, record: unknown, recordPath: string): void;
export declare function validateBootstrapRequest(request: HostHelperRequest): void;
export declare function validateRegisterRequest(request: HostHelperRequest): void;
export declare function validateUnregisterRequest(request: HostHelperRequest): void;
export declare function validateDeleteRequest(request: HostHelperRequest): void;
export declare function validateInstallRequest(request: HostHelperRequest): void;
//# sourceMappingURL=host-helper-validation.d.ts.map