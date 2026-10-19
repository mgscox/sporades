export type HelperError = Error & {
    code?: string;
    hint?: string;
    sporadesAclDenialLogData?: any;
    sporadesAuthDenialLogData?: any;
    sporadesEndpointResponse?: boolean;
};
type LooseRecord = Record<string, any>;
export declare function commandError(message: string | undefined, hint: string, code?: string | null): HelperError;
export declare function assertJsonCompatible(value: any): any;
export declare function invalidReferenceError(field: LooseRecord): HelperError;
/** Routine authorization outcomes and cancellations are not diagnostic failures. */
export declare const expectedDiagnosticErrorCodes: string[];
export {};
//# sourceMappingURL=runtime-errors.d.ts.map