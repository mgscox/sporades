import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const service={kind:'container',image:'example:v1',command:[],port:8080,health:{http:'/health'},env:{HF_TOKEN:{sealed:'HF_TOKEN'}},compose:{gpus:'all'},elevated:['gpus']};
test('host push refuses container declarations before resolving a Host; doctor reports names, pins, architecture and elevations',async()=>{
 const dir=await mkdtemp(path.join(root,'.sporades-container-cli-'));
 try {
  const config={name:'container-doctor',services:{embeddings:service}};
  await writeFile(path.join(dir,'sporades.json'),JSON.stringify(config));
  await writeFile(path.join(dir,'.env.sporades.server'),'HF_TOKEN=synthetic-legacy-token\n');
  const run=args=>spawnSync(process.execPath,[path.join(root,'bin/sporades.js'),...args,'--json'],{cwd:dir,env:{...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config')},encoding:'utf8',timeout:20000});
  const pushed=run(['host','push']);
  assert.equal(pushed.status,1);
  assert.match(pushed.stdout,/Hosted Capsule container services are not supported/);
  assert(!pushed.stdout.includes('synthetic-legacy-token'));
  const doctor=run(['doctor','--session','dev']);
  const checks=JSON.parse(doctor.stdout).data.checks;
  const missing=checks.find(c=>c.id==='doctor.server-env');
  assert.equal(missing.status,'fail');assert.deepEqual(missing.details.missingKeys,['HF_TOKEN']);
  const image=checks.find(c=>c.id==='doctor.services.embeddings.image');
  assert.equal(image.status,'warn');assert(image.details.targetArchitecture);
  const elevation=checks.find(c=>c.id==='doctor.services.embeddings.elevated');
  assert.deepEqual(elevation.details.elevated,['gpus']);
  assert(!doctor.stdout.includes('synthetic-legacy-token'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('reset cleans removed service state and labelled volumes after the last Compose file is retired',async()=>{
 const {mkdir,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(root,'.sporades-container-reset-'));
 try{
  await writeFile(path.join(dir,'sporades.json'),JSON.stringify({name:'retired',services:{}}));
  const state=path.join(dir,'.sporades/services/removed');await mkdir(state,{recursive:true});await writeFile(path.join(state,'cache'),'retired state');
  await writeFile(path.join(dir,'.sporades/services/credentials.json'),JSON.stringify({container:{removed:{apiKey:'a'.repeat(64)}}}));
  const bin=path.join(dir,'fake-bin');await mkdir(bin);await writeFile(path.join(bin,'package.json'),'{"type":"module"}');
  const calls=path.join(dir,'docker.jsonl');
  await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='volume'&&args[1]==='ls')process.stdout.write('sporades-retired-removed-cache\\n');
`,{mode:0o755});
  const result=spawnSync(process.execPath,[path.join(root,'bin/sporades.js'),'deploy','reset','--json'],{cwd:dir,env:{...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,CALLS:calls},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  await assert.rejects(readFile(path.join(state,'cache')),{code:'ENOENT'});
  const events=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert(events.some(args=>args[0]==='volume'&&args[1]==='rm'&&args.includes('sporades-retired-removed-cache')));
  const saved=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));assert.equal(saved.container,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('startup addressing restrictions preserve stop and reset for existing network declarations',async()=>{
 const {mkdir,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(root,'.sporades-network-teardown-'));
 try{
  const bin=path.join(dir,'fake-bin'),calls=path.join(dir,'docker.jsonl');await mkdir(bin);
  await writeFile(path.join(bin,'package.json'),'{"type":"module"}');
  await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+'\\n');
`,{mode:0o755});
  for(const network_mode of ['bridge','none']){
   await writeFile(path.join(dir,'sporades.json'),JSON.stringify({name:'network-teardown',services:{worker:{kind:'container',image:'example:v1',command:[],port:8080,health:{http:'/health'},compose:{network_mode},elevated:['network_mode']}}}));
   for(const args of [['dev','stop'],['dev','reset'],['deploy','reset']]){
    const result=spawnSync(process.execPath,[path.join(root,'bin/sporades.js'),...args,'--json'],{cwd:dir,env:{...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,CALLS:calls},encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,`${network_mode} ${args.join(' ')}: ${result.stdout}${result.stderr}`);
   }
  }
  const events=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(args=>args.includes('down')).length,6);
  assert(!events.some(args=>args.includes('up')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
