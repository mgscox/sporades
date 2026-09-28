import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { SPORADES_BASE_IMAGE } from "../base-image.js";
import { helperError } from "./cli-support.js";
const RELAY_IMAGE = "otel/opentelemetry-collector-contrib:0.138.0";
const RELAY_NAME = "sporades-telemetry-relay";
const RELAY_ALIAS = "sporades-telemetry";
const RELAY_LABEL = "com.sporades.host-telemetry-relay=true";
const MAX_CA_BYTES = 1024 * 1024;
function invalid() {
    throw helperError("Invalid Host Telemetry connection.", "Use a verified HTTPS OTLP/HTTP origin and a scoped ingestion credential without control characters.");
}
export function validateHostRelayConnection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalid();
    const input = value;
    if (Object.keys(input).some((key) => !["endpoint", "credential", "caPem", "metricsIntervalMs", "eventLoopDelayResolutionMs"].includes(key)))
        invalid();
    if (typeof input.endpoint !== "string" || input.endpoint.length > 2048)
        invalid();
    let url;
    try {
        url = new URL(input.endpoint);
    }
    catch {
        return invalid();
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        invalid();
    if (typeof input.credential !== "string" || !input.credential || input.credential.length > 4096 || /[\x00-\x1f\x7f]/.test(input.credential))
        invalid();
    if (input.caPem !== undefined && (typeof input.caPem !== "string" || Buffer.byteLength(input.caPem) > MAX_CA_BYTES || !input.caPem.includes("-----BEGIN CERTIFICATE-----")))
        invalid();
    if (input.metricsIntervalMs !== undefined && (!Number.isSafeInteger(input.metricsIntervalMs) || input.metricsIntervalMs < 5_000 || input.metricsIntervalMs > 300_000))
        invalid();
    if (input.eventLoopDelayResolutionMs !== undefined && (!Number.isSafeInteger(input.eventLoopDelayResolutionMs) || input.eventLoopDelayResolutionMs < 10 || input.eventLoopDelayResolutionMs > 1000))
        invalid();
    return input;
}
export function renderHostRelayCollectorConfig(options) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
        invalid();
    return `receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\n        max_request_body_size: 2097152\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 96\n    spike_limit_mib: 24\n  batch:\n    send_batch_size: 256\n    timeout: 1s\nexporters:\n  otlphttp/remote:\n    endpoint: ${JSON.stringify(options.endpoint)}\n    headers:\n      Authorization: \"\${env:SPORADES_INGEST_AUTH}\"\n${options.caFile ? "    tls:\n      ca_file: /etc/otelcol/ca.pem\n" : ""}    sending_queue:\n      enabled: true\n      queue_size: 1000\n      num_consumers: 2\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 300s\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/remote]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/remote]\n`;
}
function paths(remoteRoot) {
    if (!path.isAbsolute(remoteRoot) || path.normalize(remoteRoot) !== remoteRoot || remoteRoot === "/")
        invalid();
    const directory = path.join(remoteRoot, "telemetry");
    return { directory, descriptor: path.join(directory, "connection.json"), config: path.join(directory, "collector.yaml"), credential: path.join(directory, "credential.env"), ca: path.join(directory, "ca.pem") };
}
async function assertOwnedDirectory(directory) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || (process.geteuid && details.uid !== process.geteuid()) || (details.mode & 0o077) !== 0) {
        throw helperError("Host Telemetry state is not protected.", "Use a helper-owned telemetry directory with mode 0700 and no symlinks.");
    }
}
async function readProtected(file) {
    try {
        const details = await lstat(file);
        if (!details.isFile() || details.isSymbolicLink() || (process.geteuid && details.uid !== process.geteuid()) || (details.mode & 0o022) !== 0)
            throw new Error("unsafe file");
        return await readFile(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw helperError("Host Telemetry state is not protected.", "Repair helper-owned Telemetry files and retry.");
    }
}
async function atomicWrite(file, content, mode) {
    const candidate = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(candidate, content, { flag: "wx", mode });
    try {
        await rename(candidate, file);
        await chmod(file, mode);
    }
    catch (error) {
        throw error;
    }
}
function docker(args) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    return { ok: !result.error && result.status === 0, stdout: String(result.stdout ?? "").trim() };
}
function inspectRelay() {
    const result = docker(["inspect", "--format", "{{json .}}", RELAY_NAME]);
    if (!result.ok)
        return null;
    try {
        const value = JSON.parse(result.stdout);
        if (value?.Config?.Labels?.["com.sporades.host-telemetry-relay"] !== "true")
            throw new Error("foreign container");
        return value;
    }
    catch {
        throw helperError("Host Telemetry relay name is occupied.", "Inspect the existing relay container before reconciling it.");
    }
}
export async function readHostTelemetryConnection(remoteRoot) {
    const files = paths(remoteRoot);
    try {
        await assertOwnedDirectory(files.directory);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    const raw = await readProtected(files.descriptor);
    if (!raw)
        return null;
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw helperError("Host Telemetry connection is invalid.", "Repair protected Host Telemetry state.");
    }
    if (value.schemaVersion !== 1 || typeof value.endpoint !== "string" || typeof value.network !== "string" || value.internalEndpoint !== `http://${RELAY_ALIAS}:4318/`) {
        throw helperError("Host Telemetry connection is invalid.", "Repair protected Host Telemetry state.");
    }
    return value;
}
export async function statusHostTelemetryRelay(remoteRoot) {
    const connection = await readHostTelemetryConnection(remoteRoot);
    const relay = inspectRelay();
    return {
        connected: Boolean(connection),
        relayReady: Boolean(connection && relay?.State?.Running === true),
        capsuleCoverage: "not-configured",
        backendVerification: "unavailable",
        ...(connection ? { endpoint: connection.endpoint, internalEndpoint: connection.internalEndpoint, network: connection.network, caConfigured: connection.caConfigured, connectedAt: connection.connectedAt, ...(connection.metricsIntervalMs ? { metricsIntervalMs: connection.metricsIntervalMs } : {}), ...(connection.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: connection.eventLoopDelayResolutionMs } : {}) } : {}),
    };
}
export async function connectHostTelemetryRelay(remoteRoot, network, input) {
    const connection = validateHostRelayConnection(input);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network))
        invalid();
    if (!docker(["network", "inspect", network]).ok)
        throw helperError("Hosted Docker network is unavailable.", "Bootstrap the Host before connecting Telemetry.");
    const files = paths(remoteRoot);
    await mkdir(files.directory, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(files.directory);
    const previous = await readHostTelemetryConnection(remoteRoot);
    const previousConfig = previous ? await readProtected(files.config) : null;
    const previousCredential = previous ? await readProtected(files.credential) : null;
    const previousCa = previous?.caConfigured ? await readProtected(files.ca) : null;
    const descriptor = { schemaVersion: 1, endpoint: connection.endpoint, network, internalEndpoint: `http://${RELAY_ALIAS}:4318/`, caConfigured: Boolean(connection.caPem), connectedAt: new Date().toISOString(), ...(connection.metricsIntervalMs ? { metricsIntervalMs: connection.metricsIntervalMs } : {}), ...(connection.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: connection.eventLoopDelayResolutionMs } : {}) };
    await atomicWrite(files.config, renderHostRelayCollectorConfig({ endpoint: connection.endpoint, caFile: Boolean(connection.caPem) }), 0o644);
    await atomicWrite(files.credential, `SPORADES_INGEST_AUTH=Bearer ${connection.credential}\n`, 0o600);
    if (connection.caPem)
        await atomicWrite(files.ca, connection.caPem, 0o644);
    try {
        await startRelay(files, network, Boolean(connection.caPem));
    }
    catch (error) {
        if (previous && previousConfig && previousCredential && (!previous.caConfigured || previousCa)) {
            await atomicWrite(files.config, previousConfig, 0o644);
            await atomicWrite(files.credential, previousCredential, 0o600);
            if (previousCa)
                await atomicWrite(files.ca, previousCa, 0o644);
            try {
                await startRelay(files, previous.network, previous.caConfigured);
            }
            catch {
                throw helperError("Host Telemetry relay recovery failed.", "The saved connection remains protected; inspect Docker and retry reconcile.");
            }
        }
        else {
            await rm(files.config, { force: true });
            await rm(files.credential, { force: true });
        }
        throw error;
    }
    await atomicWrite(files.descriptor, `${JSON.stringify(descriptor, null, 2)}\n`, 0o600);
    return await statusHostTelemetryRelay(remoteRoot);
}
async function startRelay(files, network, caConfigured) {
    const existing = inspectRelay();
    if (existing) {
        if (!docker(["rm", "-f", RELAY_NAME]).ok)
            throw helperError("Host Telemetry relay could not be reconciled.", "Inspect Docker relay state and retry.");
    }
    const args = ["run", "--detach", "--name", RELAY_NAME, "--label", RELAY_LABEL, "--network", network, "--network-alias", RELAY_ALIAS, "--restart", "unless-stopped", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--memory", "192m", "--cpus", "0.5", "--pids-limit", "128", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "--env-file", files.credential, "--mount", `type=bind,source=${files.config},target=/etc/otelcol/config.yaml,readonly`, ...(caConfigured ? ["--mount", `type=bind,source=${files.ca},target=/etc/otelcol/ca.pem,readonly`] : []), RELAY_IMAGE, "--config=/etc/otelcol/config.yaml"];
    if (!docker(args).ok)
        throw helperError("Host Telemetry relay failed to start.", "Inspect protected relay configuration and Docker logs, then retry `sporades host telemetry connect`.");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (inspectRelay()?.State?.Running !== true)
        throw helperError("Host Telemetry relay exited during startup.", "Inspect Docker relay logs for collector configuration errors, then retry.");
}
export async function reconcileHostTelemetryRelay(remoteRoot) {
    const connection = await readHostTelemetryConnection(remoteRoot);
    if (!connection)
        throw helperError("Host Telemetry is not connected.", "Run `sporades host telemetry connect` first.");
    const files = paths(remoteRoot);
    if (!await readProtected(files.config) || !await readProtected(files.credential) || (connection.caConfigured && !await readProtected(files.ca))) {
        throw helperError("Host Telemetry configuration is incomplete.", "Reconnect the relay with a verified Telemetry profile.");
    }
    if (!docker(["network", "inspect", connection.network]).ok)
        throw helperError("Hosted Docker network is unavailable.", "Bootstrap the Host before reconciling Telemetry.");
    const existing = inspectRelay();
    if (!existing?.State?.Running || !existing?.NetworkSettings?.Networks?.[connection.network])
        await startRelay(files, connection.network, connection.caConfigured);
    return statusHostTelemetryRelay(remoteRoot);
}
const syntheticTrace = (id) => JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "sporades-host-relay-check" } }] }, scopeSpans: [{ spans: [{ traceId: id, spanId: id.slice(0, 16), name: "sporades.host.relay.check", kind: 1, startTimeUnixNano: String(Date.now() * 1_000_000), endTimeUnixNano: String((Date.now() + 1) * 1_000_000) }] }] }] });
export async function checkHostTelemetryDelivery(remoteRoot) {
    const descriptor = await readHostTelemetryConnection(remoteRoot);
    if (!descriptor)
        throw helperError("Host Telemetry is not connected.", "Run `sporades host telemetry connect` first.");
    const files = paths(remoteRoot);
    const raw = await readProtected(files.credential);
    const credential = raw?.match(/^SPORADES_INGEST_AUTH=Bearer ([^\r\n]+)\n$/)?.[1];
    if (!credential)
        throw helperError("Host Telemetry credential is unavailable.", "Reconnect the relay with a scoped ingestion credential.");
    const ca = descriptor.caConfigured ? await readProtected(files.ca) : undefined;
    const url = new URL("v1/traces", descriptor.endpoint);
    const traceId = randomBytes(16).toString("hex");
    const body = syntheticTrace(traceId);
    const result = await new Promise((resolve) => {
        const request = httpsRequest(url, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${credential}`, "content-length": Buffer.byteLength(body) }, ...(ca ? { ca } : {}), timeout: 5000 }, (response) => {
            response.resume();
            resolve({ stage: response.statusCode === 401 || response.statusCode === 403 ? "auth" : response.statusCode && response.statusCode >= 200 && response.statusCode < 300 ? "accepted" : "destination", accepted: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300), statusCode: response.statusCode });
        });
        request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
        request.on("error", (error) => resolve({ stage: error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" ? "dns" : String(error.code).startsWith("ERR_TLS") || String(error.code).includes("CERT") ? "tls" : "network", accepted: false }));
        request.end(body);
    });
    const relayReady = (await statusHostTelemetryRelay(remoteRoot)).relayReady;
    let relayAccepted = false;
    if (relayReady) {
        const script = `const u='http://${RELAY_ALIAS}:4318/v1/traces'; fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1],signal:AbortSignal.timeout(5000)}).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('unavailable'));`;
        const relay = docker(["run", "--rm", "--network", descriptor.network, "--user", "10001:10001", "--entrypoint", "node", SPORADES_BASE_IMAGE.image, "-e", script, body]);
        relayAccepted = relay.ok && ["200", "202"].includes(relay.stdout);
    }
    return { ...result, origin: "host", traceId, relayReady, relayAccepted, backendStorage: "verification-unavailable", capsuleCoverage: "not-configured" };
}
//# sourceMappingURL=host-telemetry-relay.js.map