import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

import { createClientRuntimeSource } from "./templates/client-runtime-template.js";
import { clientCapabilityError, clientFrameworkCapability, supportsClientCapability } from "./client-capabilities.js";

export type ClientToolchainName = "esbuild" | "vite";
export type ClientToolchainDiagnostics = {
  framework: string;
  toolchain: ClientToolchainName;
  refresh: "none" | "full-page";
};
export type NormalizedClientFile = { path: string; contents: string | Uint8Array };
export type ClientToolchainOutput = {
  publicFiles: NormalizedClientFile[];
  legacyClientBundle: string | null;
  diagnostics: ClientToolchainDiagnostics;
};

type FrameworkBuildConfig = {
  framework: string;
  entry: string;
  loader: "ts" | "tsx";
  jsxImportSource: string | null;
  jsxRuntimeImport: string | null;
  jsxFactory?: string;
};

export async function buildClientToolchain(options: {
  projectDir: string;
  frameworkConfig: FrameworkBuildConfig;
  toolchain: ClientToolchainName;
  clientSource: string;
  clientSourcePath: string;
  indexHtml: string;
  indexHtmlPath: string;
  devRefresh?: boolean;
}): Promise<ClientToolchainOutput> {
  validateClientToolchainInput(options);
  if (options.toolchain === "vite") return buildVite(options);
  return buildEsbuild(options);
}

export function validateClientToolchainInput(options: {
  frameworkConfig: FrameworkBuildConfig;
  toolchain: ClientToolchainName;
  indexHtml: string;
}) {
  if (options.toolchain !== "vite") return;
  const frameworkLabel = clientFrameworkCapability(options.frameworkConfig.framework)?.label ?? String(options.frameworkConfig.framework);
  if (!supportsClientCapability(options.frameworkConfig.framework, options.toolchain)) {
    const details = clientCapabilityError(options.frameworkConfig.framework, options.toolchain);
    throw clientToolchainError(details.message, details.hint);
  }
  if (referencesLegacyClientShell(options.indexHtml)) {
    throw clientToolchainError(
      `${frameworkLabel}/Vite requires an author-owned source entry in index.html.`,
      `Replace the \`/client.js\` script with \`<script type="module" src="/client/${options.frameworkConfig.entry}"></script>\`, then retry.`,
    );
  }
  if (!referencesFrameworkSourceEntry(options.indexHtml, options.frameworkConfig.entry)) {
    throw clientToolchainError(
      `${frameworkLabel}/Vite could not find the client source entry in index.html.`,
      `Add \`<script type="module" src="/client/${options.frameworkConfig.entry}"></script>\` to the author-owned HTML shell.`,
    );
  }
}

async function buildEsbuild(options: {
  frameworkConfig: FrameworkBuildConfig;
  clientSource: string;
  clientSourcePath: string;
  indexHtml: string;
  devRefresh?: boolean;
}) {
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
      jsx: options.frameworkConfig.framework === "inferno" ? "transform" : "automatic",
      ...(options.frameworkConfig.jsxFactory ? { jsxFactory: options.frameworkConfig.jsxFactory } : {}),
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
    if (!clientOutput) throw clientToolchainError("Client bundle failed: esbuild returned no output.", `Fix client/${options.frameworkConfig.entry} and save again.`);
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
      diagnostics: { framework: options.frameworkConfig.framework, toolchain: "esbuild" as const, refresh: options.devRefresh ? "full-page" as const : "none" as const },
      publicFiles: [
        { path: "index.html", contents: options.indexHtml },
        ...outputs.map((output) => {
          const emittedPath = path.relative(outputDir, output.path).split(path.sep).join("/");
          const relativePath = emittedPath === "client.css" || emittedPath === "client.css.map" ? `assets/${emittedPath}` : emittedPath;
          return { path: relativePath, contents: relativePath === "client.js" ? clientBundle : output.contents };
        }),
      ],
    };
  } catch (error) {
    if (hasHint(error)) throw error;
    throw clientToolchainError(`Client bundle failed: ${boundedBuildMessage(error)}`, `Fix client/${options.frameworkConfig.entry} and save again.`);
  }
}

async function buildVite(options: {
  projectDir: string;
  frameworkConfig: FrameworkBuildConfig;
  indexHtml: string;
  indexHtmlPath: string;
  devRefresh?: boolean;
}) {
  const { build } = await import("vite");
  const frameworkPlugins: VitePlugin[] = [];
  let projectRoot = path.resolve(options.projectDir);
  try {
    projectRoot = await realpath(options.projectDir);
    const canonicalIndexHtmlPath = path.join(projectRoot, path.basename(options.indexHtmlPath));
    const projectConfigFile = await findProjectViteConfig(projectRoot);
    if (options.frameworkConfig.framework === "vue") {
      const { plugin, compiler } = await loadProjectVueToolchain(projectRoot);
      frameworkPlugins.push(plugin({ compiler }));
    } else if (options.frameworkConfig.framework === "svelte") {
      const { plugin } = await loadProjectSvelteToolchain(projectRoot);
      frameworkPlugins.push(plugin());
    } else if (options.frameworkConfig.framework === "solid") {
      const { plugin } = await loadProjectSolidToolchain(projectRoot);
      frameworkPlugins.push(plugin());
    } else if (options.frameworkConfig.framework === "inferno") {
      frameworkPlugins.push(await loadProjectInfernoToolchain(projectRoot));
    }
    const result = await build({
      root: projectRoot,
      base: "/",
      publicDir: false,
      configFile: projectConfigFile,
      envFile: false,
      envPrefix: "\0",
      mode: "production",
      define: {
        "import.meta.env": JSON.stringify({ BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false }),
      },
      appType: "mpa",
      clearScreen: false,
      logLevel: "silent",
      esbuild: options.frameworkConfig.framework === "inferno"
        ? { jsx: "transform", jsxFactory: "createElement" }
        : { jsx: "automatic", jsxImportSource: options.frameworkConfig.jsxImportSource ?? undefined },
      css: { postcss: { plugins: [] } },
      plugins: [
        ...frameworkPlugins,
        sporadesViteClientPlugin(options.devRefresh === true),
        sporadesViteBuildInvariants(canonicalIndexHtmlPath, options.frameworkConfig),
      ],
      build: {
        write: false,
        emptyOutDir: false,
        sourcemap: true,
        cssCodeSplit: true,
        assetsInlineLimit: 0,
        watch: null,
        lib: false,
        ssr: false,
        manifest: false,
        ssrManifest: false,
        rollupOptions: {
          input: canonicalIndexHtmlPath,
          external: [],
          output: {
            entryFileNames: "assets/[name]-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const files = new Map<string, string | Uint8Array>();
    for (const output of outputs) {
      if (!("output" in output)) throw new Error("Vite unexpectedly entered watch mode.");
      for (const item of output.output) {
        const relativePath = normalizeOutputPath(item.fileName);
        files.set(relativePath, item.type === "asset" ? item.source : item.code);
        if (item.type === "chunk" && item.map) {
          const mapPath = `${relativePath}.map`;
          if (!files.has(mapPath)) files.set(mapPath, item.map.toString());
        }
      }
    }
    if (!files.has("index.html")) throw new Error("Vite returned no transformed index.html output.");
    return {
      publicFiles: [...files].map(([filePath, contents]) => ({ path: filePath, contents })),
      legacyClientBundle: null,
      diagnostics: { framework: options.frameworkConfig.framework, toolchain: "vite" as const, refresh: "full-page" as const },
    };
  } catch (error) {
    if (hasHint(error)) throw error;
    throw viteBuildError(error, [options.projectDir, projectRoot], options.frameworkConfig.framework);
  }
}

const VITE_CONFIG_NAMES = [
  "vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts",
];

async function findProjectViteConfig(projectRoot: string) {
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = path.join(projectRoot, name);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw clientToolchainError(
          `Vite configuration must be a regular file inside the Capsule: ${name}.`,
          `Replace ${name} with a regular project-owned file, then retry.`,
        );
      }
      const canonical = await realpath(candidate);
      if (!isCanonicalDescendant(projectRoot, canonical)) {
        throw clientToolchainError(
          `Vite configuration escaped the Capsule project: ${name}.`,
          `Move ${name} inside the Capsule project, then retry.`,
        );
      }
      return canonical;
    } catch (error) {
      if (errorDetails(error).code === "ENOENT") continue;
      throw error;
    }
  }
  return false as const;
}

async function loadProjectVueToolchain(projectRoot: string) {
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
  if (typeof plugin !== "function" || typeof compiler?.parse !== "function") throw projectToolchainError("Vue", "Vue/Vite project compiler packages have incompatible exports.", "Run `npm install` in the Vue Capsule to install its declared @vitejs/plugin-vue and @vue/compiler-sfc versions.");
  return { plugin, compiler };
}

async function loadProjectSvelteToolchain(projectRoot: string) {
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
  if (typeof plugin !== "function" || typeof compiler?.compile !== "function") throw projectToolchainError("Svelte", "Svelte/Vite project compiler packages have incompatible exports.", hint);
  return { plugin, compiler };
}

async function loadProjectSolidToolchain(projectRoot: string) {
  const hint = "Run `npm install` in the SolidJS Capsule to install its declared vite-plugin-solid and solid-js versions.";
  const loaded = await loadProjectCompilerToolchain(projectRoot, {
    framework: "SolidJS",
    requiredPackages: [
      { declaration: "vite-plugin-solid", resolve: "vite-plugin-solid", major: 2 },
      { declaration: "solid-js", resolve: "solid-js", major: 1 },
    ],
    installHint: hint,
  });
  const pluginModule = loaded.get("vite-plugin-solid");
  const solidModule = loaded.get("solid-js");
  const plugin = pluginModule?.default?.default ?? pluginModule?.default ?? pluginModule;
  if (typeof plugin !== "function" || typeof solidModule?.createSignal !== "function") {
    throw projectToolchainError("SolidJS", "SolidJS/Vite project compiler packages have incompatible exports.", hint);
  }
  return { plugin };
}

async function loadProjectInfernoToolchain(projectRoot: string): Promise<VitePlugin> {
  const hint = "Run `npm install` in the Inferno Capsule to install its declared inferno and inferno-create-element versions.";
  const loaded = await loadProjectCompilerToolchain(projectRoot, {
    framework: "Inferno",
    requiredPackages: [
      { declaration: "inferno", resolve: "inferno", major: 9 },
      { declaration: "inferno-create-element", resolve: "inferno-create-element", major: 9 },
    ],
    installHint: hint,
  });
  const inferno = loaded.get("inferno");
  const elements = loaded.get("inferno-create-element");
  if (typeof inferno?.render !== "function" || typeof elements?.createElement !== "function") {
    throw projectToolchainError("Inferno", "Inferno/Vite project compiler packages have incompatible exports.", hint);
  }
  return { name: "sporades-inferno-project-jsx", enforce: "pre" };
}

async function loadProjectCompilerToolchain(projectRoot: string, spec: {
  framework: string;
  requiredPackages: Array<{ declaration: string; resolve: string; major: number }>;
  installHint: string;
}) {
  let projectManifest: Record<string, any>;
  try {
    projectManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    throw projectToolchainError(spec.framework, `${spec.framework}/Vite could not read the Capsule package.json.`, spec.installHint);
  }
  const declared = { ...(projectManifest.dependencies ?? {}), ...(projectManifest.devDependencies ?? {}) };
  const nodeModulesDir = path.join(projectRoot, "node_modules");
  let canonicalNodeModules: string;
  try {
    const nodeModulesMetadata = await lstat(nodeModulesDir);
    if (!nodeModulesMetadata.isDirectory() || nodeModulesMetadata.isSymbolicLink()) throw new Error("node_modules is not a real directory");
    canonicalNodeModules = await realpath(nodeModulesDir);
    if (!isCanonicalDescendant(projectRoot, canonicalNodeModules)) throw new Error("node_modules escaped the project root");
  } catch {
    throw projectToolchainError(spec.framework, `${spec.framework}/Vite requires node_modules to be a real directory contained by the Capsule project.`, spec.installHint);
  }
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const resolvedPackages = new Map<string, string>();
  for (const required of spec.requiredPackages) {
    if (typeof declared[required.declaration] !== "string") {
      throw projectToolchainError(spec.framework, `${spec.framework}/Vite requires the Capsule to declare ${required.declaration}.`, spec.installHint);
    }
    const packageDir = path.join(projectRoot, "node_modules", ...required.declaration.split("/"));
    let installedManifest: Record<string, any>;
    let resolved: string;
    try {
      installedManifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
      try {
        resolved = projectRequire.resolve(required.resolve);
      } catch {
        const subpath = required.resolve === required.declaration ? "." : `.${required.resolve.slice(required.declaration.length)}`;
        const exported = installedManifest.exports?.[subpath];
        const importTarget = typeof exported === "string" ? exported : typeof exported?.import === "string" ? exported.import : exported?.import?.default;
        if (typeof importTarget !== "string") throw new Error("package has no import export");
        resolved = path.resolve(packageDir, importTarget);
      }
      const canonicalPackageDir = await realpath(packageDir);
      if (!isCanonicalDescendant(canonicalNodeModules, canonicalPackageDir)) throw new Error("package directory escaped project node_modules");
      const canonicalResolved = await realpath(resolved);
      if (!isCanonicalDescendant(canonicalPackageDir, canonicalResolved)) throw new Error("package entry escaped its project-owned package root");
      resolved = canonicalResolved;
    } catch {
      throw projectToolchainError(spec.framework, `${spec.framework}/Vite could not resolve project-owned ${required.declaration}.`, spec.installHint);
    }
    const installedMajor = Number.parseInt(String(installedManifest.version).split(".")[0] ?? "", 10);
    if (installedMajor !== required.major) {
      throw projectToolchainError(
        spec.framework, `${spec.framework}/Vite does not support the installed ${required.declaration} version.`, spec.installHint,
        { package: required.declaration, installedVersion: String(installedManifest.version).slice(0, 40), supportedMajor: required.major },
      );
    }
    resolvedPackages.set(required.resolve, resolved);
  }
  const loaded = new Map<string, any>();
  for (const [packageName, resolved] of resolvedPackages) {
    try {
      loaded.set(packageName, await import(pathToFileURL(resolved).href));
    } catch (error) {
      throw projectToolchainError(
        spec.framework, `${spec.framework}/Vite could not load project-owned ${packageName}: ${boundedBuildMessage(error, [projectRoot])}`, spec.installHint,
        { package: packageName },
      );
    }
  }
  return loaded;
}

function isCanonicalDescendant(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function projectToolchainError(_framework: string, message: string, hint: string, diagnostics?: unknown) {
  return clientToolchainError(message, hint, diagnostics);
}

function sporadesEsbuildClientPlugin(devRefresh = false): EsbuildPlugin {
  return {
    name: "sporades-client",
    setup(build) {
      build.onResolve({ filter: /^sporades\/server(?:\/|$)/ }, (args) => {
        throw serverOnlyClientImportError(args.path);
      });
      build.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: "sporades/client", namespace: "sporades-runtime" }));
      build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({ loader: "js", contents: createClientRuntimeSource({ devRefresh }) }));
    },
  };
}

function sporadesViteClientPlugin(devRefresh = false): VitePlugin {
  const runtimeId = "\0sporades:client-runtime";
  return {
    name: "sporades-client-runtime",
    enforce: "pre",
    resolveId(id) {
      if (/^sporades\/server(?:\/|$)/.test(id)) throw serverOnlyClientImportError(id);
      return id === "sporades/client" ? runtimeId : null;
    },
    load(id) { return id === runtimeId ? createClientRuntimeSource({ devRefresh }) : null; },
  };
}

function serverOnlyClientImportError(specifier: string) {
  return clientToolchainError(
    "Client code cannot import server-only Sporades modules.",
    "Move this import into server/ and expose only bounded application data through a query or mutation.",
    { specifier },
  );
}

function sporadesViteBuildInvariants(
  indexHtmlPath: string,
  frameworkConfig: FrameworkBuildConfig,
): VitePlugin {
  return {
    name: "sporades-build-invariants",
    enforce: "post",
    config() {
      return {
        root: path.dirname(indexHtmlPath),
        base: "/",
        publicDir: false,
        envFile: false,
        envPrefix: "\0",
        mode: "production",
        define: {
          "import.meta.env": JSON.stringify({ BASE_URL: "/", MODE: "production", DEV: false, PROD: true, SSR: false }),
        },
        appType: "mpa",
        clearScreen: false,
        logLevel: "silent",
        esbuild: frameworkConfig.framework === "inferno"
          ? { jsx: "transform", jsxFactory: "createElement" }
          : { jsx: "automatic", jsxImportSource: frameworkConfig.jsxImportSource ?? undefined },
        css: { postcss: { plugins: [] } },
        build: {
          write: false,
          emptyOutDir: false,
          sourcemap: true,
          cssCodeSplit: true,
          assetsInlineLimit: 0,
          watch: null,
          lib: false,
          ssr: false,
          manifest: false,
          ssrManifest: false,
          rollupOptions: {
            input: indexHtmlPath,
            external: [],
            output: {
              entryFileNames: "assets/[name]-[hash].js",
              chunkFileNames: "assets/[name]-[hash].js",
              assetFileNames: "assets/[name]-[hash][extname]",
            },
          },
        },
      };
    },
    configResolved(config) {
      const pluginNames = new Set(config.plugins.map((plugin) => plugin.name));
      if (!pluginNames.has("sporades-client-runtime") || !pluginNames.has("sporades-build-invariants")) {
        throw new Error("Sporades mandatory Vite plugins were not preserved.");
      }
      const requiredFrameworkPlugin = {
        vue: "vite:vue",
        svelte: "vite-plugin-svelte",
        solid: "solid",
        inferno: "sporades-inferno-project-jsx",
      }[frameworkConfig.framework];
      if (requiredFrameworkPlugin && !pluginNames.has(requiredFrameworkPlugin)) {
        throw new Error(`Sporades mandatory ${frameworkConfig.framework} Vite plugin was not preserved.`);
      }
    },
  };
}

function referencesLegacyClientShell(html: string) {
  return /<script\b[^>]*\bsrc\s*=\s*["']\/?client\.js(?:\?[^"']*)?["'][^>]*>/i.test(html);
}

function referencesFrameworkSourceEntry(html: string, entry: string) {
  const escapedEntry = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']\\/?client/${escapedEntry}(?:\\?[^"']*)?["'][^>]*>`, "i").test(html);
}

function normalizeOutputPath(fileName: string) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Vite emitted an unsafe public path.");
  return normalized;
}

function viteBuildError(error: unknown, projectRoots: string[], framework: string) {
  const details = errorDetails(error);
  const message = boundedBuildMessage(error, projectRoots);
  const loc = errorDetails(details.loc);
  const rawFile = typeof loc.file === "string" ? loc.file : typeof details.id === "string" ? details.id : null;
  const relativeFile = rawFile ? safeRelativeDiagnosticPath(projectRoots, rawFile) : null;
  return clientToolchainError(
    `Client bundle failed: ${message}`,
    `Fix the ${clientFrameworkCapability(framework)?.label ?? framework}/Vite client source and save again.`,
    {
      ...(typeof details.code === "string" ? { code: details.code.slice(0, 80) } : {}),
      ...(relativeFile ? { file: relativeFile } : {}),
      ...(Number.isInteger(loc.line) ? { line: loc.line } : {}),
      ...(Number.isInteger(loc.column) ? { column: loc.column } : {}),
    },
  );
}

function safeRelativeDiagnosticPath(projectRoots: string[], fileName: string) {
  for (const projectRoot of canonicalDiagnosticRoots(projectRoots)) {
    const relative = path.relative(projectRoot, fileName).split(path.sep).join("/");
    if (relative && !relative.startsWith("../") && relative !== "..") return relative.slice(0, 240);
  }
  return path.basename(fileName).slice(0, 120);
}

function boundedBuildMessage(error: unknown, projectRoots: string[] = []) {
  const details = errorDetails(error);
  const firstError = Array.isArray(details.errors) ? details.errors[0] : null;
  let message = typeof errorDetails(firstError).text === "string"
    ? String(errorDetails(firstError).text)
    : typeof details.message === "string" ? details.message : "unknown error";
  message = redactBuildProjectRoots(message, projectRoots);
  return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function redactBuildProjectRoots(message: string, projectRoots: string[]) {
  const absoluteRoots = new Set<string>();
  const relativeRoots = new Set<string>();
  for (const projectRoot of projectRoots) {
    const resolved = path.resolve(projectRoot);
    for (const root of [resolved, path.isAbsolute(projectRoot) ? projectRoot : ""]) {
      if (!root) continue;
      for (const normalizedRoot of diagnosticNormalizationForms(root)) {
        absoluteRoots.add(normalizedRoot);
        absoluteRoots.add(normalizedRoot.replaceAll("\\", "/"));
        absoluteRoots.add(normalizedRoot.replaceAll("/", "\\"));
      }
    }
    const relative = path.relative(process.cwd(), resolved);
    if (!relative || relative === ".") continue;
    for (const normalizedRoot of diagnosticNormalizationForms(relative)) {
      for (const root of [normalizedRoot, normalizedRoot.replaceAll("\\", "/"), normalizedRoot.replaceAll("/", "\\")]) {
        relativeRoots.add(root);
        relativeRoots.add(`./${root}`);
        relativeRoots.add(`.\\${root}`);
      }
    }
  }
  let redacted = message;
  for (const root of [...absoluteRoots].filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(root).join("<project>");
  }
  for (const root of [...relativeRoots].filter(Boolean).sort((left, right) => right.length - left.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}\\p{Pc}.\\/\\\\-])${escaped}(?=[/\\\\])`, "gu"), "$1<project>");
  }
  return redacted;
}

function diagnosticNormalizationForms(value: string) {
  return [...new Set([value, value.normalize("NFC"), value.normalize("NFD")])];
}

function canonicalDiagnosticRoots(projectRoots: string[]) {
  return [...new Set(projectRoots.flatMap((projectRoot) => {
    const resolved = path.resolve(projectRoot);
    const relative = path.relative(process.cwd(), resolved);
    return [projectRoot, resolved, relative, relative.split(path.sep).join("/")];
  }).filter(Boolean))].sort((left, right) => right.length - left.length);
}

function clientToolchainError(message: string, hint: string, diagnostics?: unknown) {
  const error = new Error(message) as Error & { hint?: string; diagnostics?: unknown };
  error.hint = hint;
  if (diagnostics && Object.keys(diagnostics as object).length > 0) error.diagnostics = diagnostics;
  return error;
}

function errorDetails(error: unknown): Record<string, any> {
  return error && typeof error === "object" ? error as Record<string, any> : { message: String(error) };
}

function hasHint(error: unknown): error is Error & { hint: string } {
  return Boolean(error && typeof error === "object" && typeof (error as { hint?: unknown }).hint === "string");
}
