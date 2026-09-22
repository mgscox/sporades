import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactBuildProjectRoots } from "./build-diagnostics.js";
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
export async function renderClientPrerenderFragment(projectRoot, fragment, projectRoots = [projectRoot]) {
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
        const { build, transform } = await import("esbuild");
        const projectTsconfigRaw = await readOptionalFile(path.join(projectRoot, "tsconfig.json"));
        const result = await build({
            absWorkingDir: projectRoot,
            bundle: true,
            entryNames: "renderer",
            entryPoints: { renderer: canonicalModulePath },
            format: "cjs",
            logLevel: "silent",
            outdir: path.join(projectRoot, ".sporades-prerender-output"),
            platform: "node",
            plugins: [preserveRendererImportMetaUrl(transform, projectTsconfigRaw)],
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
        throw prerenderError(`Could not build client prerender module for ${fragment.name}: ${boundedMessage(error, projectRoots)}`, `Fix ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    let renderer;
    try {
        renderer = executeBundledRenderer(bundledSource, canonicalModulePath, fragment.module);
    }
    catch (error) {
        throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, projectRoots)}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    if (typeof renderer !== "function") {
        throw prerenderError(`Client prerender module for ${fragment.name} must default-export a zero-argument renderer.`, `Default-export a function from ${fragment.module} that returns an HTML string or Promise<string>.`);
    }
    let rendered;
    try {
        rendered = await renderer();
    }
    catch (error) {
        throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, projectRoots)}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    if (typeof rendered !== "string") {
        throw prerenderError(`Client prerender renderer for ${fragment.name} returned a non-string result.`, `Return an HTML string or Promise<string> from ${fragment.module}.`, { fragment: fragment.name, resultType: rendered === null ? "null" : typeof rendered });
    }
    return rendered;
}
async function readOptionalFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function preserveRendererImportMetaUrl(transform, projectTsconfigRaw) {
    const loaders = new Map([
        [".cjs", "js"],
        [".cts", "ts"],
        [".js", "js"],
        [".jsx", "jsx"],
        [".mjs", "js"],
        [".mts", "ts"],
        [".ts", "ts"],
        [".tsx", "tsx"],
    ]);
    return {
        name: "sporades-renderer-import-meta-url",
        setup(build) {
            build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, async (args) => {
                const contents = await readFile(args.path, "utf8");
                if (!contents.includes("import.meta.url"))
                    return undefined;
                const loader = loaders.get(path.extname(args.path));
                if (!loader)
                    return undefined;
                const result = await transform(contents, {
                    define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) },
                    jsx: "preserve",
                    loader,
                    sourcefile: args.path,
                    target: "esnext",
                    ...(projectTsconfigRaw === undefined ? {} : { tsconfigRaw: projectTsconfigRaw }),
                });
                return {
                    contents: result.code,
                    loader,
                    resolveDir: path.dirname(args.path),
                    watchFiles: [args.path],
                };
            });
        },
    };
}
export function placeClientPrerenderFragment(html, fragment, rendered) {
    const bounded = `<!-- sporades:prerender-boundary-start ${fragment.name} -->${rendered}<!-- sporades:prerender-boundary-end ${fragment.name} -->`;
    const placement = scanClientPrerenderHtml(html);
    if (placement.problem) {
        throw prerenderError(`Client prerender placement could not safely scan index.html: ${placement.problem}.`, "Fix the malformed HTML construct in index.html, then retry.", { fragment: fragment.name });
    }
    const namedMarkers = placement.markers.filter((marker) => marker.name === fragment.name);
    if (namedMarkers.length > 0) {
        let replaced = "";
        let cursor = 0;
        for (const marker of namedMarkers) {
            replaced += `${html.slice(cursor, marker.start)}${bounded}`;
            cursor = marker.end;
        }
        return `${replaced}${html.slice(cursor)}`;
    }
    if (placement.markers.length > 0)
        return html;
    if (placement.bodyEnd === undefined) {
        throw prerenderError("Client prerender fallback placement requires an opening body element.", "Add an opening `<body>` element or a named `<!-- sporades:prerender NAME -->` marker to index.html.", { fragment: fragment.name });
    }
    return `${html.slice(0, placement.bodyEnd)}${bounded}${html.slice(placement.bodyEnd)}`;
}
function scanClientPrerenderHtml(html) {
    const lowerHtml = foldAsciiCase(html);
    const rawTextElements = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);
    const markers = [];
    let bodyEnd;
    let problem;
    let cursor = 0;
    while (cursor < html.length) {
        const tagStart = html.indexOf("<", cursor);
        if (tagStart === -1)
            break;
        if (html.startsWith("<!--", tagStart)) {
            const commentEnd = findHtmlCommentEnd(html, tagStart);
            if (!commentEnd) {
                problem = "unterminated HTML comment";
                break;
            }
            const marker = /^\s*sporades:prerender(?:\s+([A-Za-z][A-Za-z0-9_-]{0,63}))?\s*$/.exec(html.slice(tagStart + 4, commentEnd.contentEnd));
            if (marker)
                markers.push({ start: tagStart, end: commentEnd.end, name: marker[1] });
            cursor = commentEnd.end;
            continue;
        }
        if (html.startsWith("<![CDATA[", tagStart)) {
            const cdataEnd = html.indexOf("]]>", tagStart + 9);
            if (cdataEnd === -1) {
                problem = "unterminated CDATA section";
                break;
            }
            cursor = cdataEnd + 3;
            continue;
        }
        let nameStart = tagStart + 1;
        const closing = html[nameStart] === "/";
        if (closing)
            nameStart += 1;
        if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
            const declarationEnd = findHtmlTagEnd(html, nameStart);
            cursor = declarationEnd === undefined ? tagStart + 1 : declarationEnd;
            continue;
        }
        let nameEnd = nameStart + 1;
        while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? ""))
            nameEnd += 1;
        const name = lowerHtml.slice(nameStart, nameEnd);
        const tagEnd = findHtmlTagEnd(html, nameEnd);
        if (tagEnd === undefined)
            break;
        if (!closing && name === "body" && bodyEnd === undefined)
            bodyEnd = tagEnd;
        cursor = tagEnd;
        if (!closing && rawTextElements.has(name)) {
            if (name === "plaintext")
                break;
            const rawTextEnd = findRawTextElementEnd(html, lowerHtml, cursor, name);
            if (rawTextEnd === undefined) {
                problem = `unterminated raw text element: ${name}`;
                break;
            }
            cursor = rawTextEnd;
        }
    }
    return { bodyEnd, markers, problem };
}
function findHtmlCommentEnd(html, commentStart) {
    const contentStart = commentStart + 4;
    if (html[contentStart] === ">")
        return { contentEnd: contentStart, end: contentStart + 1 };
    if (html.startsWith("->", contentStart))
        return { contentEnd: contentStart, end: contentStart + 2 };
    const standardEnd = html.indexOf("-->", contentStart);
    const bangEnd = html.indexOf("--!>", contentStart);
    if (standardEnd === -1 && bangEnd === -1)
        return undefined;
    if (bangEnd !== -1 && (standardEnd === -1 || bangEnd < standardEnd)) {
        return { contentEnd: bangEnd, end: bangEnd + 4 };
    }
    return { contentEnd: standardEnd, end: standardEnd + 3 };
}
function foldAsciiCase(value) {
    return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}
function findHtmlTagEnd(html, cursor) {
    let quote;
    for (let index = cursor; index < html.length; index += 1) {
        const character = html[index];
        if (quote) {
            if (character === quote)
                quote = undefined;
        }
        else if (character === "\"" || character === "'") {
            quote = character;
        }
        else if (character === ">") {
            return index + 1;
        }
    }
    return undefined;
}
function findRawTextElementEnd(html, lowerHtml, cursor, name) {
    const closingPrefix = `</${name}`;
    while (cursor < html.length) {
        const closingStart = lowerHtml.indexOf(closingPrefix, cursor);
        if (closingStart === -1)
            return undefined;
        const boundary = html[closingStart + closingPrefix.length];
        if (boundary === ">" || boundary === "/" || /\s/.test(boundary ?? "")) {
            return findHtmlTagEnd(html, closingStart + closingPrefix.length);
        }
        cursor = closingStart + closingPrefix.length;
    }
    return undefined;
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
function boundedMessage(error, projectRoots = []) {
    let message;
    try {
        message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    }
    catch {
        message = "Thrown error message unavailable.";
    }
    const redacted = redactBuildProjectRoots(message, projectRoots);
    return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}
function prerenderError(message, hint, diagnostics) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics)
        error.diagnostics = diagnostics;
    return error;
}
//# sourceMappingURL=client-prerender.js.map