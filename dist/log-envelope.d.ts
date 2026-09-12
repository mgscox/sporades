type LooseRecord = Record<string, any>;
export declare function uncappedLogEnvelope(input: LooseRecord): {
    schema: string;
    timestamp: any;
    category: any;
    event: any;
    level: any;
    message: string;
    capsule: {
        name: string;
        id: string;
    };
    release: any;
    request: {
        id: any;
        method: any;
        path: any;
    } | null;
    correlation: any;
    data: any;
};
export declare function minimumLogPayloadMaxBytes(config?: LooseRecord): number;
export declare function logPayloadMaxBytes(config?: LooseRecord): any;
export declare function validateLogConfig(config?: LooseRecord): void;
export {};
//# sourceMappingURL=log-envelope.d.ts.map