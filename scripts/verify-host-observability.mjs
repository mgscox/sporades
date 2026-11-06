// Disposable LOCAL Docker acceptance. Never connects to a Host, SSH or cloud.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { enableObservability, disableObservability, provisionObservability, statusObservability, observabilityDocker, observabilityPort, observabilityDirectory, readObservabilityState, backupObservability, listObservabilityBackups, restoreObservability } from '../dist/cli/host-observability.js';
import { createRuntimeObservability } from '../dist/observability-runtime.js';
import { unsealServerEnv } from '../dist/sealed-server-env.js';
const scratch = path.join(process.cwd(), '.sporades');
await mkdir(scratch, {recursive:true});
const directory = await mkdtemp(path.join(scratch, 'observe-acceptance-'));
const host = { alias:'disposable-local', domain:'observability.example.test', scheme:'https', remoteRoot:directory };
const {publicKey,privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const target = { domain:'capsules.example.test', subname:'test', errors:true, analytics:true, publicKey };
const sql = (service,user,query) => observabilityDocker(host,['exec','-T',service,'psql','-U',user,'-d',user,'-tAc',query]).toString().trim();
try {
  // Fail after provider initialization and prove retry converges without resetting credentials.
  await assert.rejects(enableObservability(host, async()=>{throw new Error('simulated Caddy failure');}), /simulated/);
  process.stdout.write("Provider bootstrap recovery verified.\n");
  const first = await enableObservability(host, async ports => { assert.ok(ports.errors); assert.ok(ports.analytics); });
  assert.ok(first.credentials);
  const second = await enableObservability(host, async()=>{});
  assert.equal(second.credentials, undefined);
  process.stdout.write("Repeated enable verified.\n");
  // Caddy terminates HTTPS and forwards HTTP: a valid browser CSRF token must
  // pass the exact public Origin check even though the upstream hop is HTTP.
  const csrfCheck=`from django.test import RequestFactory\nfrom django.middleware.csrf import CsrfViewMiddleware,get_token\nfrom django.http import HttpResponse\nr=RequestFactory().post('/',HTTP_HOST='errors.${host.domain}',HTTP_ORIGIN='https://errors.${host.domain}')\ntoken=get_token(r)\nr.COOKIES['csrftoken']=r.META['CSRF_COOKIE']\nr.META['HTTP_X_CSRFTOKEN']=token\nview=lambda request:HttpResponse()\nassert CsrfViewMiddleware(view).process_view(r,view,(),{}) is None\n`;
  observabilityDocker(host,['exec','-T','web','./manage.py','shell','-c',csrfCheck]);
  const token=(await readObservabilityState(host)).secrets.token;
  const origin=`http://127.0.0.1:${observabilityPort(host,'web')}`;
  const glitchtip=async(route,method='GET',body)=>{
    const response=await fetch(origin+'/api/0/'+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000),redirect:'error'});
    assert.ok(response.ok,`Disposable GlitchTip ${method} failed (${response.status}); provider response omitted.`);
    return response.json();
  };
  const slug='capsule-b197d192cbb5479bbbf8302af227700d',route=`projects/sporades/${slug}/`;
  // Model a legacy Capsule with a working DSN and stored history before migration.
  const legacy=await glitchtip('teams/sporades/capsules/projects/','POST',{name:slug,slug,platform:'node'});
  assert.equal(legacy.name,slug);assert.equal(legacy.slug,slug);assert.match(legacy.id,/^[1-9]\d*$/);
  const originalKeys=await glitchtip(route+'keys/');assert.ok(originalKeys.length);
  const localDsn=value=>{const url=new URL(value);url.protocol='http:';url.hostname='127.0.0.1';url.port=String(observabilityPort(host,'web'));return url.href;};
  const sendError=async(message,dsn)=>{
    const runtime=createRuntimeObservability({name:'test',observability:{errors:{protocol:'sentry',dsnEnv:'ERROR_DSN'}}},{ERROR_DSN:localDsn(dsn)});
    try{runtime.capture(new Error(message),'query');await runtime.flush();}finally{runtime.close();}
  };
  const issueIds=()=>sql('errors-db','glitchtip',`SELECT id FROM issue_events_issue WHERE project_id=${legacy.id} ORDER BY id`);
  await sendError('disposable legacy history',originalKeys[0].dsn.public);
  const historyDeadline=Date.now()+90_000;
  while(!issueIds()&&Date.now()<historyDeadline)await new Promise(r=>setTimeout(r,1000));
  const history=issueIds();assert.ok(history,'Legacy DSN stores an issue before migration');
  const connection = await provisionObservability(host,target);
  const values = unsealServerEnv(connection.env,privateKey);
  const renamed=await glitchtip(route);
  assert.equal(renamed.id,legacy.id);assert.equal(renamed.slug,slug);assert.equal(renamed.name,'test.capsules.example.test');
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Migration preserves complete key responses');
  assert.equal(issueIds(),history,'Migration preserves issue history');
  const again = await provisionObservability(host,target);
  assert.deepEqual(unsealServerEnv(again.env,privateKey),values);
  // Interrupt after a real create and before rename; retry must use that project.
  const interruptedTarget={...target,subname:'interrupted',analytics:false};
  const fetchProvider=globalThis.fetch;
  let interruptedRoute;
  try{
    globalThis.fetch=async(url,options)=>{
      if(options?.method==='PUT'){
        interruptedRoute=new URL(url).pathname.slice('/api/0/'.length);
        return new Response('synthetic interruption',{status:503});
      }
      return fetchProvider(url,options);
    };
    await assert.rejects(provisionObservability(host,interruptedTarget),/Host observability operation failed/);
  }finally{globalThis.fetch=fetchProvider;}
  assert.ok(interruptedRoute);
  const interrupted=await glitchtip(interruptedRoute),interruptedKeys=await glitchtip(interruptedRoute+'keys/');
  assert.equal(interrupted.name,interrupted.slug);
  // Now lose an acknowledgement after the real provider has committed the rename.
  try{
    globalThis.fetch=async(url,options)=>{
      const response=await fetchProvider(url,options);
      if(options?.method==='PUT'){
        assert.ok(response.ok,'Real rename succeeds before synthetic acknowledgement loss');
        await response.arrayBuffer();
        return new Response('synthetic acknowledgement loss',{status:503});
      }
      return response;
    };
    await assert.rejects(provisionObservability(host,interruptedTarget),/Host observability operation failed/);
  }finally{globalThis.fetch=fetchProvider;}
  assert.equal((await glitchtip(interruptedRoute)).name,'interrupted.capsules.example.test');
  const retried=unsealServerEnv((await provisionObservability(host,interruptedTarget)).env,privateKey);
  const recovered=await glitchtip(interruptedRoute);
  assert.equal(recovered.id,interrupted.id);assert.equal(recovered.slug,interrupted.slug);assert.equal(recovered.name,'interrupted.capsules.example.test');
  assert.ok(JSON.stringify(await glitchtip(interruptedRoute+'keys/'))===JSON.stringify(interruptedKeys),'Retry preserves keys from create');
  assert.deepEqual(unsealServerEnv((await provisionObservability(host,interruptedTarget)).env,privateKey),retried);
  // Human-selected names are not managed defaults.
  const operatorName='Operator-selected disposable Capsule';
  await glitchtip(route,'PUT',{name:operatorName,slug});
  await provisionObservability(host,target);
  assert.equal((await glitchtip(route)).name,operatorName);
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Operator name reconciliation preserves keys');
  const other = unsealServerEnv((await provisionObservability(host,{...target,domain:'another.example.test'})).env,privateKey);
  assert.notEqual(other.ANALYTICS_WEBSITE_ID,values.ANALYTICS_WEBSITE_ID);
  assert.notEqual(other.ERROR_DSN,values.ERROR_DSN);
  const projects=await glitchtip('organizations/sporades/projects/');
  assert.equal(projects.length,3,'Create, migration and retries do not duplicate projects');
  assert.equal(projects.find(p=>p.name==='test.another.example.test')?.id,new URL(other.ERROR_DSN).pathname.slice(1));
  const dsn = new URL(values.ERROR_DSN);
  dsn.protocol='http:'; dsn.hostname='127.0.0.1'; dsn.port=String(observabilityPort(host,'web'));
  const config = { name:'test',observability:{errors:{protocol:'sentry',dsnEnv:'ERROR_DSN',client:true}},analytics:{provider:'umami',endpointEnv:'ANALYTICS_ENDPOINT',websiteIdEnv:'ANALYTICS_WEBSITE_ID'} };
  const runtime = createRuntimeObservability(config,{...values,ERROR_DSN:dsn.href,ANALYTICS_ENDPOINT:`http://127.0.0.1:${observabilityPort(host,'umami')}/api/send`});
  runtime.capture(new Error('disposable observability acceptance'),'query');
  await runtime.flush();
  await runtime.collect({type:'pageview',url:'/acceptance?secret=concealed#fragment'},'https://test.capsules.example.test',{headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'}},{});
  runtime.close();
  process.stdout.write("API provisioning and sealed env verified; awaiting stored events.\n");
  const deadline=Date.now()+90_000;
  let errors=0,views=0;
  do {
    errors=Number(sql('errors-db','glitchtip','SELECT count(*) FROM issue_events_issue'));
    views=Number(sql('analytics-db','umami',"SELECT count(*) FROM website_event WHERE url_path='/acceptance'"));
    if(errors>0&&views>0&&issueIds().split('\n').length>history.split('\n').length)break;
    await new Promise(r=>setTimeout(r,1000));
  }while(Date.now()<deadline);
  assert.ok(errors>0,'GlitchTip stores the runtime error');
  assert.ok(issueIds().split('\n').length>history.split('\n').length,'Original DSN continues ingesting after rename');
  assert.ok(history.split('\n').every(id=>issueIds().split('\n').includes(id)),'Original issue history remains');
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Ingestion and retries retain all keys');
  assert.ok(views>0,'Umami stores the query-free pageview');
  assert.equal((await statusObservability(host)).healthy,true);
  process.stdout.write("Stored error and pageview verified.\n");
  if (process.env.SPORADES_OBSERVABILITY_BACKUP_TEST === '1') {
    const {spawnSync}=await import('node:child_process');
    const {writeFile}=await import('node:fs/promises');
    const {configureHostBackups}=await import('../dist/cli/host-backups.js');
    const passwordFile=path.join(directory,'restic-password');
    await writeFile(passwordFile,'disposable-only',{mode:0o600});
    const policy={repository:path.join(directory,'repository'),passwordFile,schedule:null,retention:2,maxAgeHours:26};
    assert.equal(spawnSync('restic',['init'],{env:{...process.env,RESTIC_REPOSITORY:policy.repository,RESTIC_PASSWORD_FILE:passwordFile}}).status,0);
    await configureHostBackups(host,policy);
    const snapshot=await backupObservability(host);
    assert.equal((await listObservabilityBackups(host)).snapshots.length,1);
    await disableObservability(host,async()=>{});
    const tools=path.join(directory,'restore-tools');
    await mkdir(tools);
    const realDocker=spawnSync('which',['docker'],{encoding:'utf8'}).stdout.trim();
    const failFlag=path.join(tools,'fail-once');
    await writeFile(failFlag,'1');
    await writeFile(path.join(tools,'docker'),`#!/usr/bin/env node\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('pg_restore')&&args.includes('analytics-db')&&fs.existsSync(${JSON.stringify(failFlag)})){fs.unlinkSync(${JSON.stringify(failFlag)});process.exit(1);}const r=spawnSync(${JSON.stringify(realDocker)},args,{stdio:['inherit','inherit','pipe']});if(r.status!==0)fs.writeFileSync(${JSON.stringify(path.join(directory,'restore-diagnostic.log'))},r.stderr??'',{mode:0o600});process.exit(r.status??1);\n`,{mode:0o755});
    const originalPath=process.env.PATH;
    try {
      process.env.PATH=`${tools}${path.delimiter}${originalPath}`;
      await assert.rejects(restoreObservability(host,snapshot.id,'observability'),/dump operation failed/);
      await assert.rejects(enableObservability(host,async()=>{}),/interrupted service restore/);
      await assert.rejects(restoreObservability(host,'f'.repeat(64),'observability'));
      assert.equal((await restoreObservability(host,snapshot.id,'observability')).restored,true);
    } finally {process.env.PATH=originalPath;}
    process.stdout.write('Real restic snapshots and interrupted database restore recovery verified.\n');
  }
  await disableObservability(host,async()=>{});
  assert.equal((await provisionObservability(host,target)).connected,false);
  await disableObservability(host,async()=>{});
  await enableObservability(host,async()=>{});
  assert.equal((await statusObservability(host)).healthy,true);
  assert.ok(Number(sql('errors-db','glitchtip','SELECT count(*) FROM issue_events_issue'))>0);
  assert.ok(Number(sql('analytics-db','umami',"SELECT count(*) FROM website_event WHERE url_path='/acceptance'"))>0);
  assert.deepEqual(unsealServerEnv((await provisionObservability(host,target)).env,privateKey),values);
  await disableObservability(host,async()=>{},true);
  assert.ok(await readFile(path.join(observabilityDirectory(host),'secrets.json')));
  process.stdout.write('PASS: real pinned providers, readable names with preserved IDs/slugs/keys/history, rename retries, operator names, no duplicate projects, isolated identities, sealed env, continued DSN ingestion + pageview, disable/re-enable/uninstall.\n');
} finally {
  try { observabilityDocker(host,['down','--volumes','--remove-orphans']); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
