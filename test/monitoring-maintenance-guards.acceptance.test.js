import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const enabled = process.env.SPORADES_MAINTENANCE_DOCKER === '1';
async function fixture(t) {
  const root = process.cwd(), temp = await mkdtemp(path.join(root, '.sporades/maintenance-guards-'));
  const project = 'dennis213-' + randomBytes(6).toString('hex');
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(temp, 'config'), COMPOSE_PROJECT_NAME: project };
  const run = (cmd, args, extra = {}, cwd = root) => spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
  const cliArgs = args => [path.join(root, 'bin/sporades.js'), 'monitoring', 'stack', ...args, '--json'];
  const cli = (args, extra) => run(process.execPath, cliArgs(args), extra);
  const source = path.join(temp, 'source'), backup = path.join(temp, 'backup');
  assert.equal(cli(['init', '--dir', source]).status, 0);
  await writeFile(path.join(source, '.env'), (await readFile(path.join(source, '.env'), 'utf8')).replace('TRACE_TLS_MODE=tls', 'TRACE_TLS_MODE=proxy'));
  assert.equal(run(process.execPath, ['setup.mjs'], {}, source).status, 0);
  const volumes = ['traces', 'metrics', 'grafana', 'inventory'].map(key => project + '_' + key);
  t.after(async () => {
    for (const name of volumes) run('docker', ['volume', 'rm', name]);
    await rm(temp, { recursive: true, force: true });
  });
  for (const name of volumes) {
    assert.equal(run('docker', ['volume', 'create', name]).status, 0);
    assert.equal(run('docker', ['run', '--rm', '--network', 'none', '-v', name + ':/storage', 'busybox:1.37.0', 'sh', '-c', 'echo snapshot > /storage/sentinel']).status, 0);
  }
  assert.equal(cli(['backup', '--dir', source, '--backup', backup]).status, 0);
  for (const name of volumes) assert.equal(run('docker', ['volume', 'rm', name]).status, 0);
  const realDocker = run('which', ['docker']).stdout.trim();
  const wrapper = path.join(temp, 'bin'); await mkdir(wrapper);
  const target = path.join(temp, 'target'); await mkdir(target);
  return { root, temp, project, env, run, cli, cliArgs, source, backup, volumes, realDocker, wrapper, target };
}

test('restore refuses a foreign volume created after listing without modifying its bytes', { skip: !enabled, timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.wrapper, 'docker'), `#!${process.execPath}
import cp from 'node:child_process';const a=process.argv.slice(2);
const r=cp.spawnSync(${JSON.stringify(f.realDocker)},a,{stdio:a[0]==='volume'&&a[1]==='ls'?['inherit','pipe','inherit']:'inherit',encoding:'utf8'});
if(a[0]==='volume'&&a[1]==='ls'){
process.stdout.write(r.stdout);
cp.execFileSync(${JSON.stringify(f.realDocker)},['volume','create','--label','operator=foreign',${JSON.stringify(f.volumes[0])}]);
cp.execFileSync(${JSON.stringify(f.realDocker)},['run','--rm','--network','none','-v',${JSON.stringify(f.volumes[0] + ':/storage')},'busybox:1.37.0','sh','-c','echo unrelated-operator > /storage/sentinel']);
}process.exit(r.status??1);
`, { mode: 0o755 });
  const result = f.cli(['restore', '--dir', f.target, '--backup', f.backup], { PATH: f.wrapper + path.delimiter + process.env.PATH });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(f.run('docker', ['run', '--rm', '--network', 'none', '-v', f.volumes[0] + ':/storage:ro', 'busybox:1.37.0', 'cat', '/storage/sentinel']).stdout, 'unrelated-operator\n');
  const meta = JSON.parse(f.run('docker', ['volume', 'inspect', f.volumes[0]]).stdout)[0];
  assert.equal(meta.Labels.operator, 'foreign');
  assert.equal(meta.Labels['com.sporades.restore'], undefined);
});

test('restores from different directories exclude shared volumes and release guards after SIGKILL', { skip: !enabled, timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const marker = path.join(f.temp, 'extracting');
  await writeFile(path.join(f.wrapper, 'docker'), `#!${process.execPath}
import fs from 'node:fs';import cp from 'node:child_process';const a=process.argv.slice(2);
if(a.includes('-xpf')){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)}
else {const r=cp.spawnSync(${JSON.stringify(f.realDocker)},a,{stdio:'inherit'});process.exit(r.status??1)}
`, { mode: 0o755 });
  const args = ['restore', '--dir', f.target, '--backup', f.backup];
  const child = spawn(process.execPath, f.cliArgs(args), { env: { ...f.env, PATH: f.wrapper + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  // Wrapper is independently killed below, so it cannot keep a child process alive.
  for (let i = 0; i < 200; i++) {
    try { await readFile(marker); break; } catch {}
    if (child.exitCode !== null) assert.fail('first restore exited before extraction');
    await new Promise(r => setTimeout(r, 50));
  }
  const wrapperPid = Number(await readFile(marker, 'utf8'));
  t.after(() => { try { process.kill(wrapperPid, 'SIGKILL'); } catch {} });
  const second = path.join(f.temp, 'second'); await mkdir(second);
  const result = f.cli(['restore', '--dir', second, '--backup', f.backup]);
  assert.equal(result.status, 1, 'different directories sharing backend names must not both extract');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  process.kill(wrapperPid, 'SIGKILL');
  // SIGKILL closes the owner's pipe; daemon guards remove themselves on EOF.
  let retry;
  for (let i = 0; i < 40; i++) {
    retry = f.cli(args);
    if (retry.status === 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  for (const name of f.volumes) assert.equal(f.run('docker', ['run', '--rm', '--network', 'none', '-v', name + ':/storage:ro', 'busybox:1.37.0', 'cat', '/storage/sentinel']).stdout, 'snapshot\n');
});

test('Linux UID 10001 creates private operator-owned backups preserving archived numeric metadata', { skip: !enabled, timeout: 240_000 }, async t => {
  const root = process.cwd(), temp = await mkdtemp(path.join(root, '.sporades/maintenance-linux-'));
  const prefix = 'dennis213-linux-' + randomBytes(6).toString('hex');
  const image = prefix + ':test', workspace = prefix + '-workspace', container = prefix + '-operator';
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(temp, 'config') };
  const run = args => spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000 });
  const must = args => { const r = run(args); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout.trim(); };
  const volumes = ['traces', 'metrics', 'grafana', 'inventory'].map(key => prefix + '_' + key);
  t.after(async () => {
    run(['rm', '--force', container]);
    for (const volume of [...volumes, workspace]) run(['volume', 'rm', volume]);
    run(['image', 'rm', image]);
    await rm(temp, { recursive: true, force: true });
  });
  // A Linux named-volume filesystem avoids Docker Desktop's host UID translation.
  await writeFile(path.join(temp, 'Dockerfile'), 'FROM node:24-alpine\nCOPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker\nCOPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose\n');
  must(['build', '--tag', image, temp]);
  must(['volume', 'create', workspace]);
  const hostPath = JSON.parse(must(['volume', 'inspect', workspace]))[0].Mountpoint;
  must(['run', '--detach', '--name', container, '--network', 'none', '--mount', `type=volume,src=${workspace},dst=${hostPath}`,
    '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', image, 'tail', '-f', '/dev/null']);
  must(['exec', container, 'sh', '-c', `mkdir -p ${hostPath}/package/bin ${hostPath}/package/monitoring ${hostPath}/operator && chown 10001:10001 ${hostPath}/operator && chmod 700 ${hostPath}/operator`]);
  must(['cp', path.join(root, 'bin/sporades.js'), container + ':' + hostPath + '/package/bin/sporades.js']);
  must(['cp', path.join(root, 'monitoring/trace'), container + ':' + hostPath + '/package/monitoring/trace']);
  must(['cp', path.join(root, 'package.json'), container + ':' + hostPath + '/package/package.json']);
  for (const volume of volumes) {
    must(['volume', 'create', volume]);
    must(['run', '--rm', '--network', 'none', '-v', volume + ':/storage', 'busybox:1.37.0', 'sh', '-c', 'echo preserved > /storage/numeric-owner; chown 23456:34567 /storage/numeric-owner; chmod 600 /storage/numeric-owner']);
  }
  const script = `import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';
const base=${JSON.stringify(hostPath)},project=${JSON.stringify(prefix)};
assert.equal(process.getuid(),10001);
const original=base+'/operator/original',backup=base+'/operator/backup';
const env={...process.env,SPORADES_CONFIG_DIR:base+'/operator/config',COMPOSE_PROJECT_NAME:project};
const run=(args,cwd=base)=>{const r=cp.spawnSync('node',args,{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);};
const cli=args=>run([base+'/package/bin/sporades.js','monitoring','stack',...args,'--json']);
cli(['init','--dir',original]);
fs.writeFileSync(original+'/.env',fs.readFileSync(original+'/.env','utf8').replace('TRACE_TLS_MODE=tls','TRACE_TLS_MODE=proxy'));
run(['setup.mjs'],original);
cli(['backup','--dir',original,'--backup',backup]);
assert.equal(fs.statSync(backup).uid,10001);assert.equal(fs.statSync(backup).mode&511,448);
for(const key of ['traces','metrics','grafana','inventory']){const st=fs.statSync(backup+'/'+key+'.tar');assert.equal(st.uid,10001);assert.equal(st.mode&511,384);fs.chmodSync(backup+'/'+key+'.tar',384);const r=cp.spawnSync('tar',['-tvf',backup+'/'+key+'.tar'],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/23456\\/34567.*numeric-owner/);}
console.log('Linux UID 10001 backup and numeric archive ownership passed');`;
  await writeFile(path.join(temp, 'linux-probe.mjs'), script);
  must(['cp', path.join(temp, 'linux-probe.mjs'), container + ':' + hostPath + '/linux-probe.mjs']);
  const socketGid = must(['exec', container, 'stat', '-c', '%g', '/var/run/docker.sock']);
  must(['exec', '--user', `10001:${socketGid}`, container, 'node', hostPath + '/linux-probe.mjs']);
});

test('real Compose malformed effective backend files prevent generated-file publication', { skip: !enabled, timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const manifestPath = path.join(f.source, 'stack-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath)); manifest.packageVersion = '0.9.29';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const before = await readFile(manifestPath), readme = await readFile(path.join(f.source, 'README.md'));
  await writeFile(path.join(f.source, 'operator-backend.yaml'), 'malformed-secret: [\n');
  for (const [service, destination] of [['prometheus', '/etc/prometheus/prometheus.yml'], ['jaeger', '/etc/jaeger/config.yaml']]) {
    await writeFile(path.join(f.source, 'compose.override.yaml'), `services:\n  ${service}:\n    volumes:\n      - ./operator-backend.yaml:${destination}:ro\n`);
    const result = f.cli(['upgrade', '--dir', f.source]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /malformed-secret/);
    assert.deepEqual(await readFile(manifestPath), before);
    assert.deepEqual(await readFile(path.join(f.source, 'README.md')), readme);
  }
});

test('restore rechecks ownership immediately before extraction', { skip: !enabled, timeout: 120_000 }, async t => {
  const f = await fixture(t), counter = path.join(f.temp, 'checks');
  await writeFile(path.join(f.wrapper, 'docker'), `#!${process.execPath}
import cp from 'node:child_process';import fs from 'node:fs';const a=process.argv.slice(2);
if(a[0]==='ps'&&a.includes('volume='+${JSON.stringify(f.volumes[0])})){
const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)})):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));
if(n===1){
cp.execFileSync(${JSON.stringify(f.realDocker)},['volume','rm',${JSON.stringify(f.volumes[0])}]);
cp.execFileSync(${JSON.stringify(f.realDocker)},['volume','create','--label','operator=foreign',${JSON.stringify(f.volumes[0])}]);
cp.execFileSync(${JSON.stringify(f.realDocker)},['run','--rm','--network','none','-v',${JSON.stringify(f.volumes[0] + ':/storage')},'busybox:1.37.0','sh','-c','echo before-extraction > /storage/sentinel']);
}}
const r=cp.spawnSync(${JSON.stringify(f.realDocker)},a,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  const result = f.cli(['restore', '--dir', f.target, '--backup', f.backup], { PATH: f.wrapper + path.delimiter + process.env.PATH });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(f.run('docker', ['run', '--rm', '--network', 'none', '-v', f.volumes[0] + ':/storage:ro', 'busybox:1.37.0', 'cat', '/storage/sentinel']).stdout, 'before-extraction\n');
});
