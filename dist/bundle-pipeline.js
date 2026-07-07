import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "./sealed-server-env.js";
import { serverRuntimeModuleSource } from "./server.js";
import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
import { createServerBundleSource } from "./templates/server-bundle-template.js";
const FRAMEWORK_BUNDLE_CONFIG = {
    react: {
        jsxImportSource: "react",
        jsxRuntimeImport: "react/jsx-runtime",
    },
    preact: {
        jsxImportSource: "preact",
        jsxRuntimeImport: "preact/jsx-runtime",
    },
};
const SUPPORTED_AUTH_PROVIDERS = new Set(["anonymous", "google", "email"]);
export async function createBundle(projectDir, config) {
    const frameworkBundleConfig = readFrameworkBundleConfig(config.client?.framework ?? "react");
    const buildDir = path.join(projectDir, ".sporades", "build");
    await mkdir(buildDir, { recursive: true });
    const paths = {
        config: path.join(projectDir, "sporades.json"),
        serverEntry: path.join(projectDir, "server", "index.ts"),
        clientEntry: path.join(projectDir, "client", "index.tsx"),
        indexHtml: path.join(projectDir, "index.html"),
        serverEnv: path.join(projectDir, ".env.sporades.server"),
        serverBundle: path.join(buildDir, "server.mjs"),
        clientBundle: path.join(buildDir, "client.js"),
    };
    const sealedPaths = sealedServerEnvPaths(projectDir);
    const sealedEnvelope = await readSealedServerEnv(sealedPaths);
    const serverEnvFile = sealedEnvelope ? { exists: false, raw: "" } : await readServerEnvFile(paths.serverEnv);
    const serverEnv = sealedEnvelope
        ? unsealServerEnv(sealedEnvelope, (await readRequiredSealedPrivateKey(sealedPaths)).privateKey)
        : parseServerEnv(serverEnvFile);
    validateAuthConfig(config, serverEnv);
    const [serverSource, clientSource] = await Promise.all([
        readRequiredFile(paths.serverEntry, "Missing capsule entry: server/index.ts", "Run `sporades create` to scaffold a new project."),
        readRequiredFile(paths.clientEntry, "Missing client entry: client/index.tsx", "Run `sporades create` to scaffold a new project."),
        readRequiredFile(paths.indexHtml, "Missing HTML shell: index.html", "Restore index.html or run `sporades create`."),
    ]);
    const serverCapsuleModule = await bundleServerCapsuleModule({
        serverSource,
        serverSourcePath: paths.serverEntry,
    });
    const clientBundle = await bundleClientSource(clientSource, {
        clientSourcePath: paths.clientEntry,
        frameworkBundleConfig,
    });
    await Promise.all([
        writeFile(paths.serverBundle, createServerBundleSource({
            config,
            serverEnv: sealedEnvelope ? {} : serverEnv,
            sealedServerEnv: sealedEnvelope ? { enabled: true } : { enabled: false },
            serverSource,
            serverModuleSource: serverCapsuleModule,
        })),
        writeFile(paths.clientBundle, clientBundle),
    ]);
    return {
        paths,
        buildDir,
        serverRuntime: {
            source: serverSource,
            env: serverEnv,
            capsuleModuleSource: serverCapsuleModule,
        },
        staticFiles: {
            indexHtml: paths.indexHtml,
            clientBundle: paths.clientBundle,
        },
        containerMounts: {
            files: [
                { host: paths.serverBundle, container: "/app/server.mjs", mode: "ro" },
                { host: paths.clientBundle, container: "/app/client.js", mode: "ro" },
                { host: paths.indexHtml, container: "/app/index.html", mode: "ro" },
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
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
export function authStatus(config, serverEnv) {
    const authConfig = config.auth ?? { mode: "anonymous" };
    const normalized = normalizeAuthConfig(authConfig);
    const clientIdEnv = normalized.providers.google.clientIdEnv;
    const clientSecretEnv = normalized.providers.google.clientSecretEnv;
    const providers = {
        anonymous: {
            enabled: normalized.providers.anonymous.enabled,
        },
        google: {
            enabled: normalized.providers.google.enabled,
            configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
            clientIdEnv,
            clientSecretEnv,
        },
    };
    if (normalized.providers.email.enabled) {
        providers.email = {
            enabled: true,
        };
    }
    return {
        mode: normalized.mode,
        providers,
        google: {
            configured: providers.google.configured,
            clientIdEnv,
            clientSecretEnv,
        },
    };
}
function normalizeAuthConfig(authConfig) {
    const providerConfig = isRecord(authConfig.providers) ? authConfig.providers : {};
    for (const provider of Object.keys(providerConfig)) {
        if (!SUPPORTED_AUTH_PROVIDERS.has(provider)) {
            throw commandError(`Unsupported auth provider: ${provider}`, "Use supported auth providers: anonymous, google, email.");
        }
    }
    const googleConfig = readProviderConfig(providerConfig.google);
    const legacyGoogle = readProviderConfig(authConfig.google);
    const googleEnabled = googleConfig.enabled || authConfig.mode === "google";
    const emailConfig = readProviderConfig(providerConfig.email);
    const anonymousConfig = readProviderConfig(providerConfig.anonymous);
    const anonymousEnabled = providerConfig.anonymous === undefined ? true : anonymousConfig.enabled;
    const mode = typeof authConfig.mode === "string" ? authConfig.mode : googleEnabled ? "google" : "anonymous";
    return {
        mode,
        providers: {
            anonymous: {
                enabled: anonymousEnabled,
            },
            google: {
                enabled: googleEnabled,
                clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv,
                clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv,
            },
            email: {
                enabled: emailConfig.enabled,
            },
        },
    };
}
function readProviderConfig(config) {
    if (config === true) {
        return { enabled: true, clientIdEnv: null, clientSecretEnv: null };
    }
    if (config === false || config === undefined || config === null) {
        return { enabled: false, clientIdEnv: null, clientSecretEnv: null };
    }
    if (!isRecord(config)) {
        return { enabled: false, clientIdEnv: null, clientSecretEnv: null };
    }
    return {
        enabled: config.enabled !== false,
        clientIdEnv: typeof config.clientIdEnv === "string" ? config.clientIdEnv : null,
        clientSecretEnv: typeof config.clientSecretEnv === "string" ? config.clientSecretEnv : null,
    };
}
function validateAuthConfig(config, serverEnv) {
    const status = authStatus(config, serverEnv);
    if (!status.providers.google.enabled) {
        return;
    }
    if (!status.google.configured) {
        throw commandError("Google OAuth is not fully configured.", "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.");
    }
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
    if (typeof framework !== "string" || !(framework in FRAMEWORK_BUNDLE_CONFIG)) {
        throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact.");
    }
    return FRAMEWORK_BUNDLE_CONFIG[framework];
}
async function bundleClientSource(clientSource, options) {
    const { build } = await import("esbuild");
    try {
        const result = await build({
            bundle: true,
            format: "esm",
            platform: "browser",
            write: false,
            logLevel: "silent",
            sourcemap: "inline",
            jsx: "automatic",
            jsxImportSource: options.frameworkBundleConfig.jsxImportSource,
            stdin: {
                contents: clientSource,
                sourcefile: options.clientSourcePath,
                resolveDir: path.dirname(options.clientSourcePath),
                loader: "tsx",
            },
            plugins: [sporadesClientPlugin()],
        });
        const output = result.outputFiles?.[0];
        if (!output) {
            throw commandError("Client bundle failed: esbuild returned no output.", "Fix client/index.tsx and save again.");
        }
        return [
            "// Sporades client bundle",
            `// JSX import source: ${options.frameworkBundleConfig.jsxImportSource}`,
            `// JSX runtime import: ${options.frameworkBundleConfig.jsxRuntimeImport}`,
            'console.log("Sporades client bundle loaded");',
            "",
            output.text,
        ].join("\n");
    }
    catch (error) {
        const message = bundleErrorMessage(error);
        throw commandError(`Client bundle failed: ${message}`, "Fix client/index.tsx and save again.");
    }
}
function sporadesClientPlugin() {
    return {
        name: "sporades-client",
        setup(build) {
            build.onResolve({ filter: /^sporades\/client$/ }, () => ({
                path: "sporades/client",
                namespace: "sporades-runtime",
            }));
            build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({
                loader: "js",
                contents: createClientRuntimeSource(),
            }));
        },
    };
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
function bundleErrorMessage(error) {
    const details = errorDetails(error);
    const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
    if (isRecord(firstError) && typeof firstError.text === "string") {
        return firstError.text;
    }
    return typeof details.message === "string" ? details.message : "unknown error";
}
function commandError(message, hint) {
    const error = new Error(message);
    error.hint = hint;
    return error;
}
//# sourceMappingURL=bundle-pipeline.js.map