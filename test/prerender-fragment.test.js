import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createBundle } from "../dist/bundle-pipeline.js";
import { placeClientPrerenderFragment, renderClientPrerenderFragment } from "../dist/client-prerender.js";
import { readProjectConfig } from "../dist/cli/project-config.js";
import { validateClientToolchainInput } from "../dist/client-toolchain.js";
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

const viteConfig = {
  framework: "react",
  toolchain: "vite",
  prerender: [{ name: "landing", module: "render-landing.mjs" }],
};

test("fallback placement finds the real opening body without rewriting surrounding HTML", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  const cases = [
    {
      source: '<!doctype html><html><head></head><body data-label="a > b" class=\'shell\'><p>page</p></body></html>\n',
      expected: `<!doctype html><html><head></head><body data-label="a > b" class='shell'>${bounded}<p>page</p></body></html>\n`,
    },
    {
      source: '<!doctype html><html><head><!-- <body data-decoy="comment"> --></head><body class="shell"><p>page</p></body></html>\n',
      expected: `<!doctype html><html><head><!-- <body data-decoy="comment"> --></head><body class="shell">${bounded}<p>page</p></body></html>\n`,
    },
    {
      source: '<!doctype html><html><head><script>const template = "<body data-decoy=\'script\'>";</script></head><body class="shell"><p>page</p></body></html>\n',
      expected: `<!doctype html><html><head><script>const template = "<body data-decoy='script'>";</script></head><body class="shell">${bounded}<p>page</p></body></html>\n`,
    },
  ];

  for (const fixture of cases) {
    assert.equal(placeClientPrerenderFragment(fixture.source, fragment, rendered), fixture.expected);
  }
});

test("fallback placement keeps Unicode byte offsets while matching HTML tags case-insensitively", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  const source = '<!doctype html><HTML><HEAD><TITLE>İstanbul & CAFÉ</TITLE></HEAD><BoDy data-label="A > B"><p>page</p></bOdY></HTML>\n';
  const expected = `<!doctype html><HTML><HEAD><TITLE>İstanbul & CAFÉ</TITLE></HEAD><BoDy data-label="A > B">${bounded}<p>page</p></bOdY></HTML>\n`;

  assert.equal(placeClientPrerenderFragment(source, fragment, rendered), expected);
});

test("named prerender markers replace only HTML comment nodes outside raw text", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const marker = "<!-- sporades:prerender landing -->";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  const source = `<!doctype html><html><head><script>const marker = ${JSON.stringify(marker)};</script><style>.shell::before { content: ${JSON.stringify(marker)}; }</style></head><body>${marker}<p>between</p>${marker}</body></html>\n`;
  const expected = `<!doctype html><html><head><script>const marker = ${JSON.stringify(marker)};</script><style>.shell::before { content: ${JSON.stringify(marker)}; }</style></head><body>${bounded}<p>between</p>${bounded}</body></html>\n`;

  assert.equal(placeClientPrerenderFragment(source, fragment, rendered), expected);
});

test("fallback scanning recovers abrupt comments and rejects unterminated constructs", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const marker = "<!-- sporades:prerender landing -->";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  for (const abruptComment of ["<!-->", "<!--->", "<!-- stale --!>"]) {
    const source = `<!doctype html><html><head>${abruptComment}</head><body>${marker}<p>page</p></body></html>\n`;
    const expected = `<!doctype html><html><head>${abruptComment}</head><body>${bounded}<p>page</p></body></html>\n`;
    assert.equal(placeClientPrerenderFragment(source, fragment, rendered), expected, abruptComment);
  }
  assert.throws(
    () => placeClientPrerenderFragment("<html><body><!-- unterminated", fragment, rendered),
    /unterminated HTML comment/i,
  );
  assert.throws(
    () => placeClientPrerenderFragment("<html><body><script>const open = true;", fragment, rendered),
    /unterminated raw text element: script/i,
  );
});

test("fallback scanning rejects unterminated tags and declarations before insertion", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  for (const [source, message] of [
    ['<html><body><div class="unterminated', /unterminated HTML tag/i],
    ["<html><body><!doctype", /unterminated HTML declaration/i],
    ["<html><body><?processing", /unterminated HTML declaration/i],
  ]) {
    assert.throws(() => placeClientPrerenderFragment(source, fragment, rendered), message, source);
  }
});

test("a prerender module can use a local CommonJS dependency that requires a Node builtin", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const dependencyDir = path.join(projectDir, "node_modules", "renderer-cjs");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(path.join(dependencyDir, "package.json"), '{"name":"renderer-cjs","main":"index.cjs"}\n');
    await writeFile(
      path.join(dependencyDir, "index.cjs"),
      'const { format } = require("node:util");\nmodule.exports = () => format("<main>%s</main>", "CJS builtin works");\n',
    );
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "renderer-cjs";\nexport default () => render();\n',
    );

    const bundle = await createBundle(projectDir, { name: "cjs-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /<main>CJS builtin works<\/main>/);
      const files = await publicFiles(bundle.staticFiles.publicDir);
      assert.equal(files.some((file) => /renderer|renderer-cjs/.test(file)), false, JSON.stringify(files));
      await assert.rejects(access(path.join(projectDir, ".sporades-prerender-output")), (error) => error.code === "ENOENT");
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("a transitive ESM prerender module retains its own import.meta.url", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const rendererDir = path.join(projectDir, "renderer");
    const helperDir = path.join(rendererDir, "helper");
    await mkdir(helperDir, { recursive: true });
    await writeFile(
      path.join(rendererDir, "render-landing.mjs"),
      'import { renderAdjacent } from "./helper/render-adjacent.mjs";\nexport default renderAdjacent;\n',
    );
    await writeFile(
      path.join(helperDir, "render-adjacent.mjs"),
      'import { readFile } from "node:fs/promises";\nexport async function renderAdjacent() {\n  const content = await readFile(new URL("./content.txt", import.meta.url), "utf8");\n  return `<main>${content.trim()}</main>`;\n}\n',
    );
    await writeFile(path.join(helperDir, "content.txt"), "transitive import.meta.url works\n");
    const config = structuredClone(viteConfig);
    config.prerender[0].module = "renderer/render-landing.mjs";

    const bundle = await createBundle(projectDir, { name: "esm-import-meta-prerender", client: config }, { publishLegacy: false });
    try {
      const emittedHtml = await readFile(bundle.staticFiles.indexHtml, "utf8");
      assert.match(emittedHtml, /<main>transitive import\.meta\.url works<\/main>/);
      assert.equal(await readFile(path.join(projectDir, "index.html"), "utf8"), sourceHtml);
      assert.equal((await publicFiles(bundle.staticFiles.publicDir)).some((file) => /renderer|content\.txt/.test(file)), false);
      await assert.rejects(access(path.join(projectDir, ".sporades-prerender-output")), (error) => error.code === "ENOENT");
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("TypeScript renderer import.meta.url preserves project tsconfig semantics", async () => {
  await withTempDir(async (projectDir) => {
    await writeFile(path.join(projectDir, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    }, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "render-landing.ts"),
      `function legacyField(target: object, propertyKey: string) {
  if (!target || propertyKey !== "message") throw new Error("project tsconfig decorator semantics lost");
}
class ViewModel {
  @legacyField
  message = "project tsconfig preserved";
}
export default () => \`<main>\${new ViewModel().message}:\${new URL(".", import.meta.url).protocol}</main>\`;
`,
    );
    const fragment = { name: "landing", module: "render-landing.ts" };
    const canonicalProject = await realpath(projectDir);

    assert.equal(
      await renderClientPrerenderFragment(canonicalProject, fragment),
      "<main>project tsconfig preserved:file:</main>",
    );
  });
});

test("TypeScript renderer import.meta.url discovers nearest extended tsconfig", async () => {
  await withTempDir(async (projectDir) => {
    const rendererDir = path.join(projectDir, "renderer");
    await mkdir(rendererDir);
    await writeFile(path.join(projectDir, "tsconfig.base.json"), `${JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
        verbatimModuleSyntax: true,
      },
    }, null, 2)}\n`);
    await writeFile(path.join(rendererDir, "tsconfig.json"), `${JSON.stringify({ extends: "../tsconfig.base.json" }, null, 2)}\n`);
    const sideEffectFlag = `__sporades_extended_tsconfig_${path.basename(projectDir).replace(/[^A-Za-z0-9_]/g, "_")}`;
    await writeFile(
      path.join(rendererDir, "side-effect.mjs"),
      `globalThis[${JSON.stringify(sideEffectFlag)}] = true;\nexport const registration = true;\n`,
    );
    await writeFile(
      path.join(rendererDir, "render-landing.ts"),
      `import { registration } from "./side-effect.mjs";
function legacyField(target: object, propertyKey: string) {
  if (!target || propertyKey !== "message") throw new Error("nearest extended tsconfig semantics lost");
}
class ViewModel {
  @legacyField
  message = "nearest extended tsconfig preserved";
}
export default () => {
  const importPreserved = (globalThis as any)[${JSON.stringify(sideEffectFlag)}] === true;
  delete (globalThis as any)[${JSON.stringify(sideEffectFlag)}];
  return \`<main>\${new ViewModel().message}:\${new URL(".", import.meta.url).protocol}:\${importPreserved}</main>\`;
};
`,
    );
    const canonicalProject = await realpath(projectDir);

    assert.equal(
      await renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "renderer/render-landing.ts" }),
      "<main>nearest extended tsconfig preserved:file::true</main>",
    );
  });
});

test("renderer import.meta.url failures redact encoded project URL forms", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9 space#percent% capsule");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, "render-landing.mjs"), "export default () => { throw new Error(import.meta.url); };\n");
    const canonicalProject = await realpath(projectDir);
    const encodedAliases = [...new Set([projectDir, canonicalProject].flatMap((root) => [root.normalize("NFC"), root.normalize("NFD")]).flatMap((root) => {
      const url = pathToFileURL(root);
      return [url.href, url.pathname];
    }))];

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, viteConfig.prerender[0], [projectDir, canonicalProject]),
      (error) => {
        assert.match(error.message, /renderer for landing failed: <project>\/render-landing\.mjs/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack, cause: error.cause });
        for (const alias of encodedAliases) assert.equal(surfaced.includes(alias), false, `leaked encoded Capsule URL alias: ${alias}`);
        assert.doesNotMatch(surfaced, /caf%C3%A9|%20space|%23percent|%25%20capsule/i);
        return true;
      },
    );
  });
});

test("runtime renderer dependency failures redact Capsule path aliases", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9-capsule");
    const projectAlias = path.join(dir, "capsule-alias");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await symlink(projectDir, projectAlias, "dir");
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `const missing = process.env.SPORADES_TEST_MISSING_RENDERER_DEPENDENCY || "./missing-runtime-dependency.cjs";
export default () => require(missing);
`,
    );
    const canonicalProject = await realpath(projectDir);
    const aliases = new Set([projectAlias, projectDir, canonicalProject].flatMap((root) => [
      root,
      root.normalize("NFC"),
      root.normalize("NFD"),
      root.replaceAll("\\", "/"),
      root.replaceAll("/", "\\"),
    ]));

    await assert.rejects(
      createBundle(projectAlias, { name: "runtime-require-failure", client: structuredClone(viteConfig) }),
      (error) => {
        assert.match(error.message, /Cannot find module.*missing-runtime-dependency\.cjs/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        for (const alias of aliases) assert.equal(surfaced.includes(alias), false, `leaked Capsule path alias: ${alias}`);
        return true;
      },
    );
  });
});

test("renderer-owned hints and diagnostics cannot bypass bounded path redaction", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9-hinted-capsule");
    const projectAlias = path.join(dir, "hinted-capsule-alias");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await symlink(projectDir, projectAlias, "dir");
    const canonicalProject = await realpath(projectDir);
    const aliases = [...new Set([projectAlias, projectDir, canonicalProject].flatMap((root) => [
      root,
      root.normalize("NFC"),
      root.normalize("NFD"),
      root.replaceAll("\\", "/"),
      root.replaceAll("/", "\\"),
    ]))];
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `const aliases = ${JSON.stringify(aliases)};
export default () => {
  const error = new Error(\`hostile renderer at \${aliases[0]}\`);
  error.hint = \`hostile hint at \${aliases[1]}\`;
  error.diagnostics = { hostilePath: aliases[2], nested: { path: aliases[3] } };
  error.cause = new Error(\`hostile cause at \${aliases[4]}\`);
  error.stack += \`\\nhostile stack at \${aliases[5]}\`;
  throw error;
};
`,
    );

    await assert.rejects(
      createBundle(projectAlias, { name: "hinted-renderer-failure", client: structuredClone(viteConfig) }),
      (error) => {
        assert.match(error.message, /renderer for landing failed: hostile renderer at <project>/i);
        assert.match(error.hint, /fix the renderer in render-landing\.mjs/i);
        assert.doesNotMatch(error.hint, /hostile hint/i);
        assert.deepEqual(error.diagnostics, { fragment: "landing", module: "render-landing.mjs" });
        assert.equal(error.cause, undefined);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack, cause: error.cause });
        assert.doesNotMatch(surfaced, /hostile (?:hint|cause|stack)|hostilePath/);
        for (const alias of aliases) assert.equal(surfaced.includes(alias), false, `leaked Capsule path alias: ${alias}`);
        return true;
      },
    );
  });
});

test("hostile message access cannot escape the renderer error boundary", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9-hostile-message-capsule");
    const projectAlias = path.join(dir, "hostile-message-capsule-alias");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await symlink(projectDir, projectAlias, "dir");
    const canonicalProject = await realpath(projectDir);
    const aliases = [...new Set([projectAlias, projectDir, canonicalProject].flatMap((root) => [
      root,
      root.normalize("NFC"),
      root.normalize("NFD"),
      root.replaceAll("\\", "/"),
      root.replaceAll("/", "\\"),
    ]))];
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `const aliases = ${JSON.stringify(aliases)};
export default () => {
  const thrown = { hint: \`outer hostile hint at \${aliases[0]}\` };
  Object.defineProperty(thrown, "message", {
    get() {
      const nested = new Error(\`nested hostile message at \${aliases[1]}\`);
      nested.hint = \`nested hostile hint at \${aliases[2]}\`;
      nested.diagnostics = { path: aliases[3] };
      nested.cause = new Error(\`nested hostile cause at \${aliases[4]}\`);
      throw nested;
    },
  });
  throw thrown;
};
`,
    );

    await assert.rejects(
      createBundle(projectAlias, { name: "hostile-message-failure", client: structuredClone(viteConfig) }),
      (error) => {
        assert.match(error.message, /renderer for landing failed: thrown error message unavailable/i);
        assert.match(error.hint, /fix the renderer in render-landing\.mjs/i);
        assert.deepEqual(error.diagnostics, { fragment: "landing", module: "render-landing.mjs" });
        assert.equal(error.cause, undefined);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack, cause: error.cause });
        assert.doesNotMatch(surfaced, /(?:outer|nested) hostile|hostile-message-capsule/);
        for (const alias of aliases) assert.equal(surfaced.includes(alias), false, `leaked Capsule path alias: ${alias}`);
        return true;
      },
    );
  });
});

test("prerender placement preserves replacement-pattern dollar sequences byte for byte", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'export default () => "<main>$&amp;|$\'|$`|$$|literal dollars</main>";\n',
    );

    const bundle = await createBundle(projectDir, { name: "dollar-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      const emittedHtml = await readFile(bundle.staticFiles.indexHtml, "utf8");
      assert.match(emittedHtml, /<main>\$&amp;\|\$'\|\$`\|\$\$\|literal dollars<\/main>/);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("one configured Vite prerender fragment reaches the normalized public tree", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(projectDir, "render-landing.mjs"), 'export default () => "<main><h1>Useful before JavaScript</h1></main>";\n');
    const config = { name: "prerender-capsule", client: structuredClone(viteConfig) };
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
    const multipleConfig = structuredClone(config);
    multipleConfig.client.prerender.push({ name: "footer", module: "render-footer.mjs" });
    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(multipleConfig, null, 2)}\n`);
    await assert.rejects(readProjectConfig(projectDir), (error) => {
      assert.match(error.message, /supports one configured prerender fragment/i);
      assert.match(error.hint, /ordered multi-fragment builds are not available yet/i);
      return true;
    });
    for (const invalidModule of [
      "../escape.mjs",
      "./dot.mjs",
      "/absolute.mjs",
      "D:drive-relative.mjs",
      "D:/drive-qualified.mjs",
      "//server/share/renderer.mjs",
      "//?/D:/device-renderer.mjs",
      "nested\\windows.mjs",
      "\\\\server\\share\\renderer.mjs",
      "\\\\?\\D:\\device-renderer.mjs",
    ]) {
      const invalidConfig = structuredClone(config);
      invalidConfig.client.prerender[0].module = invalidModule;
      await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(invalidConfig, null, 2)}\n`);
      await assert.rejects(readProjectConfig(projectDir), (error) => {
        assert.match(error.message, /invalid client prerender module for landing/i);
        assert.match(error.hint, /project-relative module path/i);
        return true;
      }, invalidModule);
    }
    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify(config, null, 2)}\n`);
    assert.throws(() => validateClientToolchainInput({
      frameworkConfig: { framework: "react", entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" },
      toolchain: "esbuild",
      indexHtml: '<script type="module" src="/client/index.tsx"></script>',
      prerender: config.client.prerender,
    }), /prerender fragments require the Vite client toolchain/i);

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
      `export default async (...args) => {
  const leaked = [
    args.length ? "runtime-context-injected" : null,
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
    assert.doesNotMatch(publicOutput, /runtime-context-injected|project-env-secret|project-local-env-secret|server-env-secret|PRERENDER_SERVER_SECRET/);

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
      {
        label: "non-function default export",
        module: "render-landing.mjs",
        source: 'export default "not a renderer";\n',
        message: /must default-export a zero-argument renderer/,
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

    const externalRenderer = path.join(path.dirname(projectDir), `external-renderer-${path.basename(projectDir)}.mjs`);
    await writeFile(externalRenderer, 'export default () => "<p>escaped</p>";\n');
    await symlink(externalRenderer, path.join(projectDir, "symlink-renderer.mjs"));
    config.client.prerender[0].module = "symlink-renderer.mjs";
    try {
      await assert.rejects(createBundle(projectDir, config), (error) => {
        assert.match(error.message, /could not load client prerender module for landing/i);
        assert.doesNotMatch(JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics }), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
      assert.deepEqual((await readdir(treesDir)).sort(), treeState, "symlink module failure created partial public output");
      assert.equal(await readFile(published.staticFiles.indexHtml, "utf8"), activeHtml, "symlink module failure replaced the active public tree");
    } finally {
      await rm(externalRenderer, { force: true });
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
