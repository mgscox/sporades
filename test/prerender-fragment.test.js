import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createBundle } from "../dist/bundle-pipeline.js";
import { discardPublicTree } from "../dist/public-tree.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-prerender-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMinimalViteCapsule(projectDir, indexHtml) {
  await mkdir(path.join(projectDir, "client"), { recursive: true });
  await mkdir(path.join(projectDir, "server"), { recursive: true });
  await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(projectDir, "index.html"), indexHtml);
  await writeFile(path.join(projectDir, "client", "index.tsx"), 'console.log("interactive client");\n');
  await writeFile(path.join(projectDir, "server", "index.ts"), "export default {};\n");
}

async function publicFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await publicFiles(root, filePath));
    else files.push(path.relative(root, filePath).split(path.sep).join("/"));
  }
  return files.sort();
}

test("one configured Vite prerender fragment reaches the normalized public tree", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(projectDir, "render-landing.mjs"), 'export default () => "<main><h1>Useful before JavaScript</h1></main>";\n');
    const config = {
      name: "prerender-capsule",
      client: {
        framework: "react",
        toolchain: "vite",
        prerender: [{ name: "landing", module: "render-landing.mjs" }],
      },
    };

    const bundle = await createBundle(projectDir, config, { publishLegacy: false });
    try {
      const files = await publicFiles(bundle.staticFiles.publicDir);
      assert(files.includes("index.html"), JSON.stringify(files));
      assert(files.some((file) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(file)), JSON.stringify(files));
      const emittedHtml = await readFile(bundle.staticFiles.indexHtml, "utf8");
      assert.match(emittedHtml, /<!--[^>]+--><main><h1>Useful before JavaScript<\/h1><\/main><!--[^>]+-->/);
      assert.doesNotMatch(emittedHtml, /sporades:prerender landing/);
      assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), sourceHtml);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});
