import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { SPORADES_BASE_IMAGE } from "./base-image.js";
const DEV_CLAMAV_READY_MARKER = "sporades-clamav-ready-v1";
const DEV_CLAMAV_HOST_READY_TIMEOUT_MS = 125_000;
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
function devClamavNow(timing) { return timing?.now?.() ?? Date.now(); }
function waitForDevClamavChildExitAttempt(child, timeoutMs, timing, signal) {
    if (!child || devClamavChildTerminated(child))
        return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const remove = () => { child.removeListener?.("exit", onExit); child.removeListener?.("close", onClose); child.removeListener?.("error", onError); };
        const finish = (value) => { if (settled)
            return; settled = true; if (timer)
            clearTimeout(timer); remove(); if (value)
            child.__sporadesClamavTerminated = true; resolve(value || devClamavChildTerminated(child)); };
        const onExit = () => finish(true);
        const onClose = () => finish(true);
        const onError = () => finish(false);
        child.once("exit", onExit);
        child.once("close", onClose);
        child.once("error", onError);
        if (signal) {
            try {
                child.kill(signal);
            }
            catch {
                if (!devClamavChildTerminated(child)) {
                    finish(false);
                    return;
                }
            }
        }
        if (settled || devClamavChildTerminated(child)) {
            finish(true);
            return;
        }
        const remaining = Math.max(0, timeoutMs);
        if (timing?.delay)
            Promise.resolve(timing.delay(remaining)).then(() => finish(false), () => finish(false));
        else
            timer = setTimeout(() => finish(false), remaining);
    });
}
export function waitForDevClamavChildExit(child, timeoutMs, timing) { return waitForDevClamavChildExitAttempt(child, timeoutMs, timing); }
export async function ensureDevClamavChildExit(child, timeoutMs, timing) {
    const startedAt = devClamavNow(timing);
    const deadline = startedAt + Math.max(0, timeoutMs);
    const firstWait = Math.floor(Math.max(0, timeoutMs) / 2);
    if (await waitForDevClamavChildExit(child, firstWait, timing))
        return true;
    return await waitForDevClamavChildExitAttempt(child, Math.max(0, deadline - devClamavNow(timing)), timing, "SIGKILL");
}
function waitForDevClamavReadinessProof(child, deadline, ready, now) {
    if (ready() && now() <= deadline)
        return Promise.resolve(true);
    if (!child || devClamavChildTerminated(child))
        return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const remove = () => { child.stdout?.removeListener?.("data", onData); child.removeListener?.("exit", onTerminated); child.removeListener?.("close", onTerminated); child.removeListener?.("error", onTerminated); };
        const finish = (ready) => { if (settled)
            return; settled = true; if (timer)
            clearTimeout(timer); remove(); resolve(ready); };
        const onData = () => { if (ready() && now() <= deadline)
            finish(true); };
        const onTerminated = () => finish(false);
        const expire = () => { const remaining = deadline - now(); if (remaining <= 0)
            finish(false);
        else
            timer = setTimeout(expire, Math.max(1, Math.ceil(remaining))); };
        child.stdout?.on?.("data", onData);
        child.once("exit", onTerminated);
        child.once("close", onTerminated);
        child.once("error", onTerminated);
        expire();
        if (ready() && now() <= deadline)
            finish(true);
    });
}
function devClamavUnavailableError() {
    return Object.assign(new Error("Required Dev File inspection scanner did not become ready."), { code: "FILE_INSPECTION_UNAVAILABLE" });
}
function waitForDevClamavLifecycleTurn(unavailable, alive) {
    if (!alive())
        return Promise.resolve(false);
    return Promise.race([
        unavailable.then(() => false),
        new Promise((resolve) => setImmediate(() => resolve(alive()))),
    ]);
}
async function devClamavContainerIsRunning(dockerCommand, containerName, deadline, now) {
    const remaining = deadline - now();
    if (remaining < 0)
        return false;
    const result = await commandResult(dockerCommand, ["container", "inspect", "--format", "{{.State.Running}}", containerName], Math.max(1, Math.ceil(remaining)));
    return result.code === 0 && result.stdout.trim() === "true" && now() <= deadline;
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
    let readinessLine = "";
    let readinessLineOverflow = false;
    let readinessProven = false;
    let childUnavailable = false;
    let signalChildUnavailable = () => { };
    const childUnavailablePromise = new Promise((resolve) => { signalChildUnavailable = resolve; });
    try {
        const dockerCommand = options.dockerCommand ?? "docker";
        await ensureBaseImage(dockerCommand, options.dockerfile, options.buildContext);
        const uid = process.getuid?.() ?? 10001;
        const gid = process.getgid?.() ?? 10001;
        const script = [
            "set -eu",
            "/usr/bin/freshclam --config-file=/etc/clamav/freshclam.conf",
            "/usr/sbin/clamd --foreground --config-file=/etc/clamav/clamd.conf >/tmp/clamd.log 2>&1 & daemon=$!",
            "trap 'kill -TERM \"$daemon\" 2>/dev/null || true; wait \"$daemon\" 2>/dev/null || true' EXIT INT TERM",
            "ready=0",
            "while kill -0 \"$daemon\" 2>/dev/null; do if printf '%s' 'sporades file inspection readiness' | /usr/bin/clamdscan --config-file=/etc/clamav/clamd.conf --stream - >/tmp/clamd-ready.log 2>&1; then ready=1; break; fi; sleep .1; done",
            "if [ \"$ready\" -ne 1 ]; then cat /tmp/clamd.log /tmp/clamd-ready.log >&2 2>/dev/null || true; exit 1; fi",
            "/usr/bin/freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf >/tmp/freshclam.log 2>&1 & updater=$!",
            "kill -0 \"$updater\" 2>/dev/null",
            `printf '%s\\n' '${DEV_CLAMAV_READY_MARKER}'`,
            "trap 'kill -TERM \"$daemon\" \"$updater\" 2>/dev/null || true; wait \"$daemon\" \"$updater\" 2>/dev/null || true' EXIT INT TERM",
            "while kill -0 \"$daemon\" 2>/dev/null && kill -0 \"$updater\" 2>/dev/null; do sleep 1; done",
            "cat /tmp/clamd.log /tmp/freshclam.log >&2 || true",
            "exit 1",
        ].join("\n");
        child = spawn(dockerCommand, ["run", "--rm", "--name", containerName, "--label", `com.sporades.dev-task=${identity}`, "--user", `${uid}:${gid}`, "--volume", `${dataRoot}:/app/data`, "--entrypoint", "/bin/sh", SPORADES_BASE_IMAGE.image, "-ec", script], { stdio: ["ignore", "pipe", "pipe"] });
        const removeChildLifecycleListeners = () => { child.removeListener?.("exit", onChildUnavailable); child.removeListener?.("close", onChildUnavailable); child.removeListener?.("error", onChildUnavailable); };
        const onChildUnavailable = () => { if (childUnavailable)
            return; childUnavailable = true; child.__sporadesClamavTerminated = true; removeChildLifecycleListeners(); signalChildUnavailable(); };
        child.once("exit", onChildUnavailable);
        child.once("close", onChildUnavailable);
        child.once("error", onChildUnavailable);
        const childIsAlive = () => !childUnavailable && !devClamavChildTerminated(child);
        const retain = (chunk) => { output = (output + chunk.toString("utf8")).slice(-8192); };
        const retainStdout = (chunk) => {
            retain(chunk);
            const text = chunk.toString("utf8");
            let cursor = 0;
            while (cursor < text.length) {
                const newline = text.indexOf("\n", cursor);
                const segment = text.slice(cursor, newline < 0 ? text.length : newline);
                if (!readinessLineOverflow) {
                    readinessLine += segment;
                    if (readinessLine.length > DEV_CLAMAV_READY_MARKER.length + 1) {
                        readinessLine = "";
                        readinessLineOverflow = true;
                    }
                }
                if (newline < 0)
                    break;
                if (!readinessLineOverflow && (readinessLine === DEV_CLAMAV_READY_MARKER || readinessLine === `${DEV_CLAMAV_READY_MARKER}\r`))
                    readinessProven = true;
                readinessLine = "";
                readinessLineOverflow = false;
                cursor = newline + 1;
            }
        };
        child.stdout.on("data", retainStdout);
        child.stderr.on("data", retain);
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        const requestedReadinessTimeout = options.readinessTimeoutMs;
        const readinessTimeoutMs = Number.isFinite(requestedReadinessTimeout) ? Math.max(1, Math.min(DEV_CLAMAV_HOST_READY_TIMEOUT_MS, Math.trunc(requestedReadinessTimeout))) : DEV_CLAMAV_HOST_READY_TIMEOUT_MS;
        const readinessNow = options.readinessTiming?.now ?? (() => performance.now());
        const readinessDeadline = readinessNow() + readinessTimeoutMs;
        const containerIsRunning = options.readinessTiming?.containerIsRunning ?? (() => devClamavContainerIsRunning(dockerCommand, containerName, readinessDeadline, readinessNow));
        if (!await waitForDevClamavReadinessProof(child, readinessDeadline, () => readinessProven, readinessNow))
            throw devClamavUnavailableError();
        if (!await waitForDevClamavLifecycleTurn(childUnavailablePromise, childIsAlive))
            throw devClamavUnavailableError();
        if (!await containerIsRunning() || !childIsAlive())
            throw devClamavUnavailableError();
        const bridgeSource = "const net=require('node:net');const socket=net.createConnection('/tmp/sporades-clamd.sock');process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('error',()=>process.exit(1));";
        proxy = (options.proxyServerFactory ?? createServer)((socket) => { proxySockets.add(socket); const bridge = spawn(dockerCommand, ["exec", "-i", containerName, "node", "-e", bridgeSource], { stdio: ["pipe", "pipe", "ignore"] }); bridges.add(bridge); socket.pipe(bridge.stdin); bridge.stdout.pipe(socket); const close = () => { bridges.delete(bridge); proxySockets.delete(socket); socket.destroy(); }; bridge.once("close", close); bridge.once("error", close); socket.once("error", () => { try {
            bridge.kill("SIGTERM");
        }
        catch { } }); });
        const proxyPublished = new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(socketPath, () => resolve(true)); });
        if (!await Promise.race([proxyPublished, childUnavailablePromise.then(() => false)]))
            throw devClamavUnavailableError();
        if (!await containerIsRunning() || !childIsAlive())
            throw devClamavUnavailableError();
        if (!await waitForDevClamavLifecycleTurn(childUnavailablePromise, childIsAlive))
            throw devClamavUnavailableError();
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