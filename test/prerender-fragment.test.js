import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createBundle } from "../dist/bundle-pipeline.js";
import { readProjectConfig } from "../dist/cli/project-config.js";
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
    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(config, null, 2)}\n`);
    assert.deepEqual((await readProjectConfig(projectDir)).client.prerender, config.client.prerender);
    const duplicateConfig = structuredClone(config);
    duplicateConfig.client.prerender.push({ name: "landing", module: "another-renderer.mjs" });
    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(duplicateConfig, null, 2)}\n`);
    await assert.rejects(readProjectConfig(projectDir), (error) => {
      assert.match(error.message, /duplicate client prerender name: landing/i);
      assert.match(error.hint, /unique name/i);
      return true;
    });
    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(config, null, 2)}\n`);

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

    const fallbackSource = '<!doctype html><html><head></head><body class="shell"><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeFile(path.join(projectDir, "index.html"), fallbackSource);
    await writeFile(path.join(projectDir, ".env"), "VITE_PRERENDER_SECRET=project-env-secret\n");
    await writeFile(path.join(projectDir, ".env.local"), "VITE_PRERENDER_LOCAL_SECRET=project-local-env-secret\n");
    await writeFile(path.join(projectDir, ".env.sporades.server"), "PRERENDER_SERVER_SECRET=server-env-secret\n");
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `export default async () => {
  const leaked = [
    process.env.PRERENDER_SERVER_SECRET,
    process.env.VITE_PRERENDER_SECRET,
    import.meta.env?.VITE_PRERENDER_SECRET,
  ].filter(Boolean).join(":");
  return \`<aside>\${leaked || "async environment isolated"}</aside>\`;
};
`,
    );
    const published = await createBundle(projectDir, config);
    const publishedHtml = await readFile(published.staticFiles.indexHtml, "utf8");
    assert.match(publishedHtml, /<body class="shell"><!--[^>]+--><aside>async environment isolated<\/aside><!--[^>]+-->/);
    assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), fallbackSource);
    const publishedPaths = await publicFiles(published.staticFiles.publicDir);
    const publicOutput = (await Promise.all(publishedPaths.map((file) => readFile(path.join(published.staticFiles.publicDir, file), "utf8")))).join("\n");
    assert.doesNotMatch(publicOutput, /project-env-secret|project-local-env-secret|server-env-secret|PRERENDER_SERVER_SECRET/);

    const treesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
    const treeState = (await readdir(treesDir)).sort();
    const activeHtml = await readFile(published.staticFiles.indexHtml, "utf8");
    const failureCases = [
      {
        label: "missing module",
        module: "missing-renderer.mjs",
        source: null,
        message: /Could not load client prerender module for landing/,
      },
      {
        label: "thrown renderer",
        module: "render-landing.mjs",
        source: 'export default () => { throw new Error("sync renderer boom"); };\n',
        message: /renderer for landing failed: sync renderer boom/,
      },
      {
        label: "rejected renderer",
        module: "render-landing.mjs",
        source: 'export default async () => { throw new Error("async renderer boom"); };\n',
        message: /renderer for landing failed: async renderer boom/,
      },
      {
        label: "non-string renderer",
        module: "render-landing.mjs",
        source: "export default () => ({ html: '<p>not a string</p>' });\n",
        message: /renderer for landing returned a non-string result/,
      },
    ];
    for (const failure of failureCases) {
      config.client.prerender[0].module = failure.module;
      if (failure.source !== null) await writeFile(path.join(projectDir, failure.module), failure.source);
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.match(error.message, failure.message, failure.label);
        assert.equal(error.phase, "client");
        assert.equal(error.framework, "react");
        assert.equal(error.toolchain, "vite");
        return true;
      });
      assert.deepEqual((await readdir(treesDir)).sort(), treeState, `${failure.label} created partial public output`);
      assert.equal(await readFile(published.staticFiles.indexHtml, "utf8"), activeHtml, `${failure.label} replaced the active public tree`);
    }

    config.client.prerender[0].module = "render-landing.mjs";
    config.client.toolchain = "esbuild";
    await assert.rejects(createBundle(projectDir, config), (error) => {
      assert.match(error.message, /prerender fragments require the Vite client toolchain/i);
      assert.match(error.hint, /client\.toolchain.*vite/i);
      return true;
    });
    assert.deepEqual((await readdir(treesDir)).sort(), treeState, "esbuild compatibility failure created partial public output");
    assert.equal(await readFile(published.staticFiles.indexHtml, "utf8"), activeHtml, "esbuild compatibility failure replaced the active public tree");
  });
});
