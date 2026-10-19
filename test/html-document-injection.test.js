import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { Window } from 'happy-dom';
import { createBundle } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const repo = process.cwd();
const cli = path.join(repo, 'bin/sporades.js');
const page = '<!doctype html><html><head><script nonce="%SPORADES_NONCE%" src="/client.js"></script></head><body><h1>Pricing</h1></body></html>';

async function fixture(t, mode = 'dev', analytics = true) {
  const root = await mkdtemp(path.join(repo, '.scratch', 'html-documents-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(root, { recursive: true, force: true });
  });
  const received = [];
  const receiver = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => new Promise(resolve => { receiver.closeAllConnections(); receiver.close(resolve); }));
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config') };
  const created = spawnSync(process.execPath, [cli, 'create', 'app', '--template', 'blank', '--framework', 'vanilla', '--no-install', '--no-git', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(created.status, 0, created.stderr);
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(repo, path.join(project, 'node_modules/sporades'));
  const configPath = path.join(project, 'sporades.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.dev.port = 0;
  config.security = { csp: { mode: 'enforce', nonce: true } };
  if (analytics) config.analytics = { provider: 'umami', endpointEnv: 'ANALYTICS_URL', websiteIdEnv: 'WEBSITE_ID' };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(project, '.env.sporades.server'), `ANALYTICS_URL=http://127.0.0.1:${receiver.address().port}/ingest\nWEBSITE_ID=html-document-test\n`);
  await mkdir(path.join(project, 'public/nested'), { recursive: true });
  for (const name of ['pricing.html', 'nested/PRICING.HTML']) await writeFile(path.join(project, 'public', name), page);
  await writeFile(path.join(project, 'public/plain.txt'), '%SPORADES_NONCE%');
  let args = [cli, 'dev', '--json'];
  if (mode === 'container') {
    const bundle = await createBundle(project, config, { telemetryProfile: null });
    await writeFile(bundle.paths.serverBundle, await createServerBundleModuleSource({
      config, serverSource: bundle.serverRuntime.source, serverEnv: bundle.serverRuntime.env,
      serverModuleSource: bundle.serverRuntime.capsuleModuleSource,
      epilogue: 'process.stdout.write(JSON.stringify({ listening: server.address().port }) + "\\n");',
    }));
    args = [bundle.paths.serverBundle];
  }
  child = spawn(process.execPath, args, { cwd: project, env: { ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', origin;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const deadline = Date.now() + 20000;
  while (!origin && Date.now() < deadline) {
    assert.equal(child.exitCode, null, output + errors);
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.data?.event === 'started') origin = event.data.url;
        if (event.listening) origin = `http://127.0.0.1:${event.listening}`;
      } catch {}
    }
    if (!origin) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(origin, output + errors);
  return { origin, received, project };
}

function upgrade(origin, token) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/__sporades/ws?connectionToken=' + encodeURIComponent(token), origin), { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    } });
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    request.on('response', response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('upgrade timeout')));
    request.end();
  });
}

async function checkDocuments({ origin, received, project }) {
  for (const pathname of ['/pricing.html', '/nested/PRICING.HTML']) {
    const response = await fetch(new URL(pathname, origin), { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    const html = await response.text();
    const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html)?.[1];
    assert.ok(token, `${pathname} must carry a connection token before client evaluation`);
    assert.equal(await upgrade(origin, token), 101, 'the first handshake accepts the page token');
    const nonce = response.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
    assert.ok(html.includes(`<script nonce="${nonce}">window.__SPORADES_CONNECTION_TOKEN=`));
    assert.ok(html.includes(`<script nonce="${nonce}" src="/__sporades/observe.js"></script>`));
    assert.ok(html.indexOf('/__sporades/observe.js') < html.indexOf('/client.js'));
    assert.doesNotMatch(html, /%SPORADES_NONCE%/);
    const loader = await fetch(new URL('/__sporades/observe.js', origin));
    assert.equal(loader.status, 200);
    const window = new Window({ url: new URL(pathname + '?private=value#fragment', origin).href });
    const sends = [];
    window.fetch = (url, options) => {
      const sent = fetch(new URL(url, origin), { ...options, headers: { ...options.headers, origin } });
      sends.push(sent);
      return sent;
    };
    try {
      window.eval(await loader.text());
      assert.equal(sends.length, 1);
      assert.equal((await sends[0]).status, 204);
    } finally { await window.happyDOM.abort(); }
    assert.equal(received.at(-1).payload.url, pathname);
    assert.equal(received.at(-1).payload.website, 'html-document-test');
    for (const dest of [undefined, 'empty', 'iframe']) {
      const fetched = await fetch(new URL(pathname, origin), { headers: dest ? { 'sec-fetch-dest': dest } : {} });
      assert.equal(fetched.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await fetched.text(), /__SPORADES_CONNECTION_TOKEN|__sporades\/observe.js/);
    }
  }
  assert.equal(received.length, 2);
  assert.equal(await readFile(path.join(project, 'public/pricing.html'), 'utf8'), page, 'injection never changes source public files');
  assert.equal(await (await fetch(new URL('/plain.txt', origin), { headers: { 'sec-fetch-dest': 'document' } })).text(), '%SPORADES_NONCE%');
}

test('Dev injects valid connection tokens and the pageview loader into every HTML document navigation', { timeout: 30000 }, async t => {
  await checkDocuments(await fixture(t));
});

test('Container Bundle injects valid connection tokens and the pageview loader into every HTML document navigation', { timeout: 30000 }, async t => {
  await checkDocuments(await fixture(t, 'container'));
});

for (const mode of ['dev', 'container']) test(`${mode} HTML documents receive connection tokens when observability is disabled`, { timeout: 30000 }, async t => {
  const { origin, received } = await fixture(t, mode, false);
  const response = await fetch(new URL('/pricing.html', origin), { headers: { 'sec-fetch-dest': 'document' } });
  const html = await response.text();
  const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html)?.[1];
  assert.ok(token);
  assert.equal(await upgrade(origin, token), 101);
  assert.doesNotMatch(html, /__sporades\/observe.js/);
  assert.deepEqual(received, []);
});
