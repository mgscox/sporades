import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
export async function buildClientToolchain(options) {
    validateClientToolchainInput(options);
    if (options.toolchain === "vite")
        return buildVite(options);
    return buildEsbuild(options);
}
export function validateClientToolchainInput(options) {
    if (options.toolchain !== "vite")
        return;
    const frameworkLabel = options.frameworkConfig.framework === "preact" ? "Preact" : options.frameworkConfig.framework === "vue" ? "Vue" : options.frameworkConfig.framework === "svelte" ? "Svelte" : "React";
    if (!new Set(["react", "preact", "vue", "svelte"]).has(options.frameworkConfig.framework)) {
        throw clientToolchainError(`Unsupported client framework/toolchain combination: ${options.frameworkConfig.framework}/vite`, "Use React, Preact, Vue, or Svelte with Vite, or keep Vanilla TypeScript on esbuild.");
    }
    if (referencesLegacyClientShell(options.indexHtml)) {
        throw clientToolchainError(`${frameworkLabel}/Vite requires an author-owned source entry in index.html.`, `Replace the \`/client.js\` script with \`<script type="module" src="/client/${options.frameworkConfig.entry}"></script>\`, then retry.`);
    }
    if (!referencesFrameworkSourceEntry(options.indexHtml, options.frameworkConfig.entry)) {
        throw clientToolchainError(`${frameworkLabel}/Vite could not find the client source entry in index.html.`, `Add \`<script type="module" src="/client/${options.frameworkConfig.entry}"></script>\` to the author-owned HTML shell.`);
    }
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
            plugins: [sporadesEsbuildClientPlugin(options.devRefresh === true)],
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
async function buildVite(options) {
    const { build } = await import("vite");
    const frameworkPlugins = [];
    let projectRoot = path.resolve(options.projectDir);
    try {
        projectRoot = await realpath(options.projectDir);
        if (options.frameworkConfig.framework === "vue") {
            const { plugin, compiler } = await loadProjectVueToolchain(projectRoot);
            frameworkPlugins.push(plugin({ compiler }));
        }
        else if (options.frameworkConfig.framework === "svelte") {
            const { plugin } = await loadProjectSvelteToolchain(projectRoot);
            frameworkPlugins.push(plugin());
        }
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
            esbuild: { jsx: "automatic", jsxImportSource: options.frameworkConfig.jsxImportSource ?? undefined },
            css: { postcss: { plugins: [] } },
            plugins: [...frameworkPlugins, sporadesViteClientPlugin(options.devRefresh === true)],
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
            diagnostics: { framework: options.frameworkConfig.framework, toolchain: "vite", refresh: "full-page" },
        };
    }
    catch (error) {
        if (hasHint(error))
            throw error;
        throw viteBuildError(error, [options.projectDir, projectRoot], options.frameworkConfig.framework);
    }
}
async function loadProjectVueToolchain(projectRoot) {
    const loaded = await loadProjectCompilerToolchain(projectRoot, {
        framework: "Vue",
        requiredPackages: [
            { declaration: "@vitejs/plugin-vue", resolve: "@vitejs/plugin-vue", major: 5 },
            { declaration: "@vue/compiler-sfc", resolve: "@vue/compiler-sfc", major: 3 },
        ],
        installHint: "Run `npm install` in the Vue Capsule to install its declared @vitejs/plugin-vue and @vue/compiler-sfc versions.",
    });
    const pluginModule = loaded.get("@vitejs/plugin-vue");
    const compilerModule = loaded.get("@vue/compiler-sfc");
    const plugin = pluginModule?.default?.default ?? pluginModule?.default ?? pluginModule;
    const compiler = compilerModule?.default ?? compilerModule;
    if (typeof plugin !== "function" || typeof compiler?.parse !== "function")
        throw projectToolchainError("Vue", "Vue/Vite project compiler packages have incompatible exports.", "Run `npm install` in the Vue Capsule to install its declared @vitejs/plugin-vue and @vue/compiler-sfc versions.");
    return { plugin, compiler };
}
async function loadProjectSvelteToolchain(projectRoot) {
    const hint = "Run `npm install` in the Svelte Capsule to install its declared @sveltejs/vite-plugin-svelte and svelte versions.";
    const loaded = await loadProjectCompilerToolchain(projectRoot, {
        framework: "Svelte",
        requiredPackages: [
            { declaration: "@sveltejs/vite-plugin-svelte", resolve: "@sveltejs/vite-plugin-svelte", major: 5 },
            { declaration: "svelte", resolve: "svelte/compiler", major: 5 },
        ],
        installHint: hint,
    });
    const pluginModule = loaded.get("@sveltejs/vite-plugin-svelte");
    const compilerModule = loaded.get("svelte/compiler");
    const plugin = pluginModule?.svelte ?? pluginModule?.default?.svelte ?? pluginModule?.default ?? pluginModule;
    const compiler = compilerModule?.default ?? compilerModule;
    if (typeof plugin !== "function" || typeof compiler?.compile !== "function")
        throw projectToolchainError("Svelte", "Svelte/Vite project compiler packages have incompatible exports.", hint);
    return { plugin, compiler };
}
async function loadProjectCompilerToolchain(projectRoot, spec) {
    let projectManifest;
    try {
        projectManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    }
    catch {
        throw projectToolchainError(spec.framework, `${spec.framework}/Vite could not read the Capsule package.json.`, spec.installHint);
    }
    const declared = { ...(projectManifest.dependencies ?? {}), ...(projectManifest.devDependencies ?? {}) };
    const nodeModulesDir = path.join(projectRoot, "node_modules");
    let canonicalNodeModules;
    try {
        const nodeModulesMetadata = await lstat(nodeModulesDir);
        if (!nodeModulesMetadata.isDirectory() || nodeModulesMetadata.isSymbolicLink())
            throw new Error("node_modules is not a real directory");
        canonicalNodeModules = await realpath(nodeModulesDir);
        if (!isCanonicalDescendant(projectRoot, canonicalNodeModules))
            throw new Error("node_modules escaped the project root");
    }
    catch {
        throw projectToolchainError(spec.framework, `${spec.framework}/Vite requires node_modules to be a real directory contained by the Capsule project.`, spec.installHint);
    }
    const projectRequire = createRequire(path.join(projectRoot, "package.json"));
    const resolvedPackages = new Map();
    for (const required of spec.requiredPackages) {
        if (typeof declared[required.declaration] !== "string") {
            throw projectToolchainError(spec.framework, `${spec.framework}/Vite requires the Capsule to declare ${required.declaration}.`, spec.installHint);
        }
        const packageDir = path.join(projectRoot, "node_modules", ...required.declaration.split("/"));
        let installedManifest;
        let resolved;
        try {
            installedManifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
            try {
                resolved = projectRequire.resolve(required.resolve);
            }
            catch {
                const subpath = required.resolve === required.declaration ? "." : `.${required.resolve.slice(required.declaration.length)}`;
                const exported = installedManifest.exports?.[subpath];
                const importTarget = typeof exported === "string" ? exported : typeof exported?.import === "string" ? exported.import : exported?.import?.default;
                if (typeof importTarget !== "string")
                    throw new Error("package has no import export");
                resolved = path.resolve(packageDir, importTarget);
            }
            const canonicalPackageDir = await realpath(packageDir);
            if (!isCanonicalDescendant(canonicalNodeModules, canonicalPackageDir))
                throw new Error("package directory escaped project node_modules");
            const canonicalResolved = await realpath(resolved);
            if (!isCanonicalDescendant(canonicalPackageDir, canonicalResolved))
                throw new Error("package entry escaped its project-owned package root");
            resolved = canonicalResolved;
        }
        catch {
            throw projectToolchainError(spec.framework, `${spec.framework}/Vite could not resolve project-owned ${required.declaration}.`, spec.installHint);
        }
        const installedMajor = Number.parseInt(String(installedManifest.version).split(".")[0] ?? "", 10);
        if (installedMajor !== required.major) {
            throw projectToolchainError(spec.framework, `${spec.framework}/Vite does not support the installed ${required.declaration} version.`, spec.installHint, { package: required.declaration, installedVersion: String(installedManifest.version).slice(0, 40), supportedMajor: required.major });
        }
        resolvedPackages.set(required.resolve, resolved);
    }
    const loaded = new Map();
    for (const [packageName, resolved] of resolvedPackages) {
        try {
            loaded.set(packageName, await import(pathToFileURL(resolved).href));
        }
        catch (error) {
            throw projectToolchainError(spec.framework, `${spec.framework}/Vite could not load project-owned ${packageName}: ${boundedBuildMessage(error, [projectRoot])}`, spec.installHint, { package: packageName });
        }
    }
    return loaded;
}
function isCanonicalDescendant(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function projectToolchainError(_framework, message, hint, diagnostics) {
    return clientToolchainError(message, hint, diagnostics);
}
function sporadesEsbuildClientPlugin(devRefresh = false) {
    return {
        name: "sporades-client",
        setup(build) {
            build.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: "sporades/client", namespace: "sporades-runtime" }));
            build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({ loader: "js", contents: createClientRuntimeSource({ devRefresh }) }));
        },
    };
}
function sporadesViteClientPlugin(devRefresh = false) {
    const runtimeId = "\0sporades:client-runtime";
    return {
        name: "sporades-client-runtime",
        enforce: "pre",
        resolveId(id) { return id === "sporades/client" ? runtimeId : null; },
        load(id) { return id === runtimeId ? createClientRuntimeSource({ devRefresh }) : null; },
    };
}
function referencesLegacyClientShell(html) {
    return /<script\b[^>]*\bsrc\s*=\s*["']\/?client\.js(?:\?[^"']*)?["'][^>]*>/i.test(html);
}
function referencesFrameworkSourceEntry(html, entry) {
    const escapedEntry = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']\\/?client/${escapedEntry}(?:\\?[^"']*)?["'][^>]*>`, "i").test(html);
}
function normalizeOutputPath(fileName) {
    const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes(".."))
        throw new Error("Vite emitted an unsafe public path.");
    return normalized;
}
function viteBuildError(error, projectRoots, framework) {
    const details = errorDetails(error);
    const message = boundedBuildMessage(error, projectRoots);
    const loc = errorDetails(details.loc);
    const rawFile = typeof loc.file === "string" ? loc.file : typeof details.id === "string" ? details.id : null;
    const relativeFile = rawFile ? safeRelativeDiagnosticPath(projectRoots, rawFile) : null;
    return clientToolchainError(`Client bundle failed: ${message}`, `Fix the ${framework === "preact" ? "Preact" : framework === "vue" ? "Vue" : framework === "svelte" ? "Svelte" : "React"}/Vite client source and save again.`, {
        ...(typeof details.code === "string" ? { code: details.code.slice(0, 80) } : {}),
        ...(relativeFile ? { file: relativeFile } : {}),
        ...(Number.isInteger(loc.line) ? { line: loc.line } : {}),
        ...(Number.isInteger(loc.column) ? { column: loc.column } : {}),
    });
}
function safeRelativeDiagnosticPath(projectRoots, fileName) {
    for (const projectRoot of canonicalDiagnosticRoots(projectRoots)) {
        const relative = path.relative(projectRoot, fileName).split(path.sep).join("/");
        if (relative && !relative.startsWith("../") && relative !== "..")
            return relative.slice(0, 240);
    }
    return path.basename(fileName).slice(0, 120);
}
function boundedBuildMessage(error, projectRoots = []) {
    const details = errorDetails(error);
    const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
    let message = typeof errorDetails(firstError).text === "string"
        ? String(errorDetails(firstError).text)
        : typeof details.message === "string" ? details.message : "unknown error";
    for (const projectRoot of canonicalDiagnosticRoots(projectRoots)) {
        message = message.split(projectRoot).join("<project>");
    }
    return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}
function canonicalDiagnosticRoots(projectRoots) {
    return [...new Set(projectRoots.flatMap((projectRoot) => {
            const resolved = path.resolve(projectRoot);
            return [projectRoot, resolved];
        }).filter(Boolean))].sort((left, right) => right.length - left.length);
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