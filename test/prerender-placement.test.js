import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBundle } from "../dist/bundle-pipeline.js";

test("ordered prerender placement preserves author HTML, warnings and last successful output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-placement-"));
  try {
    await mkdir(path.join(root, "client"));
    await mkdir(path.join(root, "server"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(root, "client/index.tsx"), 'console.log("interactive");');
    await writeFile(path.join(root, "server/index.ts"), 'export default {};');
    await writeFile(path.join(root, "order.json"), '[]');
    for (const name of ["first", "second"]) {
      await writeFile(path.join(root, `${name}.mjs`), `import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('./order.json', import.meta.url);
export default async () => {
  const order = JSON.parse(readFileSync(file)); order.push('${name}'); writeFileSync(file, JSON.stringify(order));
  return '<meta data-fragment="${name}">${name === "second" ? '<meta name="second-copy" content="second">' : '<span data-fragment="first">first</span>'}';
};`);
    }
    const config = { name: "placement", client: { framework: "react", toolchain: "vite", prerender: [
      { name: "first", module: "first.mjs" }, { name: "second", module: "second.mjs" },
    ] } };
    const cases = [
      { head: '', body: '<!-- sporades:prerender -->', order: ['first', 'second'], codes: [] },
      { head: '', body: '', order: ['first', 'second'], codes: [] },
      { head: '<!-- sporades:prerender second -->', body: '<!-- sporades:prerender first -->', order: ['second', 'first'], codes: [] },
      { head: '', body: '<!-- sporades:prerender first --><!-- sporades:prerender -->', order: ['first', 'first', 'second'], codes: ['PRERENDER_DUPLICATE_PLACEMENT'] },
      { head: '', body: '<!-- sporades:prerender --><!-- sporades:prerender -->', order: ['first', 'second', 'first', 'second'], codes: ['PRERENDER_DUPLICATE_PLACEMENT', 'PRERENDER_DUPLICATE_PLACEMENT'] },
      { head: '', body: '<!-- sporades:prerender first --><!-- sporades:prerender first -->', order: ['first', 'first'], codes: ['PRERENDER_DUPLICATE_PLACEMENT', 'PRERENDER_UNUSED_FRAGMENT'] },
      { head: '', body: '<!-- sporades:prerender typo -->', order: [], codes: ['PRERENDER_UNKNOWN_MARKER', 'PRERENDER_UNUSED_FRAGMENT', 'PRERENDER_UNUSED_FRAGMENT'] },
      { head: '', body: '<!-- sporades:prerender landing.page -->', order: [], codes: ['PRERENDER_UNKNOWN_MARKER', 'PRERENDER_UNUSED_FRAGMENT', 'PRERENDER_UNUSED_FRAGMENT'] },
      { head: '', body: '<!-- sporades:prerender two words -->', order: [], codes: ['PRERENDER_UNKNOWN_MARKER', 'PRERENDER_UNUSED_FRAGMENT', 'PRERENDER_UNUSED_FRAGMENT'] },
    ];
    let last;
    for (const fixture of cases) {
      const source = `<!doctype html><html><head>${fixture.head}</head><body>${fixture.body}<script type="module" src="/client/index.tsx"></script></body></html>`;
      await writeFile(path.join(root, "index.html"), source);
      await writeFile(path.join(root, "order.json"), '[]');
      last = await createBundle(root, config);
      const html = await readFile(last.staticFiles.indexHtml, "utf8");
      assert.deepEqual([...html.matchAll(/<meta data-fragment="(.*?)">/g)].map((match) => match[1]), fixture.order);
      assert.deepEqual(JSON.parse(await readFile(path.join(root, 'order.json'), 'utf8')), ['first', 'second']);
      assert.deepEqual(last.clientDiagnostics.warnings?.map((warning) => warning.code) ?? [], fixture.codes);
      for (const warning of last.clientDiagnostics.warnings ?? []) {
        assert.equal(typeof warning.message, 'string');
        assert.equal(typeof warning.fragment, 'string');
        assert.equal(warning.message.includes(root), false);
      }
      if (fixture.codes.includes('PRERENDER_UNKNOWN_MARKER')) assert.ok(html.includes(fixture.body));
      assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), source);
      assert.match(html, /\/assets\/index-[^" ]+\.js/);
      assert.doesNotMatch(html, /<div[^>]*sporades/);
    }
    const active = await readFile(path.join(root, '.sporades/build/.public-trees/active.json'), 'utf8');
    const lastHtml = await readFile(last.staticFiles.indexHtml, 'utf8');
    await writeFile(path.join(root, 'second.mjs'), 'export default () => { throw new Error("broken renderer"); };');
    await assert.rejects(createBundle(root, config), /broken renderer/);
    assert.equal(await readFile(path.join(root, '.sporades/build/.public-trees/active.json'), 'utf8'), active);
    assert.equal(await readFile(last.staticFiles.indexHtml, 'utf8'), lastHtml);
    // Project HTML plugins run first; renderer-produced marker text stays literal.
    await writeFile(path.join(root, 'vite.config.mjs'), `export default { plugins: [{ name: 'author-html', enforce: 'post', transformIndexHtml: { order: 'post', handler: html => html.replace('AUTHOR_SLOT', '<!-- sporades:prerender -->') } }] };`);
    await writeFile(path.join(root, 'index.html'), '<html><head></head><body>AUTHOR_SLOT<script type="module" src="/client/index.tsx"></script></body></html>');
    await writeFile(path.join(root, 'first.mjs'), `export default () => '<main>literal <!-- sporades:prerender second --></main>';`);
    await writeFile(path.join(root, 'second.mjs'), `export default () => '<footer>second once</footer>';`);
    const composed = await createBundle(root, config);
    const composedHtml = await readFile(composed.staticFiles.indexHtml, 'utf8');
    assert.ok(composedHtml.includes('<main>literal <!-- sporades:prerender second --></main>'));
    assert.equal(composedHtml.split('<footer>second once</footer>').length - 1, 1);
    // Vite composes descriptors after each hook; placement precedes derived assets.
    await writeFile(path.join(root, 'vite.config.mjs'), `export default { plugins: [{ name: 'author-tags', transformIndexHtml: () => ({ tags: [{ tag: 'section', attrs: { id: 'plugin-slot' }, children: '<!-- sporades:prerender -->', injectTo: 'body' }] }) }] };`);
    await writeFile(path.join(root, 'index.html'), '<html><head></head><body><script type="module" src="/client/index.tsx"></script></body></html>');
    const tags = await createBundle(root, config);
    const tagHtml = await readFile(tags.staticFiles.indexHtml, 'utf8');
    assert.match(tagHtml, /<section id="plugin-slot">[\s\S]*<main>literal/);
    assert.equal(tagHtml.split('<footer>second once</footer>').length - 1, 1);
    assert.equal(tags.clientDiagnostics.warnings, undefined);
    await writeFile(path.join(root, 'vite.config.mjs'), `import {createHash} from 'node:crypto'; export default { plugins: [{ name: 'html-digest', generateBundle: { order:'post', handler(_options, bundle) { const html = bundle['index.html'].source; this.emitFile({type:'asset', fileName:'index-digest.txt', source:createHash('sha256').update(html).digest('hex')}); } } }] };`);
    const digested = await createBundle(root, config);
    const digestedHtml = await readFile(digested.staticFiles.indexHtml, 'utf8');
    assert.ok(digestedHtml.includes('<footer>second once</footer>'));
    assert.equal(await readFile(path.join(path.dirname(digested.staticFiles.indexHtml), 'index-digest.txt'), 'utf8'), createHash('sha256').update(digestedHtml).digest('hex'));
    await writeFile(path.join(root, 'vite.config.mjs'), 'export default {};');
    // Explicit empty configuration still diagnoses stale names; omission is opt-out.
    await writeFile(path.join(root, 'index.html'), '<html><head></head><body><!-- sporades:prerender stale --><script type="module" src="/client/index.tsx"></script></body></html>');
    const empty = await createBundle(root, {...config, client:{...config.client, prerender:[]}});
    assert.deepEqual(empty.clientDiagnostics.warnings?.map(({code, fragment}) => ({code, fragment})), [{code:'PRERENDER_UNKNOWN_MARKER', fragment:'stale'}]);
    assert.ok((await readFile(empty.staticFiles.indexHtml, 'utf8')).includes('<!-- sporades:prerender stale -->'));
    const omitted = await createBundle(root, {...config, client:{framework:'react', toolchain:'vite'}});
    assert.equal(omitted.clientDiagnostics.warnings, undefined);
    // Private browser cleanup boundaries cannot be authored even with prerender off.
    const boundary = '<!-- sporades:prerender-boundary-start landing --><p>author content</p><!-- sporades:prerender-boundary-end landing -->';
    for (const client of [{framework:'react', toolchain:'vite'}, {framework:'react', toolchain:'vite', prerender:[]}]) {
      await writeFile(path.join(root, 'index.html'), `<html><body>${boundary}<script type="module" src="/client/index.tsx"></script></body></html>`);
      await assert.rejects(createBundle(root, {...config, client}), /reserved prerender boundary comment/i);
      await writeFile(path.join(root, 'index.html'), '<html><body>AUTHOR_SLOT<script type="module" src="/client/index.tsx"></script></body></html>');
      await writeFile(path.join(root, 'vite.config.mjs'), `export default { plugins: [{ name: 'author-boundaries', enforce: 'post', transformIndexHtml: { order: 'post', handler: html => html.replace('AUTHOR_SLOT', ${JSON.stringify(boundary)}) } }] };`);
      await assert.rejects(createBundle(root, {...config, client}), /reserved prerender boundary comment/i);
      await writeFile(path.join(root, 'vite.config.mjs'), `export default { plugins: [{ name: 'deferred-boundaries', transformIndexHtml: () => ({ tags: [{tag:'section', children:${JSON.stringify(boundary)}, injectTo:'body'}] }) }] };`);
      await assert.rejects(createBundle(root, {...config, client}), /reserved prerender boundary comment/i);
      await writeFile(path.join(root, 'vite.config.mjs'), `export default { plugins: [{ name: 'late-boundaries', generateBundle: {order:'post', handler(_options, bundle) {bundle['index.html'].source += ${JSON.stringify(boundary)};} } }] };`);
      await assert.rejects(createBundle(root, {...config, client}), /reserved prerender boundary comment/i);
      await assert.rejects(createBundle(root, config), /not stable in the parsed HTML document/i);
    }
    await writeFile(path.join(root, 'vite.config.mjs'), 'export default {};');
    await writeFile(path.join(root, 'index.html'), '<html><body><script type="module" src="/client/index.tsx"></script></body></html>');
    await writeFile(path.join(root, 'renderer-only.css'), 'body { color: red; }');
    await writeFile(path.join(root, 'second.mjs'), `import './renderer-only.css'; export default () => '<footer>not a second asset graph</footer>';`);
    await assert.rejects(createBundle(root, config), /unsupported secondary output|Could not build client prerender module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
