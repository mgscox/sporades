// Synthetic endpoints exist only in temporary test Bundles, never shipped apps.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServerBundleModuleSource } from '../../dist/templates/server-bundle-module-graph.js';
import { bundleServerCapsuleModule } from '../../dist/bundle-pipeline.js';

export async function startCollectionCapsule(t, { config, serverEnv, failureMarker = 'generated server failure', dynamicFailureMarker = false }) {
  const scratch = path.join(process.cwd(), '.scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'collect-bundle-'));
  let child, failed = false;
  t.after(async () => {
    try {
      if (child?.pid && !failed && child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 4000);
        let timer;
        try {
          await Promise.race([ended, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Synthetic Capsule shutdown timed out')), 8000);
          })]);
        } finally { clearTimeout(force); clearTimeout(timer); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const serverSource = `import { capsule, endpoint, table, String as StringField } from 'sporades/server';
export default capsule({ name: ${JSON.stringify(config.name)}, schema: { notes: table({ text: StringField() }) }, endpoints: {
  fail: endpoint({ method: 'GET', path: '/failure' }, async ctx => {
    await ctx.db.notes.insert({ text: 'rolled-back' });
    throw new Error(${dynamicFailureMarker ? `(String(ctx.request.query.marker ?? '').match(/^acceptance-[a-f0-9]{32}-server-error$/) ? ctx.request.query.marker + ' password="synthetic-server-password"' : ${JSON.stringify(failureMarker)})` : JSON.stringify(failureMarker)});
  }),
  commit: endpoint({ method: 'POST', path: '/commit' }, async ctx => {
    await ctx.db.notes.insert({ text: 'committed' });
    return { body: { ok: true } };
  }),
  state: endpoint({ method: 'GET', path: '/state' }, async ctx => ({ body: (await ctx.db.notes.all()).map(row => row.text) })),
} });`;
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server', 'index.ts') });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><html><head></head><body>Collection fixture</body></html>');
  await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv, serverSource, serverModuleSource,
    epilogue: 'process.stdout.write(JSON.stringify({ listening: server.address().port }) + "\\n");' }));
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
    SPORADES_CONFIG_DIR: path.join(root, 'config'), PORT: '0', SPORADES_SECURITY_SESSION: 'dev',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.on('error', () => { failed = true; });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr.resume(); // Synthetic handler diagnostics are never printed by acceptance.
  for (let attempt = 0; attempt < 2000; attempt++) {
    assert.ok(!failed && child.exitCode === null, 'Synthetic Capsule exited before readiness');
    const signal = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => Number.isInteger(event?.listening));
    if (signal) return { origin: `http://127.0.0.1:${signal.listening}` };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic Capsule readiness timed out');
}

export async function assertCollectionBusinessSemantics(origin, committed = 0) {
  const request = (route, options) => fetch(origin + route, { ...options, signal: AbortSignal.timeout(5000) });
  const state = async () => {
    const response = await request('/state');
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await state(), Array(committed).fill('committed'));
  assert.equal((await request('/commit', { method: 'POST' })).status, 200);
  const failure = await request('/failure');
  assert.equal(failure.status, 500);
  const body = await failure.text();
  assert.deepEqual(JSON.parse(body), { ok: false, data: null, error: {
    message: 'Endpoint handler failed.', hint: 'Check the endpoint handler and retry the request.',
  } });
  assert.deepEqual(await state(), Array(committed + 1).fill('committed'));
  assert.equal((await request('/commit', { method: 'POST' })).status, 200);
  assert.deepEqual(await state(), Array(committed + 2).fill('committed'));
  return body;
}

export async function emitCollectionBrowserFailures(t, origin, marker, kinds = ['browser-error', 'browser-rejection']) {
  const { Window } = await import('happy-dom');
  const response = await fetch(origin + '/__sporades/observe.js', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const script = await response.text();
  const window = new Window({ url: origin + '/?token=synthetic-location#synthetic-fragment' });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = (url, options) => {
    assert.equal(url, '/__sporades/collect');
    const send = fetch(new URL(url, origin), { ...options, headers: { ...options.headers, origin }, signal: AbortSignal.timeout(5000) });
    sends.push(send);
    return send;
  };
  window.eval(script);
  const markers = kinds.map(kind => `${marker}-${kind}`);
  const error = value => Object.assign(new Error(`${value} password="synthetic-password" https://example.test/private?token=synthetic-query#synthetic-fragment`), {
    stack: `Error: ${value}\n    at execute (https://example.test/client.js?token=synthetic-stack#synthetic-fragment:12:8)`,
  });
  for (const [index, kind] of kinds.entries()) {
    if (kind === 'browser-error') window.dispatchEvent(new window.ErrorEvent('error', { error: error(markers[index]) }));
    else {
      const rejection = new window.Event('unhandledrejection');
      Object.defineProperty(rejection, 'reason', { value: error(markers[index]) });
      window.dispatchEvent(rejection);
    }
  }
  for (const sent of await Promise.all(sends)) assert.equal(sent.status, 204);
  return markers;
}
