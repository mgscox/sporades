import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {composeEquivalenceCases} from './support/compose-equivalence-cases.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const cli=path.join(root,'bin/sporades.js');
const binary=process.env.SPORADES_COMPOSE_TEST_BINARY;

const needsCompose={skip:!binary&&'Set SPORADES_COMPOSE_TEST_BINARY (no daemon needed).'};
async function probe(mode,compose={},elevated=[],override='environment',tamper=false){
  const dir=await mkdtemp(path.join(root,'.sporades-compose-cli-'));
  try{
   const env={...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config')};
   delete env.COMPOSE_PROJECT_NAME;
   if(override==='environment')env.COMPOSE_PROJECT_NAME='qa-unrelated';
   const created=spawnSync(process.execPath,[cli,'create','capsule','--framework','vanilla','--template','blank','--no-install','--no-git','--json'],{cwd:dir,env,encoding:'utf8',timeout:15000});
   assert.equal(created.status,0,created.stdout+created.stderr);
   const project=path.join(dir,'capsule');
   if(override==='project dotenv')await writeFile(path.join(project,'.env'),'COMPOSE_PROJECT_NAME=qa-unrelated\n');
   if(override==='parent dotenv')await writeFile(path.join(dir,'.env'),'COMPOSE_PROJECT_NAME=qa-unrelated\n');
   const config=JSON.parse(await readFile(path.join(project,'sporades.json'),'utf8'));
   config.services={worker:{kind:'container',image:'example:v1',command:[],port:8080,health:{http:'/health'},env:{KEY:{generated:'key'}},compose,elevated}};
   await writeFile(path.join(project,'sporades.json'),JSON.stringify(config));
   const bin=path.join(dir,'fake-bin'),calls=path.join(dir,'docker.jsonl');
   await mkdir(bin);await writeFile(path.join(bin,'package.json'),'{"type":"commonjs"}');
   await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
const {appendFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='compose'&&(args.includes('config')||args.includes('up'))){
 const index=args.findIndex(arg=>arg==='config'||arg==='up');
 const r=spawnSync(process.env.SPORADES_COMPOSE_TEST_BINARY,[...args.slice(1,index),'config','--format','json'],{encoding:'utf8',env:process.env,timeout:10000});
 if(r.status!==0){process.stderr.write(r.stderr??'');process.exit(r.status??1);}
 const resolved=JSON.parse(r.stdout);
 appendFileSync(process.env.FAKE_CALLS,JSON.stringify({args,project:resolved.name,ambientProject:process.env.COMPOSE_PROJECT_NAME??null})+'\\n');
 if(args.includes('config')){
  if(process.env.FAKE_TAMPER_PROJECT)resolved.name='qa-unrelated';
  process.stdout.write(JSON.stringify(resolved));process.exit(0);
 }
 process.exit(1);
}
appendFileSync(process.env.FAKE_CALLS,JSON.stringify({args})+'\\n');
`,{mode:0o755});
   // Deliberately stop at up, after the real resolved-model check.
   const result=spawnSync(process.execPath,[cli,mode,'--port','5203','--json'],{cwd:project,env:{...env,PATH:bin+path.delimiter+env.PATH,FAKE_CALLS:calls,FAKE_TAMPER_PROJECT:tamper?'1':''},encoding:'utf8',timeout:15000});
   assert.equal(result.status,1,result.stdout+result.stderr);
   const output=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
   const events=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
   return {events,message:output.find(value=>value.ok===false)?.error?.message};
  }finally{await rm(dir,{recursive:true,force:true});}
}

for(const {name,compose,elevated=[]} of composeEquivalenceCases)for(const mode of ['dev','deploy']){
 test(`built ${mode} CLI admits ${name} through official Compose preflight`,needsCompose,async()=>{
  const {events,message}=await probe(mode,compose,elevated);
  assert.equal(message,'Failed to start Capsule services.');
  assert(events.findIndex(({args})=>args.includes('config'))>=0);
  assert(events.findIndex(({args})=>args.includes('config'))<events.findIndex(({args})=>args.includes('up')));
 });
}

for(const mode of ['dev','deploy']){
 for(const override of ['environment','project dotenv','parent dotenv'])test(`built ${mode} pins project ownership against ${override}`,needsCompose,async()=>{
  const {events,message}=await probe(mode,{},[],override);
  assert.equal(message,'Failed to start Capsule services.');
  const compose=events.filter(({args})=>args[0]==='compose');
  assert(compose.some(({args})=>args.includes('up')));
  for(const {args,project,ambientProject} of compose){
   assert.equal(args[args.indexOf('-p')+1],'sporades-capsule-services');
   assert.equal(project,'sporades-capsule-services');
   assert.equal(ambientProject,null);
  }
 });
 test(`built ${mode} refuses a changed resolved project before up`,needsCompose,async()=>{
  const {events,message}=await probe(mode,{},[],'environment',true);
  assert.match(message,/compose.name/);
  assert(!events.some(({args})=>args.includes('up')));
 });
}
