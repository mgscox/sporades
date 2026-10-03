#!/usr/bin/env node
// Local disposable Docker transport acceptance. No SSH or real Host profiles.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const repository = process.cwd();
assert(process.env.SPORADES_CONFIG_DIR?.startsWith(repository + path.sep), 'Set SPORADES_CONFIG_DIR inside this worktree.');
const base = path.join(repository, '.sporades', 'inventory-docker');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'run-'));
const suffix = randomBytes(5).toString('hex');
const prefix = `ken118-${suffix}`;
const image = `${prefix}-gateway`;
const network = `${prefix}-network`;
const monitoring = `${prefix}-monitoring`;
const host = `${prefix}-host`;
const scope = 'xn--bcher-kva.example';
const subname = 'a--b';
const neighborDomain = 'z--neighbor.example';
const neighborSubname = 'xn--bcher-kva';
const credential = randomBytes(24).toString('hex');
const wrongCredential = randomBytes(24).toString('hex');
const run = (program, args, timeout = 60_000, input) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout, input, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${program} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const docker = (...args) => run('docker', args);
const user = `${process.getuid()}:${process.getgid()}`;
const hostRoot = path.join(root, 'host');
const inventoryDirectory = path.join(root, 'central');
const certs = path.join(root, 'certs');
const telemetry = path.join(hostRoot, 'telemetry');
const registry = path.join(hostRoot, 'hosts', scope, 'registry', 'capsules');
const hostVolume = `${prefix}-host-state`;
const centralVolume = `${prefix}-central-state`;
let hostStarted = false;
let evidence;
try {
  for (const directory of [inventoryDirectory, certs, telemetry]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(registry, { recursive: true });
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certs, 'key.pem'), '-out', path.join(certs, 'cert.pem'), '-days', '1', '-subj', '/CN=inventory-monitor', '-addext', 'subjectAltName=DNS:inventory-monitor']);
  const privateFile = path.join(root, 'credentials.json');
  await writeFile(privateFile, JSON.stringify({ ingestToken: randomBytes(24).toString('hex'), uiUser: 'operator', uiPassword: randomBytes(24).toString('hex'), inventoryHosts: { [scope]: credential, 'other.example': wrongCredential } }), { mode: 0o600 });
  await writeFile(path.join(telemetry, 'connection.json'), JSON.stringify({ schemaVersion: 1, endpoint: 'https://inventory-monitor:8443/', internalEndpoint: 'http://sporades-telemetry:4318/', network: 'unused', inventoryHost: scope, caConfigured: true, inventory: { generation: randomBytes(16).toString('hex'), credential, caPem: (await readFile(path.join(certs, 'cert.pem'))).toString() } }), { mode: 0o600 });
  await writeFile(path.join(telemetry, 'ca.pem'), await readFile(path.join(certs, 'cert.pem')));
  let changed = 0;
  const persist = async data => {
    const directory = path.join(hostRoot, 'hosts', data.domain, 'registry/capsules');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, data.subname + '.json'), JSON.stringify(data));
    if (hostStarted) run('docker', ['exec', '--interactive', host, 'node', '-e', `require('node:fs').writeFileSync('/host/hosts/${data.domain}/registry/capsules/${data.subname}.json',require('node:fs').readFileSync(0))`], 60_000, JSON.stringify(data));
  };
  const record = async (state, release = 'release-1', optedOut = false) => {
    const data = { domain: scope, subname, remoteCapsuleId: `${scope}/${subname}`, hostedUrl: `https://${subname}.${scope}`, aliasDomains: ['xn--bcher-kva.example', 'alias--one.example', ...Array.from({ length: 18 }, (_, i) => `alias-${i}.example`)], status: state, updatedAt: new Date(Date.now() + changed++).toISOString(), currentRelease: { id: release }, telemetry: { disabled: optedOut } };
    await persist(data);
  };
  const neighbor = release => persist({ domain: neighborDomain, subname: neighborSubname, hostedUrl: `https://${neighborSubname}.${neighborDomain}/`, status: 'running', updatedAt: new Date(Date.now() + changed++).toISOString(), currentRelease: { id: release } });
  await record('registered');
  await neighbor('neighbor-release-1');
  // Check generated persistent timer units on disposable Linux with local systemctl fakes.
  const unitScript = `
    const fs = await import('node:fs/promises');
    const assert = (await import('node:assert/strict')).default;
    const { installHostInventoryWorker, inventoryUnit } = await import('/source/dist/cli/host-inventory.js');
    await fs.mkdir('/tmp/unit-host/bin', {recursive:true});
    await fs.mkdir('/etc/systemd/system', {recursive:true});
    await fs.mkdir('/tmp/unit-bin', {recursive:true});
    await fs.copyFile('/source/bin/sporades-host-helper.js','/tmp/unit-host/bin/sporades-host-helper');
    await fs.writeFile('/tmp/unit-bin/systemctl', '#!/bin/sh\\nif [ "$1" = show ]; then echo loaded; fi\\nexit 0\\n', {mode:0o755});
    process.env.PATH = '/tmp/unit-bin:' + process.env.PATH;
    assert.equal((await installHostInventoryWorker('/tmp/unit-host')).installed,true);
    assert.equal((await installHostInventoryWorker('/tmp/unit-host')).installed,true);
    const name = inventoryUnit('/tmp/unit-host');
    const service = await fs.readFile('/etc/systemd/system/'+name+'.service','utf8');
    const timer = await fs.readFile('/etc/systemd/system/'+name+'.timer','utf8');
    assert(service.includes('--reconcile-inventory'));
    assert(!service.includes('Requires=docker'));
    assert(timer.includes('OnBootSec=30s') && timer.includes('OnUnitActiveSec=60s'));
    await fs.writeFile('/etc/systemd/system/'+name+'.service','operator-owned');
    await assert.rejects(installHostInventoryWorker('/tmp/unit-host'), /operator-owned/);
    console.log('timer-contract-passed');
  `;
  assert.equal(docker('run', '--rm', '--name', `${prefix}-units`, '--mount', `type=bind,source=${repository},target=/source,readonly`, '--env', 'SPORADES_CONFIG_DIR=/tmp/unit-config', 'node:24-bookworm-slim', 'node', '--input-type=module', '-e', unitScript), 'timer-contract-passed');
  run('docker', ['build', '--file', 'monitoring/trace/Dockerfile.gateway', '--tag', image, 'monitoring/trace'], 180_000);
  docker('network', 'create', network);
  docker('volume', 'create', hostVolume);
  docker('volume', 'create', centralVolume);
  docker('run', '--rm', '--name', `${prefix}-seed`, '--mount', `type=bind,source=${root},target=/fixtures,readonly`, '--mount', `type=volume,source=${hostVolume},target=/host`, '--mount', `type=volume,source=${centralVolume},target=/inventory`, 'node:24-bookworm-slim', 'sh', '-c', `cp -R /fixtures/host/. /host/ && chown -R ${user} /host /inventory && chmod 700 /host /host/telemetry /inventory`);
  const startGateway = () => docker('run', '--detach', '--name', monitoring, '--network', network, '--network-alias', 'inventory-monitor', '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '192m', '--pids-limit', '128', '--env', 'TRACE_TLS_MODE=tls', '--env', 'TRACE_BIND=127.0.0.1', '--env', 'TRACE_CERT_FILE=/certs/cert.pem', '--env', 'TRACE_KEY_FILE=/certs/key.pem', '--mount', `type=bind,source=${certs},target=/certs,readonly`, '--mount', `type=bind,source=${privateFile},target=/run/secrets/trace-credentials.json,readonly`, '--mount', `type=volume,source=${centralVolume},target=/inventory`, image);
  startGateway();
  docker('run', '--detach', '--name', host, '--network', network, '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '192m', '--pids-limit', '128', '--mount', `type=volume,source=${hostVolume},target=/host`, '--mount', `type=bind,source=${path.join(repository, 'bin/sporades-host-helper.js')},target=/helper.mjs,readonly`, '--env', 'SPORADES_CONFIG_DIR=/host/config', 'node:24-bookworm-slim', 'sleep', 'infinity');
  hostStarted = true;
  const reconcile = () => JSON.parse(docker('exec', host, 'node', '/helper.mjs', '--reconcile-inventory', Buffer.from('/host').toString('base64url')));
  // Poll without a long blocking sleep; only this isolated local gateway is contacted.
  let connected;
  for (let attempt = 0; attempt < 20; attempt++) {
    connected = reconcile();
    if (connected.ok && !connected.data.pending) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(connected.ok, true);
  assert.equal(connected.data.pending, false, JSON.stringify(connected));
  const centralFile = createHash('sha256').update(scope).digest('hex') + '.json';
  const central = async () => JSON.parse(docker('run', '--rm', '--name', `${prefix}-read`, '--user', user, '--read-only', '--cap-drop', 'ALL', '--mount', `type=volume,source=${centralVolume},target=/inventory,readonly`, 'node:24-bookworm-slim', 'node', '-e', `process.stdout.write(require('node:fs').readFileSync('/inventory/${centralFile}','utf8'))`));
  assert.equal((await central()).inventory.capsules[0].targets.length, 21, 'canonical origin and all 20 aliases reach central storage');
  assert.deepEqual((await central()).inventory.capsules.map(item => item.id), [`${scope}/${subname}`, `${neighborDomain}/${neighborSubname}`], 'punycode and consecutive-hyphen Hosted domains are never omitted');
  await neighbor('neighbor-release-2');
  assert.equal(reconcile().data.pending, false);
  assert.equal((await central()).inventory.capsules[1].release, 'neighbor-release-2', 'neighbor updates continue alongside supported DNS names');
  const states = [];
  for (const state of ['released', 'running', 'stopped']) {
    await record(state);
    assert.equal(reconcile().data.pending, false);
    states.push((await central()).inventory.capsules[0].state);
  }
  await record('running', 'release-2'); reconcile();
  await record('running', 'release-1'); reconcile(); // registry-owned rollback release
  assert.equal((await central()).inventory.capsules[0].release, 'release-1');
  await record('running', 'release-1', true); reconcile();
  assert.equal((await central()).inventory.capsules[0].state, 'opted-out');
  assert.deepEqual((await central()).inventory.capsules[0].targets, []);
  const priorRevision = (await central()).inventory.revision;
  docker('rm', '-f', monitoring);
  await record('running', 'release-3');
  const offline = reconcile();
  assert.equal(offline.data.pending, true);
  assert.equal(offline.data.acknowledgedRevision, priorRevision);
  assert.equal((await central()).inventory.revision, priorRevision, 'outage cannot erase central expectations');
  docker('restart', host); // worker state is independent of workstation/process lifetime
  startGateway();
  for (let attempt = 0; attempt < 20; attempt++) {
    connected = reconcile(); if (!connected.data.pending) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(connected.data.pending, false);
  assert.equal((await central()).inventory.capsules[0].release, 'release-3');
  const snapshot = (await central()).inventory;
  const requestScript = `const fs=require('node:fs');const https=require('node:https');const s=JSON.parse(fs.readFileSync(0));const r=https.request('https://inventory-monitor:8443/v1/inventory/${scope}',{ca:fs.readFileSync('/host/telemetry/ca.pem'),method:'PUT',headers:{authorization:'Bearer '+s.credential,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>process.stdout.write(String(res.statusCode)))});r.on('error',()=>process.exit(1));r.end(JSON.stringify(s.inventory));`;
  const put = async (inventory, auth) => run('docker', ['exec', '--interactive', host, 'node', '-e', requestScript], 60_000, JSON.stringify({ inventory, credential: auth }));
  assert.equal(await put({ ...snapshot, revision: 1 }, credential), '409');
  assert.equal(await put(snapshot, wrongCredential), '403');
  assert.equal(await put({ ...snapshot, capsules: [] }, credential), '409');
  await record('unregistered'); reconcile();
  docker('exec', host, 'node', '-e', `require('node:fs').unlinkSync('/host/hosts/${scope}/registry/capsules/${subname}.json')`); reconcile();
  assert.equal((await central()).inventory.capsules[0].state, 'deleted');
  assert.equal((await central()).inventory.capsules[1].release, 'neighbor-release-2');
  evidence = { topology: 'two isolated Linux Docker containers, authenticated TLS, persisted independent state', sourceVersion: JSON.parse(await readFile('package.json', 'utf8')).version, states, connectionGeneration: true, canonicalAndTwentyAliases: true, supportedDnsNames: true, neighboringCapsuleUpdates: true, registryRollback: true, optOut: true, staleAndConflictingDenied: true, crossHostDenied: true, outageRetainsExpectations: true, hostAndGatewayRestart: true, deletion: true, timerUnitContract: true, operatorUnitConflictDenied: true, realSeparateVmAcceptance: 'not rerun; see committed separate-VM evidence and its qualification' };
  await writeFile(path.join(base, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  for (const name of [host, monitoring, `${prefix}-seed`, `${prefix}-units`, `${prefix}-read`]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  for (const volume of [hostVolume, centralVolume]) spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore' });
  await rm(root, { recursive: true, force: true });
}
