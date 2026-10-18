import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);
const cli = path.resolve('bin/sporades.js');

test('installed CLI routes canonical registration and existing-registration commands through the Host helper', async () => {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/origin-cli-'));
  const configDir = path.join(root, 'config');
  const fakeBin = path.join(root, 'bin');
  try {
    await mkdir(configDir); await mkdir(fakeBin);
    await writeFile(path.join(root, 'sporades.json'), JSON.stringify({ name: 'origin-cli' }));
    await writeFile(path.join(fakeBin, 'ssh'), `#!/usr/bin/env node
let text='';for await(const chunk of process.stdin)text+=chunk;
const r=JSON.parse(text);
process.stdout.write(JSON.stringify({ok:true,data:r.action==='capsule.register'?{capsule:{...r.registration,publicOrigin:'https://'+r.registration.canonicalDomain},request:r}:{publicOrigin:r.canonical.domain?'https://'+r.canonical.domain:'https://notes.capsules.example',canonicalDomain:r.canonical.domain,request:r},error:null})+'\\n');`, { mode: 0o755 });
    const env = { ...process.env, SPORADES_CONFIG_DIR: configDir, PATH: fakeBin + path.delimiter + process.env.PATH };
    const invoke = async args => JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { cwd: root, env, timeout: 15000 })).stdout);
    await invoke(['host', 'add', 'test', '--server', 'root@example.invalid', '--domain', 'capsules.example']);
    const registered = await invoke(['host', 'register', 'notes', '--host', 'test', '--canonical-domain', 'canonical.example']);
    assert.equal(registered.data.request.registration.canonicalDomain, 'canonical.example');
    assert.deepEqual(registered.data.request.registration.aliasDomains, ['canonical.example']);
    assert.equal(registered.data.binding.hostedUrl, 'https://notes.capsules.example');
    const bindingBefore = await readFile(path.join(root, '.sporades/remote-binding.json'), 'utf8');
    const changed = await invoke(['host', 'canonical', 'set', 'notes', 'other.example', '--host', 'test']);
    assert.equal(changed.data.request.action, 'capsule.canonical.set');
    assert.deepEqual(changed.data.request.canonical, { domain: 'other.example' });
    const cleared = await invoke(['host', 'canonical', 'clear', 'notes', '--host', 'test']);
    assert.deepEqual(cleared.data.request.canonical, { domain: null });
    assert.equal(await readFile(path.join(root, '.sporades/remote-binding.json'), 'utf8'), bindingBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Dev resolves --port 0 before init hooks and preserves the origin through rebuild and doctor', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.resolve('.scratch/origin-dev-'));
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_PUBLIC_ORIGIN: 'https://ignored.example' };
  let child;
  try {
    await run(process.execPath, [cli, 'create', 'origin-dev', '--template', 'blank', '--no-install', '--no-git', '--json'], { cwd: root, env });
    const project = path.join(root, 'origin-dev');
    const configPath = path.join(project, 'sporades.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.dev.port = 5688;
    config.deploy.publicOrigin = 'https://container.example';
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(project, 'client/index.tsx'), 'document.body.dataset.ready="true";');
    const serverFile = path.join(project, 'server/index.ts');
    await writeFile(serverFile, `import {capsule,endpoint} from 'sporades/server';let initOrigin;export default capsule({name:'origin-dev',hooks:{init(ctx){initOrigin=ctx.app.publicOrigin;}},endpoints:{origin:endpoint({method:'GET',path:'/origin'},ctx=>({status:200,body:{origin:ctx.app.publicOrigin,initOrigin}}))}});`);
    let output = '', errors = '';
    child = spawn(process.execPath, [cli, 'dev', '--port', '0', '--json'], { cwd: project, env });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const until = async predicate => {
      const deadline = Date.now() + 30000;
      while (!predicate() && Date.now() < deadline && child.exitCode === null) await pause(50);
      assert(predicate(), output + errors);
    };
    await until(() => output.includes('"event":"started"'));
    const started = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(line => line?.data?.event === 'started');
    const origin = started.data.url;
    assert.notEqual(new URL(origin).port, '0');
    assert.deepEqual(await (await fetch(`${origin}/origin`)).json(), { origin, initOrigin: origin });
    output = '';
    await writeFile(serverFile, (await readFile(serverFile, 'utf8')) + '\n// rebuild origin\n');
    await until(() => output.includes('"event":"rebuild"') && output.includes('"status":"success"'));
    assert.deepEqual(await (await fetch(`${origin}/origin`)).json(), { origin, initOrigin: origin });
    const doctor = JSON.parse((await run(process.execPath, [cli, 'doctor', '--session', 'dev', '--json'], { cwd: project, env })).stdout);
    assert.equal(doctor.data.checks.find(c => c.id === 'doctor.public-origin').details.publicOrigin, origin);
  } finally {
    if (child) {
      child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
