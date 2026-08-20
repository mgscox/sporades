import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const LIT_PROJECT_PACKAGES = [
  "@esbuild", "@lit", "@rollup", "@types", "csstype", "entities", "esbuild",
  "fdir", "fsevents", "lit", "lit-element", "lit-html", "nanoid", "parse5",
  "picocolors", "picomatch", "postcss", "rollup", "source-map-js", "tinyglobby", "typescript", "vite",
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
  const sporades = path.join(nodeModules, "sporades");
  await mkdir(sporades, { recursive: true });
  await Promise.all([
    cp(path.join(repoRoot, "src/types/client.d.ts"), path.join(sporades, "client.d.ts")),
    cp(path.join(repoRoot, "src/types/server.d.ts"), path.join(sporades, "server.d.ts")),
    cp(path.join(repoRoot, "src/types/stripe.d.ts"), path.join(sporades, "stripe.d.ts")),
    writeFile(path.join(sporades, "package.json"), `${JSON.stringify({ name: "sporades", type: "module", exports: { "./client": { types: "./client.d.ts" }, "./server": { types: "./server.d.ts" }, "./server/stripe": { types: "./stripe.d.ts" } } }, null, 2)}\n`),
  ]);
}
