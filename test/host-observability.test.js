import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertObservabilityResources,OBSERVABILITY_IMAGES,observabilityCompose,observabilityProject,observabilityDirectory,readObservabilityState,observabilityMonitorUnits,provisionObservability} from '../dist/cli/host-observability.js';
import {assertHostnamesAvailable} from '../dist/cli/host-domain-aliases.js';
import {unsealServerEnv,readSealedServerEnv,readKeyPair,sealedServerEnvPaths} from '../dist/sealed-server-env.js';
const run=promisify(execFile);
const root=process.cwd();
const cli=path.join(root,'bin/sporades.js');
const h=dir=>({alias:'local',domain:'ops.example.test',scheme:'https',remoteRoot:dir});
async function fixture(fn){await mkdir(path.join(root,'.sporades'),{recursive:true}); const dir=await mkdtemp(path.join(root,'.sporades/observe-test-'));try{await fn(dir);}finally{await rm(dir,{force:true,recursive:true});}}
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
test('CLI registration and dedicated ops connect seal custom env names without disclosing provider values',()=>fixture(async dir=>{
 const env={...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config')};
 const fake=path.join(dir,'tools');await mkdir(fake);
 const ledger=path.join(dir,'requests.jsonl');
 const values={ERROR_DSN:'https://abcdef@errors.ops.example.test/42',ANALYTICS_ENDPOINT:'https://analytics.ops.example.test/api/send',ANALYTICS_WEBSITE_ID:'11111111-1111-4111-a111-111111111111'};
 await writeFile(path.join(fake,'ssh'),`#!/usr/bin/env node\nimport fs from 'node:fs';\nimport {sealServerEnv} from ${JSON.stringify(pathToFileURL(path.join(root,'dist/sealed-server-env.js')).href)};\nlet input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input);fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(r)+'\\n');let data={registered:true,capsule:{subname:r.capsule?.subname}};if(r.action==='host.services.connect')data={connected:true,env:sealServerEnv(${JSON.stringify(values)},r.services.publicKey)};process.stdout.write(JSON.stringify({ok:true,data,error:null}));\n`,{mode:0o755});
 env.PATH=`${fake}${path.delimiter}${process.env.PATH}`;
 const invoke=async(args,cwd=dir)=>JSON.parse((await run(process.execPath,[cli,...args],{cwd,env})).stdout);
 await invoke(['create','capsule','--no-install','--no-git','--json']);
 const project=path.join(dir,'capsule');const file=path.join(project,'sporades.json');const config=JSON.parse(await readFile(file,'utf8'));
 config.observability={errors:{protocol:'sentry',dsnEnv:'CUSTOM_DSN'}};config.analytics={provider:'umami',endpointEnv:'CUSTOM_ENDPOINT',websiteIdEnv:'CUSTOM_SITE'};
 await writeFile(file,JSON.stringify(config));
 for(const [alias,domain] of [['app','apps.example.test'],['ops','ops.example.test']])await invoke(['host','add',alias,'--server',`${alias}@fake.invalid`,'--domain',domain,'--json']);
 const registration=await invoke(['host','register','hello','--host','app','--on','ops','--json'],project);
 assert.equal(registration.data.observability.connected,true);
 assert.doesNotMatch(JSON.stringify(registration),/abcdef|11111111/);
 const paths=sealedServerEnvPaths(project),pair=await readKeyPair(paths);
 const sealed=unsealServerEnv(await readSealedServerEnv(paths),pair.privateKey);
 assert.deepEqual(sealed,{CUSTOM_DSN:values.ERROR_DSN,CUSTOM_ENDPOINT:values.ANALYTICS_ENDPOINT,CUSTOM_SITE:values.ANALYTICS_WEBSITE_ID});
 const connection=await invoke(['host','services','connect','hello','--host','app','--on','ops','--json'],project);
 assert.equal(connection.data.pushRequired,true);
 const requests=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(requests.some(r=>r.action==='capsule.stats'&&r.host.domain==='apps.example.test'));
 for(const r of requests.filter(r=>r.action==='host.services.connect')){assert.equal(r.host.domain,'ops.example.test');assert.equal(r.services.domain,'apps.example.test');assert.equal(r.services.subname,'hello');}
 // External env selection is never silently overwritten by registration.
 config.observability.errors.dsnEnv='SPORADES_SECRET';await writeFile(file,JSON.stringify(config));
 const rejected=await run(process.execPath,[cli,'host','services','connect','hello','--host','app','--on','ops','--json'],{cwd:project,env}).then(()=>null,e=>e);
 assert.ok(rejected);
}));
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
 const relative=path.relative(root,dir);
 await writeFile(path.join(dir,'Caddyfile'),`{\n admin off\n}\nimport /workspace/${relative}/*.caddy\n`);
 for(const ports of [{errors:52281,analytics:52282},null]){
  await writeFile(path.join(dir,OBSERVABILITY_ROUTE_FILE),renderObservabilityRoutes(h(dir),ports));
  const result=spawnSync('docker',['run','--rm','--name',`sporades-ken-observability-caddy-${process.pid}`,'--network','none','--mount',`type=bind,source=${root},target=/workspace,readonly`,'caddy:2.10.2-alpine','caddy','adapt','--config',`/workspace/${relative}/Caddyfile`,'--adapter','caddyfile'],{encoding:'utf8',timeout:55_000});
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
 const env={...process.env,SPORADES_CONFIG_DIR:path.join(dir,'config'),SPORADES_TEST_FLOCK_PATH:path.join(root,'test/support/exec-flock.py')};
 const helper=path.join(root,'bin/sporades-host-helper.js');
 const invoke=extra=>JSON.parse(spawnSync(process.execPath,[helper],{input:JSON.stringify(request),env:{...env,...extra},encoding:'utf8'}).stdout);
 const dormant=invoke({});assert.equal(dormant.ok,true);assert.deepEqual(dormant.data,{installed:false,enabled:false});
 const spoofed=invoke({SPORADES_HOST_GLOBAL_ROUTE_LOCK_FILE:path.join(remoteRoot,'bin','.sporades-host-helper.host-route.lock')});
 assert.equal(spoofed.ok,false);assert.match(spoofed.error.message,/lock identity was not retained/);
}));
