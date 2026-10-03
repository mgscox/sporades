/** A Host-owned launch decision; project config and Server env never supply these fields. */
export function hostedTelemetryConfig(connection, capsule) {
    if (!connection || capsule.telemetry?.disabled === true)
        return null;
    if (connection.internalEndpoint !== "http://sporades-telemetry:4318/")
        throw new Error("Invalid Host Telemetry relay endpoint.");
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
export function hostedTelemetryCoverage(desired, running, runtime, expectedServiceName, expectedConfigHash) {
    if (!running)
        return { state: desired ? "pending-start" : "disabled", restartRequired: false };
    if (!runtime || runtime.supported !== true)
        return { state: "unverified", restartRequired: null };
    if (runtime.enabled !== desired || (desired && runtime.serviceName !== expectedServiceName) || (expectedConfigHash && runtime.configHash !== expectedConfigHash))
        return { state: "pending-restart", restartRequired: true };
    return { state: desired ? "instrumented" : "disabled", restartRequired: false };
}
//# sourceMappingURL=hosted-telemetry-coverage.js.map