import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPublicTree, readPublicAsset, validatePublicTree } from "../dist/public-tree.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-public-tree-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a failed candidate leaves the active immutable public tree continuously readable", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "<h1>last good</h1>" },
      { path: "assets/client.js", contents: "console.log('good')" },
      { path: "assets/capsule.css", contents: "body { color: teal; }" },
    ]);

    await assert.rejects(
      createPublicTree(buildDir, [
        { path: "index.html", contents: "<h1>bad</h1>" },
        { path: "../escape.js", contents: "bad" },
      ]),
      (error) => error.message === "Invalid public path.",
    );

    const html = await readPublicAsset(active, "/");
    const css = await readPublicAsset(active, "/assets/capsule.css");
    assert.equal(html.body.toString("utf8"), "<h1>last good</h1>");
    assert.equal(css.body.toString("utf8"), "body { color: teal; }");
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.equal(await readFile(path.join(active.root, "assets", "client.js"), "utf8"), "console.log('good')");
  });
});

test("creating a replacement never removes or mutates the active public tree", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "old html" },
      { path: "client.js", contents: "old client" },
    ]);
    const replacementPromise = createPublicTree(buildDir, [
      { path: "index.html", contents: "new html" },
      { path: "client.js", contents: "new client" },
    ]);

    assert.equal((await readPublicAsset(active, "/client.js")).body.toString("utf8"), "old client");
    const replacement = await replacementPromise;
    assert.notEqual(replacement.root, active.root);
    assert.equal((await readPublicAsset(active, "/client.js")).body.toString("utf8"), "old client");
    assert.equal((await readPublicAsset(replacement, "/client.js")).body.toString("utf8"), "new client");
  });
});

test("the validated asset snapshot is race-safe when an output path becomes a symlink", async () => {
  await withTempDir(async (buildDir) => {
    const tree = await createPublicTree(buildDir, [
      { path: "index.html", contents: "safe html" },
      { path: "client.js", contents: "safe client" },
    ]);
    const outside = path.join(buildDir, "outside.js");
    await writeFile(outside, "secret outside bytes");
    await rm(path.join(tree.root, "client.js"));
    await symlink(outside, path.join(tree.root, "client.js"));

    for (let index = 0; index < 25; index += 1) {
      assert.equal((await readPublicAsset(tree, "/client.js")).body.toString("utf8"), "safe client");
    }
    await assert.rejects(validatePublicTree(tree.root), /Invalid public tree/);
  });
});

test("normalized public trees reject symlinks and Unicode normalization collisions", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "index.html"), "<h1>safe</h1>");
    await symlink(path.join(root, "index.html"), path.join(root, "linked.html"));
    await assert.rejects(validatePublicTree(root), /Invalid public tree/);

    await assert.rejects(
      createPublicTree(root, [
        { path: "index.html", contents: "<h1>safe</h1>" },
        { path: "assets/caf\u00e9.js", contents: "one" },
        { path: "assets/cafe\u0301.js", contents: "two" },
      ]),
      (error) => /normalization collision/.test(error.hint),
    );
  });
});
