import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { lifecycleOwnership, removeOwnedDockerContainer, assertGenerationObservation } from './support/admission-lifecycle-proof.js';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const scratch = path.join(repo, '.sporades/issue-73/cleanup-tests');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fakeStartup(t, removal, signal) {
  await mkdir(scratch, {recursive:true});
  const root = await mkdtemp(path.join(scratch, 'fake-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const events = path.join(root, 'events.jsonl');
  await writeFile(path.join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),events=${JSON.stringify(events)};
let ownership;
if(args[0]==='run') {
  const mount=args.find(arg=>arg.endsWith(':/app/server.mjs:ro'));
  ownership=JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(mount.split(':/app/')[0])),'ownership.json'),'utf8'));
}
const past=fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(events,JSON.stringify({args,ownership})+'\\n');
if(args[0]==='context') process.stdout.write('unix:///fake-proof.sock\\n');
else if(args[0]==='info') process.stdout.write('fake-only\\n');
else if(args[0]==='run') {
  ${signal ? 'setInterval(()=>{},1000);' : "process.stderr.write('fake startup failed after create\\n');process.exitCode=1;"}
} else if(args[0]==='rm') {
  const previous=past.filter(event=>event.args[0]==='rm'&&event.args.at(-1)===args.at(-1)).length;
  if(${JSON.stringify(removal)}==='fail'||previous===0) {process.stderr.write('fake removal failed\\n');process.exitCode=1;}
} else { process.stderr.write('unexpected fake command'); process.exitCode=1; }
`, {mode:0o755});
  // CommonJS fake commands must stay outside any inherited ESM package root.
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  const proof = path.join(root, 'proof');
  const child = spawn(process.execPath, ['test/admission-lifecycle.acceptance.test.js'], {
    cwd:repo, env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
      DOCKER_HOST:'unix:///fake-proof.sock',SPORADES_CONFIG_DIR:path.join(root,'config'),
      SPORADES_ADMISSION_DRIVER_CHECK:'0',SPORADES_REAL_ADMISSION_LIFECYCLE:'1',SPORADES_ADMISSION_PROOF_ROOT:proof},
    stdio:['ignore','pipe','pipe'],
  });
  const closed = once(child, 'close');
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  t.after(() => { if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  if(signal) {
    const deadline = Date.now()+15000;
    while(Date.now()<deadline) {
      try { if((await readFile(events,'utf8')).includes('"run"')) break; } catch {}
      await sleep(25);
    }
    assert.ok((await readFile(events,'utf8')).includes('"run"'), 'fake startup never reached launch');
    child.kill(signal);
  }
  const [code] = await closed; assert.equal(code,1,output);
  const reports = await Promise.all(['container','hosted'].map(session => readFile(path.join(proof,`evidence/lifecycle-${session}-docker.json`),'utf8').then(JSON.parse)));
  const calls = (await readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
  for(const call of calls.filter(call=>call.args[0]==='run')) {
    const name=call.args[call.args.indexOf('--name')+1];
    assert.ok(call.ownership.some(owner=>owner.name===name&&!owner.removed), 'launch preceded durable ownership');
  }
  for(const report of reports) {
    assert.equal(report.cleanup.length,1,output);
    const owner=report.cleanup[0];
    assert.equal(owner.attempts.length,2);
    assert.equal(owner.attempts[0].removed,false);
    assert.match(owner.attempts[0].error,/fake removal failed/);
    assert.equal(owner.removed,removal!=='fail');
    assert.equal(calls.filter(call=>call.args[0]==='rm'&&call.args.at(-1)===owner.name).length,2);
    if(removal==='fail') {
      assert.equal(report.status,'cleanup-failed');
      const journal=JSON.parse(await readFile(path.join(report.retainedFixture,'ownership.json'),'utf8'));
      assert.deepEqual(journal,report.cleanup);
      await readFile(path.join(report.retainedFixture,'runtime/server.mjs'));
    } else {
      assert.equal(report.status,signal?'interrupted':'incomplete');
      assert.equal(report.retainedFixture,undefined);
    }
  }
  assert.equal((await readdir(proof)).filter(name=>name.startsWith('lifecycle-')).length,removal==='fail'?2:0);
}

test('failed startup and failed removal retain both session fixtures and ownership', {timeout:30000}, t => fakeStartup(t,'fail'));
test('failed startup retries removal and deletes fixtures only after success', {timeout:30000}, t => fakeStartup(t,'retry'));
for(const [signal,removal] of [['SIGINT','fail'],['SIGTERM','retry']])
  test(`${signal} during startup reports ownership and retries cleanup`, {timeout:30000}, t => fakeStartup(t,removal,signal));

test('ownership remains retryable after an explicit removal failure', async t => {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(path.join(scratch,'owner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const owners=lifecycleOwnership(path.join(root,'ownership.json')); let attempts=0;
  const remove=await owners.register('container','owned-only',async()=>{if(++attempts===1) throw new Error('busy');});
  await assert.rejects(remove(),/busy/);
  assert.equal(owners.snapshot()[0].removed,false);
  await remove(); await remove();
  assert.equal(attempts,2);
  assert.deepEqual(owners.snapshot()[0].attempts,[{removed:false,error:'busy'},{removed:true}]);
});

test('missing-container cleanup requires explicit Docker absence confirmation', async () => {
  const removal=new Error('rm failed');
  for (const stderr of ['daemon unavailable','object exists']) {
    await assert.rejects(removeOwnedDockerContainer(async args=>{
      if(args[0]==='rm') throw removal;
      throw Object.assign(new Error('inspect failed'),{code:1,stderr});
    },'owned-only'),error=>error===removal);
  }
  await removeOwnedDockerContainer(async args=>{
    if(args[0]==='rm') throw removal;
    throw Object.assign(new Error('absent'),{code:1,stderr:'Error: No such object: owned-only'});
  },'owned-only');
});

test('journal failure cannot stop removal of later owners or poison future writes', async t => {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(path.join(scratch,'journal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=path.join(root,'ownership.json'),owners=lifecycleOwnership(journal),removed=[];
  await owners.register('container','first',async()=>removed.push('first'));
  await owners.register('container','second',async()=>removed.push('second'));
  await mkdir(journal+'.candidate');
  const result=await owners.cleanup();
  assert.deepEqual(removed,['second','first']);
  assert.ok(result.every(record=>record.removed&&record.journalErrors.length>0));
  await rm(journal+'.candidate',{recursive:true});
  await owners.cleanup();
  assert.deepEqual(removed,['second','first'],'confirmed removal must remain idempotent');
  assert.deepEqual(JSON.parse(await readFile(journal,'utf8')),owners.snapshot());
});

for (const signal of [undefined, 'SIGTERM']) test(`outer runner retains child ownership after ${signal || 'failed startup'}`, {timeout:30000}, async t => {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(path.join(scratch,'runner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'); await mkdir(bin); await writeFile(path.join(bin,'package.json'),'{"type":"commonjs"}');
  const events=path.join(root,'events.jsonl');
  // The fake Git status permits archiving a dirty test checkout. All other Git
  // reads remain real; fake Docker never executes the archived tools program.
  await writeFile(path.join(bin,'git'),`#!${process.execPath}
if(process.argv[2]!=='status') {
  const result=require('node:child_process').spawnSync('git',process.argv.slice(2),{env:{...process.env,PATH:process.env.PROOF_REAL_PATH},stdio:'inherit'});
  process.exitCode=result.status;
}
`,{mode:0o755});
  await writeFile(path.join(bin,'docker'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(args)+'\\n');
if(args[0]==='context') process.stdout.write('unix:///fake-proof.sock\\n');
else if(args[0]==='info') process.stdout.write('fake-only\\n');
else if(args[0]==='run') {
  const source=args[args.indexOf('--workdir')+1],fixture=path.join(source,'.sporades/issue-73/lifecycle-fake');
  fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'ownership.json'),JSON.stringify([{kind:'container',name:'sporades-lifecycle-container-aaaaaaaaaaaa',removed:false,attempts:[]}]));
  fs.writeFileSync(path.join(fixture,'fixture-marker'),'retain me');
  ${signal ? 'setInterval(()=>{},1000);' : "process.stderr.write('fake runner startup failed\\n');process.exitCode=1;"}
} else if(args[0]==='rm'&&args.at(-1)==='sporades-lifecycle-container-aaaaaaaaaaaa') {
  process.stderr.write('fake Capsule removal failed\\n');process.exitCode=1;
}
`,{mode:0o755});
  const runRoot=path.join(root,'evidence');
  const child=spawn(process.execPath,['scripts/verify-admission-lifecycle.mjs'],{cwd:repo,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,PROOF_REAL_PATH:process.env.PATH,
      DOCKER_HOST:'unix:///fake-proof.sock',SPORADES_CONFIG_DIR:path.join(root,'config'),SPORADES_ADMISSION_RUN_ROOT:runRoot},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close'); let output='';
  child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');});
  if(signal) {
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      try { if((await readFile(events,'utf8')).includes('"run"')) break; } catch {}
      await sleep(25);
    }
    assert.ok((await readFile(events,'utf8')).includes('"run"'));
    // Allow the fake launch to finish creating the durable child fixture.
    await sleep(50); child.kill(signal);
  }
  const [code]=await closed; assert.equal(code,1,output);
  const runs=await readdir(runRoot); assert.equal(runs.length,1);
  const report=JSON.parse(await readFile(path.join(runRoot,runs[0],'docker-report.json'),'utf8'));
  assert.equal(report.status,'cleanup-failed'); assert.ok(report.retainedStage);
  t.after(()=>rm(report.retainedStage,{recursive:true,force:true}));
  await readFile(path.join(report.retainedStage,'source/.sporades/issue-73/lifecycle-fake/fixture-marker'));
  const owner=report.cleanup.find(item=>item.name==='sporades-lifecycle-container-aaaaaaaaaaaa');
  assert.equal(owner.removed,false); assert.equal(owner.attempts.length,2);
  assert.ok(owner.attempts.every(attempt=>!attempt.removed&&/fake Capsule removal failed/.test(attempt.error)));
  assert.ok(report.cleanup.filter(item=>item.name!==owner.name).every(item=>item.removed));
});

test('native runner interruption reaches the fixture owner and stops its child', {timeout:30000}, async t => {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(path.join(scratch,'native-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runRoot=path.join(root,'evidence');
  const child=spawn(process.execPath,['scripts/verify-admission-lifecycle.mjs','--driver-check'],{cwd:repo,
    env:{...process.env,SPORADES_CONFIG_DIR:path.join(root,'config'),SPORADES_ADMISSION_RUN_ROOT:runRoot},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close'); let output='', pid, run;
  child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');});
  const deadline=Date.now()+15000;
  while(!pid&&Date.now()<deadline) {
    try {
      run=(await readdir(runRoot))[0]; const fixtures=path.join(runRoot,run,'fixtures');
      for(const directory of (await readdir(fixtures)).filter(name=>name.startsWith('lifecycle-'))) {
        const owners=JSON.parse(await readFile(path.join(fixtures,directory,'ownership.json'),'utf8'));
        pid=owners.find(owner=>owner.kind==='process'&&!owner.removed)?.pid;
        if(pid) break;
      }
    } catch {}
    await sleep(25);
  }
  assert.ok(pid,'native child was not durably identified before interruption');
  child.kill('SIGTERM');
  const [code]=await closed; assert.equal(code,1,output);
  const report=JSON.parse(await readFile(path.join(runRoot,run,'driver-report.json'),'utf8'));
  assert.equal(report.status,'interrupted'); assert.equal(report.interruption,'SIGTERM');
  assert.equal((await readdir(path.join(runRoot,run,'fixtures'))).filter(name=>name.startsWith('lifecycle-')).length,0);
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','owned native child survived cleanup');
});

test('generation observations reject union, empty and split policies', () => {
  const generations=new Map([['old','a'],['new','b']]);
  for(const digest of generations.keys()) for(const group of ['a','b']) for(const transport of ['http','websocket']) {
    const denied=generations.get(digest)===group;
    const observation={digest,transport,outcome:denied?'denied':'admitted'};
    const probe={group,transport}; const response={status:denied?403:transport==='http'?200:101};
    assert.equal(assertGenerationObservation(generations,observation,probe,response),denied);
    assert.throws(()=>assertGenerationObservation(generations,{...observation,outcome:denied?'admitted':'denied'},probe,response),/mixed generation/);
  }
  // A union denies group B under the old digest; an empty policy admits A.
  assert.throws(()=>assertGenerationObservation(generations,{digest:'old',transport:'http',outcome:'denied'}, {group:'b',transport:'http'},{status:403}),/mixed generation/);
  assert.throws(()=>assertGenerationObservation(generations,{digest:'old',transport:'http',outcome:'admitted'}, {group:'a',transport:'http'},{status:200}),/mixed generation/);
  // Split transport rules deny B on WebSocket while claiming the old generation.
  assert.throws(()=>assertGenerationObservation(generations,{digest:'old',transport:'websocket',outcome:'denied'}, {group:'b',transport:'websocket'},{status:403}),/mixed generation/);
  assert.throws(()=>assertGenerationObservation(generations,{digest:'merged',transport:'http',outcome:'denied'}, {group:'a',transport:'http'},{status:403}),/unknown\/partial/);
});
