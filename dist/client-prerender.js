import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Parser } from "acorn";
import jsx from "acorn-jsx";
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
    let bundleFormat = "cjs";
    const rendererDependencyRoots = new Set();
    try {
        const { build } = await import("esbuild");
        let result;
        try {
            result = await buildRendererBundle(build, projectRoot, canonicalModulePath, bundleFormat, rendererDependencyRoots);
        }
        catch (error) {
            if (!isCommonJsTopLevelAwaitBuildFailure(error))
                throw error;
            bundleFormat = "esm";
            result = await buildRendererBundle(build, projectRoot, canonicalModulePath, bundleFormat, rendererDependencyRoots);
        }
        const outputs = result.outputFiles ?? [];
        const javascript = outputs.filter((output) => output.path.endsWith(".js"));
        if (outputs.length !== 1 || javascript.length !== 1 || !javascript[0]?.text) {
            throw new Error("the renderer produced an unsupported secondary output");
        }
        bundledSource = javascript[0].text;
    }
    catch (error) {
        throw prerenderError(`Could not build client prerender module for ${fragment.name}: ${boundedMessage(error, [...projectRoots, ...rendererDependencyRoots])}`, `Fix ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    const boundedRendererRoots = [...projectRoots, ...rendererDependencyRoots];
    if (bundleFormat === "esm") {
        const outcome = await executeEsmBundledRenderer(bundledSource, canonicalModulePath, fragment.module, boundedRendererRoots);
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
    let renderer;
    const initialRequireCache = new Set(Object.keys(createRequire(canonicalModulePath).cache));
    try {
        renderer = executeBundledRenderer(bundledSource, canonicalModulePath, fragment.module);
    }
    catch (error) {
        discardRendererRequireCache(initialRequireCache);
        throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, boundedRendererRoots)}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    if (typeof renderer !== "function") {
        discardRendererRequireCache(initialRequireCache);
        throw prerenderError(`Client prerender module for ${fragment.name} must default-export a zero-argument renderer.`, `Default-export a function from ${fragment.module} that returns an HTML string or Promise<string>.`);
    }
    let rendered;
    try {
        rendered = await renderer();
    }
    catch (error) {
        throw prerenderError(`Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, boundedRendererRoots)}`, `Fix the renderer in ${fragment.module}, then retry.`, { fragment: fragment.name, module: fragment.module });
    }
    finally {
        discardRendererRequireCache(initialRequireCache);
    }
    if (typeof rendered !== "string") {
        throw prerenderError(`Client prerender renderer for ${fragment.name} returned a non-string result.`, `Return an HTML string or Promise<string> from ${fragment.module}.`, { fragment: fragment.name, resultType: rendered === null ? "null" : typeof rendered });
    }
    return rendered;
}
async function buildRendererBundle(build, projectRoot, canonicalModulePath, format, rendererDependencyRoots) {
    return build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryNames: "renderer",
        entryPoints: { renderer: canonicalModulePath },
        format,
        logLevel: "silent",
        outdir: path.join(projectRoot, ".sporades-prerender-output"),
        platform: "node",
        plugins: [preserveRendererImportMetaUrl(build, projectRoot, rendererDependencyRoots)],
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
function preserveRendererImportMetaUrl(esbuildBuild, projectRoot, rendererDependencyRoots) {
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
                    if (path.isAbsolute(args.path)
                        && path.resolve(args.path) !== path.resolve(projectRoot)
                        && !isCanonicalDescendant(projectRoot, args.path)) {
                        rendererDependencyRoots.add(path.dirname(args.path));
                    }
                    return args.namespace === commonJsNamespace ? { errors: resolved.errors, warnings: resolved.warnings } : undefined;
                }
                if (!resolved.external
                    && resolved.namespace === "file"
                    && !isCanonicalDescendant(projectRoot, resolved.path)) {
                    rendererDependencyRoots.add(path.dirname(resolved.path));
                }
                let namespace = resolved.namespace;
                if (!resolved.external && namespace === "file" && [".js", ".jsx"].includes(path.extname(resolved.path))) {
                    const contents = await readFile(resolved.path, "utf8");
                    if (await rendererModuleUsesCommonJs(resolved.path, contents, projectRoot, packageModeCache)
                        && await rendererNeedsCommonJsBoundaryNamespace(resolved.path)) {
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
                const requiresTransform = preservesImportMetaUrl || (commonJsModule && /\b(?:require|__dirname|__filename)\b/.test(contents));
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
                    format: commonJsModule ? "cjs" : "esm",
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
async function rendererModuleUsesCommonJs(modulePath, contents, projectRoot, packageModeCache) {
    const extension = path.extname(modulePath);
    if (extension === ".cjs" || extension === ".cts")
        return true;
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
function specializeCommonJsRendererModule(contents, modulePath, moduleUrl) {
    const syntax = RendererSyntaxParser.parse(contents, {
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        ecmaVersion: "latest",
        sourceType: "script",
    });
    const rootScope = { functionScope: true, bindings: new Set() };
    const scopes = new WeakMap();
    collectRendererScopes(syntax, rootScope, scopes);
    const assignmentTargets = new WeakSet();
    collectRendererAssignmentTargets(syntax, assignmentTargets);
    const deleteOperands = new WeakSet();
    collectRendererDeleteOperands(syntax, deleteOperands);
    const writtenWrapperNames = new Set();
    visitRendererSyntax(syntax, (node) => {
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
    visitRendererSyntax(syntax, (node, parent, key) => {
        const scope = scopes.get(node) ?? rootScope;
        if (node.type === "CallExpression") {
            const callee = node.callee;
            const args = node.arguments;
            const first = args?.[0];
            const memberObject = callee?.type === "MemberExpression" ? callee.object : undefined;
            const memberProperty = callee?.type === "MemberExpression" ? callee.property : undefined;
            if (memberObject?.type === "Identifier"
                && memberObject.name === "require"
                && memberProperty?.type === "Identifier"
                && memberProperty.name === "resolve"
                && callee?.computed !== true
                && !rendererScopeBinds(scope, "require")) {
                replacements.push({
                    start: memberObject.start,
                    end: memberObject.end,
                    value: writtenWrapperNames.has("require") ? "(0, require)" : helperName,
                });
                return;
            }
            if (callee?.type === "Identifier"
                && callee.name === "require"
                && !rendererScopeBinds(scope, "require")
                && first
                && !isStaticRendererRequireSpecifier(first)) {
                replacements.push({
                    start: callee.start,
                    end: callee.end,
                    value: writtenWrapperNames.has("require") ? "(0, require)" : helperName,
                });
            }
            return;
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
    if (replacements.length === 0)
        return { contents, changed: false };
    const needsModuleRequire = replacements.some((replacement) => replacement.value === helperName);
    if (needsModuleRequire) {
        const insertionOffset = rendererHelperInsertionOffset(syntax, contents);
        replacements.push({
            start: insertionOffset,
            end: insertionOffset,
            value: `const ${helperName} = require("node:module").createRequire(${JSON.stringify(moduleUrl)});\n`,
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
        for (const declaration of node.declarations ?? [])
            addRendererBinding(declarationScope, declaration.id);
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
function discardRendererRequireCache(initialCache) {
    const cache = createRequire(import.meta.url).cache;
    for (const cachedPath of Object.keys(cache)) {
        if (!initialCache.has(cachedPath))
            delete cache[cachedPath];
    }
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
    const rawTextElements = new Set(["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"]);
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
        const tagKind = html[tagStart + 1];
        if (tagKind === "!" || tagKind === "?") {
            const declarationEnd = html.indexOf(">", tagStart + 2);
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
async function executeEsmBundledRenderer(source, modulePath, displayPath, projectRoots) {
    // A short-lived worker gives top-level-await bundles a real ESM evaluator while
    // bounding Node's otherwise permanent data-URL module cache to this render.
    const bootstrap = String.raw `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
globalThis.require = createRequire(workerData.modulePath);
function safeMessage(error) {
  try {
    return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  } catch {
    return "Thrown error message unavailable.";
  }
}
(async () => {
  try {
    const encoded = Buffer.from(workerData.source + "\n//# sourceURL=" + workerData.displayPath + "\n").toString("base64");
    const namespace = await import("data:text/javascript;base64," + encoded);
    if (typeof namespace.default !== "function") return parentPort.postMessage({ kind: "not-function" });
    const rendered = await namespace.default();
    if (typeof rendered !== "string") {
      return parentPort.postMessage({ kind: "non-string", resultType: rendered === null ? "null" : typeof rendered });
    }
    parentPort.postMessage({ kind: "success", rendered });
  } catch (error) {
    parentPort.postMessage({ kind: "failure", message: safeMessage(error) });
  }
})();`;
    const worker = new Worker(bootstrap, {
        eval: true,
        workerData: { source, modulePath, displayPath: displayPath.replaceAll("\\", "/") },
    });
    try {
        const outcome = await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                worker.off("message", onMessage);
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
            worker.once("message", onMessage);
            worker.once("error", onError);
            worker.once("exit", onExit);
        });
        if (outcome.kind !== "failure")
            return outcome;
        return { kind: "failure", message: boundedMessage(outcome.message, projectRoots) };
    }
    catch (error) {
        return { kind: "failure", message: boundedMessage(error, projectRoots) };
    }
    finally {
        await worker.terminate();
    }
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