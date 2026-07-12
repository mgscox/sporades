import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CLIENT_CAPABILITIES, CLIENT_FRAMEWORKS, CLIENT_TEMPLATES, CLIENT_TOOLCHAINS, clientCapabilityError, clientFrameworkCapability, defaultClientToolchain, resolveClientCapability, supportsClientCapability } from "../dist/client-capabilities.js";
import { scaffoldFiles } from "../dist/templates/scaffold-template.js";

test("the immutable client capability matrix covers every admitted pair and template without skipped cells", () => {
  assert.equal(Object.isFrozen(CLIENT_CAPABILITIES), true);
  assert.equal(Object.isFrozen(CLIENT_FRAMEWORKS), true);
  assert.equal(Object.isFrozen(CLIENT_TOOLCHAINS), true);
  assert.equal(Object.isFrozen(CLIENT_TEMPLATES), true);
  for (const capability of CLIENT_CAPABILITIES) {
    assert.equal(Object.isFrozen(capability), true);
    assert.equal(Object.isFrozen(capability.templates), true);
    assert.equal(Object.isFrozen(capability.build), true);
  }
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

test("capability lookups own defaults, build metadata, and stable diagnostics", () => {
  assert.equal(resolveClientCapability("solid").toolchain, "vite");
  assert.equal(resolveClientCapability(undefined, undefined).framework, "react");
  assert.equal(clientFrameworkCapability("inferno").build.jsxFactory, "createElement");
  assert.deepEqual(clientCapabilityError("lit", "esbuild"), {
    message: "Unsupported client framework/toolchain combination: lit/esbuild",
    hint: "Use Lit with Vite.",
  });
  assert.throws(() => { CLIENT_CAPABILITIES[0].build.entry = "owned.ts"; }, TypeError);
  assert.throws(() => { CLIENT_CAPABILITIES[0].templates.push("owned"); }, TypeError);
});

test("unsupported matrix cells and replacement frameworks remain structurally absent", () => {
  for (const [framework, toolchain] of [["vanilla", "vite"], ["vue", "esbuild"], ["svelte", "esbuild"], ["solid", "esbuild"], ["lit", "esbuild"], ["angular", "vite"], ["next", "vite"], ["nuxt", "vite"]]) assert.equal(supportsClientCapability(framework, toolchain), false, `${framework}/${toolchain}`);
});

test("the user-guide capability table is derived-data checked against the runtime matrix", async () => {
  const guide = await readFile(new URL("../docs/guide/reference.md", import.meta.url), "utf8");
  for (const framework of CLIENT_FRAMEWORKS) {
    const cells = CLIENT_CAPABILITIES.filter((cell) => cell.framework === framework);
    const primary = cells.find((cell) => cell.default);
    const also = cells.filter((cell) => !cell.default).map((cell) => cell.toolchain === "vite" ? "Vite" : cell.toolchain).join(", ") || "—";
    const toolchain = primary.toolchain === "vite" ? "Vite" : primary.toolchain;
    assert(guide.includes(`| ${primary.label} | ${toolchain} | ${also} | ${CLIENT_TEMPLATES.join(", ")} |`), `${framework} documentation row`);
  }
});
