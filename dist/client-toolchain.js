import path from "node:path";
import { realpath } from "node:fs/promises";
import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
export async function buildClientToolchain(options) {
    if (options.toolchain === "vite")
        return buildReactVite(options);
    return buildEsbuild(options);
}
async function buildEsbuild(options) {
    const { build } = await import("esbuild");
    try {
        const outputDir = path.join(path.dirname(options.clientSourcePath), ".sporades-esbuild-public");
        const result = await build({
            bundle: true,
            format: "esm",
            platform: "browser",
            write: false,
            logLevel: "silent",
            sourcemap: "external",
            outdir: outputDir,
            entryNames: "client",
            chunkNames: "assets/[name]-[hash]",
            assetNames: "assets/[name]-[hash]",
            splitting: true,
            loader: {
                ".svg": "file", ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file",
                ".webp": "file", ".ico": "file", ".woff": "file", ".woff2": "file",
            },
            jsx: "automatic",
            ...(options.frameworkConfig.jsxImportSource ? { jsxImportSource: options.frameworkConfig.jsxImportSource } : {}),
            stdin: {
                contents: options.clientSource,
                sourcefile: options.clientSourcePath,
                resolveDir: path.dirname(options.clientSourcePath),
                loader: options.frameworkConfig.loader,
            },
            plugins: [sporadesEsbuildClientPlugin()],
        });
        const outputs = result.outputFiles ?? [];
        const clientOutput = outputs.find((output) => path.relative(outputDir, output.path) === "client.js");
        if (!clientOutput)
            throw clientToolchainError("Client bundle failed: esbuild returned no output.", `Fix client/${options.frameworkConfig.entry} and save again.`);
        const clientBundle = [
            "// Sporades client bundle",
            `// Client framework: ${options.frameworkConfig.framework}`,
            ...(options.frameworkConfig.jsxImportSource ? [
                `// JSX import source: ${options.frameworkConfig.jsxImportSource}`,
                `// JSX runtime import: ${options.frameworkConfig.jsxRuntimeImport}`,
            ] : []),
            'console.log("Sporades client bundle loaded");',
            "",
            clientOutput.text,
        ].join("\n");
        return {
            legacyClientBundle: clientBundle,
            diagnostics: { framework: options.frameworkConfig.framework, toolchain: "esbuild", refresh: "none" },
            publicFiles: [
                { path: "index.html", contents: options.indexHtml },
                ...outputs.map((output) => {
                    const emittedPath = path.relative(outputDir, output.path).split(path.sep).join("/");
                    const relativePath = emittedPath === "client.css" || emittedPath === "client.css.map" ? `assets/${emittedPath}` : emittedPath;
                    return { path: relativePath, contents: relativePath === "client.js" ? clientBundle : output.contents };
                }),
            ],
        };
    }
    catch (error) {
        if (hasHint(error))
            throw error;
        throw clientToolchainError(`Client bundle failed: ${boundedBuildMessage(error)}`, `Fix client/${options.frameworkConfig.entry} and save again.`);
    }
}
async function buildReactVite(options) {
    if (options.frameworkConfig.framework !== "react") {
        throw clientToolchainError(`Unsupported client framework/toolchain combination: ${options.frameworkConfig.framework}/vite`, "Use React with Vite, or keep Preact and Vanilla TypeScript on esbuild.");
    }
    if (referencesLegacyClientShell(options.indexHtml)) {
        throw clientToolchainError("React/Vite requires an author-owned source entry in index.html.", 'Replace the `/client.js` script with `<script type="module" src="/client/index.tsx"></script>`, then retry.');
    }
    if (!referencesReactSourceEntry(options.indexHtml)) {
        throw clientToolchainError("React/Vite could not find the client source entry in index.html.", 'Add `<script type="module" src="/client/index.tsx"></script>` to the author-owned HTML shell.');
    }
    const { build } = await import("vite");
    try {
        const projectRoot = await realpath(options.projectDir);
        const result = await build({
            root: projectRoot,
            base: "/",
            publicDir: false,
            configFile: false,
            envFile: false,
            envPrefix: "\0",
            define: {
                "import.meta.env": JSON.stringify({ BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false }),
            },
            appType: "mpa",
            clearScreen: false,
            logLevel: "silent",
            esbuild: { jsx: "automatic", jsxImportSource: "react" },
            plugins: [sporadesViteClientPlugin()],
            build: {
                write: false,
                emptyOutDir: false,
                sourcemap: true,
                cssCodeSplit: true,
                assetsInlineLimit: 0,
                rollupOptions: {
                    output: {
                        entryFileNames: "assets/[name]-[hash].js",
                        chunkFileNames: "assets/[name]-[hash].js",
                        assetFileNames: "assets/[name]-[hash][extname]",
                    },
                },
            },
        });
        const outputs = Array.isArray(result) ? result : [result];
        const files = new Map();
        for (const output of outputs) {
            if (!("output" in output))
                throw new Error("Vite unexpectedly entered watch mode.");
            for (const item of output.output) {
                const relativePath = normalizeOutputPath(item.fileName);
                files.set(relativePath, item.type === "asset" ? item.source : item.code);
                if (item.type === "chunk" && item.map) {
                    const mapPath = `${relativePath}.map`;
                    if (!files.has(mapPath))
                        files.set(mapPath, item.map.toString());
                }
            }
        }
        if (!files.has("index.html"))
            throw new Error("Vite returned no transformed index.html output.");
        return {
            publicFiles: [...files].map(([filePath, contents]) => ({ path: filePath, contents })),
            legacyClientBundle: null,
            diagnostics: { framework: "react", toolchain: "vite", refresh: "full-page" },
        };
    }
    catch (error) {
        if (hasHint(error))
            throw error;
        throw viteBuildError(error, options.projectDir);
    }
}
function sporadesEsbuildClientPlugin() {
    return {
        name: "sporades-client",
        setup(build) {
            build.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: "sporades/client", namespace: "sporades-runtime" }));
            build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({ loader: "js", contents: createClientRuntimeSource() }));
        },
    };
}
function sporadesViteClientPlugin() {
    const runtimeId = "\0sporades:client-runtime";
    return {
        name: "sporades-client-runtime",
        enforce: "pre",
        resolveId(id) { return id === "sporades/client" ? runtimeId : null; },
        load(id) { return id === runtimeId ? createClientRuntimeSource() : null; },
    };
}
function referencesLegacyClientShell(html) {
    return /<script\b[^>]*\bsrc\s*=\s*["']\/?client\.js(?:\?[^"']*)?["'][^>]*>/i.test(html);
}
function referencesReactSourceEntry(html) {
    return /<script\b[^>]*\bsrc\s*=\s*["']\/?client\/index\.tsx(?:\?[^"']*)?["'][^>]*>/i.test(html);
}
function normalizeOutputPath(fileName) {
    const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes(".."))
        throw new Error("Vite emitted an unsafe public path.");
    return normalized;
}
function viteBuildError(error, projectDir) {
    const details = errorDetails(error);
    const message = boundedBuildMessage(error, projectDir);
    const loc = errorDetails(details.loc);
    const rawFile = typeof loc.file === "string" ? loc.file : typeof details.id === "string" ? details.id : null;
    const relativeFile = rawFile ? safeRelativeDiagnosticPath(projectDir, rawFile) : null;
    return clientToolchainError(`Client bundle failed: ${message}`, "Fix the React/Vite client source and save again.", {
        ...(typeof details.code === "string" ? { code: details.code.slice(0, 80) } : {}),
        ...(relativeFile ? { file: relativeFile } : {}),
        ...(Number.isInteger(loc.line) ? { line: loc.line } : {}),
        ...(Number.isInteger(loc.column) ? { column: loc.column } : {}),
    });
}
function safeRelativeDiagnosticPath(projectDir, fileName) {
    const relative = path.relative(projectDir, fileName).split(path.sep).join("/");
    return relative && !relative.startsWith("../") && relative !== ".." ? relative.slice(0, 240) : path.basename(fileName).slice(0, 120);
}
function boundedBuildMessage(error, projectDir) {
    const details = errorDetails(error);
    const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
    let message = typeof errorDetails(firstError).text === "string"
        ? String(errorDetails(firstError).text)
        : typeof details.message === "string" ? details.message : "unknown error";
    if (projectDir)
        message = message.split(projectDir).join("<project>");
    return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}
function clientToolchainError(message, hint, diagnostics) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics && Object.keys(diagnostics).length > 0)
        error.diagnostics = diagnostics;
    return error;
}
function errorDetails(error) {
    return error && typeof error === "object" ? error : { message: String(error) };
}
function hasHint(error) {
    return Boolean(error && typeof error === "object" && typeof error.hint === "string");
}
//# sourceMappingURL=client-toolchain.js.map