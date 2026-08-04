import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TAILWIND_TOOLCHAIN_PACKAGES = [
  "@esbuild", "@jridgewell", "@rollup", "@tailwindcss", "@types",
  "detect-libc", "enhanced-resolve", "esbuild", "fdir", "fsevents",
  "graceful-fs", "jiti", "lightningcss", "lightningcss-darwin-arm64", "magic-string", "nanoid",
  "picocolors", "picomatch", "postcss", "rollup", "source-map-js",
  "tailwindcss", "tapable", "tinyglobby", "vite",
];

export async function installProjectTailwindToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(TAILWIND_TOOLCHAIN_PACKAGES.map(async (packageName) => {
    try {
      await cp(path.join(repoRoot, "node_modules", packageName), path.join(nodeModules, packageName), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT" || packageName !== "fsevents") throw error;
    }
  }));
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies = {
    ...(manifest.devDependencies ?? {}),
    "@tailwindcss/vite": "^4.0.0",
    tailwindcss: "^4.0.0",
    vite: "^6.0.0",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
