import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { Plugin } from "vite";

const NONCE_PLACEHOLDER = "%SPORADES_NONCE%";

function scripts(html: string) {
  const found: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node && node.tagName === "script") found.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("tagName" in node && node.tagName === "template") visit((node as DefaultTreeAdapterTypes.Template).content);
  };
  visit(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
  return found;
}

/** Only explicitly marked modules may contribute code to a nonced Vite entry. */
export function viteCspPlugins(): Plugin[] {
  const preserved = new Map<string, Map<string, string>>();
  return [{
    name: "sporades-csp-preserve-scripts",
    enforce: "post",
    configResolved(config) {
      // Vite's option grants every authored script a nonce, including deliberately
      // unmarked ones. This security boundary owns authorization instead.
      if (config.html) config.html.cspNonce = undefined;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        let prefix = `sporades-csp-${createHash("sha256").update(html).digest("hex")}-`;
        while (html.includes(prefix)) prefix += "_";
        const originals = new Map<string, string>();
        const edits = scripts(html).flatMap(script => {
          if (script.attrs.some(attr => attr.name === "nonce" && attr.value === NONCE_PLACEHOLDER)) return [];
          const location = script.sourceCodeLocation;
          if (!location) throw new Error("Cannot preserve CSP script authorization.");
          const marker = `<!--${prefix}${originals.size}-->`;
          originals.set(marker, html.slice(location.startOffset, location.endOffset));
          return [{ start: location.startOffset, end: location.endOffset, value: marker }];
        });
        preserved.set(context.filename, originals);
        for (const edit of edits.sort((left, right) => right.start - left.start)) {
          html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
        }
        return html;
      },
    },
  }, {
    name: "sporades-csp-generated-entries",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        // Vite can replace an import-only entry with tags for its static imports.
        // Follow the output graph, rather than trusting an assets/ URL pattern.
        const entryFiles = new Set<string>();
        const visit = (file: string) => {
          if (entryFiles.has(file)) return;
          const chunk = context.bundle?.[file];
          if (chunk?.type !== "chunk") return;
          entryFiles.add(file);
          chunk.imports.forEach(visit);
        };
        if (context.chunk) visit(context.chunk.fileName);
        const insertions = scripts(html).flatMap(script => {
          const src = script.attrs.find(attr => attr.name === "src")?.value;
          if (!src || !entryFiles.has(src.replace(/^\//, "")) || script.attrs.some(attr => attr.name === "nonce")) return [];
          const end = script.sourceCodeLocation?.startTag?.endOffset;
          if (!end) throw new Error("Cannot authorize generated CSP entry.");
          return [end - 1];
        });
        for (const offset of insertions.sort((left, right) => right - left)) {
          html = html.slice(0, offset) + ` nonce="${NONCE_PLACEHOLDER}"` + html.slice(offset);
        }
        for (const [marker, original] of preserved.get(context.filename) ?? []) {
          if (html.split(marker).length !== 2) throw new Error("CSP script preservation marker changed during build.");
          html = html.replace(marker, () => original);
        }
        preserved.delete(context.filename);
        return html;
      },
    },
  }];
}
