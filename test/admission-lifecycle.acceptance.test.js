import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, writeFile, readFile, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { ADMISSION_LIMITS, publishAdmissionPolicy, parseAdmissionPolicy } from '../dist/admission-policy.js';
import { preservedDeployFilePath } from '../dist/deploy-files.js';
import { baseImageMetadata, baseImageRuntimeUser } from '../dist/base-image.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

// Native mode validates the scenario driver and generated runtime. It deliberately
// makes no claim about deployed mounts, Docker hardening or the Caddy boundary.
const native = process.env.SPORADES_ADMISSION_DRIVER_CHECK === '1';
const enabled = native || process.env.SPORADES_REAL_ADMISSION_LIFECYCLE === '1';
const exec = promisify(execFile);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const probe = 'c'.repeat(64); // disposable synthetic Host capability, never a profile credential
const image = process.env.SPORADES_ADMISSION_PROOF_BASE_IMAGE || baseImageMetadata().image;
const token = clientAddressBoundaryToken(probe);
const bytes = rules => Buffer.from(JSON.stringify({ version: 1, rules }));
const deny = (id, target) => ({ id, enabled: true, conditions: [{ kind: 'pathname', exact: target }], action: { kind: 'deny' } });
const quota = (id, target, limit = 1) => ({ ...deny(id, target), action: { kind: 'rate-limit', limit, windowMs: 60000 } });
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function localDockerOnly() {
  const configured = process.env.DOCKER_HOST;
  assert.ok(!configured || configured.startsWith('unix://'), 'Lifecycle proof permits only a local Unix Docker socket');
  const { stdout } = await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {timeout:5000});
  assert.ok(stdout.trim().startsWith('unix://'), 'Lifecycle proof refuses remote Docker contexts');
  await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {timeout:12000});
}

async function until(predicate, label, timeout = 9500) {
  const deadline = performance.now() + timeout;
  do { if (await predicate()) return; await sleep(50); } while (performance.now() < deadline);
  assert.fail(label);
}

async function helper(input, config) {
  const child = spawn(process.execPath, [path.join(repo, 'bin/sporades-host-helper.js')], {
    cwd: repo, env: { ...process.env, SPORADES_CONFIG_DIR: config }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const result = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdin.end(JSON.stringify(input) + '\n');
  try {
    const [code] = await result;
    assert.equal(code, 0, stderr);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    return envelope.data;
  } finally { clearTimeout(timer); }
}

const app = `import {capsule, endpoint, query} from 'sporades/server';
const fs = globalThis.process.getBuiltinModule('node:fs');
const dir = globalThis.process.env.PROOF_DATA_DIR;
const called = name => fs.appendFileSync(dir + '/calls', name + '\\n');
export default capsule({ name:'lifecycle-proof', schema:{},
  queries:{ ping:query(() => { called('query'); return 'Capsule reply'; }) },
  endpoints:{
    blocked:endpoint({path:'/blocked',method:'GET'}, () => { called('blocked'); return {status:200,body:'original bytes\\n'}; }),
    limited:endpoint({path:'/limited',method:'GET'}, () => { called('limited'); return {status:200,body:'original bytes\\n'}; }),
    identity:endpoint({path:'/identity',method:'GET'}, () => { called('identity'); return {status:200,body:'original bytes\\n'}; }),
    echo:endpoint({path:'/echo',method:'POST'}, ctx => { called('echo'); return {status:201,headers:{'x-proof-app':'original'},body:ctx.request.body}; }),
    resources:endpoint({path:'/resources',method:'GET'}, () => ({body:globalThis.process.memoryUsage()})),
    tamper:endpoint({path:'/tamper',method:'GET'}, () => {
      called('tamper'); const file=globalThis.process.env.PROOF_POLICY_FILE;
      return {body:['write','truncate','rename','unlink','replace'].map(op => {
        try {
          if(op==='write') fs.writeFileSync(file,'{}');
          if(op==='truncate') fs.truncateSync(file,0);
          if(op==='rename') fs.renameSync(file,file+'.moved');
          if(op==='unlink') fs.unlinkSync(file);
          if(op==='replace') fs.renameSync(dir+'/replacement',file);
          return {op,code:'MUTATED'};
        } catch(error) { return {op,code:error.code}; }
      })};
    })
  }
});`;

async function fixture(root, session, declared = true) {
  const domain = `proof-${randomBytes(5).toString('hex')}.invalid`;
  const hostRoot = path.join(root, 'host');
  const capsule = path.join(hostRoot, 'hosts', domain, 'capsules', 'proof');
  const storage = session === 'hosted' ? path.join(capsule, 'preserved-files/admission') : path.join(root, 'policy');
  const target = preservedDeployFilePath(storage, 'policy.json');
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  const publicDir = path.join(native ? storage : root, 'public');
  await Promise.all([storage, data, config, publicDir].map(dir => mkdir(dir, { recursive: true })));
  await chmod(data, 0o777);
  await writeFile(path.join(data, 'replacement'), '{}', { mode: 0o666 });
  await writeFile(path.join(publicDir, 'asset.txt'), 'static original bytes\n');
  // Endpoint/static collision proves the shipped endpoint-before-public ordering.
  await writeFile(path.join(publicDir, 'blocked'), 'wrong static route');
  if (declared) await publishAdmissionPolicy(storage, 'policy.json', null);
  const registry = path.join(hostRoot, 'hosts', domain, 'registry/capsules/proof.json');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, JSON.stringify({ subname: 'proof', domain, remoteCapsuleId: `${domain}/proof`,
    hostedUrl: `http://proof.${domain}`, status: 'started', currentRelease: { id: '20261004T120000Z-feedface' },
    releases: [{ id: '20261004T120000Z-feedface', state: 'verified', current: true,
      source: { deployFiles: [{ path: 'policy.json', update: 'admission' }] } }],
  }));
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource: app, serverSourcePath: path.join(root, 'server/index.ts') });
  const source = await createServerBundleModuleSource({
    config: { name: 'lifecycle-proof', ...(declared ? { admissionPolicy: { path: native ? path.basename(target) : 'policy.json' } } : {}) },
    serverEnv: {}, serverSource: app, serverModuleSource,
    epilogue: `${native ? `database.securitySession=${JSON.stringify(session)}; database.runtimeProbeToken=${JSON.stringify(probe)};` : ''}
      const untouched = new Proxy({}, {get(){throw new Error('no-policy gate touched a surface');}});
      const samples=[]; for(let batch=0;batch<8;batch++) { const start=performance.now();
        for(let i=0;i<200000;i++) { if(routeHttpAdmission({},untouched,untouched)) throw new Error('unexpected admission'); }
        if(batch) samples.push((performance.now()-start)*1000/200000); }
      samples.sort((a,b)=>a-b);
      process.stdout.write(JSON.stringify({proofListening:server.address().port,gateMedianUs:samples[3],runtimeNode:process.versions.node})+'\\n');`,
  });
  const serverFile = path.join(root, 'server.mjs'); await writeFile(serverFile, source);
  const name = `sporades-lifecycle-${session}-${randomBytes(6).toString('hex')}`;
  let child, output = '', errors = '', base, cleaned = false, launchArgs;
  const command = async args => (await exec('docker', args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const env = { PORT: native ? '0' : '5688', PROOF_DATA_DIR: native ? data : '/app/data',
    PROOF_POLICY_FILE: native ? target : '/run/sporades-admission/' + path.basename(target),
    SPORADES_RUNTIME_PROBE_TOKEN: probe, SPORADES_CONFIG_DIR: config, SPORADES_LOG_STDOUT: '1',
    SPORADES_SECURITY_SESSION: native ? 'dev' : session,
    SPORADES_ADMISSION_POLICY_PATH: declared ? (native ? path.basename(target) : 'policy.json') : '',
  };
  async function start() {
    if (native) {
      child = spawn(process.execPath, [serverFile], { cwd: storage, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
      await until(async () => {
        const ready = output.split('\n').flatMap(line => { try { const v = JSON.parse(line); return v.proofListening ? [v] : []; } catch { return []; } }).at(-1);
        if (child.exitCode !== null) assert.fail(output + errors);
        if (ready) { base = `http://127.0.0.1:${ready.proofListening}`; return true; }
        return false;
      }, 'generated driver runtime did not listen');
    } else {
      launchArgs = ['run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', baseImageRuntimeUser(), '--memory', '256m', '--pids-limit', '100', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec',
        '-p', '127.0.0.1::5688', '-v', `${serverFile}:/app/server.mjs:ro`, '-v', `${publicDir}:/app/public:ro`,
        '-v', `${data}:/app/data:rw`, '-v', `${storage}:/run/sporades-admission:ro`, '-w', '/app',
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image];
      await command(launchArgs);
      base = 'http://' + (await command(['port', name, '5688/tcp'])).trim();
    }
  }
  async function logs() {
    if (native) return output + errors;
    const value = await exec('docker', ['logs', name], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return value.stdout + value.stderr;
  }
  const health = async () => {
    const response = await fetch(base + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': probe }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); return (await response.json()).data.runtime;
  };
  const publish = async value => {
    if (session === 'hosted' && !native) return helper({ action: 'capsule.admission.publish',
      host: { alias: 'local-proof', domain, scheme: 'http', remoteRoot: hostRoot }, capsule: { subname: 'proof' },
      admission: { contents: value === null ? null : value.toString('base64') },
    }, config);
    await publishAdmissionPolicy(storage, 'policy.json', value);
  };
  const activate = async value => {
    const started = performance.now(); await publish(value);
    const digest = value === null ? null : parseAdmissionPolicy(value).digest;
    await until(async () => { const h = (await health()).admissionPolicy; return h.digest === digest && h.state === (value === null ? 'disabled' : 'healthy'); }, 'policy publication exceeded 10 seconds');
    const elapsedMs = performance.now() - started; assert.ok(elapsedMs < 10000); return elapsedMs;
  };
  const replace = async value => { const candidate = target + '.candidate'; await writeFile(candidate, value, { mode: 0o444 }); await rename(candidate, target); };
  const calls = async () => { try { return (await readFile(path.join(data, 'calls'), 'utf8')).trim().split('\n'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (native) { if (child?.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; } }
    else await command(['rm', '-f', name]);
  };
  try { await start(); await until(async () => { try { return !!await health(); } catch { return false; } }, 'runtime readiness'); }
  catch (error) { await cleanup().catch(() => {}); throw error; }
  return { base, health, activate, publish, replace, calls, logs, cleanup, target, storage, data, serverFile, name,
    identity: address => ({ 'x-sporades-client-address': address, 'x-sporades-client-address-token': token }),
    artifactDigest: hash(source), command, child,
    coldCleanup: () => command(['rm', '-f', name]),
    coldStart: () => command(launchArgs.filter(arg => arg !== '-d')),
  };
}

async function http(base, target, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(base + target, { method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout'))); req.end();
  });
}

async function upgrade(base, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + target, { headers: { connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode, headers: response.headers, body: '' }); });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('upgrade timeout'))); req.end();
  });
}

function opaque(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.body, status === 403 ? 'Forbidden\n' : 'Too Many Requests\n');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
  assert.equal(response.headers['sec-websocket-accept'], undefined);
  if (status === 429) assert.match(response.headers['retry-after'], /^[1-9][0-9]*$/);
  else assert.equal(response.headers['retry-after'], undefined);
}

async function queryReply(base) {
  const response = await fetch(base + '/__sporades/connection-token', { headers: { 'x-sporades-connection-token-request': '1' } });
  assert.equal(response.status, 200);
  const connectionToken = (await response.json()).token;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/__sporades/ws?connectionToken=' + connectionToken);
  const deadline = setTimeout(() => socket.close(), 5000);
  try {
    await once(socket, 'open'); const reply = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'proof', type: 'query.subscribe', query: 'ping', args: [] }));
    const value = JSON.parse((await reply)[0].data);
    assert.deepEqual({ id: value.id, error: value.error, data: value.data }, { id: 'proof', error: null, data: 'Capsule reply' });
    return value.data;
  } finally { clearTimeout(deadline); const closed = once(socket, 'close'); socket.close(); await closed; }
}

async function streamedEcho(base) {
  return new Promise((resolve, reject) => {
    const req = request(base + '/echo', { method: 'POST', headers: { 'content-type': 'text/plain' } }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, header: response.headers['x-proof-app'], body }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('stream timeout')));
    req.write('first streamed '); setTimeout(() => req.end('second chunk'), 20);
  });
}

for (const session of ['container', 'hosted']) test(`generated ${session} admission lifecycle boundary (${native ? 'native driver check; deployment proof pending' : 'Docker'})`, { skip: !enabled, timeout: 240000 }, async t => {
  if (!native) await localDockerOnly();
  await mkdir(path.join(repo, '.sporades/issue-73'), {recursive:true});
  const root = await mkdtemp(path.join(repo, '.sporades/issue-73/lifecycle-'));
  let runtime, baseline, coldCreated = false;
  const evidence = { session, mode: native ? 'native-driver-check' : 'local-docker', measurements: {}, pending: ['actual Host lifecycle/Caddy publication and socket-derived identity'] };
  evidence.status = 'incomplete';
  if (native) evidence.pending.push('Docker read-only mount, hardening, authorized Host helper publication and invalid deployed cold start');
  try {
    runtime = await fixture(path.join(root, 'runtime'), session);
    evidence.bundleDigest = runtime.artifactDigest;
    evidence.baseImage = image;
    if (!native) evidence.baseImageId = (await runtime.command(['inspect', '--format', '{{.Image}}', runtime.name])).trim();
    const before = native ? runtime.child.pid : (await runtime.command(['inspect', '--format', '{{.Id}}', runtime.name])).trim();
    assert.equal((await http(runtime.base, '/blocked')).body, 'original bytes\n');
    await rm(path.join(runtime.data, 'calls'), { force: true });
    const initial = bytes([deny('old-complete', '/blocked'), deny('ws-old-complete', '/__sporades/ws')]);
    evidence.measurements.addMs = await runtime.activate(initial);
    const countersBefore = (await runtime.health()).admissionPolicy.evidence.counters;
    opaque(await http(runtime.base, '/blocked?private=never-log-this'), 403);
    opaque(await upgrade(runtime.base, '/__sporades/ws?private=never-log-this'), 403);
    assert.deepEqual(await runtime.calls(), []);
    const countersAfter = (await runtime.health()).admissionPolicy.evidence.counters;
    assert.equal(BigInt(countersAfter.evaluated) - BigInt(countersBefore.evaluated), 2n);
    assert.equal(BigInt(countersAfter.denied) - BigInt(countersBefore.denied), 2n);

    // Every complete generation denies both transports. Any partial/empty policy
    // would admit HTTP or move the upgrade to transport authentication instead.
    let stopped = false, observed = 0;
    const traffic = (async () => { while (!stopped) {
      const responses = await Promise.all([http(runtime.base, '/blocked'), upgrade(runtime.base, '/__sporades/ws')]);
      for (const response of responses) opaque(response, 403); observed += responses.length;
      await sleep(5);
    } })();
    try {
      for (let generation = 0; generation < 3; generation++) {
        evidence.measurements[`change${generation}Ms`] = await runtime.activate(bytes([deny(`new-${generation}`, '/blocked'), deny(`ws-new-${generation}`, '/__sporades/ws')]));
      }
    } finally { stopped = true; await traffic; }
    evidence.measurements.concurrentDecisions = observed; assert.ok(observed > 10);
    assert.deepEqual(await runtime.calls(), []);
    const good = (await runtime.health()).admissionPolicy.digest;
    await runtime.replace('{');
    await until(async () => (await runtime.health()).admissionPolicy.state === 'degraded', 'truncated replacement did not degrade');
    assert.equal((await runtime.health()).admissionPolicy.digest, good);
    opaque(await http(runtime.base, '/blocked'), 403); opaque(await upgrade(runtime.base, '/__sporades/ws'), 403);
    evidence.measurements.recoveryMs = await runtime.activate(initial);
    assert.equal((await runtime.health()).admissionPolicy.evidence.counters.reloadRecoveries, '1');

    // Publication rejects bounded hostile candidates without replacing the file.
    const invalid = [Buffer.alloc(ADMISSION_LIMITS.bytes + 1, 32), Buffer.from('{'),
      bytes(Array.from({ length: ADMISSION_LIMITS.rules + 1 }, (_, i) => deny('overflow-' + i, '/blocked'))),
      bytes([{ ...deny('condition-overflow', '/blocked'), conditions: Array.from({ length: 17 }, () => ({ kind: 'method', value: 'GET' })) }]),
      bytes([{ ...deny('text-overflow', '/blocked'), conditions: [{ kind: 'header', name: 'x-test', value: 'a'.repeat(1025) }] }]),
      Buffer.from('{"version":1,"rules":[],"extra":' + '['.repeat(9) + '0' + ']'.repeat(9) + '}'), Buffer.from([0xff]),
    ];
    const stored = hash(await readFile(runtime.target));
    for (const value of invalid) { await assert.rejects(runtime.publish(value)); assert.equal(hash(await readFile(runtime.target)), stored); }
    await runtime.replace(Buffer.alloc(ADMISSION_LIMITS.bytes + 1, 32));
    await until(async () => (await runtime.health()).admissionPolicy.state === 'degraded', 'oversized hot file did not degrade');
    opaque(await http(runtime.base, '/blocked'), 403);
    await runtime.activate(initial);

    if (!native) {
      const response = await fetch(runtime.base + '/tamper');
      const attempts = await response.json(); assert.equal(attempts.length, 5);
      for (const attempt of attempts) assert.ok(['EROFS', 'EACCES', 'EXDEV', 'EPERM'].includes(attempt.code), JSON.stringify(attempt));
      assert.equal(hash(await readFile(runtime.target)), stored);
      opaque(await http(runtime.base, '/blocked'), 403);
      evidence.measurements.runtimeTamper = attempts;
    }

    await runtime.activate(bytes([{ ...deny('identity-boundary', '/identity'), conditions: [{kind:'pathname',exact:'/identity'}, {kind:'address',value:'192.0.2.0/24'}] }, quota('quota', '/limited'), quota('ws-quota', '/__sporades/ws')]));
    const forge = { 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1',
      'x-sporades-client-address': '198.51.100.1', 'x-sporades-client-address-token': 'd'.repeat(64) };
    opaque(await http(runtime.base, '/identity', forge), 403);
    opaque(await http(runtime.base, '/identity', runtime.identity('192.0.2.7')), 403);
    const trusted = runtime.identity('198.51.100.7');
    if (session === 'hosted') {
      assert.equal((await http(runtime.base, '/identity', trusted)).status, 200);
      assert.equal((await http(runtime.base, '/limited', trusted)).status, 200);
      opaque(await http(runtime.base, '/limited', trusted), 429);
      // Shared HTTP/upgrade bucket: unsupported HTTP WS route still consumes one.
      assert.equal((await http(runtime.base, '/__sporades/ws', trusted)).status, 404);
      opaque(await upgrade(runtime.base, '/__sporades/ws', trusted), 429);
      await runtime.activate(bytes([{...quota('quota','/limited'),action:{kind:'rate-limit',limit:1,windowMs:1000}}]));
      assert.equal((await http(runtime.base, '/limited', trusted)).status, 200);
      const exhausted = await http(runtime.base, '/limited', trusted); opaque(exhausted, 429);
      assert.equal(exhausted.headers['retry-after'], '1');
      await sleep(1100);
      assert.equal((await http(runtime.base, '/limited', trusted)).status, 200);
    } else {
      opaque(await http(runtime.base, '/identity', trusted), 403);
      opaque(await http(runtime.base, '/limited', trusted), 403);
      opaque(await upgrade(runtime.base, '/__sporades/ws', trusted), 403);
    }

    await runtime.activate(bytes([deny('hostile-rate', '/blocked')]));
    const startHealth = (await runtime.health()).admissionPolicy;
    const memoryStart = await (await fetch(runtime.base + '/resources')).json();
    const startCounters = (await runtime.health()).admissionPolicy.evidence.counters;
    const loadStarted = performance.now();
    for (let batch = 0; batch < 32; batch++) {
      const responses = await Promise.all(Array.from({ length: 64 }, (_, i) => http(runtime.base,
        i % 2 ? '/blocked?credential=never-log-this' : '/%FF?credential=never-log-this', { 'x-private': 'never-log-this' })));
      for (const response of responses) opaque(response, 403);
    }
    const endHealth = (await runtime.health()).admissionPolicy;
    const memoryEnd = await (await fetch(runtime.base + '/resources')).json();
    assert.equal(BigInt(endHealth.evidence.counters.evaluated) - BigInt(startCounters.evaluated), 2048n);
    assert.equal(BigInt(endHealth.evidence.counters.denied) - BigInt(startCounters.denied), 2048n);
    assert.ok(Number(endHealth.evidence.counters.decisionsEmitted) - Number(startCounters.decisionsEmitted) <= 20);
    assert.ok(endHealth.evidence.sampling.retainedKeys <= 20);
    assert.ok(memoryEnd.rss - memoryStart.rss < 64 * 1024 * 1024, 'load retained over 64 MiB RSS growth');
    evidence.measurements.hostileLoad = { requests: 2048, elapsedMs: performance.now() - loadStarted,
      rssBefore: memoryStart.rss, rssAfter: memoryEnd.rss, counters: endHealth.evidence.counters, activeDigest: startHealth.digest };

    if (session === 'hosted') {
      await runtime.activate(bytes([{...quota('bucket-bound', '/limited'),action:{kind:'rate-limit',limit:1,windowMs:86400000}}]));
      const start = (await runtime.health()).admissionPolicy;
      for (let batch = 0; batch < 158; batch++) {
        const responses = await Promise.all(Array.from({ length: 64 }, (_, i) => {
          const n = batch * 64 + i; return http(runtime.base, '/limited', runtime.identity(`198.18.${Math.floor(n / 256)}.${n % 256}`));
        }));
        for (const response of responses) assert.equal(response.status, 200);
      }
      const end = (await runtime.health()).admissionPolicy;
      assert.equal(end.rateLimit.buckets, 10000); assert.equal(end.rateLimit.evictions - start.rateLimit.evictions, 112);
      assert.equal(BigInt(end.evidence.counters.limiterEvictions) - BigInt(start.evidence.counters.limiterEvictions), 112n);
      assert.equal(BigInt(end.evidence.counters.admitted) - BigInt(start.evidence.counters.admitted), 10112n);
      evidence.measurements.bucketBound = end.rateLimit;
    }

    evidence.measurements.removeMs = await runtime.activate(null);
    const removedCounters = (await runtime.health()).admissionPolicy.evidence.counters;
    baseline = await fixture(path.join(root, 'no-policy'), session, false);
    assert.equal(Object.hasOwn(await baseline.health(), 'admissionPolicy'), false);
    for (const target of ['/blocked', '/asset.txt', '/missing']) {
      const old = await http(baseline.base, target), current = await http(runtime.base, target);
      assert.deepEqual({status:current.status,body:current.body,type:current.headers['content-type']}, {status:old.status,body:old.body,type:old.headers['content-type']});
    }
    assert.deepEqual(await streamedEcho(runtime.base), await streamedEcho(baseline.base));
    assert.equal(await queryReply(runtime.base), await queryReply(baseline.base));
    assert.deepEqual((await runtime.health()).admissionPolicy.evidence.counters, removedCounters, 'removed policy changed request counters');
    const allLogs = await runtime.logs(), baselineLogs = await baseline.logs();
    const events = allLogs.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.ok(events.some(event => event.event === 'admission.policy.failure'));
    assert.ok(events.some(event => event.event === 'admission.policy.recovery'));
    const finalCounters = (await runtime.health()).admissionPolicy.evidence.counters;
    assert.equal(events.filter(event => event.event === 'admission.decision').length, Number(finalCounters.decisionsEmitted));
    assert.equal(events.filter(event => event.event === 'admission.policy.failure').length, Number(finalCounters.reloadFailures));
    assert.equal(events.filter(event => event.event === 'admission.policy.recovery').length, Number(finalCounters.reloadRecoveries));
    const gateMedianUs = events.find(event => event.proofListening).gateMedianUs;
    evidence.runtimeNode = events.find(event => event.proofListening).runtimeNode;
    assert.ok(gateMedianUs < 1, `generated no-policy gate exceeds agreed 1us budget: ${gateMedianUs}`);
    assert.equal(baselineLogs.includes('admission.'), false);
    for (const secret of ['never-log-this', probe, token, '198.51.100.7', '198.18.', '192.0.2.']) assert.equal((allLogs + baselineLogs).includes(secret), false, secret);
    evidence.measurements.noPolicyGateMedianUs = gateMedianUs;
    evidence.measurements.logBytes = Buffer.byteLength(allLogs);
    assert.ok(evidence.measurements.logBytes < 128 * 1024, 'bounded scenario amplified logs beyond 128 KiB');
    assert.equal(hash(await readFile(runtime.serverFile)), runtime.artifactDigest);
    const after = native ? runtime.child.pid : (await runtime.command(['inspect', '--format', '{{.Id}}', runtime.name])).trim();
    assert.equal(after, before, 'hot policy operation replaced the application process/container');

    await runtime.activate(initial); await runtime.cleanup();
    await runtime.replace('{');
    if (!native) {
      coldCreated = true;
      await runtime.coldStart().then(() => assert.fail('invalid cold start succeeded'), error => assert.equal(error.code, 1));
      const coldLogs = await runtime.logs(); assert.match(coldLogs, /Configured admission policy could not be loaded/);
      assert.equal(coldLogs.includes('proofListening'), false);
      assert.equal(coldLogs.includes('runtime.started'), false);
    }
    evidence.status = native ? 'driver-check-passed' : 'runtime-boundary-passed';
    t.diagnostic(JSON.stringify(evidence));
  } finally {
    evidence.cleanup = [];
    for (const [name, operation] of [[baseline?.name, () => baseline?.cleanup()], [runtime?.name, () => runtime?.cleanup()],
      ...(coldCreated ? [[runtime.name, () => runtime.coldCleanup()]] : [])]) {
      if (!name) continue;
      try { await operation(); evidence.cleanup.push({name,removed:true}); }
      catch (error) { evidence.cleanup.push({name,removed:false,error:error.message}); }
    }
    const cleanupFailed = evidence.cleanup.some(item => !item.removed);
    if (cleanupFailed) { evidence.status = 'cleanup-failed'; evidence.retainedFixture = root; }
    await mkdir(path.join(repo, '.sporades/issue-73/evidence'), {recursive:true});
    await writeFile(path.join(repo, `.sporades/issue-73/evidence/lifecycle-${session}-${native ? 'driver' : 'docker'}.json`), JSON.stringify(evidence, null, 2) + '\n');
    if (!cleanupFailed) await rm(root, { recursive: true, force: true });
    assert.equal(cleanupFailed, false, 'Owned lifecycle resource cleanup failed; see retained evidence');
  }
});
