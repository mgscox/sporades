type LooseRecord = Record<string, any>;
export declare const AUTH_REQUIREMENTS: unique symbol;
export declare const ACCESS_KEY_SCOPE_LIMIT = 1024;
export declare const ACCESS_KEY_SCOPE_BYTE_LIMIT = 256;
export type CredentialKind = "session" | "access-key";
export type AuthRequirements = Readonly<{
    linked: boolean;
    credentials: readonly CredentialKind[];
    scopes: readonly string[];
    reauthentication: string | null;
}>;
export declare function invalidAuthRequirements(hint: string): import("./runtime-errors.js").HelperError;
export declare function normalizeRequireUserAuthOptions(options?: unknown): Readonly<{
    linked: boolean;
}>;
export declare function decorateRequireAuth(options: unknown, handler: unknown): (this: unknown, ...args: unknown[]) => any;
export declare function readAuthRequirements(handler: unknown): AuthRequirements | null;
export declare function normalizeAuthRequirements(options?: unknown): AuthRequirements;
export declare function normalizeCapsuleAuthDefinition<Definition extends LooseRecord>(definition: Definition): Definition;
export declare function validateCapsuleAuthRequirements(definition: LooseRecord): LooseRecord;
export declare function scopeGrantMatches(grant: string, requiredScope: string): boolean;
export declare function accessKeyGrantsSatisfyScopes(grants: readonly string[], requiredScopes: readonly string[]): boolean;
export {};
//# sourceMappingURL=auth-admission.d.ts.map