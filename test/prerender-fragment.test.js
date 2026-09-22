import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createBundle } from "../dist/bundle-pipeline.js";
import { placeClientPrerenderFragment, rendererTransformOutputLoader, renderClientPrerenderFragment } from "../dist/client-prerender.js";
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

test("precompiled renderer output uses only honest JavaScript-family loaders", () => {
  assert.deepEqual(
    ["js", "jsx", "ts", "tsx"].map((loader) => rendererTransformOutputLoader(loader)),
    ["js", "jsx", "js", "jsx"],
  );
});

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

test("marker scanning treats noscript content as raw text when scripting is enabled", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const marker = "<!-- sporades:prerender landing -->";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  const noscript = `<NoScRiPt data-copy="a > b">${marker}</nOsCrIpT>`;

  assert.equal(
    placeClientPrerenderFragment(`<html><body>${noscript}<p>${marker}</p></body></html>`, fragment, rendered),
    `<html><body>${noscript}<p>${bounded}</p></body></html>`,
  );
  assert.equal(
    placeClientPrerenderFragment(`<html><body class="shell">${noscript}<p>page</p></body></html>`, fragment, rendered),
    `<html><body class="shell">${bounded}${noscript}<p>page</p></body></html>`,
  );
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

test("marker scanning preserves less-than text and bounds bogus HTML constructs", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const marker = "<!-- sporades:prerender landing -->";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  for (const text of ["1 < 2", "<3", "a<b"]) {
    const source = `<html><body>${text}${marker}<p>page</p></body></html>`;
    const expected = `<html><body>${text}${bounded}<p>page</p></body></html>`;
    assert.equal(placeClientPrerenderFragment(source, fragment, rendered), expected, text);
  }
  for (const bogus of ['<!x " >', '<? " >', '</3 " >']) {
    const source = `<html><body>${bogus}${marker}tail"><p>page</p></body></html>`;
    const expected = `<html><body>${bogus}${bounded}tail"><p>page</p></body></html>`;
    assert.equal(placeClientPrerenderFragment(source, fragment, rendered), expected, bogus);
  }
});

test("marker scanning distinguishes prose quotes, malformed raw tags, and HTML CDATA declarations", () => {
  const fragment = { name: "landing", module: "render-landing.mjs" };
  const rendered = "<main>static fragment</main>";
  const marker = "<!-- sporades:prerender landing -->";
  const bounded = "<!-- sporades:prerender-boundary-start landing --><main>static fragment</main><!-- sporades:prerender-boundary-end landing -->";
  for (const prefix of [
    "<html><body><p>x<y isn't true.</p>",
    '<html><body><p>x<y "is not" true.</p>',
    '<html><body><p data-claim = "x < y > z">quoted attribute</p>',
  ]) {
    const suffix = "<p>Don't forget: 3 > 2</p></body></html>";
    assert.equal(
      placeClientPrerenderFragment(`${prefix}${marker}${suffix}`, fragment, rendered),
      `${prefix}${bounded}${suffix}`,
      prefix,
    );
  }
  assert.throws(
    () => placeClientPrerenderFragment(`<html><body>x<script src=a<b>${marker}</script></body></html>`, fragment, rendered),
    /malformed raw text element opener: script/i,
  );
  const cdataPrefix = "<html><body><![CDATA[declaration boundary >";
  const cdataSuffix = " tail]]><p>page</p></body></html>";
  assert.equal(
    placeClientPrerenderFragment(`${cdataPrefix}${marker}${cdataSuffix}`, fragment, rendered),
    `${cdataPrefix}${bounded}${cdataSuffix}`,
  );
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

test("CommonJS prerender helpers keep static TypeScript sibling requires in the esbuild graph", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(projectDir, "tsconfig.json"), '{"compilerOptions":{"jsx":"react","jsxFactory":"h"}}\n');
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const view = require("./view.tsx");
const resolved = require.resolve("./view.tsx");
const shadowed = (() => { const require = (value) => value; return require("shadowed require"); })();
const untouched = "require(not-code)"; // require(notCodeEither)
module.exports = () => \`<main>\${view.content}|\${require("node:path").basename(resolved)}|\${shadowed}|\${untouched}</main>\`;
`,
    );
    await writeFile(
      path.join(nestedDir, "view.tsx"),
      'function h(tag: string, _props: unknown, ...children: string[]) { return { tag, children }; }\nconst view = <strong>static TSX sibling</strong>;\nexport const content = `${view.tag}:${view.children.join("")}`;\n',
    );

    const bundle = await createBundle(projectDir, { name: "cjs-static-tsx-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>strong:static TSX sibling\|view\.tsx\|shadowed require\|require\(not-code\)<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("TypeScript CommonJS prerender helpers keep static TypeScript sibling requires in the esbuild graph", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cts";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cts"),
      'import card = require("./card.ts");\nconst resolved: string = require.resolve("./card.ts");\nmodule.exports = () => `<main>${card.content}|${require("node:path").basename(resolved)}</main>`;\n',
    );
    await writeFile(
      path.join(nestedDir, "card.ts"),
      'enum CardState { Ready = "static TS sibling" }\nexport const content = CardState.Ready;\n',
    );

    const bundle = await createBundle(projectDir, { name: "cts-static-ts-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /<main>static TS sibling\|card\.ts<\/main>/);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("named class expression bindings shield local CommonJS-like identifiers", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const path = require("node:path");
const Resolver = class require {
  static resolve(value) { return value; }
  static value() { return require.resolve("class-local"); }
};
const DirectoryName = class __dirname {
  static value() { return __dirname === DirectoryName ? "directory-class-local" : "directory-class-rewritten"; }
};
const FileName = class __filename {
  static value() { return __filename === FileName ? "file-class-local" : "file-class-rewritten"; }
};
function nested(require) {
  return class NestedResolver {
    static value() { return require.resolve("nested-function-class"); }
  }.value();
}
module.exports = () => \`<main>\${Resolver.value()}|\${DirectoryName.value()}|\${FileName.value()}|\${nested({ resolve: (value) => value })}|\${path.basename(__dirname)}</main>\`;
`,
    );

    const bundle = await createBundle(projectDir, { name: "class-scope-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>class-local\|directory-class-local\|file-class-local\|nested-function-class\|nested<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("for and switch lexical bindings do not hide the module CommonJS require", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const observed = [];
for (let require = { resolve: (value) => \`for:\${value}\` }, index = 0; index < 1; observed.push(require.resolve("update")), index++) {
  observed.push(require.resolve("body"));
}
for (const require of [{ resolve: (value) => \`of:\${value}\` }]) observed.push(require.resolve("value"));
for (const key in { item: true }) {
  const require = { resolve: (value) => \`in:\${value}\` };
  observed.push(require.resolve(key));
}
switch ("go") {
  case "go":
    const require = { resolve: (value) => \`switch:\${value}\` };
    observed.push(require.resolve("case"));
    break;
  default:
    break;
}
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
const adjacent = require(target);
module.exports = () => \`<main>\${observed.join("|")}|\${adjacent}</main>\`;
`,
    );
    await writeFile(path.join(nestedDir, "adjacent.cjs"), 'module.exports = "module-local dynamic require";\n');

    const bundle = await createBundle(projectDir, { name: "lexical-scope-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>for:body\|for:update\|of:value\|in:item\|switch:case\|module-local dynamic require<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("CommonJS wrapper writes remain valid assignment targets with local semantics", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `module.exports = () => {
  const observed = [];
  ({ __dirname } = { __dirname: "shorthand" });
  observed.push(__dirname);
  ({ value: __dirname } = { value: "renamed" });
  observed.push(__dirname);
  [__dirname] = ["array"];
  observed.push(__dirname);
  [...__dirname] = ["r", "e", "s", "t"];
  observed.push(__dirname.join(""));
  [__dirname = "default"] = [undefined];
  observed.push(__dirname);
  __dirname = "direct";
  __dirname += "-compound";
  observed.push(__dirname);
  __dirname = 1;
  __dirname++;
  observed.push(String(__dirname));
  for (__dirname of ["for-of"]) {}
  observed.push(__dirname);
  for (__dirname in { "for-in": true }) {}
  observed.push(__dirname);

  ({ __filename } = { __filename: "filename-shorthand" });
  ({ value: __filename } = { value: "filename-renamed" });
  __filename += "-compound";
  observed.push(__filename);
  __filename = 1;
  ++__filename;
  observed.push(String(__filename));
  for (__filename of ["filename-for-of"]) {}
  observed.push(__filename);

  ({ require } = { require: { resolve: (value) => \`local:\${value}\` } });
  observed.push(require.resolve("shorthand"));
  ({ value: require } = { value: { resolve: (value) => \`renamed:\${value}\` } });
  observed.push(require.resolve("require"));
  require = { resolve: (value) => \`direct:\${value}\` };
  observed.push(require.resolve("require"));
  return \`<main>\${observed.join("|")}</main>\`;
};
`,
    );

    const bundle = await createBundle(projectDir, { name: "wrapper-write-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>shorthand\|renamed\|array\|rest\|default\|direct-compound\|2\|for-of\|for-in\|filename-renamed-compound\|2\|filename-for-of\|local:shorthand\|renamed:require\|direct:require<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("deleting CommonJS location wrappers stays false without changing later reads", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const path = require("node:path");
module.exports = async () => {
  const deletedDirectory = delete __dirname;
  const deletedFilename = delete __filename;
  const type = typeof __dirname;
  const voided = void __filename;
  const awaitedDirectory = await __dirname;
  function* filenames() { yield __filename; }
  const yieldedFilename = filenames().next().value;
  return \`<main>\${deletedDirectory}|\${deletedFilename}|\${type}|\${voided === undefined}|\${path.basename(awaitedDirectory)}|\${path.basename(yieldedFilename)}|\${path.basename(__dirname)}|\${path.basename(__filename)}</main>\`;
};
`,
    );

    const bundle = await createBundle(projectDir, { name: "wrapper-delete-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>false\|false\|string\|true\|nested\|helper\.cjs\|nested\|helper\.cjs<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("class member names and labels stay literal while computed keys read CommonJS locations", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `class Fields {
  __dirname = "instance-field";
  static __filename = "static-field";
  [__filename] = "computed-instance-field";
  static [__dirname] = "computed-static-field";
}
class Methods {
  __dirname() { return "instance-method"; }
  static __filename() { return "static-method"; }
  [__filename]() { return "computed-instance-method"; }
  static [__dirname]() { return "computed-static-method"; }
}
class Accessors {
  get __dirname() { return "instance-getter"; }
  set __filename(value) { this.setterValue = value; }
  static get require() { return "static-getter"; }
  static set __dirname(value) { this.setterValue = value; }
  get [__filename]() { return "computed-getter"; }
}
module.exports = () => {
  const observed = [];
  __dirname: for (let index = 0; index < 1; index++) { observed.push("break-label"); break __dirname; }
  __filename: for (let index = 0; index < 1; index++) { observed.push("continue-label"); continue __filename; }
  require: { observed.push("require-label"); break require; }
  const fields = new Fields();
  const methods = new Methods();
  const accessors = new Accessors();
  accessors.__filename = "instance-setter";
  Accessors.__dirname = "static-setter";
  observed.push(
    fields.__dirname,
    Fields.__filename,
    fields[__filename],
    Fields[__dirname],
    methods.__dirname(),
    Methods.__filename(),
    methods[__filename](),
    Methods[__dirname](),
    accessors.__dirname,
    accessors.setterValue,
    Accessors.require,
    Accessors.setterValue,
    accessors[__filename],
  );
  return \`<main>\${observed.join("|")}</main>\`;
};
`,
    );

    const bundle = await createBundle(projectDir, { name: "member-key-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>break-label\|continue-label\|require-label\|instance-field\|static-field\|computed-instance-field\|computed-static-field\|instance-method\|static-method\|computed-instance-method\|computed-static-method\|instance-getter\|instance-setter\|static-getter\|static-setter\|computed-getter<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("a nested CommonJS prerender helper keeps per-module paths and computed require", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const path = require("node:path");
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
module.exports = () => {
  const adjacent = require(target);
  const locations = { __dirname, __filename };
  const labels = { __dirname: "directory-key", __filename: "filename-key" };
  return \`<main>\${path.basename(locations.__dirname)}|\${path.basename(locations.__filename)}|\${labels.__dirname}|\${labels.__filename}|\${path.basename(adjacent.filename)}|\${adjacent.cached}|\${adjacent.content}</main>\`;
};
`,
    );
    await writeFile(
      path.join(nestedDir, "adjacent.cjs"),
      'const fs = require("node:fs");\nconst path = require("node:path");\nmodule.exports = { filename: __filename, cached: Boolean(require.cache[__filename]), content: fs.readFileSync(path.join(__dirname, "content.txt"), "utf8").trim() };\n',
    );
    await writeFile(path.join(nestedDir, "content.txt"), "adjacent CommonJS content\n");

    const bundle = await createBundle(projectDir, { name: "nested-cjs-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>nested\|helper\.cjs\|directory-key\|filename-key\|adjacent\.cjs\|true\|adjacent CommonJS content<\/main>/,
      );
      const cache = createRequire(import.meta.url).cache;
      const canonicalProjectDir = await realpath(projectDir);
      assert.equal(Object.keys(cache).some((file) => file.startsWith(canonicalProjectDir)), false, "renderer dependencies remained in the CommonJS cache");
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("CommonJS helper injection preserves hashbangs and directive prologues", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `#!/usr/bin/env node
"use strict";
"sporades fixture directive";
// The helper belongs after this complete prologue and its trivia.
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
const adjacent = require(target);
const resolved = require.resolve("./adjacent.cjs");
function plainCall() { return this === undefined; }
module.exports = () => \`<main>\${plainCall()}|\${adjacent}|\${resolved.endsWith("/renderer/nested/adjacent.cjs")}</main>\`;
`,
    );
    await writeFile(path.join(nestedDir, "adjacent.cjs"), 'module.exports = "module-local hashbang require";\n');

    const bundle = await createBundle(projectDir, { name: "hashbang-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>true\|module-local hashbang require\|true<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("default-package CommonJS JavaScript helpers keep module-local wrapper semantics", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(projectDir, "package.json"), '{}\n');
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.js";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.js"),
      `const path = require("node:path");
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
module.exports = () => \`<main>\${path.basename(__dirname)}|\${path.basename(__filename)}|\${require(target)}</main>\`;
`,
    );
    await writeFile(path.join(nestedDir, "adjacent.cjs"), 'module.exports = "default-package CommonJS";\n');

    const bundle = await createBundle(projectDir, { name: "default-js-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>nested\|helper\.js\|default-package CommonJS<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("nested CommonJS package boundaries specialize JSX helpers", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(projectDir, "tsconfig.json"), '{"compilerOptions":{"jsx":"react","jsxFactory":"h"}}\n');
    const nestedDir = path.join(projectDir, "renderer", "common", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(projectDir, "renderer", "common", "package.json"), '{"type":"commonjs"}\n');
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/common/nested/helper.jsx";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.jsx"),
      `const path = require("node:path");
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
function h(tag, _props, ...children) { return { tag, children }; }
const view = <strong>nested JSX CommonJS</strong>;
module.exports = () => \`<main>\${path.basename(__dirname)}|\${path.basename(__filename)}|\${view.tag}:\${view.children.join("")}|\${require(target)}</main>\`;
`,
    );
    await writeFile(path.join(nestedDir, "adjacent.cjs"), 'module.exports = "nested package boundary";\n');

    const bundle = await createBundle(projectDir, { name: "nested-jsx-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>nested\|helper\.jsx\|strong:nested JSX CommonJS\|nested package boundary<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("module-package JavaScript helpers retain ESM import.meta.url semantics", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.js";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.js"),
      'import { readFile } from "node:fs/promises";\nexport default async () => `<main>${(await readFile(new URL("./content.txt", import.meta.url), "utf8")).trim()}</main>`;\n',
    );
    await writeFile(path.join(nestedDir, "content.txt"), "ESM JavaScript package boundary\n");

    const bundle = await createBundle(projectDir, { name: "esm-js-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /<main>ESM JavaScript package boundary<\/main>/);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("type-less JavaScript helpers use ESM syntax detection without string false positives", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(projectDir, "package.json"), '{}\n');
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.js";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.js"),
      `import { readFile } from "node:fs/promises";
const misleading = "require(dynamic) __dirname __filename"; // export default and import.meta are syntax only outside this comment.
const awaited = await Promise.resolve("type-less ESM syntax");
export default async () => \`<main>\${awaited}|\${misleading.length > 0}|\${(await readFile(new URL("./content.txt", import.meta.url), "utf8")).trim()}</main>\`;
`,
    );
    await writeFile(path.join(nestedDir, "content.txt"), "module-local import.meta.url\n");

    const bundle = await createBundle(projectDir, { name: "typeless-esm-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>type-less ESM syntax\|true\|module-local import\.meta\.url<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("top-level-await renderer worker exit fails instead of hanging", async () => {
  await withTempDir(async (projectDir) => {
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `await Promise.resolve();
export default () => {
  process.exit(0);
};
`,
    );
    let timeout;
    const canonicalProject = await realpath(projectDir);
    const render = renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" });
    const boundedRender = Promise.race([
      render,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for renderer worker exit")), 500);
      }),
    ]).finally(() => clearTimeout(timeout));

    await assert.rejects(
      boundedRender,
      (error) => {
        assert.match(error.message, /renderer worker exited before returning a result \(code 0\)/i);
        assert.match(error.hint, /fix the renderer/i);
        return true;
      },
    );
  });
});

test("top-level-await worker preserves renderer result validation", async () => {
  await withTempDir(async (projectDir) => {
    const canonicalProject = await realpath(projectDir);
    const cases = [
      {
        source: "await Promise.resolve();\nexport const value = 1;\n",
        message: /must default-export a zero-argument renderer/i,
      },
      {
        source: "await Promise.resolve();\nexport default () => 42;\n",
        message: /returned a non-string result/i,
      },
    ];
    for (const testCase of cases) {
      await writeFile(path.join(projectDir, "render-landing.mjs"), testCase.source);
      await assert.rejects(
        renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
        testCase.message,
      );
    }
  });
});

test("top-level-await worker failures redact Capsule path aliases", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9 worker capsule");
    const projectAlias = path.join(dir, "worker-alias");
    await mkdir(projectDir);
    await symlink(projectDir, projectAlias, "dir");
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'await Promise.resolve();\nexport default () => { throw new Error(`worker path ${import.meta.url}`); };\n',
    );
    const canonicalProject = await realpath(projectDir);
    const aliases = [projectAlias, projectDir, canonicalProject];

    await assert.rejects(
      renderClientPrerenderFragment(
        canonicalProject,
        { name: "landing", module: "render-landing.mjs" },
        aliases,
      ),
      (error) => {
        assert.match(error.message, /client prerender renderer for landing failed/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        for (const alias of aliases) {
          assert.equal(surfaced.includes(alias), false, `leaked Capsule worker path: ${alias}`);
          assert.equal(surfaced.includes(pathToFileURL(alias).href), false, `leaked Capsule worker URL: ${alias}`);
        }
        return true;
      },
    );
  });
});

test("invalid renderer package metadata is identified without leaking Capsule paths", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "caf\u00e9 package capsule");
    const projectAlias = path.join(dir, "package-alias");
    await mkdir(projectDir);
    await symlink(projectDir, projectAlias, "dir");
    const nestedDir = path.join(projectDir, "renderer", "invalid");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/invalid/helper.js";\nexport default render;\n',
    );
    await writeFile(path.join(nestedDir, "package.json"), '{"type":"commonjs", invalid}\n');
    await writeFile(path.join(nestedDir, "helper.js"), 'module.exports = () => "<main>unreachable</main>";\n');
    const canonicalProject = await realpath(projectDir);
    const aliases = [projectAlias, projectDir, canonicalProject];

    await assert.rejects(
      renderClientPrerenderFragment(
        canonicalProject,
        { name: "landing", module: "render-landing.mjs" },
        aliases,
      ),
      (error) => {
        assert.match(error.message, /invalid renderer package metadata at <project>\/renderer\/invalid\/package\.json/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        for (const alias of aliases) assert.equal(surfaced.includes(alias), false, `leaked Capsule package path: ${alias}`);
        return true;
      },
    );
  });
});

test("package lookup stops at node_modules for a hoisted package without metadata", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await writeFile(path.join(tempRoot, "package.json"), '{"type":"module"}\n');
    const dependencyDir = path.join(tempRoot, "node_modules", "hoisted-default-renderer");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "hoisted-default-renderer";\nexport default render;\n',
    );
    await writeFile(
      path.join(dependencyDir, "index.js"),
      `const path = require("node:path");
const target = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
module.exports = () => \`<main>\${path.basename(__dirname)}|\${path.basename(__filename)}|\${require(target)}</main>\`;
`,
    );
    await writeFile(path.join(dependencyDir, "adjacent.cjs"), 'module.exports = "node_modules default CommonJS";\n');

    const bundle = await createBundle(projectDir, { name: "hoisted-default-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>hoisted-default-renderer\|index\.js\|node_modules default CommonJS<\/main>/,
      );
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("metadata-less hoisted CommonJS modules load without specialization tokens", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const dependencyDir = path.join(tempRoot, "node_modules", "plain-default-renderer");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "plain-default-renderer";\nexport default render;\n',
    );
    await writeFile(
      path.join(dependencyDir, "index.js"),
      'const unchanged = "require __dirname __filename";\nmodule.exports = () => `<main>plain CommonJS|${unchanged.length > 0}</main>`;\n',
    );

    const bundle = await createBundle(projectDir, { name: "plain-hoisted-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /<main>plain CommonJS\|true<\/main>/);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("unresolved absolute renderer imports redact external host paths", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    const externalDir = path.join(tempRoot, "caf\u00e9 external modules");
    await mkdir(projectDir);
    await mkdir(externalDir);
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const canonicalProject = await realpath(projectDir);
    const canonicalExternalDir = await realpath(externalDir);
    const missingModule = path.join(canonicalExternalDir, "missing-renderer-dependency.mjs");
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      `import ${JSON.stringify(missingModule)};\nexport default () => "<main>unreachable</main>";\n`,
    );

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
      (error) => {
        assert.match(error.message, /could not build client prerender module/i);
        assert.match(error.message, /<project>\/missing-renderer-dependency\.mjs/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        assert.equal(surfaced.includes(canonicalExternalDir), false, "leaked unresolved external import directory");
        assert.equal(surfaced.includes(pathToFileURL(canonicalExternalDir).href), false, "leaked unresolved external import URL");
        assert.doesNotMatch(surfaced, /caf(?:é|e%CC%81|%C3%A9)%20external%20modules/i);
        return true;
      },
    );
  });
});

test("hoisted renderer build failures redact dependency paths outside the Capsule", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const dependencyDir = path.join(tempRoot, "node_modules", "broken-default-renderer");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "broken-default-renderer";\nexport default render;\n',
    );
    await writeFile(path.join(dependencyDir, "index.js"), "module.exports = () => <broken;\n");
    const canonicalProject = await realpath(projectDir);
    const canonicalDependency = await realpath(dependencyDir);

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
      (error) => {
        assert.match(error.message, /could not build client prerender module/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        assert.equal(surfaced.includes(canonicalDependency), false, "leaked hoisted dependency path");
        assert.equal(surfaced.includes(tempRoot), false, "leaked hoisted dependency parent path");
        return true;
      },
    );
  });
});

test("hoisted CommonJS runtime failures redact dependency paths outside the Capsule", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const dependencyDir = path.join(tempRoot, "node_modules", "throwing-default-renderer");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "throwing-default-renderer";\nexport default render;\n',
    );
    const dependencyFile = path.join(dependencyDir, "index.js");
    await writeFile(dependencyFile, 'module.exports = () => { throw new Error(`dependency path ${__filename}`); };\n');
    const canonicalProject = await realpath(projectDir);
    const canonicalDependency = await realpath(dependencyFile);

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
      (error) => {
        assert.match(error.message, /client prerender renderer for landing failed/i);
        assert.match(error.message, /dependency path <project>\/index\.js/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        assert.equal(surfaced.includes(canonicalDependency), false, "leaked hoisted CommonJS runtime path");
        return true;
      },
    );
  });
});

test("nested project runtime diagnostics preserve project-relative context", async () => {
  await withTempDir(async (projectDir) => {
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const helperDir = path.join(projectDir, "renderer", "invalid");
    await mkdir(helperDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/invalid/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(helperDir, "helper.cjs"),
      'const { pathToFileURL } = require("node:url");\nmodule.exports = () => { throw new Error("file " + __filename + " url " + pathToFileURL(__filename).href); };\n',
    );
    const canonicalProject = await realpath(projectDir);

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
      (error) => {
        assert.match(
          error.message,
          /file <project>\/renderer\/invalid\/helper\.cjs url <project>\/renderer\/invalid\/helper\.cjs/i,
        );
        return true;
      },
    );
  });
});

test("top-level-await worker runtime failures redact hoisted dependency paths", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const dependencyDir = path.join(tempRoot, "node_modules", "throwing-worker-renderer");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "throwing-worker-renderer";\nawait Promise.resolve();\nexport default render;\n',
    );
    const dependencyFile = path.join(dependencyDir, "index.js");
    await writeFile(dependencyFile, 'module.exports = () => { throw new Error(`worker dependency path ${__filename}`); };\n');
    const canonicalProject = await realpath(projectDir);
    const canonicalDependency = await realpath(dependencyFile);

    await assert.rejects(
      renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "render-landing.mjs" }),
      (error) => {
        assert.match(error.message, /client prerender renderer for landing failed/i);
        const surfaced = JSON.stringify({ message: error.message, hint: error.hint, diagnostics: error.diagnostics, stack: error.stack });
        assert.equal(surfaced.includes(canonicalDependency), false, "leaked hoisted Worker runtime path");
        return true;
      },
    );
  });
});

test("a nested TypeScript CommonJS prerender helper keeps per-module paths and computed require", async () => {
  await withTempDir(async (projectDir) => {
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    const nestedDir = path.join(projectDir, "renderer", "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cts";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cts"),
      `const path = require("node:path");
const target: string = process.argv.length > 0 ? "./adjacent.cjs" : "./missing.cjs";
module.exports = () => {
  const adjacent = require(target);
  return \`<main>\${path.basename(__dirname)}|\${path.basename(__filename)}|\${path.basename(adjacent.filename)}|\${adjacent.cached}|\${adjacent.content}</main>\`;
};
`,
    );
    await writeFile(
      path.join(nestedDir, "adjacent.cjs"),
      'const fs = require("node:fs");\nconst path = require("node:path");\nmodule.exports = { filename: __filename, cached: Boolean(require.cache[__filename]), content: fs.readFileSync(path.join(__dirname, "content.txt"), "utf8").trim() };\n',
    );
    await writeFile(path.join(nestedDir, "content.txt"), "adjacent CTS content\n");

    const bundle = await createBundle(projectDir, { name: "nested-cts-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(
        await readFile(bundle.staticFiles.indexHtml, "utf8"),
        /<main>nested\|helper\.cts\|adjacent\.cjs\|true\|adjacent CTS content<\/main>/,
      );
      const cache = createRequire(import.meta.url).cache;
      const canonicalProjectDir = await realpath(projectDir);
      assert.equal(Object.keys(cache).some((file) => file.startsWith(canonicalProjectDir)), false, "renderer dependencies remained in the CommonJS cache");
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }
  });
});

test("prerender execution removes new project and hoisted CommonJS cache entries after failure or success", async () => {
  await withTempDir(async (tempRoot) => {
    const projectDir = path.join(tempRoot, "capsule");
    const nestedDir = path.join(projectDir, "renderer", "nested");
    const hoistedDir = path.join(tempRoot, "node_modules", "hoisted-renderer");
    const sourceHtml = '<!doctype html><html><head></head><body><!-- sporades:prerender landing --><script type="module" src="/client/index.tsx"></script></body></html>\n';
    await writeMinimalViteCapsule(projectDir, sourceHtml);
    await mkdir(nestedDir, { recursive: true });
    await mkdir(hoistedDir, { recursive: true });
    await writeFile(path.join(hoistedDir, "package.json"), '{"name":"hoisted-renderer","main":"index.cjs"}\n');
    await writeFile(
      path.join(hoistedDir, "index.cjs"),
      'module.exports = { cachedDuringLoad: Boolean(require.cache[__filename]) };\n',
    );
    await writeFile(
      path.join(projectDir, "render-landing.mjs"),
      'import render from "./renderer/nested/helper.cjs";\nexport default render;\n',
    );
    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const target = process.argv.length > 0 ? "hoisted-renderer" : "missing-renderer";
module.exports = () => {
  const dependency = require(target);
  return \`<main>hoisted cache: \${dependency.cachedDuringLoad}</main>\`;
};
`,
    );

    const bundle = await createBundle(projectDir, { name: "hoisted-cache-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false });
    try {
      assert.match(await readFile(bundle.staticFiles.indexHtml, "utf8"), /<main>hoisted cache: true<\/main>/);
      const canonicalHoistedDir = await realpath(hoistedDir);
      assert.equal(Object.keys(createRequire(import.meta.url).cache).some((file) => file.startsWith(canonicalHoistedDir)), false);
    } finally {
      await bundle.releasePublicTreeLease();
      await discardPublicTree(bundle.staticFiles.publicTree);
    }

    await writeFile(
      path.join(nestedDir, "helper.cjs"),
      `const target = process.argv.length > 0 ? "./failure.cjs" : "./missing.cjs";
module.exports = () => {
  const dependency = require(target);
  if (!dependency.cachedDuringLoad) throw new Error("failure dependency was not cached during evaluation");
  throw new Error("expected renderer failure");
};
`,
    );
    await writeFile(path.join(nestedDir, "failure.cjs"), 'module.exports = { cachedDuringLoad: Boolean(require.cache[__filename]) };\n');

    await assert.rejects(
      createBundle(projectDir, { name: "failed-cache-prerender", client: structuredClone(viteConfig) }, { publishLegacy: false }),
      /expected renderer failure/,
    );
    const canonicalProjectDir = await realpath(projectDir);
    assert.equal(Object.keys(createRequire(import.meta.url).cache).some((file) => file.startsWith(canonicalProjectDir)), false);
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

test("TSX renderer import.meta.url applies JSX settings from nearest extended tsconfig", async () => {
  await withTempDir(async (projectDir) => {
    const rendererDir = path.join(projectDir, "renderer");
    const runtimeDir = path.join(rendererDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(projectDir, "tsconfig.base.json"), `${JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "./runtime",
      },
    }, null, 2)}\n`);
    await writeFile(path.join(rendererDir, "tsconfig.json"), `${JSON.stringify({ extends: "../tsconfig.base.json" }, null, 2)}\n`);
    await writeFile(
      path.join(runtimeDir, "jsx-runtime.js"),
      'export function jsx(tag, props) { return `<${tag}>${props.children ?? ""}</${tag}>`; }\nexport const jsxs = jsx;\nexport const Fragment = Symbol("Fragment");\n',
    );
    await writeFile(
      path.join(rendererDir, "render-landing.tsx"),
      'export default (): string => <main>{`extended TSX config:${new URL(".", import.meta.url).protocol}`}</main>;\n',
    );
    const canonicalProject = await realpath(projectDir);

    assert.equal(
      await renderClientPrerenderFragment(canonicalProject, { name: "landing", module: "renderer/render-landing.tsx" }),
      "<main>extended TSX config:file:</main>",
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
