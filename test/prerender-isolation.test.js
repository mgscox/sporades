import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { renderClientPrerenderFragment } from '../dist/client-prerender.js';

test('writable CommonJS locations start module-local and remain isolated from siblings', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-writable-renderer-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'entry.mjs'), `import first from './nested/first.cjs'; import second from './nested/second.cjs'; export default () => first() + second();`);
    await writeFile(path.join(root, 'nested/first.cjs'), `
const path = require('node:path');
module.exports = () => {
  const before = path.basename(__dirname) + '/' + path.basename(__filename);
  __dirname = 'changed-dir'; __filename = 'changed-file';
  return before + '|' + __dirname + '/' + __filename + '|';
};`);
    await writeFile(path.join(root, 'nested/second.cjs'), `const path = require('node:path'); module.exports = () => path.basename(__dirname) + '/' + path.basename(__filename);`);
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'nested/first.cjs|changed-dir/changed-file|nested/second.cjs');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('prerender executions isolate preloaded dynamic CommonJS dependencies and preserve host cache', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-cache-isolation-')));
  const require = createRequire(import.meta.url);
  const dependency = path.join(root, 'state.cjs');
  try {
    await writeFile(dependency, 'module.exports = { count: 0 };');
    const preloaded = require(dependency);
    preloaded.count = 40;
    await writeFile(path.join(root, 'entry.cjs'), `exports.default = () => { const name = './state.cjs'; const state = require(name); return String(++state.count); };`);
    const fragment = {name:'landing', module:'entry.cjs'};
    assert.equal(await renderClientPrerenderFragment(root, fragment), '1');
    assert.equal(await renderClientPrerenderFragment(root, fragment), '1');
    assert.equal(require(dependency), preloaded);
    assert.equal(preloaded.count, 40);
    const results = await Promise.all([renderClientPrerenderFragment(root, fragment), renderClientPrerenderFragment(root, fragment)]);
    assert.deepEqual(results, ['1', '1']);
  } finally { delete require.cache[require.resolve(dependency)]; await rm(root, {recursive:true, force:true}); }
});

test('writable require starts module-local, keeps static TypeScript imports, and then honors replacement', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-writable-require-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'entry.mjs'), `import render from './nested/helper.cjs'; export default render;`);
    await writeFile(path.join(root, 'nested/value.cjs'), 'module.exports = "adjacent";');
    await writeFile(path.join(root, 'nested/typed.ts'), 'const value: string = "typed"; export default value;');
    await writeFile(path.join(root, 'nested/helper.cjs'), `
const path = require('node:path');
module.exports = () => {
  const target = './value.cjs';
  const before = require(target) + '|' + path.basename(require.resolve(target)) + '|' + require('./typed.ts').default;
  require = (value) => 'replaced:' + value;
  return before + '|' + require('./value.cjs');
};`);
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'adjacent|value.cjs|typed|replaced:./value.cjs');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('computed dynamic imports fail clearly rather than resolving against the CLI directory', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-dynamic-import-')));
  try {
    await writeFile(path.join(root, 'entry.mjs'), `export default async () => { const target = './adjacent.mjs'; return (await import(target)).default; };`);
    await writeFile(path.join(root, 'adjacent.mjs'), 'export default "adjacent";');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), /prerender.*dynamic import.*string literal/i);
    await writeFile(path.join(root, 'entry.mjs'), `export default async () => (await import('./adjacent.mjs')).default;`);
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'adjacent');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('root var declarations redeclare initialized CommonJS wrapper parameters', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-wrapper-vars-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'entry.mjs'), `import render from './nested/helper.cjs'; export default render;`);
    await writeFile(path.join(root, 'nested/value.cjs'), 'module.exports = "adjacent";');
    await writeFile(path.join(root, 'nested/helper.cjs'), `
var __dirname, __filename, require;
const path = require('node:path');
const target = './value.cjs';
const initial = path.basename(__dirname) + '/' + path.basename(__filename) + '|' + require(target);
var __dirname = 'assigned';
module.exports = () => initial + '|' + __dirname;
`);
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'nested/helper.cjs|adjacent|assigned');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('computed external require failures redact runtime paths and file URLs', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-runtime-redaction-')));
  const external = await realpath(await mkdtemp(path.join(tmpdir(), 'private-renderer-location-')));
  try {
    const missing = path.join(external, 'missing helper.cjs');
    for (const target of [missing, pathToFileURL(missing).href]) {
      for (const resolver of ['require.resolve', 'module.require.resolve']) {
        await writeFile(path.join(root, 'entry.cjs'), `exports.default = () => { const target = ${JSON.stringify(target)}; return ${resolver}(target); };`);
        await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), (error) => {
          assert.doesNotMatch(error.message, /private-renderer-location-/);
          assert.ok(error.message.includes('<project>'), error.message);
          return true;
        });
      }
      await writeFile(path.join(root, 'entry.cjs'), `exports.default = () => { const target = ${JSON.stringify(target)}; return require(target); };`);
      await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), (error) => {
        assert.doesNotMatch(error.message, /private-renderer-location-/);
        assert.ok(error.message.includes('<project>'), error.message);
        return true;
      });
    }
    const throwing = path.join(external, 'throwing.cjs');
    await writeFile(throwing, 'throw new Error("Failed helper " + __filename);');
    await writeFile(path.join(root, 'entry.cjs'), `exports.default = () => { const target = ${JSON.stringify(throwing)}; return require(target); };`);
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), (error) => {
      assert.doesNotMatch(error.message, /private-renderer-location-/);
      assert.match(error.message, /throwing\.cjs/);
      return true;
    });
    await writeFile(path.join(root, 'entry.cjs'), `exports.default = () => new Promise(() => process.nextTick(() => { const target = ${JSON.stringify(missing)}; require(target); }));`);
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), (error) => {
      assert.doesNotMatch(error.message, /private-renderer-location-/);
      assert.ok(error.message.includes('<project>'), error.message);
      return true;
    });
  } finally { await rm(root, {recursive:true, force:true}); await rm(external, {recursive:true, force:true}); }
});

test('renderer parentPort progress cannot impersonate bootstrap completion', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-renderer-channel-')));
  try {
    await writeFile(path.join(root, 'entry.cjs'), `
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ progress: 'loading' });
exports.default = async () => {
  parentPort.postMessage({ kind:'success', rendered:'wrong channel' });
  await new Promise((resolve) => setImmediate(resolve));
  return '<main>Actual renderer result</main>';
};`);
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), '<main>Actual renderer result</main>');
    await writeFile(path.join(root, 'entry.cjs'), 'exports.default = () => "fast completion";');
    for (let index = 0; index < 20; index += 1) {
      assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), 'fast completion');
    }
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('CommonJS module.require stays module-relative and writable in helpers', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-module-require-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/value.cjs'), 'module.exports = "adjacent";');
    await writeFile(path.join(root, 'entry.mjs'), 'import render from "./nested/helper.cjs"; export default render;');
    await writeFile(path.join(root, 'nested/typed.ts'), 'const value: string = "typed"; export default value;');
    await writeFile(path.join(root, 'nested/helper.cjs'), 'module.exports = () => { const target = "./value.cjs"; const alias = module; const original = alias.require(target) + "|" + module.require("./typed.ts").default; module.require = () => "replaced"; return original + "|" + module.require(target); };');
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'adjacent|typed|replaced');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('TypeScript CommonJS helper syntax selects module-local wrappers', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-typescript-cjs-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'nested/value.cjs'), 'module.exports = "adjacent";');
    for (const extension of ['ts', 'tsx']) {
      await writeFile(path.join(root, `nested/helper.${extension}`), 'const target: string = "./value.cjs"; const path = require("node:path"); module.exports = () => path.basename(__dirname) + "/" + path.basename(__filename) + "|" + require(target);');
      await writeFile(path.join(root, 'entry.mjs'), `import render from "./nested/helper.${extension}"; export default render;`);
      assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), `nested/helper.${extension}|adjacent`);
    }
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('CommonJS module location fields identify each source helper and stay writable', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-module-location-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    for (const extension of ['cjs', 'ts', 'tsx']) {
      const file = path.join(root, `nested/helper.${extension}`);
      await writeFile(file, 'var module; if (false) { var module; } module.exports = () => { const record = module; const initial = [record.filename, record.id, record.path]; record.filename = "reassigned"; return JSON.stringify([...initial, module.filename]); };');
      await writeFile(path.join(root, 'entry.mjs'), `import render from "./nested/helper.${extension}"; export default render;`);
      assert.deepEqual(JSON.parse(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'})), [file, file, path.dirname(file), 'reassigned']);
    }
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('direct CommonJS eval fails explicitly instead of using entry-rooted wrappers', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-direct-eval-')));
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'entry.mjs'), 'import render from "./nested/helper.cjs"; export default render;');
    await writeFile(path.join(root, 'nested/helper.cjs'), 'module.exports = () => eval("__dirname");');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), /Direct eval is unsupported/i);
    await writeFile(path.join(root, 'nested/helper.cjs'), 'function local(eval) { return eval("__dirname"); } module.exports = () => local(globalThis.eval);');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), /Direct eval is unsupported/i);
    await writeFile(path.join(root, 'nested/helper.cjs'), 'const local = { eval: value => value }; module.exports = () => local.eval("local");');
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'}), 'local');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('CommonJS dynamic with scope fails explicitly before wrapper specialization', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-with-scope-')));
  try {
    await writeFile(path.join(root, 'entry.cjs'), 'exports.default = () => { with ({ require: () => "local" }) { const target = "./absent.cjs"; return require(target); } };');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), /With statements are unsupported/i);
    await writeFile(path.join(root, 'entry.cjs'), 'exports.default = () => { with ({ value: "local" }) { return value; } };');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), /With statements are unsupported/i);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('CommonJS wrapper arguments fail explicitly while ordinary function arguments work', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-wrapper-arguments-')));
  try {
    for (const source of [
      'const filename = arguments[3]; exports.default = () => filename;',
      'exports.default = () => arguments[3];',
      'var arguments; exports.default = () => arguments[1]("node:path").sep;',
    ]) {
      await writeFile(path.join(root, 'entry.cjs'), source);
      await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), /Top-level CommonJS arguments are unsupported/i);
    }
    await writeFile(path.join(root, 'entry.cjs'), 'function regular(value) { return (() => arguments[0])(); } const expression = function(value) { return arguments[0]; }; exports.default = () => regular("local") + expression("-function");');
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), 'local-function');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('ESM import.meta aliases and computed accesses preserve each source URL', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-import-meta-alias-')));
  try {
    await mkdir(path.join(root, 'nested'));
    const helper = path.join(root, 'nested/helper.mjs');
    const entry = path.join(root, 'entry.mjs');
    await writeFile(helper, 'const meta = import.meta; const {url} = import /* module meta */ .meta; export default () => [meta.url, url, import.meta["url"], meta === import.meta];');
    await writeFile(entry, 'import helper from "./nested/helper.mjs"; const meta = import.meta; export default () => JSON.stringify([meta["url"], ...helper()]);');
    assert.deepEqual(JSON.parse(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.mjs'})), [pathToFileURL(entry).href, pathToFileURL(helper).href, pathToFileURL(helper).href, pathToFileURL(helper).href, true]);
  } finally { await rm(root, {recursive:true, force:true}); }
});
