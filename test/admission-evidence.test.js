import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAdmissionPolicy } from '../dist/admission-policy.js';
import { createAdmissionEvidence, inspectAdmissionHealth, ADMISSION_EVIDENCE_LIMITS } from '../dist/admission-evidence.js';
import { routeHttpAdmission, routeWebSocketAdmission } from '../dist/http-runtime.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';
import { runDoctorChecks, renderDoctorHumanOutput } from '../dist/cli/doctor.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const probe = 'a'.repeat(64);
const deny = (id = 'deny', prefix = '/blocked') => ({ id, enabled: true, conditions: [{ kind: 'pathname', prefix }], action: { kind: 'deny' } });
const quota = { id: 'quota', enabled: true, conditions: [{ kind: 'pathname', exact: '/limited' }], action: { kind: 'rate-limit', limit: 1, windowMs: 60000 } };
const policy = rules => JSON.stringify({ version: 1, rules });
const request = (url, address = '192.0.2.1') => {
  const headers = { 'x-sporades-client-address': address, 'x-sporades-client-address-token': clientAddressBoundaryToken(probe), 'x-mode': 'sensitive-match' };
  return { url, method: 'POST', rawHeaders: Object.entries(headers).flat(), headers };
};
const response = () => ({ status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
async function temporary(fn) {
  const root = await mkdtemp(path.join(repo, '.agent-tmp-evidence-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('exact HTTP/WS totals include quotas, evictions, malformed input, and every failure/recovery, with opaque responses', async () => temporary(async root => {
  await writeFile(path.join(root, 'policy.json'), policy([deny(), quota]));
  const events = [], logs = []; let now = 0;
  const runtime = await openAdmissionPolicy(root, 'policy.json', (health, event) => events.push({ health, event }), { now: () => now, maxBuckets: 2 });
  const database = { securitySession: 'hosted', runtimeProbeToken: probe, admissionPolicy: runtime, log: { emit: event => logs.push(event) } };
  try {
    for (const [url, address, status] of [
      ['/blocked?credential=sensitive-query', '192.0.2.1', 403], ['/allowed', '192.0.2.1', null],
      ['/limited', '192.0.2.1', null], ['/limited', '192.0.2.1', 429],
      ['/limited', '192.0.2.2', null], ['/limited', '192.0.2.3', null], ['/bad%escape', '192.0.2.1', 403],
    ]) { const res = response(); routeHttpAdmission(database, request(url, address), res); assert.equal(res.status, status); }
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const upgrade = new IncomingMessage(new Socket()); upgrade.method = 'GET'; upgrade.url = '/blocked';
    assert.equal(routeWebSocketAdmission(database, upgrade, socket), true);
    await new Promise(resolve => setImmediate(resolve)); socket.destroy();
    // Genuine controls neither evaluate nor consume a sample/quota.
    upgrade.url = '/__sporades/health/runtime'; const control = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    assert.equal(routeWebSocketAdmission(database, upgrade, control), true);
    assert.deepEqual(runtime.health().evidence.counters, { evaluated: '8', admitted: '4', denied: '3', rateLimited: '1', reloadFailures: '0', reloadRecoveries: '0', limiterEvictions: '1', decisionsEmitted: '5', decisionsSuppressed: '3' });
    assert.deepEqual(logs[0].data, { digest: runtime.health().digest, ruleId: 'deny', action: 'deny', outcome: 'denied', transport: 'http', routeClass: 'ordinary', sessionKind: 'hosted' });
    assert.equal(logs.filter(log => log.data.ruleId === 'deny' && log.data.outcome === 'denied').length, 1);
    // Advance the monotonic sample window to see the same rule through the other transport.
    now = ADMISSION_EVIDENCE_LIMITS.windowMs;
    const nextSocket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    const nextUpgrade = Object.assign(new IncomingMessage(new Socket()), { method: 'GET', url: '/blocked' });
    assert.equal(routeWebSocketAdmission(database, nextUpgrade, nextSocket), true);
    await new Promise(resolve => setImmediate(resolve)); nextSocket.destroy();
    assert.deepEqual(logs.filter(log => log.data.ruleId === 'deny').map(log => log.data.transport), ['http', 'websocket']);
    const digest = runtime.health().digest;
    for (let i = 0; i < 3; i++) { await writeFile(path.join(root, 'policy.json'), 'invalid-sensitive-bytes'); await runtime.reload(); }
    assert.equal(runtime.health().state, 'degraded'); assert.equal(runtime.health().digest, digest);
    await writeFile(path.join(root, 'policy.json'), policy([deny('recovered')])); await runtime.reload();
    assert.deepEqual(events.map(e => e.event), ['loaded', 'failure', 'failure', 'failure', 'recovery']);
    assert.equal(runtime.health().evidence.counters.reloadFailures, '3'); assert.equal(runtime.health().evidence.counters.reloadRecoveries, '1');
    const output = JSON.stringify({ logs, events, health: runtime.health() });
    for (const secret of ['192.0.2.', 'sensitive-query', 'sensitive-match', 'invalid-sensitive-bytes', 'x-sporades', probe]) assert.equal(output.includes(secret), false, secret);
    const cold = [];
    await assert.rejects(openAdmissionPolicy(root, 'missing-policy.json', (health, event) => cold.push({ health, event })), /could not be loaded/);
    assert.equal(cold[0].event, 'failure'); assert.equal(cold[0].health.evidence.counters.reloadFailures, '1');
  } finally { await runtime.close(); }
}));

test('policy churn and throwing sinks cannot grow the sampling table or interrupt accounting', () => {
  let now = 0; const evidence = createAdmissionEvidence(() => now);
  for (let i = 0; i < 10000; i++) evidence.decision({ digest: 'a'.repeat(64), ruleId: `rule${i}`, action: 'deny', outcome: 'denied', sessionKind: 'hosted', transport: 'http', routeClass: 'ordinary' }, () => { throw new Error('unavailable sink'); });
  assert.equal(evidence.snapshot().counters.denied, '10000'); assert.equal(evidence.snapshot().counters.decisionsEmitted, '20');
  assert.equal(evidence.snapshot().sampling.retainedKeys, 20);
  now = 60000;
  evidence.decision({ digest: 'b'.repeat(64), ruleId: 'rule0', action: 'deny', outcome: 'denied', sessionKind: 'hosted', transport: 'http', routeClass: 'ordinary' }, () => {});
  assert.equal(evidence.snapshot().sampling.retainedKeys, 1); assert.equal(evidence.snapshot().counters.decisionsEmitted, '21');
});

test('operator projection strips extra fields and rejects attacker-shaped counters/digests', () => {
  const health = { state: 'degraded', digest: 'b'.repeat(64), evidence: createAdmissionEvidence().snapshot(), rateLimit: { buckets: 2, maxBuckets: 3, evictions: 1 } };
  assert.deepEqual(inspectAdmissionHealth({ ...health, address: '192.0.2.1', rule: 'secret', evidence: { ...health.evidence, secret: 'value', counters: { ...health.evidence.counters, rawQuery: 'secret' } } }), health);
  assert.equal(inspectAdmissionHealth({ ...health, digest: 'raw-secret' }), null);
  for (const bad of ['18446744073709551616', '999999999999999999999', 'query-secret', -1, 12]) assert.equal(inspectAdmissionHealth({ ...health, evidence: { ...health.evidence, counters: { ...health.evidence.counters, denied: bad } } }).evidence, undefined);
});

test('200,000 denials keep exact totals, one log sample, bounded live heap, and failure/recovery visibility', t => {
  const code = `import assert from 'node:assert/strict'; import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { openAdmissionPolicy } from ${JSON.stringify(new URL('../dist/admission-policy.js', import.meta.url).href)};
import { routeHttpAdmission } from ${JSON.stringify(new URL('../dist/http-runtime.js', import.meta.url).href)};
import { createRuntimeLogSink } from ${JSON.stringify(new URL('../dist/server-runtime-source.js', import.meta.url).href)};
const root = await mkdtemp(${JSON.stringify(path.join(repo, '.agent-tmp-evidence-load-'))});
const policy = ${JSON.stringify(policy([deny()]))}; await writeFile(root+'/policy.json',policy);
let database; const events = []; const runtime = await openAdmissionPolicy(root,'policy.json',(health,event)=>{events.push(event);database?.log.emit({category:'platform',event:'admission.policy.'+event,level:'info',message:'Admission reload',data:health});},{now:()=>0});
database = {admissionPolicy:runtime,securitySession:'container',insertLogIndexEvent(){},pruneLogIndex(){}};
database.log = createRuntimeLogSink({database,config:{name:'evidence-high-load'},serverEnv:{},dataDir:root});
const readLogs = async () => (await readFile(database.log.path,'utf8')).trim().split('\\n').map(line=>JSON.parse(line));
const response = {writeHead:status=>assert.equal(status,403),end:body=>assert.equal(body,'Forbidden\\n')};
const run = (start,end) => { for(let i=start;i<end;i++) routeHttpAdmission(database,{method:'POST',url:'/blocked?private='+i,rawHeaders:['x-private',String(i)],headers:{}},response); };
try { run(0,10000); global.gc(); const before = process.memoryUsage().heapUsed; run(10000,200000); global.gc();
const growth = process.memoryUsage().heapUsed-before; assert.ok(growth<2*1024*1024, 'retained heap growth '+growth);
assert.equal(runtime.health().evidence.counters.denied,'200000'); assert.equal(runtime.health().evidence.counters.evaluated,'200000'); const logs = await readLogs(); assert.equal(logs.length,1); assert.equal(logs[0].event,'admission.decision'); assert.ok(JSON.stringify(logs).length<1024);
assert.equal(runtime.health().evidence.sampling.retainedKeys,1);
await writeFile(root+'/policy.json','invalid');await runtime.reload();await writeFile(root+'/policy.json',policy);await runtime.reload();
assert.deepEqual(events,['loaded','failure','recovery']); assert.deepEqual((await readLogs()).map(log=>log.event),['admission.decision','admission.policy.failure','admission.policy.recovery']); console.log(JSON.stringify({growth,logs:logs.length,counters:runtime.health().evidence.counters}));
}finally{await runtime.close();await rm(root,{recursive:true,force:true});}`;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', code], { cwd: repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, SPORADES_CONFIG_DIR: path.join(repo, '.agent-tmp/config') } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  t.diagnostic(result.stdout.trim());
});

test('local doctor uses authenticated evidence, redacts runtime extras, warns on degradation, and leaves no-policy checks unchanged', async () => temporary(async root => {
  const health = { state: 'degraded', digest: 'b'.repeat(64), evidence: createAdmissionEvidence().snapshot(), rawAddress: '192.0.2.1', rawQuery: 'private-query' };
  const server = createServer((req, res) => { assert.equal(req.headers['x-sporades-host-probe'], probe); res.end(JSON.stringify({ data: { runtime: { admissionPolicy: health } } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(root, '.sporades')); await writeFile(path.join(root, '.sporades/dev-session.json'), JSON.stringify({ port: server.address().port, inspectionToken: probe }));
    const config = { name: 'evidence', admissionPolicy: { path: 'policy.json' } }; await writeFile(path.join(root, 'sporades.json'), JSON.stringify(config));
    const checks = await runDoctorChecks({ projectDir: root, session: 'dev' });
    const check = checks.find(check => check.id === 'doctor.dev.admission-policy'); assert.equal(check.status, 'warn'); assert.deepEqual(check.details, inspectAdmissionHealth(health));
    const text = renderDoctorHumanOutput({ checks }); assert.ok(text.includes(health.digest)); assert.ok(text.includes('"denied":"0"'));
    const result = await runNode([path.join(repo, 'bin/sporades.js'), 'doctor', '--session', 'dev', '--json'], root);
    assert.deepEqual(JSON.parse(result.stdout).data.checks.find(c => c.id === check.id), check);
    for (const secret of ['192.0.2.1', 'private-query', probe]) assert.equal((JSON.stringify(checks) + text + result.stdout).includes(secret), false);
    health.state = 'healthy'; delete health.evidence;
    const legacy = (await runDoctorChecks({ projectDir: root, session: 'dev' })).find(c => c.id === check.id);
    assert.equal(legacy.status, 'warn'); assert.match(legacy.message, /v1 counters are unavailable/);
    delete config.admissionPolicy; await writeFile(path.join(root, 'sporades.json'), JSON.stringify(config));
    assert.equal((await runDoctorChecks({ projectDir: root, session: 'dev' })).some(check => check.id.endsWith('admission-policy')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

async function runNode(args, cwd, env = {}, input) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, SPORADES_CONFIG_DIR: path.join(cwd, 'config'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.stdin.end(input);
  const code = await new Promise(resolve => child.on('close', resolve)); return { code, stdout, stderr };
}

test('generated Host helper stats and Container doctor expose only the allowlisted evidence from local fake Docker', async () => temporary(async root => {
  const health = { state: 'healthy', digest: 'b'.repeat(64), rateLimit: { buckets: 1, maxBuckets: 10000, evictions: 3 }, evidence: createAdmissionEvidence().snapshot(), headers: 'private-header', address: '192.0.2.1' };
  const fakeBin = path.join(root, 'fake-bin'); await mkdir(fakeBin);
  const docker = path.join(fakeBin, 'docker');
  await writeFile(docker, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='info'||args[0]==='version')console.log('fake');
else if(args[0]==='exec')console.log(JSON.stringify({admissionPolicy:${JSON.stringify(health)}}));
else if(args[0]==='stats')console.log(JSON.stringify({CPUPerc:'1%',PIDs:'1'}));
else if(args[0]==='inspect')console.log(args.some(a=>a.includes('.State.Running'))?'true':JSON.stringify({State:{Running:true,Status:'running'},Config:{Labels:{}},HostConfig:{},NetworkSettings:{Ports:{}},Mounts:[]}));
else process.exit(1);
`); await chmod(docker, 0o755);
  const env = { PATH: `${fakeBin}:${process.env.PATH}` };
  const remoteRoot = path.join(root, 'host'); const registry = path.join(remoteRoot, 'hosts/capsules.example.dev/registry/capsules'); await mkdir(registry, { recursive: true });
  const record = { subname: 'example', domain: 'capsules.example.dev', remoteCapsuleId: 'capsules.example.dev/example', hostedUrl: 'https://example.capsules.example.dev', status: 'running', currentRelease: { id: '20260101T000000Z-abcdef12', source: { deployFiles: [{ path: 'policy.json', update: 'admission' }] } } };
  await writeFile(path.join(registry, 'example.json'), JSON.stringify(record));
  const result = await runNode([path.join(repo, 'bin/sporades-host-helper.js')], root, env, JSON.stringify({ action: 'capsule.stats', host: { alias: 'local', domain: record.domain, scheme: 'https', remoteRoot }, capsule: { subname: 'example' }, stats: { hostedUrl: record.hostedUrl, remoteCapsuleId: record.remoteCapsuleId, container: { name: 'sporades-capsules-example-dev-example' } } }));
  assert.equal(result.code, 0, result.stdout + result.stderr); assert.deepEqual(JSON.parse(result.stdout).data.admissionPolicy, inspectAdmissionHealth(health));
  await mkdir(path.join(root, '.sporades')); await writeFile(path.join(root, '.sporades/binding.json'), JSON.stringify({ containerId: 'fixture' }));
  await writeFile(path.join(root, 'sporades.json'), JSON.stringify({ name: 'example', admissionPolicy: { path: 'policy.json' } }));
  const doctor = await runNode([path.join(repo, 'bin/sporades.js'), 'doctor', '--session', 'container', '--json'], root, env);
  const check = JSON.parse(doctor.stdout).data.checks.find(c => c.id === 'doctor.container.admission-policy'); assert.equal(check.status, 'pass'); assert.deepEqual(check.details, inspectAdmissionHealth(health));
  for(const secret of ['private-header','192.0.2.1',probe])assert.equal((result.stdout + doctor.stdout).includes(secret),false);
  // Inspect the running release even when local project configuration has changed.
  await writeFile(path.join(root, 'sporades.json'), JSON.stringify({ name: 'example' }));
  await writeFile(path.join(root, '.sporades/binding.json'), JSON.stringify({ containerId: 'fixture', deployFiles: [{ path: 'policy.json', update: 'admission' }] }));
  const retained = await runNode([path.join(repo, 'bin/sporades.js'), 'doctor', '--session', 'container', '--json'], root, env);
  assert.deepEqual(JSON.parse(retained.stdout).data.checks.find(c => c.id === check.id).details, check.details);
}));
