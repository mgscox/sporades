import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PACKAGES = ["@esbuild", "csstype", "esbuild", "inferno", "inferno-create-element", "inferno-vnode-flags", "opencollective-postinstall", "typescript"];

export async function installProjectInfernoToolchain(projectDir, repoRoot) {
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await Promise.all(PACKAGES.map((name) => cp(path.join(repoRoot, "node_modules", name), path.join(nodeModules, name), { recursive: true })));
  const sporades = path.join(nodeModules, "sporades"); await mkdir(sporades, { recursive: true });
  await Promise.all([
    cp(path.join(repoRoot, "src/types/client.d.ts"), path.join(sporades, "client.d.ts")),
    cp(path.join(repoRoot, "src/types/server.d.ts"), path.join(sporades, "server.d.ts")),
    writeFile(path.join(sporades, "package.json"), `${JSON.stringify({ name: "sporades", type: "module", exports: { "./client": { types: "./client.d.ts" }, "./server": { types: "./server.d.ts" } } }, null, 2)}\n`),
  ]);
}
