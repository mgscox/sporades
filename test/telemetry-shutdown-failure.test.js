import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'sporades.js');
const failure = 'scoped shutdown fixture failure';

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function waitForHttp(url, running) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) throw new Error(`Process exited before HTTP readiness: ${JSON.stringify(running.output())}`);
    const response = await fetch(url).catch(() => null);
    if (response) return response;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP readiness timed out: ${JSON.stringify(running.output())}`);
}

test('Dev and generated Bundle flush queued OTLP signals after Capsule shutdown rejection', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sporades-shutdown-telemetry-'));
  const received = [];
  const receiver = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(parts).toString()) });
    response.writeHead(200).end('{}');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  let running;
  try {
    const configDir = path.join(dir, 'config');
    await mkdir(configDir);
    await writeFile(path.join(configDir, 'telemetry.json'), JSON.stringify({ schemaVersion: 1, profiles: { local: {
      endpoint: `http://127.0.0.1:${receiver.address().port}`, tls: { mode: 'loopback' }, metricsIntervalMs: 5000,
    } } }));
    const created = launch([cli, 'create', 'shutdown-telemetry', '--template', 'blank', '--framework', 'vanilla', '--no-install', '--no-git', '--json'], dir, { SPORADES_CONFIG_DIR: configDir });
    assert.equal((await created.exited).code, 0, JSON.stringify(created.output()));
    const project = path.join(dir, 'shutdown-telemetry');
    await writeFile(path.join(project, 'server', 'index.ts'), `import { capsule } from 'sporades/server';\nexport default capsule({ name: 'shutdown-telemetry', hooks: { shutdown: () => { throw new Error('${failure}'); } } });\n`);
    const configPath = path.join(project, 'sporades.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.dev.port = await freePort();
    config.telemetry = { profile: 'local' };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const env = { SPORADES_CONFIG_DIR: configDir };
    for (const mode of ['Dev', 'Bundle']) {
      const port = mode === 'Dev' ? config.dev.port : await freePort();
      running = mode === 'Dev'
        ? launch([cli, 'dev', '--json'], project, env)
        : launch([path.join(project, '.sporades', 'build', 'server.mjs')], project, {
          ...env, PORT: String(port), SPORADES_SECURITY_SESSION: 'container', SPORADES_DATABASE_PATH: path.join(dir, 'bundle-data.db'),
          SPORADES_CONTAINER_TELEMETRY_CONFIG: JSON.stringify({ endpoint: `http://127.0.0.1:${receiver.address().port}`, tls: { mode: 'loopback' }, serviceName: 'shutdown-telemetry', metricsIntervalMs: 5000 }),
        });
      const response = await waitForHttp(`http://127.0.0.1:${port}/`, running);
      assert(response.status > 0);
      if (mode === 'Dev') {
        const deadline = Date.now() + 5000;
        while (!running.output().stdout.includes('"event":"started"') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(running.output().stdout.includes('"event":"started"'), `Dev startup event missing: ${JSON.stringify(running.output())}`);
      }
      const before = received.length;
      const started = Date.now();
      running.child.kill('SIGTERM');
      let exitTimer;
      const result = await Promise.race([running.exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error(`${mode} exit timed out`)), 5000); })]);
      clearTimeout(exitTimer);
      assert.equal(result.code, 1, `${mode}: ${JSON.stringify(running.output())}`);
      assert.match(running.output().stderr, new RegExp(failure));
      assert(Date.now() - started < 5000, `${mode} shutdown exceeded bounded deadline`);
      const signals = new Set(received.slice(before).map(item => item.path));
      assert(signals.has('/v1/traces'), `${mode} lost queued spans: ${JSON.stringify([...signals])}`);
      assert(signals.has('/v1/metrics'), `${mode} lost final metrics: ${JSON.stringify([...signals])}`);
      const spans = received.slice(before).filter(item => item.path === '/v1/traces')
        .flatMap(item => item.body.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? [])
        .flatMap(scope => scope.spans ?? []);
      assert(spans.some(span => span.name?.includes('GET')), `${mode} did not export the completed HTTP request span`);
      const metrics = received.slice(before).filter(item => item.path === '/v1/metrics')
        .flatMap(item => item.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? [])
        .flatMap(scope => scope.metrics ?? []);
      assert(metrics.some(metric => metric.name === 'http.server.request.count'), `${mode} did not export final HTTP request metrics`);
      running = null;
    }
  } finally {
    if (running?.child.exitCode === null) running.child.kill('SIGKILL');
    receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
