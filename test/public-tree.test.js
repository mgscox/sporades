import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishLegacyBundles } from "../dist/bundle-pipeline.js";
import {
  PUBLIC_TREE_LIMITS,
  cleanupPublicTrees,
  createPublicTree,
  readPublicAsset,
  validatePublicFiles,
  validatePublicTree,
} from "../dist/public-tree.js";

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

test("public snapshots copy validated inputs and ignore later file growth", async () => {
  await withTempDir(async (buildDir) => {
    const mutableClient = Buffer.from("bounded client");
    const tree = await createPublicTree(buildDir, [
      { path: "index.html", contents: "safe html" },
      { path: "client.js", contents: mutableClient },
    ]);
    mutableClient.fill("x");
    await writeFile(path.join(tree.root, "client.js"), Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes + 1, 1));
    assert.equal((await readPublicAsset(tree, "/client.js")).body.toString("utf8"), "bounded client");

    const fullSized = Buffer.alloc(PUBLIC_TREE_LIMITS.fileBytes);
    assert.throws(
      () => validatePublicFiles([
        { path: "index.html", contents: "x" },
        { path: "assets/one.bin", contents: fullSized },
        { path: "assets/two.bin", contents: fullSized },
        { path: "assets/three.bin", contents: fullSized },
        { path: "assets/four.bin", contents: fullSized },
      ]),
      (error) => /aggregate size limit/.test(error.hint),
    );
  });
});

test("public tree cleanup stays bounded and preserves the newest recoverable trees", async () => {
  await withTempDir(async (buildDir) => {
    const active = await createPublicTree(buildDir, [
      { path: "index.html", contents: "active tree" },
      { path: "client.js", contents: "active client" },
    ]);
    const treesDir = path.join(buildDir, ".public-trees");
    await writeFile(path.join(treesDir, "active.json"), `${JSON.stringify({ tree: path.basename(active.root) })}\n`);
    let newest = active;
    for (let index = 0; index < 5; index += 1) {
      newest = await createPublicTree(buildDir, [
        { path: "index.html", contents: `tree ${index}` },
        { path: "client.js", contents: `client ${index}` },
      ]);
    }
    const completed = (await readdir(treesDir)).filter((name) => !name.startsWith(".staging-") && name !== "active.json");
    assert.equal(completed.length, 2);
    await access(active.root);
    await access(newest.root);

    const staleStaging = path.join(treesDir, ".staging-stale");
    await mkdir(staleStaging);
    await assert.rejects(
      cleanupPublicTrees(buildDir, {
        keepRoots: [newest.root],
        fault: (_event, entryPath) => {
          if (entryPath === staleStaging) throw new Error("injected cleanup failure");
        },
      }),
      (error) => error.message === "Public tree cleanup degraded." && /active and recoverable trees were preserved/.test(error.hint),
    );
    await access(newest.root);
    await access(staleStaging);
  });
});

test("legacy Bundle rollback restores every recoverable file and preserves failed backups", async () => {
  await withTempDir(async (buildDir) => {
    const server = path.join(buildDir, "server.mjs");
    const client = path.join(buildDir, "client.js");
    await writeFile(server, "old server");
    await writeFile(client, "old client");

    await assert.rejects(
      publishLegacyBundles(
        buildDir,
        [
          { target: server, contents: "new server" },
          { target: client, contents: "new client" },
        ],
        {
          fault: (event, index) => {
            if (event === "before-publish" && index === 1) throw new Error("injected publish failure");
            if (event === "before-restore" && index === 0) throw new Error("injected restore failure");
          },
        },
      ),
      (error) => error.message === "Legacy Bundle recovery is incomplete." && error.diagnostics.failedFiles === 1,
    );

    assert.equal(await readFile(client, "utf8"), "old client");
    const recoveryDirName = (await readdir(buildDir)).find((name) => name.startsWith(".legacy-staging-"));
    assert.ok(recoveryDirName);
    assert.equal(await readFile(path.join(buildDir, recoveryDirName, "backup-0"), "utf8"), "old server");
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
