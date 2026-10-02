import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
export const inventoryHostPattern = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const states = new Set(["registered", "released", "started", "stopped", "failed", "deleted", "opted-out"]);
const fail = () => { throw new Error("Invalid lifecycle inventory."); };
export function validateInventory(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail();
    const v = value;
    if (Object.keys(v).some(k => !["schemaVersion", "host", "revision", "capsules"].includes(k)) || v.schemaVersion !== 1 || typeof v.host !== "string" || !inventoryHostPattern.test(v.host) || !Number.isSafeInteger(v.revision) || v.revision < 1 || !Array.isArray(v.capsules) || v.capsules.length > 10000)
        return fail();
    const seen = new Set();
    const capsules = v.capsules.map((c) => {
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["identity", "state", "targets", "releaseId", "lifecycleAt"].includes(k)) || typeof c.identity !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(c.identity) || seen.has(c.identity) || !states.has(c.state) || !Array.isArray(c.targets) || c.targets.length > 100)
            return fail();
        seen.add(c.identity);
        const targets = c.targets.map((target) => {
            if (typeof target !== "string" || target.length > 2048)
                return fail();
            let url;
            try {
                url = new URL(target);
            }
            catch {
                return fail();
            }
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.toString() !== target)
                return fail();
            return target;
        }).sort();
        if (new Set(targets).size !== targets.length || (c.state === "deleted" && targets.length))
            return fail();
        if (c.releaseId !== undefined && (typeof c.releaseId !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(c.releaseId)))
            return fail();
        if (c.lifecycleAt !== undefined && (typeof c.lifecycleAt !== "string" || !Number.isFinite(Date.parse(c.lifecycleAt)) || new Date(c.lifecycleAt).toISOString() !== c.lifecycleAt))
            return fail();
        return { identity: c.identity, state: c.state, targets, ...(c.releaseId ? { releaseId: c.releaseId } : {}), ...(c.lifecycleAt ? { lifecycleAt: c.lifecycleAt } : {}) };
    }).sort((a, b) => a.identity.localeCompare(b.identity));
    const result = { schemaVersion: 1, host: v.host, revision: v.revision, capsules };
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
        return fail();
    return result;
}
export async function readInventoryFile(file) {
    try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.geteuid && stat.uid !== process.geteuid()))
            throw new Error("Unprotected inventory state.");
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw e;
    }
}
export async function writeInventoryFile(file, value) {
    const tmp = `${file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
        const handle = await open(tmp, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(value)}\n`);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(tmp, file);
        const directory = await open(path.dirname(file), "r");
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await rm(tmp, { force: true });
    }
}
// The OS owns lock release, including process crashes and Host restarts. A
// held child stdin keeps the advisory lock alive until the atomic write ends.
export async function withInventoryLock(directory, fn) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.geteuid && stat.uid !== process.geteuid()))
        throw new Error("Unprotected inventory directory.");
    const file = path.join(directory, ".lock");
    try {
        const lockStat = await lstat(file);
        if (!lockStat.isFile() || lockStat.isSymbolicLink() || (lockStat.mode & 0o077))
            throw new Error("Unsafe inventory lock.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    try {
        await writeFile(file, "", { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    // Darwin is only a local development surface; production is Linux/flock.
    const python = "import fcntl,os,sys\nfd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint('locked',flush=True)\nsys.stdin.read()";
    const child = process.platform === "darwin"
        ? spawn("/usr/bin/python3", ["-c", python, file], { stdio: ["pipe", "pipe", "ignore"] })
        : spawn("/usr/bin/flock", ["--exclusive", "--timeout", "5", file, process.execPath, "-e", "process.stdout.write('locked\\n');process.stdin.resume()"], { stdio: ["pipe", "pipe", "ignore"] });
    const released = new Promise(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    try {
        await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => { child.kill(); reject(new Error("Inventory state is busy.")); }, 6000);
            const finish = (error) => { clearTimeout(deadline); error ? reject(error) : resolve(); };
            child.stdout.once("data", () => finish());
            child.once("error", () => finish(new Error("Inventory locking is unavailable.")));
            child.once("exit", () => finish(new Error("Inventory locking is unavailable.")));
        });
        return await fn();
    }
    finally {
        child.stdin.end();
        await released;
    }
}
export async function acknowledgeInventory(directory, authority, input) {
    const inventory = validateInventory(input);
    if (inventory.host !== authority)
        throw Object.assign(new Error("Inventory authority denied."), { status: 403 });
    return withInventoryLock(directory, async () => {
        const file = path.join(directory, `${authority}.json`);
        const prior = await readInventoryFile(file);
        if (prior) {
            const old = validateInventory(prior.inventory);
            if (inventory.revision < old.revision || (inventory.revision === old.revision && JSON.stringify(inventory) !== JSON.stringify(old)))
                throw Object.assign(new Error("Inventory revision conflict."), { status: 409 });
            if (inventory.revision === old.revision)
                return prior;
        }
        if (prior) {
            const ids = new Set(inventory.capsules.map(c => c.identity));
            // Require the sender to carry tombstones: prevents ambiguous omission and
            // keeps equal-revision retry comparisons exact after a sender restart.
            if (prior.inventory.capsules.some(c => !ids.has(c.identity)))
                throw Object.assign(new Error("Inventory identities omitted."), { status: 409 });
        }
        const ack = { inventory, acknowledgedAt: new Date().toISOString() };
        await writeInventoryFile(file, ack);
        return ack;
    });
}
//# sourceMappingURL=lifecycle-inventory.js.map