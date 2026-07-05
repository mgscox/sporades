export declare const SPORADES_BASE_IMAGE: {
    name: string;
    image: string;
    version: string;
    runtimeUser: string;
    runtimeUid: number;
    runtimeGid: number;
    updatePolicy: {
        defaultMode: string;
        modes: string[];
        autoPatchSupported: boolean;
        autoPatchUnsupportedReason: string;
    };
};
export declare function baseImageRuntimeUser(): string;
export declare function normaliseBaseImageUpdatePolicy(value: string | {
    mode: string;
}): string;
export declare function baseImageUpdatePolicy(mode?: string): {
    mode: string;
    autoPatch: {
        supported: boolean;
        reason: string;
    };
};
export declare function baseImageMetadata(updatePolicyMode?: string): {
    name: string;
    image: string;
    version: string;
    updatePolicy: {
        mode: string;
        autoPatch: {
            supported: boolean;
            reason: string;
        };
    };
};
export declare function baseImageLabels(updatePolicyMode?: string): {
    "com.sporades.base-image.name": string;
    "com.sporades.base-image.version": string;
    "com.sporades.base-image.update-policy": string;
};
//# sourceMappingURL=base-image.d.ts.map