import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertGeneratedSourceManifest,
  writeGeneratedSourceManifest,
} from "../scripts/generated-source-manifest.mjs";

test("fresh local manifest accepts a source-only PR while committed dist stays older", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-pr-local-build-"));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    for (const dir of ['src', 'dist']) await mkdir(path.join(root, dir));
    await writeFile(path.join(root, 'src/runtime.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'dist/runtime.js'), 'export const value = 1;\n');
    for (const name of ['tsconfig.json', 'tsconfig.runtime.json']) await writeFile(path.join(root, name), '{}\n');
    await writeGeneratedSourceManifest(root);
    git('init');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Old build');
    await writeFile(path.join(root, 'src/runtime.ts'), 'export const value = 2;\n');
    git('add', 'src');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Source-only PR');
    await assert.rejects(assertGeneratedSourceManifest(root));
    // Simulate the complete local build without updating the committed tree.
    await writeFile(path.join(root, 'dist/runtime.js'), 'export const value = 2;\n');
    await writeGeneratedSourceManifest(root);
    await assertGeneratedSourceManifest(root);
    assert.equal(git('show', 'HEAD:dist/runtime.js'), 'export const value = 1;');
    assert.match(git('diff', '--name-only'), /dist\/generated-source-manifest.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone generated entrypoints start quietly without PDF rendering support", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-standalone-entrypoints-"));
  try {
    for (const name of ["sporades.js", "sporades-host-helper.js"]) {
      const artifact = path.join(root, name);
      await copyFile(path.join(process.cwd(), "bin", name), artifact);
      const result = spawnSync(process.execPath, [artifact, "--help"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "", `${name} initialized optional PDF rendering support:\n${result.stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bin-only generation cannot bless stale dist against changed TypeScript sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-generated-manifest-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "src", "runtime.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "tsconfig.json"), "{}\n");
    await writeFile(path.join(root, "tsconfig.runtime.json"), "{}\n");
    await writeGeneratedSourceManifest(root);
    await assertGeneratedSourceManifest(root);

    // A bin-only build changes no manifest. The stale dist/source relationship
    // therefore remains visible until the complete build writes its final seal.
    await writeFile(path.join(root, "src", "runtime.ts"), "export const value = 2;\n");
    await assert.rejects(
      assertGeneratedSourceManifest(root),
      /do not match their generator inputs and retained outputs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated freshness rejects a corrupted shipped output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-generated-output-manifest-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dist"));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "src", "runtime.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "dist", "runtime.js"), "export const value = 1;\n");
    await writeFile(path.join(root, "bin", "sporades.js"), "#!/usr/bin/env node\n");
    await writeFile(path.join(root, "tsconfig.json"), "{}\n");
    await writeFile(path.join(root, "tsconfig.runtime.json"), "{}\n");
    await writeGeneratedSourceManifest(root);
    await assertGeneratedSourceManifest(root);

    await writeFile(path.join(root, "dist", "runtime.js"), "export const value = 999;\n");
    await assert.rejects(
      assertGeneratedSourceManifest(root),
      /do not match their generator inputs and retained outputs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated freshness rejects a deleted shipped declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-generated-deletion-manifest-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "src", "runtime.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "dist", "runtime.js"), "export const value = 1;\n");
    await writeFile(path.join(root, "dist", "runtime.d.ts"), "export declare const value = 1;\n");
    await writeFile(path.join(root, "tsconfig.json"), "{}\n");
    await writeFile(path.join(root, "tsconfig.runtime.json"), "{}\n");
    await writeGeneratedSourceManifest(root);
    await unlink(path.join(root, "dist", "runtime.d.ts"));

    await assert.rejects(
      assertGeneratedSourceManifest(root),
      /do not match their generator inputs and retained outputs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated freshness rejects a changed generator input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-generator-input-manifest-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dist"));
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "src", "runtime.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "dist", "runtime.js"), "export const value = 1;\n");
    await writeFile(path.join(root, "scripts", "build-bin.mjs"), "export const version = 1;\n");
    await writeFile(path.join(root, "tsconfig.json"), "{}\n");
    await writeFile(path.join(root, "tsconfig.runtime.json"), "{}\n");
    await writeGeneratedSourceManifest(root);
    await writeFile(path.join(root, "scripts", "build-bin.mjs"), "export const version = 2;\n");

    await assert.rejects(
      assertGeneratedSourceManifest(root),
      /do not match their generator inputs and retained outputs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
