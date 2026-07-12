import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { buildClientToolchain, validateClientToolchainInput, type ClientToolchainName } from "./client-toolchain.js";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "./sealed-server-env.js";
import { serverRuntimeModuleSource } from "./server.js";
import { createServerBundleSource } from "./templates/server-bundle-template.js";
import { createPublicTree, discardPublicTree, releasePublicTreeLease, validateActivePublicTreeReference } from "./public-tree.js";

export type JsonRecord = Record<string, unknown>;
export type ServerEnv = Record<string, string>;
type HelperError = Error & { hint?: string; diagnostics?: unknown; phase?: string; framework?: string; toolchain?: string };
export type ServerEnvFile = { exists: boolean; raw: string };
export type ProjectConfig = JsonRecord & {
  auth?: AuthConfig;
  client?: { framework?: unknown; toolchain?: unknown };
};
export type AuthConfig = JsonRecord & {
  mode?: unknown;
  providers?: unknown;
  google?: unknown;
};
export type NormalizedProviderConfig = {
  enabled: boolean;
  clientIdEnv: string | null;
  clientSecretEnv: string | null;
};
export type NormalizedAuthConfig = {
  mode: string;
  providers: {
    anonymous: { enabled: boolean };
    google: NormalizedProviderConfig;
    email: { enabled: boolean };
  };
};
export type FrameworkBundleConfig = {
  framework: string;
  entry: string;
  loader: "ts" | "tsx";
  jsxImportSource: string | null;
  jsxRuntimeImport: string | null;
  jsxFactory?: string;
};

const FRAMEWORK_BUNDLE_CONFIG = {
  react: {
    framework: "react",
    entry: "index.tsx",
    loader: "tsx",
    jsxImportSource: "react",
    jsxRuntimeImport: "react/jsx-runtime",
  },
  preact: {
    framework: "preact",
    entry: "index.tsx",
    loader: "tsx",
    jsxImportSource: "preact",
    jsxRuntimeImport: "preact/jsx-runtime",
  },
  inferno: {
    framework: "inferno",
    entry: "index.tsx",
    loader: "tsx",
    jsxImportSource: null,
    jsxRuntimeImport: null,
    jsxFactory: "createElement",
  },
  solid: {
    framework: "solid",
    entry: "index.tsx",
    loader: "tsx",
    jsxImportSource: "solid-js",
    jsxRuntimeImport: "solid-js/jsx-runtime",
  },
  lit: {
    framework: "lit",
    entry: "index.ts",
    loader: "ts",
    jsxImportSource: null,
    jsxRuntimeImport: null,
  },
  vue: {
    framework: "vue",
    entry: "index.ts",
    loader: "ts",
    jsxImportSource: null,
    jsxRuntimeImport: null,
  },
  svelte: {
    framework: "svelte",
    entry: "index.ts",
    loader: "ts",
    jsxImportSource: null,
    jsxRuntimeImport: null,
  },
  vanilla: {
    framework: "vanilla",
    entry: "index.ts",
    loader: "ts",
    jsxImportSource: null,
    jsxRuntimeImport: null,
  },
} satisfies Record<string, FrameworkBundleConfig>;
const SUPPORTED_AUTH_PROVIDERS = new Set(["anonymous", "google", "email"]);

export async function createBundle(
  projectDir: string,
  config: ProjectConfig,
  options: {
    publishLegacy?: boolean;
    devClientRefresh?: boolean;
    activeReferenceFault?: (event: "before-active-write" | "after-active-write" | "before-active-restore" | "after-active-restore") => void;
  } = {},
) {
  const frameworkBundleConfig = readFrameworkBundleConfig(config.client?.framework ?? "react");
  const toolchain = readClientToolchain(config.client?.toolchain ?? (["lit", "solid", "vue", "svelte"].includes(frameworkBundleConfig.framework) ? "vite" : "esbuild"), frameworkBundleConfig.framework);
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
  } catch (error) {
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
    let previous: Array<{ target: string; contents: Buffer | null }>;
    const activeTreePath = path.join(buildDir, ".public-trees", "active.json");
    const candidateTreeName = path.basename(publicTree.root);
    let previousActiveTree: Buffer | null;
    try {
      previous = await Promise.all(legacyFiles.map(async (file) => ({
        target: file.target,
        contents: await readFile(file.target).catch((error) => {
          if (errorDetails(error).code === "ENOENT") return null;
          throw error;
        }),
      })));
      previousActiveTree = await readFile(activeTreePath).catch((error) => {
        if (errorDetails(error).code === "ENOENT") return null;
        throw error;
      });
      await publishLegacyBundles(buildDir, legacyFiles.filter((file): file is { target: string; contents: string } => file.contents !== null));
      await Promise.all(legacyFiles.filter((file) => file.contents === null).map((file) => rm(file.target, { force: true })));
      try {
        options.activeReferenceFault?.("before-active-write");
        await replaceBundleStateFile(activeTreePath, `${JSON.stringify({ tree: candidateTreeName })}\n`);
        options.activeReferenceFault?.("after-active-write");
      } catch (error) {
        const activeState = await inspectActiveTreeState(activeTreePath);
        const previousState = previousActiveTree === null
          ? { kind: "missing" as const }
          : await parseActiveTreeState(previousActiveTree.toString("utf8"), path.dirname(activeTreePath));
        if (!activeTreeStatesEqual(activeState, previousState)) throw activeReferenceRecoveryError(candidateTreeName, activeState.kind);
        await restoreLegacyBundleFiles(buildDir, previous);
        throw error;
      }
      legacyPublished = true;
    } catch (error) {
      throw tagBuildError(error, "publish", frameworkBundleConfig.framework, toolchain);
    }
    return async () => {
      try {
        options.activeReferenceFault?.("before-active-restore");
        if (previousActiveTree === null) await rm(activeTreePath, { force: true });
        else await replaceBundleStateFile(activeTreePath, previousActiveTree);
        options.activeReferenceFault?.("after-active-restore");
      } catch {
        const activeState = await inspectActiveTreeState(activeTreePath);
        const previousState = previousActiveTree === null
          ? { kind: "missing" as const }
          : await parseActiveTreeState(previousActiveTree.toString("utf8"), path.dirname(activeTreePath));
        if (!activeTreeStatesEqual(activeState, previousState)) throw activeReferenceRecoveryError(candidateTreeName, activeState.kind);
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
      } catch (error) {
        await rollback();
        throw error;
      }
    } catch (error) {
      if (candidateDiscardIsForbidden(error)) await releasePublicTreeLease(publicTree).catch(() => {});
      else await discardPublicTree(publicTree);
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

async function restoreLegacyBundleFiles(buildDir: string, previous: Array<{ target: string; contents: Buffer | null }>) {
  const existing = previous.filter((file): file is { target: string; contents: Buffer } => file.contents !== null);
  await publishLegacyBundles(buildDir, existing);
  await Promise.all(previous.filter((file) => file.contents === null).map((file) => rm(file.target, { force: true })));
}

async function inspectActiveTreeState(filePath: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "valid"; tree: string }> {
  try {
    return await parseActiveTreeState(await readFile(filePath, "utf8"), path.dirname(filePath));
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

async function parseActiveTreeState(raw: string, treesDir: string): Promise<{ kind: "invalid" } | { kind: "valid"; tree: string }> {
  try {
    return { kind: "valid", tree: await validateActivePublicTreeReference(treesDir, raw) };
  } catch {
    return { kind: "invalid" };
  }
}

function activeTreeStatesEqual(
  left: { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; tree: string },
  right: { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; tree: string },
) {
  if (left.kind === "missing" && right.kind === "missing") return true;
  return left.kind === "valid" && right.kind === "valid" && left.tree === right.tree;
}

function activeReferenceRecoveryError(candidateTree: string, activeState: string) {
  return commandError(
    "Active public tree recovery is incomplete.",
    "Preserved the candidate public tree and matching legacy Bundles for deterministic recovery.",
    { candidateDiscard: "forbidden", candidateTree, activeState },
  );
}

async function replaceBundleStateFile(filePath: string, contents: string | Uint8Array) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function publishLegacyBundles(
  buildDir: string,
  files: ReadonlyArray<{ target: string; contents: string | Uint8Array }>,
  options: { fault?: (event: "before-publish" | "before-restore", index: number) => void } = {},
) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = path.join(buildDir, `.legacy-staging-${nonce}`);
  const states: Array<{ target: string; candidate: string; backup: string; moved: boolean; published: boolean }> = [];
  let preserveStaging = false;
  await mkdir(stagingDir, { recursive: false });
  try {
    for (const [index, file] of files.entries()) {
      const stats = await lstat(file.target).catch((error) => {
        if (errorDetails(error).code === "ENOENT") return null;
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
        } catch (error) {
          if (errorDetails(error).code !== "ENOENT") throw error;
        }
      }
      for (const [index, state] of states.entries()) {
        options.fault?.("before-publish", index);
        await rename(state.candidate, state.target);
        state.published = true;
      }
    } catch (error) {
      const recoveryFailures: number[] = [];
      for (const [index, state] of [...states.entries()].reverse()) {
        try {
          options.fault?.("before-restore", index);
          if (state.moved) await rename(state.backup, state.target);
          else if (state.published) await rm(state.target, { force: true });
        } catch {
          recoveryFailures.push(index);
        }
      }
      if (recoveryFailures.length > 0) {
        preserveStaging = true;
        throw commandError(
          "Legacy Bundle recovery is incomplete.",
          `Preserved ${recoveryFailures.length} recovery backup${recoveryFailures.length === 1 ? "" : "s"} in ${path.basename(stagingDir)}.`,
          { failedFiles: recoveryFailures.length, recoveryDirectory: path.basename(stagingDir) },
        );
      }
      throw error;
    }
  } finally {
    if (!preserveStaging) await rm(stagingDir, { recursive: true, force: true });
  }
}

async function readRequiredSealedPrivateKey(paths: { root: string; envelope: string; privateKey: string; publicKey: string; hosts: string; }) {
  const keyPair = await readKeyPair(paths);
  if (!keyPair) {
    throw commandError(
      "Sealed Server env private key is missing.",
      "Restore .sporades/sealed-server-env/server-env.private.pem or re-import the Server env values.",
    );
  }
  return keyPair;
}

export async function bundleServerCapsuleModule(options: { serverSource: string; serverSourcePath: string }) {
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
  } catch (error) {
    const message = bundleErrorMessage(error);
    throw commandError(`Server bundle failed: ${message}`, "Fix server/index.ts and save again.");
  }
}

export async function readServerEnvFile(envPath: PathLike | FileHandle): Promise<ServerEnvFile> {
  try {
    const raw = await readFile(envPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw commandError("Invalid server env file.", ".env.sporades.server must be 64KB or smaller.");
    }
    return { exists: true, raw };
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      return { exists: false, raw: "" };
    }
    throw error;
  }
}

export function parseServerEnv(envFile: ServerEnvFile): ServerEnv {
  const values: ServerEnv = {};
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

function parseEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function authStatus(config: ProjectConfig, serverEnv: ServerEnv) {
  const authConfig = config.auth ?? { mode: "anonymous" };
  const normalized = normalizeAuthConfig(authConfig);
  const clientIdEnv = normalized.providers.google.clientIdEnv;
  const clientSecretEnv = normalized.providers.google.clientSecretEnv;
  const providers: {
    anonymous: { enabled: boolean };
    google: { enabled: boolean; configured: boolean; clientIdEnv: string | null; clientSecretEnv: string | null };
    email?: { enabled: boolean };
  } = {
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

function normalizeAuthConfig(authConfig: AuthConfig): NormalizedAuthConfig {
  const providerConfig = isRecord(authConfig.providers) ? authConfig.providers : {};
  for (const provider of Object.keys(providerConfig)) {
    if (!SUPPORTED_AUTH_PROVIDERS.has(provider)) {
      throw commandError(
        `Unsupported auth provider: ${provider}`,
        "Use supported auth providers: anonymous, google, email.",
      );
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

function readProviderConfig(config: unknown): NormalizedProviderConfig {
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

function validateAuthConfig(config: ProjectConfig, serverEnv: ServerEnv) {
  const status = authStatus(config, serverEnv);
  if (!status.providers.google.enabled) {
    return;
  }
  if (!status.google.configured) {
    throw commandError(
      "Google OAuth is not fully configured.",
      "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
    );
  }
}

async function readRequiredFile(filePath: PathLike | FileHandle, message: string, hint: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") {
      throw commandError(message, hint);
    }
    throw error;
  }
}

function readFrameworkBundleConfig(framework: unknown): FrameworkBundleConfig {
  if (typeof framework !== "string" || !(framework in FRAMEWORK_BUNDLE_CONFIG)) {
    throw commandError(`Unsupported framework: ${framework}`, "Use one of: react, preact, inferno, lit, solid, vue, svelte, vanilla.");
  }
  return FRAMEWORK_BUNDLE_CONFIG[framework as keyof typeof FRAMEWORK_BUNDLE_CONFIG];
}

function readClientToolchain(toolchain: unknown, framework: string): ClientToolchainName {
  if (toolchain !== "esbuild" && toolchain !== "vite") {
    throw commandError(`Unsupported client toolchain: ${toolchain}`, "Use one of: esbuild, vite.");
  }
  if (toolchain === "vite" && framework === "vanilla") {
    throw commandError(
      `Unsupported client framework/toolchain combination: ${framework}/vite`,
      "Use React or Preact with Vite, or keep Vanilla TypeScript on esbuild.",
    );
  }
  if (framework === "vue" && toolchain !== "vite") {
    throw commandError("Unsupported client framework/toolchain combination: vue/esbuild", "Use Vue with Vite.");
  }
  if (framework === "svelte" && toolchain !== "vite") {
    throw commandError("Unsupported client framework/toolchain combination: svelte/esbuild", "Use Svelte with Vite.");
  }
  if (framework === "solid" && toolchain !== "vite") {
    throw commandError("Unsupported client framework/toolchain combination: solid/esbuild", "Use SolidJS with Vite.");
  }
  if (framework === "lit" && toolchain !== "vite") {
    throw commandError("Unsupported client framework/toolchain combination: lit/esbuild", "Use Lit with Vite.");
  }
  if (framework === "inferno" && toolchain !== "esbuild") {
    throw commandError("Unsupported client framework/toolchain combination: inferno/vite", "Use Inferno with esbuild.");
  }
  return toolchain;
}

function sporadesServerPlugin(): import("esbuild").Plugin {
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorDetails(error: unknown): JsonRecord {
  if (error === null || error === undefined) {
    return {};
  }
  return typeof error === "object" ? (error as JsonRecord) : { message: String(error) };
}

function candidateDiscardIsForbidden(error: unknown) {
  const diagnostics = errorDetails(error).diagnostics;
  return isRecord(diagnostics) && diagnostics.candidateDiscard === "forbidden";
}

function bundleErrorMessage(error: unknown): string {
  const details = errorDetails(error);
  const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
  if (isRecord(firstError) && typeof firstError.text === "string") {
    return firstError.text;
  }
  return typeof details.message === "string" ? details.message : "unknown error";
}

function commandError(message: string, hint: string, diagnostics?: unknown): HelperError {
  const error: HelperError = new Error(message);
  error.hint = hint;
  if (diagnostics !== undefined) error.diagnostics = diagnostics;
  return error;
}

function tagBuildError(error: unknown, phase: string, framework: string, toolchain: ClientToolchainName) {
  const tagged = error instanceof Error ? error as HelperError : commandError(String(error), "Fix the build error and save again.");
  tagged.phase = phase;
  tagged.framework = framework;
  tagged.toolchain = toolchain;
  return tagged;
}
