import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=path.join(root,'bin/sporades.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read) { const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(50);}throw new Error('Timed out waiting for Dev service probe'); }

test('Dev Jobs call declared service with stable generated auth; rebuilds preserve credentials and removing the last declaration stops services',{timeout:60000},async()=>{
 const dir=await mkdtemp(path.join(root,'.sporades-container-dev-'));
 let child,companion,output='',errors='';
 try {
  const env={...process.env,COMPOSE_PROJECT_NAME:'qa-unrelated',SPORADES_CONFIG_DIR:path.join(dir,'config')};
  const run=(args,cwd=dir)=>spawnSync(process.execPath,[cli,...args,'--json'],{cwd,env,encoding:'utf8',timeout:20000});
  let r=run(['create','capsule','--framework','vanilla','--template','todo','--no-install','--no-git']);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const project=path.join(dir,'capsule');
  const config=JSON.parse(await readFile(path.join(project,'sporades.json'),'utf8'));
  config.services={embeddings:{kind:'container',image:'example/embedding:v1',command:['--embeddings'],port:8080,health:{http:'/health'},env:{HF_TOKEN:{sealed:'HF_TOKEN'},API_KEY:{generated:'apiKey'}},compose:{tty:false,stdin_open:false,'x-note':{purpose:'reviewed'},logging:{driver:'json-file',options:{}},dns:'1.1.1.1',dns_search:'example.test',extra_hosts:['reviewed:127.0.0.1','ipv6:[::1]'],deploy:{resources:{limits:{pids:64}}},volumes:[{type:'volume',source:'cache',target:'/cache',volume:{nocopy:false}}]},elevated:['extra_hosts']}};
  await writeFile(path.join(project,'sporades.json'),JSON.stringify(config));
  const {ensureSealedServerEnvKeyPair,sealedServerEnvPaths,sealServerEnv,writeSealedServerEnv}=await import('../dist/sealed-server-env.js');
  const paths=sealedServerEnvPaths(project),pair=await ensureSealedServerEnvKeyPair(paths);
  await writeSealedServerEnv(paths,sealServerEnv({HF_TOKEN:'synthetic-hf-token',UNDECLARED:'synthetic-other-key'},pair.publicKey));
  let authorizedCalls=0;
  companion=createServer(async(req,res)=>{
   const saved=JSON.parse(await readFile(path.join(project,'.sporades/services/credentials.json'),'utf8'));
   assert.equal(req.headers.authorization,`Bearer ${saved.container.embeddings.apiKey}`);
   authorizedCalls++;
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{embedding:[0.25,0.5]}]}));
  });
  companion.listen(0,'127.0.0.1');await once(companion,'listening');
  const servicePort=companion.address().port;
  const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const devPort=portServer.address().port;await new Promise(r=>portServer.close(r));
  const fakeBin=path.join(dir,'fake-bin'),log=path.join(dir,'docker.jsonl');await mkdir(fakeBin);
  await writeFile(path.join(fakeBin,'docker'),`#!/usr/bin/env node
import {appendFileSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);appendFileSync(process.env.FAKE_CALLS,JSON.stringify(args)+'\\n');
if(args.includes('config')){
 if(process.env.SPORADES_COMPOSE_TEST_BINARY){const result=spawnSync(process.env.SPORADES_COMPOSE_TEST_BINARY,args.slice(1),{encoding:'utf8',env:process.env});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);}
 const raw=readFileSync(args[args.indexOf('-f')+1],'utf8');
 const model=JSON.parse(raw.replace(/\\$\\{(SPORADES_SVC_[A-Za-z0-9_]+):\\?\\}/g,(_m,k)=>process.env[k]??''));
 process.stdout.write(JSON.stringify(model));
}else if(args.includes('ps'))process.stdout.write(JSON.stringify({State:'running',Health:'healthy'}));
else if(args.includes('port'))process.stdout.write('127.0.0.1:'+process.env.FAKE_PORT);
`,{mode:0o755});
  await writeFile(path.join(fakeBin,'package.json'),'{"type":"module"}');
  const source=version=>`import {capsule,endpoint,job} from 'sporades/server';
export default capsule({name:'capsule',jobs:{embed:job(async ctx=>{const svc=ctx.services.embeddings;const response=await fetch(svc.url+'/v1/embeddings',{method:'POST',headers:{authorization:'Bearer '+svc.secrets.apiKey,'content-type':'application/json'},body:JSON.stringify({input:['probe']})});return response.json();})},endpoints:{ready:endpoint({method:'GET',path:'/ready'},ctx=>({body:{version:${version},declared:!!ctx.services.embeddings}})),start:endpoint({method:'POST',path:'/start'},async ctx=>({body:await ctx.jobs.enqueue('embed',{})}))}});`;
  await writeFile(path.join(project,'server/index.ts'),source(1));
  child=spawn(process.execPath,[cli,'dev','--port',String(devPort),'--json'],{cwd:project,env:{...env,PATH:fakeBin+path.delimiter+env.PATH,FAKE_PORT:String(servicePort),FAKE_CALLS:log},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  const ready=async expected=>until(async()=>{assert.equal(child.exitCode,null,output+errors);try{const res=await fetch(`http://127.0.0.1:${devPort}/ready`);const body=await res.json();return body.version===expected&&body;}catch{return null;}});
  assert.equal((await ready(1)).declared,true);
  const first=JSON.parse(await readFile(path.join(project,'.sporades/services/credentials.json'),'utf8')).container.embeddings.apiKey;
  const called=await fetch(`http://127.0.0.1:${devPort}/start`,{method:'POST'});assert.equal(called.status,200,await called.text());
  await until(()=>authorizedCalls>0);
  await writeFile(path.join(project,'server/index.ts'),source(2));
  await ready(2);
  const second=JSON.parse(await readFile(path.join(project,'.sporades/services/credentials.json'),'utf8')).container.embeddings.apiKey;
  assert.equal(first,second);
  assert(!output.includes(first));assert(!errors.includes(first));
  assert(!output.includes('synthetic-hf-token'));assert(!output.includes('synthetic-other-key'));
  config.services={};await writeFile(path.join(project,'sporades.json'),JSON.stringify(config));
  await until(async()=>{try{return !(await (await fetch(`http://127.0.0.1:${devPort}/ready`)).json()).declared;}catch{return false;}});
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  for(const args of calls.filter(args=>args[0]==='compose'))assert.equal(args[args.indexOf('-p')+1],'sporades-capsule-services');
  for(const action of ['config','up','ps','port','down'])assert(calls.some(args=>args[0]==='compose'&&args.includes(action)),action);
  assert(calls.some(args=>args.includes('down')&&args.includes('--remove-orphans')));
  assert(!calls.some(args=>args.includes('--force-recreate')));
 } finally {
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit',{signal:AbortSignal.timeout(10000)}).catch(()=>{});if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
  if(companion)await new Promise(r=>companion.close(r));
  await rm(dir,{recursive:true,force:true});
 }
});
