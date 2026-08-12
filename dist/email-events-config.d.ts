type LooseRecord = Record<string, any>;
export declare function validateEmailWebhooksConfig(webhooks: LooseRecord | undefined): {
    mailjet?: undefined;
} | {
    mailjet: {
        enabled: boolean;
        path: any;
        secretEnv: any;
    };
} | undefined;
export {};
//# sourceMappingURL=email-events-config.d.ts.map