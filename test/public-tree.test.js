import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { replacePublicTree, validatePublicTree } from "../dist/public-tree.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-public-tree-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalized public tree replacement keeps the last successful tree when validation fails", async () => {
  await withTempDir(async (buildDir) => {
    await replacePublicTree(buildDir, [
      { path: "index.html", contents: "<h1>last good</h1>" },
      { path: "assets/client.js", contents: "console.log('good')" },
    ]);

    await assert.rejects(
      replacePublicTree(buildDir, [
        { path: "index.html", contents: "<h1>bad</h1>" },
        { path: "../escape.js", contents: "bad" },
      ]),
      (error) => error.message === "Invalid public path.",
    );

    assert.equal(await readFile(path.join(buildDir, "public", "index.html"), "utf8"), "<h1>last good</h1>");
    assert.equal(await readFile(path.join(buildDir, "public", "assets", "client.js"), "utf8"), "console.log('good')");
  });
});

test("normalized public tree rejects symlinks and Unicode normalization collisions", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "index.html"), "<h1>safe</h1>");
    await symlink(path.join(root, "index.html"), path.join(root, "linked.html"));
    await assert.rejects(validatePublicTree(root), /Invalid public tree/);
    await rm(path.join(root, "linked.html"));

    await assert.rejects(
      replacePublicTree(root, [
        { path: "index.html", contents: "<h1>safe</h1>" },
        { path: "assets/caf\u00e9.js", contents: "one" },
        { path: "assets/cafe\u0301.js", contents: "two" },
      ]),
      (error) => /normalization collision/.test(error.hint),
    );
  });
});
