export declare function validateMailConfig(mail: Record<string, any> | undefined): {
    webhooks?: undefined;
} | {
    webhooks: {
        mailjet?: undefined;
    } | {
        mailjet: {
            enabled: boolean;
            path: any;
            secretEnv: any;
        };
    };
} | {
    webhooks?: {
        mailjet?: undefined;
    } | {
        mailjet: {
            enabled: boolean;
            path: any;
            secretEnv: any;
        };
    } | undefined;
    smtp: Record<string, any>;
} | undefined;
//# sourceMappingURL=mail-config.d.ts.map