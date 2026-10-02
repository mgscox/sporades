import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const dockerEnabled = process.env.SPORADES_FETCH_DOCKER === '1';

// Exercise shipped modules from npm pack, then execute their self-contained ESM output.
test('packaged generated fetch Bundle on supported runtimes and the exact Base image', { timeout: 300_000 }, async t => {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/telemetry-fetch-'));
  const payloads = [], calls = [];
  const collector = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString())); res.end('{}');
  }).listen(0, '0.0.0.0');
  const dependency = createServer(async (req, res) => {
    calls.push({ url: req.url, traceparent: req.headers.traceparent, baggage: req.headers.baggage });
    if (req.url.startsWith('/reset')) { req.socket.destroy(); return; }
    await pause(req.url.startsWith('/slow') ? 150 : 5);
    if (!res.destroyed) res.end('dependency-result');
  }).listen(0, '0.0.0.0');
  await Promise.all([once(collector, 'listening'), once(dependency, 'listening')]);
  try {
    const packed = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', root, '--silent']);
    await run('tar', ['-xzf', path.join(root, packed.stdout.trim()), '-C', root]);
    const { bundleServerCapsuleModule } = await import(pathToFileURL(path.join(root, 'package/dist/bundle-pipeline.js')));
    const { createServerBundleModuleSource } = await import(pathToFileURL(path.join(root, 'package/dist/templates/server-bundle-module-graph.js')));
    const targets = [{ name: `local ${process.version}` },
      ...['node:22.13.0-alpine', 'node:24-alpine', 'ghcr.io/sporades/sporades-base:0.2.0-node22-alpine'].map(image => ({ name: image, image }))];
    for (const target of targets) await t.test(target.name, { skip: target.image && !dockerEnabled ? 'Set SPORADES_FETCH_DOCKER=1 for isolated Docker matrix.' : false }, async () => {
      const offset = payloads.length, callOffset = calls.length;
      const dir = path.join(root, target.image ? target.image.replace(/[^a-z0-9]/g, '-') : 'local');
      await mkdir(path.join(dir, 'data'), { recursive: true, mode: 0o777 });
      await chmod(path.join(dir, 'data'), 0o777);
      const host = target.image ? 'host.docker.internal' : '127.0.0.1';
      const origin = `http://${host}:${dependency.address().port}`;
      const serverSource = `import { capsule, endpoint } from 'sporades/server';
export default capsule({ name: 'fetch-bundle', endpoints: { work: endpoint({ method: 'GET', path: '/work' }, async ctx => {
  const mode = ctx.request.query.mode ?? 'slow';
  const controller = new AbortController();
  const signal = mode === 'timeout' ? AbortSignal.timeout(25) : controller.signal;
  if (mode === 'cancel') setTimeout(() => controller.abort(new Error('private-cancellation')), 25);
  try {
    const response = await fetch(${JSON.stringify(origin)} + '/' + (mode === 'timeout' || mode === 'cancel' ? 'slow' : mode) + '/private-person?secret=private-query', { redirect: 'manual', signal, headers: { authorization: 'private-token' } });
    return { status: 200, body: { result: await response.text() } };
  } catch (error) { return { status: 200, body: { result: signal.aborted ? 'aborted' : 'network-error' } }; }
}) } });`;
      const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
      const source = await createServerBundleModuleSource({ config: { name: 'fetch-bundle', __sporadesTelemetry: {
        endpoint: `http://${host}:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'fetch-bundle', tracePropagationOrigins: [origin],
      } }, serverEnv: {}, serverSource, serverModuleSource,
        epilogue: 'process.stdout.write(JSON.stringify({ listening: server.address().port }) + "\\n");' });
      await writeFile(path.join(dir, 'server.mjs'), source);
      let child, containerName, stdout = '', stderr = '';
      try {
        if (target.image) {
          containerName = `ken-123-fetch-${process.pid}-${targets.indexOf(target)}`;
          child = spawn('docker', ['run', '--rm', '--name', containerName, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--mount', `type=bind,src=${dir},dst=/app,readonly`, '--mount', `type=bind,src=${dir}/data,dst=/app/data`,
            '--workdir', '/app', '--env', 'PORT=5218', '--env', 'SPORADES_CONFIG_DIR=/app/data/config', '--publish', '127.0.0.1::5218', target.image, 'node', '/app/server.mjs']);
        } else child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { cwd: dir, env: { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(dir, 'config') } });
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        let listening;
        const deadline = Date.now() + 90_000;
        while (!listening && Date.now() < deadline) {
          listening = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
          if (child.exitCode !== null) throw new Error(`Bundle exited: ${stdout}\n${stderr}`);
          if (!listening) await pause(50);
        }
        assert(listening, stderr);
        const port = target.image ? Number((await run('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5218/tcp") 0).HostPort}}', containerName])).stdout.trim()) : listening;
        const modes = ['slow', 'fast', 'reset', 'timeout', 'cancel'];
        const responses = await Promise.all(modes.map((mode, i) => fetch(`http://127.0.0.1:${port}/work?mode=${mode}`, {
          headers: { traceparent: `00-${String(i + 1).repeat(32)}-${'a'.repeat(16)}-01`, baggage: 'secret=private-baggage' },
        }).then(async response => { assert.equal(response.status, 200); return response.json(); })));
        assert.deepEqual(responses.map(r => r.result), ['dependency-result', 'dependency-result', 'network-error', 'aborted', 'aborted']);
        await pause(750);
        if (containerName) await run('docker', ['stop', '--time', '5', containerName]); else child.kill('SIGTERM');
        if (child.exitCode === null) await Promise.race([once(child, 'exit'), pause(5000)]);
        assert.equal(child.exitCode, 0, stderr);
        const spans = payloads.slice(offset).flatMap(p => (p.resourceSpans ?? []).flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
        const children = spans.filter(s => s.kind === 3), parents = spans.filter(s => s.kind === 2 && s.name === 'GET /work');
        assert.equal(children.length, modes.length, stderr); assert.equal(parents.length, modes.length);
        const outcome = s => s.attributes.find(a => a.key === 'sporades.http.outcome').value.stringValue;
        for (const child of children) assert.equal(child.parentSpanId, parents.find(p => p.traceId === child.traceId)?.spanId);
        assert.deepEqual(children.map(outcome).sort(), ['cancelled', 'network_error', 'success', 'success', 'timeout']);
        const slow = children.find(s => s.traceId === '1'.repeat(32));
        assert(Number(BigInt(slow.endTimeUnixNano) - BigInt(slow.startTimeUnixNano)) / 1e6 >= 120);
        for (const call of calls.slice(callOffset)) {
          assert.equal(call.baggage, undefined);
          const [, traceId, spanId] = call.traceparent.split('-');
          assert(children.some(s => s.traceId === traceId && s.spanId === spanId));
        }
        assert.doesNotMatch(JSON.stringify(payloads.slice(offset)), /private-person|private-query|private-token|private-cancellation|private-baggage/);
        if (target.image) {
          const evidence = await run('docker', ['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', target.image]);
          t.diagnostic(`${target.image}: ${evidence.stdout.trim()}`);
        }
      } finally {
        if (containerName) await run('docker', ['stop', '--time', '2', containerName]).catch(() => {});
        else if (child && child.exitCode === null) child.kill('SIGKILL');
      }
    });
  } finally { await Promise.all([close(collector), close(dependency)]); await rm(root, { recursive: true, force: true }); }
});
