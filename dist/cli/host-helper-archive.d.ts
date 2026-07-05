import type { HostHelperRelease, HostHelperRequest as HostHelperContractRequest, HostHelperCapsuleTarget } from "./host-helper-contract.js";
type HostHelperRequest = HostHelperContractRequest & {
    capsule: HostHelperCapsuleTarget;
    release: HostHelperRelease;
};
export declare function validateReleaseArchive(request: HostHelperRequest): void;
export declare function removeDiscardedArchiveMetadata(directory: string): Promise<void>;
export {};
//# sourceMappingURL=host-helper-archive.d.ts.map