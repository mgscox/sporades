import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { readHostTelemetryConnection } from "./host-telemetry-relay.js";
import { inventoryHost, validateInventory } from "./inventory-contract.js";
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
// OS-owned lock releases on exit/crash. Neither a stale mkdir lock nor an HTTP
// request can obstruct Capsule lifecycle locks. The sender releases it before HTTPS.
async function locked(root, operation) {
    const dir = directory(root);
    await protectedPath(dir, true);
    const file = path.join(dir, "inventory.lock");
    const handle = await open(file, "a", 0o600);
    await handle.close();
    await protectedPath(file);
    const child = spawn(process.env.SPORADES_TEST_FLOCK_PATH || "/usr/bin/flock", ["--exclusive", "--timeout", "2", "--conflict-exit-code", "75", "--no-fork", file, process.execPath, "-e", "process.stdout.write('locked');process.stdin.resume();"], { stdio: ["pipe", "pipe", "ignore"] });
    try {
        await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Inventory lock unavailable.")));
            child.stdout.once("data", () => resolve());
        });
        return await operation();
    }
    finally {
        child.stdin.end();
    }
}
async function registrySnapshot(root, previous) {
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
            const state = record.status === "unregistered" ? "deleted" : record.telemetry?.disabled === true ? "opted-out" : record.status;
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
export async function queueHostInventory(root) {
    const connection = await readHostTelemetryConnection(root);
    if (!connection)
        return null;
    if (!inventoryHost(connection.inventoryHost))
        throw new Error("Reconnect Host Telemetry to assign inventory authority.");
    return locked(root, async () => {
        const previous = await readState(root);
        if (previous && previous.desired.host !== connection.inventoryHost)
            throw new Error("Inventory Host identity cannot change.");
        const desired = validateInventory({ schemaVersion: 1, host: connection.inventoryHost, revision: previous?.desired.revision ?? 1, capsules: await registrySnapshot(root, previous?.desired.capsules ?? []) });
        const changed = !previous || JSON.stringify(desired) !== JSON.stringify(previous.desired) || previous.endpoint !== connection.endpoint;
        if (changed && previous)
            desired.revision++;
        const state = changed ? { desired, endpoint: connection.endpoint, acknowledgement: previous?.endpoint === connection.endpoint ? previous.acknowledgement : null, lastAttemptAt: previous?.lastAttemptAt ?? null, failure: null } : previous;
        if (changed)
            await atomicWrite(path.join(directory(root), "inventory.json"), JSON.stringify(state) + "\n");
        return state;
    });
}
export async function hostInventoryStatus(root, snapshotFailed = false) {
    const state = await readState(root);
    const connection = await readHostTelemetryConnection(root);
    const reconcilerInstalled = spawnSync("systemctl", ["is-enabled", `${inventoryUnit(root)}.timer`], { stdio: "ignore", timeout: 1000 }).status === 0;
    return { host: state?.desired.host ?? connection?.inventoryHost ?? null, desiredRevision: state?.desired.revision ?? null, acknowledgedRevision: state?.acknowledgement?.revision ?? null, acknowledgedAt: state?.acknowledgement?.acknowledgedAt ?? null, pending: Boolean(connection && (snapshotFailed || !state || state.desired.revision !== state.acknowledgement?.revision)), stale: Boolean(connection && (snapshotFailed || !state?.acknowledgement || Date.now() - Date.parse(state.acknowledgement.acknowledgedAt) > 180_000)), lastAttemptAt: state?.lastAttemptAt ?? null, failure: snapshotFailed ? "snapshot-unavailable" : state?.failure ?? (connection && !state ? "snapshot-unavailable" : null), reconcilerInstalled };
}
export async function exportHostInventory(root) { return (await queueHostInventory(root))?.desired ?? null; }
export async function reconcileHostInventory(root) {
    const state = await queueHostInventory(root);
    if (!state)
        return hostInventoryStatus(root);
    const connection = await readHostTelemetryConnection(root);
    if (!connection)
        return hostInventoryStatus(root);
    const tokenPath = path.join(directory(root), "inventory-credential");
    await protectedPath(tokenPath);
    const credential = (await readFile(tokenPath, "utf8")).trim();
    if (!credential || /[\x00-\x20\x7f]/.test(credential))
        throw new Error("Invalid inventory credential.");
    const ca = connection.caConfigured ? await readFile(path.join(directory(root), "ca.pem")) : undefined;
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
        if (!current || current.endpoint !== state.endpoint || current.desired.host !== state.desired.host)
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
//# sourceMappingURL=host-inventory.js.map