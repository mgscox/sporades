type RecordLike = Record<string, any>;
export declare function devRuntimeRequiresClamav(database: RecordLike): boolean;
export declare function releaseDevClamavSidecar(sidecar: any): Promise<undefined>;
export declare function retireDevClamavSidecarIfUnused(sidecar: any, database: RecordLike): Promise<any>;
export declare function devClamavSidecarIsReusable(sidecar: any): boolean;
export declare function attachRequiredDevClamavSidecar(sidecar: any, database: RecordLike, createSidecar: () => Promise<any>): Promise<{
    sidecar: any;
    attached: boolean;
}>;
type DevClamavTiming = {
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
};
export declare function waitForDevClamavChildExit(child: any, timeoutMs: number, timing?: DevClamavTiming): Promise<boolean>;
export declare function ensureDevClamavChildExit(child: any, timeoutMs: number, timing?: DevClamavTiming): Promise<boolean>;
export declare function startDevClamavSidecar(options: RecordLike): Promise<{
    descriptor: {
        containerName: string;
        socketPath: string;
        process: any;
        externallyManaged: boolean;
        diagnosticOutput: () => string;
    };
    attach(database: RecordLike): void;
    stop(): Promise<void>;
}>;
export {};
//# sourceMappingURL=dev-clamav-sidecar.d.ts.map