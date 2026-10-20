import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { Window } from 'happy-dom';
import { parse } from 'parse5';
import { injectPageConnectionToken } from '../dist/http-runtime.js';
import { createBundle } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const repo = process.cwd();
const cli = path.join(repo, 'bin/sporades.js');
const page = '<!doctype html><html><head><script nonce="%SPORADES_NONCE%" src="/client.js"></script></head><body><h1>Pricing</h1></body></html>';
const headlessPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Pricing</title>
<link rel="icon" href="data:,">
<script nonce="%SPORADES_NONCE%">
window.capsuleExecuted = true;
window.tokenBeforeCapsule = typeof window.__SPORADES_CONNECTION_TOKEN === 'string';
window.loaderBeforeCapsule = !!document.querySelector('script[src="/__sporades/observe.js"]');
const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/__sporades/ws?connectionToken=' + encodeURIComponent(window.__SPORADES_CONNECTION_TOKEN));
socket.onopen = () => { window.socketOpened = true; };
</script><body style="margin:0"><div id="box" style="height:50%"><div style="height:40px"></div></div></body></html>`;
const headlessDocuments = {
  'omitted-head.html': headlessPage,
  'omitted-root.html': headlessPage.replace('<html lang="en">', '').replace('</html>', ''),
  'prologue.html': headlessPage.replace('<!doctype html>', '\uFEFF \n<!-- Pricing page -->\n<!DOCTYPE html SYSTEM "about:legacy-compat">'),
  'quirks.html': headlessPage.replace('<!doctype html>', '<!-- No doctype -->\n'.repeat(64)),
  'comment-head.html': headlessPage.replace('<meta', '<!-- optional <head> omitted -->\n<meta'),
  'script-head.html': headlessPage.replace('window.capsuleExecuted', 'window.example="<head>";\nwindow.capsuleExecuted'),
};

test('injection uses the parsed document head rather than tag-like text', () => {
  const sources = [
    '<!doctype html><!-- optional <head> omitted --><script>window.example="<head>";</script>',
    '<!doctype html><html data-example="<head>"><HEAD data-example=\'x > y\'><script>window.example="<head>";</script></HEAD></html>',
    '<!doctype html><!-- <head> --><html><head><title>Pricing</title></head></html>',
    ...['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'].map(tag =>
      `<!doctype html><html><${tag}>optional <head> omitted</${tag}></html>`),
    '<!doctype html><html><body><template><head></head></template></body></html>',
  ];
  for (const source of sources) {
    const injected = injectPageConnectionToken(source, 'test-token', { observability: { enabled: true } }, 'test-nonce');
    const document = parse(injected);
    const head = document.childNodes.find(node => node.tagName === 'html').childNodes.find(node => node.tagName === 'head');
    const scripts = head.childNodes.filter(node => node.tagName === 'script');
    assert.equal(scripts.filter(node => node.childNodes[0]?.value.includes('window.__SPORADES_CONNECTION_TOKEN=')).length, 1, source);
    assert.equal(scripts.filter(node => node.attrs.some(attr => attr.name === 'src' && attr.value === '/__sporades/observe.js')).length, 1, source);
    assert.equal(document.mode, 'no-quirks', source);
    assert.ok(injected.includes('<script nonce="test-nonce">window.__SPORADES_CONNECTION_TOKEN='), source);
  }
});

async function fixture(t, mode = 'dev', analytics = true, documentSource = page) {
  const root = await mkdtemp(path.join(repo, '.scratch', 'html-documents-'));
  let child;
  let containerId;
  t.after(async () => {
    if (containerId) {
      const removed = spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8', timeout: 30000 });
      assert.equal(removed.status, 0, removed.stderr);
    }
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
  }).listen(0, mode === 'docker' ? '0.0.0.0' : '127.0.0.1');
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
  if (mode === 'docker') {
    config.name = `html-document-${path.basename(root).toLowerCase()}`;
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    config.deploy.port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
  }
  config.security = { csp: { mode: 'enforce', nonce: true } };
  if (analytics) config.analytics = { provider: 'umami', endpointEnv: 'ANALYTICS_URL', websiteIdEnv: 'WEBSITE_ID' };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(project, '.env.sporades.server'), `ANALYTICS_URL=http://127.0.0.1:${receiver.address().port}/ingest\nWEBSITE_ID=html-document-test\n`);
  await mkdir(path.join(project, 'public/nested'), { recursive: true });
  for (const name of ['pricing.html', 'nested/PRICING.HTML']) await writeFile(path.join(project, 'public', name), documentSource);
  for (const [name, source] of Object.entries(headlessDocuments)) await writeFile(path.join(project, 'public', name), source);
  await writeFile(path.join(project, 'public/plain.txt'), '%SPORADES_NONCE%');
  if (mode === 'docker') {
    const deployed = spawnSync(process.execPath, [cli, 'deploy', '--no-telemetry', '--json'], { cwd: project, env, encoding: 'utf8', timeout: 120000 });
    // Capture ownership even if a post-start step failed, so cleanup is scoped.
    const binding = await readFile(path.join(project, '.sporades/binding.json'), 'utf8').catch(() => null);
    containerId = binding ? JSON.parse(binding).containerId : undefined;
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    assert.ok(containerId, 'deploy must retain its exact Container identity');
    // Keep the supported loopback HTTP provider contract inside the Container.
    // This disposable forwarder reaches only this test's local fake receiver.
    const receiverPort = receiver.address().port;
    const forwarded = spawnSync('docker', ['exec', '-d', containerId, 'node', '--input-type=module', '-e', `
      import net from 'node:net';
      net.createServer(socket => {
        const upstream = net.connect(${receiverPort}, 'host.docker.internal');
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
      }).listen(${receiverPort}, '127.0.0.1');
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(forwarded.status, 0, forwarded.stderr);
    const listening = spawnSync('docker', ['exec', containerId, 'node', '--input-type=module', '-e', `
      import net from 'node:net';
      setTimeout(() => process.exit(1), 5000);
      function probe() {
        const socket = net.connect(${receiverPort}, '127.0.0.1');
        socket.on('connect', () => process.exit(0));
        socket.on('error', () => setTimeout(probe, 25));
      }
      probe();
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(listening.status, 0, listening.stderr);
    const origin = `http://localhost:${config.deploy.port}`;
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(new URL('/pricing.html', origin), { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        ready = response.status === 200;
      } catch { /* Docker can accept connections before the runtime is listening. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, spawnSync('docker', ['logs', containerId], { encoding: 'utf8', timeout: 5000 }).stderr);
    return { origin, received, project };
  }
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

for (const mode of ['dev', 'container']) test(`${mode} preserves parsing modes when injecting into omitted-head documents`, { timeout: 30000 }, async t => {
  const { origin, project } = await fixture(t, mode);
  for (const [name, source] of Object.entries(headlessDocuments)) {
    const response = await fetch(new URL('/' + name, origin), { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const document = parse(html);
    assert.equal(document.mode, name === 'quirks.html' ? 'quirks' : 'no-quirks', name);
    assert.equal(document.childNodes.find(node => node.nodeName === '#documentType')?.name, name === 'quirks.html' ? undefined : 'html', name);
    assert.ok(html.indexOf('window.__SPORADES_CONNECTION_TOKEN=') < html.indexOf('window.tokenBeforeCapsule'), name);
    assert.equal(await readFile(path.join(project, 'public', name), 'utf8'), source);
  }
});

for (const mode of ['dev', 'container', 'docker']) test(`Chromium preserves standards-mode layout and injection for ${mode} documents with omitted head tags`, {
  skip: process.env.SPORADES_REAL_CSP_BROWSER !== '1' || (mode === 'docker' && process.env.SPORADES_REAL_HTML_CONTAINER !== '1'),
  timeout: mode === 'docker' ? 150000 : 30000,
}, async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SPORADES_CSP_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const { origin, received } = await fixture(t, mode, true, headlessPage);
  const tab = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  tab.on('pageerror', error => errors.push(error.message));
  tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const tokenRefetches = [];
  tab.on('request', request => { if (new URL(request.url()).pathname === '/__sporades/connection-token') tokenRefetches.push(request.url()); });
  for (const name of ['pricing.html', 'omitted-root.html', 'prologue.html', 'comment-head.html', 'script-head.html']) await t.test(name, async () => {
    const collected = tab.waitForResponse(response => new URL(response.url()).pathname === '/__sporades/collect' && response.status() === 204, { timeout: 3000 }).catch(() => null);
    await tab.goto(new URL('/' + name, origin).href);
    assert.equal(await tab.evaluate(() => window.capsuleExecuted), true, 'the Capsule script executes');
    assert.equal(await tab.evaluate(() => window.example), name === 'script-head.html' ? '<head>' : undefined, 'script text stays intact');
    assert.deepEqual(await tab.evaluate(() => ({
      mode: document.compatMode,
      doctype: document.doctype && { name: document.doctype.name, publicId: document.doctype.publicId, systemId: document.doctype.systemId },
      boxHeight: document.querySelector('#box').getBoundingClientRect().height,
      tokenBeforeCapsule: window.tokenBeforeCapsule, loaderBeforeCapsule: window.loaderBeforeCapsule,
      loaderCount: document.querySelectorAll('script[src="/__sporades/observe.js"]').length,
      loaderNonce: !!document.querySelector('script[src="/__sporades/observe.js"]').nonce,
    })), { mode: 'CSS1Compat', doctype: { name: 'html', publicId: '', systemId: name === 'prologue.html' ? 'about:legacy-compat' : '' }, boxHeight: 40, tokenBeforeCapsule: true,
      loaderBeforeCapsule: true, loaderCount: 1, loaderNonce: true }, name);
    await tab.waitForFunction(() => window.socketOpened === true);
    assert.ok(await collected, 'the initial pageview is collected');
    assert.equal(received.at(-1)?.payload.url, '/' + name);
  });
  assert.deepEqual(tokenRefetches, []);
  assert.deepEqual(errors, []);
});
