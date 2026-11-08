import type { HostHelperHost } from "./hosted-capsule-contract.js";
export type HostObservabilityMail = {
    version: 1;
    transport: "console";
} | {
    version: 1;
    transport: "smtp-ssl";
    host: string;
    port: number;
    username: string;
    password: string;
    from: string;
};
export declare function validateObservabilityMail(value: unknown): HostObservabilityMail;
export declare function observabilityMailFile(host: HostHelperHost): string;
export declare function readObservabilityMail(host: HostHelperHost): Promise<HostObservabilityMail | null>;
export declare function observabilityMailStatus(mail: HostObservabilityMail | null): {
    configured: boolean;
    transport: "console" | "smtp-ssl";
};
/** Caller holds the Host-wide lock. Input is an on-Host staged path, never argv credentials. */
export declare function configureObservabilityMail(host: HostHelperHost, stagedFile: unknown): Promise<{
    mail: {
        configured: boolean;
        transport: "console" | "smtp-ssl";
    };
    applyRequired: boolean;
}>;
export declare function observabilityMailEnvironment(mail: HostObservabilityMail | null, domain: string): {
    EMAIL_URL: string;
    DEFAULT_FROM_EMAIL: string;
};
//# sourceMappingURL=host-observability-mail.d.ts.map