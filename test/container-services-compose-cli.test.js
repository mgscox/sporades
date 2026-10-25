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

for(const {name,compose,elevated=[]} of composeEquivalenceCases)for(const mode of ['dev','deploy']){
 test(`built ${mode} CLI admits ${name} through official Compose preflight`,{skip:!binary&&'Set SPORADES_COMPOSE_TEST_BINARY (no daemon needed).'},async()=>{
  const dir=await mkdtemp(path.join(root,'.sporades-compose-cli-'));
  try{
   const env={...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config')};
   const created=spawnSync(process.execPath,[cli,'create','capsule','--framework','vanilla','--template','blank','--no-install','--no-git','--json'],{cwd:dir,env,encoding:'utf8',timeout:15000});
   assert.equal(created.status,0,created.stdout+created.stderr);
   const project=path.join(dir,'capsule');
   const config=JSON.parse(await readFile(path.join(project,'sporades.json'),'utf8'));
   config.services={worker:{kind:'container',image:'example:v1',command:[],port:8080,health:{http:'/health'},env:{KEY:{generated:'key'}},compose,elevated}};
   await writeFile(path.join(project,'sporades.json'),JSON.stringify(config));
   const bin=path.join(dir,'fake-bin'),calls=path.join(dir,'docker.jsonl');
   await mkdir(bin);await writeFile(path.join(bin,'package.json'),'{"type":"commonjs"}');
   await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
const {appendFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);appendFileSync(process.env.FAKE_CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='compose'&&args.includes('config')){
 const r=spawnSync(process.env.SPORADES_COMPOSE_TEST_BINARY,args.slice(1),{encoding:'utf8',env:process.env,timeout:10000});
 process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
}
// Deliberately stop at service startup, after the real resolved-model check.
if(args[0]==='compose'&&args.includes('up'))process.exit(1);
`,{mode:0o755});
   const result=spawnSync(process.execPath,[cli,mode,'--port','5203','--json'],{cwd:project,env:{...env,PATH:bin+path.delimiter+env.PATH,FAKE_CALLS:calls},encoding:'utf8',timeout:15000});
   assert.equal(result.status,1,result.stdout+result.stderr);
   const output=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
   assert.equal(output.find(value=>value.ok===false)?.error?.message,'Failed to start Capsule services.',result.stdout+result.stderr);
   const events=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
   assert(events.findIndex(args=>args.includes('config'))>=0);
   assert(events.findIndex(args=>args.includes('config'))<events.findIndex(args=>args.includes('up')));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
