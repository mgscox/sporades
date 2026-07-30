import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildClientToolchain, validateClientToolchainInput } from "./client-toolchain.js";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "./sealed-server-env.js";
import { serverRuntimeModuleSource } from "./server.js";
import { createServerBundleSource } from "./templates/server-bundle-template.js";
import { createPublicTree, discardPublicTree, releasePublicTreeLease, validateActivePublicTreeReference } from "./public-tree.js";
import { CLIENT_FRAMEWORK_HINT, CLIENT_TOOLCHAIN_HINT, clientCapabilityError, clientFrameworkCapability, defaultClientToolchain, isClientToolchain, supportsClientCapability } from "./client-capabilities.js";
const AUTH_PROVIDER_ORDER = ["anonymous", "email", "google", "microsoft", "apple", "facebook"];
const SUPPORTED_AUTH_PROVIDERS = new Set(AUTH_PROVIDER_ORDER);
const RUNTIME_AUTH_PROVIDERS = new Set(["anonymous", "email", "google"]);
export async function createBundle(projectDir, config, options = {}) {
    const frameworkBundleConfig = readFrameworkBundleConfig(config.client?.framework ?? "react");
    const toolchain = readClientToolchain(config.client?.toolchain ?? defaultClientToolchain(frameworkBundleConfig.framework), frameworkBundleConfig.framework);
    const buildDir = path.join(projectDir, ".sporades", "build");
    const paths = {
        config: path.join(projectDir, "sporades.json"),
        serverEntry: path.join(projectDir, "server", "index.ts"),
        clientEntry: path.join(projectDir, "client", frameworkBundleConfig.entry),
        indexHtml: path.join(projectDir, "index.html"),
        serverEnv: path.join(projectDir, ".env.sporades.server"),
        serverBundle: path.join(buildDir, "server.mjs"),
        clientBundle: path.join(buildDir, "client.js"),
    };
    const indexHtml = await readRequiredFile(paths.indexHtml, "Missing HTML shell: index.html", "Restore index.html or run `sporades create`.")
        .catch((error) => { throw tagBuildError(error, "client", frameworkBundleConfig.framework, toolchain); });
    try {
        validateClientToolchainInput({ frameworkConfig: frameworkBundleConfig, toolchain, indexHtml });
    }
    catch (error) {
        throw tagBuildError(error, "client", frameworkBundleConfig.framework, toolchain);
    }
    const sealedPaths = sealedServerEnvPaths(projectDir);
    const sealedEnvelope = await readSealedServerEnv(sealedPaths);
    const serverEnvFile = sealedEnvelope ? { exists: false, raw: "" } : await readServerEnvFile(paths.serverEnv);
    const serverEnv = sealedEnvelope
        ? unsealServerEnv(sealedEnvelope, (await readRequiredSealedPrivateKey(sealedPaths)).privateKey)
        : parseServerEnv(serverEnvFile);
    validateAuthConfig(config, serverEnv);
    const [serverSource, clientSource] = await Promise.all([
        readRequiredFile(paths.serverEntry, "Missing capsule entry: server/index.ts", "Run `sporades create` to scaffold a new project.")
            .catch((error) => { throw tagBuildError(error, "server", frameworkBundleConfig.framework, toolchain); }),
        readRequiredFile(paths.clientEntry, `Missing client entry: client/${frameworkBundleConfig.entry}`, "Run `sporades create` to scaffold a new project.")
            .catch((error) => { throw tagBuildError(error, "client", frameworkBundleConfig.framework, toolchain); }),
    ]);
    const serverCapsuleModule = await bundleServerCapsuleModule({
        serverSource,
        serverSourcePath: paths.serverEntry,
    }).catch((error) => { throw tagBuildError(error, "server", frameworkBundleConfig.framework, toolchain); });
    const clientOutput = await buildClientToolchain({
        projectDir,
        toolchain,
        indexHtml,
        indexHtmlPath: paths.indexHtml,
        clientSource,
        clientSourcePath: paths.clientEntry,
        frameworkConfig: frameworkBundleConfig,
        devRefresh: options.devClientRefresh === true,
    }).catch((error) => { throw tagBuildError(error, "client", frameworkBundleConfig.framework, toolchain); });
    const clientBundle = clientOutput.legacyClientBundle;
    const serverBundle = createServerBundleSource({
        config,
        serverEnv: sealedEnvelope ? {} : serverEnv,
        sealedServerEnv: sealedEnvelope ? { enabled: true } : { enabled: false },
        serverSource,
        serverModuleSource: serverCapsuleModule,
    });
    await mkdir(buildDir, { recursive: true });
    const publicTree = await createPublicTree(buildDir, clientOutput.publicFiles)
        .catch((error) => { throw tagBuildError(error, "public", frameworkBundleConfig.framework, toolchain); });
    const legacyFiles = [
        { target: paths.serverBundle, contents: serverBundle },
        { target: paths.clientBundle, contents: clientBundle },
    ];
    let legacyPublished = false;
    const publishLegacy = async () => {
        if (legacyPublished) {
            throw tagBuildError(new Error("Legacy Bundles are already published."), "publish", frameworkBundleConfig.framework, toolchain);
        }
        let previous;
        const activeTreePath = path.join(buildDir, ".public-trees", "active.json");
        const candidateTreeName = path.basename(publicTree.root);
        let previousActiveTree;
        try {
            previous = await Promise.all(legacyFiles.map(async (file) => ({
                target: file.target,
                contents: await readFile(file.target).catch((error) => {
                    if (errorDetails(error).code === "ENOENT")
                        return null;
                    throw error;
                }),
            })));
            previousActiveTree = await readFile(activeTreePath).catch((error) => {
                if (errorDetails(error).code === "ENOENT")
                    return null;
                throw error;
            });
            await publishLegacyBundles(buildDir, legacyFiles.filter((file) => file.contents !== null));
            await Promise.all(legacyFiles.filter((file) => file.contents === null).map((file) => rm(file.target, { force: true })));
            try {
                options.activeReferenceFault?.("before-active-write");
                await replaceBundleStateFile(activeTreePath, `${JSON.stringify({ tree: candidateTreeName })}\n`);
                options.activeReferenceFault?.("after-active-write");
            }
            catch (error) {
                const activeState = await inspectActiveTreeState(activeTreePath);
                const previousState = previousActiveTree === null
                    ? { kind: "missing" }
                    : await parseActiveTreeState(previousActiveTree.toString("utf8"), path.dirname(activeTreePath));
                if (!activeTreeStatesEqual(activeState, previousState))
                    throw activeReferenceRecoveryError(candidateTreeName, activeState.kind);
                await restoreLegacyBundleFiles(buildDir, previous);
                throw error;
            }
            legacyPublished = true;
        }
        catch (error) {
            throw tagBuildError(error, "publish", frameworkBundleConfig.framework, toolchain);
        }
        return async () => {
            try {
                options.activeReferenceFault?.("before-active-restore");
                if (previousActiveTree === null)
                    await rm(activeTreePath, { force: true });
                else
                    await replaceBundleStateFile(activeTreePath, previousActiveTree);
                options.activeReferenceFault?.("after-active-restore");
            }
            catch {
                const activeState = await inspectActiveTreeState(activeTreePath);
                const previousState = previousActiveTree === null
                    ? { kind: "missing" }
                    : await parseActiveTreeState(previousActiveTree.toString("utf8"), path.dirname(activeTreePath));
                if (!activeTreeStatesEqual(activeState, previousState))
                    throw activeReferenceRecoveryError(candidateTreeName, activeState.kind);
            }
            await restoreLegacyBundleFiles(buildDir, previous);
            legacyPublished = false;
        };
    };
    if (options.publishLegacy !== false) {
        try {
            const rollback = await publishLegacy();
            try {
                await releasePublicTreeLease(publicTree);
            }
            catch (error) {
                await rollback();
                throw error;
            }
        }
        catch (error) {
            if (candidateDiscardIsForbidden(error))
                await releasePublicTreeLease(publicTree).catch(() => { });
            else
                await discardPublicTree(publicTree);
            throw error;
        }
    }
    return {
        paths,
        buildDir,
        publishLegacy,
        releasePublicTreeLease: () => releasePublicTreeLease(publicTree),
        serverRuntime: {
            source: serverSource,
            env: serverEnv,
            capsuleModuleSource: serverCapsuleModule,
        },
        staticFiles: {
            publicTree,
            publicDir: publicTree.root,
            indexHtml: path.join(publicTree.root, "index.html"),
            clientBundle: clientBundle === null ? null : path.join(publicTree.root, "client.js"),
        },
        containerMounts: {
            files: [
                { host: paths.serverBundle, container: "/app/server.mjs", mode: "ro" },
                { host: publicTree.root, container: "/app/public", mode: "ro" },
                { host: paths.config, container: "/app/sporades.json", mode: "ro" },
            ],
            serverEnv: serverEnvFile.exists
                ? { host: paths.serverEnv, container: "/app/.env.sporades.server", mode: "ro" }
                : null,
            sealedServerEnv: sealedEnvelope
                ? {
                    envelope: { host: sealedPaths.envelope, container: "/app/.sporades/sealed-server-env/server-env.sealed.json", mode: "ro" },
                    privateKey: { host: sealedPaths.privateKey, container: "/app/.sporades/sealed-server-env/server-env.private.pem", mode: "ro" },
                }
                : null,
        },
    };
}
async function restoreLegacyBundleFiles(buildDir, previous) {
    const existing = previous.filter((file) => file.contents !== null);
    await publishLegacyBundles(buildDir, existing);
    await Promise.all(previous.filter((file) => file.contents === null).map((file) => rm(file.target, { force: true })));
}
async function inspectActiveTreeState(filePath) {
    try {
        return await parseActiveTreeState(await readFile(filePath, "utf8"), path.dirname(filePath));
    }
    catch (error) {
        if (errorDetails(error).code === "ENOENT")
            return { kind: "missing" };
        return { kind: "invalid" };
    }
}
async function parseActiveTreeState(raw, treesDir) {
    try {
        return { kind: "valid", tree: await validateActivePublicTreeReference(treesDir, raw) };
    }
    catch {
        return { kind: "invalid" };
    }
}
function activeTreeStatesEqual(left, right) {
    if (left.kind === "missing" && right.kind === "missing")
        return true;
    return left.kind === "valid" && right.kind === "valid" && left.tree === right.tree;
}
function activeReferenceRecoveryError(candidateTree, activeState) {
    return commandError("Active public tree recovery is incomplete.", "Preserved the candidate public tree and matching legacy Bundles for deterministic recovery.", { candidateDiscard: "forbidden", candidateTree, activeState });
}
async function replaceBundleStateFile(filePath, contents) {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
        await writeFile(temporaryPath, contents);
        await rename(temporaryPath, filePath);
    }
    finally {
        await rm(temporaryPath, { force: true });
    }
}
export async function publishLegacyBundles(buildDir, files, options = {}) {
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stagingDir = path.join(buildDir, `.legacy-staging-${nonce}`);
    const states = [];
    let preserveStaging = false;
    await mkdir(stagingDir, { recursive: false });
    try {
        for (const [index, file] of files.entries()) {
            const stats = await lstat(file.target).catch((error) => {
                if (errorDetails(error).code === "ENOENT")
                    return null;
                throw error;
            });
            if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
                throw commandError("Legacy Bundle publication failed.", `${file.target} must be a regular file.`);
            }
            const candidate = path.join(stagingDir, `candidate-${index}`);
            await writeFile(candidate, file.contents);
            states.push({ target: file.target, candidate, backup: path.join(stagingDir, `backup-${index}`), moved: false, published: false });
        }
        try {
            for (const state of states) {
                try {
                    await rename(state.target, state.backup);
                    state.moved = true;
                }
                catch (error) {
                    if (errorDetails(error).code !== "ENOENT")
                        throw error;
                }
            }
            for (const [index, state] of states.entries()) {
                options.fault?.("before-publish", index);
                await rename(state.candidate, state.target);
                state.published = true;
            }
        }
        catch (error) {
            const recoveryFailures = [];
            for (const [index, state] of [...states.entries()].reverse()) {
                try {
                    options.fault?.("before-restore", index);
                    if (state.moved)
                        await rename(state.backup, state.target);
                    else if (state.published)
                        await rm(state.target, { force: true });
                }
                catch {
                    recoveryFailures.push(index);
                }
            }
            if (recoveryFailures.length > 0) {
                preserveStaging = true;
                throw commandError("Legacy Bundle recovery is incomplete.", `Preserved ${recoveryFailures.length} recovery backup${recoveryFailures.length === 1 ? "" : "s"} in ${path.basename(stagingDir)}.`, { failedFiles: recoveryFailures.length, recoveryDirectory: path.basename(stagingDir) });
            }
            throw error;
        }
    }
    finally {
        if (!preserveStaging)
            await rm(stagingDir, { recursive: true, force: true });
    }
}
async function readRequiredSealedPrivateKey(paths) {
    const keyPair = await readKeyPair(paths);
    if (!keyPair) {
        throw commandError("Sealed Server env private key is missing.", "Restore .sporades/sealed-server-env/server-env.private.pem or re-import the Server env values.");
    }
    return keyPair;
}
export async function bundleServerCapsuleModule(options) {
    const { build } = await import("esbuild");
    try {
        const result = await build({
            bundle: true,
            format: "esm",
            platform: "node",
            write: false,
            logLevel: "silent",
            sourcemap: "inline",
            stdin: {
                contents: options.serverSource,
                sourcefile: options.serverSourcePath,
                resolveDir: path.dirname(options.serverSourcePath),
                loader: "ts",
            },
            plugins: [sporadesServerPlugin()],
        });
        const output = result.outputFiles?.[0];
        if (!output) {
            throw commandError("Server bundle failed: esbuild returned no output.", "Fix server/index.ts and save again.");
        }
        return output.text;
    }
    catch (error) {
        const message = bundleErrorMessage(error);
        throw commandError(`Server bundle failed: ${message}`, "Fix server/index.ts and save again.");
    }
}
export async function readServerEnvFile(envPath) {
    try {
        const raw = await readFile(envPath, "utf8");
        if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
            throw commandError("Invalid server env file.", ".env.sporades.server must be 64KB or smaller.");
        }
        return { exists: true, raw };
    }
    catch (error) {
        if (errorDetails(error).code === "ENOENT") {
            return { exists: false, raw: "" };
        }
        throw error;
    }
}
export function parseServerEnv(envFile) {
    const values = {};
    for (const [index, line] of envFile.raw.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex <= 0) {
            throw commandError("Invalid server env file.", `Fix line ${index + 1} in .env.sporades.server to use KEY=value.`);
        }
        const key = trimmed.slice(0, equalsIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw commandError("Invalid server env file.", `Fix invalid key ${key} in .env.sporades.server.`);
        }
        if (key.startsWith("SPORADES_")) {
            throw commandError("Invalid server env file.", "Remove reserved SPORADES_ keys from .env.sporades.server.");
        }
        values[key] = parseEnvValue(trimmed.slice(equalsIndex + 1).trim());
    }
    if (Object.keys(values).length > 64) {
        throw commandError("Invalid server env file.", ".env.sporades.server can contain at most 64 keys.");
    }
    return values;
}
function parseEnvValue(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === "string") {
                return parsed;
            }
        }
        catch {
            // Preserve the legacy double-quoted value behaviour for existing env files.
        }
        return value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1);
    }
    return value;
}
export function authStatus(config, serverEnv) {
    const authConfig = config.auth ?? { mode: "anonymous" };
    const normalized = normalizeAuthConfig(authConfig);
    const providers = {};
    const port = typeof config.dev === "object" && config.dev && typeof config.dev.port === "number"
        ? Number(config.dev.port)
        : typeof config.deploy === "object" && config.deploy && typeof config.deploy.port === "number"
            ? Number(config.deploy.port)
            : 4000;
    for (const providerName of AUTH_PROVIDER_ORDER) {
        const provider = normalized.providers[providerName];
        const configured = providerConfigured(providerName, provider, serverEnv);
        const result = {
            enabled: provider.enabled,
            configured,
            runtimeAvailable: RUNTIME_AUTH_PROVIDERS.has(providerName),
        };
        if (providerName === "google" || providerName === "microsoft" || providerName === "facebook") {
            result.clientIdEnv = provider.clientIdEnv;
            result.clientSecretEnv = provider.clientSecretEnv;
        }
        if (providerName === "microsoft")
            result.tenant = provider.tenant;
        if (providerName === "facebook")
            result.graphVersion = provider.graphVersion;
        if (providerName === "apple") {
            result.clientId = provider.clientId;
            result.teamId = provider.teamId;
            result.keyId = provider.keyId;
            result.privateKeyEnv = provider.privateKeyEnv;
        }
        if (!["anonymous", "email"].includes(providerName)) {
            result.callbackPath = `/__sporades/auth/${providerName}/callback`;
            if (providerName === "apple") {
                result.callbackUrl = null;
                result.callbackGuidance = "Register this callback path on the Capsule's Hosted HTTPS origin, or use an HTTPS development tunnel.";
            }
            else {
                result.callbackUrl = port > 0 ? `http://localhost:${port}${result.callbackPath}` : null;
            }
        }
        providers[providerName] = result;
    }
    return {
        mode: normalized.mode,
        providers,
        google: {
            configured: providers.google.configured,
            clientIdEnv: normalized.providers.google.clientIdEnv,
            clientSecretEnv: normalized.providers.google.clientSecretEnv,
        },
    };
}
function normalizeAuthConfig(authConfig) {
    const providerConfig = isRecord(authConfig.providers) ? authConfig.providers : {};
    for (const provider of Object.keys(providerConfig)) {
        if (!SUPPORTED_AUTH_PROVIDERS.has(provider)) {
            throw commandError(`Unsupported auth provider: ${provider}`, `Use supported auth providers: ${AUTH_PROVIDER_ORDER.join(", ")}.`);
        }
    }
    const googleConfig = readProviderConfig(providerConfig.google);
    const legacyGoogle = readProviderConfig(authConfig.google);
    const googleEnabled = googleConfig.enabled || authConfig.mode === "google";
    const emailConfig = readProviderConfig(providerConfig.email);
    const anonymousConfig = readProviderConfig(providerConfig.anonymous);
    const anonymousEnabled = providerConfig.anonymous === undefined ? true : anonymousConfig.enabled;
    const mode = typeof authConfig.mode === "string" ? String(authConfig.mode) : googleEnabled ? "google" : "anonymous";
    return {
        mode,
        providers: {
            anonymous: {
                enabled: anonymousEnabled,
                ...emptyProviderConfig(),
            },
            google: {
                ...emptyProviderConfig(),
                enabled: googleEnabled,
                clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv,
                clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv,
            },
            email: {
                enabled: emailConfig.enabled,
                ...emptyProviderConfig(),
            },
            microsoft: readProviderConfig(providerConfig.microsoft),
            apple: readProviderConfig(providerConfig.apple),
            facebook: readProviderConfig(providerConfig.facebook),
        },
    };
}
function readProviderConfig(config) {
    if (config === true) {
        return { enabled: true, ...emptyProviderConfig() };
    }
    if (config === false || config === undefined || config === null) {
        return { enabled: false, ...emptyProviderConfig() };
    }
    if (!isRecord(config)) {
        return { enabled: false, ...emptyProviderConfig() };
    }
    return {
        enabled: config.enabled !== false,
        clientIdEnv: typeof config.clientIdEnv === "string" ? config.clientIdEnv : null,
        clientSecretEnv: typeof config.clientSecretEnv === "string" ? config.clientSecretEnv : null,
        clientId: typeof config.clientId === "string" ? config.clientId : null,
        teamId: typeof config.teamId === "string" ? config.teamId : null,
        keyId: typeof config.keyId === "string" ? config.keyId : null,
        privateKeyEnv: typeof config.privateKeyEnv === "string" ? config.privateKeyEnv : null,
        tenant: typeof config.tenant === "string" ? config.tenant : null,
        graphVersion: typeof config.graphVersion === "string" ? config.graphVersion : null,
    };
}
function validateAuthConfig(config, serverEnv) {
    const status = authStatus(config, serverEnv);
    for (const provider of AUTH_PROVIDER_ORDER) {
        const state = status.providers[provider];
        if (!state.enabled || state.configured)
            continue;
        const callback = typeof state.callbackUrl === "string"
            ? ` Register callback URL ${state.callbackUrl}.`
            : typeof state.callbackGuidance === "string"
                ? ` ${state.callbackGuidance}`
                : "";
        throw commandError(`${providerLabel(provider)} auth is not fully configured.`, `${providerConfigurationHint(provider)}${callback}`);
    }
}
function emptyProviderConfig() {
    return {
        clientIdEnv: null,
        clientSecretEnv: null,
        clientId: null,
        teamId: null,
        keyId: null,
        privateKeyEnv: null,
        tenant: null,
        graphVersion: null,
    };
}
function providerConfigured(provider, config, serverEnv) {
    if (provider === "anonymous" || provider === "email")
        return true;
    if (provider === "apple") {
        return Boolean(config.clientId && config.teamId && config.keyId && config.privateKeyEnv && serverEnv[config.privateKeyEnv]);
    }
    return Boolean(config.clientIdEnv && config.clientSecretEnv && serverEnv[config.clientIdEnv] && serverEnv[config.clientSecretEnv]);
}
function providerLabel(provider) {
    return `${provider[0].toUpperCase()}${provider.slice(1)}`;
}
function providerConfigurationHint(provider) {
    if (provider === "apple") {
        return "Run `sporades auth set apple --client-id <services-id> --team-id <team-id> --key-id <key-id> --private-key <pem>` or use `--client-json <path>`.";
    }
    return `Run \`sporades auth set ${provider} --client-id <id> --client-secret <secret>\` or use \`--client-json <path>\`.`;
}
async function readRequiredFile(filePath, message, hint) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (errorDetails(error).code === "ENOENT") {
            throw commandError(message, hint);
        }
        throw error;
    }
}
function readFrameworkBundleConfig(framework) {
    const capability = clientFrameworkCapability(framework);
    if (!capability)
        throw commandError(`Unsupported framework: ${framework}`, CLIENT_FRAMEWORK_HINT);
    return { framework: capability.framework, ...capability.build };
}
function readClientToolchain(toolchain, framework) {
    if (!isClientToolchain(toolchain))
        throw commandError(`Unsupported client toolchain: ${toolchain}`, CLIENT_TOOLCHAIN_HINT);
    if (!supportsClientCapability(framework, toolchain)) {
        const details = clientCapabilityError(framework, toolchain);
        throw commandError(details.message, details.hint);
    }
    return toolchain;
}
function sporadesServerPlugin() {
    return {
        name: "sporades-server",
        setup(build) {
            build.onResolve({ filter: /^sporades\/server$/ }, () => ({
                path: "sporades/server",
                namespace: "sporades-runtime",
            }));
            build.onLoad({ filter: /^sporades\/server$/, namespace: "sporades-runtime" }, async () => ({
                loader: "js",
                contents: serverRuntimeModuleSource(),
            }));
        },
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function errorDetails(error) {
    if (error === null || error === undefined) {
        return {};
    }
    return typeof error === "object" ? error : { message: String(error) };
}
function candidateDiscardIsForbidden(error) {
    const diagnostics = errorDetails(error).diagnostics;
    return isRecord(diagnostics) && diagnostics.candidateDiscard === "forbidden";
}
function bundleErrorMessage(error) {
    const details = errorDetails(error);
    const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
    if (isRecord(firstError) && typeof firstError.text === "string") {
        return firstError.text;
    }
    return typeof details.message === "string" ? details.message : "unknown error";
}
function commandError(message, hint, diagnostics) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics !== undefined)
        error.diagnostics = diagnostics;
    return error;
}
function tagBuildError(error, phase, framework, toolchain) {
    const tagged = error instanceof Error ? error : commandError(String(error), "Fix the build error and save again.");
    tagged.phase = phase;
    tagged.framework = framework;
    tagged.toolchain = toolchain;
    return tagged;
}
//# sourceMappingURL=bundle-pipeline.js.map