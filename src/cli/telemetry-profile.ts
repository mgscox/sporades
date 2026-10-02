import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateTracePropagationOrigins } from "../telemetry-propagation-policy.js";
import type { RuntimeTelemetryConfig } from "../runtime-telemetry.js";
import { commandError } from "./cli-support.js";

export type TelemetryProfile = {
  tracePropagationOrigins?: string[];
  endpoint: string;
  dashboard?: string;
  tls: { mode: "verified" | "loopback"; caFile?: string };
  credentialEnv?: string;
  metricsIntervalMs?: number;
  eventLoopDelayResolutionMs?: number;
};

const aliasPattern = /^[a-z][a-z0-9-]{0,39}$/;
const envPattern = /^[A-Z][A-Z0-9_]{0,79}$/;

function profilePath() {
  const configDir = process.env.SPORADES_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".config"), "sporades");
  return path.join(configDir, "telemetry.json");
}

function invalid(hint: string): never { throw commandError("Invalid Telemetry profile.", hint); }

export function validateTelemetryProjectConfig(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "profile")) {
    invalid("Set `telemetry` to `{ \"profile\": \"name\" }` in sporades.json.");
  }
  const profile = (value as { profile?: unknown }).profile;
  if (typeof profile !== "string" || !aliasPattern.test(profile)) invalid("Set `telemetry.profile` to a registered Telemetry profile name.");
}

export function validateTelemetryProfile(value: unknown): TelemetryProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Provide an endpoint, TLS mode and optional references.");
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some((key) => !["endpoint", "dashboard", "tls", "credentialEnv", "metricsIntervalMs", "eventLoopDelayResolutionMs", "tracePropagationOrigins"].includes(key))) invalid("Remove unsupported Telemetry profile fields.");
  if (typeof profile.endpoint !== "string" || profile.endpoint.length > 2048) invalid("Use an OTLP/HTTP base URL without credentials or query strings.");
  let url: URL;
  try { url = new URL(profile.endpoint); } catch { return invalid("Use a valid OTLP/HTTP base URL."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["http:", "https:"].includes(url.protocol)) invalid("Use an OTLP/HTTP origin without credentials, path, query or fragment.");
  const tls = profile.tls;
  if (!tls || typeof tls !== "object" || Array.isArray(tls)) invalid("Set TLS mode to verified or loopback.");
  const trust = tls as Record<string, unknown>;
  if (Object.keys(trust).some((key) => !["mode", "caFile"].includes(key))) invalid("Remove unsupported TLS trust fields.");
  if (trust.mode !== "verified" && trust.mode !== "loopback") invalid("Set TLS mode to verified or loopback.");
  if (trust.mode === "verified" && url.protocol !== "https:") invalid("Verified Telemetry profiles require HTTPS.");
  if (trust.mode === "loopback" && (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) invalid("Loopback Telemetry profiles require an HTTP loopback address.");
  if (trust.caFile !== undefined && (trust.mode !== "verified" || typeof trust.caFile !== "string" || !path.isAbsolute(trust.caFile) || trust.caFile.length > 1024)) invalid("Use an absolute private CA file path with verified TLS.");
  if (profile.credentialEnv !== undefined && (typeof profile.credentialEnv !== "string" || !envPattern.test(profile.credentialEnv))) invalid("Use an uppercase credential environment reference such as TRACE_INGEST_TOKEN.");
  if (profile.metricsIntervalMs !== undefined && (!Number.isSafeInteger(profile.metricsIntervalMs) || (profile.metricsIntervalMs as number) < 5_000 || (profile.metricsIntervalMs as number) > 300_000)) invalid("Use a metrics export interval from 5000 to 300000 milliseconds.");
  if (profile.eventLoopDelayResolutionMs !== undefined && (!Number.isSafeInteger(profile.eventLoopDelayResolutionMs) || (profile.eventLoopDelayResolutionMs as number) < 10 || (profile.eventLoopDelayResolutionMs as number) > 1000)) invalid("Use an event-loop delay resolution from 10 to 1000 milliseconds.");
  if (profile.dashboard !== undefined) {
    if (typeof profile.dashboard !== "string" || profile.dashboard.length > 2048) invalid("Use a dashboard HTTPS URL without embedded credentials.");
    let dashboard: URL;
    try { dashboard = new URL(profile.dashboard); } catch { return invalid("Use a valid dashboard URL."); }
    if (dashboard.protocol !== "https:" || dashboard.username || dashboard.password || dashboard.search || dashboard.hash) invalid("Use a dashboard HTTPS URL without credentials, query or fragment.");
  }
  if (profile.tracePropagationOrigins !== undefined) {
    try { profile.tracePropagationOrigins = validateTracePropagationOrigins(profile.tracePropagationOrigins); }
    catch { invalid("Use at most 32 exact HTTP/HTTPS origins without credentials, paths, queries or fragments."); }
  }
  return profile as TelemetryProfile;
}

export async function readTelemetryProfiles(): Promise<Record<string, TelemetryProfile>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(profilePath(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw commandError("Invalid Telemetry profile configuration.", "Inspect or replace the Sporades telemetry.json profile file.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "profiles") || (value as any).schemaVersion !== 1) invalid("Use a schemaVersion 1 Telemetry profile file.");
  const profiles = (value as any).profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) invalid("Use an object of named Telemetry profiles.");
  return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => {
    if (!aliasPattern.test(name)) invalid("Use lower-case Telemetry profile names containing letters, digits and hyphens.");
    return [name, validateTelemetryProfile(profile)];
  }));
}

async function writeTelemetryProfiles(profiles: Record<string, TelemetryProfile>) {
  const target = profilePath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, profiles }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    throw error;
  }
}

export async function changeTelemetryProfile(operation: "add" | "remove", name: string, profile?: TelemetryProfile) {
  if (!aliasPattern.test(name)) invalid("Use a lower-case profile name containing letters, digits and hyphens.");
  const profiles = await readTelemetryProfiles();
  if (operation === "add") {
    if (!profile) invalid("Provide a Telemetry profile.");
    if (Object.hasOwn(profiles, name)) throw commandError("Telemetry profile already exists.", "Use another name or remove the existing profile first.");
    profiles[name] = validateTelemetryProfile(profile);
  } else {
    if (!Object.hasOwn(profiles, name)) throw commandError("Unknown Telemetry profile.", "Run `sporades telemetry profile list` to inspect registered names.");
    delete profiles[name];
  }
  await writeTelemetryProfiles(profiles);
  return operation === "add" ? profiles[name] : null;
}

export async function resolveLocalTelemetryConfig(config: { name?: string; telemetry?: { profile?: string } }, sessionProfile?: string | null): Promise<RuntimeTelemetryConfig | null> {
  validateTelemetryProjectConfig(config.telemetry);
  const name = sessionProfile ?? config.telemetry?.profile;
  if (!name) return null;
  if (!aliasPattern.test(name)) invalid("Select a registered Telemetry profile name.");
  const profiles = await readTelemetryProfiles();
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!profile) throw commandError("Unknown Telemetry profile.", "Register the selected Telemetry profile before starting this session.");
  if (profile.credentialEnv && !process.env[profile.credentialEnv]) throw commandError("Telemetry ingestion credential is unavailable.", `Set the environment variable referenced by Telemetry profile ${name}.`);
  return { ...(profile.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: profile.tracePropagationOrigins } : {}), endpoint: profile.endpoint, tls: profile.tls, credentialEnv: profile.credentialEnv, serviceName: typeof config.name === "string" ? config.name : "sporades-capsule", environment: "dev", metricsIntervalMs: profile.metricsIntervalMs, eventLoopDelayResolutionMs: profile.eventLoopDelayResolutionMs };
}

/** Docker loopback is the Capsule itself; route an explicitly local profile to its Host. */
export async function resolveContainerTelemetryConfig(config: { name?: string; telemetry?: { profile?: string } }, sessionProfile?: string | null): Promise<RuntimeTelemetryConfig | null> {
  if (sessionProfile === null) return null;
  const resolved = await resolveLocalTelemetryConfig(config, sessionProfile);
  if (!resolved) return null;
  return toContainerTelemetryConfig(resolved);
}

export function toContainerTelemetryConfig(resolved: RuntimeTelemetryConfig): RuntimeTelemetryConfig {
  const endpoint = new URL(resolved.endpoint);
  if (resolved.tls.mode === "loopback") endpoint.hostname = "host.docker.internal";
  return {
    ...resolved,
    environment: "container",
    endpoint: endpoint.toString(),
    tls: resolved.tls.caFile ? { ...resolved.tls, caFile: "/run/sporades/telemetry-ca.pem" } : resolved.tls,
  };
}
