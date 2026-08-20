type LooseRecord = Record<string, any>;
export declare const STRIPE_API_VERSION: "2026-07-29.dahlia";
export type DormantStripePaymentsConfig = Readonly<{
    enabled: false;
}>;
export type EnabledStripePaymentsConfig = Readonly<{
    enabled: true;
    secretKeyEnv: string;
    webhookSecretEnv: string;
    publicOrigin: string;
    callbackPath: string;
    apiVersion: typeof STRIPE_API_VERSION;
    livemode: boolean;
    requestTimeoutMs: number;
}>;
export type StripePaymentsConfig = DormantStripePaymentsConfig | EnabledStripePaymentsConfig;
export type PaymentsConfig = Readonly<{
    stripe: StripePaymentsConfig;
}>;
export declare function validatePaymentsConfig(payments: unknown): PaymentsConfig | undefined;
export declare function validateStripePaymentsRuntimeConfig(payments: unknown, serverEnv: LooseRecord): PaymentsConfig | undefined;
export {};
//# sourceMappingURL=stripe-payment-config.d.ts.map