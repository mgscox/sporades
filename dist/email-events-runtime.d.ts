type LooseRecord = Record<string, any>;
/** Send provider-normalized events through the Capsule's single email-event seam. */
export declare function dispatchVerifiedEmailEvents(ctx: LooseRecord, events: LooseRecord[], subscription?: LooseRecord): Promise<void>;
export declare function createEmailEventEndpoints(mailConfig: LooseRecord | undefined, serverEnv: LooseRecord, subscription: LooseRecord | undefined): {
    name: string;
    runtimeOwnedEmailEvent: boolean;
    method: string;
    path: any;
    handler(ctx: LooseRecord): Promise<{
        status: number;
        body: {
            ok: boolean;
            accepted: number;
            ignored: number;
        };
    }>;
}[];
export {};
//# sourceMappingURL=email-events-runtime.d.ts.map