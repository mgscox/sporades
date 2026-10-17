/** Escape text for HTML text nodes and quoted attribute values. Nullish values are empty. */
export declare function escapeHtml(value: unknown): string;
declare const htmlBrand: unique symbol;
/** Immutable escaped HTML. Convert with String(fragment) outside Sporades mail. */
export type Html = Readonly<{
    [htmlBrand]: true;
    toString(): string;
}>;
/** Internal recognition never executes a caller-supplied getter or toString method. */
export declare function htmlString(value: unknown): string | undefined;
/** Escape every interpolation; nested fragments and arrays compose without double escaping. */
export declare function html(strings: TemplateStringsArray, ...values: unknown[]): Html;
export declare namespace html {
    /** Explicitly trust HTML supplied by Capsule code. Never pass untrusted input. */
    function raw(trusted: string): Html;
}
export {};
//# sourceMappingURL=html.d.ts.map