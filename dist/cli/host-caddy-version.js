import { spawnSync } from "node:child_process";
import { helperError } from "./cli-support.js";
// 2.9.1 is the first release that parses every construct Sporades generates:
// the global `metrics` option (2.9.0) and `match` blocks in `header` (2.9.1).
// Older releases accept a `match` block as a literal `Match` response header.
export const MINIMUM_CADDY_VERSION = "2.9.1";
export const CADDY_UPGRADE_HINT = `Install Caddy ${MINIMUM_CADDY_VERSION} or newer from the official Caddy apt repository (see "Upgrade Caddy on an existing Host" in docs/server-installation.md); distribution packages such as Ubuntu's 2.6.2 are too old.`;
/** Reads `caddy version` output such as `v2.11.9 h1:...` or the distro form `2.6.2`. */
export function parseCaddyVersion(output) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(String(output ?? "").trim());
    return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}
export function caddyVersionSupported(version) {
    const actual = version.split(".").map(Number);
    const minimum = MINIMUM_CADDY_VERSION.split(".").map(Number);
    for (let index = 0; index < minimum.length; index += 1) {
        if (actual[index] !== minimum[index])
            return actual[index] > minimum[index];
    }
    return true;
}
export function inspectCaddyVersion(timeout = 30_000) {
    const result = spawnSync("caddy", ["version"], { encoding: "utf8", timeout });
    const available = !result.error && result.status === 0;
    const version = available ? parseCaddyVersion(result.stdout) : null;
    return { available, version, minimumVersion: MINIMUM_CADDY_VERSION, supported: version !== null && caddyVersionSupported(version) };
}
/** Refuses to generate or apply Caddy configuration on a Host whose Caddy is too old. */
export function assertSupportedCaddy(retry, timeout) {
    const status = inspectCaddyVersion(timeout);
    if (status.supported)
        return;
    throw helperError(status.version
        ? `Caddy ${status.version} is older than the minimum supported version ${MINIMUM_CADDY_VERSION}.`
        : "Could not determine the installed Caddy version.", `${CADDY_UPGRADE_HINT} Then ${retry}.`);
}
//# sourceMappingURL=host-caddy-version.js.map