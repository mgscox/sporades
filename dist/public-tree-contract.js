export const PUBLIC_TREE_LIMITS = {
    files: 512,
    fileBytes: 16 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    pathBytes: 240,
};
export function normalizePublicTreePath(value) {
    if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
        return null;
    if (Buffer.byteLength(value, "utf8") > PUBLIC_TREE_LIMITS.pathBytes)
        return null;
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".."))
        return null;
    return segments.join("/");
}
export function publicTreePathFromRequest(rawPathname) {
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
    if (!decoded.startsWith("/") || /%[0-9a-f]{2}/i.test(decoded))
        return null;
    return normalizePublicTreePath(decoded.slice(1));
}
export function validatePublicTreeFileSet(files) {
    if (files.length > PUBLIC_TREE_LIMITS.files)
        return { ok: false, reason: "files" };
    const canonicalPaths = new Set();
    let totalBytes = 0;
    let hasIndex = false;
    for (const file of files) {
        const normalized = normalizePublicTreePath(file.path);
        if (normalized === null || !Number.isSafeInteger(file.size) || file.size < 0)
            return { ok: false, reason: "path" };
        const canonical = normalized.normalize("NFC");
        if (canonicalPaths.has(canonical))
            return { ok: false, reason: "collision" };
        canonicalPaths.add(canonical);
        if (file.size > PUBLIC_TREE_LIMITS.fileBytes)
            return { ok: false, reason: "file-bytes", path: normalized };
        totalBytes += file.size;
        if (totalBytes > PUBLIC_TREE_LIMITS.totalBytes)
            return { ok: false, reason: "total-bytes" };
        if (normalized === "index.html")
            hasIndex = true;
    }
    if (!hasIndex)
        return { ok: false, reason: "index" };
    return { ok: true, fileCount: files.length, totalBytes };
}
//# sourceMappingURL=public-tree-contract.js.map