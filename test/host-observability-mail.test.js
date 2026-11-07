import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observabilityCompose } from '../dist/cli/host-observability.js';
import { validateObservabilityMail } from '../dist/cli/host-observability-mail.js';
const smtp = {version:1,transport:'smtp-ssl',host:'smtp.example.test',port:465,username:'user@example.test',password:'p@ss:/?#%$! space',from:'alerts@example.test'};
const state = {secrets:{}};
test('sender dollar signs are escaped for Compose interpolation',()=>{
 const compose=observabilityCompose({remoteRoot:'/srv/sporades',domain:'example.test'},state,validateObservabilityMail({...smtp,from:'alert$sender@example.test'}));
 assert.equal(compose.services.web.environment.DEFAULT_FROM_EMAIL,'alert$$sender@example.test');
});
test('implicit TLS and reserved credentials reach both GlitchTip roles; absent config stays console-only',()=>{
 const mail=validateObservabilityMail(smtp);
 const compose=observabilityCompose({remoteRoot:'/srv/sporades',domain:'example.test'},state,mail);
 for(const role of ['web','worker']){
  assert.equal(compose.services[role].environment.EMAIL_URL,'smtp+ssl://user%40example.test:p%40ss%3A%2F%3F%23%25%24!%20space@smtp.example.test:465');
  assert.equal(compose.services[role].environment.DEFAULT_FROM_EMAIL,'alerts@example.test');
 }
 assert.equal(observabilityCompose({remoteRoot:'/srv/sporades',domain:'example.test'},state).services.web.environment.EMAIL_URL,'consolemail://');
});

test('mail schema is closed, complete and redacts rejected values',()=>{
 for(const bad of [null,[],{}, {...smtp,version:2},{...smtp,transport:'smtp'},{...smtp,port:'465'},{...smtp,port:0},{...smtp,port:65536},
  {...smtp,host:'smtp.example.test?private-marker'},{...smtp,host:'smtp.example.test\nprivate-marker'}, {...smtp,from:'Name <alerts@example.test>'},
  {...smtp,from:'a@example.test\r\nBcc:x@example.test'},{...smtp,from:'a..b@example.test'},{...smtp,from:'.a@example.test'},{...smtp,from:'a.@example.test'},{...smtp,password:'snow雪'},{...smtp,password:''},{...smtp,password:'private-marker\n'}, {...smtp,password:'\ud800'},
  {...smtp,extra:'private-marker'}, {...smtp,password:undefined}, {version:1,transport:'console',password:'private-marker'}]){
  assert.throws(()=>validateObservabilityMail(bad),e=>/Invalid protected/.test(e.message)&&!JSON.stringify(e).includes('private-marker'));
 }
 assert.deepEqual(validateObservabilityMail({version:1,transport:'console'}),{version:1,transport:'console'});
});

import { mkdir, writeFile, readFile, chmod, symlink, link, rm, stat, chown } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHostFixture, hostFixtureConfig, removeHostFixture } from './support/host-fixture-root.js';
import { configureObservabilityMail, readObservabilityMail, observabilityMailFile } from '../dist/cli/host-observability-mail.js';
import { applyObservabilityMail, observabilityDirectory, observabilityProject, restoreObservability } from '../dist/cli/host-observability.js';
const hostFor=dir=>({alias:'local',remoteRoot:dir,domain:'ops.example.test',scheme:'https'});
async function fixture(fn){
 const dir=await createHostFixture('sporades-mail-',{privateAncestors:true});
 try {await writeFile(path.join(dir,"package.json"),'{"type":"module"}');await fn(dir,hostFor(dir));} finally {await removeHostFixture(dir);}
}
const redacted=e=>/Invalid protected/.test(e.message)&&!JSON.stringify(e).includes(smtp.password);
test('protected publication is atomic; unsafe staged and installed files fail closed without replacing credentials',()=>fixture(async(dir,host)=>{
 const staged=path.join(dir,'staged.json'),file=observabilityMailFile(host);
 assert.equal(await readObservabilityMail(host),null);
 for(const invalid of [undefined,{},"","relative.json","/srv/../mail.json"])await assert.rejects(configureObservabilityMail(host,invalid),redacted);
 await writeFile(staged,JSON.stringify(smtp),{mode:0o600});
 assert.deepEqual(await configureObservabilityMail(host,staged),{mail:{configured:true,transport:'smtp-ssl'},applyRequired:true});
 const before=await readFile(file,'utf8');
 assert.equal((await stat(file)).mode&0o777,0o600);
 assert.equal((await readObservabilityMail(host)).password,smtp.password);
 for(const value of ['{'+smtp.password,JSON.stringify({...smtp,from:'a..b@example.test'},{...smtp,from:'.a@example.test'},{...smtp,from:'a.@example.test'},{...smtp,password:'snow雪'},{...smtp,password:''}),JSON.stringify({...smtp,port:25,transport:'smtp'})]){
  await writeFile(staged,value);await assert.rejects(configureObservabilityMail(host,staged),redacted);assert.equal(await readFile(file,'utf8'),before);
 }
 await writeFile(staged,JSON.stringify(smtp));
 for(const mode of [0o644,0o660,0o400,0o700]){
  await chmod(staged,mode);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 }
 await chmod(staged,0o600);
 const other=path.join(dir,'other');await writeFile(other,JSON.stringify(smtp),{mode:0o600});
 await rm(staged);await symlink(other,staged);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 await rm(staged);await link(other,staged);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 await rm(staged);await symlink(path.join(dir,'missing'),staged);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 await rm(staged);await writeFile(staged,JSON.stringify(smtp),{mode:0o600});
 for(const mode of [0o644,0o620]){
  await chmod(file,mode);await assert.rejects(readObservabilityMail(host),redacted);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 }
 await chmod(file,0o600);
 await rm(file);await symlink(other,file);await assert.rejects(readObservabilityMail(host),redacted);await assert.rejects(configureObservabilityMail(host,staged),redacted);
 await rm(file);await symlink(path.join(dir,'missing'),file);await assert.rejects(readObservabilityMail(host),redacted);
 await rm(file);await link(other,file);await assert.rejects(readObservabilityMail(host),redacted);
 await rm(file);await mkdir(file);await assert.rejects(readObservabilityMail(host),redacted);await rm(file,{recursive:true});
 await configureObservabilityMail(host,staged);
 await chmod(path.dirname(file),0o770);await assert.rejects(readObservabilityMail(host),redacted);await assert.rejects(configureObservabilityMail(host,staged),redacted);await chmod(path.dirname(file),0o700);
 const alias=path.join(dir,'alias');await symlink(path.dirname(file),alias);
 await assert.rejects(configureObservabilityMail(host,path.join(alias,'mail.json')),redacted);
 await writeFile(staged,'x'.repeat(8193));await assert.rejects(configureObservabilityMail(host,staged),redacted);
 if(process.geteuid?.()===0){await chown(file,12345,12345);await assert.rejects(readObservabilityMail(host),redacted);await chown(file,0,0);}
 await writeFile(staged,JSON.stringify({version:1,transport:'console'}));
 assert.deepEqual(await configureObservabilityMail(host,staged),{mail:{configured:false,transport:'console'},applyRequired:true});
 assert.deepEqual(await readObservabilityMail(host),{version:1,transport:'console'});
}));
const secretNames=['database','umamiDatabase','django','app','errorsPassword','analyticsPassword','token'];
const installedState=()=>({version:1,enabled:true,ready:true,disclosed:true,secrets:Object.fromEntries(secretNames.map((k,i)=>[k,String(i).repeat(64)]))});
test('mail apply recreates only web/worker, retains Compose identities and suppresses provider failures; retry converges',()=>fixture(async(dir,host)=>{
 const directory=observabilityDirectory(host),staged=path.join(dir,'staged.json');
 await writeFile(staged,JSON.stringify(smtp),{mode:0o600});await configureObservabilityMail(host,staged);
 const state=installedState();await writeFile(path.join(directory,'secrets.json'),JSON.stringify(state),{mode:0o600});
 const compose=observabilityCompose(host,state);compose.services.umami.environment.MARKER='untouched';
 await writeFile(path.join(directory,'compose.json'),JSON.stringify(compose),{mode:0o600});
 const tools=path.join(dir,'tools');await mkdir(tools,{mode:0o700});
 const calls=path.join(dir,'calls'),failFlag=path.join(dir,'fail');
 await writeFile(path.join(tools,'docker'),`#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('port')){console.log('127.0.0.1:52281');process.exit(0);}console.error('smtp auth secret-marker');process.exit(fs.existsSync(${JSON.stringify(failFlag)})?1:0);\n`,{mode:0o700});
 const oldPath=process.env.PATH;process.env.PATH=tools+path.delimiter+oldPath;
 try{
  await writeFile(failFlag,'1');
  await assert.rejects(applyObservabilityMail(host),e=>!JSON.stringify(e).includes('secret-marker'));
  await rm(failFlag);
  // Fake only the local readiness response, without logging any provider input.
  const originalFetch=globalThis.fetch;
  // Port resolution uses the fake executable, so give it the normal loopback output.
  await writeFile(path.join(tools,'docker'),`#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('port'))console.log('127.0.0.1:52281');\n`,{mode:0o700});
  globalThis.fetch=async()=>({ok:true,text:async()=>'{}'});
  try {assert.deepEqual(await applyObservabilityMail(host),{mail:{configured:true,transport:'smtp-ssl'},recreated:['web','worker']});}
  finally {globalThis.fetch=originalFetch;}
  const after=JSON.parse(await readFile(path.join(directory,'compose.json'),'utf8'));
  assert.deepEqual(after.services.web.ports,['127.0.0.1:52281:8080']);
  assert.equal(after.name,observabilityProject(host));assert.deepEqual(after.volumes,compose.volumes);
  for(const name of ['errors-db','analytics-db','valkey','umami'])assert.deepEqual(after.services[name],compose.services[name]);
  assert.equal(after.services.worker.environment.EMAIL_URL,after.services.web.environment.EMAIL_URL);
  const commands=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(commands.find(args=>args.includes('up')).slice(-6),['up','-d','--no-deps','--force-recreate','web','worker']);
  assert.ok(!JSON.stringify(commands).includes('smtp+ssl')&&!JSON.stringify(commands).includes(smtp.password));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'secrets.json'),'utf8')),state);
  await writeFile(path.join(directory,'restore.json'),'{}',{mode:0o600});await assert.rejects(applyObservabilityMail(host),/interrupted service restore/);
 }finally{process.env.PATH=oldPath;}
}));

test('shipped helper accepts a staged path under the Host lock and status never discloses credentials',()=>fixture(async(dir,host)=>{
 const staged=path.join(dir,'staged.json');await writeFile(staged,JSON.stringify(smtp),{mode:0o600});
 const helper=path.join(process.cwd(),'bin/sporades-host-helper.js');
 const env={...process.env,SPORADES_CONFIG_DIR:hostFixtureConfig(dir),SPORADES_TEST_FLOCK_PATH:path.join(process.cwd(),'test/support/exec-flock.py')};
 for(const request of [{action:'host.services.mail-configure',mail:{stagedFile:staged}},{action:'host.services.status'}]){
  const result=spawnSync(process.execPath,[helper],{env,input:JSON.stringify({...request,host}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes(smtp.password)&&!result.stdout.includes('smtp+ssl://')&&!result.stdout.includes(smtp.username));
  const envelope=JSON.parse(result.stdout);assert.equal(envelope.ok,true,JSON.stringify(envelope));
  assert.deepEqual(envelope.data.mail,{configured:true,transport:'smtp-ssl'});
 }
 assert.equal((await readObservabilityMail(host)).password,smtp.password);
}));

test('shipped CLI forwards only the remote staging path and validates mail operation flags',()=>fixture(async(dir)=>{
 await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
 const tools=path.join(dir,'tools');await mkdir(tools);
 const ledger=path.join(dir,'ssh.jsonl');
 await writeFile(path.join(tools,'ssh'),`#!/usr/bin/env node\nimport fs from 'node:fs';let input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input);fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({argv:process.argv,request:r})+'\\n');console.log(JSON.stringify({ok:true,data:{mail:{configured:true,transport:'smtp-ssl'}},error:null}));\n`,{mode:0o700});
 const env={...process.env,PATH:tools+path.delimiter+process.env.PATH,SPORADES_CONFIG_DIR:hostFixtureConfig(dir)};
 const invoke=args=>spawnSync(process.execPath,[path.join(process.cwd(),'bin/sporades.js'),...args],{cwd:dir,env,encoding:'utf8'});
 const added=invoke(['host','add','ops','--server','operator@fake.invalid','--domain','ops.example.test','--json']);assert.equal(added.status,0,added.stderr);
 for(const args of [['mail-configure','--file','/srv/sporades/mail-staging/mail.json'],['mail-apply']]){
  const [operation,...flags]=args;const result=invoke(['host','services',operation,'observability','--on','ops','--json',...flags]);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);
 }
 const entries=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(entries.length,2);
 assert.equal(entries[0].request.action,'host.services.mail-configure');assert.deepEqual(entries[0].request.mail,{stagedFile:'/srv/sporades/mail-staging/mail.json'});
 assert.equal(entries[1].request.action,'host.services.mail-apply');assert.equal(entries[1].request.mail,undefined);
 for(const entry of entries)assert.ok(!JSON.stringify(entry.argv).includes('mail-staging'));
 for(const args of [['mail-configure'],['mail-apply','--file','/remote'],['status','--file','/remote']]){
  const [operation,...flags]=args;const result=invoke(['host','services',operation,'observability','--on','ops','--json',...flags]);assert.notEqual(result.status,0);assert.match(JSON.parse(result.stdout).error.message,/Invalid mail configuration input/);
 }
 assert.equal((await readFile(ledger,'utf8')).trim().split('\n').length,2);
}));

test('public protected-mail type resolves to the generated helper contract',()=>fixture(async dir=>{
 const file=path.join(dir,'mail-contract.mts');
 const publicTypes=path.join(process.cwd(),'src/types/host-observability.js').replaceAll(path.sep,'/');
 await writeFile(file,`import type { HostObservabilityMail } from ${JSON.stringify(publicTypes)};
const consoleMail: HostObservabilityMail = {version:1,transport:'console'};
const smtpMail: HostObservabilityMail = {version:1,transport:'smtp-ssl',host:'smtp.example.test',port:465,username:'synthetic',password:'synthetic',from:'alerts@example.test'};
// @ts-expect-error SMTP fields must be complete.
const partial: HostObservabilityMail = {version:1,transport:'smtp-ssl'};
// @ts-expect-error Plaintext SMTP is unsupported.
const plaintext: HostObservabilityMail = {version:1,transport:'smtp'};
void [consoleMail,smtpMail,partial,plaintext];
`);
 const result=spawnSync(process.execPath,[path.join(process.cwd(),'node_modules/typescript/bin/tsc'),'--noEmit','--skipLibCheck','--module','nodenext','--target','ES2022',file],{encoding:'utf8',timeout:120000});
 assert.equal(result.status,0,result.stdout+result.stderr);
}));
