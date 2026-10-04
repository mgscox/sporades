import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validClientAddressNetwork, clientAddressMatches } from "./client-address.js";
import { createAdmissionRateLimiter } from "./admission-rate-limit.js";
import { createAdmissionEvidence } from "./admission-evidence.js";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { readDeployFile, resolveDeployFiles, preservedDeployFilePath, type BuiltDeployFile } from "./deploy-files.js";

export const ADMISSION_LIMITS = Object.freeze({ bytes: 65536, depth: 8, rules: 128, conditions: 16, textBytes: 1024, reloadMs: 2000 });
export type { AdmissionCondition, AdmissionAction, AdmissionPolicy, AdmissionGeneration, AdmissionHealth } from "../src/types/admission-policy.js";
import type { AdmissionGeneration, AdmissionHealth } from "../src/types/admission-policy.js";
const invalid = (): never => { throw new Error("Invalid admission policy."); };
function object(value: any, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function text(value: any): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= ADMISSION_LIMITS.textBytes && !/[\x00-\x1f\x7f]/.test(value); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function depth(value: unknown, level = 0) { if (level > ADMISSION_LIMITS.depth) invalid(); if (value && typeof value === "object") for (const child of Object.values(value)) depth(child, level + 1); }
function isCanonicalPolicyPathname(target: string) {
  try { return canonicalAdmissionPathname(target) === target; } catch { return false; }
}
const controls = ["/__sporades/health/runtime", "/__sporades/connection-token"];
function condition(value: any) {
  object(value, ["kind", "value", "exact", "prefix", "name"]);
  switch (value.kind) {
    case "method": object(value, ["kind", "value"]); if (!text(value.value) || !/^[A-Z]{1,32}$/.test(value.value)) invalid(); break;
    case "pathname": {
      object(value, ["kind", "exact", "prefix"]);
      const target = value.exact ?? value.prefix;
      if ((value.exact !== undefined) === (value.prefix !== undefined) || !text(target) || !target.startsWith("/") || target.startsWith("//") || /[\\?#%]/.test(target) || !isCanonicalPolicyPathname(target)) invalid();
      if (controls.some(control => value.exact === control || (value.prefix !== undefined && (control === target || control.startsWith(target.endsWith("/") ? target : `${target}/`))))) invalid();
      break;
    }
    case "address": {
      object(value, ["kind", "value"]); if (!text(value.value)) invalid();
      if (!validClientAddressNetwork(value.value)) invalid();
      break;
    }
    case "header":
      object(value, ["kind", "name", "value"]);
      if (!text(value.name) || !/^[a-z0-9!#$&'*+.^_`|~-]+$/.test(value.name) || /^(host|connection|proxy-.*|authorization|cookie|set-cookie|forwarded|via|true-client-ip|x-real-ip|x-forwarded-.*|x-sporades-.*|cf-.*)$/.test(value.name) || (value.value !== undefined && (typeof value.value !== "string" || Buffer.byteLength(value.value) > ADMISSION_LIMITS.textBytes || /[\x00-\x1f\x7f]/.test(value.value) || /^[ \t]|[ \t]$/.test(value.value)))) invalid();
      break;
    case "query-key": object(value, ["kind", "name"]); if (!text(value.name)) invalid(); break;
    default: invalid();
  }
}
export function parseAdmissionPolicy(bytes: Buffer): AdmissionGeneration {
  if (bytes.length > ADMISSION_LIMITS.bytes) invalid();
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) invalid();
  let value: any; try { value = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
  depth(value); object(value, ["version", "rules"]);
  if (value.version !== 1 || !Array.isArray(value.rules) || value.rules.length > ADMISSION_LIMITS.rules) invalid();
  const ids = new Set<string>();
  for (const rule of value.rules) {
    object(rule, ["id", "enabled", "conditions", "action"]);
    if (typeof rule.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(rule.id) || ids.has(rule.id) || typeof rule.enabled !== "boolean" || !Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > ADMISSION_LIMITS.conditions) invalid();
    ids.add(rule.id); for (const item of rule.conditions) condition(item);
    object(rule.action, ["kind", "limit", "windowMs"]);
    if (rule.action.kind === "deny") object(rule.action, ["kind"]);
    else if (rule.action.kind === "rate-limit") {
      if (!Number.isSafeInteger(rule.action.limit) || rule.action.limit < 1 || rule.action.limit > 1000000 || !Number.isSafeInteger(rule.action.windowMs) || rule.action.windowMs < 1000 || rule.action.windowMs > 86400000) invalid();
    } else invalid();
  }
  return freeze({ digest: createHash("sha256").update(bytes).digest("hex"), policy: value });
}
/** Admission uses the raw pathname, with explicit decode-once and dot-segment rules. */
export function canonicalAdmissionPathname(raw: string): string {
  if (raw === "*") return raw;
  if (!raw.startsWith("/") || /[\\?#\x00-\x20\x7f]|%2f|%5c/i.test(raw)) throw new Error("Invalid admission pathname.");
  const decoded = decodeURIComponent(raw);
  if (/[\x00-\x1f\x7f]|%[0-9a-f]{2}/i.test(decoded)) throw new Error("Invalid admission pathname.");
  const segments = decoded.slice(1).split("/");
  const output: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === "." || segment === "..") {
      if (segment === "..") output.pop();
      if (index === segments.length - 1) output.push("");
    } else output.push(segment);
  }
  return `/${output.join("/")}`;
}
function pathnameMatches(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}
/** Trusted HTTP boundary input; rawHeaders preserves duplicates discarded by Node's headers map. */
export type AdmissionHttpInput = {
  method: string;
  pathname: string;
  query: string;
  rawHeaders: readonly string[];
  /** Canonical identity authenticated by the Host boundary, never a public header. */
  trustedAddress?: string | null;
};
/** Ordered AND evaluation. Unsupported conditions are indeterminate, never permission to admit. */
export function matchHttpAdmissionRule(generation: AdmissionGeneration, input: AdmissionHttpInput) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(input.method)) throw new Error("Invalid admission method.");
  const method = input.method.toUpperCase();
  const pathname = canonicalAdmissionPathname(input.pathname);
  // Validate even ignored query values: URLSearchParams would silently repair bad UTF-8/escapes.
  const query = decodeURIComponent(input.query.replace(/\+/g, " "));
  if (/[\x00-\x1f\x7f]/.test(query)) throw new Error("Invalid admission query.");
  const queryKeys = new Set(input.query.split("&").filter(Boolean).map(part => decodeURIComponent(part.split("=", 1)[0].replace(/\+/g, " "))));
  const headers = new Map<string, string[]>();
  if (!Array.isArray(input.rawHeaders) || input.rawHeaders.length % 2) throw new Error("Invalid admission headers.");
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    const name = input.rawHeaders[index].toLowerCase();
    const value = input.rawHeaders[index + 1].replace(/^[ \t]+|[ \t]+$/g, "");
    if (!/^[a-z0-9!#$&'*+.^_`|~-]+$/.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error("Invalid admission headers.");
    const values = headers.get(name);
    if (values) values.push(value); else headers.set(name, [value]);
  }
  for (const rule of generation.policy.rules) {
    if (!rule.enabled) continue;
    let matches = true;
    let indeterminate = false;
    for (const item of rule.conditions) {
      switch (item.kind) {
        case "method": if (method !== item.value) matches = false; break;
        case "pathname": if (!("exact" in item ? pathname === item.exact : pathnameMatches(pathname, item.prefix))) matches = false; break;
        case "header": {
          const values = headers.get(item.name);
          if (!values) matches = false;
          else if (item.value !== undefined) {
            // Never match Node's joined/discarded representation as one caller-controlled value.
            if (values.length !== 1) indeterminate = true;
            else if (values[0] !== item.value) matches = false;
          }
          break;
        }
        case "query-key": if (!queryKeys.has(item.name)) matches = false; break;
        case "address":
          if (!input.trustedAddress) indeterminate = true;
          else if (!clientAddressMatches(input.trustedAddress, item.value)) matches = false;
          break;
      }
    }
    if (!matches) continue;
    if (indeterminate) throw new Error("Indeterminate admission condition.");
    return rule;
  }
  return null;
}

export function resolveAdmissionPolicy(value: unknown, files: unknown = undefined): string | null {
  if (value === undefined) return null;
  object(value, ["path"]);
  const relative = resolveDeployFiles([{ path: (value as any).path }])[0].path;
  const name = relative.normalize("NFC").toLowerCase();
  if (resolveDeployFiles(files).some(file => { const other = file.path.normalize("NFC").toLowerCase(); return other === name || other.startsWith(`${name}/`) || name.startsWith(`${other}/`); })) throw new Error("Admission policy overlaps deploy.files.");
  return relative;
}
export function admissionStorageRoot(preservedRoot: string) { return path.join(preservedRoot, "admission"); }
export async function buildAdmissionPolicy(projectDir: string, value: unknown, files?: unknown): Promise<BuiltDeployFile[]> {
  const relative = resolveAdmissionPolicy(value, files); if (!relative) return [];
  const contents = await readDeployFile(projectDir, relative, ADMISSION_LIMITS.bytes);
  parseAdmissionPolicy(contents);
  return [{ path: relative, update: "admission", contents }];
}
// This marker is a publication protocol, never accepted as user policy JSON.
const REMOVED = Buffer.from('{"sporadesAdmissionPublication":1,"removed":true}\n');
export async function publishAdmissionPolicy(root: string, relative: string, bytes: Buffer | null) {
  if (bytes) parseAdmissionPolicy(bytes);
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe admission storage.");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temporary = `.publish-${randomUUID()}`;
  // Linux descriptor paths pin publication to the checked directory.
  const anchored = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : root;
  const target = path.join(anchored, path.basename(preservedDeployFilePath(root, relative)));
  let output;
  try {
    const identity = await handle.stat();
    const named = await lstat(root);
    if (identity.dev !== named.dev || identity.ino !== named.ino || named.isSymbolicLink()) throw new Error("Unsafe admission storage.");
    // Validate existing authority; disappearance is an error, never implicit removal.
    const previous = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) throw new Error("Unsafe admission policy file.");
    output = await open(path.join(anchored, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
    await output.writeFile(bytes ?? REMOVED); await output.chmod(0o444); await output.sync(); await output.close(); output = undefined;
    const current = await lstat(root);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) throw new Error("Unsafe admission storage.");
    await rename(path.join(anchored, temporary), target); await handle.sync();
  } finally { await output?.close(); await rm(path.join(anchored, temporary), { force: true }); await handle.close(); }
}
export type AdmissionReloadEvent = "loaded" | "failure" | "recovery";
export async function openAdmissionPolicy(root: string, relative: string, onHealth?: (health: AdmissionHealth, event: AdmissionReloadEvent) => void, options: Parameters<typeof createAdmissionRateLimiter>[0] & { evidence?: ReturnType<typeof createAdmissionEvidence>; deferActivation?: boolean } = {}) {
  // A Dev session owns evidence across loader replacement. Quota state remains loader-owned.
  const { evidence = createAdmissionEvidence(options.now), deferActivation = false, ...limiterOptions } = options;
  const rateLimiter = createAdmissionRateLimiter({ ...limiterOptions, onEviction: () => evidence.count("limiterEvictions") });
  let active: AdmissionGeneration | null = null;
  let health: AdmissionHealth = Object.freeze({ state: "disabled", digest: null });
  let activated = !deferActivation;
  let recoveryPending = false;
  let closed = false;
  let pending: Promise<void> | null = null;
  function report(state: AdmissionHealth["state"], event: AdmissionReloadEvent, force = false) {
    const next = Object.freeze({ state, digest: active?.digest ?? null });
    if (!force && event === "loaded" && next.state === health.state && next.digest === health.digest) return;
    health = next;
    // Rejected prepared loaders emit failures, but cannot consume the session's recovery.
    if (!activated && event !== "failure") return;
    try { onHealth?.(Object.freeze({ ...health, evidence: evidence.snapshot() }), event); } catch { /* Diagnostics never break reload. */ }
  }
  function recover(state = health.state) {
    if (!activated || !recoveryPending || state === "degraded") return false;
    recoveryPending = false; evidence.count("reloadRecoveries"); return true;
  }
  function activate(previousHealth?: AdmissionHealth) {
    if (activated) return;
    recoveryPending ||= previousHealth?.state === "degraded";
    activated = true;
    report(health.state, recover() ? "recovery" : "loaded", true);
  }
  async function load(cold: boolean) {
    try {
      const bytes = await readDeployFile(root, relative, ADMISSION_LIMITS.bytes);
      const next = bytes.equals(REMOVED) ? null : parseAdmissionPolicy(bytes);
      rateLimiter.reconcile(next);
      active = next;
      const state = next ? "healthy" : "disabled";
      report(state, recover(state) ? "recovery" : "loaded");
    } catch { recoveryPending = true; evidence.count("reloadFailures"); report("degraded", "failure"); if (cold) throw new Error("Configured admission policy could not be loaded."); }
  }
  await load(true);
  const reload = () => {
    if (closed) return Promise.resolve();
    if (!pending) pending = load(false).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void reload(); }, ADMISSION_LIMITS.reloadMs); timer.unref();
  return Object.freeze({ current: () => active, rateLimiter, evidence,
    health: (): AdmissionHealth => Object.freeze({ ...health, rateLimit: rateLimiter.stats(), evidence: evidence.snapshot() }),
    activate, reload, close: async () => { closed = true; clearInterval(timer); await pending; } });
}
