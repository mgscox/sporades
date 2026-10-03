import { request } from "node:https";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { helperError } from "./cli-support.js";
import type { HostRelayConnection } from "./host-telemetry-relay.js";

export type DiagnosticCheck = { state: "passed" | "failed" | "unavailable" | "unsupported"; reason?: string };
export type TelemetryDeliveryChecks = Record<"configuration" | "agentReadiness" | "dns" | "tls" | "authentication" | "otlpAcceptance" | "relayAcceptance" | "recentIngestion" | "backendQuery", DiagnosticCheck>;
export const unavailable = (reason: string): DiagnosticCheck => ({ state: "unavailable", reason });
export const passed = (): DiagnosticCheck => ({ state: "passed" });
export const failed = (reason: string): DiagnosticCheck => ({ state: "failed", reason });
export function validateQueryCredential(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096 || !/^[^:\x00-\x20\x7f]+:[^\x00-\x1f\x7f]+$/.test(value)) {
    throw helperError("Invalid operator query credential.", "Supply a protected environment reference containing the Monitoring operator user:password; ingestion tokens cannot query.");
  }
  return value;
}
export function diagnosticTrace() {
  const traceId = randomBytes(16).toString("hex");
  const now = BigInt(Date.now()) * 1_000_000n;
  return { traceId, body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "sporades-host-relay-check" } }] }, scopeSpans: [{ spans: [{ traceId, spanId: randomBytes(8).toString("hex"), name: "sporades.host.relay.check", kind: 1, startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1_000_000n) }] }] }] }) };
}

// Bound DNS, handshake, headers and the entire body by one deadline. Never
// expose destination text, response bodies, underlying errors or redirects.
async function exchange(connection: Pick<HostRelayConnection, "endpoint" | "caPem">, pathname: string, authorization: string, body?: string) {
  let dns = isIP(new URL(connection.endpoint).hostname.replace(/^\[|\]$/g, "")) ? passed() : unavailable("not-reached");
  let tls = unavailable("not-reached");
  return new Promise<{ dns: DiagnosticCheck; tls: DiagnosticCheck; status?: number; body?: string; failure?: string }>(resolve => {
    let done = false;
    const finish = (value: { status?: number; body?: string; failure?: string }) => {
      if (done) return; done = true; clearTimeout(deadline); resolve({ dns, tls, ...value });
    };
    const req = request(new URL(pathname, connection.endpoint), { method: body === undefined ? "GET" : "POST", ...(connection.caPem ? { ca: connection.caPem } : {}), headers: { authorization, ...(body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; if (Buffer.byteLength(text) > 8192) req.destroy(new Error("oversize")); });
      res.on("end", () => finish({ status: res.statusCode, body: text }));
      res.on("error", () => finish({ failure: "network" }));
      res.on("aborted", () => finish({ failure: "network" }));
    });
    const deadline = setTimeout(() => { finish({ failure: "timeout" }); req.destroy(); }, 5000);
    req.on("socket", socket => {
      socket.on("lookup", error => { dns = error ? failed("dns") : passed(); });
      socket.on("secureConnect", () => { dns = passed(); tls = passed(); });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      const code = String(error.code);
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") dns = failed("dns");
      if (code.startsWith("ERR_TLS") || code.includes("CERT") || code.includes("SSL")) tls = failed("tls");
      finish({ failure: dns.state === "failed" ? "dns" : tls.state === "failed" ? "tls" : "network" });
    });
    req.end(body);
  });
}
export async function probeTelemetryDestination(connection: HostRelayConnection) {
  const probe = diagnosticTrace();
  const response = await exchange(connection, "/v1/traces", `Bearer ${connection.credential}`, probe.body);
  let accepted = false;
  let reason = response.failure ?? "destination";
  if (response.status && response.status >= 200 && response.status < 300) {
    try {
      const data = JSON.parse(response.body || "{}");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      const partial = data.partialSuccess;
      if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial) || (partial.rejectedSpans !== undefined && String(partial.rejectedSpans) !== "0") || partial.errorMessage)) reason = "partial-rejection";
      else accepted = true;
    } catch { reason = "invalid-acceptance"; }
  }
  const auth = response.status === 401 || response.status === 403 ? failed("auth") : accepted ? passed() : unavailable("not-proven");
  const stage = auth.state === "failed" ? "auth" : accepted ? "accepted" : reason;
  return { traceId: probe.traceId, accepted, stage, ...(response.status ? { statusCode: response.status } : {}), checks: { dns: response.dns, tls: response.tls, authentication: auth, otlpAcceptance: accepted ? passed() : failed(stage) } };
}
export async function queryDiagnosticTrace(connection: Pick<HostRelayConnection, "endpoint" | "caPem">, traceId: string, queryCredential?: string) {
  if (!queryCredential) return { backendQuery: unavailable("operator-authority-required"), recentIngestion: unavailable("operator-authority-required") };
  const deadline = Date.now() + 5000;
  do {
    const response = await exchange(connection, `/v1/diagnostics/traces/${traceId}`, `Basic ${Buffer.from(queryCredential).toString("base64")}`);
    if (response.status === 404 || response.status === 405) return { backendQuery: { state: "unsupported" as const, reason: "gateway-upgrade-required" }, recentIngestion: unavailable("query-unsupported") };
    if (response.status === 401 || response.status === 403) return { backendQuery: failed("operator-auth"), recentIngestion: unavailable("operator-auth") };
    if (response.status !== 200) return { backendQuery: unavailable("backend-unavailable"), recentIngestion: unavailable("backend-unavailable") };
    try {
      const value = JSON.parse(response.body ?? "");
      if (value.ok !== true || typeof value.data?.queryVisible !== "boolean" || typeof value.data?.recent !== "boolean" || (value.data.recent && !value.data.queryVisible)) throw new Error();
      if (value.data.queryVisible) return { backendQuery: passed(), recentIngestion: value.data.recent ? passed() : failed("stale-probe") };
    } catch { return { backendQuery: unavailable("invalid-query-response"), recentIngestion: unavailable("invalid-query-response") }; }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  return { backendQuery: failed("probe-not-visible"), recentIngestion: failed("probe-not-visible") };
}

export async function probeInventoryDestination(connection: HostRelayConnection, host: string) {
  if (!connection.inventoryCredential) return failed("inventory-authority-required");
  const response = await exchange(connection, `/v1/inventory/${host}`, `Bearer ${connection.inventoryCredential}`);
  if (response.status === 401 || response.status === 403) return failed("inventory-auth");
  if (response.status !== 200) return unavailable("inventory-unavailable");
  try { if (JSON.parse(response.body ?? "").ok !== true) throw new Error(); }
  catch { return failed("invalid-inventory-response"); }
  return passed();
}
