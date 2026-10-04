import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { lifecycleOwnership, removeOwnedDockerContainer, assertGenerationObservation, lifecycleDockerNetworkArgs, lifecycleDockerEndpoint } from './support/admission-lifecycle-proof.js';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const scratch = path.join(repo, '.sporades/issue-73/cleanup-tests');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('runner probes address sibling DNS while workstation probes retain loopback publication', async () => {
  const network='sporades-proof-network-cccccccccccc';
  const name='sporades-lifecycle-container-aaaaaaaaaaaa';
  const calls=[];
  const command=async args=>{calls.push(args);return '127.0.0.1:53129\n';};
  assert.deepEqual(lifecycleDockerNetworkArgs(network),['--network',network]);
  assert.equal(await lifecycleDockerEndpoint(command,name,network),`http://${name}:5688`,
    'tools-container probes must not address the daemon host publication through their own loopback');
  assert.equal(await lifecycleDockerEndpoint(command,name), 'http://127.0.0.1:53129');
  assert.deepEqual(calls,[['port',name,'5688/tcp'],['port',name,'5688/tcp']]);
  assert.throws(()=>lifecycleDockerNetworkArgs('bridge'),/owned per-run proof network/);
  await assert.rejects(lifecycleDockerEndpoint(async()=> '0.0.0.0:53129',name,network),/loopback-only/);
});

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
      SPORADES_ADMISSION_PROOF_NETWORK:'sporades-proof-network-cccccccccccc',
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
    assert.equal(call.args[call.args.indexOf('--network')+1],'sporades-proof-network-cccccccccccc','Capsule must join the runner bridge');
    assert.equal(call.args[call.args.indexOf('-p')+1],'127.0.0.1::5688','host publication must remain loopback-only');
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

async function fakeOuterCleanup(t, { signal, runnerRemoval = 'success', childRemoval = 'fail', networkRemoval = 'success', lateChild = false, interruptAt = 'startup' } = {}) {
  await mkdir(scratch,{recursive:true}); const root=await mkdtemp(path.join(scratch,'runner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'); await mkdir(bin); await writeFile(path.join(bin,'package.json'),'{"type":"commonjs"}');
  const events=path.join(root,'events.jsonl'),stateFile=path.join(root,'docker-state.json');
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
const stateFile=${JSON.stringify(stateFile)};
const createChild=source=>{
  const fixture=path.join(source,'.sporades/issue-73/lifecycle-fake');
  fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'ownership.json'),JSON.stringify([{kind:'container',name:'sporades-lifecycle-container-aaaaaaaaaaaa',removed:false,attempts:[]}]));
  fs.writeFileSync(path.join(fixture,'fixture-marker'),'retain me');
  fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(['created-child','sporades-lifecycle-container-aaaaaaaaaaaa'])+'\\n');
};
if(args[0]==='context') process.stdout.write('unix:///fake-proof.sock\\n');
else if(args[0]==='info') process.stdout.write('fake-only\\n');
else if(args[0]==='network'&&args[1]==='create') {
  const evidence=${JSON.stringify(path.join(root,'evidence'))};
  const run=fs.readdirSync(evidence)[0];
  const owner=JSON.parse(fs.readFileSync(path.join(evidence,run,'ownership.json'),'utf8')).find(owner=>owner.kind==='network'&&owner.name===args.at(-1));
  fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(['network-journal',owner])+'\\n');
  if(!owner||owner.removed) {process.stderr.write('network creation preceded ownership');process.exitCode=1;}
} else if(args[0]==='network'&&args[1]==='rm') {
  if(${JSON.stringify(networkRemoval)}==='fail') {process.stderr.write('fake network removal failed\\n');process.exitCode=1;}
}
else if(args[0]==='run') {
  const source=args[args.indexOf('--workdir')+1];
  fs.writeFileSync(stateFile,JSON.stringify({source,removals:0}));
  if(!${lateChild}) createChild(source);
  fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(['runner-ready'])+'\\n');
  ${signal && interruptAt === 'startup' ? 'setInterval(()=>{},1000);' : "process.stderr.write('fake runner startup failed\\n');process.exitCode=1;"}
} else if(args[0]==='rm'&&args.at(-1).startsWith('sporades-proof-runner-')) {
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));state.removals++;
  fs.writeFileSync(stateFile,JSON.stringify(state));
  if(state.removals===2&&${lateChild}) createChild(state.source);
  const finish=()=>{
    if(${JSON.stringify(runnerRemoval)}==='fail'||(${JSON.stringify(runnerRemoval)}==='retry'&&state.removals===1)) {
      process.stderr.write('fake runner removal failed\\n');process.exitCode=1;
    }
  };
  ${signal && interruptAt === 'removal' ? 'if(state.removals===2) setTimeout(finish,200); else finish();' : 'finish();'}
} else if(args[0]==='rm'&&args.at(-1)==='sporades-lifecycle-container-aaaaaaaaaaaa') {
  if(${JSON.stringify(childRemoval)}==='fail') {process.stderr.write('fake Capsule removal failed\\n');process.exitCode=1;}
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
      try {
        const calls=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
        if(interruptAt==='startup' ? calls.some(args=>args[0]==='runner-ready') : calls.filter(args=>args[0]==='rm'&&args.at(-1).startsWith('sporades-proof-runner-')).length>=2) break;
      } catch {}
      await sleep(25);
    }
    const calls=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(interruptAt==='startup' ? calls.some(args=>args[0]==='runner-ready') : calls.filter(args=>args[0]==='rm'&&args.at(-1).startsWith('sporades-proof-runner-')).length>=2);
    child.kill(signal);
  }
  const [code]=await closed; assert.equal(code,1,output);
  const runs=await readdir(runRoot); assert.equal(runs.length,1);
  const report=JSON.parse(await readFile(path.join(runRoot,runs[0],'docker-report.json'),'utf8'));
  const runner=report.cleanup.find(item=>item.name.startsWith('sporades-proof-runner-'));
  const stage=runner.stage;
  t.after(()=>rm(stage,{recursive:true,force:true}));
  const calls=(await readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
  const network=report.cleanup.find(item=>item.kind==='network');
  assert.ok(network,'owned bridge was not reported');
  assert.equal(network.name,report.network.name);
  const creation=calls.find(args=>args[0]==='network'&&args[1]==='create');
  assert.deepEqual(creation,['network','create','--driver','bridge',network.name]);
  assert.equal(calls.find(args=>args[0]==='network-journal')[1].removed,false,'network creation must follow its journal');
  const launch=calls.find(args=>args[0]==='run');
  assert.equal(launch[launch.indexOf('--network')+1],network.name,'runner must join the Capsule bridge');
  assert.ok(launch.includes(`SPORADES_ADMISSION_PROOF_NETWORK=${network.name}`),'fixtures must receive the same network');
  const removals=calls.filter(args=>args[0]==='rm'&&args.at(-1)===runner.name);
  assert.equal(removals.length,runnerRemoval==='success'?1:2,'writer must not be retried after the inventory');
  if(runnerRemoval==='retry') assert.ok(report.cleanup.some(item=>item.name==='sporades-lifecycle-container-aaaaaaaaaaaa'),'late child was omitted from recovery');
  assert.equal(report.runnerTermination.confirmed,runnerRemoval!=='fail');
  if(signal) assert.equal(report.interruption,signal);
  if(runnerRemoval==='fail') {
    assert.equal(report.status,'cleanup-failed'); assert.equal(report.retainedStage,stage);
    assert.equal(report.childOwnershipScan,'blocked-runner-termination');
    assert.deepEqual(report.childOwnership,[]);
    assert.equal(runner.removed,false);
    assert.ok(runner.attempts.every(attempt=>!attempt.removed&&/fake runner removal failed/.test(attempt.error)));
    assert.equal(calls.some(args=>['inspect','rm'].includes(args[0])&&args.at(-1)==='sporades-lifecycle-container-aaaaaaaaaaaa'),false,'uncertain writer must block child recovery');
    assert.equal(network.removed,false); assert.deepEqual(network.attempts,[]);
    assert.equal(calls.some(args=>args[0]==='network'&&args[1]==='rm'),false,'uncertain writer must retain its network');
    await readFile(path.join(stage,'source/.sporades/issue-73/lifecycle-fake/fixture-marker'));
    return;
  }
  assert.equal(report.childOwnershipScan,'complete');
  assert.equal(report.childOwnership.length,1);
  assert.equal(report.childOwnership[0].name,'sporades-lifecycle-container-aaaaaaaaaaaa');
  assert.equal(runner.removed,true);
  if(runnerRemoval==='retry') assert.deepEqual(runner.attempts.map(attempt=>attempt.removed),[false,true]);
  const owner=report.cleanup.find(item=>item.name==='sporades-lifecycle-container-aaaaaaaaaaaa');
  assert.ok(owner,'authoritative inventory omitted the child');
  const runnerRemovalEnd=calls.findLastIndex(args=>args[0]==='rm'&&args.at(-1)===runner.name);
  const childInspection=calls.findIndex(args=>args[0]==='inspect'&&args.at(-1)===owner.name);
  assert.ok(childInspection>runnerRemovalEnd,'child inventory/recovery preceded confirmed writer termination');
  if(childRemoval==='fail') {
    assert.equal(report.status,'cleanup-failed'); assert.equal(report.retainedStage,stage);
    await readFile(path.join(stage,'source/.sporades/issue-73/lifecycle-fake/fixture-marker'));
    assert.equal(owner.removed,false); assert.equal(owner.attempts.length,2);
    assert.ok(owner.attempts.every(attempt=>!attempt.removed&&/fake Capsule removal failed/.test(attempt.error)));
    assert.equal(network.removed,false); assert.deepEqual(network.attempts,[]);
    assert.equal(calls.some(args=>args[0]==='network'&&args[1]==='rm'),false,'failed Capsule cleanup must retain its network');
  } else {
    assert.equal(owner.removed,true); assert.equal(owner.attempts.length,1);
    const networkRemovalStart=calls.findIndex(args=>args[0]==='network'&&args[1]==='rm');
    assert.ok(networkRemovalStart>calls.findLastIndex(args=>args[0]==='rm'&&args.at(-1)===owner.name),'network removal must follow all container removals');
    if(networkRemoval==='fail') {
      assert.equal(network.removed,false); assert.equal(network.attempts.length,2);
      assert.ok(network.attempts.every(attempt=>!attempt.removed&&/fake network removal failed/.test(attempt.error)));
      assert.equal(report.status,'cleanup-failed'); assert.equal(report.retainedStage,stage);
      await readdir(stage);
    } else {
      assert.equal(network.removed,true);
      assert.equal(report.retainedStage,undefined);
      assert.equal(report.status,signal?'interrupted':'incomplete');
      await assert.rejects(readdir(stage),error=>error.code==='ENOENT','complete recovery should permit stage deletion');
    }
  }
  assert.ok(report.cleanup.filter(item=>![owner.name,network.name].includes(item.name)).every(item=>item.removed));
}

for (const signal of [undefined, 'SIGTERM']) test(`outer runner retains child ownership after ${signal || 'failed startup'}`, {timeout:30000}, t => fakeOuterCleanup(t,{signal}));
for (const runnerRemoval of ['retry','fail']) for (const signal of [undefined,'SIGTERM'])
  test(`runner ${runnerRemoval} removal ${signal || 'without interruption'} inventories late ownership only after termination`, {timeout:30000},
    t => fakeOuterCleanup(t,{runnerRemoval,signal,childRemoval:'success',lateChild:true,interruptAt:'removal'}));
test('failed owned-network removal retains recovery stage after runner and child termination', {timeout:30000},
  t=>fakeOuterCleanup(t,{childRemoval:'success',networkRemoval:'fail'}));

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
