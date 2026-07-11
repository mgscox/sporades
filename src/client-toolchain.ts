import path from "node:path";
import { realpath } from "node:fs/promises";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

import { createClientRuntimeSource } from "./templates/client-runtime-template.js";

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
};

export async function buildClientToolchain(options: {
  projectDir: string;
  frameworkConfig: FrameworkBuildConfig;
  toolchain: ClientToolchainName;
  clientSource: string;
  clientSourcePath: string;
  indexHtml: string;
  indexHtmlPath: string;
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
  const frameworkLabel = options.frameworkConfig.framework === "preact" ? "Preact" : options.frameworkConfig.framework === "vue" ? "Vue" : "React";
  if (!new Set(["react", "preact", "vue"]).has(options.frameworkConfig.framework)) {
    throw clientToolchainError(
      `Unsupported client framework/toolchain combination: ${options.frameworkConfig.framework}/vite`,
      "Use React, Preact, or Vue with Vite, or keep Vanilla TypeScript on esbuild.",
    );
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
      diagnostics: { framework: options.frameworkConfig.framework, toolchain: "esbuild" as const, refresh: "none" as const },
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
}) {
  const { build } = await import("vite");
  const frameworkPlugins: VitePlugin[] = [];
  if (options.frameworkConfig.framework === "vue") {
    const { default: vue } = await import("@vitejs/plugin-vue");
    frameworkPlugins.push(vue());
  }
  let projectRoot = path.resolve(options.projectDir);
  try {
    projectRoot = await realpath(options.projectDir);
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
      plugins: [...frameworkPlugins, sporadesViteClientPlugin()],
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

function sporadesEsbuildClientPlugin(): EsbuildPlugin {
  return {
    name: "sporades-client",
    setup(build) {
      build.onResolve({ filter: /^sporades\/client$/ }, () => ({ path: "sporades/client", namespace: "sporades-runtime" }));
      build.onLoad({ filter: /^sporades\/client$/, namespace: "sporades-runtime" }, () => ({ loader: "js", contents: createClientRuntimeSource() }));
    },
  };
}

function sporadesViteClientPlugin(): VitePlugin {
  const runtimeId = "\0sporades:client-runtime";
  return {
    name: "sporades-client-runtime",
    enforce: "pre",
    resolveId(id) { return id === "sporades/client" ? runtimeId : null; },
    load(id) { return id === runtimeId ? createClientRuntimeSource() : null; },
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
    `Fix the ${framework === "preact" ? "Preact" : framework === "vue" ? "Vue" : "React"}/Vite client source and save again.`,
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
  for (const projectRoot of canonicalDiagnosticRoots(projectRoots)) {
    message = message.split(projectRoot).join("<project>");
  }
  return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function canonicalDiagnosticRoots(projectRoots: string[]) {
  return [...new Set(projectRoots.flatMap((projectRoot) => {
    const resolved = path.resolve(projectRoot);
    return [projectRoot, resolved];
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
