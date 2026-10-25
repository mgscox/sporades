import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/sporades.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => readFile(file).then(() => true, () => false);
async function until(read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await pause(20);
  }
  throw new Error('Timed out waiting for service lifecycle barrier');
}
function launch(args, cwd, env) {
  const child = spawn(process.execPath, [cli, ...args, '--json'], {cwd, env});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return {child, output: () => output, done: once(child, 'exit')};
}
async function stop(process) {
  if (!process || process.child.exitCode !== null) return;
  process.child.kill('SIGTERM');
  await Promise.race([process.done, pause(3000)]);
  if (process.child.exitCode === null && process.child.signalCode === null) {
    process.child.kill('SIGKILL');
    await process.done;
  }
}

async function overlap({phase, surface, action, deny = false}) {
  const dir = await mkdtemp(path.join(root, '.sporades-service-lifecycle-'));
  let dev, operation;
  const resume = path.join(dir, 'resume');
  try {
    const env = {...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'config')};
    const created = spawnSync(process.execPath, [cli, 'create', 'capsule', '--framework', 'vanilla', '--template', 'blank', '--no-install', '--no-git', '--json'], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const project = path.join(dir, 'capsule');
    const config = JSON.parse(await readFile(path.join(project, 'sporades.json'), 'utf8'));
    config.services = {worker: {kind: 'container', image: 'example:v1', command: ['run'], port: 8080, health: {http: '/health', await: false}, env: {KEY: {generated: 'key'}}}};
    await writeFile(path.join(project, 'sporades.json'), JSON.stringify(config));
    const server = version => `import {capsule, endpoint} from 'sporades/server';
export default capsule({name:'capsule',endpoints:{ready:endpoint({method:'GET',path:'/ready'},()=>({body:{version:${version}}}))}});`;
    await writeFile(path.join(project, 'server/index.ts'), server(1));
    const bin = path.join(dir, 'fake-bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
    await writeFile(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), base = process.env.LIFECYCLE_PROBE;
const file = name => path.join(base, name);
const record = value => fs.appendFileSync(file('events'), JSON.stringify(value) + '\\n');
if (args[0] === 'compose' && args.includes('config')) {
  let model;
  if (process.env.SPORADES_COMPOSE_TEST_BINARY) {
    const result = cp.spawnSync(process.env.SPORADES_COMPOSE_TEST_BINARY, args.slice(1), {encoding:'utf8', env:process.env});
    if (result.status !== 0) { process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1); }
    model = JSON.parse(result.stdout);
  } else {
    model = JSON.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8').replace(/\\$\\{(SPORADES_SVC_[A-Za-z0-9_]+):\\?\\}/g, (_m, key) => process.env[key] ?? ''));
  }
  if (fs.existsSync(file('pause-next'))) {
    fs.unlinkSync(file('pause-next'));
    fs.writeFileSync(file('paused'), '1');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file('resume')) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    if (!fs.existsSync(file('resume'))) process.exit(1);
    if (process.env.LIFECYCLE_DENY) model.name = 'foreign-project';
  }
  process.stdout.write(JSON.stringify(model));
} else if (args[0] === 'compose' && (args.includes('up') || args.includes('down'))) {
  const action = args.includes('up') ? 'up' : 'down';
  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.sporades/services/credentials.json'), 'utf8')); } catch {}
  record({action, credentialsPresent:!!credentials?.container?.worker?.key});
  if (action === 'up') fs.writeFileSync(file('running'), '1');
  else fs.rmSync(file('running'), {force:true});
} else if (args.includes('ps')) process.stdout.write(JSON.stringify({State:'running', Health:'healthy'}));
else if (args.includes('port')) process.stdout.write('127.0.0.1:5690');
`, {mode: 0o755});
    // Observe a real EEXIST contention result without changing lock semantics.
    // This avoids treating a sleep or an early child-process spawn as overlap.
    const hook = path.join(dir, 'lock-observer.cjs');
    await writeFile(hook, `const fs = require('node:fs'), promises = require('node:fs/promises');
const mkdir = promises.mkdir;
promises.mkdir = async function(target, ...args) {
  try { return await mkdir.call(this, target, ...args); }
  catch (error) {
    if (String(target).endsWith('/.container-lifecycle-lock') && error.code === 'EEXIST') fs.writeFileSync(process.env.LIFECYCLE_WAITING, '1');
    throw error;
  }
};
require('node:module').syncBuiltinESMExports();
`);
    Object.assign(env, {PATH: bin + path.delimiter + env.PATH, LIFECYCLE_PROBE: dir, LIFECYCLE_DENY: deny ? '1' : ''});
    if (phase === 'startup') await writeFile(path.join(dir, 'pause-next'), '1');
    dev = launch(['dev', '--port', '0'], project, env);
    if (phase === 'rebuild') {
      await until(() => dev.child.exitCode !== null || dev.output().includes('"event":"started"'));
      assert.equal(dev.child.exitCode, null, dev.output());
      await writeFile(path.join(dir, 'pause-next'), '1');
      await writeFile(path.join(project, 'server/index.ts'), server(2));
    }
    await until(async () => await exists(path.join(dir, 'paused')) || dev.child.exitCode !== null);
    assert.equal(dev.child.exitCode, null, dev.output());
    const compose = path.join(project, '.sporades/compose/capsule-services.compose.yml');
    const credentials = path.join(project, '.sporades/services/credentials.json');
    const beforeCompose = await readFile(compose, 'utf8');
    const beforeCredentials = await readFile(credentials, 'utf8');
    if (surface === 'deploy' && action === 'stop') {
      await writeFile(path.join(project, '.sporades/binding.json'), JSON.stringify({containerId:'lifecycle-fixture', containerName:'sporades-capsule'}));
    }
    const waiting = path.join(dir, 'waiting');
    operation = launch([surface, action], project, {...env, LIFECYCLE_WAITING: waiting, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(hook)}`});
    await until(async () => await exists(waiting) || operation.child.exitCode !== null);
    const contended = await exists(waiting);
    if (contended) {
      assert.equal(operation.child.exitCode, null, operation.output());
      assert.equal(await readFile(compose, 'utf8'), beforeCompose);
      assert.equal(await readFile(credentials, 'utf8'), beforeCredentials);
      const owner = JSON.parse(await readFile(path.join(project, '.sporades/.container-lifecycle-lock/owner.json'), 'utf8'));
      assert.equal(owner.pid, dev.child.pid);
    }
    await writeFile(resume, '1');
    const [code] = await operation.done;
    assert.equal(code, 0, operation.output());
    await until(() => dev.child.exitCode !== null || (phase === 'startup' ? dev.output().includes('"event":"started"') : dev.output().includes('"status":"success"') || dev.output().includes('"status":"failed"')));
    const events = (await readFile(path.join(dir, 'events'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(!events.some(event => event.action === 'up' && !event.credentialsPresent), JSON.stringify(events));
    assert.equal(events.at(-1).action, 'down', JSON.stringify(events));
    assert.equal(await exists(path.join(dir, 'running')), false);
    const finalCredentials = JSON.parse(await readFile(credentials, 'utf8'));
    if (action === 'reset') assert.equal(finalCredentials.container, undefined);
    else assert.deepEqual(finalCredentials.container, JSON.parse(beforeCredentials).container);
    assert(contended, `${surface} ${action} completed during paused ${phase}`);
    if (deny) {
      assert.equal(dev.child.exitCode, 1, dev.output());
      assert(!events.some(event => event.action === 'up'));
    } else assert.equal(dev.child.exitCode, null, dev.output());
    await assert.rejects(readFile(path.join(project, '.sporades/.container-lifecycle-lock/owner.json')), {code:'ENOENT'});
  } finally {
    await writeFile(resume, '1');
    await stop(operation);
    await stop(dev);
    await rm(dir, {recursive: true, force: true});
  }
}

for (const phase of ['startup', 'rebuild']) for (const surface of ['dev', 'deploy']) for (const action of ['stop', 'reset']) {
  test(`built Dev ${phase} serializes with ${surface} ${action} through credential finalization`, {timeout: 30000}, () => overlap({phase, surface, action}));
}
for (const surface of ['dev', 'deploy']) {
  test(`failed built Dev preflight releases its fence for waiting ${surface} reset`, {timeout: 30000}, () => overlap({phase:'startup', surface, action:'reset', deny:true}));
}
