export type TrustedService = Readonly<{
    url: string;
    secrets: Readonly<Record<string, string>>;
}>;
export type TrustedServices = Readonly<Record<string, TrustedService | undefined>>;
/** Launch plumbing only: declarations cannot supply URLs or credential values. */
export declare function createTrustedServices(config: any, serviceEnv?: Record<string, unknown>): TrustedServices;
export declare function bindServicesContext<T extends object>(context: T, services: TrustedServices): T;
/** Redaction values are a separate sink input, never a ctx.env addition. */
export declare function serviceRedactionValues(services: TrustedServices): Record<string, string>;
//# sourceMappingURL=services-context.d.ts.map