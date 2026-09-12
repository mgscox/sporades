/** Exact hostnames only: never interpolate caller-controlled Caddy syntax. */
export declare function validateAliasDomains(value: unknown): string[];
/** Caller holds the Host-wide route flock, including during bootstrap. */
export declare function assertHostnamesAvailable(remoteRoot: string, hostnames: string[], owner: string): Promise<void>;
//# sourceMappingURL=host-domain-aliases.d.ts.map