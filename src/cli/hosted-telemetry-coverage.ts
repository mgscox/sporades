import type { RuntimeTelemetryConfig } from "../runtime-telemetry.js";

type Connection = { tracePropagationOrigins?: string[]; internalEndpoint: string; metricsIntervalMs?: number; eventLoopDelayResolutionMs?: number } | null;
type Capsule = { domain: string; subname: string; telemetry?: { disabled?: boolean } };

/** A Host-owned launch decision; project config and Server env never supply these fields. */
export function hostedTelemetryConfig(connection: Connection, capsule: Capsule): RuntimeTelemetryConfig | null {
  if (!connection || capsule.telemetry?.disabled === true) return null;
  if (connection.internalEndpoint !== "http://sporades-telemetry:4318/") throw new Error("Invalid Host Telemetry relay endpoint.");
  return {
    ...(connection.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: connection.tracePropagationOrigins } : {}),
    endpoint: connection.internalEndpoint,
    tls: { mode: "loopback" },
    serviceName: `${capsule.domain}/${capsule.subname}`,
    environment: "hosted",
    ...(connection.metricsIntervalMs ? { metricsIntervalMs: connection.metricsIntervalMs } : {}),
    ...(connection.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: connection.eventLoopDelayResolutionMs } : {}),
  };
}

export function hostedTelemetryCoverage(desired: boolean, running: boolean, runtime: { supported: boolean; enabled: boolean; serviceName?: string; configHash?: string } | null, expectedServiceName?: string, expectedConfigHash?: string) {
  if (!running) return { state: desired ? "pending-start" : "disabled", restartRequired: false };
  if (!runtime || runtime.supported !== true) return { state: "unverified", restartRequired: null };
  if (runtime.enabled !== desired || (desired && runtime.serviceName !== expectedServiceName) || (expectedConfigHash && runtime.configHash !== expectedConfigHash)) return { state: "pending-restart", restartRequired: true };
  return { state: desired ? "instrumented" : "disabled", restartRequired: false };
}
