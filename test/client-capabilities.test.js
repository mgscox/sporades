import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_CAPABILITIES, CLIENT_TEMPLATES, defaultClientToolchain, supportsClientCapability } from "../dist/client-capabilities.js";
import { scaffoldFiles } from "../dist/templates/scaffold-template.js";

test("the immutable client capability matrix covers every admitted pair and template without skipped cells", () => {
  assert.equal(Object.isFrozen(CLIENT_CAPABILITIES), true);
  assert.equal(new Set(CLIENT_CAPABILITIES.map(({ framework, toolchain }) => `${framework}/${toolchain}`)).size, 11);
  let cells = 0;
  for (const capability of CLIENT_CAPABILITIES) for (const template of CLIENT_TEMPLATES) {
    const files = scaffoldFiles({ name: `matrix-${capability.framework}-${capability.toolchain}-${template}`, framework: capability.framework, toolchain: capability.toolchain, template });
    const config = JSON.parse(files["sporades.json"]);
    assert.deepEqual(config.client, { framework: capability.framework, toolchain: capability.toolchain });
    assert(files["index.html"]); assert(files["client/index.ts"] || files["client/index.tsx"]);
    cells += 1;
  }
  assert.equal(cells, 55);
  for (const framework of [...new Set(CLIENT_CAPABILITIES.map(({ framework }) => framework))]) assert(CLIENT_CAPABILITIES.some((cell) => cell.framework === framework && cell.toolchain === defaultClientToolchain(framework) && cell.default));
});

test("unsupported matrix cells and replacement frameworks remain structurally absent", () => {
  for (const [framework, toolchain] of [["vanilla", "vite"], ["vue", "esbuild"], ["svelte", "esbuild"], ["solid", "esbuild"], ["lit", "esbuild"], ["angular", "vite"], ["next", "vite"], ["nuxt", "vite"]]) assert.equal(supportsClientCapability(framework, toolchain), false, `${framework}/${toolchain}`);
});
