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
