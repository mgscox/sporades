export type HelperError = Error & {
    code?: string;
    hint?: string;
    sporadesAclDenialLogData?: any;
    sporadesAuthDenialLogData?: any;
    sporadesEndpointResponse?: boolean;
};
export declare function commandError(message: string | undefined, hint: string, code?: string | null): HelperError;
//# sourceMappingURL=runtime-errors.d.ts.map