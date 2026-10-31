/** The only response headers available on a thrown endpoint failure. */
export type EndpointErrorHeaders = Readonly<Partial<Record<"Cache-Control" | "Pragma" | "X-Robots-Tag" | "Content-Security-Policy" | "Referrer-Policy" | "cache-control" | "pragma" | "x-robots-tag" | "content-security-policy" | "referrer-policy", string>>>;
/** Self-contained so the public helper and generated Capsule helper use identical validation. */
export declare function endpointError(headers: EndpointErrorHeaders): Error;
/** Revalidate the public helper's snapshot at the response boundary, including forged errors. */
export declare function endpointErrorResponseHeaders(error: unknown): Record<string, string>;
//# sourceMappingURL=endpoint-error.d.ts.map