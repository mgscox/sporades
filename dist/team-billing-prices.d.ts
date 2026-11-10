type Facts = Record<string, any>;
export declare function validBillingCurrency(value: any): value is string;
export declare function validBillingAmount(value: any): value is number;
/** Undefined means the legacy identity-only Price contract. */
export declare function billingCurrencyAmount(price: Facts, currency: any): number | undefined;
export declare function normalizeBillingCurrency(price: Facts, invalid: () => Error): Facts;
/** Subscription Price facts use the selected currency, rather than the default Price amount. */
export declare function matchesBillingCurrency(price: Facts, currency: any, amount: any): boolean;
export declare function billingCurrencyMismatch(): Error & {
    code: string;
    hint: string;
};
export declare function validTeamBillingInterval(value: any): value is string;
export declare function teamBillingPrices(binding: any): Facts[];
export declare function teamBillingPrice(binding: any, interval: any): any;
export declare function teamBillingPriceById(binding: any, priceId: any): Facts | null;
export declare function normalizeModeBinding(value: any, invalidDeclaration: () => Error): Readonly<{
    portalConfigurationId?: any;
    productId?: any;
}>;
export declare function matchesBillingPriceAmount(actual: any, expected: number): boolean;
export {};
//# sourceMappingURL=team-billing-prices.d.ts.map