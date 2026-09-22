import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('computed require cannot hide an ESM import graph from Dev dependency tracking', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sporades-computed-esm-')));
  try {
    await writeFile(path.join(root, 'copy.mjs'), 'export default "static copy";');
    await writeFile(path.join(root, 'view.mjs'), 'import copy from "./copy.mjs"; export default copy;');
    await writeFile(path.join(root, 'entry.cjs'), 'exports.default = () => { const target = "./view.mjs"; return require(target).default; };');
    await assert.rejects(renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}), /require\(\).*ES Module.*not supported/is);
    await writeFile(path.join(root, 'entry.cjs'), 'exports.default = () => require("./view.mjs").default;');
    const dependencies = new Set();
    assert.equal(await renderClientPrerenderFragment(root, {name:'landing', module:'entry.cjs'}, [root], (file) => dependencies.add(file)), 'static copy');
    assert.ok(dependencies.has(path.join(root, 'view.mjs')));
    assert.ok(dependencies.has(path.join(root, 'copy.mjs')));
  } finally { await rm(root, {recursive:true, force:true}); }
});
