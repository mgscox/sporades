import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { SPORADES_BASE_IMAGE } from "./base-image.js";
export function devRuntimeRequiresClamav(database) {
    return Boolean(database.endpoints?.some((item) => item?.options?.body?.multipart?.inspection?.requiredInspectors?.includes("clamav")));
}
export async function releaseDevClamavSidecar(sidecar) {
    if (!sidecar)
        return undefined;
    await sidecar.stop();
    return undefined;
}
export async function retireDevClamavSidecarIfUnused(sidecar, database) {
    if (!sidecar || devRuntimeRequiresClamav(database))
        return sidecar;
    return await releaseDevClamavSidecar(sidecar);
}
function commandResult(command, args, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-8192);
        child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        const finish = (code) => { if (settled)
            return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
        const timer = setTimeout(() => { try {
            child.kill("SIGKILL");
        }
        catch { } finish(null); }, timeoutMs);
        child.once("close", finish);
        child.once("error", () => finish(null));
    });
}
async function ensureBaseImage(dockerCommand, dockerfile, buildContext) {
    if ((await commandResult(dockerCommand, ["image", "inspect", SPORADES_BASE_IMAGE.image], 30_000)).code === 0)
        return;
    if ((await commandResult(dockerCommand, ["pull", SPORADES_BASE_IMAGE.image], 5 * 60_000)).code === 0)
        return;
    const built = await commandResult(dockerCommand, ["build", "-f", dockerfile, "-t", SPORADES_BASE_IMAGE.image, buildContext], 10 * 60_000);
    if (built.code !== 0)
        throw Object.assign(new Error("Required Dev File inspection image is unavailable."), { code: "FILE_INSPECTION_UNAVAILABLE" });
}
function devClamavChildTerminated(child) {
    return Boolean(child) && (child.exitCode !== null || child.signalCode != null || child.__sporadesClamavTerminated === true);
}
export function devClamavSidecarIsReusable(sidecar) {
    const child = sidecar?.descriptor?.process;
    return Boolean(child) && !devClamavChildTerminated(child);
}
export async function attachRequiredDevClamavSidecar(sidecar, database, createSidecar) {
    if (!devRuntimeRequiresClamav(database))
        return { sidecar, attached: false };
    let selected = sidecar;
    if (selected && !devClamavSidecarIsReusable(selected)) {
        // Stop before replacement so there can never be two task-owned scanner
        // containers. Assignment happens only after stop/create/attach succeeds,
        // leaving a failed cleanup reachable for the caller's next retry.
        await selected.stop();
        selected = undefined;
    }
    if (!selected)
        selected = await createSidecar();
    selected.attach(database);
    return { sidecar: selected, attached: true };
}
export function waitForDevClamavChildExit(child, timeoutMs) {
    if (!child || devClamavChildTerminated(child))
        return Promise.resolve(true);
    return new Promise((resolve) => { let settled = false; const finish = (value) => { if (value)
        child.__sporadesClamavTerminated = true; if (settled)
        return; settled = true; clearTimeout(timer); resolve(value); }; const timer = setTimeout(() => finish(false), timeoutMs); child.once("close", () => finish(true)); child.once("error", () => finish(true)); });
}
export async function ensureDevClamavChildExit(child, timeoutMs) {
    if (await waitForDevClamavChildExit(child, timeoutMs))
        return true;
    try {
        child.kill("SIGKILL");
    }
    catch { }
    return await waitForDevClamavChildExit(child, timeoutMs);
}
export async function startDevClamavSidecar(options) {
    const dataRoot = path.join(options.projectDir, ".sporades", "clamav");
    await mkdir(path.join(dataRoot, "clamav"), { recursive: true });
    const socketDir = await mkdtemp(path.join(tmpdir(), "sporades-dev-clamav-"));
    const identity = createHash("sha256").update(`${path.resolve(options.projectDir)}\0${process.pid}\0${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 20);
    const containerName = `sporades-dev-clamav-${identity}`;
    const socketPath = path.join(socketDir, "clamd.sock");
    let child;
    let proxy;
    const bridges = new Set();
    const proxySockets = new Set();
    let stopped = false;
    let output = "";
    try {
        const dockerCommand = options.dockerCommand ?? "docker";
        await ensureBaseImage(dockerCommand, options.dockerfile, options.buildContext);
        const uid = process.getuid?.() ?? 10001;
        const gid = process.getgid?.() ?? 10001;
        const script = [
            "set -eu",
            "/usr/bin/freshclam --config-file=/etc/clamav/freshclam.conf",
            "/usr/bin/freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf >/tmp/freshclam.log 2>&1 & updater=$!",
            "/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf >/tmp/clamd.log 2>&1 & daemon=$!",
            "trap 'kill -TERM \"$daemon\" \"$updater\" 2>/dev/null || true; wait \"$daemon\" \"$updater\" 2>/dev/null || true' EXIT INT TERM",
            "while kill -0 \"$daemon\" 2>/dev/null && kill -0 \"$updater\" 2>/dev/null; do sleep 1; done",
            "cat /tmp/clamd.log /tmp/freshclam.log >&2 || true",
            "exit 1",
        ].join("\n");
        child = spawn(dockerCommand, ["run", "--rm", "--name", containerName, "--label", `com.sporades.dev-task=${identity}`, "--user", `${uid}:${gid}`, "--volume", `${dataRoot}:/app/data`, "--entrypoint", "/bin/sh", SPORADES_BASE_IMAGE.image, "-ec", script], { stdio: ["ignore", "pipe", "pipe"] });
        const retain = (chunk) => { output = (output + chunk.toString("utf8")).slice(-8192); };
        child.stdout.on("data", retain);
        child.stderr.on("data", retain);
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        const bridgeSource = "const net=require('node:net');const socket=net.createConnection('/tmp/sporades-clamd.sock');process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('error',()=>process.exit(1));";
        proxy = (options.proxyServerFactory ?? createServer)((socket) => { proxySockets.add(socket); const bridge = spawn(dockerCommand, ["exec", "-i", containerName, "node", "-e", bridgeSource], { stdio: ["pipe", "pipe", "ignore"] }); bridges.add(bridge); socket.pipe(bridge.stdin); bridge.stdout.pipe(socket); const close = () => { bridges.delete(bridge); proxySockets.delete(socket); socket.destroy(); }; bridge.once("close", close); bridge.once("error", close); socket.once("error", () => { try {
            bridge.kill("SIGTERM");
        }
        catch { } }); });
        await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(socketPath, resolve); });
    }
    catch (error) {
        const failures = [];
        for (const socket of proxySockets)
            socket.destroy();
        for (const bridge of bridges) {
            try {
                bridge.kill("SIGTERM");
            }
            catch { }
        }
        if (proxy)
            await new Promise((resolve) => { try {
                proxy.close(() => resolve());
            }
            catch {
                resolve();
            } });
        if (child) {
            const removed = await commandResult(options.dockerCommand ?? "docker", ["rm", "-f", containerName], 30_000);
            if (removed.code !== 0 && !/No such container/i.test(`${removed.stdout}\n${removed.stderr}`))
                failures.push(new Error("Dev File inspection container cleanup failed."));
            if (!await ensureDevClamavChildExit(child, 5_000))
                failures.push(new Error("Dev File inspection process did not exit."));
        }
        try {
            await rm(socketDir, { recursive: true, force: true });
        }
        catch (cleanupError) {
            failures.push(cleanupError);
        }
        if (failures.length)
            throw new AggregateError([error, ...failures], "Dev File inspection startup and cleanup both failed.");
        throw error;
    }
    const descriptor = { containerName, socketPath, process: child, externallyManaged: true, diagnosticOutput: () => output };
    return {
        descriptor,
        attach(database) { database.__clamavDevSidecar = descriptor; },
        async stop() {
            if (stopped)
                return;
            const failures = [];
            for (const socket of proxySockets)
                socket.destroy();
            proxySockets.clear();
            if (proxy)
                await new Promise((resolve) => proxy.close(() => resolve()));
            for (const bridge of bridges) {
                try {
                    bridge.kill("SIGTERM");
                }
                catch { }
            }
            bridges.clear();
            const removed = await commandResult(options.dockerCommand ?? "docker", ["rm", "-f", containerName], 30_000);
            if (removed.code !== 0 && !/No such container/i.test(`${removed.stdout}\n${removed.stderr}`))
                failures.push(new Error("Dev File inspection container cleanup failed."));
            if (!await ensureDevClamavChildExit(child, 5_000))
                failures.push(new Error("Dev File inspection process did not exit."));
            try {
                await rm(socketDir, { recursive: true, force: true });
            }
            catch (error) {
                failures.push(error);
            }
            const residue = await commandResult(options.dockerCommand ?? "docker", ["container", "inspect", containerName], 30_000);
            if (residue.code === 0)
                failures.push(new Error("Dev File inspection container remained after cleanup."));
            if (failures.length === 1)
                throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(failures, "Dev File inspection cleanup failed.");
            stopped = true;
        },
    };
}
//# sourceMappingURL=dev-clamav-sidecar.js.map