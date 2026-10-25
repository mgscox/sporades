import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeCapsuleServicesCompose} from '../dist/capsule-services.js';
import {resolveContainerSecrets,validateResolvedContainerServices} from '../dist/container-services.js';
import {composeEquivalenceCases} from './support/compose-equivalence-cases.js';
const binary=process.env.SPORADES_COMPOSE_TEST_BINARY;
const root=fileURLToPath(new URL('../',import.meta.url));
test('official Compose canonical models preserve owned boundaries for Dev and Container service combinations',{skip:!binary&&'Set SPORADES_COMPOSE_TEST_BINARY to a Compose v2 executable (no daemon needed).'},async t=>{
 const dir=await mkdtemp(path.join(root,'.sporades-container-compose-'));
 try{
  const base={kind:'container',image:'example:v1',command:['--embed'],port:8080,health:{http:'/health',startPeriodSeconds:3600},env:{KEY:{generated:'apiKey'},LITERAL:'$HOME ${NOT_EXPANDED}'},compose:{privileged:false,restart:'unless-stopped',mem_limit:'4g',cpus:2,shm_size:'1g',stop_grace_period:'90s',entrypoint:'/bin/sh -c \"literal words\"',ulimits:{nofile:65536},volumes:['cache:/cache']}};
  const cases=[
   ...composeEquivalenceCases.map(({name,compose,elevated=[]})=>[name,compose,elevated]),
   ['baseline',{},[]],
   ['scalar dns',{dns:'1.1.1.1'},[]],
   ['scalar dns_search',{dns_search:'example.test'},[]],
   ['extra_hosts colon separators',{extra_hosts:['reviewed:127.0.0.1','ipv6:::1']},['extra_hosts']],
   ['deploy resource limits',{deploy:{resources:{limits:{pids:64,memory:'4g',cpus:'2'}}}},[]],
   ['volume nocopy false',{volumes:[{type:'volume',source:'cache',target:'/cache',volume:{nocopy:false}}]},[]],
   ['list DNS and equals host separators',{dns:['1.1.1.1','8.8.8.8'],dns_search:['example.test','other.test'],extra_hosts:['reviewed=127.0.0.1','ipv6=::1']},['extra_hosts']],
  ];
  for(const [label,compose,elevated] of cases)for(const startPeriodSeconds of [0,3600])for(const publishPorts of [true,false])for(const builtin of [false,true])await t.test(`${label}, ${publishPorts?'Dev':'Container'}, builtins=${builtin}, startPeriod=${startPeriodSeconds}`,async()=>{
   const config={name:'compose-contract',services:{...(builtin?{database:{kind:'database',engine:'postgres'},storage:{kind:'storage',engine:'minio'}}:{}),embeddings:{...base,elevated:['privileged',...elevated],health:{...base.health,startPeriodSeconds},state:{path:'/models'},...(!publishPorts?{network:{egress:false}}:{}),compose:{...base.compose,...compose,...(builtin?{depends_on:{database:{condition:'service_healthy'}}}:{})}}}};
   const model=await writeCapsuleServicesCompose(dir,config,{publishPorts});
   const secrets=await resolveContainerSecrets(dir,config);
   const result=spawnSync(binary,['-p',model.composeProjectName,'-f',model.path,'config','--format','json'],{encoding:'utf8',env:{...process.env,COMPOSE_PROJECT_NAME:'qa-unrelated',...secrets.environment},timeout:20000});
   assert.equal(result.status,0,result.stderr);
   const resolved=JSON.parse(result.stdout);
   validateResolvedContainerServices(model.composeDocument,resolved,config.services,model.nameMapping,secrets.environment);
   const bad=structuredClone(resolved);bad.services[model.nameMapping.embeddings].environment.EXTRA='not-declared';
   assert.throws(()=>validateResolvedContainerServices(model.composeDocument,bad,config.services,model.nameMapping,secrets.environment));
   const changed=structuredClone(resolved);changed.services[model.nameMapping.embeddings].user='0';
   assert.throws(()=>validateResolvedContainerServices(model.composeDocument,changed,config.services,model.nameMapping,secrets.environment));
   const foreign=structuredClone(resolved);foreign.name='qa-unrelated';
   assert.throws(()=>validateResolvedContainerServices(model.composeDocument,foreign,config.services,model.nameMapping,secrets.environment));
  });
 }finally{await rm(dir,{recursive:true,force:true});}
});
