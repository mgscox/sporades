import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';

const repo = process.cwd();
const cli = path.join(repo, 'bin', 'sporades.js');

function upgrade(base, target) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: target, headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    } });
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode }); });
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve({ status: null }) : reject(error));
    request.setTimeout(5000, () => request.destroy(new Error('upgrade timeout')));
    request.end();
  });
}

test('Dev denies Capsule WebSocket upgrades with the same opaque HTTP response', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(repo, '.agent-tmp-ws-dev-'));
  const configDir = path.join(root, 'config');
  const env = { ...process.env, SPORADES_CONFIG_DIR: configDir };
  let child;
  let output = '', errors = '';
  try {
    const created = spawnSync(process.execPath, [cli, 'create', 'app', '--template', 'blank', '--framework', 'vanilla', '--no-install', '--no-git', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(created.status, 0, created.stderr);
    const project = path.join(root, 'app');
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await symlink(repo, path.join(project, 'node_modules', 'sporades'));
    const configPath = path.join(project, 'sporades.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.dev.port = 0;
    config.admissionPolicy = { path: 'policy.json' };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(project, 'policy.json'), JSON.stringify({ version: 1, rules: [{
      id: 'opaque-deny-rule', enabled: true, conditions: [{ kind: 'pathname', exact: '/__sporades/ws' }], action: { kind: 'deny' },
    }] }));

    child = spawn(process.execPath, [cli, 'dev', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    let started;
    const deadline = Date.now() + 20000;
    while (!started && Date.now() < deadline) {
      assert.equal(child.exitCode, null, output + errors);
      for (const line of output.split('\n')) {
        try { const event = JSON.parse(line); if (event?.data?.event === 'started') started = event; } catch {}
      }
      if (!started) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(started, output + errors);
    const base = started.data.url;
    const tokenResponse = await fetch(base + '/__sporades/connection-token', { headers: { 'x-sporades-connection-token-request': '1' } });
    assert.equal(tokenResponse.status, 200);
    const { token } = await tokenResponse.json();
    assert.equal(typeof token, 'string');
    const target = '/__sporades/ws?connectionToken=' + encodeURIComponent(token);
    const ordinary = await fetch(base + target);
    const denied = await upgrade(base, target);
    assert.equal(denied.status, 403);
    assert.equal(denied.body, 'Forbidden\n');
    assert.equal(ordinary.status, 403);
    assert.equal(await ordinary.text(), denied.body);
    for (const name of ['cache-control', 'content-type', 'content-length', 'connection', 'x-content-type-options']) {
      assert.equal(denied.headers[name], ordinary.headers.get(name), name);
    }
    assert.equal((output + errors).includes('opaque-deny-rule'), false);
    assert.equal((output + errors).includes(token), false);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
