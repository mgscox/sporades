import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const VUE_TOOLCHAIN_PACKAGES = [
  "@babel", "@esbuild", "@jridgewell", "@rollup", "@vitejs", "@vue",
  "csstype", "entities", "esbuild", "estree-walker", "fdir", "fsevents",
  "magic-string", "nanoid", "picocolors", "picomatch", "postcss", "rollup",
  "source-map-js", "tinyglobby", "vite", "vue",
];

export async function installProjectVueToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(VUE_TOOLCHAIN_PACKAGES.map(async (packageName) => {
    try {
      await cp(
        path.join(repoRoot, "node_modules", packageName),
        path.join(nodeModules, packageName),
        { recursive: true },
      );
    } catch (error) {
      if (error.code !== "ENOENT" || packageName !== "fsevents") throw error;
    }
  }));
}
