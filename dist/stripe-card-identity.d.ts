/** Internal transient provider evidence; only the keyed token may leave this boundary. */
export declare function cardIdentityKey(config: Record<string, any>, env: Record<string, any>): string;
export declare function stripeCardIdentity(paymentMethod: any, key: string, livemode: boolean): Readonly<{
    token: string;
}> | null;
export declare function cardIdentityUnavailable(): Error & {
    code: string;
    retryable: boolean;
    hint: string;
};
export declare const CHECKOUT_CARD_EXPAND: string[];
export declare const SUBSCRIPTION_CARD_EXPAND: string[];
//# sourceMappingURL=stripe-card-identity.d.ts.map