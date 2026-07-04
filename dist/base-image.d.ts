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
export declare function normaliseBaseImageUpdatePolicy(value: any): any;
export declare function baseImageUpdatePolicy(mode?: string): {
    mode: any;
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
        mode: any;
        autoPatch: {
            supported: boolean;
            reason: string;
        };
    };
};
export declare function baseImageLabels(updatePolicyMode?: string): {
    "com.sporades.base-image.name": string;
    "com.sporades.base-image.version": string;
    "com.sporades.base-image.update-policy": any;
};
//# sourceMappingURL=base-image.d.ts.map