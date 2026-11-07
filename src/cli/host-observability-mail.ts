import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { helperError } from "./cli-support.js";
import { trustedBackupPath } from "./host-backups.js";
import type { HostHelperHost } from "./hosted-capsule-contract.js";

export type HostObservabilityMail =
  | { version: 1; transport: "console" }
  | { version: 1; transport: "smtp-ssl"; host: string; port: number; username: string; password: string; from: string };

function fail(): never {
  throw helperError("Invalid protected GlitchTip mail configuration.", "Stage a helper-owned mode-0600 regular JSON file in protected directories. Use version 1 and transport console, or smtp-ssl with host, port, username, password and from. Values and provider diagnostics are omitted.");
}
const dns = (v: unknown): v is string => typeof v === "string" && v.length <= 253 && v.includes(".") && !/^[0-9.]+$/.test(v) && v.split(".").every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
export function validateObservabilityMail(value: unknown): HostObservabilityMail {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const v = value as Record<string, unknown>;
    const keys = v.transport === "console" ? ["version", "transport"] : ["version", "transport", "host", "port", "username", "password", "from"];
    if (v.version !== 1 || Object.keys(v).sort().join() !== keys.sort().join()) return fail();
    if (v.transport === "console") return { version: 1, transport: "console" };
    if (v.transport !== "smtp-ssl" || !dns(v.host) || !Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535) return fail();
    for (const name of ["username", "password", "from"]) {
      const text = v[name];
      if (typeof text !== "string" || !text.length || text.length > 1024 || /[^\x20-\x7e]/.test(text)) return fail();
    }
    if (typeof v.from !== "string" || v.from.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[^@]+$/.test(v.from) || !dns(v.from.split("@")[1])) return fail();
    const local = v.from.split("@")[0];
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..") || local.length > 64) return fail();
    return { version: 1, transport: "smtp-ssl", host: v.host, port: Number(v.port), username: v.username as string, password: v.password as string, from: v.from };
  } catch { return fail(); }
}
export function observabilityMailFile(host: HostHelperHost) {
  return path.join(host.remoteRoot, "hosts", host.domain, "services", "observability", "mail.json");
}
async function readProtected(file: string): Promise<HostObservabilityMail> {
  await trustedBackupPath(file, true);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o600 || s.size > 8192) return fail();
    const bytes = await handle.readFile();
    if (bytes.length > 8192) return fail();
    return validateObservabilityMail(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { await handle.close(); }
}
export async function readObservabilityMail(host: HostHelperHost): Promise<HostObservabilityMail | null> {
  try { return await readProtected(observabilityMailFile(host)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail();
  }
}
export function observabilityMailStatus(mail: HostObservabilityMail | null) {
  // Deliberately omit all operator text, including usernames and sender addresses.
  return { configured: mail?.transport === "smtp-ssl", transport: mail?.transport ?? "console" };
}
/** Caller holds the Host-wide lock. Input is an on-Host staged path, never argv credentials. */
export async function configureObservabilityMail(host: HostHelperHost, stagedFile: unknown) {
  try {
    if (typeof stagedFile !== "string" || !path.isAbsolute(stagedFile) || path.normalize(stagedFile) !== stagedFile) return fail();
    const mail = await readProtected(stagedFile);
    const file = observabilityMailFile(host), directory = path.dirname(file);
    // Check existing ancestors before mkdir, including when the destination is absent.
    try { await trustedBackupPath(directory, true); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await trustedBackupPath(directory, true);
    try {
      await lstat(file);
      await readProtected(file);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(mail) + "\n");
      await handle.sync();
      await rename(temporary, file);
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await handle.close(); await rm(temporary, { force: true }); }
    return { mail: observabilityMailStatus(mail), applyRequired: true };
  } catch { return fail(); }
}
export function observabilityMailEnvironment(mail: HostObservabilityMail | null, domain: string) {
  return mail?.transport === "smtp-ssl"
    ? { EMAIL_URL: `smtp+ssl://${encodeURIComponent(mail.username)}:${encodeURIComponent(mail.password)}@${mail.host}:${mail.port}`, DEFAULT_FROM_EMAIL: mail.from.replace(/\$/g, () => "$$") }
    : { EMAIL_URL: "consolemail://", DEFAULT_FROM_EMAIL: `ops@${domain}` };
}
