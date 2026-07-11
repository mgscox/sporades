import type { HostHelperRelease, HostHelperRequest as HostHelperContractRequest, HostHelperCapsuleTarget } from "./host-helper-contract.js";
type HostHelperRequest = HostHelperContractRequest & {
    capsule: HostHelperCapsuleTarget;
    release: HostHelperRelease;
};
export declare const HOST_RELEASE_ARCHIVE_LIMITS: {
    readonly entries: 2048;
    readonly fileBytes: number;
    readonly totalBytes: number;
    readonly pathBytes: number;
    readonly compressedBytes: number;
};
export type ReleaseArchiveFile = {
    path: string;
    size: number;
};
export declare function validateReleaseArchive(request: HostHelperRequest, archivePath?: string): {
    files: {
        path: string;
        size: number;
    }[];
};
export {};
//# sourceMappingURL=host-helper-archive.d.ts.map