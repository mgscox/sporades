/** Exact hostnames only: never interpolate caller-controlled Caddy syntax. */
export declare function validateAliasDomains(value: unknown): string[];
/** Caller holds the Host-wide route flock, including during bootstrap. */
export declare function assertHostnamesAvailable(remoteRoot: string, hostnames: string[], owner: string): Promise<void>;
export declare function validateCanonicalDomain(value: unknown): string | null;
export declare function hostedPublicOrigin(record: any): string;
//# sourceMappingURL=host-domain-aliases.d.ts.map