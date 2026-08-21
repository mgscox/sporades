type LooseRecord = Record<string, any>;
export declare function createStripeCallbackEndpoint(payments: LooseRecord | undefined, serverEnv: LooseRecord, admissionFault?: (boundary: string, details: LooseRecord) => void | Promise<void>): {
    name: string;
    runtimeOwnedStripeCallback: boolean;
    method: string;
    path: any;
    handler(ctx: LooseRecord): Promise<{
        status: number;
        body: {
            ok: boolean;
            jobId?: undefined;
        };
    } | {
        status: number;
        body: {
            ok: boolean;
            jobId: any;
        };
    }>;
} | null;
export {};
//# sourceMappingURL=stripe-webhook-runtime.d.ts.map