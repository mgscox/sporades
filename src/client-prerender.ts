import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ClientToolchainName } from "./client-capabilities.js";
import { redactBuildProjectRoots } from "./build-diagnostics.js";

export type ClientPrerenderFragment = Readonly<{
  name: string;
  module: string;
}>;

export function readClientPrerenderConfig(value: unknown, toolchain: ClientToolchainName): ClientPrerenderFragment[] {
  if (value === undefined) return [];
  const hint = "Set `client.prerender` to an ordered array of unique `{ name, module }` entries for a Vite client.";
  if (!Array.isArray(value)) throw prerenderError("Invalid client prerender configuration.", hint);
  if (toolchain !== "vite") {
    throw prerenderError(
      "Client prerender fragments require the Vite client toolchain.",
      "Set `client.toolchain` to `vite`, or remove `client.prerender` from sporades.json.",
    );
  }
  const names = new Set<string>();
  const fragments = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw prerenderError(`Invalid client prerender entry at index ${index}.`, hint);
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "name" && key !== "module")) {
      throw prerenderError(`Invalid client prerender entry at index ${index}.`, hint);
    }
    if (typeof record.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(record.name)) {
      throw prerenderError(
        `Invalid client prerender name at index ${index}.`,
        "Use a unique 1-64 character name beginning with a letter and containing only letters, digits, `_`, or `-`.",
      );
    }
    if (names.has(record.name)) {
      throw prerenderError(`Duplicate client prerender name: ${record.name}.`, "Give every `client.prerender` entry a unique name.");
    }
    names.add(record.name);
    if (typeof record.module !== "string" || !isProjectRelativeModulePath(record.module)) {
      throw prerenderError(
        `Invalid client prerender module for ${record.name}.`,
        "Use a non-empty project-relative module path without absolute, parent, dot, or backslash segments.",
      );
    }
    return { name: record.name, module: record.module };
  });
  if (fragments.length > 1) {
    throw prerenderError(
      "This Sporades version supports one configured prerender fragment.",
      "Configure one `client.prerender` entry. Ordered multi-fragment builds are not available yet.",
    );
  }
  return fragments;
}

export async function renderClientPrerenderFragment(
  projectRoot: string,
  fragment: ClientPrerenderFragment,
  projectRoots: string[] = [projectRoot],
): Promise<string> {
  const modulePath = path.resolve(projectRoot, ...fragment.module.split("/"));
  let canonicalModulePath: string;
  try {
    const metadata = await lstat(modulePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular project file");
    canonicalModulePath = await realpath(modulePath);
    if (!isCanonicalDescendant(projectRoot, canonicalModulePath)) throw new Error("escaped the Capsule project");
  } catch (error) {
    throw prerenderError(
      `Could not load client prerender module for ${fragment.name}.`,
      `Restore the regular project-owned module at ${fragment.module}, then retry.`,
      { fragment: fragment.name, module: fragment.module },
    );
  }

  let bundledSource: string;
  try {
    const { build, transform } = await import("esbuild");
    const result = await build({
      absWorkingDir: projectRoot,
      bundle: true,
      entryNames: "renderer",
      entryPoints: { renderer: canonicalModulePath },
      format: "cjs",
      logLevel: "silent",
      outdir: path.join(projectRoot, ".sporades-prerender-output"),
      platform: "node",
      plugins: [preserveRendererImportMetaUrl(transform)],
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
  } catch (error) {
    throw prerenderError(
      `Could not build client prerender module for ${fragment.name}: ${boundedMessage(error, projectRoots)}`,
      `Fix ${fragment.module}, then retry.`,
      { fragment: fragment.name, module: fragment.module },
    );
  }

  let renderer: unknown;
  try {
    renderer = executeBundledRenderer(bundledSource, canonicalModulePath, fragment.module);
  } catch (error) {
    throw prerenderError(
      `Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, projectRoots)}`,
      `Fix the renderer in ${fragment.module}, then retry.`,
      { fragment: fragment.name, module: fragment.module },
    );
  }
  if (typeof renderer !== "function") {
    throw prerenderError(
      `Client prerender module for ${fragment.name} must default-export a zero-argument renderer.`,
      `Default-export a function from ${fragment.module} that returns an HTML string or Promise<string>.`,
    );
  }

  let rendered: unknown;
  try {
    rendered = await renderer();
  } catch (error) {
    throw prerenderError(
      `Client prerender renderer for ${fragment.name} failed: ${boundedMessage(error, projectRoots)}`,
      `Fix the renderer in ${fragment.module}, then retry.`,
      { fragment: fragment.name, module: fragment.module },
    );
  }
  if (typeof rendered !== "string") {
    throw prerenderError(
      `Client prerender renderer for ${fragment.name} returned a non-string result.`,
      `Return an HTML string or Promise<string> from ${fragment.module}.`,
      { fragment: fragment.name, resultType: rendered === null ? "null" : typeof rendered },
    );
  }
  return rendered;
}

function preserveRendererImportMetaUrl(transform: typeof import("esbuild").transform): import("esbuild").Plugin {
  const loaders = new Map<string, import("esbuild").Loader>([
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
        if (!contents.includes("import.meta.url")) return undefined;
        const loader = loaders.get(path.extname(args.path));
        if (!loader) return undefined;
        const result = await transform(contents, {
          define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) },
          jsx: "preserve",
          loader,
          sourcefile: args.path,
          target: "node22",
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

export function placeClientPrerenderFragment(html: string, fragment: ClientPrerenderFragment, rendered: string): string {
  const bounded = `<!-- sporades:prerender-boundary-start ${fragment.name} -->${rendered}<!-- sporades:prerender-boundary-end ${fragment.name} -->`;
  const placement = scanClientPrerenderHtml(html);
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
  if (placement.markers.length > 0) return html;
  if (placement.bodyEnd === undefined) {
    throw prerenderError(
      "Client prerender fallback placement requires an opening body element.",
      "Add an opening `<body>` element or a named `<!-- sporades:prerender NAME -->` marker to index.html.",
      { fragment: fragment.name },
    );
  }
  return `${html.slice(0, placement.bodyEnd)}${bounded}${html.slice(placement.bodyEnd)}`;
}

function scanClientPrerenderHtml(html: string) {
  const lowerHtml = foldAsciiCase(html);
  const rawTextElements = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);
  const markers: Array<{ start: number; end: number; name?: string }> = [];
  let bodyEnd: number | undefined;
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) break;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd !== -1) {
        const marker = /^\s*sporades:prerender(?:\s+([A-Za-z][A-Za-z0-9_-]{0,63}))?\s*$/.exec(html.slice(tagStart + 4, commentEnd));
        if (marker) markers.push({ start: tagStart, end: commentEnd + 3, name: marker[1] });
      }
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = html.indexOf("]]>", tagStart + 9);
      cursor = cdataEnd === -1 ? html.length : cdataEnd + 3;
      continue;
    }

    let nameStart = tagStart + 1;
    const closing = html[nameStart] === "/";
    if (closing) nameStart += 1;
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      const declarationEnd = findHtmlTagEnd(html, nameStart);
      cursor = declarationEnd === undefined ? tagStart + 1 : declarationEnd;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? "")) nameEnd += 1;
    const name = lowerHtml.slice(nameStart, nameEnd);
    const tagEnd = findHtmlTagEnd(html, nameEnd);
    if (tagEnd === undefined) break;
    if (!closing && name === "body" && bodyEnd === undefined) bodyEnd = tagEnd;
    cursor = tagEnd;

    if (!closing && rawTextElements.has(name)) {
      if (name === "plaintext") break;
      cursor = findRawTextElementEnd(html, lowerHtml, cursor, name);
    }
  }
  return { bodyEnd, markers };
}

function foldAsciiCase(value: string) {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function findHtmlTagEnd(html: string, cursor: number): number | undefined {
  let quote: "\"" | "'" | undefined;
  for (let index = cursor; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return undefined;
}

function findRawTextElementEnd(html: string, lowerHtml: string, cursor: number, name: string): number {
  const closingPrefix = `</${name}`;
  while (cursor < html.length) {
    const closingStart = lowerHtml.indexOf(closingPrefix, cursor);
    if (closingStart === -1) return html.length;
    const boundary = html[closingStart + closingPrefix.length];
    if (boundary === ">" || boundary === "/" || /\s/.test(boundary ?? "")) {
      return findHtmlTagEnd(html, closingStart + closingPrefix.length) ?? html.length;
    }
    cursor = closingStart + closingPrefix.length;
  }
  return html.length;
}

function isProjectRelativeModulePath(value: string) {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function isCanonicalDescendant(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function executeBundledRenderer(source: string, modulePath: string, displayPath: string) {
  const moduleRecord: { exports: unknown } = { exports: {} };
  // Renderers share the trusted-build-code boundary of project Vite config. Execute the
  // in-memory CommonJS bundle fresh on every build: project-rooted require supports Node
  // builtins/native externals without adding a unique data URL to the permanent ESM cache.
  const execute = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${source}\n//# sourceURL=${displayPath.replaceAll("\\", "/")}\n`,
  ) as (exports: unknown, require: NodeJS.Require, module: { exports: unknown }, fileName: string, directory: string) => void;
  execute(moduleRecord.exports, createRequire(modulePath), moduleRecord, modulePath, path.dirname(modulePath));
  const exported = moduleRecord.exports;
  return exported && typeof exported === "object" && "default" in exported
    ? (exported as { default?: unknown }).default
    : undefined;
}

function boundedMessage(error: unknown, projectRoots: string[] = []) {
  let message: string;
  try {
    message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  } catch {
    message = "Thrown error message unavailable.";
  }
  const redacted = redactBuildProjectRoots(message, projectRoots);
  return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function prerenderError(message: string, hint: string, diagnostics?: unknown) {
  const error = new Error(message) as Error & { hint?: string; diagnostics?: unknown };
  error.hint = hint;
  if (diagnostics) error.diagnostics = diagnostics;
  return error;
}
