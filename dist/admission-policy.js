import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { readDeployFile, resolveDeployFiles, preservedDeployFilePath } from "./deploy-files.js";
export const ADMISSION_LIMITS = Object.freeze({ bytes: 65536, depth: 8, rules: 128, conditions: 16, textBytes: 1024, reloadMs: 2000 });
const invalid = () => { throw new Error("Invalid admission policy."); };
function object(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        invalid();
}
function text(value) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= ADMISSION_LIMITS.textBytes && !/[\x00-\x1f\x7f]/.test(value); }
function freeze(value) { if (value && typeof value === "object") {
    for (const child of Object.values(value))
        freeze(child);
    Object.freeze(value);
} return value; }
function depth(value, level = 0) { if (level > ADMISSION_LIMITS.depth)
    invalid(); if (value && typeof value === "object")
    for (const child of Object.values(value))
        depth(child, level + 1); }
const controls = ["/__sporades/health/runtime", "/__sporades/connection-token"];
function condition(value) {
    object(value, ["kind", "value", "exact", "prefix", "name"]);
    switch (value.kind) {
        case "method":
            object(value, ["kind", "value"]);
            if (!text(value.value) || !/^[A-Z]{1,32}$/.test(value.value))
                invalid();
            break;
        case "pathname": {
            object(value, ["kind", "exact", "prefix"]);
            const target = value.exact ?? value.prefix;
            if ((value.exact !== undefined) === (value.prefix !== undefined) || !text(target) || !target.startsWith("/") || target.startsWith("//") || /[\\?#%]/.test(target) || new URL(target, "http://localhost").pathname !== target)
                invalid();
            if (controls.some(control => value.exact === control || (value.prefix !== undefined && (control === target || control.startsWith(target.endsWith("/") ? target : `${target}/`)))))
                invalid();
            break;
        }
        case "address": {
            object(value, ["kind", "value"]);
            if (!text(value.value))
                invalid();
            const [address, prefix, extra] = value.value.split("/");
            const family = isIP(address);
            if (!family || extra !== undefined || (prefix !== undefined && (!/^(0|[1-9][0-9]{0,2})$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))))
                invalid();
            break;
        }
        case "header":
            object(value, ["kind", "name", "value"]);
            if (!text(value.name) || !/^[a-z0-9!#$&'*+.^_`|~-]+$/.test(value.name) || /^(authorization|proxy-authorization|cookie|set-cookie|forwarded|x-forwarded-.*|x-sporades-.*|cf-.*)$/.test(value.name) || (value.value !== undefined && (typeof value.value !== "string" || Buffer.byteLength(value.value) > ADMISSION_LIMITS.textBytes || /[\x00-\x1f\x7f]/.test(value.value))))
                invalid();
            break;
        case "query-key":
            object(value, ["kind", "name"]);
            if (!text(value.name))
                invalid();
            break;
        default: invalid();
    }
}
export function parseAdmissionPolicy(bytes) {
    if (bytes.length > ADMISSION_LIMITS.bytes)
        invalid();
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
        invalid();
    let value;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    }
    catch {
        invalid();
    }
    depth(value);
    object(value, ["version", "rules"]);
    if (value.version !== 1 || !Array.isArray(value.rules) || value.rules.length > ADMISSION_LIMITS.rules)
        invalid();
    const ids = new Set();
    for (const rule of value.rules) {
        object(rule, ["id", "enabled", "conditions", "action"]);
        if (typeof rule.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(rule.id) || ids.has(rule.id) || typeof rule.enabled !== "boolean" || !Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > ADMISSION_LIMITS.conditions)
            invalid();
        ids.add(rule.id);
        for (const item of rule.conditions)
            condition(item);
        object(rule.action, ["kind", "limit", "windowMs"]);
        if (rule.action.kind === "deny")
            object(rule.action, ["kind"]);
        else if (rule.action.kind === "rate-limit") {
            if (!Number.isSafeInteger(rule.action.limit) || rule.action.limit < 1 || rule.action.limit > 1000000 || !Number.isSafeInteger(rule.action.windowMs) || rule.action.windowMs < 1000 || rule.action.windowMs > 86400000)
                invalid();
        }
        else
            invalid();
    }
    return freeze({ digest: createHash("sha256").update(bytes).digest("hex"), policy: value });
}
/** First-match exact-path slice. An indeterminate condition must never grant admission. */
export function matchExactAdmissionRule(generation, pathname) {
    for (const rule of generation.policy.rules) {
        if (!rule.enabled)
            continue;
        if (rule.conditions.some(item => item.kind === "pathname" && "exact" in item && item.exact !== pathname))
            continue;
        if (rule.conditions.some(item => item.kind !== "pathname" || !("exact" in item))) {
            throw new Error("Unsupported admission condition.");
        }
        return rule;
    }
    return null;
}
export function resolveAdmissionPolicy(value, files = undefined) {
    if (value === undefined)
        return null;
    object(value, ["path"]);
    const relative = resolveDeployFiles([{ path: value.path }])[0].path;
    const name = relative.normalize("NFC").toLowerCase();
    if (resolveDeployFiles(files).some(file => { const other = file.path.normalize("NFC").toLowerCase(); return other === name || other.startsWith(`${name}/`) || name.startsWith(`${other}/`); }))
        throw new Error("Admission policy overlaps deploy.files.");
    return relative;
}
export function admissionStorageRoot(preservedRoot) { return path.join(preservedRoot, "admission"); }
export async function buildAdmissionPolicy(projectDir, value, files) {
    const relative = resolveAdmissionPolicy(value, files);
    if (!relative)
        return [];
    const contents = await readDeployFile(projectDir, relative, ADMISSION_LIMITS.bytes);
    parseAdmissionPolicy(contents);
    return [{ path: relative, update: "admission", contents }];
}
// This marker is a publication protocol, never accepted as user policy JSON.
const REMOVED = Buffer.from('{"sporadesAdmissionPublication":1,"removed":true}\n');
export async function publishAdmissionPolicy(root, relative, bytes) {
    if (bytes)
        parseAdmissionPolicy(bytes);
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error("Unsafe admission storage.");
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const temporary = `.publish-${randomUUID()}`;
    // Linux descriptor paths pin publication to the checked directory.
    const anchored = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : root;
    const target = path.join(anchored, path.basename(preservedDeployFilePath(root, relative)));
    let output;
    try {
        const identity = await handle.stat();
        const named = await lstat(root);
        if (identity.dev !== named.dev || identity.ino !== named.ino || named.isSymbolicLink())
            throw new Error("Unsafe admission storage.");
        // Validate existing authority; disappearance is an error, never implicit removal.
        const previous = await lstat(target).catch(error => { if (error.code === "ENOENT")
            return null; throw error; });
        if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1))
            throw new Error("Unsafe admission policy file.");
        output = await open(path.join(anchored, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
        await output.writeFile(bytes ?? REMOVED);
        await output.chmod(0o444);
        await output.sync();
        await output.close();
        output = undefined;
        const current = await lstat(root);
        if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink())
            throw new Error("Unsafe admission storage.");
        await rename(path.join(anchored, temporary), target);
        await handle.sync();
    }
    finally {
        await output?.close();
        await rm(path.join(anchored, temporary), { force: true });
        await handle.close();
    }
}
export async function openAdmissionPolicy(root, relative, onHealth) {
    let active = null;
    let health = Object.freeze({ state: "disabled", digest: null });
    let closed = false;
    let pending = null;
    function report(state) {
        const next = Object.freeze({ state, digest: active?.digest ?? null });
        if (next.state === health.state && next.digest === health.digest)
            return;
        health = next;
        try {
            onHealth?.(health);
        }
        catch { /* Diagnostics never break reload. */ }
    }
    async function load(cold) {
        try {
            const bytes = await readDeployFile(root, relative, ADMISSION_LIMITS.bytes);
            const next = bytes.equals(REMOVED) ? null : parseAdmissionPolicy(bytes);
            active = next;
            report(next ? "healthy" : "disabled");
        }
        catch {
            report("degraded");
            if (cold)
                throw new Error("Configured admission policy could not be loaded.");
        }
    }
    await load(true);
    const reload = () => {
        if (closed)
            return Promise.resolve();
        if (!pending)
            pending = load(false).finally(() => { pending = null; });
        return pending;
    };
    const timer = setInterval(() => { void reload(); }, ADMISSION_LIMITS.reloadMs);
    timer.unref();
    return Object.freeze({ current: () => active, health: () => health, reload, close: async () => { closed = true; clearInterval(timer); await pending; } });
}
//# sourceMappingURL=admission-policy.js.map