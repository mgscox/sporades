export type ExceptionFrame = {
    filename: string;
    function: string;
    lineno?: number;
    colno?: number;
};
/** Serialized into the first-party loader too; keep this function self-contained. */
export declare function exceptionFrames(input: unknown, embeddedSource?: string): ExceptionFrame[];
//# sourceMappingURL=exception-stack.d.ts.map