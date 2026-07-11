import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
export const PUBLIC_TREE_LIMITS = {
    files: 512,
    fileBytes: 16 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    pathBytes: 240,
};
const LIVE_PUBLIC_TREE_LEASES = new Set();
const OWNER_HEARTBEATS = new Map();
const execFileAsync = promisify(execFile);
const UNVERIFIED_OWNER_TTL_MS = 30_000;
const OWNER_HEARTBEAT_INTERVAL_MS = 10_000;
const OWNER_CLOCK_SKEW_MS = 5_000;
export async function createPublicTree(buildDir, files, options = {}) {
    const nonce = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
    const treesDir = path.join(buildDir, ".public-trees");
    const stagingDir = path.join(treesDir, `.staging-${nonce}`);
    const publicDir = path.join(treesDir, nonce);
    const normalizedFiles = normalizePublicFiles(files);
    await mkdir(treesDir, { recursive: true });
    const releaseLock = await acquirePublicTreeLock(treesDir);
    let published = false;
    let lease = null;
    try {
        await cleanupPublicTreesUnlocked(buildDir, { maxCompleted: 1, fault: options.cleanupFault });
        await mkdir(stagingDir, { recursive: false });
        for (const file of normalizedFiles) {
            const destination = path.join(stagingDir, ...file.path.split("/"));
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, file.contents);
        }
        await validatePublicTree(stagingDir);
        lease = await createPublicTreeLease(treesDir, nonce);
        await rename(stagingDir, publicDir);
        published = true;
        await cleanupPublicTreesUnlocked(buildDir, { keepRoots: [publicDir], maxCompleted: 1, fault: options.cleanupFault });
        return {
            root: publicDir,
            assets: new Map(normalizedFiles.map((file) => [file.path, publicAsset(file.path, file.contents)])),
            lease,
        };
    }
    catch (error) {
        if (published)
            await rm(publicDir, { recursive: true, force: true });
        if (lease)
            await removePublicTreeLease(lease).catch(() => { });
        throw error;
    }
    finally {
        await rm(stagingDir, { recursive: true, force: true });
        await releaseLock();
    }
}
export async function discardPublicTree(tree) {
    const treesDir = path.dirname(tree.root);
    const releaseLock = await acquirePublicTreeLock(treesDir);
    try {
        const activeReference = await readActivePublicTreeReference(treesDir);
        if (activeReference === path.basename(tree.root)) {
            throw publicTreeError("Active public tree cannot be discarded.", "Preserve the referenced candidate until the active public tree reference is repaired.", { candidateDiscard: "forbidden", activeTree: activeReference });
        }
        await removePublicTreeLease(tree.lease);
        await rm(tree.root, { recursive: true, force: true });
    }
    finally {
        await releaseLock();
    }
}
export async function releasePublicTreeLease(tree) {
    const treesDir = path.dirname(tree.root);
    const releaseLock = await acquirePublicTreeLock(treesDir);
    try {
        await removePublicTreeLease(tree.lease);
        await cleanupPublicTreesUnlocked(path.dirname(treesDir), { maxCompleted: 1 });
    }
    finally {
        await releaseLock();
    }
}
export async function validatePublicTree(root) {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw publicTreeError("Invalid public tree.", "The public output root must be a real directory.");
    }
    const canonicalPaths = new Map();
    let fileCount = 0;
    let totalBytes = 0;
    async function visit(directory, prefix = "") {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            validateRelativePublicPath(relativePath);
            const canonicalPath = relativePath.normalize("NFC");
            const collision = canonicalPaths.get(canonicalPath);
            if (collision && collision !== relativePath) {
                throw publicTreeError("Invalid public tree.", `Remove the normalization collision between ${collision} and ${relativePath}.`);
            }
            canonicalPaths.set(canonicalPath, relativePath);
            const absolutePath = path.join(directory, entry.name);
            const stats = await lstat(absolutePath);
            if (stats.isSymbolicLink()) {
                throw publicTreeError("Invalid public tree.", `Replace the symbolic link at ${relativePath} with a regular file.`);
            }
            if (stats.isDirectory()) {
                await visit(absolutePath, relativePath);
                continue;
            }
            if (!stats.isFile()) {
                throw publicTreeError("Invalid public tree.", `Remove the unsupported entry at ${relativePath}.`);
            }
            fileCount += 1;
            totalBytes += stats.size;
            if (fileCount > PUBLIC_TREE_LIMITS.files) {
                throw publicTreeError("Invalid public tree.", `Public output may contain at most ${PUBLIC_TREE_LIMITS.files} files.`);
            }
            if (stats.size > PUBLIC_TREE_LIMITS.fileBytes) {
                throw publicTreeError("Invalid public tree.", `${relativePath} exceeds the per-file public output limit.`);
            }
            if (totalBytes > PUBLIC_TREE_LIMITS.totalBytes) {
                throw publicTreeError("Invalid public tree.", "Public output exceeds the aggregate size limit.");
            }
        }
    }
    await visit(root);
    const indexStats = await lstat(path.join(root, "index.html")).catch(() => null);
    if (!indexStats?.isFile() || indexStats.isSymbolicLink()) {
        throw publicTreeError("Invalid public tree.", "Client output must contain a regular index.html file.");
    }
    return { fileCount, totalBytes };
}
export async function validateActivePublicTreeReference(treesDir, raw) {
    let tree;
    try {
        tree = JSON.parse(raw)?.tree;
    }
    catch {
        tree = null;
    }
    if (!(typeof tree === "string" && isPublicTreeName(tree))) {
        throw publicTreeError("Invalid active public tree reference.", "The active tree name is unsafe or malformed.");
    }
    const root = path.join(treesDir, tree);
    const stats = await lstat(root).catch(() => null);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw publicTreeError("Invalid active public tree reference.", "The active tree must reference an existing real public-tree directory.");
    }
    await validatePublicTree(root);
    return tree;
}
export function validatePublicFiles(files) {
    const normalized = normalizePublicFiles(files);
    return {
        fileCount: normalized.length,
        totalBytes: normalized.reduce((total, file) => total + file.contents.byteLength, 0),
    };
}
export async function cleanupPublicTrees(buildDir, options = {}) {
    const treesDir = path.join(buildDir, ".public-trees");
    await mkdir(treesDir, { recursive: true });
    const releaseLock = await acquirePublicTreeLock(treesDir);
    try {
        await cleanupPublicTreesUnlocked(buildDir, options);
    }
    finally {
        await releaseLock();
    }
}
async function cleanupPublicTreesUnlocked(buildDir, options = {}) {
    const treesDir = path.join(buildDir, ".public-trees");
    const entries = await readdir(treesDir, { withFileTypes: true }).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return [];
        throw error;
    });
    const keepNames = new Set((options.keepRoots ?? []).filter((root) => path.dirname(root) === treesDir).map((root) => path.basename(root)));
    const activeReference = await readActivePublicTreeReference(treesDir);
    if (typeof activeReference === "string") {
        keepNames.add(activeReference);
    }
    const now = options.now ?? Date.now;
    const { live: liveLeaseNames, stale: staleLeaseNames } = await publicTreeLeaseStates(treesDir, now);
    for (const name of liveLeaseNames)
        keepNames.add(name);
    const completed = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && isPublicTreeName(entry.name))
        .map(async (entry) => ({ entry, modifiedAt: (await lstat(path.join(treesDir, entry.name))).mtimeMs })));
    completed.sort((left, right) => right.modifiedAt - left.modifiedAt);
    let recoverableCount = 0;
    for (const item of completed) {
        if (keepNames.has(item.entry.name))
            continue;
        if (staleLeaseNames.has(item.entry.name))
            continue;
        if (recoverableCount >= (options.maxCompleted ?? 1))
            break;
        keepNames.add(item.entry.name);
        recoverableCount += 1;
    }
    const failures = [];
    for (const entry of entries) {
        if (entry.name === "active.json" || entry.name === ".leases" || entry.name === ".lifecycle-lock" || entry.name === ".owner-heartbeats")
            continue;
        if (keepNames.has(entry.name))
            continue;
        const entryPath = path.join(treesDir, entry.name);
        try {
            options.fault?.("before-remove", entryPath);
            await rm(entryPath, { recursive: true, force: true });
        }
        catch {
            failures.push(entry.name);
        }
    }
    if (failures.length > 0) {
        throw publicTreeError("Public tree cleanup degraded.", `Could not remove ${failures.length} stale public tree entr${failures.length === 1 ? "y" : "ies"}; the active and recoverable trees were preserved.`);
    }
    await removeStalePublicTreeLeases(treesDir, new Set(completed.map((item) => item.entry.name)), now);
    await removeOrphanedOwnerHeartbeats(treesDir);
}
export async function readPublicAsset(tree, rawPathname) {
    const relativePath = publicPathFromRequest(rawPathname);
    return relativePath ? tree.assets.get(relativePath) ?? null : null;
}
function publicPathFromRequest(rawPathname) {
    if (/%2f|%5c/i.test(rawPathname))
        return null;
    let decoded;
    try {
        decoded = decodeURIComponent(rawPathname);
    }
    catch {
        return null;
    }
    if (decoded === "/")
        return "index.html";
    if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0"))
        return null;
    if (/%[0-9a-f]{2}/i.test(decoded))
        return null;
    try {
        return validateRelativePublicPath(decoded.slice(1));
    }
    catch {
        return null;
    }
}
function validateRelativePublicPath(value) {
    if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
        throw publicTreeError("Invalid public path.", "Public paths must be safe relative POSIX paths.");
    }
    if (Buffer.byteLength(value, "utf8") > PUBLIC_TREE_LIMITS.pathBytes) {
        throw publicTreeError("Invalid public path.", `Public paths may be at most ${PUBLIC_TREE_LIMITS.pathBytes} bytes.`);
    }
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw publicTreeError("Invalid public path.", "Public paths cannot be empty, current-directory, or parent-directory paths.");
    }
    return segments.join("/");
}
function normalizePublicFiles(files) {
    const paths = new Map();
    let totalBytes = 0;
    const normalized = files.map((file) => {
        const relativePath = validateRelativePublicPath(file.path);
        const canonicalPath = relativePath.normalize("NFC");
        const collision = paths.get(canonicalPath);
        if (collision) {
            throw publicTreeError("Invalid public tree.", `Remove the normalization collision between ${collision} and ${relativePath}.`);
        }
        paths.set(canonicalPath, relativePath);
        const contents = Buffer.from(typeof file.contents === "string" ? file.contents : file.contents);
        if (contents.byteLength > PUBLIC_TREE_LIMITS.fileBytes) {
            throw publicTreeError("Invalid public tree.", `${relativePath} exceeds the per-file public output limit.`);
        }
        totalBytes += contents.byteLength;
        return { path: relativePath, contents };
    });
    if (normalized.length > PUBLIC_TREE_LIMITS.files) {
        throw publicTreeError("Invalid public tree.", `Public output may contain at most ${PUBLIC_TREE_LIMITS.files} files.`);
    }
    if (totalBytes > PUBLIC_TREE_LIMITS.totalBytes) {
        throw publicTreeError("Invalid public tree.", "Public output exceeds the aggregate size limit.");
    }
    if (!paths.has("index.html")) {
        throw publicTreeError("Invalid public tree.", "Client output must contain a regular index.html file.");
    }
    return normalized;
}
function publicAsset(relativePath, contents) {
    return {
        body: Buffer.from(contents),
        contentType: publicContentType(relativePath),
        relativePath,
        html: relativePath === "index.html",
    };
}
function publicContentType(relativePath) {
    switch (path.extname(relativePath).toLowerCase()) {
        case ".html": return "text/html; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".json":
        case ".map": return "application/json; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".ico": return "image/x-icon";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        case ".txt": return "text/plain; charset=utf-8";
        default: return "application/octet-stream";
    }
}
async function createPublicTreeLease(treesDir, treeName) {
    const leasesDir = path.join(treesDir, ".leases");
    await mkdir(leasesDir, { recursive: true });
    const token = randomBytes(16).toString("hex");
    const leasePath = path.join(leasesDir, `${treeName}.json`);
    const processStart = await getProcessStartIdentity(process.pid);
    const record = {
        tree: treeName,
        pid: process.pid,
        processStart,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        token,
    };
    await writeFile(leasePath, `${JSON.stringify(record)}\n`, { flag: "wx" });
    LIVE_PUBLIC_TREE_LEASES.add(token);
    if (processStart === null)
        startOwnerHeartbeat(leasePath, record);
    return { path: leasePath, token };
}
async function removePublicTreeLease(lease) {
    await stopOwnerHeartbeat(lease.token);
    const record = await readFile(lease.path, "utf8").then(JSON.parse).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return null;
        throw error;
    });
    if (record && record.token !== lease.token) {
        LIVE_PUBLIC_TREE_LEASES.delete(lease.token);
        throw publicTreeError("Public tree lease ownership changed.", "Preserve the candidate and retry cleanup from its owning build.");
    }
    await rm(lease.path, { force: true });
    LIVE_PUBLIC_TREE_LEASES.delete(lease.token);
}
async function publicTreeLeaseStates(treesDir, now) {
    const leasesDir = path.join(treesDir, ".leases");
    const entries = await readdir(leasesDir).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return [];
        throw error;
    });
    const live = new Set();
    const stale = new Set();
    for (const entry of entries) {
        try {
            const lease = JSON.parse(await readFile(path.join(leasesDir, entry), "utf8"));
            if (validLeaseRecord(lease)) {
                if (await leaseIsLive(lease, path.join(leasesDir, entry), now))
                    live.add(lease.tree);
                else
                    stale.add(lease.tree);
            }
            else if (entry.endsWith(".json"))
                stale.add(entry.slice(0, -5));
        }
        catch {
            if (entry.endsWith(".json"))
                stale.add(entry.slice(0, -5));
        }
    }
    return { live, stale };
}
async function removeStalePublicTreeLeases(treesDir, completedNames, now) {
    const leasesDir = path.join(treesDir, ".leases");
    const entries = await readdir(leasesDir).catch((error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return [];
        throw error;
    });
    for (const entry of entries) {
        const leasePath = path.join(leasesDir, entry);
        let lease = null;
        try {
            lease = JSON.parse(await readFile(leasePath, "utf8"));
        }
        catch { }
        if (!validLeaseRecord(lease) || !completedNames.has(lease.tree) || !(await leaseIsLive(lease, leasePath, now))) {
            if (validLeaseRecord(lease)) {
                LIVE_PUBLIC_TREE_LEASES.delete(lease.token);
                await stopOwnerHeartbeat(lease.token);
            }
            await rm(leasePath, { force: true });
        }
    }
}
function validLeaseRecord(lease) {
    return Boolean(lease
        && typeof lease.tree === "string"
        && !lease.tree.includes("/")
        && !lease.tree.includes("\\")
        && Number.isInteger(lease.pid)
        && lease.pid > 0
        && (typeof lease.processStart === "string" || lease.processStart === null)
        && Number.isFinite(lease.createdAt)
        && Number.isFinite(lease.heartbeatAt)
        && typeof lease.token === "string"
        && lease.token.length > 0);
}
async function leaseIsLive(lease, recordPath, now) {
    if (lease.pid === process.pid && !LIVE_PUBLIC_TREE_LEASES.has(lease.token))
        return false;
    return ownerIdentityIsLive(lease, recordPath, now);
}
async function readActivePublicTreeReference(treesDir) {
    try {
        return await validateActivePublicTreeReference(treesDir, await readFile(path.join(treesDir, "active.json"), "utf8"));
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return null;
        throw publicTreeError("Public tree cleanup degraded.", "The active public tree reference is invalid; no referenced candidate may be discarded.", { candidateDiscard: "forbidden" });
    }
}
function isPublicTreeName(value) {
    return /^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(value);
}
async function acquirePublicTreeLock(treesDir) {
    const lockDir = path.join(treesDir, ".lifecycle-lock");
    for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
            await mkdir(lockDir);
            const ownerPath = path.join(lockDir, "owner.json");
            const token = randomBytes(16).toString("hex");
            const processStart = await getProcessStartIdentity(process.pid);
            const owner = {
                pid: process.pid,
                processStart,
                createdAt: Date.now(),
                heartbeatAt: Date.now(),
                token,
            };
            await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
            if (processStart === null)
                startOwnerHeartbeat(ownerPath, owner);
            return async () => {
                await stopOwnerHeartbeat(token);
                const currentOwner = await readFile(ownerPath, "utf8").then(JSON.parse).catch((error) => {
                    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
                        return null;
                    throw error;
                });
                if (currentOwner === null)
                    return;
                if (currentOwner.token !== token) {
                    throw publicTreeError("Public tree lock ownership changed.", "Preserve the successor lock and retry after its owner completes.");
                }
                await rm(lockDir, { recursive: true, force: true });
            };
        }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
                throw error;
            const owner = await readFile(path.join(lockDir, "owner.json"), "utf8")
                .then((raw) => JSON.parse(raw))
                .catch(() => null);
            if (owner !== null && !(await ownerIdentityIsLive(owner, path.join(lockDir, "owner.json")))) {
                await rm(lockDir, { recursive: true, force: true });
                continue;
            }
            if (owner === null) {
                const ageMs = Date.now() - await lstat(lockDir).then((stats) => stats.mtimeMs).catch(() => Date.now());
                if (ageMs > 1_000) {
                    await rm(lockDir, { recursive: true, force: true });
                    continue;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw publicTreeError("Public tree lifecycle is busy.", "Retry after the other Bundle operation completes.");
}
async function ownerIdentityIsLive(owner, recordPath, clock = Date.now) {
    if (!validOwnerRecord(owner))
        return false;
    const actualStart = await getProcessStartIdentity(owner.pid);
    if (actualStart !== null && typeof owner.processStart === "string")
        return actualStart === owner.processStart;
    const heartbeatAge = clock() - await readOwnerHeartbeat(recordPath, owner);
    return processIsLive(owner.pid) && heartbeatAge >= -OWNER_CLOCK_SKEW_MS && heartbeatAge <= UNVERIFIED_OWNER_TTL_MS;
}
function validOwnerRecord(owner) {
    return Boolean(owner
        && Number.isInteger(owner.pid)
        && owner.pid > 0
        && (typeof owner.processStart === "string" || owner.processStart === null)
        && Number.isFinite(owner.createdAt)
        && Number.isFinite(owner.heartbeatAt)
        && typeof owner.token === "string"
        && owner.token.length > 0);
}
function startOwnerHeartbeat(recordPath, record) {
    let stopped = false;
    let inFlight = Promise.resolve();
    const heartbeatPath = ownerHeartbeatPath(recordPath, record.token);
    const refresh = async () => {
        const current = await readFile(recordPath, "utf8").then(JSON.parse).catch(() => null);
        if (!validOwnerRecord(current) || current.token !== record.token) {
            stopped = true;
            clearInterval(timer);
            return;
        }
        await mkdir(path.dirname(heartbeatPath), { recursive: true });
        await writeFile(heartbeatPath, `${JSON.stringify({ token: record.token, heartbeatAt: Date.now() })}\n`);
    };
    const timer = setInterval(() => {
        if (!stopped)
            inFlight = inFlight.then(refresh).catch(() => { });
    }, OWNER_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    OWNER_HEARTBEATS.set(record.token, {
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            await inFlight;
            await rm(heartbeatPath, { force: true });
        },
    });
}
function ownerHeartbeatPath(recordPath, token) {
    const ownerDir = path.dirname(recordPath);
    const treesDir = [".leases", ".lifecycle-lock"].includes(path.basename(ownerDir)) ? path.dirname(ownerDir) : ownerDir;
    return path.join(treesDir, ".owner-heartbeats", `${token}.json`);
}
async function readOwnerHeartbeat(recordPath, owner) {
    try {
        const heartbeat = JSON.parse(await readFile(ownerHeartbeatPath(recordPath, owner.token), "utf8"));
        if (!(heartbeat && heartbeat.token === owner.token && Number.isFinite(heartbeat.heartbeatAt)))
            return Number.NaN;
        return heartbeat.heartbeatAt;
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return owner.heartbeatAt;
        return Number.NaN;
    }
}
async function stopOwnerHeartbeat(token) {
    const heartbeat = OWNER_HEARTBEATS.get(token);
    OWNER_HEARTBEATS.delete(token);
    await heartbeat?.stop();
}
async function removeOrphanedOwnerHeartbeats(treesDir) {
    const retained = new Set();
    const leaseFiles = await readdir(path.join(treesDir, ".leases")).catch(() => []);
    for (const entry of leaseFiles) {
        const lease = await readFile(path.join(treesDir, ".leases", entry), "utf8").then(JSON.parse).catch(() => null);
        if (validLeaseRecord(lease))
            retained.add(lease.token);
    }
    const lock = await readFile(path.join(treesDir, ".lifecycle-lock", "owner.json"), "utf8").then(JSON.parse).catch(() => null);
    if (validOwnerRecord(lock))
        retained.add(lock.token);
    const heartbeatDir = path.join(treesDir, ".owner-heartbeats");
    const heartbeatFiles = await readdir(heartbeatDir).catch(() => []);
    for (const entry of heartbeatFiles) {
        const token = entry.endsWith(".json") ? entry.slice(0, -5) : "";
        if (!retained.has(token))
            await rm(path.join(heartbeatDir, entry), { recursive: true, force: true });
    }
}
export async function getProcessStartIdentity(pid, options = {}) {
    if (!(Number.isInteger(pid) && pid > 0))
        return null;
    const platform = options.platform ?? process.platform;
    if (platform === "linux") {
        try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            return fields[19] ? `linux:${fields[19]}` : null;
        }
        catch {
            return null;
        }
    }
    if (platform === "darwin") {
        try {
            const run = options.execFile ?? execFileAsync;
            const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
                env: { ...process.env, LC_ALL: "C", LANG: "C" },
            });
            const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(stdout.trim().replace(/\s+/g, " "));
            if (!match)
                return null;
            const month = String(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]) + 1).padStart(2, "0");
            return `darwin:${match[4]}-${month}-${match[2].padStart(2, "0")}T${match[3]}`;
        }
        catch {
            return null;
        }
    }
    return null;
}
function processIsLive(pid) {
    if (pid === process.pid)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
    }
}
function publicTreeError(message, hint, diagnostics) {
    return Object.assign(new Error(message), { hint, ...(diagnostics === undefined ? {} : { diagnostics }) });
}
//# sourceMappingURL=public-tree.js.map