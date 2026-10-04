import { reportHostAvailability } from "./host-availability.js";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { readHostTelemetryConnection, readHostInventoryConnection } from "./host-telemetry-relay.js";
import { inventoryHost, validateInventory } from "./inventory-contract.js";
import { withHostTelemetryLock as locked } from "./host-telemetry-state.js";
function directory(root) {
    if (!path.isAbsolute(root) || root === "/" || path.normalize(root) !== root)
        throw new Error("Invalid Host inventory root.");
    return path.join(root, "telemetry");
}
async function protectedPath(file, isDirectory = false) {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) || (process.geteuid && stat.uid !== process.geteuid()))
        throw new Error("Unprotected Host inventory state.");
}
async function readState(root) {
    const file = path.join(directory(root), "inventory.json");
    try {
        await protectedPath(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    let state;
    try {
        state = JSON.parse(await readFile(file, "utf8"));
    }
    catch {
        throw new Error("Invalid inventory outbox.");
    }
    state.desired = validateInventory(state.desired);
    if (typeof state.endpoint !== "string" || (state.acknowledgement && (!Number.isSafeInteger(state.acknowledgement.revision) || !Number.isFinite(Date.parse(state.acknowledgement.acknowledgedAt)))))
        throw new Error("Invalid inventory outbox.");
    return state;
}
async function atomicWrite(file, content) {
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, file);
        const dir = await open(path.dirname(file), "r");
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
    }
    finally {
        await rm(temporary, { force: true });
    }
}
async function registrySnapshot(root, previous, exportsDisabled = false) {
    const capsules = [];
    const hostsDirectory = path.join(root, "hosts");
    for (const dir of [root, hostsDirectory]) {
        const stat = await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid()))
            throw new Error("Unsafe Host registry root.");
    }
    const domains = await readdir(hostsDirectory, { withFileTypes: true });
    for (const domain of domains.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!inventoryHost(domain.name))
            continue;
        if (!domain.isDirectory() || domain.isSymbolicLink())
            throw new Error("Unsafe Host registry directory.");
        const registry = path.join(hostsDirectory, domain.name, "registry");
        const records = path.join(registry, "capsules");
        // Missing registry directories are corruption, never proof of deletion.
        for (const dir of [registry, records]) {
            const stat = await lstat(dir);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid()))
                throw new Error("Unsafe Host registry.");
        }
        for (const file of await readdir(records, { withFileTypes: true })) {
            if (!file.name.endsWith(".json"))
                continue;
            if (!file.isFile() || file.isSymbolicLink())
                throw new Error("Unsafe registry record.");
            const recordPath = path.join(records, file.name);
            const stat = await lstat(recordPath);
            if ((stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid()) || stat.size > 8 * 1024 * 1024)
                throw new Error("Unsafe registry record.");
            let record;
            try {
                record = JSON.parse(await readFile(recordPath, "utf8"));
            }
            catch {
                throw new Error("Invalid Host registry record.");
            }
            if (record.domain !== domain.name || `${record.subname}.json` !== file.name || (record.remoteCapsuleId && record.remoteCapsuleId !== `${domain.name}/${record.subname}`))
                throw new Error("Invalid registry identity.");
            const state = record.status === "unregistered" ? "deleted" : (exportsDisabled || record.telemetry?.disabled === true) ? "opted-out" : record.status;
            const disabled = ["deleted", "stopped", "opted-out"].includes(state);
            const url = new URL(record.hostedUrl);
            if (url.hostname !== `${record.subname}.${domain.name}`)
                throw new Error("Invalid registry address.");
            const targets = disabled ? [] : [url.href, ...(record.aliasDomains ?? []).map((alias) => `${url.protocol}//${alias}/`)];
            capsules.push({ id: `${domain.name}/${record.subname}`, state, changedAt: record.updatedAt, release: record.currentRelease?.id ?? null, targets });
        }
    }
    for (const capsule of previous) {
        if (!capsules.some(item => item.id === capsule.id)) {
            const domain = capsule.id.split("/")[0];
            if (!domains.some(item => item.name === domain))
                throw new Error("Expected Host registry disappeared.");
            capsules.push(capsule.state === "deleted" ? capsule : { ...capsule, state: "deleted", changedAt: new Date().toISOString(), targets: [] });
        }
    }
    return capsules;
}
/** Persist desired state only. No network access on Capsule operation paths. */
async function queueLocked(root, connection) {
    const previous = await readState(root);
    if (previous && previous.desired.host !== connection.host)
        throw new Error("Inventory Host identity cannot change.");
    const desired = validateInventory({ schemaVersion: 1, host: connection.host, revision: previous?.desired.revision ?? 1, capsules: await registrySnapshot(root, previous?.desired.capsules ?? [], (await readHostTelemetryConnection(root))?.exportsDisabled === true) });
    const sameGeneration = previous?.connectionGeneration === connection.generation;
    const changed = !previous || JSON.stringify(desired) !== JSON.stringify(previous.desired) || !sameGeneration;
    if (changed && previous)
        desired.revision++;
    const state = changed ? { desired, endpoint: connection.endpoint, connectionGeneration: connection.generation, acknowledgement: sameGeneration ? previous.acknowledgement : null, lastAttemptAt: previous?.lastAttemptAt ?? null, failure: null } : previous;
    if (changed)
        await atomicWrite(path.join(directory(root), "inventory.json"), JSON.stringify(state) + "\n");
    return state;
}
export async function queueHostInventory(root) {
    if (!await readHostTelemetryConnection(root))
        return null;
    return locked(root, async () => {
        const connection = await readHostInventoryConnection(root);
        return connection ? queueLocked(root, connection) : null;
    });
}
export async function hostInventoryStatus(root, snapshotFailed = false) {
    const connected = await readHostTelemetryConnection(root);
    const status = async () => {
        const state = await readState(root);
        let unavailable = false;
        const connection = connected ? await readHostInventoryConnection(root).catch(() => { unavailable = true; return null; }) : null;
        const failed = snapshotFailed || unavailable;
        const sameGeneration = Boolean(connection && state?.connectionGeneration === connection.generation);
        const acknowledgement = sameGeneration ? state?.acknowledgement : null;
        const reconcilerInstalled = spawnSync("systemctl", ["is-enabled", `${inventoryUnit(root)}.timer`], { stdio: "ignore", timeout: 1000 }).status === 0;
        return { host: state?.desired.host ?? connection?.host ?? connected?.inventoryHost ?? null, desiredRevision: state?.desired.revision ?? null, acknowledgedRevision: acknowledgement?.revision ?? null, acknowledgedAt: acknowledgement?.acknowledgedAt ?? null, pending: Boolean(connected && (failed || !sameGeneration || !state || state.desired.revision !== acknowledgement?.revision)), stale: Boolean(connected && (failed || !acknowledgement || Date.now() - Date.parse(acknowledgement.acknowledgedAt) > 180_000)), lastAttemptAt: state?.lastAttemptAt ?? null, failure: failed ? "snapshot-unavailable" : sameGeneration ? state?.failure ?? null : connected ? "snapshot-unavailable" : null, reconcilerInstalled };
    };
    return connected ? locked(root, status) : status();
}
export async function exportHostInventory(root) { return (await queueHostInventory(root))?.desired ?? null; }
export async function reconcileHostInventory(root) {
    if (!await readHostTelemetryConnection(root))
        return hostInventoryStatus(root);
    // Capture desired state and all transport authority under the reconnect lock.
    // HTTP itself runs after releasing it, so lifecycle writes remain independent.
    const captured = await locked(root, async () => {
        const connection = await readHostInventoryConnection(root);
        return connection ? { connection, state: await queueLocked(root, connection) } : null;
    });
    if (!captured)
        return hostInventoryStatus(root);
    const { state, connection } = captured;
    const relay = await readHostTelemetryConnection(root);
    if (relay)
        await reportHostAvailability({ host: state.desired.host, network: relay.network, capsules: state.desired.capsules });
    const { credential, caPem: ca } = connection;
    const body = JSON.stringify(state.desired);
    const result = await new Promise(resolve => {
        const req = httpsRequest(new URL(`/v1/inventory/${state.desired.host}`, state.endpoint), { method: "PUT", ...(ca ? { ca } : {}), headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
            let text = "";
            res.once("error", () => resolve({ failure: "network-or-tls" }));
            res.once("aborted", () => resolve({ failure: "network-or-tls" }));
            res.on("data", chunk => { text += chunk; if (text.length > 8192)
                req.destroy(); });
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    resolve({ failure: res.statusCode === 401 || res.statusCode === 403 ? "auth" : res.statusCode === 409 ? "revision-conflict" : "destination" });
                    return;
                }
                try {
                    const acknowledgement = JSON.parse(text).data;
                    if (acknowledgement.revision !== state.desired.revision || typeof acknowledgement.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(acknowledgement.acknowledgedAt)))
                        throw new Error();
                    resolve({ acknowledgement });
                }
                catch {
                    resolve({ failure: "invalid-acknowledgement" });
                }
            });
        });
        // Covers DNS, connect, TLS and the complete response, not just idle sockets.
        const deadline = setTimeout(() => req.destroy(new Error("timeout")), 5000);
        req.once("close", () => clearTimeout(deadline));
        req.once("error", () => resolve({ failure: "network-or-tls" }));
        req.end(body);
    });
    await locked(root, async () => {
        const current = await readState(root);
        const active = await readHostInventoryConnection(root);
        if (!active || active.generation !== connection.generation || !current || current.connectionGeneration !== connection.generation || current.desired.host !== state.desired.host)
            return;
        if ((current.acknowledgement?.revision ?? 0) > state.desired.revision)
            return;
        if (result.acknowledgement && (!current.acknowledgement || current.acknowledgement.revision < result.acknowledgement.revision || (current.acknowledgement.revision === result.acknowledgement.revision && Date.parse(current.acknowledgement.acknowledgedAt) <= Date.parse(result.acknowledgement.acknowledgedAt))))
            current.acknowledgement = result.acknowledgement;
        current.lastAttemptAt = new Date().toISOString();
        current.failure = result.failure ?? null;
        await atomicWrite(path.join(directory(root), "inventory.json"), JSON.stringify(current) + "\n");
    });
    return hostInventoryStatus(root);
}
export function inventoryUnit(root) { return `sporades-inventory-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`; }
export function kickHostInventory(root) {
    spawnSync("systemctl", ["start", "--no-block", `${inventoryUnit(root)}.service`], { stdio: "ignore", timeout: 1000 });
}
export async function installHostInventoryWorker(root) {
    directory(root);
    const probe = spawnSync("systemctl", ["show", "docker.service", "--property=LoadState", "--value"], { encoding: "utf8", timeout: 1000 });
    if (probe.status !== 0 || probe.stdout.trim() !== "loaded")
        return { installed: false, reason: "systemd-unavailable" };
    const helper = path.join(root, "bin", "sporades-host-helper");
    for (const file of ["/etc/systemd/system", helper]) {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022))
            throw new Error("Unsafe inventory worker installation path.");
    }
    const unit = inventoryUnit(root);
    const marker = "# Managed by Sporades: lifecycle inventory\n";
    const executable = JSON.stringify(helper).replace(/%/g, "%%").replace(/\$/g, () => "$$");
    const encoded = Buffer.from(root).toString("base64url");
    const files = {
        [`${unit}.service`]: `${marker}[Unit]\nDescription=Sporades lifecycle inventory\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${executable} --reconcile-inventory ${encoded}\nTimeoutStartSec=30\nUMask=0077\n`,
        [`${unit}.timer`]: `${marker}[Unit]\nDescription=Reconcile Sporades lifecycle inventory\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nRandomizedDelaySec=5s\n\n[Install]\nWantedBy=timers.target\n`,
    };
    for (const [name, content] of Object.entries(files)) {
        const file = path.join("/etc/systemd/system", name);
        try {
            const stat = await lstat(file);
            if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || !(await readFile(file, "utf8")).startsWith(marker))
                throw new Error("Inventory unit is operator-owned.");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        await atomicWrite(file, content);
    }
    for (const args of [["daemon-reload"], ["enable", "--now", `${unit}.timer`]])
        if (spawnSync("systemctl", args, { timeout: 10_000, stdio: "ignore" }).status !== 0)
            throw new Error("Inventory worker installation failed.");
    return { installed: true, unit: `${unit}.timer`, intervalSeconds: 60 };
}
/** Remove only the exact generated timer/service; retain protected outbox and secrets. */
export async function removeHostInventoryWorker(root) {
    directory(root);
    const unit = inventoryUnit(root);
    const files = ["timer", "service"].map(kind => path.join("/etc/systemd/system", `${unit}.${kind}`));
    const present = [];
    for (const file of files) {
        try {
            const st = await lstat(file);
            if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022 || !(await readFile(file, "utf8")).startsWith("# Managed by Sporades: lifecycle inventory\n"))
                throw new Error("Inventory worker is not owned.");
            present.push(file);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
    }
    if (present.length) {
        const commands = [
            ...(present.includes(files[0]) ? [["disable", "--now", `${unit}.timer`]] : []),
            ...(present.includes(files[1]) ? [["stop", `${unit}.service`]] : []),
        ];
        for (const args of commands)
            if (spawnSync("systemctl", args, { stdio: "ignore", timeout: 10_000 }).status !== 0)
                throw new Error("Inventory worker removal failed.");
        for (const file of present)
            await rm(file);
        if (spawnSync("systemctl", ["daemon-reload"], { stdio: "ignore", timeout: 10_000 }).status !== 0)
            throw new Error("Inventory worker removal failed.");
    }
    return { removed: true };
}
//# sourceMappingURL=host-inventory.js.map