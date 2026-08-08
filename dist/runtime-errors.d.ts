export type HelperError = Error & {
    code?: string;
    hint?: string;
    sporadesAclDenialLogData?: any;
    sporadesAuthDenialLogData?: any;
    sporadesEndpointResponse?: boolean;
};
type LooseRecord = Record<string, any>;
export declare function commandError(message: string | undefined, hint: string, code?: string | null): HelperError;
export declare function assertJsonCompatible(value: any): void;
export declare function invalidReferenceError(field: LooseRecord): HelperError;
export {};
//# sourceMappingURL=runtime-errors.d.ts.map