import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundleServerCapsuleModule} from '../dist/bundle-pipeline.js';
import {createServerBundleModuleSource} from '../dist/templates/server-bundle-module-graph.js';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const session of ['dev','container'])test(`generated ${session} Bundle receives frozen services solely through launch env`,{timeout:30000},async()=>{
 const dir=await mkdtemp(path.join(root,'.sporades-container-bundle-'));
 let child;
 try{
  const serverSource=`import {capsule,endpoint} from 'sporades/server';
export default capsule({name:'bundle-service',endpoints:{probe:endpoint({method:'GET',path:'/service-probe',session:'none'},ctx=>({body:{local:ctx.services.embeddings.url.includes('127.0.0.1'),frozen:Object.isFrozen(ctx.services)&&Object.isFrozen(ctx.services.embeddings)&&Object.isFrozen(ctx.services.embeddings.secrets),keyLength:ctx.services.embeddings.secrets.apiKey.length,unknown:ctx.services.unknown===undefined}}))}});`;
  const serverModuleSource=await bundleServerCapsuleModule({serverSource,serverSourcePath:path.join(dir,'server/index.ts')});
  const config={name:'bundle-service',services:{embeddings:{kind:'container',image:'example:v1',command:[],port:8080,health:{tcp:true},env:{KEY:{generated:'apiKey'}}}}};
  const source=await createServerBundleModuleSource({config,serverEnv:{},serverSource,serverModuleSource,epilogue:'process.stdout.write(JSON.stringify({listening:server.address().port})+"\\n");'});
  const key='b'.repeat(64),url=session==='dev'?'http://127.0.0.1:5204':'http://sporades-bundle-service-embeddings:8080';
  assert(!source.includes(key));assert(!source.includes('127.0.0.1:5204'));
  const entry=path.join(dir,'server.mjs');await writeFile(entry,source);
  const env={...process.env,PORT:'0',SPORADES_SECURITY_SESSION:session,SPORADES_CONFIG_DIR:path.join(dir,'config'),SPORADES_DATABASE_PATH:path.join(dir,'data.db'),SPORADES_CONTAINER_SERVICES:JSON.stringify({embeddings:{url,secrets:{apiKey:key}}})};
  let output='',errors='';child=spawn(process.execPath,[entry],{cwd:dir,env});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  let port;const deadline=Date.now()+15000;
  while(!port&&Date.now()<deadline){assert.equal(child.exitCode,null,output+errors);port=output.split('\n').map(line=>{try{return JSON.parse(line).listening;}catch{return null;}}).find(Boolean);if(!port)await new Promise(r=>setTimeout(r,30));}
  assert(port,output+errors);
  const response=await fetch(`http://127.0.0.1:${port}/service-probe`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{local:session==='dev',frozen:true,keyLength:64,unknown:true});
  const inspected=spawnSync(process.execPath,[entry,'--sporades-action','jobs.inspect'],{cwd:dir,env,encoding:'utf8',timeout:10000});
  assert.equal(inspected.status,0,inspected.stdout+inspected.stderr);
  assert(!inspected.stdout.includes(key));assert(!inspected.stdout.includes(url));assert(!output.includes(key));assert(!errors.includes(key));
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit',{signal:AbortSignal.timeout(10000)}).catch(()=>{});if(child.exitCode===null)child.kill('SIGKILL');}await rm(dir,{recursive:true,force:true});}
});
