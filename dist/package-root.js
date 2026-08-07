import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The directory holding the Sporades package's own `package.json`, found by walking up from
// whichever module is executing.
//
// Both server-bundle builders need it, and for the same reason: building a Capsule bundle now means
// reading Sporades' own compiled output, which the `Function.prototype.toString()` mechanism never
// had to do because concatenating source text reads no files.
//
// Not `new URL("./…", import.meta.url)`. A sibling lookup is right only while this module is being
// executed from `dist/`, and the CLI is not always executed from there: `scripts/build-bin.mjs`
// bundles `src/cli/sporades.ts` into `bin/sporades.js`, and esbuild rewrites `import.meta.url` for
// the entry point only. Every other module in the graph — this one included — inherits the entry's,
// so inside the bundled CLI the value below is `bin/sporades.js` and a sibling lookup resolves next
// to `bin/` and fails with ENOENT.
//
// Walking to the package root is correct under both layouts, because `<root>/dist/…` and
// `<root>/bin/sporades.js` sit inside the same package and neither contains a nearer `package.json`.
// `CLI_ROOT` in `src/cli/sporades.ts` survives bundling for the opposite reason — that file *is* the
// entry point.
export function resolveSporadesPackageRoot() {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(path.join(directory, "package.json"))) {
            return directory;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            throw Object.assign(new Error("Server bundle failed: could not locate the Sporades package root."), {
                hint: "Reinstall the Sporades CLI: its dist/ directory is missing or the install is incomplete.",
            });
        }
        directory = parent;
    }
}
//# sourceMappingURL=package-root.js.map