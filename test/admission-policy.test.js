import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseAdmissionPolicy, resolveAdmissionPolicy, openAdmissionPolicy, publishAdmissionPolicy, admissionStorageRoot, buildAdmissionPolicy } from '../dist/admission-policy.js';
import { preparePreservedFiles, deployFileMounts, preservedDeployFilePath, resolveDeployFiles } from '../dist/deploy-files.js';
const policy = (id = 'block-path') => ({ version: 1, rules: [{ id, enabled: true, conditions: [{ kind: 'pathname', exact: '/blocked' }], action: { kind: 'deny' } }] });
async function temporary(fn) { const root = await mkdtemp(path.join(tmpdir(), 'admission-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('v1 policy preserves rule order and deeply freezes validated generations', () => {
  const generation = parseAdmissionPolicy(Buffer.from(JSON.stringify(policy())));
  assert.equal(generation.policy.rules[0].id, 'block-path');
  assert.match(generation.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => { generation.policy.rules[0].conditions[0].exact = '/changed'; }, TypeError);
  for (const value of [{...policy(), version: 2}, {...policy(), rules: [...policy().rules, ...policy().rules]}, {...policy(), extra: true}]) assert.throws(() => parseAdmissionPolicy(Buffer.from(JSON.stringify(value))), /Invalid admission policy/);
});
test('a retained policy uses an isolated read-only directory mount and survives redeploy', async () => temporary(async root => {
  const release = path.join(root, 'release'), preserved = path.join(root, 'preserved');
  await mkdir(release); await writeFile(path.join(release, 'policy.json'), JSON.stringify(policy()));
  const files = await buildAdmissionPolicy(release, {path: 'policy.json'});
  assert.deepEqual(resolveDeployFiles(files.map(({path, update}) => ({path, update})), true), [{path:'policy.json', update:'admission'}]);
  assert.throws(() => resolveDeployFiles([{path:'policy.json', update:'admission'}]), /Invalid deploy.files/);
  await preparePreservedFiles(files, release, preserved);
  assert.deepEqual(deployFileMounts(files, release, preserved), [{host: admissionStorageRoot(preserved), container:'/run/sporades-admission', mode:'ro'}]);
  const storage = admissionStorageRoot(preserved), relative = path.basename(preservedDeployFilePath(storage, 'policy.json'));
  const runtime = await openAdmissionPolicy(storage, relative);
  try {
    await publishAdmissionPolicy(storage, 'policy.json', Buffer.from(JSON.stringify(policy('new'))));
    await runtime.reload(); assert.equal(runtime.current().policy.rules[0].id, 'new');
    await preparePreservedFiles(files, release, preserved);
    await runtime.reload(); assert.equal(runtime.current().policy.rules[0].id, 'new');
  } finally { await runtime.close(); }
}));
test('hot failures retain a complete immutable generation; explicit removal and recovery are observable', async () => temporary(async root => {
  await writeFile(path.join(root, 'policy.json'), JSON.stringify(policy()));
  const events = []; const runtime = await openAdmissionPolicy(root, 'policy.json', health => events.push(health));
  const old = runtime.current();
  try {
    await writeFile(path.join(root, 'policy.json'), '{'); await Promise.all([runtime.reload(),runtime.reload()]);
    assert.equal(runtime.current(), old); assert.equal(runtime.health().state, 'degraded');
    await rm(path.join(root, 'policy.json')); await runtime.reload(); assert.equal(runtime.current(), old);
    await writeFile(path.join(root, 'next.json'), JSON.stringify(policy('new'))); await rename(path.join(root, 'next.json'),path.join(root, 'policy.json'));
    await runtime.reload(); assert.equal(runtime.health().state, 'healthy'); assert.equal(runtime.current().policy.rules[0].id,'new'); assert.equal(old.policy.rules[0].id,'block-path');
    assert.deepEqual(events.map(event => event.state), ['healthy','degraded','healthy']);
    assert.deepEqual(Object.keys(runtime.health()), ['state','digest']);
  } finally { await runtime.close(); }
  await assert.rejects(openAdmissionPolicy(root,'missing.json'), /could not be loaded/);
  await writeFile(path.join(root,'policy.json'),'{'); await assert.rejects(openAdmissionPolicy(root,'policy.json'), /could not be loaded/);
}));
test('authorized removal disables policy and survives restart; invalid publication cannot replace it', async () => temporary(async root => {
  const relative = 'policy.json', stored = path.basename(preservedDeployFilePath(root, relative));
  await writeFile(path.join(root,stored),JSON.stringify(policy()));
  const runtime = await openAdmissionPolicy(root,stored);
  try {
    await assert.rejects(publishAdmissionPolicy(root, relative, Buffer.from('{}')), /Invalid admission policy/);
    await publishAdmissionPolicy(root,relative,null); await runtime.reload();
    assert.equal(runtime.current(),null); assert.deepEqual(runtime.health(),{state:'disabled',digest:null});
    const restarted = await openAdmissionPolicy(root,stored); await restarted.close();
    await publishAdmissionPolicy(root,relative,Buffer.from(JSON.stringify(policy()))); await runtime.reload(); assert.equal(runtime.health().state,'healthy');
  } finally { await runtime.close(); }
}));
test('the shipped CLI publishes only the policy recorded in the Container binding', async () => temporary(async root => {
  const { spawnSync } = await import('node:child_process');
  const cli = path.resolve('bin/sporades.js');
  const preserved = path.join(root,'.sporades','preserved-files'); const storage = admissionStorageRoot(preserved);
  await mkdir(storage,{recursive:true});
  await writeFile(path.join(root,'.sporades','binding.json'),JSON.stringify({containerId:'fixture',deployFiles:[{path:'policy.json',update:'admission'}]}));
  await writeFile(path.join(storage,path.basename(preservedDeployFilePath(storage,'policy.json'))),JSON.stringify(policy()));
  await writeFile(path.join(root,'next.json'),JSON.stringify(policy('published')));
  const run = args => spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...process.env,SPORADES_CONFIG_DIR:path.resolve('.agent-tmp/config')}});
  const published = run(['deploy','policy','publish','next.json','--json']);
  assert.equal(published.status,0,published.stdout+published.stderr);
  const runtime = await openAdmissionPolicy(storage,path.basename(preservedDeployFilePath(storage,'policy.json')));
  try {
    assert.equal(runtime.current().policy.rules[0].id,'published');
    assert.equal(run(['deploy','policy','remove','--json']).status,0); await runtime.reload(); assert.equal(runtime.current(),null);
  } finally { await runtime.close(); }
}));
test('policy bounds, reserved controls, unsupported vocabulary and unsafe files are rejected', async () => temporary(async root => {
  const invalid = [];
  for (const condition of [{kind:'pathname',exact:'/__sporades/connection-token'}, {kind:'pathname',prefix:'/__sporades/health'}, {kind:'pathname',exact:'/%2e'}, {kind:'method',value:'get'}, {kind:'address',value:'10.0.0.1/33'}, {kind:'address',value:'::1/129'}, {kind:'header',name:'Authorization'}, {kind:'header',name:'x-sporades-client-address'}, {kind:'header',name:'forwarded'}, {kind:'cookie',name:'secret'}, {kind:'query-key',name:'a'.repeat(1025)}]) {
    const p = policy(); p.rules[0].conditions = [condition]; invalid.push(p);
  }
  for (const action of [{kind:'allow'}, {kind:'deny',body:'secret'}, {kind:'rate-limit',limit:0,windowMs:1000}, {kind:'rate-limit',limit:5,windowMs:999}]) { const p = policy(); p.rules[0].action = action; invalid.push(p); }
  const excessive = policy(); excessive.rules = Array.from({length:129},(_,i)=>({...policy().rules[0],id:`r${i}`})); invalid.push(excessive);
  const many = policy(); many.rules[0].conditions = Array.from({length:17},()=>({kind:'method',value:'GET'})); invalid.push(many);
  for (const p of invalid) assert.throws(()=>parseAdmissionPolicy(Buffer.from(JSON.stringify(p))), /Invalid admission policy/);
  assert.throws(()=>parseAdmissionPolicy(Buffer.alloc(65537,32)), /Invalid admission policy/);
  assert.throws(()=>parseAdmissionPolicy(Buffer.from('['.repeat(20)+'0'+']'.repeat(20))), /Invalid admission policy/);
  for (const target of ['../outside','/absolute','.sporades/secret','public/policy.json']) assert.throws(()=>resolveAdmissionPolicy({path:target}));
  assert.throws(()=>resolveAdmissionPolicy({path:'policy.json'},[{path:'POLICY.json',update:'preserve'}]), /overlaps/);
  await writeFile(path.join(root,'policy.json'),JSON.stringify(policy()));
  await symlink('policy.json',path.join(root,'linked.json'));
  await assert.rejects(buildAdmissionPolicy(root,{path:'linked.json'}), /symlink|regular/);
  await mkdir(path.join(root,'nested')); await symlink('nested',path.join(root,'linked'));
  await writeFile(path.join(root,'nested','policy.json'),JSON.stringify(policy()));
  await assert.rejects(openAdmissionPolicy(root,'linked/policy.json'), /could not be loaded/);
  await writeFile(path.join(root,'huge.json'),Buffer.alloc(65537,32)); await assert.rejects(openAdmissionPolicy(root,'huge.json'), /could not be loaded/);
}));
test('polling observes an atomic replacement without a caller-triggered reload within ten seconds', async () => temporary(async root => {
  await writeFile(path.join(root,'policy.json'),JSON.stringify(policy()));
  const runtime = await openAdmissionPolicy(root,'policy.json');
  try {
    await writeFile(path.join(root,'next.json'),JSON.stringify(policy('polled'))); await rename(path.join(root,'next.json'),path.join(root,'policy.json'));
    const deadline = Date.now()+9000;
    while(runtime.current().policy.rules[0].id !== 'polled' && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(runtime.current().policy.rules[0].id,'polled');
  } finally { await runtime.close(); }
}));
