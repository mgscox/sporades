import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=path.join(root,'bin/sporades.js');
const key='c'.repeat(64);
const declaration={kind:'container',image:'example:v1',command:[],port:8080,health:{http:'/health'},state:{path:'/models'},env:{API_KEY:{generated:'apiKey'}}};

test('reset helper uses the immutable Node image pinned by the Base Dockerfile',async()=>{
 const {SERVICE_STATE_CLEANUP_IMAGE}=await import('../dist/container-service-reset.js');
 assert((await readFile(path.join(root,'Dockerfile.base'),'utf8')).startsWith('FROM '+SERVICE_STATE_CLEANUP_IMAGE+'\n'));
});

async function fixture(run){
 const dir=await mkdtemp(path.join(root,'.sporades-reset-'));
 try{
  const state=path.join(dir,'.sporades/services/worker'),nested=path.join(state,'.locks/models--private');
  await mkdir(nested,{recursive:true});await writeFile(path.join(nested,'cache'),'model cache');await chmod(nested,0o555);
  await writeFile(path.join(dir,'sporades.json'),JSON.stringify({name:'reset-contract',services:{worker:declaration}}));
  const credentials=path.join(dir,'.sporades/services/credentials.json');
  await writeFile(credentials,JSON.stringify({databasePassword:'retain-builtin',container:{worker:{apiKey:key}},containerGeneration:'old-generation'}));
  const bin=path.join(dir,'fake-bin'),calls=path.join(dir,'docker.jsonl'),marker=path.join(dir,'helper-ran');await mkdir(bin);
  await writeFile(path.join(bin,'package.json'),'{"type":"commonjs"}');
  const preload=path.join(dir,'foreign-owner.cjs');
  await writeFile(preload,`if(process.argv[1]===process.env.TEST_CLI){
const fs=require('node:fs/promises'),sync=require('node:fs');const state=process.env.TEST_STATE;
const originalLstat=fs.lstat,originalRm=fs.rm,originalChmod=fs.chmod,originalReaddir=fs.readdir;let reads=0;
fs.readdir=async function(file,...args){const entries=await originalReaddir.call(this,file,...args);if(String(file)===require('node:path').dirname(state)&&args[0]?.withFileTypes)entries.sort((a,b)=>a.name==='worker'?-1:b.name==='worker'?1:0);return entries;};
fs.lstat=async function(file,...args){const stat=await originalLstat.call(this,file,...args);if(String(file)===state&&process.env.TEST_SWAP_STATE&&++reads===2){sync.renameSync(state,state+'-old');sync.symlinkSync(process.env.TEST_SWAP_STATE,state,'dir');}if(String(file)===state||String(file).startsWith(state+'/'))stat.uid=10001;return stat;};
fs.chmod=async function(file,...args){if(String(file)===state)throw Object.assign(new Error('EACCES private owner '+process.env.TEST_SECRET),{code:'EACCES'});return originalChmod.call(this,file,...args);};
fs.rm=async function(file,...args){if(String(file)===state&&sync.lstatSync(state).isDirectory()&&!sync.existsSync(process.env.TEST_MARKER))throw Object.assign(new Error('EACCES model cache '+process.env.TEST_SECRET),{code:'EACCES'});return originalRm.call(this,file,...args);};
require('node:module').syncBuiltinESMExports();}
`);
  await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
const saved=JSON.parse(fs.readFileSync(process.env.TEST_CREDENTIALS,'utf8'));
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({args,hasSecrets:!!saved.container||!!saved.containerGeneration})+'\\n');
if(args.includes('down')&&process.env.TEST_DOWN_FAIL==='1')process.exit(1);
if(args[0]==='volume'&&args[1]==='ls')process.stdout.write('sporades-reset-contract-cache\\n');
if(args[0]==='run'){
 if(process.env.TEST_HELPER_FAIL==='1'){process.stderr.write('EACCES '+process.env.TEST_SECRET);process.exit(1);}
 if(process.env.TEST_HELPER_NOOP==='1')process.exit(0);
 if(process.env.TEST_STICKY==='1'&&!args.includes('FOWNER')){process.stderr.write('EPERM sticky owner '+process.env.TEST_SECRET);process.exit(1);}
 const mount=args[args.indexOf('--mount')+1];if(!mount?.includes('target=/state'))process.exit(2);
 const state=process.env.TEST_STATE;
 const repair=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())repair(file);}};
 repair(state);for(const entry of fs.readdirSync(state))fs.rmSync(path.join(state,entry),{recursive:true,force:true});
 fs.writeFileSync(process.env.TEST_MARKER,'done');
}
`,{mode:0o755});
  const env={...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,NODE_OPTIONS:`--require=${JSON.stringify(preload)}`,TEST_CLI:cli,TEST_STATE:state,TEST_CREDENTIALS:credentials,TEST_CALLS:calls,TEST_MARKER:marker,TEST_SECRET:key};
  const command=(surface,extra={})=>spawnSync(process.execPath,[cli,surface,'reset','--json'],{cwd:dir,env:{...env,...extra},encoding:'utf8',timeout:15000});
  const events=async()=>(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  await run({dir,state,nested,credentials,command,events});
 }finally{
  // The fixture models foreign ownership through the CLI preload, so its creator can repair it.
  const repair=async directory=>{await chmod(directory,0o700);for(const entry of await (await import('node:fs/promises')).readdir(directory,{withFileTypes:true})){if(entry.isDirectory())await repair(path.join(directory,entry.name));}};
  await repair(dir);await rm(dir,{recursive:true,force:true});
 }
}

for(const surface of ['dev','deploy']){
 test(`built ${surface} reset keeps secrets revoked when Compose cannot stop services`,async()=>fixture(async({state,credentials,command,events})=>{
  const result=command(surface,{TEST_DOWN_FAIL:'1'});assert.equal(result.status,1);
  const saved=JSON.parse(await readFile(credentials,'utf8'));assert.equal(saved.container,undefined);assert.equal(saved.containerGeneration,undefined);
  assert.equal(await readFile(path.join(state,'.locks/models--private/cache'),'utf8'),'model cache');
  assert(!(await events()).some(c=>c.args[0]==='run'));
 }));
 test(`built ${surface} reset removes foreign-UID cache through a confined helper after revoking secrets`,async()=>fixture(async({state,credentials,command,events})=>{
  const result=command(surface,{TEST_STICKY:'1'});assert.equal(result.status,0,result.stdout+result.stderr);
  await assert.rejects(lstat(state),{code:'ENOENT'});
  await assert.rejects(readFile(path.join(state,'.locks/models--private/cache')),{code:'ENOENT'});
  const saved=JSON.parse(await readFile(credentials,'utf8'));assert.equal(saved.container,undefined);assert.equal(saved.containerGeneration,undefined);assert.equal(saved.databasePassword,'retain-builtin');
  const calls=await events();assert(calls.every(c=>!c.hasSecrets),'revoke before any Docker mutation');
  const helpers=calls.filter(c=>c.args[0]==='run');assert.equal(helpers.length,1);
  const args=helpers[0].args;assert.equal(args[args.indexOf('--user')+1],'0:0');assert.equal(args[args.indexOf('--network')+1],'none');
  assert.equal(args[args.indexOf('--cap-drop')+1],'ALL');assert.deepEqual(args.flatMap((a,i)=>a==='--cap-add'?[args[i+1]]:[]).sort(),['DAC_OVERRIDE','FOWNER']);assert.equal(args[args.indexOf('--security-opt')+1],'no-new-privileges:true');
  assert.equal(args.filter(a=>a==='--mount').length,1);const mount=args[args.indexOf('--mount')+1];assert(mount.includes('source='+state));assert(mount.includes('target=/state'));assert(mount.includes('bind-recursive=disabled'));
  assert(args.includes('--read-only'));assert(!args.includes('--privileged'));assert(args.some(a=>a.includes('@sha256:')));
  assert(calls.some(c=>c.args.includes('down')));assert(calls.some(c=>c.args[0]==='volume'&&c.args[1]==='rm'));
  assert(!result.stdout.includes(key));assert(!result.stderr.includes(key));
 }));
 test(`built ${surface} reset revokes secrets and continues cleanup when foreign-UID removal fails; retry converges`,async()=>fixture(async({dir,state,credentials,command,events})=>{
  const stale=path.join(dir,'.sporades/services/removed');await mkdir(stale);await writeFile(path.join(stale,'cache'),'old state');
  const result=command(surface,{TEST_HELPER_FAIL:'1'});assert.equal(result.status,1);
  const saved=JSON.parse(await readFile(credentials,'utf8'));assert.equal(saved.container,undefined);assert.equal(saved.containerGeneration,undefined);
  assert.equal(await readFile(path.join(state,'.locks/models--private/cache'),'utf8'),'model cache');await assert.rejects(readFile(path.join(stale,'cache')),{code:'ENOENT'});
  const error=JSON.parse(result.stdout.trim().split('\n').at(-1)).error;assert.match(error.message,/reset incomplete/i);assert(error.hint.includes(state));assert(error.hint.includes('10001'));assert.match(error.hint,/docker.*run/);assert(error.hint.includes('@sha256:'));
  assert(!result.stdout.includes('EACCES'));assert(!result.stdout.includes(key));assert(!result.stderr.includes(key));
  const calls=await events();assert(calls.every(c=>!c.hasSecrets));assert(calls.some(c=>c.args[0]==='volume'&&c.args[1]==='rm'));
  const retry=command(surface);assert.equal(retry.status,0,retry.stdout+retry.stderr);await assert.rejects(lstat(state),{code:'ENOENT'});
 }));
}

test('reset removes a stale foreign-UID service tree after its declaration is removed',async()=>fixture(async({dir,state,credentials,command})=>{
 await writeFile(path.join(dir,'sporades.json'),JSON.stringify({name:'reset-contract',services:{}}));
 const result=command('deploy');assert.equal(result.status,0,result.stdout+result.stderr);
 await assert.rejects(lstat(state),{code:'ENOENT'});
 await assert.rejects(readFile(path.join(state,'.locks/models--private/cache')),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(credentials,'utf8')).container,undefined);
}));

test('reset unlinks stale state symlinks without mounting or deleting their targets',async()=>fixture(async({dir,state,command,events})=>{
 await chmod(path.join(state,'.locks/models--private'),0o700);await rm(state,{recursive:true});
 const outside=path.join(dir,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep'),'unrelated');
 await symlink(outside,state,'dir');await writeFile(path.join(dir,'sporades.json'),JSON.stringify({name:'reset-contract',services:{}}));
 const result=command('dev');assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'unrelated');
 await assert.rejects(lstat(state),{code:'ENOENT'});
 assert(!(await events()).some(c=>c.args[0]==='run'));
}));

test('reset refuses a state directory replaced with a symlink before the helper mount',async()=>fixture(async({dir,credentials,command,events})=>{
 const outside=path.join(dir,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep'),'unrelated');
 const result=command('dev',{TEST_SWAP_STATE:outside});assert.equal(result.status,1);
 assert.equal(JSON.parse(await readFile(credentials,'utf8')).container,undefined);
 assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'unrelated');
 assert(!(await events()).some(c=>c.args[0]==='run'));
 const error=JSON.parse(result.stdout.trim().split('\n').at(-1)).error;assert.match(error.hint,/unsafe or changed/);assert(!error.hint.includes('Recovery command:'));
}));

test('reset verifies helper success without recursively deleting remaining foreign-owned state on the host',async()=>fixture(async({state,credentials,command})=>{
 const result=command('deploy',{TEST_HELPER_NOOP:'1'});assert.equal(result.status,1);
 assert.equal(JSON.parse(await readFile(credentials,'utf8')).container,undefined);
 assert.equal(await readFile(path.join(state,'.locks/models--private/cache'),'utf8'),'model cache');
 assert.match(JSON.parse(result.stdout.trim().split('\n').at(-1)).error.message,/reset incomplete/i);
}));

test('reset retains cleanup of declared state paths that have become regular files',async()=>fixture(async({state,credentials,command,events})=>{
 await chmod(path.join(state,'.locks/models--private'),0o700);await rm(state,{recursive:true});await writeFile(state,'damaged state');
 const result=command('dev');assert.equal(result.status,0,result.stdout+result.stderr);await assert.rejects(readFile(state),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(credentials,'utf8')).container,undefined);assert(!(await events()).some(c=>c.args[0]==='run'));
}));
