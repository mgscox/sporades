import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import { parse as parseHtml } from "parse5";
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
    return fragments;
}
export async function renderClientPrerenderFragment(projectRoot, fragment, projectRoots = [projectRoot], onDependency) {
    const modulePath = path.resolve(projectRoot, ...fragment.module.split("/"));
    onDependency?.(modulePath);
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
    let bundleFormat = "cjs";
    const rendererDependencyRoots = new Set();
    const rendererDependencyAliases = new Map();
    try {
        const { build } = await import("esbuild");
        let result;
        try {
            result = await buildRendererBundle(build, projectRoot, canonicalModulePath, bundleFormat, rendererDependencyRoots, rendererDependencyAliases, onDependency);
        }
        catch (error) {
            if (!isCommonJsTopLevelAwaitBuildFailure(error))
                throw error;
            bundleFormat = "esm";
            result = await buildRendererBundle(build, projectRoot, canonicalModulePath, bundleFormat, rendererDependencyRoots, rendererDependencyAliases, onDependency);
        }
        const outputs = result.outputFiles ?? [];
        const javascript = outputs.filter((output) => output.path.endsWith(".js"));
        if (outputs.length !== 1 || javascript.length !== 1 || !javascript[0]?.text) {
            throw new Error("the renderer produced an unsupported secondary output");
        }
        bundledSource = javascript[0].text;
    }
    catch (error) {
        throw prerenderError(`Could not build client prerender module for ${fragment.name}: ${boundedMessage(error, [...projectRoots, ...rendererDependencyRoots], [...rendererDependencyAliases])}`, `Fix ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    const boundedRendererRoots = [...projectRoots, ...rendererDependencyRoots];
    {
        const outcome = await executeBundledRenderer(bundledSource, bundleFormat, canonicalModulePath, fragment.module, boundedRendererRoots);
        for (const dependency of outcome.dependencies ?? []) {
            if (typeof dependency === "string" && path.isAbsolute(dependency))
                onDependency?.(dependency);
        }
        if (outcome.kind === "not-function") {
            throw prerenderError(`Client prerender module for ${fragment.name} must default-export a zero-argument renderer.`, `Default-export a function from ${fragment.module} that returns an HTML string or Promise<string>.`);
        }
        if (outcome.kind === "non-string") {
            throw prerenderError(`Client prerender renderer for ${fragment.name} returned a non-string result.`, `Return an HTML string or Promise<string> from ${fragment.module}.`, { fragment: fragment.name, resultType: outcome.resultType });
        }
        if (outcome.kind === "failure") {
            throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${outcome.message}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
        }
        return outcome.rendered;
    }
}
async function buildRendererBundle(build, projectRoot, canonicalModulePath, format, rendererDependencyRoots, rendererDependencyAliases, onDependency) {
    return build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryNames: "renderer",
        entryPoints: { renderer: canonicalModulePath },
        format,
        logLevel: "silent",
        outdir: path.join(projectRoot, ".sporades-prerender-output"),
        platform: "node",
        plugins: [preserveRendererImportMetaUrl(build, projectRoot, rendererDependencyRoots, rendererDependencyAliases, onDependency)],
        sourcemap: false,
        target: "node22",
        write: false,
    });
}
function isCommonJsTopLevelAwaitBuildFailure(error) {
    if (!error || typeof error !== "object" || !("errors" in error) || !Array.isArray(error.errors))
        return false;
    return error.errors.some((diagnostic) => (diagnostic
        && typeof diagnostic === "object"
        && "text" in diagnostic
        && typeof diagnostic.text === "string"
        && diagnostic.text.includes("Top-level await")
        && diagnostic.text.includes('"cjs" output format')));
}
function preserveRendererImportMetaUrl(esbuildBuild, projectRoot, rendererDependencyRoots, rendererDependencyAliases, onDependency) {
    const packageModeCache = new Map();
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
        setup(pluginBuild) {
            const commonJsNamespace = "sporades-renderer-commonjs";
            const resolutionBypass = "sporadesRendererResolutionBypass";
            pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData?.[resolutionBypass])
                    return undefined;
                const resolved = await pluginBuild.resolve(args.path, {
                    importer: args.importer,
                    kind: args.kind,
                    namespace: args.namespace === commonJsNamespace ? "file" : args.namespace,
                    pluginData: { [resolutionBypass]: true },
                    resolveDir: args.resolveDir,
                    with: args.with,
                });
                if (resolved.errors.length > 0) {
                    const failedPath = rendererLocalFilePath(args.path);
                    if (args.path.startsWith(".") || failedPath) {
                        const candidate = failedPath ?? path.resolve(args.resolveDir, args.path);
                        // Retain missing code edges so creating a previously absent import can
                        // recover a failed Dev rebuild without editing the renderer again.
                        for (const suffix of ["", ".tsx", ".ts", ".jsx", ".js", ".json", "/index.ts", "/index.js"])
                            onDependency?.(`${candidate}${suffix}`);
                    }
                    else if (!path.isAbsolute(args.path) && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|#)/.test(args.path)) {
                        const packageName = args.path.split("/").slice(0, args.path.startsWith("@") ? 2 : 1).join("/");
                        const localRequire = createRequire(path.join(args.resolveDir || projectRoot, "__sporades_prerender__.cjs"));
                        // Watch only the unresolved package roots, not every node_modules
                        // tree. Installation (including package subpaths) can then recover.
                        for (const directory of localRequire.resolve.paths(args.path) ?? [])
                            onDependency?.(path.join(directory, packageName));
                    }
                    const failedDirectory = failedPath ? rendererDependencyDirectory(failedPath) : undefined;
                    if (failedPath) {
                        const projectRootEqual = path.resolve(failedPath) === path.resolve(projectRoot);
                        const external = !projectRootEqual
                            && !isCanonicalDescendant(projectRoot, failedPath);
                        if (/^file:/i.test(args.path)) {
                            if (projectRootEqual) {
                                mergeRendererDiagnosticAlias(rendererDependencyAliases, rendererRawLocalFileUrlPath(args.path), {
                                    replacement: "<project>",
                                    boundary: "path",
                                });
                            }
                            else if (failedDirectory) {
                                const rawParent = rendererRawLocalFileUrlParent(args.path);
                                if (rawParent) {
                                    const replacement = external
                                        ? "<project>"
                                        : rendererProjectDiagnosticPrefix(projectRoot, failedDirectory);
                                    mergeRendererDiagnosticAlias(rendererDependencyAliases, rawParent, { replacement, boundary: "parent" });
                                }
                            }
                        }
                        if (external && failedDirectory)
                            rendererDependencyRoots.add(failedDirectory);
                    }
                    return args.namespace === commonJsNamespace ? { errors: resolved.errors, warnings: resolved.warnings } : undefined;
                }
                if (!resolved.external && resolved.namespace === "file")
                    onDependency?.(resolved.path);
                if (!resolved.external
                    && resolved.namespace === "file"
                    && !isCanonicalDescendant(projectRoot, resolved.path)) {
                    addRendererDependencyRoot(rendererDependencyRoots, resolved.path);
                }
                let namespace = resolved.namespace;
                if (!resolved.external && namespace === "file" && [".js", ".jsx", ".ts", ".tsx"].includes(path.extname(resolved.path))) {
                    const contents = await readFile(resolved.path, "utf8");
                    if (await rendererModuleUsesCommonJs(resolved.path, contents, projectRoot, packageModeCache)
                        && ([".ts", ".tsx"].includes(path.extname(resolved.path)) || await rendererNeedsCommonJsBoundaryNamespace(resolved.path))) {
                        namespace = commonJsNamespace;
                    }
                }
                if (namespace !== commonJsNamespace && args.namespace !== commonJsNamespace)
                    return undefined;
                return {
                    external: resolved.external,
                    namespace,
                    path: resolved.path,
                    pluginData: resolved.pluginData,
                    sideEffects: resolved.sideEffects,
                    suffix: resolved.suffix,
                    warnings: resolved.warnings,
                };
            });
            const loadRendererModule = async (args) => {
                const contents = await readFile(args.path, "utf8");
                const commonJsModule = await rendererModuleUsesCommonJs(args.path, contents, projectRoot, packageModeCache);
                const preservesImportMetaUrl = contents.includes("import.meta.url");
                const loader = loaders.get(path.extname(args.path));
                if (!loader)
                    return undefined;
                const checksImports = contents.includes("import");
                const requiresTransform = checksImports || preservesImportMetaUrl || (commonJsModule && /\b(?:require|module|__dirname|__filename)\b/.test(contents));
                if (!requiresTransform) {
                    if (args.namespace !== commonJsNamespace)
                        return undefined;
                    return {
                        contents,
                        loader,
                        resolveDir: path.dirname(args.path),
                        watchFiles: [args.path],
                    };
                }
                const moduleUrl = pathToFileURL(args.path).href;
                const define = { "import.meta.url": JSON.stringify(moduleUrl) };
                const result = await esbuildBuild({
                    absWorkingDir: projectRoot,
                    bundle: false,
                    define,
                    entryPoints: [args.path],
                    format: commonJsModule ? undefined : "esm",
                    jsx: "preserve",
                    logLevel: "silent",
                    outdir: path.join(projectRoot, ".sporades-prerender-transform"),
                    platform: "node",
                    target: "esnext",
                    write: false,
                });
                const outputs = result.outputFiles ?? [];
                const javascript = outputs.filter((output) => output.path.endsWith(".js"));
                if (outputs.length !== 1 || javascript.length !== 1 || !javascript[0]?.text) {
                    throw new Error("the import.meta.url transform produced unsupported output");
                }
                if (checksImports) {
                    const syntax = parseRendererSyntax(javascript[0].text, commonJsModule);
                    visitRendererSyntax(syntax, (node) => {
                        if (node.type === "ImportExpression" && isRendererSyntaxNode(node.source) && !isStaticRendererRequireSpecifier(node.source)) {
                            throw new Error("Prerender dynamic import specifiers must be string literals; use explicit imports so dependencies resolve from their owning module.");
                        }
                    });
                }
                const specialized = commonJsModule
                    ? specializeCommonJsRendererModule(javascript[0].text, args.path, moduleUrl)
                    : { contents: javascript[0].text, changed: false };
                if (commonJsModule && !preservesImportMetaUrl && !specialized.changed && args.namespace !== commonJsNamespace)
                    return undefined;
                return {
                    contents: specialized.contents,
                    loader: rendererTransformOutputLoader(loader),
                    resolveDir: path.dirname(args.path),
                    watchFiles: [args.path],
                };
            };
            pluginBuild.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, loadRendererModule);
            pluginBuild.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: commonJsNamespace }, loadRendererModule);
        },
    };
}
function rendererLocalFilePath(specifier) {
    if (path.isAbsolute(specifier))
        return specifier;
    if (!/^file:/i.test(specifier))
        return undefined;
    try {
        return fileURLToPath(specifier);
    }
    catch {
        return undefined;
    }
}
function addRendererDependencyRoot(roots, filePath) {
    const directory = rendererDependencyDirectory(filePath);
    if (!directory)
        return false;
    roots.add(directory);
    return true;
}
function rendererDependencyDirectory(filePath) {
    const directory = path.dirname(filePath);
    return directory === path.parse(directory).root ? undefined : directory;
}
function rendererProjectDiagnosticPrefix(projectRoot, directory) {
    const relative = path.relative(projectRoot, directory).split(path.sep).join("/");
    return relative ? `<project>/${relative}` : "<project>";
}
function rendererRawLocalFileUrlParent(specifier) {
    const rawPath = rendererRawLocalFileUrlPath(specifier);
    const finalSlash = rawPath.lastIndexOf("/");
    if (finalSlash === -1)
        return undefined;
    const parent = rawPath.slice(0, finalSlash);
    const lowerParent = parent.toLowerCase();
    return lowerParent === "file:" || lowerParent === "file:/" || lowerParent === "file://" ? undefined : parent;
}
function rendererRawLocalFileUrlPath(specifier) {
    const suffixStart = specifier.search(/[?#]/);
    return suffixStart === -1 ? specifier : specifier.slice(0, suffixStart);
}
async function rendererModuleUsesCommonJs(modulePath, contents, projectRoot, packageModeCache) {
    const extension = path.extname(modulePath);
    if (extension === ".cjs" || extension === ".cts")
        return true;
    if (extension === ".ts" || extension === ".tsx") {
        const { transform } = await import("esbuild");
        const javascript = await transform(contents, { loader: extension === ".tsx" ? "tsx" : "ts", jsx: "preserve", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
        return defaultRendererJavaScriptUsesCommonJs(javascript.code);
    }
    if (extension !== ".js" && extension !== ".jsx")
        return false;
    const mode = await nearestRendererPackageMode(path.dirname(modulePath), projectRoot, packageModeCache);
    if (mode === "module")
        return false;
    if (mode === "commonjs")
        return true;
    return defaultRendererJavaScriptUsesCommonJs(contents);
}
function defaultRendererJavaScriptUsesCommonJs(contents) {
    try {
        RendererSyntaxParser.parse(contents, {
            allowHashBang: true,
            allowReturnOutsideFunction: true,
            ecmaVersion: "latest",
            sourceType: "script",
        });
        return true;
    }
    catch {
        try {
            RendererSyntaxParser.parse(contents, {
                allowHashBang: true,
                ecmaVersion: "latest",
                sourceType: "module",
            });
            return false;
        }
        catch {
            return true;
        }
    }
}
async function rendererNeedsCommonJsBoundaryNamespace(modulePath) {
    let directory = path.dirname(modulePath);
    while (true) {
        if (path.basename(directory) === "node_modules")
            return true;
        try {
            await readFile(path.join(directory, "package.json"), "utf8");
            return false;
        }
        catch (error) {
            if (!isMissingRendererPackageJson(error))
                throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            return false;
        directory = parent;
    }
}
function nearestRendererPackageMode(directory, projectRoot, cache) {
    const cached = cache.get(directory);
    if (cached)
        return cached;
    const pending = (async () => {
        if (path.basename(directory) === "node_modules")
            return "default";
        const packagePath = path.join(directory, "package.json");
        try {
            const source = await readFile(packagePath, "utf8");
            let parsed;
            try {
                parsed = JSON.parse(source);
            }
            catch {
                throw new Error(`Invalid renderer package metadata at ${packagePath}.`);
            }
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const type = parsed.type;
                if (type === "module" || type === "commonjs")
                    return type;
            }
            return "default";
        }
        catch (error) {
            if (!isMissingRendererPackageJson(error))
                throw error;
        }
        if (path.resolve(directory) === path.resolve(projectRoot))
            return "default";
        const parent = path.dirname(directory);
        if (parent === directory)
            return "default";
        return nearestRendererPackageMode(parent, projectRoot, cache);
    })();
    cache.set(directory, pending);
    return pending;
}
function isMissingRendererPackageJson(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
export function rendererTransformOutputLoader(loader) {
    return loader === "jsx" || loader === "tsx" ? "jsx" : "js";
}
const RendererSyntaxParser = Parser.extend(jsx());
function parseRendererSyntax(contents, commonJs) {
    if (commonJs) {
        try {
            return RendererSyntaxParser.parse(contents, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
        }
        catch { /* TypeScript CommonJS modules can retain ESM declarations until bundling. */ }
    }
    return RendererSyntaxParser.parse(contents, { ecmaVersion: "latest", sourceType: "module" });
}
function specializeCommonJsRendererModule(contents, modulePath, moduleUrl) {
    const syntax = parseRendererSyntax(contents, true);
    const rootScope = { functionScope: true, bindings: new Set() };
    const scopes = new WeakMap();
    collectRendererScopes(syntax, rootScope, scopes);
    const assignmentTargets = new WeakSet();
    collectRendererAssignmentTargets(syntax, assignmentTargets);
    const deleteOperands = new WeakSet();
    collectRendererDeleteOperands(syntax, deleteOperands);
    const writtenWrapperNames = new Set();
    const wrapperDeclarations = new WeakSet();
    visitRendererSyntax(syntax, (node) => {
        if (node.type === "VariableDeclaration" && node.kind === "var" && nearestRendererFunctionScope(scopes.get(node) ?? rootScope) === rootScope) {
            for (const declaration of node.declarations) {
                const declared = { functionScope: true, bindings: new Set() };
                addRendererBinding(declared, declaration.id);
                for (const name of declared.bindings) {
                    if (["require", "__dirname", "__filename"].includes(name) && !rootScope.bindings.has(name))
                        writtenWrapperNames.add(name);
                }
                markRendererAssignmentTarget(declaration.id, wrapperDeclarations);
            }
        }
        if (node.type === "Identifier"
            && assignmentTargets.has(node)
            && (node.name === "require" || node.name === "__dirname" || node.name === "__filename")
            && !rendererScopeBinds(scopes.get(node) ?? rootScope, node.name)) {
            writtenWrapperNames.add(node.name);
        }
    });
    const replacements = [];
    let helperName = "__sporadesModuleRequire";
    while (contents.includes(helperName))
        helperName += "_";
    let writableRequireName = `${helperName}Writable`;
    while (contents.includes(writableRequireName))
        writableRequireName += "_";
    const writableRequire = writtenWrapperNames.has("require");
    const handledRequireCalls = new WeakSet();
    const handledModuleRequireCalls = new WeakSet();
    const emptyTargets = new WeakSet();
    let needsModuleRequireMethod = false;
    visitRendererSyntax(syntax, (node, parent, key) => {
        const scope = scopes.get(node) ?? rootScope;
        if (node.type === "Identifier" && node.name === "module" && !rendererScopeBinds(scope, "module")
            && isRendererIdentifierReference(node, parent, key, emptyTargets, emptyTargets))
            needsModuleRequireMethod = true;
        if (node.type === "MemberExpression" && !handledModuleRequireCalls.has(node) && isRendererSyntaxNode(node.object) && node.object.type === "Identifier" && node.object.name === "module"
            && !rendererScopeBinds(scope, "module") && isRendererSyntaxNode(node.property)
            && ((!node.computed && node.property.name === "require") || (node.computed && node.property.value === "require"))) {
            // Hide only this special access from esbuild's module.require -> require
            // lowering, which otherwise loses module locality and later reassignment.
            replacements.push({ start: node.object.start, end: node.object.end, value: `${helperName}Module()` });
        }
        if (node.type === "CallExpression") {
            const callee = node.callee;
            const args = node.arguments;
            const first = args?.[0];
            if (!node.optional && callee?.type === "MemberExpression" && isRendererSyntaxNode(callee.object) && callee.object.type === "Identifier" && callee.object.name === "module"
                && !rendererScopeBinds(scope, "module") && isRendererSyntaxNode(callee.property)
                && ((!callee.computed && callee.property.name === "require") || (callee.computed && callee.property.value === "require")) && first && isStaticRendererRequireSpecifier(first)) {
                handledModuleRequireCalls.add(callee);
                const literal = contents.slice(first.start, first.end);
                replacements.push({ start: callee.start, end: callee.end, value: `((...args) => ${helperName}Module().require === ${helperName} ? require(${literal}) : ${helperName}Module().require(...args))` });
            }
            if (callee?.type === "Identifier"
                && callee.name === "require"
                && !rendererScopeBinds(scope, "require")
                && first) {
                handledRequireCalls.add(callee);
                if (isStaticRendererRequireSpecifier(first)) {
                    if (writableRequire) {
                        // Keep a literal require in the esbuild graph (including TS imports),
                        // while honoring a reassigned wrapper at execution time.
                        const literal = contents.slice(first.start, first.end);
                        replacements.push({ start: callee.start, end: callee.end, value: `((...args) => ${writableRequireName} === ${helperName} ? require(${literal}) : ${writableRequireName}(...args))` });
                    }
                }
                else
                    replacements.push({ start: callee.start, end: callee.end, value: writableRequire ? writableRequireName : helperName });
            }
            return;
        }
        if (node.type === "Identifier" && node.name === "require" && !handledRequireCalls.has(node)
            && !rendererScopeBinds(scope, "require") && (wrapperDeclarations.has(node) || isRendererIdentifierReference(node, parent, key, emptyTargets, emptyTargets))) {
            const value = writableRequire ? writableRequireName : helperName;
            const shorthand = parent?.type === "Property" && parent.shorthand === true && parent.value === node;
            replacements.push({ start: node.start, end: node.end, value: shorthand ? `require: ${value}` : value });
        }
        if (node.type === "Identifier"
            && (node.name === "__dirname" || node.name === "__filename")
            && isRendererIdentifierReference(node, parent, key, assignmentTargets, deleteOperands)
            && !rendererScopeBinds(scope, node.name)
            && !writtenWrapperNames.has(node.name)) {
            const value = JSON.stringify(node.name === "__dirname" ? path.dirname(modulePath) : modulePath);
            const shorthand = parent?.type === "Property" && parent.shorthand === true && parent.value === node;
            replacements.push({ start: node.start, end: node.end, value: shorthand ? `${String(node.name)}: ${value}` : value });
        }
    });
    const writableLocations = ["__dirname", "__filename"].filter((name) => writtenWrapperNames.has(name));
    if (replacements.length === 0 && writableLocations.length === 0 && !needsModuleRequireMethod)
        return { contents, changed: false };
    const needsModuleRequire = needsModuleRequireMethod || replacements.some((replacement) => replacement.value.includes(helperName));
    if (needsModuleRequire || writableLocations.length > 0) {
        const insertionOffset = rendererHelperInsertionOffset(syntax, contents);
        replacements.push({
            start: insertionOffset,
            end: insertionOffset,
            value: (needsModuleRequire ? `const ${helperName} = require("node:module").createRequire(${JSON.stringify(moduleUrl)});\n` : "")
                + (needsModuleRequireMethod ? `const ${helperName}Module = () => module;\n${helperName}Module().require = ${helperName};\n` : "")
                + (writableRequire && needsModuleRequire ? `var ${writableRequireName} = ${helperName};\n` : "")
                + writableLocations.map((name) => `var ${name} = ${JSON.stringify(name === "__dirname" ? path.dirname(modulePath) : modulePath)};\n`).join(""),
        });
    }
    let rewritten = contents;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
    }
    return { contents: rewritten, changed: true };
}
function rendererHelperInsertionOffset(syntax, contents) {
    const body = syntax.body ?? [];
    let directiveCount = 0;
    while (body[directiveCount]?.type === "ExpressionStatement" && typeof body[directiveCount]?.directive === "string") {
        directiveCount += 1;
    }
    if (directiveCount > 0)
        return body[directiveCount]?.start ?? contents.length;
    if (contents.startsWith("#!")) {
        const lineEnd = contents.indexOf("\n");
        return lineEnd === -1 ? contents.length : lineEnd + 1;
    }
    return 0;
}
function collectRendererScopes(node, scope, scopes) {
    if (node.type === "SwitchStatement") {
        const switchScope = { parent: scope, functionScope: false, bindings: new Set() };
        scopes.set(node, scope);
        const discriminant = node.discriminant;
        if (isRendererSyntaxNode(discriminant))
            collectRendererScopes(discriminant, scope, scopes);
        for (const switchCase of node.cases ?? []) {
            collectRendererScopes(switchCase, switchScope, scopes);
        }
        return;
    }
    let activeScope = scope;
    if (node.type === "FunctionDeclaration") {
        addRendererBinding(scope, node.id);
        activeScope = { parent: scope, functionScope: true, bindings: new Set() };
        addRendererBinding(activeScope, node.id);
        for (const parameter of node.params ?? [])
            addRendererBinding(activeScope, parameter);
    }
    else if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        activeScope = { parent: scope, functionScope: true, bindings: new Set() };
        addRendererBinding(activeScope, node.id);
        for (const parameter of node.params ?? [])
            addRendererBinding(activeScope, parameter);
    }
    else if (node.type === "ClassDeclaration") {
        addRendererBinding(scope, node.id);
        activeScope = { parent: scope, functionScope: false, bindings: new Set() };
        addRendererBinding(activeScope, node.id);
    }
    else if (node.type === "ClassExpression") {
        activeScope = { parent: scope, functionScope: false, bindings: new Set() };
        addRendererBinding(activeScope, node.id);
    }
    else if (node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
        activeScope = { parent: scope, functionScope: false, bindings: new Set() };
    }
    else if (node.type === "StaticBlock") {
        activeScope = { parent: scope, functionScope: true, bindings: new Set() };
    }
    else if (node.type === "BlockStatement" || node.type === "CatchClause") {
        activeScope = { parent: scope, functionScope: false, bindings: new Set() };
        if (node.type === "CatchClause")
            addRendererBinding(activeScope, node.param);
    }
    scopes.set(node, activeScope);
    if (node.type === "VariableDeclaration") {
        const declarationScope = node.kind === "var" ? nearestRendererFunctionScope(activeScope) : activeScope;
        for (const declaration of node.declarations ?? []) {
            if (node.kind === "var" && !declarationScope.parent) {
                const declared = { functionScope: true, bindings: new Set() };
                addRendererBinding(declared, declaration.id);
                for (const name of declared.bindings)
                    if (!["require", "__dirname", "__filename"].includes(name))
                        declarationScope.bindings.add(name);
            }
            else
                addRendererBinding(declarationScope, declaration.id);
        }
    }
    else if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers ?? [])
            addRendererBinding(activeScope, specifier.local);
    }
    forEachRendererChild(node, (child) => collectRendererScopes(child, activeScope, scopes));
}
function addRendererBinding(scope, pattern) {
    if (!pattern || typeof pattern !== "object")
        return;
    const node = pattern;
    if (node.type === "Identifier" && typeof node.name === "string") {
        scope.bindings.add(node.name);
        return;
    }
    if (node.type === "RestElement")
        return addRendererBinding(scope, node.argument);
    if (node.type === "AssignmentPattern")
        return addRendererBinding(scope, node.left);
    if (node.type === "ArrayPattern") {
        for (const element of node.elements ?? [])
            addRendererBinding(scope, element);
    }
    if (node.type === "ObjectPattern") {
        for (const property of node.properties ?? []) {
            addRendererBinding(scope, property.type === "RestElement" ? property.argument : property.value);
        }
    }
}
function nearestRendererFunctionScope(scope) {
    let candidate = scope;
    while (!candidate.functionScope && candidate.parent)
        candidate = candidate.parent;
    return candidate;
}
function rendererScopeBinds(scope, name) {
    for (let candidate = scope; candidate; candidate = candidate.parent) {
        if (candidate.bindings.has(name))
            return true;
    }
    return false;
}
function isStaticRendererRequireSpecifier(node) {
    if (node.type === "Literal")
        return typeof node.value === "string";
    return node.type === "TemplateLiteral" && (node.expressions?.length ?? 0) === 0;
}
function collectRendererAssignmentTargets(syntax, targets) {
    visitRendererSyntax(syntax, (node) => {
        if (node.type === "AssignmentExpression")
            markRendererAssignmentTarget(node.left, targets);
        else if (node.type === "UpdateExpression")
            markRendererAssignmentTarget(node.argument, targets);
        else if ((node.type === "ForInStatement" || node.type === "ForOfStatement")
            && isRendererSyntaxNode(node.left)
            && node.left.type !== "VariableDeclaration") {
            markRendererAssignmentTarget(node.left, targets);
        }
    });
}
function collectRendererDeleteOperands(syntax, operands) {
    visitRendererSyntax(syntax, (node) => {
        if (node.type === "UnaryExpression" && node.operator === "delete" && isRendererSyntaxNode(node.argument)) {
            operands.add(node.argument);
        }
    });
}
function markRendererAssignmentTarget(value, targets) {
    if (!isRendererSyntaxNode(value))
        return;
    if (value.type === "Identifier") {
        targets.add(value);
    }
    else if (value.type === "ArrayPattern") {
        for (const element of value.elements ?? [])
            markRendererAssignmentTarget(element, targets);
    }
    else if (value.type === "ObjectPattern") {
        for (const property of value.properties ?? []) {
            markRendererAssignmentTarget(property.type === "RestElement" ? property.argument : property.value, targets);
        }
    }
    else if (value.type === "AssignmentPattern") {
        markRendererAssignmentTarget(value.left, targets);
    }
    else if (value.type === "RestElement" || value.type === "ParenthesizedExpression") {
        markRendererAssignmentTarget(value.argument ?? value.expression, targets);
    }
}
function isRendererIdentifierReference(node, parent, key, assignmentTargets, deleteOperands) {
    if (assignmentTargets.has(node) || deleteOperands.has(node))
        return false;
    if (!parent)
        return true;
    if ((parent.type === "VariableDeclarator" && key === "id") || key === "params" || key === "id")
        return false;
    if ((parent.type === "MemberExpression" || parent.type === "Property") && key === "property" && parent.computed !== true)
        return false;
    if (parent.type === "Property" && key === "key" && parent.computed !== true)
        return false;
    if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && parent.computed !== true)
        return false;
    if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
        return false;
    if (parent.type === "MetaProperty")
        return false;
    if (parent.type.startsWith("Import") || parent.type.startsWith("Export"))
        return false;
    return node.type === "Identifier";
}
function visitRendererSyntax(node, visit, parent, key, seen = new WeakSet()) {
    if (seen.has(node))
        return;
    seen.add(node);
    visit(node, parent, key);
    forEachRendererChild(node, (child, childKey) => visitRendererSyntax(child, visit, node, childKey, seen));
}
function forEachRendererChild(node, visit) {
    for (const [key, value] of Object.entries(node)) {
        if (key === "start" || key === "end" || key === "loc" || key === "range")
            continue;
        if (node.type === "Property" && node.shorthand === true && key === "key")
            continue;
        if (Array.isArray(value)) {
            for (const child of value)
                if (isRendererSyntaxNode(child))
                    visit(child, key);
        }
        else if (isRendererSyntaxNode(value)) {
            visit(value, key);
        }
    }
}
function isRendererSyntaxNode(value) {
    return Boolean(value && typeof value === "object" && typeof value.type === "string");
}
export function placeClientPrerenderFragment(html, fragment, rendered) {
    return placeClientPrerenderFragments(html, [{ name: fragment.name, html: rendered }]).html;
}
export function validateClientPrerenderSourceHtml(html) {
    if (scanClientPrerenderHtml(html).reservedBoundary) {
        throw prerenderError("Client index.html contains a reserved prerender boundary comment.", "Remove Sporades private boundary comments from index.html and HTML plugins; the Bundle pipeline supplies them.");
    }
}
export function placeClientPrerenderFragments(html, fragments) {
    const warnings = [];
    validateClientPrerenderSourceHtml(html);
    for (const fragment of fragments) {
        if (scanClientPrerenderHtml(fragment.html).reservedBoundary) {
            throw prerenderError(`Prerender fragment "${fragment.name}" contains a reserved prerender boundary comment.`, "Remove Sporades private boundary comments from renderer output; the Bundle pipeline supplies them.");
        }
    }
    const byName = new Map(fragments.map((fragment) => [fragment.name, fragment]));
    const counts = new Map(fragments.map((fragment) => [fragment.name, 0]));
    const expand = (fragment) => {
        counts.set(fragment.name, counts.get(fragment.name) + 1);
        return `<!-- sporades:prerender-boundary-start ${fragment.name} -->${fragment.html}<!-- sporades:prerender-boundary-end ${fragment.name} -->`;
    };
    const placement = scanClientPrerenderHtml(html);
    if (fragments.length === 0) {
        for (const name of new Set(placement.markers.flatMap((marker) => marker.name ? [marker.name] : []))) {
            warnings.push({ code: "PRERENDER_UNKNOWN_MARKER", fragment: name, message: `Unknown prerender marker "${name}" remains a comment in index.html.` });
        }
        return { html, warnings };
    }
    if (placement.problem) {
        throw prerenderError(`Client prerender placement could not safely scan index.html: ${placement.problem}.`, "Fix the malformed HTML construct in index.html, then retry.");
    }
    let replaced = "";
    if (placement.markers.length > 0) {
        let cursor = 0;
        const unknownNames = new Set();
        for (const marker of placement.markers) {
            replaced += html.slice(cursor, marker.start);
            if (marker.name === undefined)
                replaced += fragments.map(expand).join("");
            else if (byName.has(marker.name))
                replaced += expand(byName.get(marker.name));
            else {
                replaced += html.slice(marker.start, marker.end);
                if (!unknownNames.has(marker.name)) {
                    warnings.push({ code: "PRERENDER_UNKNOWN_MARKER", fragment: marker.name, message: `Unknown prerender marker "${marker.name}" remains a comment in index.html.` });
                    unknownNames.add(marker.name);
                }
            }
            cursor = marker.end;
        }
        replaced += html.slice(cursor);
    }
    else {
        if (placement.bodyEnd === undefined) {
            throw prerenderError("Client prerender fallback placement requires an opening body element.", "Add an opening `<body>` element or a `<!-- sporades:prerender -->` marker to index.html.");
        }
        replaced = `${html.slice(0, placement.bodyEnd)}${fragments.map(expand).join("")}${html.slice(placement.bodyEnd)}`;
    }
    for (const { name } of fragments) {
        const count = counts.get(name);
        if (count === 0)
            warnings.push({ code: "PRERENDER_UNUSED_FRAGMENT", fragment: name, message: `Configured prerender fragment "${name}" has no placement in index.html.` });
        else if (count > 1)
            warnings.push({ code: "PRERENDER_DUPLICATE_PLACEMENT", fragment: name, message: `Prerender fragment "${name}" is placed ${count} times in index.html.` });
    }
    validatePrerenderDomBoundaries(replaced, [...counts.values()].reduce((sum, count) => sum + count, 0));
    return { html: replaced, warnings };
}
function validatePrerenderDomBoundaries(html, expectedPlacements) {
    if (expectedPlacements === 0)
        return;
    const nodes = [];
    const boundaries = [];
    let order = 0;
    const visit = (node) => {
        const location = node.sourceCodeLocation;
        const position = order++;
        let located;
        if (location) {
            // Element ranges include descendants; only the opener identifies where
            // that node came from. Text ranges also reveal merged foster-parented text.
            const token = "startTag" in location && location.startTag ? location.startTag : location;
            located = { start: token.startOffset, end: token.endOffset, order: position, after: order };
            nodes.push(located);
            if (node.nodeName === "#comment" && "data" in node) {
                const marker = /^sporades:prerender-boundary-(start|end) ([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(node.data.trim());
                if (marker)
                    boundaries.push({ ...located, kind: marker[1], name: marker[2] });
            }
        }
        // Like document TreeWalker, do not descend into inert template.content.
        if ("childNodes" in node)
            for (const child of node.childNodes)
                visit(child);
        if (located)
            located.after = order;
    };
    visit(parseHtml(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
    const invalid = () => prerenderError("Client prerender placement is not stable in the parsed HTML document.", "Use context-valid fragment HTML at each marker (for example, rows inside tables), outside inert templates. The browser must keep fragment content between its boundaries.");
    if (boundaries.length !== expectedPlacements * 2)
        throw invalid();
    boundaries.sort((left, right) => left.start - right.start);
    for (let index = 0; index < boundaries.length; index += 2) {
        const start = boundaries[index];
        const end = boundaries[index + 1];
        if (start.kind !== "start" || end.kind !== "end" || start.name !== end.name || start.order >= end.order)
            throw invalid();
        for (const node of nodes) {
            if (node.order === start.order || node.order === end.order)
                continue;
            const fromFragment = node.start < end.start && node.end > start.end;
            const withinBoundary = node.order > start.order && node.order < end.order;
            // A fragment-created ancestor containing the end comment would survive
            // Range.deleteContents() as a partially contained (possibly empty) node.
            if (fromFragment !== withinBoundary || (fromFragment && node.after > end.order))
                throw invalid();
        }
    }
}
function scanClientPrerenderHtml(html) {
    const lowerHtml = foldAsciiCase(html);
    const rawTextElements = new Set(["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"]);
    const markers = [];
    const foreignElements = [];
    let bodyEnd;
    let problem;
    let reservedBoundary = false;
    let cursor = 0;
    while (cursor < html.length) {
        const tagStart = html.indexOf("<", cursor);
        if (tagStart === -1)
            break;
        // In SVG/MathML this is character data, not a bogus HTML declaration.
        // Its payload can contain both > and comment-shaped text.
        if (foreignElements.length > 0 && html.startsWith("<![CDATA[", tagStart)) {
            const cdataEnd = html.indexOf("]]>", tagStart + 9);
            if (cdataEnd === -1) {
                problem = "unterminated foreign-content CDATA section";
                break;
            }
            cursor = cdataEnd + 3;
            continue;
        }
        if (html.startsWith("<!--", tagStart)) {
            const commentEnd = findHtmlCommentEnd(html, tagStart);
            if (!commentEnd) {
                problem = "unterminated HTML comment";
                break;
            }
            const comment = html.slice(tagStart + 4, commentEnd.contentEnd);
            if (/^\s*sporades:prerender-boundary-(?:start|end)\b/.test(comment))
                reservedBoundary = true;
            const marker = /^\s*sporades:prerender(?:\s+([A-Za-z][A-Za-z0-9_-]{0,63}))?\s*$/.exec(comment);
            if (marker)
                markers.push({ start: tagStart, end: commentEnd.end, name: marker[1] });
            cursor = commentEnd.end;
            continue;
        }
        const tagKind = html[tagStart + 1];
        if (tagKind === "!" || tagKind === "?") {
            let declarationEnd = html.indexOf(">", tagStart + 2);
            if (/^<!doctype\s/i.test(html.slice(tagStart, tagStart + 10))) {
                let quote;
                declarationEnd = -1;
                for (let index = tagStart + 9; index < html.length; index += 1) {
                    const character = html[index];
                    if (quote) {
                        if (character === quote)
                            quote = undefined;
                    }
                    else if (character === "\"" || character === "'")
                        quote = character;
                    else if (character === ">") {
                        declarationEnd = index;
                        break;
                    }
                }
            }
            if (declarationEnd === -1) {
                problem = "unterminated HTML declaration";
                break;
            }
            cursor = declarationEnd + 1;
            continue;
        }
        const closing = tagKind === "/";
        let nameStart = tagStart + (closing ? 2 : 1);
        if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
            if (closing) {
                const bogusEnd = html.indexOf(">", nameStart);
                if (bogusEnd === -1) {
                    problem = "unterminated HTML declaration";
                    break;
                }
                cursor = bogusEnd + 1;
            }
            else {
                cursor = tagStart + 1;
            }
            continue;
        }
        let nameEnd = nameStart + 1;
        while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? ""))
            nameEnd += 1;
        const name = lowerHtml.slice(nameStart, nameEnd);
        const tagBoundary = scanHtmlTagBoundary(html, nameEnd);
        if (tagBoundary.nestedMarkup !== undefined) {
            if (!closing && rawTextElements.has(name)) {
                problem = `malformed raw text element opener: ${name}`;
                break;
            }
            if (!closing && /[A-Za-z0-9]/.test(html[tagStart - 1] ?? "")) {
                cursor = tagStart + 1;
                continue;
            }
            problem = "unterminated HTML tag";
            break;
        }
        const tagEnd = tagBoundary.end;
        if (tagEnd === undefined) {
            problem = "unterminated HTML tag";
            break;
        }
        if (!closing && name === "body" && bodyEnd === undefined)
            bodyEnd = tagEnd;
        if (closing) {
            const foreignIndex = foreignElements.lastIndexOf(name);
            if (foreignIndex !== -1)
                foreignElements.length = foreignIndex;
        }
        else if ((name === "svg" || name === "math") && !/\/\s*>$/.test(html.slice(tagStart, tagEnd))) {
            foreignElements.push(name);
        }
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
    return { bodyEnd, markers, problem, reservedBoundary };
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
function scanHtmlTagBoundary(html, cursor) {
    let state = "before-attribute-name";
    let quote;
    for (let index = cursor; index < html.length; index += 1) {
        const character = html[index];
        if (state === "attribute-value-quoted") {
            if (character === quote) {
                quote = undefined;
                state = "after-attribute-value-quoted";
            }
            continue;
        }
        if (state === "before-attribute-value") {
            if (/\s/.test(character))
                continue;
            if (character === "\"" || character === "'") {
                quote = character;
                state = "attribute-value-quoted";
                continue;
            }
            if (character === ">")
                return { end: index + 1 };
            if (character === "<")
                return { nestedMarkup: index };
            state = "attribute-value-unquoted";
            continue;
        }
        if (state === "attribute-value-unquoted") {
            if (/\s/.test(character))
                state = "before-attribute-name";
            else if (character === ">")
                return { end: index + 1 };
            else if (character === "<")
                return { nestedMarkup: index };
            continue;
        }
        if (state === "attribute-name") {
            if (/\s/.test(character))
                state = "after-attribute-name";
            else if (character === "=")
                state = "before-attribute-value";
            else if (character === ">")
                return { end: index + 1 };
            else if (character === "<")
                return { nestedMarkup: index };
            continue;
        }
        if (state === "after-attribute-name") {
            if (/\s/.test(character))
                continue;
            if (character === "=")
                state = "before-attribute-value";
            else if (character === ">")
                return { end: index + 1 };
            else if (character === "<")
                return { nestedMarkup: index };
            else if (character !== "/")
                state = "attribute-name";
            continue;
        }
        if (state === "after-attribute-value-quoted") {
            if (/\s/.test(character) || character === "/")
                state = "before-attribute-name";
            else if (character === ">")
                return { end: index + 1 };
            else if (character === "<")
                return { nestedMarkup: index };
            else
                state = "attribute-name";
            continue;
        }
        if (/\s/.test(character) || character === "/")
            continue;
        if (character === ">")
            return { end: index + 1 };
        if (character === "<")
            return { nestedMarkup: index };
        state = "attribute-name";
    }
    return {};
}
function findRawTextElementEnd(html, lowerHtml, cursor, name) {
    const closingPrefix = `</${name}`;
    while (cursor < html.length) {
        const closingStart = lowerHtml.indexOf(closingPrefix, cursor);
        if (closingStart === -1)
            return undefined;
        const boundary = html[closingStart + closingPrefix.length];
        if (boundary === ">" || boundary === "/" || /\s/.test(boundary ?? "")) {
            return scanHtmlTagBoundary(html, closingStart + closingPrefix.length).end;
        }
        cursor = closingStart + closingPrefix.length;
    }
    return undefined;
}
function isProjectRelativeModulePath(value) {
    if (!value || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.parse(value).root)
        return false;
    const segments = value.split("/");
    return segments.every((segment) => segment && segment !== "." && segment !== "..");
}
function isCanonicalDescendant(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function executeBundledRenderer(source, format, modulePath, displayPath, projectRoots) {
    // Each trusted renderer owns a disposable module cache and global scope. This
    // isolates preloaded CLI/Vite dependencies as well as concurrent renderer builds,
    // without evicting or mutating the host's CommonJS cache. This is not a sandbox.
    const bootstrap = String.raw `
const { workerData } = require("node:worker_threads");
const completionPort = workerData.completionPort;
delete workerData.completionPort;
const { createRequire, Module } = require("node:module");
const { dirname, isAbsolute, resolve } = require("node:path");
const dependencies = new Set();
const runtimeSpecifiers = new Set();
const originalRequire = Module.prototype.require;
// Observe attempts before evaluation: failed CommonJS modules are evicted from
// require.cache. This override lives only in the disposable renderer Worker.
Module.prototype.require = function(specifier) {
  if (typeof specifier === "string") {
    if (isAbsolute(specifier) || /^file:/i.test(specifier)) runtimeSpecifiers.add(specifier);
    const localRequire = createRequire(this.filename || workerData.modulePath);
    try {
      const filename = localRequire.resolve(specifier);
      if (isAbsolute(filename)) dependencies.add(filename);
    } catch {
      const candidates = specifier.startsWith(".") || isAbsolute(specifier)
        ? [resolve(dirname(this.filename || workerData.modulePath), specifier)]
        : (localRequire.resolve.paths(specifier) || []).map((base) => resolve(base, specifier));
      for (const candidate of candidates) {
        for (const suffix of ["", ".js", ".json", ".node", "/package.json", "/index.js", "/index.json", "/index.node"]) dependencies.add(candidate + suffix);
      }
    }
  }
  return originalRequire.apply(this, arguments);
};
globalThis.require = createRequire(workerData.modulePath);
function post(outcome) {
  // Cross-channel delivery is not ordered against Worker.exit. Keep the worker
  // alive after completion until the parent consumes the result and terminates it.
  completionPort.ref();
  completionPort.postMessage({ ...outcome, dependencies: [...new Set([...dependencies, ...Object.keys(require.cache)])], runtimeSpecifiers: [...runtimeSpecifiers] });
}
function safeMessage(error) {
  try {
    return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  } catch {
    return "Thrown error message unavailable.";
  }
}
process.once("uncaughtException", (error) => post({ kind: "failure", message: safeMessage(error) }));
(async () => {
  try {
    const source = workerData.source + "\n//# sourceURL=" + workerData.displayPath + "\n";
    let namespace;
    if (workerData.format === "cjs") {
      const record = { exports: {} };
      const execute = new Function("exports", "require", "module", "__filename", "__dirname", source);
      execute(record.exports, globalThis.require, record, workerData.modulePath, dirname(workerData.modulePath));
      namespace = record.exports;
    } else {
      const encoded = Buffer.from(source).toString("base64");
      namespace = await import("data:text/javascript;base64," + encoded);
    }
    if (!namespace) return post({ kind: "not-function" });
    if (typeof namespace.default !== "function") return post({ kind: "not-function" });
    const rendered = await namespace.default();
    if (typeof rendered !== "string") {
      return post({ kind: "non-string", resultType: rendered === null ? "null" : typeof rendered });
    }
    post({ kind: "success", rendered });
  } catch (error) {
    post({ kind: "failure", message: safeMessage(error) });
  }
})();`;
    const completion = new MessageChannel();
    const worker = new Worker(bootstrap, {
        eval: true,
        // Runtime require(esm) hides ESM descendants from require.cache on the
        // minimum supported Node release. Keep computed requires CommonJS-only;
        // literal ESM imports/requires still use the fully tracked bundle graph.
        execArgv: ["--no-experimental-require-module"],
        workerData: { source, format, modulePath, displayPath: displayPath.replaceAll("\\", "/"), completionPort: completion.port2 },
        transferList: [completion.port2],
    });
    try {
        const outcome = await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                completion.port1.off("message", onMessage);
                worker.off("error", onError);
                worker.off("exit", onExit);
            };
            const settle = (complete) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                complete();
            };
            const onMessage = (message) => settle(() => resolve(message));
            const onError = (error) => settle(() => reject(error));
            const onExit = (code) => settle(() => {
                reject(new Error(`renderer worker exited before returning a result (code ${code})`));
            });
            completion.port1.once("message", onMessage);
            worker.once("error", onError);
            worker.once("exit", onExit);
        });
        if (outcome.kind !== "failure")
            return outcome;
        const runtimeRoots = new Set(projectRoots);
        const aliases = [];
        for (const filename of outcome.dependencies ?? []) {
            if (path.isAbsolute(filename) && !projectRoots.some((root) => filename === root || isCanonicalDescendant(root, filename))) {
                addRendererDependencyRoot(runtimeRoots, filename);
            }
        }
        for (const specifier of outcome.runtimeSpecifiers ?? []) {
            const filename = rendererLocalFilePath(specifier);
            if (!filename)
                continue;
            const containedRoot = projectRoots.find((root) => filename === root || isCanonicalDescendant(root, filename));
            const relative = containedRoot ? path.relative(containedRoot, filename) : path.basename(filename);
            aliases.push([specifier, { replacement: relative ? `<project>/${relative.replaceAll("\\", "/")}` : "<project>", boundary: "path" }]);
        }
        return { ...outcome, message: boundedMessage(outcome.message, [...runtimeRoots], aliases) };
    }
    catch (error) {
        return { kind: "failure", message: boundedMessage(error, projectRoots) };
    }
    finally {
        await worker.terminate();
        completion.port1.close();
    }
}
function boundedMessage(error, projectRoots = [], exactAliases = []) {
    let message;
    try {
        message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    }
    catch {
        message = "Thrown error message unavailable.";
    }
    let redacted = message;
    const mergedAliases = new Map();
    for (const [alias, configuration] of exactAliases) {
        mergeRendererDiagnosticAlias(mergedAliases, alias, configuration);
    }
    const aliases = [...mergedAliases.entries()].sort(([left], [right]) => right.length - left.length);
    for (const [alias, configuration] of aliases) {
        if (alias)
            redacted = redactUrlPathAlias(redacted, alias, configuration);
    }
    redacted = redactBuildProjectRoots(redacted, projectRoots);
    return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}
function mergeRendererDiagnosticAlias(aliases, alias, candidate) {
    const current = aliases.get(alias);
    if (!current) {
        aliases.set(alias, candidate);
        return;
    }
    const currentRank = current.boundary === "path" ? 1 : 0;
    const candidateRank = candidate.boundary === "path" ? 1 : 0;
    if (candidateRank > currentRank) {
        aliases.set(alias, candidate);
    }
    else if (candidateRank === currentRank && candidate.replacement < current.replacement) {
        aliases.set(alias, candidate);
    }
}
function redactUrlPathAlias(value, alias, configuration) {
    let redacted = "";
    let cursor = 0;
    while (cursor < value.length) {
        const match = value.indexOf(alias, cursor);
        if (match === -1)
            break;
        const end = match + alias.length;
        redacted += value.slice(cursor, end);
        const next = value[end];
        const boundary = configuration.boundary === "parent"
            ? next === "/"
            : end === value.length
                || next === "/"
                || next === "?"
                || next === "#"
                || next === "\""
                || next === "'"
                || /\s/.test(next ?? "");
        if (boundary) {
            redacted = `${redacted.slice(0, -alias.length)}${configuration.replacement}`;
        }
        cursor = end;
    }
    return `${redacted}${value.slice(cursor)}`;
}
function prerenderError(message, hint, diagnostics) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics)
        error.diagnostics = diagnostics;
    return error;
}
//# sourceMappingURL=client-prerender.js.map