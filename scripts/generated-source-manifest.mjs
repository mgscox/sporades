import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function listFiles(root, current) {
  const absolute = path.join(root, current);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
  }
  return files;
}

export async function generatedSourceManifest(repoRoot) {
  const files = [
    ...await listFiles(repoRoot, "src"),
    "tsconfig.json",
    "tsconfig.runtime.json",
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(path.join(repoRoot, file));
    hash.update(file);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
  }
  return {
    version: 1,
    algorithm: "sha256",
    files,
    digest: hash.digest("hex"),
  };
}

export async function writeGeneratedSourceManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, "dist", "generated-source-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(await generatedSourceManifest(repoRoot), null, 2)}\n`);
}

export async function assertGeneratedSourceManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, "dist", "generated-source-manifest.json");
  const retainedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const currentManifest = await generatedSourceManifest(repoRoot);
  if (JSON.stringify(retainedManifest) !== JSON.stringify(currentManifest)) {
    throw new Error("Generated dist/bin artifacts are stale relative to their TypeScript sources. Run `npm run build`.");
  }
}
