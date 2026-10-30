// npm ci warms locked tarballs, but the packed-Capsule tests also need package
// metadata and scaffold-only dependencies for their separate offline installs.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const seed = await mkdtemp(path.join(tmpdir(), "sporades-offline-cache-"));
try {
  execFileSync(process.execPath, [path.join(root, "bin/sporades.js"), "create", "capsule", "--no-install", "--no-git"], {
    cwd: seed, stdio: "inherit",
  });
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const capsule = JSON.parse(await readFile(path.join(seed, "capsule/package.json"), "utf8"));
  // The tests install the candidate tarball, rather than the registry release.
  delete capsule.devDependencies?.sporades;
  delete capsule.dependencies?.sporades;
  const manifest = {
    private: true,
    dependencies: { ...capsule.dependencies, ...pkg.dependencies },
    devDependencies: { ...capsule.devDependencies, ...pkg.devDependencies },
    ...(pkg.overrides ? { overrides: pkg.overrides } : {}),
  };
  await writeFile(path.join(seed, "package.json"), JSON.stringify(manifest));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: seed, stdio: "inherit" });
} finally {
  await rm(seed, { recursive: true, force: true });
}
