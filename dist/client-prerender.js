import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
export function readClientPrerenderConfig(value, toolchain) {
    if (value === undefined)
        return [];
    const hint = "Set `client.prerender` to an ordered array of unique `{ name, module }` entries for a Vite client.";
    if (!Array.isArray(value))
        throw prerenderError("Invalid client prerender configuration.", hint);
    if (toolchain !== "vite") {
        throw prerenderError("Client prerender fragments require the Vite client toolchain.", "Set `client.toolchain` to `vite`, or remove `client.prerender` from sporades.json.");
    }
    const names = new Set();
    const fragments = value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw prerenderError(`Invalid client prerender entry at index ${index}.`, hint);
        }
        const record = entry;
        if (Object.keys(record).some((key) => key !== "name" && key !== "module")) {
            throw prerenderError(`Invalid client prerender entry at index ${index}.`, hint);
        }
        if (typeof record.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(record.name)) {
            throw prerenderError(`Invalid client prerender name at index ${index}.`, "Use a unique 1-64 character name beginning with a letter and containing only letters, digits, `_`, or `-`.");
        }
        if (names.has(record.name)) {
            throw prerenderError(`Duplicate client prerender name: ${record.name}.`, "Give every `client.prerender` entry a unique name.");
        }
        names.add(record.name);
        if (typeof record.module !== "string" || !isProjectRelativeModulePath(record.module)) {
            throw prerenderError(`Invalid client prerender module for ${record.name}.`, "Use a non-empty project-relative module path without absolute, parent, dot, or backslash segments.");
        }
        return { name: record.name, module: record.module };
    });
    if (fragments.length > 1) {
        throw prerenderError("This Sporades version supports one configured prerender fragment.", "Configure one `client.prerender` entry. Ordered multi-fragment builds are not available yet.");
    }
    return fragments;
}
export async function renderClientPrerenderFragment(projectRoot, fragment) {
    const modulePath = path.resolve(projectRoot, ...fragment.module.split("/"));
    let canonicalModulePath;
    try {
        const metadata = await lstat(modulePath);
        if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error("not a regular project file");
        canonicalModulePath = await realpath(modulePath);
        if (!isCanonicalDescendant(projectRoot, canonicalModulePath))
            throw new Error("escaped the Capsule project");
    }
    catch (error) {
        throw prerenderError(`Could not load client prerender module for ${fragment.name}.`, `Restore the regular project-owned module at ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    let bundledSource;
    try {
        const { build } = await import("esbuild");
        const result = await build({
            absWorkingDir: projectRoot,
            bundle: true,
            entryNames: "renderer",
            entryPoints: { renderer: canonicalModulePath },
            format: "cjs",
            logLevel: "silent",
            outdir: path.join(projectRoot, ".sporades-prerender-output"),
            platform: "node",
            sourcemap: false,
            target: "node22",
            write: false,
        });
        const outputs = result.outputFiles ?? [];
        const javascript = outputs.filter((output) => output.path.endsWith(".js"));
        if (outputs.length !== 1 || javascript.length !== 1 || !javascript[0]?.text) {
            throw new Error("the renderer produced an unsupported secondary output");
        }
        bundledSource = javascript[0].text;
    }
    catch (error) {
        if (hasHint(error))
            throw error;
        throw prerenderError(`Could not build client prerender module for ${fragment.name}: ${boundedMessage(error, projectRoot)}`, `Fix ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    try {
        const renderer = executeBundledRenderer(bundledSource, canonicalModulePath, fragment.module);
        if (typeof renderer !== "function") {
            throw prerenderError(`Client prerender module for ${fragment.name} must default-export a zero-argument renderer.`, `Default-export a function from ${fragment.module} that returns an HTML string or Promise<string>.`);
        }
        const rendered = await renderer();
        if (typeof rendered !== "string") {
            throw prerenderError(`Client prerender renderer for ${fragment.name} returned a non-string result.`, `Return an HTML string or Promise<string> from ${fragment.module}.`, { fragment: fragment.name, resultType: rendered === null ? "null" : typeof rendered });
        }
        return rendered;
    }
    catch (error) {
        if (hasHint(error))
            throw error;
        throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error)}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
}
export function placeClientPrerenderFragment(html, fragment, rendered) {
    const escapedName = fragment.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const marker = new RegExp(`<!--\\s*sporades:prerender\\s+${escapedName}\\s*-->`, "g");
    const bounded = `<!-- sporades:prerender-boundary-start ${fragment.name} -->${rendered}<!-- sporades:prerender-boundary-end ${fragment.name} -->`;
    if (marker.test(html))
        return html.replace(marker, () => bounded);
    if (/<!--\s*sporades:prerender(?:\s+[A-Za-z][A-Za-z0-9_-]{0,63})?\s*-->/.test(html))
        return html;
    const body = /<body\b[^>]*>/i;
    if (!body.test(html)) {
        throw prerenderError("Client prerender fallback placement requires an opening body element.", "Add an opening `<body>` element or a named `<!-- sporades:prerender NAME -->` marker to index.html.", { fragment: fragment.name });
    }
    return html.replace(body, (openingBody) => `${openingBody}${bounded}`);
}
function isProjectRelativeModulePath(value) {
    if (!value || value.includes("\\") || path.posix.isAbsolute(value))
        return false;
    const segments = value.split("/");
    return segments.every((segment) => segment && segment !== "." && segment !== "..");
}
function isCanonicalDescendant(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function executeBundledRenderer(source, modulePath, displayPath) {
    const moduleRecord = { exports: {} };
    // Renderers share the trusted-build-code boundary of project Vite config. Execute the
    // in-memory CommonJS bundle fresh on every build: project-rooted require supports Node
    // builtins/native externals without adding a unique data URL to the permanent ESM cache.
    const execute = new Function("exports", "require", "module", "__filename", "__dirname", `${source}\n//# sourceURL=${displayPath.replaceAll("\\", "/")}\n`);
    execute(moduleRecord.exports, createRequire(modulePath), moduleRecord, modulePath, path.dirname(modulePath));
    const exported = moduleRecord.exports;
    return exported && typeof exported === "object" && "default" in exported
        ? exported.default
        : undefined;
}
function boundedMessage(error, projectRoot) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    const redacted = projectRoot ? message.split(projectRoot).join("<project>") : message;
    return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}
function prerenderError(message, hint, diagnostics) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics)
        error.diagnostics = diagnostics;
    return error;
}
function hasHint(error) {
    return Boolean(error && typeof error === "object" && typeof error.hint === "string");
}
//# sourceMappingURL=client-prerender.js.map