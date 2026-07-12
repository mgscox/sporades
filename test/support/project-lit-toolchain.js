import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const LIT_PROJECT_PACKAGES = [
  "@esbuild", "@lit", "@rollup", "@types", "csstype", "entities", "esbuild",
  "fdir", "fsevents", "lit", "lit-element", "lit-html", "nanoid", "parse5",
  "picocolors", "picomatch", "postcss", "rollup", "source-map-js", "tinyglobby", "vite",
];

export async function installProjectLitToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(LIT_PROJECT_PACKAGES.map(async (packageName) => {
    try {
      await cp(path.join(repoRoot, "node_modules", packageName), path.join(nodeModules, packageName), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT" || packageName !== "fsevents") throw error;
    }
  }));
}
