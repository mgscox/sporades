import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the packed package imports the framework-neutral Access-key client surface", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-packed-access-keys-"));
  try {
    const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
      cwd: repoRoot,
      env: { ...process.env, npm_config_cache: path.join(dir, "npm-cache") },
    });
    const [{ filename }] = JSON.parse(packed.stdout);
    const modules = path.join(dir, "consumer", "node_modules");
    await mkdir(modules, { recursive: true });
    await run("tar", ["-xzf", path.join(dir, filename), "-C", modules]);
    await rename(path.join(modules, "package"), path.join(modules, "sporades"));
    const probe = path.join(dir, "consumer", "probe.mjs");
    await writeFile(probe, [
      'import { accessKeys } from "sporades/client";',
      'const names = Object.keys(accessKeys).sort();',
      'if (JSON.stringify(names) !== JSON.stringify(["delete", "issue", "list", "revoke", "rotate"])) process.exit(1);',
    ].join("\n"));
    const result = await run(process.execPath, [probe]);
    assert.equal(result.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
