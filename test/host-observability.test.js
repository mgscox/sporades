import { createHostFixture, hostFixtureConfig, removeHostFixture } from './support/host-fixture-root.js';
import { withFixtureUmask } from './support/fixture-umask.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm,chmod,symlink,link} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {assertObservabilityResources,OBSERVABILITY_IMAGES,observabilityCompose,observabilityProject,observabilityDirectory,readObservabilityState,observabilityMonitorUnits,provisionObservability,renderObservabilityRoutes,observabilityUrls} from '../dist/cli/host-observability.js';
import {assertHostnamesAvailable} from '../dist/cli/host-domain-aliases.js';
import {unsealServerEnv,readSealedServerEnv,readKeyPair,sealedServerEnvPaths,ensureSealedServerEnvKeyPair,sealServerEnv,writeSealedServerEnv} from '../dist/sealed-server-env.js';
const run=promisify(execFile);
const root=process.cwd();
const cli=path.join(root,'bin/sporades.js');
const h=dir=>({alias:'local',domain:'ops.example.test',scheme:'https',remoteRoot:dir});
async function fixture(fn) {
 const dir=await createHostFixture('sporades-observe-',{privateAncestors:true});
 try {
  await withFixtureUmask(async()=>{
   await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
   await fn(dir);
  });
 } finally { await removeHostFixture(dir); }
}
function state(){return {version:1,enabled:true,ready:false,disclosed:false,secrets:Object.fromEntries(['database','umamiDatabase','django','app','errorsPassword','analyticsPassword','token'].map((n,i)=>[n,String(i).repeat(64)]))};}
test('observability resource refusal is bounded and fails closed for missing probes',()=>{
  assert.doesNotThrow(()=>assertObservabilityResources(2,2*1024**3,20*1024**3));
  for(const probes of [[1,2*1024**3,20*1024**3],[2,1024**3,20*1024**3],[2,2*1024**3,1024**3],[undefined,Infinity,NaN]])assert.throws(()=>assertObservabilityResources(...probes),/requires at least/);
});
test('pinned stack keeps databases private, logs bounded and identities isolated',()=>{
 const host=h('/srv/sporades'),compose=observabilityCompose(host,state());
 for(const service of Object.values(compose.services)){
  assert.ok(Object.values(OBSERVABILITY_IMAGES).includes(service.image));
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.equal(service.logging.options['max-file'],'3');
  for(const port of service.ports??[])assert.match(port,/^127\.0\.0\.1::/);
 }
 assert.equal(compose.services['errors-db'].ports,undefined);
 assert.equal(compose.services['analytics-db'].ports,undefined);
 assert.equal(compose.services.web.environment.ENABLE_USER_REGISTRATION,'false');
 assert.equal(compose.services.web.environment.CSRF_TRUSTED_ORIGINS,'https://errors.ops.example.test');
 assert.equal(compose.services.web.environment.ALLOWED_HOSTS,'errors.ops.example.test,127.0.0.1');
 assert.notEqual(observabilityProject(host),observabilityProject({...host,remoteRoot:'/srv/other'}));
 const units=observabilityMonitorUnits({...host,remoteRoot:'/srv/host$unit%'});
 assert.match(units.service,/host\$\$unit%%/);assert.match(units.timer,/OnUnitActiveSec=60/);
 assert.doesNotMatch(units.service,/password|token/);
});
test('protected state rejects readable secrets, symbolic links and malformed values',()=>fixture(async dir=>{
 const host=h(dir),directory=observabilityDirectory(host);await mkdir(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,'secrets.json');await writeFile(file,JSON.stringify(state()),{mode:0o600});
 assert.equal((await readObservabilityState(host)).ready,false);
 await chmod(file,0o644);await assert.rejects(readObservabilityState(host),/private/);
 await chmod(file,0o600);await writeFile(file,'{"token":"sensitive-value"');await assert.rejects(readObservabilityState(host),e=>!e.message.includes('sensitive-value'));
 await rm(file);await symlink(path.join(dir,'elsewhere'),file);await assert.rejects(readObservabilityState(host),/Unsafe/);
}));
test('pending or disabled service installs reserve both domains across Hosted domains',()=>fixture(async dir=>{
 const host=h(dir),directory=observabilityDirectory(host);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'secrets.json'),JSON.stringify({...state(),enabled:false}));
 for(const domain of ['errors.ops.example.test','analytics.ops.example.test'])await assert.rejects(assertHostnamesAvailable(dir,[domain],'other/capsule'),/reserved/);
 await assertHostnamesAvailable(dir,['errors.ops.example.test','analytics.ops.example.test'],'observability:ops.example.test');
 await assertHostnamesAvailable(dir,['unrelated.ops.example.test'],'other/capsule');
}));
test('unconfigured provisioning is inert',()=>fixture(async dir=>{
 assert.equal((await provisionObservability(h(dir),{})).connected,false);
}));
const capsuleSlug='capsule-b197d192cbb5479bbbf8302af227700d';
const capsuleRoute=`/api/0/projects/sporades/${capsuleSlug}/`;
async function provisioningFixture(t,fn){
 await fixture(async dir=>{
  const host=h(dir),directory=observabilityDirectory(host);
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(directory,'secrets.json'),JSON.stringify({...state(),ready:true}),{mode:0o600});
  const tools=path.join(dir,'tools');await mkdir(tools);
  await writeFile(path.join(tools,'docker'),'#!/bin/sh\nprintf "127.0.0.1:5203\\n"\n',{mode:0o755});
  const previousPath=process.env.PATH;process.env.PATH=`${tools}${path.delimiter}${previousPath}`;
  const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const target={domain:'capsules.example.test',subname:'test',errors:true,analytics:false,publicKey:pair.publicKey};
  const requests=[];
  const respond=handler=>t.mock.method(globalThis,'fetch',async(url,options)=>{
   const request={route:new URL(url).pathname,method:options.method,body:options.body?JSON.parse(options.body):undefined};
   requests.push(request);return handler(request);
  });
  try{await fn({host,target,pair,requests,respond});}
  finally{t.mock.restoreAll();process.env.PATH=previousPath;}
 });
}
test('GlitchTip creates its deterministic identity before naming it for the Capsule Hosted domain',t=>provisioningFixture(t,async({host,target,pair,requests,respond})=>{
 let project=null;
 const keys=[{dsn:{public:'http://0123456789abcdef0123456789abcdef@127.0.0.1/42'}}];
 respond(request=>{
  if(request.method==='POST'){
   assert.equal(request.route,'/api/0/teams/sporades/capsules/projects/');
   assert.deepEqual(request.body,{name:capsuleSlug,slug:capsuleSlug,platform:'node'});
   project={id:'42',name:capsuleSlug,slug:capsuleSlug};
  }else if(request.method==='PUT'){
   assert.equal(request.route,capsuleRoute);
   assert.deepEqual(request.body,{name:'test.capsules.example.test',slug:capsuleSlug});
   project={...project,...request.body};
  }else if(request.route===capsuleRoute+'keys/')return Response.json(keys);
  return project?Response.json(project):new Response(null,{status:404});
 });
 const first=unsealServerEnv((await provisionObservability(host,target)).env,pair.privateKey);
 assert.equal(project.name,'test.capsules.example.test');
 assert.equal(project.slug,capsuleSlug);assert.equal(project.id,'42');
 assert.equal(first.ERROR_DSN,'https://0123456789abcdef0123456789abcdef@errors.ops.example.test/42');
 assert.deepEqual(unsealServerEnv((await provisionObservability(host,target)).env,pair.privateKey),first);
 assert.equal(requests.filter(r=>r.method==='POST').length,1);
 assert.equal(requests.filter(r=>r.method==='PUT').length,1);
}));
test('GlitchTip retries an interrupted rename on the existing hashed default without creating or rotating keys',t=>provisioningFixture(t,async({host,target,requests,respond})=>{
 let project={id:'42',name:capsuleSlug,slug:capsuleSlug},interrupted=true;
 respond(request=>{
  if(request.method==='PUT'){
   if(interrupted){interrupted=false;return new Response('private-provider-marker',{status:503});}
   project={...project,...request.body};
  }
  if(request.route===capsuleRoute+'keys/')return Response.json([{dsn:{public:'http://0123456789abcdef0123456789abcdef@127.0.0.1/42'}}]);
  return Response.json(project);
 });
 await assert.rejects(provisionObservability(host,target),error=>error.message==='Host observability operation failed.'&&!JSON.stringify(error).includes('private-provider-marker'));
 assert.equal(project.name,capsuleSlug);
 await provisionObservability(host,target);
 assert.deepEqual(project,{id:'42',name:'test.capsules.example.test',slug:capsuleSlug});
 assert.equal(requests.filter(r=>r.method==='POST').length,0);
 assert.equal(requests.filter(r=>r.route.endsWith('/keys/')).length,1);
}));
for(const name of ['Operator project name','test.capsules.example.test','capsule-00000000000000000000000000000000'])test(`GlitchTip retains existing nondefault name ${name}`,t=>provisioningFixture(t,async({host,target,requests,respond})=>{
 respond(request=>Response.json(request.route.endsWith('/keys/')?[{dsn:{public:'http://0123456789abcdef0123456789abcdef@127.0.0.1/42'}}]:{id:'42',name,slug:capsuleSlug}));
 await provisionObservability(host,target);
 assert.ok(requests.every(r=>r.method==='GET'));
}));
for(const phase of ['lookup','create','rename'])for(const [reason,change] of [
 ['wrong slug',{slug:'private-provider-marker'}],['invalid ID',{id:null}],['missing name',{name:null}],
 ...(phase==='lookup'?[]:[['unexpected name',{name:'private-provider-marker'}]]),
 ...(phase==='rename'?[['changed ID',{id:'99'}]]:[]),
])test(`GlitchTip fails closed on ${reason} during ${phase}`,t=>provisioningFixture(t,async({host,target,requests,respond})=>{
 respond(request=>{
  if(phase==='create'&&request.method==='GET')return new Response(null,{status:404});
  const expected={id:'42',name:request.method==='PUT'?'test.capsules.example.test':capsuleSlug,slug:capsuleSlug};
  return Response.json((phase==='lookup'||phase==='create'||request.method==='PUT')?{...expected,...change}:expected);
 });
 await assert.rejects(provisionObservability(host,{...target,analytics:true}),error=>error.message==='Host observability operation failed.'&&!JSON.stringify(error).includes('private-provider-marker'));
 assert.equal(requests.some(r=>r.route.endsWith('/keys/')||r.route.startsWith('/api/auth/')),false);
 assert.equal(requests.filter(r=>r.method==='POST').length,phase==='create'?1:0);
}));
test('GlitchTip limits only the readable name to its pinned API maximum',t=>provisioningFixture(t,async({host,target,respond})=>{
 const subname='a'.repeat(63),identity=`${subname}.capsules.example.test`;
 let project;
 respond(request=>{
  if(request.method==='POST')project={id:'42',name:request.body.name,slug:request.body.slug};
  if(request.method==='PUT'){
   assert.equal(request.body.name,'a'.repeat(63)+'.');
   assert.equal(request.body.slug,project.slug);
   project={...project,...request.body};
  }
  if(request.route.endsWith('/keys/'))return Response.json([{dsn:{public:'http://0123456789abcdef0123456789abcdef@127.0.0.1/42'}}]);
  return project?Response.json(project):new Response(null,{status:404});
 });
 const result=await provisionObservability(host,{...target,subname});
 assert.equal(result.identity,identity);
 assert.equal(project.name.length,64);
}));
test('GlitchTip rejects a null successful lookup instead of treating it as a missing project',t=>provisioningFixture(t,async({host,target,requests,respond})=>{
 respond(()=>Response.json(null));
 await assert.rejects(provisionObservability(host,target),/Host observability operation failed/);
 assert.equal(requests.length,1);
}));
test('GlitchTip refuses a key for another project without changing provider state',t=>provisioningFixture(t,async({host,target,requests,respond})=>{
 respond(request=>Response.json(request.route.endsWith('/keys/')?[{dsn:{public:'http://0123456789abcdef0123456789abcdef@127.0.0.1/99'}}]:{id:'42',name:'Operator name',slug:capsuleSlug}));
 await assert.rejects(provisionObservability(host,target),/Host observability operation failed/);
 assert.ok(requests.every(r=>r.method==='GET'));
}));
test('Umami retains its successful null lookup contract for a missing website',t=>provisioningFixture(t,async({host,target,pair,requests,respond})=>{
 respond(request=>{
  if(request.route==='/api/auth/login')return Response.json({token:'synthetic-umami-token'});
  if(request.method==='GET')return Response.json(null);
  return Response.json(request.body);
 });
 const values=unsealServerEnv((await provisionObservability(host,{...target,errors:false,analytics:true})).env,pair.privateKey);
 assert.equal(values.ANALYTICS_ENDPOINT,'https://analytics.ops.example.test/api/send');
 assert.equal(values.ANALYTICS_WEBSITE_ID,'b197d192-cbb5-479b-abf8-302af227700d');
 assert.deepEqual(requests.at(-1).body,{id:values.ANALYTICS_WEBSITE_ID,name:'test.capsules.example.test',domain:'test.capsules.example.test'});
}));
test('a protected public analytics domain owns the direct route and service URLs',()=>fixture(async dir=>{
 const host=h(dir),directory=observabilityDirectory(host);await mkdir(directory,{recursive:true,mode:0o700});
 await writeFile(path.join(directory,'secrets.json'),JSON.stringify({...state(),enabled:false}),{mode:0o600});
 await writeFile(path.join(directory,'public.json'),JSON.stringify({version:1,analyticsDomain:'analytics.kimatt.test'}),{mode:0o600});
 const routes=await renderObservabilityRoutes(host,{errors:51231,analytics:51232});
 assert.match(routes,/analytics\.kimatt\.test \{\n  reverse_proxy 127\.0\.0\.1:51232/);
 assert.doesNotMatch(routes,/analytics\.ops\.example\.test|header_up|tls_server_name/);
 assert.equal((await observabilityUrls(host)).analytics,'https://analytics.kimatt.test');
 await assert.rejects(assertHostnamesAvailable(dir,['analytics.kimatt.test'],'other/capsule'),/reserved/);
 await assertHostnamesAvailable(dir,['analytics.kimatt.test'],'observability:ops.example.test');
 assert.match(await renderObservabilityRoutes(host,null),/analytics\.kimatt\.test \{\n  respond "Service disabled" 503/);
 assert.equal(JSON.parse(await readFile(path.join(directory,'public.json'),'utf8')).analyticsDomain,'analytics.kimatt.test');
 const applied=path.join(dir,'caddy/hosts/ops.example.test/__sporades-observability.caddy');
 await mkdir(path.dirname(applied),{recursive:true});await writeFile(applied,routes);
 await writeFile(path.join(directory,'public.json'),JSON.stringify({version:1,analyticsDomain:'analytics.next.test'}));
 for(const name of ['analytics.kimatt.test','analytics.next.test'])await assert.rejects(assertHostnamesAvailable(dir,[name],'other/capsule'),/reserved/);
 await writeFile(applied,await renderObservabilityRoutes(host,null));
 await assertHostnamesAvailable(dir,['analytics.kimatt.test'],'other/capsule');
}));
test('public analytics configuration rejects unsafe files and invalid exact hostnames',()=>fixture(async dir=>{
 const host=h(dir),directory=observabilityDirectory(host);await mkdir(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,'public.json');
 assert.equal((await observabilityUrls(host)).analytics,'https://analytics.ops.example.test');
 for(const value of [null,[],{version:2,analyticsDomain:'analytics.example.test'},{version:1,analyticsDomain:'https://analytics.example.test'},
  {version:1,analyticsDomain:'*.example.test'},{version:1,analyticsDomain:'127.0.0.1'},
  {version:1,analyticsDomain:'analytics.example.test\nmalicious'},{version:1,analyticsDomain:'analytics.example.test',extra:'private-marker'}]){
  await writeFile(file,JSON.stringify(value),{mode:0o600});
  await assert.rejects(renderObservabilityRoutes(host,null),error=>/Invalid Host observability public configuration/.test(error.message)&&!JSON.stringify(error).includes('private-marker'));
 }
 const valid=JSON.stringify({version:1,analyticsDomain:'analytics.kimatt.test'});
 await writeFile(file,valid);await chmod(file,0o644);
 await assert.rejects(renderObservabilityRoutes(host,null),/Invalid Host observability public configuration/);
 await rm(file);const other=path.join(directory,'other.json');await writeFile(other,valid,{mode:0o600});await symlink(other,file);
 await assert.rejects(renderObservabilityRoutes(host,null),/Invalid Host observability public configuration/);
 await rm(file);await link(other,file);
 await assert.rejects(renderObservabilityRoutes(host,null),/Invalid Host observability public configuration/);
}));
test('Umami public domain preserves authenticated same-origin requests through Caddy',{
 skip:process.env.SPORADES_REAL_OBSERVABILITY_CADDY!=='1'?'Set SPORADES_REAL_OBSERVABILITY_CADDY=1 for isolated Docker proxy emulation.':false,timeout:120000,
},()=>fixture(async dir=>{
 const host=h(dir),directory=observabilityDirectory(host);await mkdir(directory,{recursive:true,mode:0o700});
 await writeFile(path.join(directory,'public.json'),JSON.stringify({version:1,analyticsDomain:'analytics.kimatt.test'}),{mode:0o600});
 const config=path.join(dir,'Caddyfile');
 const routes=(await renderObservabilityRoutes(host,{errors:4000,analytics:4000}))
  .replace('errors.ops.example.test {','http://errors.ops.example.test:18081 {')
  .replace('analytics.kimatt.test {','http://analytics.kimatt.test:18080 {');
 await writeFile(config,'{\n admin off\n auto_https off\n}\n'+routes);
 const id=`sporades-umami-origin-${process.pid}`,backend=id+'-backend',proxy=id+'-proxy',seed=id+'-seed';
 const docker=async args=>(await run('docker',args,{timeout:30000})).stdout;
 try{
  await docker(['network','create','--internal',id]);
  await docker(['volume','create',id]);
  await docker(['create','--name',seed,'--network','none','--volume',id+':/fixture','--entrypoint','true','node:24.22.1-bookworm-slim']);
  await docker(['cp',path.join(root,'test/support/umami-origin-emulator.mjs'),seed+':/fixture/emulator.mjs']);
  await docker(['cp',config,seed+':/fixture/Caddyfile']);
  await docker(['create','--name',backend,'--network',id,'--read-only','--volume',id+':/fixture:ro','--cpus','1','--memory','256m','--pids-limit','64','-p','127.0.0.1::18080','--entrypoint','node','node:24.22.1-bookworm-slim','/fixture/emulator.mjs']);
  await docker(['start',backend]);
  await docker(['create','--name',proxy,'--network','container:'+backend,'--read-only','--volume',id+':/fixture:ro','--cpus','1','--memory','128m','--pids-limit','64','--tmpfs','/data','--tmpfs','/config','--entrypoint','caddy','caddy:2.10.2-alpine','run','--config','/fixture/Caddyfile','--adapter','caddyfile']);
  await docker(['start',proxy]);
  const result=JSON.parse(await docker(['exec',backend,'node','/fixture/emulator.mjs','probe']));
  assert.ok(Object.values(result).every(value=>value===true),JSON.stringify(result));
 }finally{
  await docker(['rm','-f',proxy,backend,seed]).catch(()=>{});
  await docker(['network','rm',id]).catch(()=>{});
  await docker(['volume','rm',id]).catch(()=>{});
 }
}));
test('CLI registration and dedicated ops connect seal custom env names without disclosing provider values',()=>fixture(async dir=>{
 const env={...process.env,SPORADES_CONFIG_DIR:hostFixtureConfig(dir)};
 const fake=path.join(dir,'tools');await mkdir(fake);
 const ledger=path.join(dir,'requests.jsonl');
 const values={ERROR_DSN:'https://abcdef@errors.ops.example.test/42',ANALYTICS_ENDPOINT:'https://analytics.ops.example.test/api/send',ANALYTICS_WEBSITE_ID:'11111111-1111-4111-a111-111111111111'};
 await writeFile(path.join(fake,'ssh'),`#!/usr/bin/env node\nimport fs from 'node:fs';\nimport {sealServerEnv} from ${JSON.stringify(pathToFileURL(path.join(root,'dist/sealed-server-env.js')).href)};\nlet input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input);fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(r)+'\\n');let data={registered:true,capsule:{subname:r.capsule?.subname,aliasDomains:r.registration?.aliasDomains,canonicalDomain:r.registration?.canonicalDomain,publicOrigin:r.registration?.canonicalDomain?'https://'+r.registration.canonicalDomain:undefined}};if(r.action==='host.services.connect')data={connected:true,env:sealServerEnv(${JSON.stringify(values)},r.services.publicKey)};process.stdout.write(JSON.stringify({ok:true,data,error:null}));\n`,{mode:0o755});
 env.PATH=`${fake}${path.delimiter}${process.env.PATH}`;
 const invoke=async(args,cwd=dir)=>JSON.parse((await run(process.execPath,[cli,...args],{cwd,env})).stdout);
 await invoke(['create','capsule','--no-install','--no-git','--json']);
 const project=path.join(dir,'capsule');const file=path.join(project,'sporades.json');const config=JSON.parse(await readFile(file,'utf8'));
 config.observability={errors:{protocol:'sentry',dsnEnv:'CUSTOM_DSN'}};config.analytics={provider:'umami',endpointEnv:'CUSTOM_ENDPOINT',websiteIdEnv:'CUSTOM_SITE'};
 await writeFile(file,JSON.stringify(config));
 for(const [alias,domain] of [['app','apps.example.test'],['ops','ops.example.test']])await invoke(['host','add',alias,'--server',`${alias}@fake.invalid`,'--domain',domain,'--json']);
 const registration=await invoke(['host','register','hello','--host','app','--on','ops','--alias-domain','alias.example.test','--canonical-domain','canonical.example.test','--json'],project);
 assert.equal(registration.data.observability.connected,true);
 assert.doesNotMatch(JSON.stringify(registration),/abcdef|11111111/);
 const paths=sealedServerEnvPaths(project),pair=await readKeyPair(paths);
 const sealed=unsealServerEnv(await readSealedServerEnv(paths),pair.privateKey);
 assert.deepEqual(sealed,{CUSTOM_DSN:values.ERROR_DSN,CUSTOM_ENDPOINT:values.ANALYTICS_ENDPOINT,CUSTOM_SITE:values.ANALYTICS_WEBSITE_ID});
 const connection=await invoke(['host','services','connect','hello','--host','app','--on','ops','--json'],project);
 assert.equal(connection.data.pushRequired,true);
 const requests=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(requests.some(r=>r.action==='capsule.stats'&&r.host.domain==='apps.example.test'));
 assert.equal(requests.find(r=>r.action==='capsule.register').registration.canonicalDomain,'canonical.example.test');
 for(const r of requests.filter(r=>r.action==='host.services.connect')){assert.equal(r.host.domain,'ops.example.test');assert.equal(r.services.domain,'apps.example.test');assert.equal(r.services.subname,'hello');}
 // External env selection is never silently overwritten by registration.
 config.observability.errors.dsnEnv='SPORADES_SECRET';await writeFile(file,JSON.stringify(config));
 const rejected=await run(process.execPath,[cli,'host','services','connect','hello','--host','app','--on','ops','--json'],{cwd:project,env}).then(()=>null,e=>e);
 assert.ok(rejected);
}));
test('CLI registration preserves external provider env without contacting unavailable Host services',async t=>{
 for(const [name,values,on] of [
  ['external error DSN',{CUSTOM_DSN:'https://external-key@errors.external.example/7',OTHER_SECRET:'preserved'},[]],
  ['external analytics endpoint',{CUSTOM_ENDPOINT:'https://analytics.external.example/api/send',OTHER_SECRET:'preserved'},['--on','ops']],
  ['external analytics website',{CUSTOM_SITE:'22222222-2222-4222-a222-222222222222',OTHER_SECRET:'preserved'},['--on','ops']],
 ])await t.test(name,()=>fixture(async dir=>{
  const env={...process.env,SPORADES_CONFIG_DIR:hostFixtureConfig(dir)};
  const fake=path.join(dir,'tools');await mkdir(fake);
  const ledger=path.join(dir,'requests.jsonl');
  await writeFile(path.join(fake,'ssh'),`#!/usr/bin/env node\nimport fs from 'node:fs';\nlet input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input);fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(r)+'\\n');process.stdout.write(JSON.stringify(r.action==='host.services.connect'?{ok:false,data:null,error:{message:'Host observability operation failed',hint:'Disposable services are unavailable.'}}:{ok:true,data:{registered:true,capsule:{subname:r.capsule?.subname}},error:null}));\n`,{mode:0o755});
  env.PATH=`${fake}${path.delimiter}${process.env.PATH}`;
  const invoke=async(args,cwd=dir)=>JSON.parse((await run(process.execPath,[cli,...args],{cwd,env})).stdout);
  await invoke(['create','capsule','--no-install','--no-git','--json']);
  const project=path.join(dir,'capsule'),file=path.join(project,'sporades.json');
  const config=JSON.parse(await readFile(file,'utf8'));
  config.observability={errors:{protocol:'sentry',dsnEnv:'CUSTOM_DSN'}};
  config.analytics={provider:'umami',endpointEnv:'CUSTOM_ENDPOINT',websiteIdEnv:'CUSTOM_SITE'};
  await writeFile(file,JSON.stringify(config));
  for(const [alias,domain] of [['app','apps.example.test'],['ops','ops.example.test']])await invoke(['host','add',alias,'--server',`${alias}@fake.invalid`,'--domain',domain,'--json']);
  const paths=sealedServerEnvPaths(project),pair=await ensureSealedServerEnvKeyPair(paths);
  await writeSealedServerEnv(paths,sealServerEnv(values,pair.publicKey,{source:'import'}));
  const before=await readFile(paths.envelope,'utf8');
  const registration=await invoke(['host','register','hello','--host','app',...on,'--json'],project);
  assert.equal(registration.ok,true);
  assert.equal(registration.data.registered,true);
  assert.deepEqual(registration.data.observability,{connected:false,reason:'existing-provider-env'});
  assert.equal(await readFile(paths.envelope,'utf8'),before);
  assert.deepEqual(unsealServerEnv(await readSealedServerEnv(paths),pair.privateKey),values);
  const requests=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.action==='capsule.register'));
  assert.ok(!requests.some(r=>r.action==='host.services.connect'));
  // Explicit connect still reports service failures instead of hiding them.
  await assert.rejects(invoke(['host','services','connect','hello','--host','app',...on,'--json'],project),error=>{
   assert.equal(JSON.parse(error.stdout).error.message,'Host observability operation failed');return true;
  });
  assert.equal(await readFile(paths.envelope,'utf8'),before);
 }));
});
test('real pinned observability providers acceptance', {skip:process.env.SPORADES_REAL_OBSERVABILITY_DOCKER!=='1'?'Set SPORADES_REAL_OBSERVABILITY_DOCKER=1 for disposable local Docker coverage.':false,timeout:900_000}, async()=>{
 await run(process.execPath,['scripts/verify-host-observability.mjs'],{timeout:890_000,maxBuffer:2*1024*1024});
});

test('observability monitor reconciles only managed units and refuses symlink replacement',()=>fixture(async dir=>{
 const {installObservabilityMonitor}=await import('../dist/cli/host-observability.js');
 const host=h(dir),bin=path.join(dir,'bin'),units=path.join(dir,'units'),tools=path.join(dir,'tools');
 for(const folder of [bin,units,tools])await mkdir(folder,{mode:0o700});
 await writeFile(path.join(bin,'sporades-host-helper'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const calls=path.join(dir,'systemctl-calls');
 await writeFile(path.join(tools,'systemctl'),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=`${tools}${path.delimiter}${old}`;
 try{
  await installObservabilityMonitor(host,true,units);
  const name=observabilityMonitorUnits(host).name;
  const service=path.join(units,`${name}.service`),timer=path.join(units,`${name}.timer`);
  const original=await readFile(service,'utf8');
  await installObservabilityMonitor(host,true,units);
  assert.equal(await readFile(service,'utf8'),original);
  await installObservabilityMonitor(host,false,units);
  assert.match(await readFile(calls,'utf8'),new RegExp(`disable --now ${name}.timer`));
  await writeFile(timer,'# Operator unit\n');
  await assert.rejects(installObservabilityMonitor(host,true,units),/operator-owned/);
  await rm(timer);await symlink(service,timer);
  await assert.rejects(installObservabilityMonitor(host,true,units),/Unsafe/);
 }finally{process.env.PATH=old;}
}));

test('observability alert catches failed/stale health, suppresses disabled services and clears on recovery',{
 skip:process.env.SPORADES_REAL_PROMTOOL!=='1'&&!process.env.SPORADES_PROMTOOL_BIN?'Set SPORADES_REAL_PROMTOOL=1 or SPORADES_PROMTOOL_BIN for rule evaluation.':false,
 timeout:90_000,
},async()=>{
 const local=process.env.SPORADES_PROMTOOL_BIN;
 const image=(await readFile(path.join(root,'monitoring/trace/compose.yaml'),'utf8')).match(/image: (prom\/prometheus:\S+)/)[1];
 const args=['test','rules','test/fixtures/host-observability-rules.test.yaml'];
 const result=spawnSync(local||'docker',local?args:['run','--rm','--name',`sporades-ken-observability-rules-${process.pid}`,'--network','none','--mount',`type=bind,source=${root},target=/workspace,readonly`,'--workdir','/workspace','--entrypoint','/bin/promtool',image,...args],{cwd:root,encoding:'utf8',timeout:80_000});
 assert.equal(result.status,0,`${result.error??''}\n${result.stdout}\n${result.stderr}`);
});

test('Caddy imports observability routes through the managed glob with automatic TLS and disabled 503s',{
 skip:process.env.SPORADES_REAL_OBSERVABILITY_CADDY!=='1'?'Set SPORADES_REAL_OBSERVABILITY_CADDY=1 for disposable Docker Caddy adaptation.':false,
 timeout:120_000,
},()=>fixture(async dir=>{
 const {renderObservabilityRoutes,OBSERVABILITY_ROUTE_FILE}=await import('../dist/cli/host-observability.js');
 await writeFile(path.join(dir,'Caddyfile'),`{\n admin off\n}\nimport /fixture/*.caddy\n`);
 for(const ports of [{errors:52281,analytics:52282},null]){
  await writeFile(path.join(dir,OBSERVABILITY_ROUTE_FILE),await renderObservabilityRoutes(h(dir),ports));
  const result=spawnSync('docker',['run','--rm','--name',`sporades-ken-observability-caddy-${process.pid}`,'--network','none','--mount',`type=bind,source=${dir},target=/fixture,readonly`,'caddy:2.10.2-alpine','caddy','adapt','--config','/fixture/Caddyfile','--adapter','caddyfile'],{encoding:'utf8',timeout:55_000});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.stringify(JSON.parse(result.stdout));
  assert.match(config,/errors\.ops\.example\.test/);assert.match(config,/analytics\.ops\.example\.test/);
  if(ports){assert.match(config,/127\.0\.0\.1:52281/);assert.match(config,/127\.0\.0\.1:52282/);}
  else{assert.match(config,/"status_code":503/);assert.doesNotMatch(config,/reverse_proxy/);}
 }
}));

test('shipped helper dispatch keeps dormant services inert and rejects an unretained Host lock',()=>fixture(async dir=>{
 const remoteRoot=path.join(dir,'host');
 const request={action:'host.services.status',host:h(remoteRoot)};
 const env={...process.env,SPORADES_CONFIG_DIR:hostFixtureConfig(dir),SPORADES_TEST_FLOCK_PATH:path.join(root,'test/support/exec-flock.py')};
 const helper=path.join(root,'bin/sporades-host-helper.js');
 const invoke=extra=>JSON.parse(spawnSync(process.execPath,[helper],{input:JSON.stringify(request),env:{...env,...extra},encoding:'utf8'}).stdout);
 const dormant=invoke({});assert.equal(dormant.ok,true);assert.deepEqual(dormant.data,{installed:false,enabled:false});
 const spoofed=invoke({SPORADES_HOST_GLOBAL_ROUTE_LOCK_FILE:path.join(remoteRoot,'bin','.sporades-host-helper.host-route.lock')});
 assert.equal(spoofed.ok,false);assert.match(spoofed.error.message,/lock identity was not retained/);
}));
