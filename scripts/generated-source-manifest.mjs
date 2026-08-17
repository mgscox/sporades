import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function listFiles(root, current, accept = () => true) {
  const absolute = path.join(root, current);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative, accept));
    else if (entry.isFile() && accept(relative)) files.push(relative);
  }
  return files;
}

async function existingFiles(repoRoot, candidates) {
  const files = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(path.join(repoRoot, candidate))).isFile()) files.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files;
}

async function digestFiles(repoRoot, files) {
  const sortedFiles = [...files].sort();
  const hash = createHash("sha256");
  for (const file of sortedFiles) {
    const contents = await readFile(path.join(repoRoot, file));
    hash.update(file);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
  }
  return { files: sortedFiles, digest: hash.digest("hex") };
}

export async function generatedSourceManifest(repoRoot) {
  const inputs = [
    ...await listFiles(repoRoot, "src", (file) => file.endsWith(".ts")),
    ...await existingFiles(repoRoot, [
      "package.json",
      "package-lock.json",
      "scripts/build-bin.mjs",
      "scripts/generated-source-manifest.mjs",
      "scripts/write-cli-version.mjs",
      "scripts/write-generated-source-manifest.mjs",
    ]),
    "tsconfig.json",
    "tsconfig.runtime.json",
  ];
  const outputs = [
    ...await listFiles(repoRoot, "dist", (file) => file !== path.join("dist", "generated-source-manifest.json")),
    ...await listFiles(repoRoot, "bin"),
  ];
  return {
    version: 2,
    algorithm: "sha256",
    inputs: await digestFiles(repoRoot, inputs),
    outputs: await digestFiles(repoRoot, outputs),
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
    throw new Error("Generated dist/bin artifacts do not match their generator inputs and retained outputs. Run `npm run build`.");
  }
}
