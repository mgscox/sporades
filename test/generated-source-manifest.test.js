import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertGeneratedSourceManifest,
  writeGeneratedSourceManifest,
} from "../scripts/generated-source-manifest.mjs";

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
      /stale relative to their TypeScript sources/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
