import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const SOLID_TOOLCHAIN_PACKAGES = [
  "@babel", "@esbuild", "@jridgewell", "@rollup", "@types",
  "babel-plugin-jsx-dom-expressions", "babel-preset-solid", "baseline-browser-mapping",
  "browserslist", "caniuse-lite", "convert-source-map", "csstype", "debug",
  "electron-to-chromium", "entities", "esbuild", "escalade", "fdir", "fsevents",
  "gensync", "html-entities", "is-what", "js-tokens", "jsesc", "json5", "lru-cache",
  "magic-string", "merge-anything", "ms", "nanoid", "node-releases", "parse5",
  "picocolors", "picomatch", "postcss", "rollup", "semver", "seroval",
  "seroval-plugins", "solid-js", "solid-refresh", "source-map-js", "tinyglobby",
  "update-browserslist-db", "vite", "vite-plugin-solid", "vitefu", "yallist",
];

export async function installProjectSolidToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(SOLID_TOOLCHAIN_PACKAGES.map(async (packageName) => {
    try {
      await cp(path.join(repoRoot, "node_modules", packageName), path.join(nodeModules, packageName), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT" || packageName !== "fsevents") throw error;
    }
  }));
}
