export declare const CLIENT_ADDRESS_TOKEN_HEADER = "x-sporades-client-address-token";
export declare function canonicalClientAddress(value: unknown): string | null;
export declare function validClientAddressNetwork(value: string): boolean;
export declare function clientAddressMatches(address: string, network: string): boolean;
/** Domain-separated from health-control authority; owned by Host, never Capsule configuration. */
export declare function clientAddressBoundaryToken(probeToken: string): string;
/** The network is untrusted even in Hosted. Require the Host's per-runtime capability. */
export declare function trustedClientAddress(database: any, request: any): string | null;
//# sourceMappingURL=client-address.d.ts.map