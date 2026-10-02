export const INVENTORY_MAX_BYTES = 1024 * 1024;
export function inventoryHost(value) {
    return typeof value === "string" && value.length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}
function invalid() { throw new Error("Invalid lifecycle inventory."); }
function keys(value, names) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.sort().join())
        invalid();
}
export function validateInventory(value) {
    keys(value, ["schemaVersion", "host", "revision", "capsules"]);
    if (value.schemaVersion !== 1 || !inventoryHost(value.host) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
        invalid();
    if (!Array.isArray(value.capsules) || value.capsules.length > 2000 || JSON.stringify(value).length > INVENTORY_MAX_BYTES)
        invalid();
    const ids = new Set();
    const capsules = value.capsules.map((item) => {
        keys(item, ["id", "state", "changedAt", "release", "targets"]);
        if (typeof item.id !== "string" || item.id.length > 320)
            invalid();
        const [domain, subname, extra] = item.id.split("/");
        if (!inventoryHost(domain) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subname ?? "") || extra !== undefined || ids.has(item.id))
            invalid();
        ids.add(item.id);
        if (!["registered", "released", "running", "stopped", "failed", "deleted", "opted-out"].includes(String(item.state)))
            invalid();
        if (typeof item.changedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.changedAt) || !Number.isFinite(Date.parse(item.changedAt)))
            invalid();
        if (item.release !== null && (typeof item.release !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(item.release)))
            invalid();
        if (!Array.isArray(item.targets) || item.targets.length > 20 || new Set(item.targets).size !== item.targets.length)
            invalid();
        for (const target of item.targets) {
            if (typeof target !== "string" || target.length > 2048)
                invalid();
            let url;
            try {
                url = new URL(target);
            }
            catch {
                return invalid();
            }
            // Only bare public application origins, never tokens, health paths, payloads or local ports.
            if (!["https:", "http:"].includes(url.protocol) || !inventoryHost(url.hostname) || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || url.href !== target)
                invalid();
        }
        if (["deleted", "opted-out", "stopped"].includes(String(item.state)) && item.targets.length)
            invalid();
        return { ...item, targets: [...item.targets].sort() };
    }).sort((a, b) => a.id.localeCompare(b.id));
    return { schemaVersion: 1, host: value.host, revision: Number(value.revision), capsules };
}
/** Token reuse across Hosts would widen write authority and is rejected at setup. */
export function validateInventoryCredentials(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 1000)
        invalid();
    const tokens = new Set();
    for (const [host, token] of Object.entries(value)) {
        if (!inventoryHost(host) || typeof token !== "string" || token.length < 16 || token.length > 4096 || /^REPLACE_WITH_/.test(token) || /[\x00-\x20\x7f]/.test(token) || tokens.has(token))
            invalid();
        tokens.add(token);
    }
    return value;
}
//# sourceMappingURL=inventory-contract.js.map