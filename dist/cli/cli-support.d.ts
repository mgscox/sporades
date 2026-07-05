export type LooseRecord = Record<string, any>;
export type CommandError = Error & {
    hint?: string;
    diagnostics?: unknown;
};
export type HelperError = Error & {
    hint?: string;
    diagnostics?: unknown;
};
export declare function errorDetails(error: unknown): LooseRecord;
export declare function commandError(message: string, hint: string, diagnostics?: unknown): CommandError;
export declare function helperError(message: string, hint: string, diagnostics?: unknown): HelperError;
export declare function readStdin(): Promise<string>;
export declare function delay(ms: number): Promise<void>;
export declare function writeResult(result: LooseRecord, failed?: boolean): void;
export declare function writeEnvelope(result: LooseRecord, failed?: boolean): void;
//# sourceMappingURL=cli-support.d.ts.map