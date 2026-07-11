import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const SVELTE_TOOLCHAIN_PACKAGES = [
  "@esbuild", "@jridgewell", "@rollup", "@sveltejs", "@types",
  "acorn", "aria-query", "axobject-query", "clsx", "debug", "deepmerge", "devalue",
  "esbuild", "esrap", "esm-env", "estree-walker", "fdir", "fsevents", "is-reference",
  "kleur", "locate-character", "magic-string", "ms", "nanoid", "picocolors", "picomatch",
  "postcss", "rollup", "source-map-js", "svelte", "tinyglobby", "vite", "vitefu", "zimmerframe",
];

export async function installProjectSvelteToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(SVELTE_TOOLCHAIN_PACKAGES.map(async (packageName) => {
    try {
      await cp(path.join(repoRoot, "node_modules", packageName), path.join(nodeModules, packageName), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT" || packageName !== "fsevents") throw error;
    }
  }));
}
