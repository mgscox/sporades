export declare function validateMailConfig(mail: Record<string, any> | undefined): {
    webhooks?: undefined;
} | {
    webhooks: {
        [x: string]: any;
    };
} | {
    webhooks?: {
        [x: string]: any;
    } | undefined;
    smtp: Record<string, any>;
} | undefined;
//# sourceMappingURL=mail-config.d.ts.map