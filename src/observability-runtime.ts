import { collectionLoaderSource } from "./templates/observability-loader.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactDiagnosticText } from "./runtime-log-policy.js";
import { trustedClientAddress } from "./client-address.js";

type RecordValue = Record<string, any>;

/** Configuration contains env names only; resolved provider credentials stay server-side. */
export function validateObservabilityConfig(config: RecordValue) {
  const fail = () => { const error = new Error("Invalid observability or analytics configuration."); Object.assign(error, { code: "INVALID_OBSERVABILITY_CONFIG" }); throw error; };
  const object = (value: any, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  };
  const envName = (value: any) => typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/i.test(value);
  if (config.observability !== undefined) {
    object(config.observability, ["errors"]);
    if (config.observability.errors !== undefined) {
      const errors = config.observability.errors;
      object(errors, ["protocol", "dsnEnv", "environment", "sampleRate", "client"]);
      if (errors.protocol !== "sentry" || !envName(errors.dsnEnv)
        || (errors.client !== undefined && typeof errors.client !== "boolean")
        || (errors.environment !== undefined && (typeof errors.environment !== "string" || !/^[\w.-]{1,64}$/.test(errors.environment)))
        || (errors.sampleRate !== undefined && (typeof errors.sampleRate !== "number" || !Number.isFinite(errors.sampleRate) || errors.sampleRate < 0 || errors.sampleRate > 1))) fail();
    }
  }
  if (config.analytics !== undefined) {
    const analytics = config.analytics;
    object(analytics, ["provider", "endpointEnv", "websiteIdEnv", "redactQuery"]);
    if (!["umami", "plausible"].includes(analytics.provider) || !envName(analytics.endpointEnv) || !envName(analytics.websiteIdEnv)
      || (analytics.redactQuery !== undefined && analytics.redactQuery !== true)) fail();
  }
}

function providerUrl(value: unknown): URL {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return url;
  } catch { throw Object.assign(new Error("Invalid collection provider configuration."), { code: "INVALID_OBSERVABILITY_CONFIG" }); }
}

/** Always remove queries/fragments, including from callers bypassing the loader. */
function pageUrl(value: unknown, origin: string): URL {
  if (typeof value !== "string" || value.length > 4096) throw new Error();
  const url = new URL(value, origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  url.search = ""; url.hash = "";
  return url;
}

export function createRuntimeObservability(config: RecordValue = {}, env: RecordValue = {}) {
  validateObservabilityConfig(config);
  const analytics = config.analytics;
  // A missing env value leaves the integration dormant, useful in existing Dev sessions.
  const analyticsUrl = analytics && env[analytics.endpointEnv] && env[analytics.websiteIdEnv] ? providerUrl(env[analytics.endpointEnv]) : null;
  const website = analyticsUrl ? env[analytics.websiteIdEnv] : null;
  if (website && (typeof website !== "string" || website.length > 255 || /[\s?#\/]/.test(website))) throw new Error("Invalid collection provider configuration.");
  const errors = config.observability?.errors;
  let sentryUrl: URL | null = null;
  let dsn: string | null = null;
  if (errors && env[errors.dsnEnv]) {
    try {
      const parsed = new URL(env[errors.dsnEnv]);
      const key = parsed.username;
      if (!key || !/^[a-zA-Z0-9_-]+$/.test(key) || parsed.password || parsed.search || parsed.hash) throw new Error();
      parsed.username = "";
      const segments = parsed.pathname.split("/").filter(Boolean);
      const project = segments.pop();
      if (!project || !/^\d+$/.test(project)) throw new Error();
      sentryUrl = providerUrl(parsed.href);
      sentryUrl.pathname = `/${[...segments, "api", project, "envelope", ""].join("/")}`;
      dsn = String(env[errors.dsnEnv]);
    } catch { throw Object.assign(new Error("Invalid collection provider configuration."), { code: "INVALID_OBSERVABILITY_CONFIG" }); }
  }
  const stopped = new AbortController();
  const pending = new Set<Promise<void>>();
  let active = 0, count = 0, windowStart = performance.now();
  const enter = () => {
    const now = performance.now();
    if (now - windowStart >= 60000) { count = 0; windowStart = now; }
    if (stopped.signal.aborted || active >= 8 || count >= 120) return false;
    active++; count++; return true;
  };
  const safeText = (value: unknown, limit: number) => redactDiagnosticText(typeof value === "string" ? value : "Error", env).slice(0, limit);
  const send = async (url: URL, body: string, headers: Record<string, string>) => {
    const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(2000)]) });
    // Provider bodies/headers never flow back to the browser or logs.
    await response.body?.cancel();
  };
  return {
    enabled: !!analyticsUrl || !!(sentryUrl && errors.client),
    clientErrors: !!(sentryUrl && errors.client),
    analytics: !!analyticsUrl,
    capture(error: any, surface: string, address?: string | null) {
      try {
        if (!sentryUrl || error?.sporadesAuthDenialLogData || error?.sporadesAclDenialLogData
          || ["DENIED", "UNAUTHENTICATED", "JOB_CANCELLED", "RESOURCE_CANCELLED"].includes(error?.code)
          || Math.random() >= (errors.sampleRate ?? 1)) return;
        const frames = typeof error?.stack === "string" ? error.stack.slice(0, 8192).split("\n").slice(1, 21).flatMap((line: string) => {
          const match = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
          return match ? [{ filename: safeText(match[2], 512), function: safeText(match[1] || "<anonymous>", 128), lineno: Number(match[3]), colno: Number(match[4]) }] : [];
        }).reverse() : [];
        const event = {
          event_id: randomUUID().replaceAll("-", ""), timestamp: Date.now() / 1000, platform: surface === "client" ? "javascript" : "node", level: "error",
          environment: errors.environment, release: typeof config.release === "string" ? safeText(config.release, 128) : typeof config.release?.id === "string" ? safeText(config.release.id, 128) : undefined,
          tags: { capsule: safeText(config.name ?? "capsule", 128), surface },
          exception: { values: [{ type: "Error", value: safeText(error?.message ?? error, 2048), stacktrace: { frames } }] },
          ...(address ? { user: { ip_address: address } } : {}),
        };
        const payload = JSON.stringify(event);
        const body = `${JSON.stringify({ event_id: event.event_id, dsn })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
        if (!enter()) return;
        const task = send(sentryUrl, body, { "content-type": "application/x-sentry-envelope" }).catch(() => {}).finally(() => { active--; pending.delete(task); });
        pending.add(task);
      } catch { /* Error reporting must never replace the original failure. */ }
    },
    close() { stopped.abort(); },
    async flush() { await Promise.allSettled([...pending]); },
    async collect(input: RecordValue, origin: string, request: IncomingMessage, database: RecordValue) {
      if (input.type === "error") {
        if (!sentryUrl || !errors.client || typeof input.message !== "string" || (input.stack !== undefined && typeof input.stack !== "string")) throw new Error();
        this.capture({ message: input.message, stack: input.stack }, "client", trustedClientAddress(database, request));
        return;
      }
      if (!analyticsUrl || input.type !== "pageview") throw new Error();
      const url = pageUrl(input.url, origin);
      if (url.origin !== origin) throw new Error();
      const referrer = input.referrer ? pageUrl(input.referrer, origin).href : "";
      const address = trustedClientAddress(database, request);
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": safeText(request.headers["user-agent"] ?? "Sporades", 512) };
      if (address) headers["x-forwarded-for"] = address;
      const body = analytics.provider === "umami"
        ? { type: "event", payload: { website, hostname: url.hostname, url: url.pathname, referrer } }
        : { name: "pageview", domain: website, url: url.href, referrer };
      await send(analyticsUrl, JSON.stringify(body), headers);
    },
    enter,
    leave() { active--; },
  };
}

export async function routeCollection(database: RecordValue, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!database.observability?.enabled) return false;
  const pathname = request.url?.split("?")[0];
  if (pathname === "/__sporades/observe.js" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(collectionLoaderSource(database.observability.clientErrors, database.observability.analytics));
    return true;
  }
  if (pathname !== "/__sporades/collect") return false;
  const reply = (code: number) => { response.writeHead(code, { "cache-control": "no-store" }); response.end(); };
  const origin = request.headers.origin;
  try {
    if (request.method !== "POST" || typeof origin !== "string" || new URL(origin).origin !== origin || !["http:", "https:"].includes(new URL(origin).protocol)
      || new URL(origin).host !== request.headers.host || request.headers["sec-fetch-site"] === "cross-site"
      || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { reply(403); return true; }
    const allowed = database.securityPolicy?.cors?.publicOrigin;
    if (allowed && ![allowed, ...(database.securityPolicy.cors.publicAliases ?? [])].includes(origin)) { reply(403); return true; }
  } catch { reply(403); return true; }
  if (!database.observability.enter()) { reply(429); return true; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      (async () => { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 16384) throw new Error(); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks).toString("utf8"); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error()); request.destroy(); }, 2000); }),
    ]);
    clearTimeout(timer);
    const input = JSON.parse(body);
    if (!input || Array.isArray(input) || typeof input !== "object") throw new Error();
    await database.observability.collect(input, origin, request, database);
    reply(204);
  } catch { if (!response.destroyed) reply(400); }
  finally { clearTimeout(timer); database.observability.leave(); }
  return true;
}
