type RecordLike = Record<string, any>;
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