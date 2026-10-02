import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBundle } from '../dist/bundle-pipeline.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin/sporades.js');
const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(repo, '.sporades', 'test-public-assets-config') };
const assets = [
  ['favicon.ico', Buffer.from([0, 0, 1, 0, 255, 128]), 'image/x-icon'],
  ['sitemap.xml', Buffer.from('<?xml version="1.0"?><urlset/>\n'), 'application/xml; charset=utf-8'],
  ['robots.txt', Buffer.from('User-agent: *\nSitemap: /sitemap.xml\n'), 'text/plain; charset=utf-8'],
  ['nested/stable-name.txt', Buffer.from('nested public bytes\n'), 'text/plain; charset=utf-8'],
];

async function fixture(toolchain, fn) {
  await mkdir(path.join(repo, '.sporades'), { recursive: true });
  const root = await mkdtemp(path.join(repo, '.sporades', 'public-assets-'));
  try {
    const child = spawn(process.execPath, [cli, 'create', 'assets', '--framework', 'react', '--toolchain', toolchain, '--no-install', '--no-git', '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; });
    assert.equal((await once(child, 'exit'))[0], 0, output);
    const project = path.join(root, 'assets');
    await writeFile(path.join(project, 'client/index.tsx'), 'document.body.dataset.publicAssets = "ready";');
    const config = JSON.parse(await readFile(path.join(project, 'sporades.json'), 'utf8'));
    config.dev.port = 0;
    await writeFile(path.join(project, 'sporades.json'), JSON.stringify(config));
    await fn(project, config);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function events(child) {
  const history = []; let buffer = ''; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { history.push(JSON.parse(line)); } catch {}
    }
  });
  const next = async (predicate, from = 0) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const event = history.slice(from).find(predicate); if (event) return event;
      if (child.exitCode !== null) throw new Error(`Runtime exited: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for runtime event: ${JSON.stringify(history)} ${stderr}`);
  };
  next.count = () => history.length;
  return next;
}

async function writeAssets(project) {
  for (const [name, bytes] of assets) {
    const target = path.join(project, 'public', name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function assertAssets(url) {
  for (const [name, bytes, type] of assets) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${url}/${name}`, { method });
      assert.equal(response.status, 200, `${method} ${name}`);
      assert.equal(response.headers.get('content-type'), type, name);
      assert.equal(response.headers.get('cache-control'), 'no-cache', name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : bytes, name);
    }
  }
}

async function withGeneratedServer(project, bundle, fn) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; probe.close(); await once(probe, 'close');
  const url = `http://127.0.0.1:${port}`;
  const runtime = spawn(process.execPath, [bundle.paths.serverBundle], { cwd: project, env: { ...env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(project, '.sporades', 'generated.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fetch(url); break; } catch (error) { if (attempt === 100) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await fn(url);
  } finally { runtime.kill('SIGTERM'); await once(runtime, 'exit'); }
}

for (const toolchain of ['esbuild', 'vite']) test(`Unicode public collisions preserve on-disk and generated-server ${toolchain} release bytes`, async () => {
  await fixture(toolchain, async (project, config) => {
    const active = await createBundle(project, config);
    const jsPath = [...active.staticFiles.publicTree.assets.keys()].find(name => name.endsWith('.js'));
    assert.ok(jsPath, 'release includes a generated JavaScript entry');
    const original = await readFile(path.join(active.staticFiles.publicDir, jsPath));
    const reference = path.join(project, '.sporades/build/.public-trees/active.json');
    const before = await readFile(reference);
    const alias = path.join(project, 'public', jsPath.replace(/s$/, '\u017f'));
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(alias, 'document.body.dataset.publicAssets = "replacement";');
    await assert.rejects(createBundle(project, config), error => error.phase === 'public' && /Conflicting public path/.test(error.hint));
    assert.deepEqual(await readFile(reference), before);
    assert.deepEqual(await readFile(path.join(active.staticFiles.publicDir, jsPath)), original);
    await withGeneratedServer(project, active, async url => {
      const response = await fetch(`${url}/${jsPath}`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    });
  });
});

for (const toolchain of ['esbuild', 'vite']) test(`project public assets serve exact bytes in Dev and generated ${toolchain} releases`, async () => {
  await fixture(toolchain, async (project, config) => {
    await writeAssets(project);
    const htmlPath = path.join(project, 'index.html');
    await writeFile(htmlPath, (await readFile(htmlPath, 'utf8')).replace('</head>', '<link rel="icon" href="/favicon.ico"><link rel="sitemap" href="/sitemap.xml"></head>'));
    await writeFile(path.join(project, 'private.txt'), 'must not ship');
    const child = spawn(process.execPath, [cli, 'dev', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const next = events(child);
    try {
      const started = await next(event => event.data?.event === 'started');
      assert.equal(started.ok, true, JSON.stringify(started));
      await assertAssets(started.data.url);
      assert.equal((await fetch(`${started.data.url}/private.txt`)).status, 404);
    } finally { child.kill('SIGTERM'); await once(child, 'exit'); }

    const bundle = await createBundle(project, config);
    await withGeneratedServer(project, bundle, async url => {
      await assertAssets(url);
      assert.equal((await fetch(`${url}/private.txt`)).status, 404);
    });
  });
});

test('public asset documentation and shipped type guidance preserve the shared release contract', async () => {
  for (const name of ['docs/guide/client.md', 'docs/reference/projects-and-configuration.md', 'docs/adr/0032-user-owned-html-builds-to-a-normalized-public-tree.md', 'src/types/server.d.ts']) {
    const text = await readFile(path.join(repo, name), 'utf8');
    assert.match(text, /public\//, name);
    assert.match(text, /esbuild[\s\S]*Vite/, name);
    assert.match(text, /application\/xml; charset=utf-8/, name);
    assert.match(text, /unauthenticated/, name);
    assert.match(text, /rollback/, name);
    assert.match(text, /__sporades/, name);
  }
});

for (const toolchain of ['esbuild', 'vite']) test(`Dev observes public additions edits deletions and rejects candidates for ${toolchain}`, async () => {
  await fixture(toolchain, async project => {
    const child = spawn(process.execPath, [cli, 'dev', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const next = events(child);
    try {
      const started = await next(event => event.data?.event === 'started');
      assert.equal(started.ok, true, JSON.stringify(started));
      const url = started.data.url;
      const rebuild = async (change, ok = true) => {
        const from = next.count(); await change();
        const event = await next(event => event.data?.event === 'rebuild' && event.data.status === (ok ? 'success' : 'failed') && event.ok === ok, from);
        if (!ok) assert.equal(event.data.build.phase, 'public');
        return event;
      };
      assert.equal((await fetch(`${url}/robots.txt`)).status, 404);
      await rebuild(() => writeAssets(project));
      await assertAssets(url);
      await rebuild(() => writeFile(path.join(project, 'public/robots.txt'), 'updated crawler rules'));
      assert.equal(await (await fetch(`${url}/robots.txt`)).text(), 'updated crawler rules');
      // These names are public too; the watcher must not apply package exclusions.
      await mkdir(path.join(project, 'public/node_modules'), { recursive: true });
      await rebuild(() => writeFile(path.join(project, 'public/node_modules/proof.txt'), 'first'));
      await rebuild(() => writeFile(path.join(project, 'public/node_modules/proof.txt'), 'second'));
      assert.equal(await (await fetch(`${url}/node_modules/proof.txt`)).text(), 'second');
      await rebuild(() => writeFile(path.join(project, 'public/index.html'), 'conflicting entry'), false);
      assert.equal(await (await fetch(`${url}/robots.txt`)).text(), 'updated crawler rules');
      await rebuild(() => rm(path.join(project, 'public/index.html')));
      await rebuild(() => symlink(project, path.join(project, 'public/loop')), false);
      assert.equal(await (await fetch(`${url}/robots.txt`)).text(), 'updated crawler rules');
      await rebuild(() => rm(path.join(project, 'public/loop')));
      assert.equal((await fetch(`${url}/%2e%2e/sporades.json`)).status, 404);
      await rebuild(() => rm(path.join(project, 'public/robots.txt')));
      assert.equal((await fetch(`${url}/robots.txt`)).status, 404);
      await rebuild(() => rm(path.join(project, 'public'), { recursive: true }));
      assert.equal((await fetch(`${url}/favicon.ico`)).status, 404);
    } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
});

test('unsafe public candidates and combined output limits never replace the active release', async () => {
  await fixture('esbuild', async (project, config) => {
    await writeAssets(project);
    const active = await createBundle(project, config);
    const reference = path.join(project, '.sporades/build/.public-trees/active.json');
    const before = await readFile(reference);
    const publicDir = path.join(project, 'public');
    const cases = [
      ['index.html', () => writeFile(path.join(publicDir, 'index.html'), 'collision'), /Conflicting public path/],
      ['client.js', () => writeFile(path.join(publicDir, 'client.js'), 'collision'), /Conflicting public path/],
      ['CLIENT.js', () => writeFile(path.join(publicDir, 'CLIENT.js'), 'case alias collision'), /Conflicting public path/],
      ['client.js', () => mkdir(path.join(publicDir, 'client.js/nested'), { recursive: true }).then(() => writeFile(path.join(publicDir, 'client.js/nested/file.txt'), 'collision')), /Conflicting public path/],
      ['__sporades', () => mkdir(path.join(publicDir, '__sporades')).then(() => writeFile(path.join(publicDir, '__sporades/proof.txt'), 'reserved')), /reserved/],
      ['__sporade\u017f', () => mkdir(path.join(publicDir, '__sporade\u017f')).then(() => writeFile(path.join(publicDir, '__sporade\u017f/proof.txt'), 'reserved alias')), /reserved/],
      ['escape\\file.txt', () => writeFile(path.join(publicDir, 'escape\\file.txt'), 'unsafe'), /safe relative/],
      ['link', () => symlink(path.join(project, 'sporades.json'), path.join(publicDir, 'link')), /symbolic link/],
      ['large.bin', async () => { await writeFile(path.join(publicDir, 'large.bin'), ''); await truncate(path.join(publicDir, 'large.bin'), 16 * 1024 * 1024 + 1); }, /per-file/],
      ['many', async () => { await mkdir(path.join(publicDir, 'many')); for (let i = 0; i < 512; i++) await writeFile(path.join(publicDir, 'many', `${i}.txt`), ''); }, /at most 512/],
      ['aggregate', async () => { await mkdir(path.join(publicDir, 'aggregate')); for (let i = 0; i < 4; i++) { const file = path.join(publicDir, 'aggregate', `${i}.bin`); await writeFile(file, ''); await truncate(file, 16 * 1024 * 1024); } }, /aggregate size/],
    ];
    for (const [name, arrange, hint] of cases) {
      await arrange();
      await assert.rejects(createBundle(project, config), error => error.phase === 'public' && hint.test(error.hint), name);
      assert.deepEqual(await readFile(reference), before, name);
      assert.deepEqual(await readFile(path.join(active.staticFiles.publicDir, 'favicon.ico')), assets[0][1], name);
      await rm(path.join(publicDir, name), { recursive: true, force: true });
    }
    await rm(publicDir, { recursive: true });
    await symlink(project, publicDir);
    await assert.rejects(createBundle(project, config), error => /real directory/.test(error.hint));
    assert.deepEqual(await readFile(reference), before);
  });
});
