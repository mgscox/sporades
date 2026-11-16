export declare const MINIMUM_CADDY_VERSION = "2.9.1";
export declare const CADDY_UPGRADE_HINT = "Install Caddy 2.9.1 or newer from the official Caddy apt repository (see \"Upgrade Caddy on an existing Host\" in docs/server-installation.md); distribution packages such as Ubuntu's 2.6.2 are too old.";
export type CaddyVersionStatus = {
    available: boolean;
    version: string | null;
    minimumVersion: string;
    supported: boolean;
};
/** Reads `caddy version` output such as `v2.11.9 h1:...` or the distro form `2.6.2`. */
export declare function parseCaddyVersion(output: string): string | null;
export declare function caddyVersionSupported(version: string): boolean;
export declare function inspectCaddyVersion(timeout?: number): CaddyVersionStatus;
/** Refuses to generate or apply Caddy configuration on a Host whose Caddy is too old. */
export declare function assertSupportedCaddy(retry: string, timeout?: number): void;
//# sourceMappingURL=host-caddy-version.d.ts.map