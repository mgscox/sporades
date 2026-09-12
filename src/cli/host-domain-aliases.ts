import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";

/** Exact hostnames only: never interpolate caller-controlled Caddy syntax. */
export function validateAliasDomains(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((hostname) =>
    typeof hostname !== "string" || hostname.length > 253 || !hostname.includes(".")
    || /^[0-9.]+$/.test(hostname)
    || !hostname.split(".").every((label: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw helperError("Invalid Hosted Capsule alias domains.",
      "Supply at most 20 unique lowercase DNS hostnames, without schemes, ports, paths, wildcards, or IP addresses.");
  }
  if (new Set(value).size !== value.length) {
    throw helperError("Duplicate Hosted Capsule alias domain.", "Supply each alias domain once.");
  }
  return [...value];
}

/** Caller holds the Host-wide route flock, including during bootstrap. */
export async function assertHostnamesAvailable(remoteRoot: string, hostnames: string[], owner: string) {
  const wanted = new Set(hostnames.map((hostname) => hostname.replace(/:\d+$/, "")));
  if (wanted.size !== hostnames.length) {
    throw helperError("Duplicate Hosted Capsule hostname.", "An alias must differ from the Capsule subdomain.");
  }
  const assertUnclaimed = (hostname: string, claimant: string) => {
    if (claimant !== owner && wanted.has(hostname.replace(/:\d+$/, ""))) {
      throw helperError("Hosted Capsule hostname is already reserved.",
        `Choose another hostname; ${hostname} belongs to ${claimant}.`);
    }
  };
  const entries = async (directory: string) => readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
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
    if (domain.isSymbolicLink()) throw helperError("Cannot inspect Hosted domain ownership.", "Replace symbolic links in the Host registry with canonical directories.");
    if (!domain.isDirectory()) continue;
    for (const collection of ["capsules", "registration-claims"]) {
      const directory = path.join(remoteRoot, "hosts", domain.name, "registry", collection);
      for (const entry of await entries(directory)) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile()) throw helperError("Cannot inspect Hosted Capsule ownership.", "Repair the Host registry before registering domains.");
        const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
        if (record.domain !== domain.name || record.subname !== entry.name.slice(0, -5)) {
          throw helperError("Invalid Hosted Capsule registry identity.", "Repair the Host registry before registering domains.");
        }
        if (collection === "capsules" && record.status === "unregistered") continue;
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
