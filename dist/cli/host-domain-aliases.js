import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";
import { trustedBackupPath } from "./host-backups.js";
/** Operator-owned routing intent; never changes the Host or service-data identity. */
export async function readObservabilityAnalyticsDomain(host) {
    const file = path.join(host.remoteRoot, "hosts", host.domain, "services", "observability", "public.json");
    try {
        await trustedBackupPath(file, true);
        const details = await lstat(file);
        if (!details.isFile() || details.nlink !== 1 || details.size > 4096)
            throw new Error();
        const config = JSON.parse(await readFile(file, "utf8"));
        if (!config || Array.isArray(config) || config.version !== 1
            || Object.keys(config).sort().join() !== "analyticsDomain,version")
            throw new Error();
        validateAliasDomains([config.analyticsDomain]);
        return config.analyticsDomain;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return `analytics.${host.domain}`;
        throw helperError("Invalid Host observability public configuration.", "Use a helper-owned mode-0600 public.json with version 1 and one exact lowercase DNS analyticsDomain; do not use symbolic or hard links.");
    }
}
/** Exact hostnames only: never interpolate caller-controlled Caddy syntax. */
export function validateAliasDomains(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 20 || value.some((hostname) => typeof hostname !== "string" || hostname.length > 253 || !hostname.includes(".")
        || /^[0-9.]+$/.test(hostname)
        || !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
        throw helperError("Invalid Hosted Capsule alias domains.", "Supply at most 20 unique lowercase DNS hostnames, without schemes, ports, paths, wildcards, or IP addresses.");
    }
    if (new Set(value).size !== value.length) {
        throw helperError("Duplicate Hosted Capsule alias domain.", "Supply each alias domain once.");
    }
    return [...value];
}
/** Caller holds the Host-wide route flock, including during bootstrap. */
export async function assertHostnamesAvailable(remoteRoot, hostnames, owner) {
    const wanted = new Set(hostnames.map((hostname) => hostname.replace(/:\d+$/, "")));
    if (wanted.size !== hostnames.length) {
        throw helperError("Duplicate Hosted Capsule hostname.", "An alias must differ from the Capsule subdomain.");
    }
    const assertUnclaimed = (hostname, claimant) => {
        if (claimant !== owner && wanted.has(hostname.replace(/:\d+$/, ""))) {
            throw helperError("Hosted Capsule hostname is already reserved.", `Choose another hostname; ${hostname} belongs to ${claimant}.`);
        }
    };
    const entries = async (directory) => readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT")
            return [];
        throw error;
    });
    // Domain includes reserve the health hostname even before any Capsule exists.
    for (const entry of await entries(path.join(remoteRoot, "caddy", "hosts"))) {
        if (entry.name.endsWith(".caddy")) {
            const domain = entry.name.slice(0, -6);
            assertUnclaimed(`host.${domain}`, `health:${domain}`);
        }
    }
    for (const domain of await entries(path.join(remoteRoot, "hosts"))) {
        if (domain.isSymbolicLink())
            throw helperError("Cannot inspect Hosted domain ownership.", "Replace symbolic links in the Host registry with canonical directories.");
        if (!domain.isDirectory())
            continue;
        // The protected intent reserves service hostnames through partial installs and disable.
        const serviceState = path.join(remoteRoot, "hosts", domain.name, "services", "observability", "secrets.json");
        const installed = await readFile(serviceState, "utf8").then(() => true).catch(e => { if (e.code === "ENOENT")
            return false; throw e; });
        if (installed)
            for (const service of ["errors", "analytics"])
                assertUnclaimed(`${service}.${domain.name}`, `observability:${domain.name}`);
        if (installed)
            assertUnclaimed(await readObservabilityAnalyticsDomain({ remoteRoot, domain: domain.name }), `observability:${domain.name}`);
        if (installed) {
            // Desired configuration can change before the locked route replacement.
            // Keep the currently published names reserved throughout that interval.
            const applied = path.join(remoteRoot, "caddy", "hosts", domain.name, "__sporades-observability.caddy");
            let appliedNames = [];
            try {
                await trustedBackupPath(applied);
                const details = await lstat(applied);
                if (!details.isFile() || details.nlink !== 1 || details.uid !== process.geteuid?.() || (details.mode & 0o022))
                    throw new Error();
                const names = [...(await readFile(applied, "utf8")).matchAll(/^([^\s{}]+) \{$/gm)].map(match => match[1]);
                if (names.length !== 2)
                    throw new Error();
                appliedNames = validateAliasDomains(names);
            }
            catch (error) {
                if (error.code !== "ENOENT") {
                    throw helperError("Cannot inspect observability hostname ownership.", "Repair the protected managed observability route before registering hostnames.");
                }
            }
            for (const name of appliedNames)
                assertUnclaimed(name, `observability:${domain.name}`);
        }
        for (const collection of ["capsules", "registration-claims"]) {
            const directory = path.join(remoteRoot, "hosts", domain.name, "registry", collection);
            for (const entry of await entries(directory)) {
                if (!entry.name.endsWith(".json"))
                    continue;
                if (!entry.isFile())
                    throw helperError("Cannot inspect Hosted Capsule ownership.", "Repair the Host registry before registering domains.");
                const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
                if (record.domain !== domain.name || record.subname !== entry.name.slice(0, -5)) {
                    throw helperError("Invalid Hosted Capsule registry identity.", "Repair the Host registry before registering domains.");
                }
                if (collection === "capsules" && record.status === "unregistered")
                    continue;
                const claimant = `${record.domain}/${record.subname}`;
                const aliases = validateAliasDomains(record.aliasDomains);
                const previousAliases = collection === "registration-claims" ? validateAliasDomains(record.previousAliasDomains) : [];
                for (const hostname of [`${record.subname}.${record.domain}`, ...aliases, ...previousAliases]) {
                    assertUnclaimed(hostname, claimant);
                }
            }
        }
    }
}
export function validateCanonicalDomain(value) {
    if (value === undefined || value === null)
        return null;
    validateAliasDomains([value]);
    return value;
}
export function hostedPublicOrigin(record) {
    const domain = validateCanonicalDomain(record.canonicalDomain);
    if (domain && !validateAliasDomains(record.aliasDomains).includes(domain)) {
        throw helperError("Canonical domain is not a registered alias.", "Select one of this Capsule's registered alias domains.");
    }
    return domain ? `https://${domain}` : record.hostedUrl;
}
//# sourceMappingURL=host-domain-aliases.js.map