#!/usr/bin/env node
// Disposable local Linux gateway acceptance. Never connects to a Host or cloud.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SPORADES_CONFIG_DIR = path.join(root, '.test-config');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'unavailable'}): ${result.stderr ?? ''}`);
  return result.stdout.trim();
}
const endpoint = process.env.DOCKER_HOST || JSON.parse(run('docker', ['context', 'inspect']))[0]?.Endpoints?.docker?.Host;
if (!endpoint?.startsWith('unix:')) throw new Error('Use a local Unix-socket Docker context for inventory acceptance');
await mkdir(path.join(root, '.test-tmp'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.test-tmp', 'inventory-docker-'));
const suffix = `${process.pid}-${Date.now()}`;
const container = `ken-inventory-${suffix}`, volume = `${container}-state`, image = `sporades-inventory-${suffix}:test`;
const uid = process.getuid(), gid = process.getgid();
let madeContainer = false, madeVolume = false, madeImage = false;
try {
  run('docker', ['build', '--tag', image, '--file', 'monitoring/trace/Dockerfile.gateway', 'monitoring/trace']); madeImage = true;
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  await writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ ingestToken: 'test-ingest-token', uiUser: 'test', uiPassword: 'test-ui-password', inventoryHosts: { 'host-one': 'test-inventory-token-one', 'host-two': 'test-inventory-token-two' } }), { mode: 0o600 });
  run('docker', ['volume', 'create', volume]); madeVolume = true;
  run('docker', ['run', '--rm', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/inventory`, '--entrypoint', 'sh', image, '-c', `chown ${uid}:${gid} /inventory && chmod 700 /inventory`]);
  run('docker', ['run', '--detach', '--name', container, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`, '--memory', '192m', '--pids-limit', '128', '--env', 'TRACE_TLS_MODE=tls', '--env', 'TRACE_CERT_FILE=/fixtures/cert.pem', '--env', 'TRACE_KEY_FILE=/fixtures/key.pem', '--mount', `type=bind,source=${dir},target=/fixtures,readonly`, '--mount', `type=bind,source=${path.join(dir, 'credentials.json')},target=/run/secrets/trace-credentials.json,readonly`, '--mount', `type=volume,source=${volume},target=/inventory`, image]); madeContainer = true;
  const client = `import {request} from 'node:https';import {readFileSync} from 'node:fs';const input=JSON.parse(process.argv[1]);const result=await new Promise((resolve,reject)=>{const req=request('https://localhost:8443/v1/inventory/'+input.host,{method:input.method,ca:readFileSync('/fixtures/cert.pem'),headers:{authorization:'Bearer '+input.token,'content-type':'application/json'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(input.value?JSON.stringify(input.value):undefined);});process.stdout.write(JSON.stringify(result));`;
  const send = (method, value, token = 'test-inventory-token-one', host = 'host-one') => JSON.parse(run('docker', ['exec', container, 'node', '--input-type=module', '-e', client, JSON.stringify({ method, value, token, host })]));
  const value = (revision, state = 'started') => ({ schemaVersion: 1, host: 'host-one', revision, capsules: [{ identity: 'apps.example/notes', state, targets: state === 'deleted' ? [] : ['https://notes.apps.example/'] }] });
  // Bounded startup retries; every request uses the generated CA and hostname.
  let first;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { first = send('PUT', value(2)); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal(first?.status, 200);
  assert.deepEqual(send('PUT', value(2)).body, first.body);
  assert.equal(send('PUT', value(1)).status, 409);
  assert.equal(send('PUT', value(2, 'stopped')).status, 409);
  assert.equal(send('PUT', value(3), 'test-inventory-token-two').status, 403);
  assert.equal(send('GET', undefined, 'test-ingest-token').status, 403);
  assert.equal(send('PUT', value(3, 'stopped')).status, 200);
  run('docker', ['restart', container]);
  let stored;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { stored = send('GET'); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal(stored?.body.inventory.revision, 3); assert.equal(stored.body.inventory.capsules[0].state, 'stopped');
  assert.equal(send('PUT', value(4, 'opted-out')).status, 200);
  assert.equal(send('PUT', value(5, 'deleted')).status, 200);
  assert.equal(send('GET').body.inventory.capsules[0].state, 'deleted');
  process.stdout.write(JSON.stringify({ ok: true, topology: 'local Linux Docker gateway and persistent inventory volume; verified HTTPS', checks: ['durable stored lifecycle state', 'canonical retry acknowledgement', 'stale and conflicting revision denial', 'cross-Host and ingestion authority denial', 'gateway restart retention', 'opt-out and deletion tombstones'] }) + '\n');
} finally {
  if (madeContainer) run('docker', ['rm', '--force', container]);
  if (madeVolume) run('docker', ['volume', 'rm', volume]);
  if (madeImage) run('docker', ['image', 'rm', image]);
  await rm(dir, { recursive: true, force: true });
}
