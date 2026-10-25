import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateCapsuleServicesConfig, writeCapsuleServicesCompose } from '../dist/capsule-services.js';
import { capsuleServiceNetwork, classifyContainerCompose, validateContainerServiceAddress, validateResolvedContainerServices, resolveContainerSecrets } from '../dist/container-services.js';
import { capsuleServicesComposeModel } from '../dist/capsule-services.js';
import { createTrustedServices } from '../dist/services-context.js';
import { requiredServerEnvKeys } from '../dist/server-env-requirements.js';
import { composeEquivalenceCases } from './support/compose-equivalence-cases.js';
const declaration = (extra={}) => ({kind:'container', image:'example/embeddings:v1', command:['--embeddings'], port:8080, health:{http:'/health',startPeriodSeconds:900}, ...extra});
const valid = (service) => validateCapsuleServicesConfig({embeddings:declaration(service)});

test('network modes preserve reachable origins and reject unsupported addressing before startup',()=>{
  for(const mode of [undefined,'bridge','host'])for(const publishPorts of [true,false]){
    const config={services:{embeddings:declaration({...(mode?{compose:{network_mode:mode},elevated:['network_mode']}: {})})}};
    const model=capsuleServicesComposeModel(config,process.cwd(),{publishPorts});
    const service=model.services.embeddings,rendered=service.rendered;
    if(mode==='bridge'&&!publishPorts)assert.throws(()=>validateContainerServiceAddress('embeddings',service.declaration,'container'),e=>/network_mode/.test(e.message)&&/Container.*remove.*network_mode/.test(e.hint));
    else validateContainerServiceAddress('embeddings',service.declaration,publishPorts?'local':'container');
    assert.deepEqual(rendered.ports,publishPorts&&mode!=='host'?['127.0.0.1::8080']:undefined);
    assert.deepEqual(rendered.networks,mode?undefined:[model.networks.services]);
    assert.equal(capsuleServiceNetwork(model,service),mode??model.networks.services);
    const check=actual=>validateResolvedContainerServices(model.composeDocument,actual,model.declarations,model.nameMapping,{});
    check(structuredClone(model.composeDocument));
    for(const changes of [{network_mode:mode==='host'?'bridge':'host'},{ports:['0.0.0.0::8080']}]){
      const bad=structuredClone(model.composeDocument);Object.assign(bad.services[service.name],changes);
      assert.throws(()=>check(bad),/compose/);
    }
  }
  for(const network_mode of ['none','service:other','container:unrelated','default','custom','']){
    const service=declaration({compose:{network_mode},elevated:['network_mode']});
    // Reading and rendering existing declarations must remain possible for teardown.
    valid(service);
    for(const connection of ['local','container'])assert.throws(()=>validateContainerServiceAddress('embeddings',service,connection),e=>/network_mode/.test(e.message)&&/bridge.*host/.test(e.hint));
  }
  for(const network_mode of ['bridge','host']){
    assert.throws(()=>valid({compose:{network_mode}}),e=>/elevated/.test(e.hint));
    assert.throws(()=>valid({compose:{network_mode},elevated:['network_mode'],network:{egress:false}}),e=>/egress/.test(e.hint));
  }
});

test('container declarations validate names, pins, reserved names, health and env limits', () => {
  valid({});
  for (const image of ['example/image','example/image:latest','example/image:latest@sha256:'+'a'.repeat(64),'example/image:']) assert.throws(()=>valid({image}), /image/);
  valid({image:'example/image@sha256:'+'a'.repeat(64)});
  for (const name of ['Bad','a'.repeat(32),'a_b','constructor']) assert.throws(()=>validateCapsuleServicesConfig({[name]:declaration()}));
  assert.throws(()=>validateCapsuleServicesConfig({database:declaration()}));
  assert.throws(()=>validateCapsuleServicesConfig(Object.fromEntries(Array.from({length:9},(_,i)=>['s'+i,declaration()]))));
  for (const health of [null,{}, {http:'/ok',tcp:true}, {tcp:false}, {tcp:true,await:'yes'}, {tcp:true,startPeriodSeconds:3601}]) assert.throws(()=>valid({health}));
  for (const env of [{SPORADES_PRIVATE:'x'},{TOKEN:{sealed:'SPORADES_X'}},{TOKEN:{sealed:'KEY',generated:'x'}},{TOKEN:23},{TOKEN:{generated:'__proto__'}},Object.fromEntries(Array.from({length:65},(_,i)=>['K'+i,'v'])),{TOKEN:'x'.repeat(65537)}]) assert.throws(()=>valid({env}));
  valid({env:{HF_TOKEN:{sealed:'HF_TOKEN'},API_KEY:{generated:'apiKey'},TUNING:'2048'}});
});

test('Compose classification fails closed on widening, imports, interpolation and protected mounts', () => {
  for (const key of ['restart','cpus','mem_limit','entrypoint','x-note']) assert.equal(classifyContainerCompose(key), 'ordinary');
  for (const key of ['image','environment','ports','security_opt']) assert.equal(classifyContainerCompose(key), 'owned');
  for (const key of ['privileged','gpus','future_key']) assert.equal(classifyContainerCompose(key), 'elevated');
  for (const key of ['extends','include','build','<<','&anchor','*alias']) assert.throws(()=>valid({compose:{[key]:{}},elevated:[key]}));
  assert.throws(()=>valid({compose:{extends:{service:'database'}},elevated:['extends']}));
  for (const key of ['privileged','future_key']) assert.throws(()=>valid({compose:{[key]:true}}), e=>/elevated/.test(e.hint));
  valid({compose:{privileged:true}, elevated:['privileged']});
  valid({compose:{future_key:true}, elevated:['future_key']});
  assert.throws(()=>valid({compose:{environment:{TOKEN:'leak'}}}), /env/);
  assert.throws(()=>valid({compose:{entrypoint:['${TOKEN}']}}));
  assert.throws(()=>valid({command:['${TOKEN}']}));
  assert.throws(()=>valid({user:'0:0'}));
  valid({user:'0:0',elevated:['root']});
  for (const volume of ['/var/run/docker.sock:/sock','/run/docker.sock:/sock','./.sporades:/data','/:/host']) assert.throws(()=>valid({compose:{volumes:[volume]},elevated:['volumes.bind']}));
  assert.throws(()=>valid({compose:{depends_on:['unknown']}}));
  assert.throws(()=>validateCapsuleServicesConfig({a:declaration({compose:{depends_on:['b']}}),b:declaration({compose:{depends_on:['a']}})}));
});

test('secret references join required env without including values', () => {
  assert.deepEqual(requiredServerEnvKeys({services:{embeddings:declaration({env:{HF_TOKEN:{sealed:'HF_TOKEN'}}})}}), ['HF_TOKEN']);
});

test('rendering stores stable 256-bit credentials at 0600, interpolates secrets and escapes literals', async () => {
  const dir=await mkdtemp(path.resolve('.sporades-container-'));
  try {
    const config={name:'service-test',services:{embeddings:declaration({env:{HF_TOKEN:{sealed:'HF_TOKEN'},API_KEY:{generated:'apiKey'},LITERAL:'$HOME ${NO_EXPAND}'}})}};
    const first=await writeCapsuleServicesCompose(dir,config,{publishPorts:true});
    const secrets=await resolveContainerSecrets(dir,config,{HF_TOKEN:'sealed-test-secret'});
    const second=await resolveContainerSecrets(dir,config,{HF_TOKEN:'sealed-test-secret'});
    assert.deepEqual(secrets,second);
    assert.equal(Buffer.from(secrets.services.embeddings.secrets.apiKey,'hex').length,32);
    const source=await readFile(first.path,'utf8');
    assert(!source.includes('sealed-test-secret'));
    assert(!source.includes(secrets.services.embeddings.secrets.apiKey));
    assert.match(source,/SPORADES_SVC_EMBEDDINGS_API_KEY_10:\?/);
    assert.match(source,/\$\$HOME \$\$\{NO_EXPAND\}/);
    assert.equal((await stat(path.join(dir,'.sporades/services/credentials.json'))).mode & 0o777,0o600);
    assert.deepEqual(Object.keys(secrets.environment).sort(),['SPORADES_SVC_EMBEDDINGS_API_KEY_10','SPORADES_SVC_EMBEDDINGS_HF_TOKEN_10']);
    assert.throws(()=>createTrustedServices(config,{SPORADES_CONTAINER_SERVICES:'malformed'}));
    await assert.rejects(resolveContainerSecrets(dir,config,{HF_TOKEN:'  '}), e=>/HF_TOKEN/.test(e.message)&&!e.message.includes('sealed-test-secret'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('resolved model rejects changed owned values and unaccounted authority', () => {
  const rendered={services:{svc:{image:'example:v1',environment:{API_KEY:'${SPORADES_SVC_EMBEDDINGS_API_KEY:?}'},user:'10001:10001',read_only:true}}};
  const resolved=structuredClone(rendered);
  resolved.services.svc.environment.API_KEY='secret';
  const declarations={embeddings:declaration()};
  const mapping={embeddings:'svc'};
  validateResolvedContainerServices(rendered,resolved,declarations,mapping,{SPORADES_SVC_EMBEDDINGS_API_KEY:'secret'});
  for (const changed of [{image:'evil:v1'},{user:'0'},{environment:{API_KEY:'secret',EXTRA:'leak'}},{privileged:true},{future_key:true}]) {
    const bad=structuredClone(resolved);Object.assign(bad.services.svc,changed);
    assert.throws(()=>validateResolvedContainerServices(rendered,bad,declarations,mapping,{SPORADES_SVC_EMBEDDINGS_API_KEY:'secret'}), /services.embeddings.compose/);
  }
});

test('resolved Compose cannot change or omit its owned project name',()=>{
  const rendered={name:'sporades-capsule-services',services:{svc:{image:'example:v1'}}};
  const check=actual=>validateResolvedContainerServices(rendered,actual,{embeddings:declaration()},{embeddings:'svc'},{});
  check(structuredClone(rendered));
  for(const name of ['qa-unrelated',undefined]){
    const changed=structuredClone(rendered);changed.name=name;
    assert.throws(()=>check(changed),/compose.name/);
  }
});

test('resolved preflight delegates unread passthrough instead of comparing its values',()=>{
  const expected={services:{svc:{image:'example:v1',cpus:0,logging:{driver:'json-file',options:{}},entrypoint:'literal words',labels:{'operator.note':'declared'}}}};
  const actual={services:{svc:{image:'example:v1',cpus:'0.0',logging:{driver:'json-file'},entrypoint:['literal','words'],labels:{'operator.note':'normalized'},sysctls:{}}}};
  const before=structuredClone(actual);
  validateResolvedContainerServices(expected,actual,{embeddings:declaration({elevated:['sysctls']})},{embeddings:'svc'},{});
  assert.deepEqual(actual,before);
});

test('trusted service context is deeply frozen, nonserializable and contains generated secrets only', () => {
  const config={services:{embeddings:declaration({env:{API_KEY:{generated:'apiKey'},HF_TOKEN:{sealed:'HF_TOKEN'}}})}};
  const services=createTrustedServices(config,{SPORADES_CONTAINER_SERVICES:JSON.stringify({embeddings:{url:'http://127.0.0.1:5204',secrets:{apiKey:'a'.repeat(64)}}})});
  assert.equal(services.embeddings.url,'http://127.0.0.1:5204');
  assert.deepEqual(Object.keys(services.embeddings.secrets),['apiKey']);
  assert(Object.isFrozen(services)&&Object.isFrozen(services.embeddings)&&Object.isFrozen(services.embeddings.secrets));
  assert.equal(services.unknown,undefined);
  assert(!String(JSON.stringify(services)).includes('a'.repeat(64)));
});

for (const {name,compose,resolved,elevated=[]} of composeEquivalenceCases) test(`resolved Compose accepts ${name} and protects owned boundaries`,()=>{
  valid({compose,elevated});
  const check=(expected,actual)=>validateResolvedContainerServices({services:{svc:expected}},{services:{svc:actual}},{embeddings:declaration()},{embeddings:'svc'},{});
  check(compose,resolved);
  check(resolved,compose);
  const changed={...structuredClone(resolved),user:"0"};
  assert.throws(()=>check(compose,changed),/services.embeddings.compose/);
});

test('resolved preflight preserves custody, networking, mounts and hardening',()=>{
  const rendered={name:'sporades-capsule-services',services:{svc:{image:'example:v1',command:['run'],container_name:'sporades-capsule-worker',user:'10001:10001',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],environment:{KEY:'private'},networks:['owned'],ports:['127.0.0.1::8080'],tmpfs:['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'],labels:{'com.sporades.managed':'true'},volumes:[{type:'bind',source:'/reviewed',target:'/data',read_only:true}],healthcheck:{test:['CMD','probe'],interval:'5s'}}},networks:{owned:{name:'owned',internal:true}}};
  const check=actual=>validateResolvedContainerServices(rendered,actual,{embeddings:declaration()},{embeddings:'svc'},{});
  check(structuredClone(rendered));
  for(const changed of [
    {image:'evil:v1'},{command:['other']},{container_name:'foreign'},{user:'0'},
    {environment:{KEY:'changed'}},{environment:{KEY:'private',EXTRA:'leak'}},
    {healthcheck:{test:['NONE']}},{read_only:false},{cap_drop:[]},{security_opt:[]},
    {networks:['foreign']},{network_mode:'host'},{ports:['0.0.0.0::8080']},
    {volumes:[{type:'bind',source:'/var/run/docker.sock',target:'/data',read_only:true}]},
    {volumes:[{type:'bind',source:'/reviewed',target:'/other',read_only:true}]},
    {volumes:[{type:'bind',source:'/reviewed',target:'/data',read_only:false}]},
    {tmpfs:['/tmp:rw']},{tmpfs:[...rendered.services.svc.tmpfs,'/tmp/overlap:rw']},
    {tmpfs:[...rendered.services.svc.tmpfs,'/:rw']},{tmpfs:[...rendered.services.svc.tmpfs,'/tmp/..:rw']},
    {labels:{'com.sporades.managed':'false'}},{volumes_from:['container:foreign']},
    {depends_on:['foreign']},{depends_on:['svc']},{privileged:true},{future_key:true},
    {extends:{service:'foreign'}},{use_api_socket:true},
  ]){
    const actual=structuredClone(rendered);Object.assign(actual.services.svc,changed);
    assert.throws(()=>check(actual),/services.embeddings.compose/);
  }
  for(const kind of ['services','networks','volumes']){
    const actual=structuredClone(rendered);actual[kind]={...actual[kind],foreign:{}};
    assert.throws(()=>check(actual));
  }
});

test('concurrent built-in and container credential writers preserve generated identity; corrupt storage fails closed', async () => {
  const dir=await mkdtemp(path.resolve('.sporades-credentials-'));
  try {
    const config={name:'stable',services:{embeddings:declaration({env:{KEY:{generated:'key'}}})}};
    const attempts=await Promise.all(Array.from({length:8}, async()=>{
      await writeCapsuleServicesCompose(dir,config);
      return resolveContainerSecrets(dir,config);
    }));
    assert.equal(new Set(attempts.map(v=>v.services.embeddings.secrets.key)).size,1);
    const {writeFile}=await import('node:fs/promises');
    await writeFile(path.join(dir,'.sporades/services/credentials.json'),'{broken');
    await assert.rejects(resolveContainerSecrets(dir,config),/Invalid services/);
    await assert.rejects(writeCapsuleServicesCompose(dir,config),/Invalid services/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Compose validates known key types and nested elevation before rendering', () => {
  for (const compose of [{cpus:{}},{privileged:[]},{restart:[]},{logging:{driver:32}}]) assert.throws(()=>valid({compose,elevated:['privileged']}));
  valid({compose:{deploy:{resources:{limits:{memory:'4g',cpus:'2'}}}}});
  assert.throws(()=>valid({compose:{deploy:{resources:{reservations:{devices:[{capabilities:['gpu']}]}}}}}));
  valid({compose:{deploy:{resources:{reservations:{devices:[{capabilities:['gpu']}]}}}},elevated:['deploy.resources.reservations.devices']});
  for (const compose of [{labels:{'com.sporades.managed':'false'}},{use_api_socket:true},{volumes_from:['database']},{volumes:[{type:'bind',source:'/',target:'/host'}]}]) assert.throws(()=>valid({compose,elevated:['use_api_socket','volumes_from','volumes.bind']}));
});

test('inherited volumes reject Runtime sources and pin inspected external containers before preflight', async()=>{
 const {pinContainerInheritedMounts}=await import('../dist/container-services.js');
 const declarations={worker:declaration({compose:{volumes_from:['container:reviewed:ro']},elevated:['volumes_from']})};
 validateCapsuleServicesConfig(declarations);
 const model=()=>({declarations,nameMapping:{worker:'generated-worker'},composeDocument:{services:{'generated-worker':{volumes_from:['container:reviewed:ro']}}}});
 const safe=model();
 assert.equal(pinContainerInheritedMounts(safe,process.cwd(),()=>({Id:'f'.repeat(64),Mounts:[{Type:'bind',Source:'/opt/reviewed-corpus',Destination:'/corpus'}]})),true);
 assert.deepEqual(safe.composeDocument.services['generated-worker'].volumes_from,['container:'+'f'.repeat(64)+':ro']);
 for(const source of ['/', '/var/run/docker.sock',path.resolve('.sporades/services/credentials.json')]) assert.throws(()=>pinContainerInheritedMounts(model(),process.cwd(),()=>({Id:'f'.repeat(64),Mounts:[{Type:'bind',Source:source,Destination:'/corpus'}]})));
 assert.throws(()=>pinContainerInheritedMounts(model(),process.cwd(),()=>({Id:'missing',Mounts:[]})));
 assert.throws(()=>validateCapsuleServicesConfig({database:{kind:'database',engine:'postgres'},worker:declaration({compose:{volumes_from:['database']},elevated:['volumes_from']})}));
 validateCapsuleServicesConfig({source:declaration({compose:{volumes:['corpus:/corpus']}}),worker:declaration({compose:{volumes_from:['source:ro']},elevated:['volumes_from']})});
 assert.throws(()=>validateCapsuleServicesConfig({source:declaration({state:{path:'/models'}}),worker:declaration({compose:{volumes_from:['source:ro']},elevated:['volumes_from']})}));
});

test('failed candidates retain active generated secrets; successful removal discards them',async()=>{
 const {finalizeContainerSecrets}=await import('../dist/container-services.js');
 const dir=await mkdtemp(path.resolve('.sporades-service-generations-'));
 try{
  const active={services:{worker:declaration({env:{KEY:{generated:'toString'}}})}};
  const candidate={services:{worker:declaration({env:{KEY:{generated:'replacement'}}})}};
  const first=await resolveContainerSecrets(dir,active);
  await finalizeContainerSecrets(dir,active);
  await resolveContainerSecrets(dir,candidate);
  const restored=await resolveContainerSecrets(dir,active);
  assert.equal(restored.services.worker.secrets.toString,first.services.worker.secrets.toString);
  await finalizeContainerSecrets(dir,active);
  const retained=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));
  assert.deepEqual(Object.keys(retained.container.worker),['toString']);
  await finalizeContainerSecrets(dir,{services:{}});
  const removed=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));
  assert.equal(removed.container,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('secret child variables cannot collide across service-name and env-name boundaries',async()=>{
 const {serviceInterpolationName}=await import('../dist/container-services.js');
 assert.notEqual(serviceInterpolationName('a-b','C'),serviceInterpolationName('a','B_C'));
});

test('concurrent declaration finalization cannot erase a newly admitted credential generation',async()=>{
 const {finalizeContainerSecrets}=await import('../dist/container-services.js');
 const dir=await mkdtemp(path.resolve('.sporades-service-concurrent-generation-'));
 try{
  const oldConfig={services:{worker:declaration({env:{KEY:{generated:'oldKey'}}})}};
  const newConfig={services:{worker:declaration({env:{KEY:{generated:'newKey'}}})}};
  const old=await resolveContainerSecrets(dir,oldConfig);
  const next=await resolveContainerSecrets(dir,newConfig);
  await finalizeContainerSecrets(dir,newConfig,next);
  await assert.rejects(finalizeContainerSecrets(dir,oldConfig,old),/Invalid services.worker.env/);
  const saved=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));
  assert.deepEqual(saved.container.worker,{...next.services.worker.secrets});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('older finalization cannot prune a newer service when their retained keys are unchanged',async()=>{
 const {finalizeContainerSecrets}=await import('../dist/container-services.js');
 const dir=await mkdtemp(path.resolve('.sporades-service-added-generation-'));
 try{
  const one=declaration({env:{KEY:{generated:'key'}}});
  const oldConfig={services:{one}};
  const newConfig={services:{one,two:declaration({env:{KEY:{generated:'key'}}})}};
  const old=await resolveContainerSecrets(dir,oldConfig);
  const next=await resolveContainerSecrets(dir,newConfig);
  assert.equal(old.services.one.secrets.key,next.services.one.secrets.key);
  await finalizeContainerSecrets(dir,newConfig,next);
  await assert.rejects(finalizeContainerSecrets(dir,oldConfig,old),e=>/credentials changed during startup/.test(e.hint));
  const saved=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));
  assert.equal(saved.container.two.key,next.services.two.secrets.key);
  assert.equal((await resolveContainerSecrets(dir,newConfig)).services.two.secrets.key,next.services.two.secrets.key);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('empty declarations cannot prune a newer startup or finalize after credentials reset',async()=>{
 const {finalizeContainerSecrets,updateServiceCredentials}=await import('../dist/container-services.js');
 const dir=await mkdtemp(path.resolve('.sporades-service-empty-generation-'));
 try{
  const removed={services:{}};
  const old=await resolveContainerSecrets(dir,removed);
  const config={services:{worker:declaration({env:{KEY:{generated:'key'}}})}};
  const next=await resolveContainerSecrets(dir,config);
  await finalizeContainerSecrets(dir,config,next);
  await assert.rejects(finalizeContainerSecrets(dir,removed,old),e=>/credentials changed during startup/.test(e.hint));
  const saved=JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8'));
  assert.equal(saved.container.worker.key,next.services.worker.secrets.key);
  const removal=await resolveContainerSecrets(dir,removed);
  await finalizeContainerSecrets(dir,removed,removal);
  assert.equal(JSON.parse(await readFile(path.join(dir,'.sporades/services/credentials.json'),'utf8')).container,undefined);
  const restarted=await resolveContainerSecrets(dir,config);
  await updateServiceCredentials(dir,()=>({value:{},result:null}));
  await assert.rejects(finalizeContainerSecrets(dir,config,restarted),e=>/credentials changed during startup/.test(e.hint));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('named volume references preserve Compose sharing within the Capsule namespace',async()=>{
 const {capsuleServicesComposeModel}=await import('../dist/capsule-services.js');
 const config={name:'shared-cache',services:{one:declaration({compose:{volumes:['cache:/cache']}}),two:declaration({compose:{volumes:['cache:/models']}})}};
 const model=capsuleServicesComposeModel(config);
 assert.deepEqual(Object.keys(model.composeDocument.volumes),['cache']);
 assert.equal(model.composeDocument.volumes.cache.name,'sporades-shared-cache-services-cache');
 for(const service of Object.values(model.composeDocument.services))assert.equal(service.volumes[0].source,'cache');
 assert.equal(model.composeDocument.volumes.cache.labels['com.sporades.managed'],'true');
});

test('trusted origins accept HTTP port 80, which URL canonicalization removes',()=>{
 const config={services:{worker:declaration({port:80,compose:{network_mode:'host'},elevated:['network_mode']})},__sporadesSession:'dev'};
 const services=createTrustedServices(config,{SPORADES_CONTAINER_SERVICES:JSON.stringify({worker:{url:'http://127.0.0.1:80',secrets:{}}})});
 assert.equal(services.worker.url,'http://127.0.0.1');
});
