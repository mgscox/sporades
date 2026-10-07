import { spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { validateTracePropagationOrigins } from "../telemetry-propagation-policy.js";
import { SPORADES_BASE_IMAGE } from "../base-image.js";
import { helperError } from "./cli-support.js";
import { withHostTelemetryLock } from "./host-telemetry-state.js";
import { inventoryHost } from "./inventory-contract.js";
import { otlpTraceAccepted, diagnosticTrace, failed, passed, unavailable, probeTelemetryDestination, probeInventoryDestination, queryDiagnosticTrace, validateQueryCredential } from "./telemetry-diagnostics.js";
import { configureHostMetrics, hostMetricsStatus, hostScrapeConfig, readHostMetrics, HOST_METRICS_NETWORK } from "./host-metrics.js";
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
    if (Object.keys(input).some((key) => !["endpoint", "credential", "inventoryCredential", "inventoryHost", "caPem", "metricsIntervalMs", "eventLoopDelayResolutionMs", "tracePropagationOrigins"].includes(key)))
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
    if (input.inventoryCredential !== undefined && (typeof input.inventoryCredential !== "string" || input.inventoryCredential.length < 16 || input.inventoryCredential.length > 4096 || /[\x00-\x20\x7f]/.test(input.inventoryCredential)))
        invalid();
    if (input.inventoryHost !== undefined && !inventoryHost(input.inventoryHost))
        invalid();
    if (input.caPem !== undefined && (typeof input.caPem !== "string" || Buffer.byteLength(input.caPem) > MAX_CA_BYTES || !input.caPem.includes("-----BEGIN CERTIFICATE-----")))
        invalid();
    if (input.caPem !== undefined) {
        try {
            new X509Certificate(input.caPem);
        }
        catch {
            invalid();
        }
    }
    if (input.metricsIntervalMs !== undefined && (!Number.isSafeInteger(input.metricsIntervalMs) || input.metricsIntervalMs < 5_000 || input.metricsIntervalMs > 300_000))
        invalid();
    if (input.eventLoopDelayResolutionMs !== undefined && (!Number.isSafeInteger(input.eventLoopDelayResolutionMs) || input.eventLoopDelayResolutionMs < 10 || input.eventLoopDelayResolutionMs > 1000))
        invalid();
    if (input.tracePropagationOrigins !== undefined) {
        try {
            input.tracePropagationOrigins = validateTracePropagationOrigins(input.tracePropagationOrigins);
        }
        catch {
            invalid();
        }
    }
    return input;
}
export function renderHostRelayCollectorConfig(options) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
        invalid();
    return `receivers:\n  prometheus/pipeline:\n    config:\n      scrape_configs:\n        - job_name: sporades-pipeline-relay\n          scrape_interval: 15s\n          scrape_timeout: 3s\n          sample_limit: 2000\n          static_configs:\n            - targets: [127.0.0.1:8888]\n${options.resources ? hostScrapeConfig(options.resources) : ""}  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\n        max_request_body_size: 2097152\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 96\n    spike_limit_mib: 24\n  batch:\n    send_batch_size: 256\n    send_batch_max_size: 256\n    timeout: 1s\nexporters:\n  otlphttp/remote:\n    endpoint: ${JSON.stringify(options.endpoint)}\n    headers:\n      Authorization: \"\${env:SPORADES_INGEST_AUTH}\"\n${options.caFile ? "    tls:\n      ca_file: /etc/otelcol/ca.pem\n" : ""}    timeout: 2s\n    sending_queue:\n      enabled: true\n      sizer: bytes\n      queue_size: 16777216\n      num_consumers: 2\n      block_on_overflow: false\n      wait_for_result: false\n    retry_on_failure:\n      enabled: true\n      initial_interval: 1s\n      max_interval: 5s\n      max_elapsed_time: 300s\nservice:\n  telemetry:\n    metrics:\n      level: detailed\n      readers:\n        - pull:\n            exporter:\n              prometheus:\n                host: 127.0.0.1\n                port: 8888\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/remote]\n    metrics:\n      receivers: [otlp, prometheus/pipeline${options.resources?.enabled ? ", prometheus/host" : ""}]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/remote]\n`;
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
    try {
        const handle = await open(candidate, "wx", mode);
        // Collector bind mounts must be readable by its uid even under UMask=0077;
        // credential and journal callers still explicitly request 0600.
        try {
            await handle.writeFile(content);
            await handle.chmod(mode);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(candidate, file);
        const directory = await open(path.dirname(file), "r");
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await rm(candidate, { force: true });
    }
}
async function readActivation(files) {
    const file = path.join(files.directory, "activation.json");
    const raw = await readProtected(file);
    if (raw === null)
        return null;
    try {
        if ((await lstat(file)).mode & 0o077 || Buffer.byteLength(raw) > 3 * 1024 * 1024)
            throw new Error();
        const value = JSON.parse(raw);
        if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.candidateDigest) || (value.previous !== null && (typeof value.previous?.descriptor !== "string" || typeof value.previous.config !== "string" || typeof value.previous.credential !== "string" || (value.previous.ca !== null && typeof value.previous.ca !== "string"))))
            throw new Error();
        return value;
    }
    catch {
        throw helperError("Host Telemetry activation journal is invalid.", "Restore protected Telemetry state from an operator backup before reconnecting.");
    }
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function activationPending(files) {
    const journal = await readActivation(files);
    return Boolean(journal && digest(await readProtected(files.descriptor) ?? "") !== journal.candidateDigest);
}
// Called with the Host telemetry lock held. A crash before descriptor publication
// restores the previous authority. A committed descriptor completes cleanup.
async function recoverActivation(files) {
    const journal = await readActivation(files);
    if (!journal)
        return;
    if (digest(await readProtected(files.descriptor) ?? "") !== journal.candidateDigest) {
        if (journal.previous) {
            let previous;
            try {
                previous = JSON.parse(journal.previous.descriptor);
            }
            catch {
                invalid();
            }
            if (!previous || typeof previous !== "object")
                invalid();
            if (previous.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(previous.network))
                invalid();
            if (previous.exportsDisabled !== undefined && typeof previous.exportsDisabled !== "boolean")
                invalid();
            validateHostRelayConnection({ endpoint: previous.endpoint, credential: journal.previous.credential.match(/^SPORADES_INGEST_AUTH=Bearer ([^\r\n]+)\n$/)?.[1], ...(journal.previous.ca ? { caPem: journal.previous.ca } : {}) });
            await atomicWrite(files.config, journal.previous.config, 0o644);
            await atomicWrite(files.credential, journal.previous.credential, 0o600);
            if (journal.previous.ca)
                await atomicWrite(files.ca, journal.previous.ca, 0o644);
            else
                await rm(files.ca, { force: true });
            await atomicWrite(files.descriptor, journal.previous.descriptor, 0o600);
            if (previous.exportsDisabled)
                await stopHostTelemetryExports(path.dirname(files.directory), previous.inventoryHost);
            else
                await startRelay(files, previous.network, Boolean(previous.caConfigured));
        }
        else {
            if (inspectRelay() && !docker(["rm", "-f", RELAY_NAME]).ok)
                throw new Error("Recovery failed");
            for (const file of [files.descriptor, files.config, files.credential, files.ca])
                await rm(file, { force: true });
        }
    }
    await rm(path.join(files.directory, "activation.json"), { force: true });
    const dir = await open(files.directory, "r");
    try {
        await dir.sync();
    }
    finally {
        await dir.close();
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
async function readConnectionRecord(remoteRoot) {
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
    if (value.exportsDisabled !== undefined && typeof value.exportsDisabled !== "boolean")
        invalid();
    if (value.tracePropagationOrigins !== undefined) {
        try {
            value.tracePropagationOrigins = validateTracePropagationOrigins(value.tracePropagationOrigins);
        }
        catch {
            invalid();
        }
    }
    return value;
}
export async function readHostTelemetryConnection(remoteRoot) {
    const record = await readConnectionRecord(remoteRoot);
    if (!record)
        return null;
    const { exportsDisabled, schemaVersion, endpoint, network, internalEndpoint, caConfigured, connectedAt, inventoryHost, tracePropagationOrigins, metricsIntervalMs, eventLoopDelayResolutionMs } = record;
    const value = { exportsDisabled, schemaVersion, endpoint, network, internalEndpoint, caConfigured, connectedAt, inventoryHost, tracePropagationOrigins, metricsIntervalMs, eventLoopDelayResolutionMs };
    return value;
}
/** Call only while holding withHostTelemetryLock; legacy split state needs it too. */
export async function readHostInventoryConnection(remoteRoot) {
    const record = await readConnectionRecord(remoteRoot);
    if (!record)
        return null;
    const files = paths(remoteRoot);
    if (await activationPending(files))
        throw new Error("Host Telemetry activation requires reconcile.");
    const details = await lstat(files.descriptor);
    if (details.mode & 0o077)
        throw new Error("Unprotected Host inventory state.");
    if (!inventoryHost(record.inventoryHost))
        throw new Error("Reconnect Host Telemetry to assign inventory authority.");
    const bundle = record.inventory;
    let credential, caPem, generation;
    if (bundle !== undefined) {
        if (!bundle || typeof bundle.generation !== "string" || !/^[a-f0-9]{32}$/.test(bundle.generation))
            throw new Error("Invalid inventory connection.");
        ({ credential, caPem, generation } = bundle);
        if (Boolean(caPem) !== record.caConfigured)
            throw new Error("Invalid inventory connection.");
    }
    else {
        // Old Hosts remain usable. Every new reconnect uses this same OS lock and
        // publishes a complete bundle, so a legacy capture cannot straddle rotation.
        const tokenPath = path.join(files.directory, "inventory-credential");
        if ((await lstat(tokenPath)).mode & 0o077)
            throw new Error("Unprotected Host inventory state.");
        credential = (await readProtected(tokenPath) ?? "").trim();
        caPem = record.caConfigured ? await readProtected(files.ca) ?? undefined : undefined;
        if (record.caConfigured && !caPem)
            throw new Error("Invalid inventory connection.");
        generation = createHash("sha256").update(JSON.stringify([record, credential, caPem])).digest("hex");
    }
    validateHostRelayConnection({ endpoint: record.endpoint, credential, ...(caPem ? { caPem } : {}) });
    return { generation, endpoint: record.endpoint, host: record.inventoryHost, credential, caPem };
}
export async function statusHostTelemetryRelay(remoteRoot) {
    const connection = await readHostTelemetryConnection(remoteRoot);
    const relay = inspectRelay();
    return {
        resources: await hostMetricsStatus(remoteRoot),
        exportsDisabled: connection?.exportsDisabled === true,
        connected: Boolean(connection),
        activationPending: connection ? await activationPending(paths(remoteRoot)) : false,
        relayReady: Boolean(connection && !connection.exportsDisabled && relay?.State?.Running === true && !await activationPending(paths(remoteRoot))),
        capsuleCoverage: "not-configured",
        backendVerification: "unavailable",
        ...(connection ? { ...(connection.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: connection.tracePropagationOrigins } : {}), endpoint: connection.endpoint, internalEndpoint: connection.internalEndpoint, network: connection.network, caConfigured: connection.caConfigured, connectedAt: connection.connectedAt, ...(connection.metricsIntervalMs ? { metricsIntervalMs: connection.metricsIntervalMs } : {}), ...(connection.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: connection.eventLoopDelayResolutionMs } : {}) } : {}),
    };
}
export async function connectHostTelemetryRelay(remoteRoot, network, input, host, expectedBinding) {
    const connection = validateHostRelayConnection(input);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network))
        invalid();
    if (!docker(["network", "inspect", network]).ok)
        throw helperError("Hosted Docker network is unavailable.", "Bootstrap the Host before connecting Telemetry.");
    const files = paths(remoteRoot);
    await mkdir(files.directory, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(files.directory);
    return withHostTelemetryLock(remoteRoot, async () => {
        if (await readActivation(files))
            throw helperError("Host Telemetry activation needs reconciliation.", "Run host telemetry reconcile before reconnecting or migrating.");
        if (expectedBinding && createHash("sha256").update(JSON.stringify(await readConnectionRecord(remoteRoot))).digest("hex") !== expectedBinding)
            throw helperError("Host Telemetry binding changed during destination verification.", "Inspect current status and retry migration against the saved binding.");
        const previous = await readHostTelemetryConnection(remoteRoot);
        if (previous?.inventoryHost && connection.inventoryHost && previous.inventoryHost !== connection.inventoryHost)
            throw helperError("Host inventory identity cannot change.", "Use the persisted exact Host identity when reconnecting; restore retained state rather than resetting authority.");
        const resources = host ? await configureHostMetrics(remoteRoot, host) : await readHostMetrics(remoteRoot);
        const previousConfig = previous ? await readProtected(files.config) : null;
        const previousCredential = previous ? await readProtected(files.credential) : null;
        const previousCa = previous?.caConfigured ? await readProtected(files.ca) : null;
        // A verified migration retains export policy; ordinary connect deliberately
        // re-enables exports. Read policy under the same lock as the binding fence.
        const exportsDisabled = expectedBinding !== undefined && previous?.exportsDisabled === true;
        const descriptor = { ...(exportsDisabled ? { exportsDisabled: true } : {}), inventory: { generation: randomBytes(16).toString("hex"), credential: connection.inventoryCredential ?? connection.credential, ...(connection.caPem ? { caPem: connection.caPem } : {}) }, schemaVersion: 1, ...(connection.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: connection.tracePropagationOrigins } : {}), endpoint: connection.endpoint, network, internalEndpoint: `http://${RELAY_ALIAS}:4318/`, caConfigured: Boolean(connection.caPem), connectedAt: new Date().toISOString(), inventoryHost: previous?.inventoryHost ?? connection.inventoryHost ?? host, ...(connection.metricsIntervalMs ? { metricsIntervalMs: connection.metricsIntervalMs } : {}), ...(connection.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: connection.eventLoopDelayResolutionMs } : {}) };
        const candidate = `${JSON.stringify(descriptor, null, 2)}\n`;
        if (previous && (!previousConfig || !previousCredential || (previous.caConfigured && !previousCa)))
            throw helperError("Previous Host Telemetry state is incomplete.", "Restore or reconcile the protected working connection before reconnecting.");
        const previousDescriptor = await readProtected(files.descriptor);
        const journal = { schemaVersion: 1, candidateDigest: digest(candidate), previous: previous && previousDescriptor ? { descriptor: previousDescriptor, config: previousConfig, credential: previousCredential, ca: previousCa } : null };
        await atomicWrite(path.join(files.directory, "activation.json"), JSON.stringify(journal), 0o600);
        try {
            await atomicWrite(files.config, renderHostRelayCollectorConfig({ endpoint: connection.endpoint, caFile: Boolean(connection.caPem), resources }), 0o644);
            await atomicWrite(files.credential, `SPORADES_INGEST_AUTH=Bearer ${connection.credential}\n`, 0o600);
            if (connection.caPem)
                await atomicWrite(files.ca, connection.caPem, 0o644);
            if (exportsDisabled)
                await stopHostTelemetryExports(remoteRoot, previous?.inventoryHost);
            else
                await startRelay(files, network, Boolean(connection.caPem));
            await atomicWrite(files.descriptor, candidate, 0o600);
        }
        catch (error) {
            try {
                await recoverActivation(files);
            }
            catch {
                throw helperError("Host Telemetry relay recovery failed.", "Protected rollback state is retained; inspect Docker and run host telemetry reconcile.");
            }
            throw error;
        }
        // A published descriptor is the commit point. Interrupted cleanup never
        // reactivates old credentials; reconcile recognizes the committed digest.
        await recoverActivation(files);
        await rm(path.join(files.directory, "inventory-credential"), { force: true });
        return await statusHostTelemetryRelay(remoteRoot);
    });
}
async function startRelay(files, network, caConfigured) {
    const existing = inspectRelay();
    if (existing) {
        if (!docker(["rm", "-f", RELAY_NAME]).ok)
            throw helperError("Host Telemetry relay could not be reconciled.", "Inspect Docker relay state and retry.");
    }
    const hash = createHash("sha256").update(await readFile(files.config)).digest("hex");
    const resources = await readHostMetrics(path.dirname(files.directory));
    const args = ["run", "--detach", "--name", RELAY_NAME, "--label", RELAY_LABEL, "--label", `com.sporades.relay-config=${hash}`, "--network", network, "--network-alias", RELAY_ALIAS, "--restart", "unless-stopped", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--memory", "192m", "--cpus", "0.5", "--pids-limit", "128", "--stop-timeout", "5", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "--env-file", files.credential, "--mount", `type=bind,source=${files.config},target=/etc/otelcol/config.yaml,readonly`, ...(caConfigured ? ["--mount", `type=bind,source=${files.ca},target=/etc/otelcol/ca.pem,readonly`] : []), RELAY_IMAGE, "--config=/etc/otelcol/config.yaml"];
    if (!docker(args).ok)
        throw helperError("Host Telemetry relay failed to start.", "Inspect protected relay configuration and Docker logs, then retry `sporades host telemetry connect`.");
    if (resources?.enabled && !docker(["network", "connect", HOST_METRICS_NETWORK, RELAY_NAME]).ok)
        throw helperError("Could not attach relay to the private metrics network.", "Retry telemetry reconcile.");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (inspectRelay()?.State?.Running !== true)
        throw helperError("Host Telemetry relay exited during startup.", "Inspect Docker relay logs for collector configuration errors, then retry.");
}
/** Host-owned inventory timer also repairs an interrupted activation. */
export async function recoverHostTelemetryActivation(remoteRoot) {
    const files = paths(remoteRoot);
    if (!await readActivation(files))
        return;
    return withHostTelemetryLock(remoteRoot, () => recoverActivation(files));
}
export async function reconcileHostTelemetryRelay(remoteRoot, host, operation = "reconcile") {
    return withHostTelemetryLock(remoteRoot, async () => {
        await recoverActivation(paths(remoteRoot));
        return reconcileRelayLocked(remoteRoot, host, operation);
    });
}
async function reconcileRelayLocked(remoteRoot, host, operation) {
    const connection = await readHostTelemetryConnection(remoteRoot);
    if (!connection)
        throw helperError("Host Telemetry is not connected.", "Run `sporades host telemetry connect` first.");
    if (connection.exportsDisabled) {
        if (operation === "enable")
            throw helperError("Host exports are disabled.", "Reconnect deliberately to enable monitoring.");
        await stopHostTelemetryExports(remoteRoot, host ?? connection.inventoryHost, operation === "remove" ? "remove" : "disable");
        return statusHostTelemetryRelay(remoteRoot);
    }
    const files = paths(remoteRoot);
    if (!await readProtected(files.config) || !await readProtected(files.credential) || (connection.caConfigured && !await readProtected(files.ca))) {
        throw helperError("Host Telemetry configuration is incomplete.", "Reconnect the relay with a verified Telemetry profile.");
    }
    if (!docker(["network", "inspect", connection.network]).ok)
        throw helperError("Hosted Docker network is unavailable.", "Bootstrap the Host before reconciling Telemetry.");
    const resources = host ? await configureHostMetrics(remoteRoot, host, operation) : await readHostMetrics(remoteRoot);
    const oldConfig = await readProtected(files.config);
    const config = renderHostRelayCollectorConfig({ endpoint: connection.endpoint, caFile: connection.caConfigured, resources });
    const hash = createHash("sha256").update(config).digest("hex");
    const existing = inspectRelay();
    const restart = !existing?.State?.Running || !existing?.NetworkSettings?.Networks?.[connection.network] || existing?.Config?.Labels?.["com.sporades.relay-config"] !== hash || (resources?.enabled && !existing?.NetworkSettings?.Networks?.[HOST_METRICS_NETWORK]);
    if (oldConfig !== config)
        await atomicWrite(files.config, config, 0o644);
    if (restart) {
        try {
            await startRelay(files, connection.network, connection.caConfigured);
        }
        catch (error) {
            if (oldConfig) {
                await atomicWrite(files.config, oldConfig, 0o644);
                try {
                    await startRelay(files, connection.network, connection.caConfigured);
                }
                catch {
                    throw helperError("Host relay recovery failed.", "Inspect Docker and retry reconcile; protected connection credentials are preserved.");
                }
            }
            throw error;
        }
    }
    return statusHostTelemetryRelay(remoteRoot);
}
export async function checkHostTelemetryDelivery(remoteRoot, queryCredential) {
    validateQueryCredential(queryCredential);
    const checks = Object.fromEntries(["configuration", "agentReadiness", "dns", "tls", "authentication", "otlpAcceptance", "relayAcceptance", "recentIngestion", "backendQuery"].map(key => [key, unavailable("not-reached")]));
    const base = { origin: "host", accepted: false, stage: "configuration", relayReady: false, relayAccepted: false, backendStorage: "verification-unavailable", capsuleCoverage: "not-configured", checks };
    let captured;
    try {
        captured = await withHostTelemetryLock(remoteRoot, async () => {
            const descriptor = await readHostTelemetryConnection(remoteRoot);
            if (!descriptor)
                throw new Error();
            const files = paths(remoteRoot);
            if (await activationPending(files))
                throw new Error();
            const credential = (await readProtected(files.credential))?.match(/^SPORADES_INGEST_AUTH=Bearer ([^\r\n]+)\n$/)?.[1];
            const caPem = descriptor.caConfigured ? await readProtected(files.ca) : undefined;
            const config = await readProtected(files.config);
            if (!credential || typeof descriptor.caConfigured !== "boolean" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(descriptor.network) || (descriptor.caConfigured && !caPem))
                throw new Error();
            const connection = validateHostRelayConnection({ endpoint: descriptor.endpoint, credential, ...(caPem ? { caPem } : {}), ...(descriptor.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: descriptor.tracePropagationOrigins } : {}), ...(descriptor.metricsIntervalMs !== undefined ? { metricsIntervalMs: descriptor.metricsIntervalMs } : {}), ...(descriptor.eventLoopDelayResolutionMs !== undefined ? { eventLoopDelayResolutionMs: descriptor.eventLoopDelayResolutionMs } : {}) });
            if (config !== renderHostRelayCollectorConfig({ endpoint: connection.endpoint, caFile: Boolean(caPem), resources: await readHostMetrics(remoteRoot) }))
                throw new Error();
            return { descriptor, connection, relayReady: (await statusHostTelemetryRelay(remoteRoot)).relayReady };
        });
    }
    catch {
        checks.configuration = failed("saved-state-invalid-or-unavailable");
        return base;
    }
    checks.configuration = passed();
    checks.agentReadiness = captured.relayReady ? passed() : failed("relay-not-running");
    const result = await probeTelemetryDestination(captured.connection);
    Object.assign(checks, result.checks);
    // Never query the directly submitted trace as evidence for the relay path.
    const relayProbe = diagnosticTrace();
    let relayAccepted = false;
    if (captured.relayReady) {
        const script = `fetch('http://${RELAY_ALIAS}:4318/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1],signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok){process.stdout.write('rejected');return;}let d=await r.json();process.stdout.write((${otlpTraceAccepted.toString()})(d)?'accepted':'rejected');}).catch(()=>process.stdout.write('unavailable'));`;
        const relay = docker(["run", "--rm", "--network", captured.descriptor.network, "--user", "10001:10001", "--entrypoint", "node", SPORADES_BASE_IMAGE.image, "-e", script, relayProbe.body]);
        relayAccepted = relay.ok && relay.stdout === "accepted";
        checks.relayAcceptance = relayAccepted ? passed() : relay.ok && relay.stdout === "rejected" ? failed("receiver-rejected") : unavailable("probe-unavailable");
    }
    if (!captured.relayReady)
        checks.relayAcceptance = unavailable("relay-not-running");
    const query = relayAccepted ? await queryDiagnosticTrace(captured.connection, relayProbe.traceId, queryCredential) : { backendQuery: unavailable("relay-probe-not-accepted"), recentIngestion: unavailable("relay-probe-not-accepted") };
    Object.assign(checks, query);
    return { ...base, ...result, traceId: result.traceId, relayTraceId: relayProbe.traceId, relayReady: captured.relayReady, relayAccepted, checks, backendStorage: query.backendQuery.state === "passed" && query.recentIngestion.state === "passed" ? "verified-relay-trace" : "verification-unavailable" };
}
/** Verifies the destination on the actual Host before changing saved authority.
 * Old inventory is deliberately untouched: retiring its expectations is an
 * explicit Monitoring operator step, independent of retained trace history.
 */
export async function migrateHostTelemetryRelay(remoteRoot, network, input, host, queryCredential) {
    validateQueryCredential(queryCredential);
    const connection = validateHostRelayConnection(input);
    const previous = await withHostTelemetryLock(remoteRoot, () => readConnectionRecord(remoteRoot));
    if (!previous || !inventoryHost(previous.inventoryHost))
        throw helperError("Host Telemetry has no resolved inventory binding.", "Connect and register the Host before migrating it.");
    validateHostRelayConnection({ endpoint: previous.endpoint, credential: "saved-binding-validation" });
    if (typeof previous.network !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(previous.network))
        invalid();
    if (connection.inventoryHost && connection.inventoryHost !== previous.inventoryHost)
        throw helperError("Host inventory identity cannot change.", "Use the persisted exact Host identity at the destination.");
    const expectedBinding = createHash("sha256").update(JSON.stringify(previous)).digest("hex");
    const destination = await probeTelemetryDestination(connection);
    const storage = destination.accepted ? await queryDiagnosticTrace(connection, destination.traceId, queryCredential) : { backendQuery: unavailable("otlp-not-accepted"), recentIngestion: unavailable("otlp-not-accepted") };
    const inventoryAuthority = await probeInventoryDestination(connection, previous.inventoryHost);
    const before = { origin: "host", previousEndpoint: previous.endpoint, destination, storage, inventoryAuthority, relayRestarted: false, oldInventory: "operator-retirement-required", history: "preserved" };
    if (!destination.accepted || storage.backendQuery.state !== "passed" || storage.recentIngestion.state !== "passed" || inventoryAuthority.state !== "passed")
        return { ...before, activation: "not-applied", rollback: "working-binding-preserved" };
    const saved = await connectHostTelemetryRelay(remoteRoot, network, { ...(previous.tracePropagationOrigins !== undefined ? { tracePropagationOrigins: previous.tracePropagationOrigins } : {}), ...(previous.metricsIntervalMs ? { metricsIntervalMs: previous.metricsIntervalMs } : {}), ...(previous.eventLoopDelayResolutionMs ? { eventLoopDelayResolutionMs: previous.eventLoopDelayResolutionMs } : {}), ...connection, inventoryHost: previous.inventoryHost }, undefined, expectedBinding);
    return { ...before, activation: "applied", relayRestarted: !saved.exportsDisabled, rollback: "migrate-to-previous-profile", connection: saved };
}
async function stopHostTelemetryExports(remoteRoot, host, operation = "disable") {
    // Stop delivery even if Caddy validation or exporter shutdown fails. Retry
    // converges the remaining resources without removing inventory authority.
    if (inspectRelay() && !docker(["stop", RELAY_NAME]).ok)
        throw helperError("Host relay could not be stopped.", "Retry exports-disable; disabled launch policy and credentials are retained.");
    const identity = host ?? (await readHostMetrics(remoteRoot))?.host;
    if (identity)
        await configureHostMetrics(remoteRoot, identity, operation);
}
/** Durable opt-out keeps inventory authority and credentials for acknowledgement/recovery. */
export async function disableHostTelemetryExports(remoteRoot, host) {
    return withHostTelemetryLock(remoteRoot, async () => {
        // Settle an older activation before publishing the newer opt-out intent.
        // Keep shutdown serialized so reconnect cannot be stopped by this operation.
        await recoverActivation(paths(remoteRoot));
        const record = await readConnectionRecord(remoteRoot);
        if (!record)
            throw helperError("Host Telemetry is not connected.", "Connect before changing export policy.");
        await atomicWrite(paths(remoteRoot).descriptor, JSON.stringify({ ...record, exportsDisabled: true }) + "\n", 0o600);
        await stopHostTelemetryExports(remoteRoot, host);
        return statusHostTelemetryRelay(remoteRoot);
    });
}
/** Caller must first acknowledge the exact disabled inventory revision. */
export async function removeHostTelemetryAgents(remoteRoot, host) {
    if (!(await readHostTelemetryConnection(remoteRoot))?.exportsDisabled)
        throw helperError("Host exports are still enabled.", "Run exports-disable and reconcile inventory before remove-agents.");
    const { reconcileHostInventory } = await import("./host-inventory.js");
    const inventory = await reconcileHostInventory(remoteRoot);
    if (!inventory.host || inventory.pending || inventory.failure || inventory.acknowledgedRevision !== inventory.desiredRevision)
        throw helperError("Deliberate removal is not acknowledged.", "Restore inventory connectivity/authority and retry remove-agents. Credentials and the reconciler are retained.");
    await configureHostMetrics(remoteRoot, host, "remove");
    if (inspectRelay() && !docker(["rm", "-f", RELAY_NAME]).ok)
        throw helperError("Host relay could not be removed.", "Retry remove-agents; protected credentials and Capsule data are retained.");
    return statusHostTelemetryRelay(remoteRoot);
}
//# sourceMappingURL=host-telemetry-relay.js.map