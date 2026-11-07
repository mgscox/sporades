// Disposable LOCAL Docker acceptance. Never connects to a Host, SSH or cloud.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { enableObservability, disableObservability, provisionObservability, statusObservability, observabilityDocker, observabilityPort, observabilityDirectory, observabilityProject, readObservabilityState, backupObservability, listObservabilityBackups, restoreObservability } from '../dist/cli/host-observability.js';
import { createRuntimeObservability } from '../dist/observability-runtime.js';
import { unsealServerEnv } from '../dist/sealed-server-env.js';
import { startCollectionCapsule, assertCollectionBusinessSemantics, emitCollectionBrowserFailures } from '../test/support/collection-capsule.mjs';
const scratch = path.join(process.cwd(), '.sporades');
await mkdir(scratch, {recursive:true});
const directory = await mkdtemp(path.join(scratch, 'observe-acceptance-'));
const host = { alias:'disposable-local', domain:'observability.example.test', scheme:'https', remoteRoot:directory };
// Never inherit a remote Docker context or workstation profile for this local drill.
process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete process.env[key];
process.env.SPORADES_CONFIG_DIR = path.join(directory, 'config');
process.env.COMPOSE_PROJECT_NAME = observabilityProject(host);
const cleanup = [];
const fixture = { after: callback => cleanup.push(callback) };
const marker = `acceptance-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const {publicKey,privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const target = { domain:'capsules.example.test', subname:'test', errors:true, analytics:true, publicKey };
let smtp = null;
// Provider operations are retryable by identity; tolerate bounded local startup pressure.
async function provision(target) {
  for (let attempt=0;;attempt++) {
    try { return await provisionObservability(host,target); }
    catch (error) { if(attempt===2) throw error; await new Promise(resolve=>setTimeout(resolve,1000)); }
  }
}
const sql = (service,user,query,deadline) => {
  const args = ['exec','-T',...(deadline === undefined ? [] : ['-e','PGOPTIONS=-c statement_timeout=5000']),service,'psql','-U',user,'-d',user,'-tAc',query];
  if (deadline === undefined) return observabilityDocker(host,args).toString().trim();
  try {
    return execFileSync('docker',['compose','--project-name',observabilityProject(host),'--file',path.join(observabilityDirectory(host),'compose.json'),
      ...args],{timeout:Math.max(1,Math.min(10_000,deadline-Date.now())),killSignal:'SIGKILL',maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}).toString().trim();
  } catch (error) { throw new Error(`Disposable provider database query failed (${error.code ?? error.status ?? 'unknown'}); provider diagnostics omitted.`); }
};
try {
  if (process.env.SPORADES_OBSERVABILITY_SMTP_TEST === '1') smtp = await (await import('./support/observability-smtp.mjs')).smtpAcceptance(host, marker);
  fixture.after(() => smtp?.stop());
  // Fail after provider initialization and prove retry converges without resetting credentials.
  await assert.rejects(enableObservability(host, async()=>{throw new Error('simulated Caddy failure');}), /simulated/);
  process.stdout.write("Provider bootstrap recovery verified.\n");
  const first = await enableObservability(host, async ports => { assert.ok(ports.errors); assert.ok(ports.analytics); });
  assert.ok(first.credentials);
  await smtp?.start();
  const second = await enableObservability(host, async()=>{});
  assert.equal(second.credentials, undefined);
  process.stdout.write("Repeated enable verified.\n");
  await smtp?.trust();
  // Caddy terminates HTTPS and forwards HTTP: a valid browser CSRF token must
  // pass the exact public Origin check even though the upstream hop is HTTP.
  const csrfCheck=`from django.test import RequestFactory\nfrom django.middleware.csrf import CsrfViewMiddleware,get_token\nfrom django.http import HttpResponse\nr=RequestFactory().post('/',HTTP_HOST='errors.${host.domain}',HTTP_ORIGIN='https://errors.${host.domain}')\ntoken=get_token(r)\nr.COOKIES['csrftoken']=r.META['CSRF_COOKIE']\nr.META['HTTP_X_CSRFTOKEN']=token\nview=lambda request:HttpResponse()\nassert CsrfViewMiddleware(view).process_view(r,view,(),{}) is None\n`;
  observabilityDocker(host,['exec','-T','web','./manage.py','shell','-c',csrfCheck]);
  const token=(await readObservabilityState(host)).secrets.token;
  const providerOrigin=`http://127.0.0.1:${observabilityPort(host,'web')}`;
  const glitchtip=async(route,method='GET',body)=>{
    const response=await fetch(providerOrigin+'/api/0/'+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000),redirect:'error'});
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
  await sendError(`disposable legacy history ${marker}`,originalKeys[0].dsn.public);
  const historyDeadline=Date.now()+90_000;
  while(!issueIds()&&Date.now()<historyDeadline)await new Promise(r=>setTimeout(r,1000));
  const history=issueIds();assert.ok(history,'Legacy DSN stores an issue before migration');
  const connection = await provision(target);
  const values = unsealServerEnv(connection.env,privateKey);
  const renamed=await glitchtip(route);
  assert.equal(renamed.id,legacy.id);assert.equal(renamed.slug,slug);assert.equal(renamed.name,'test.capsules.example.test');
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Migration preserves complete key responses');
  assert.equal(issueIds(),history,'Migration preserves issue history');
  const again = await provision(target);
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
  const retried=unsealServerEnv((await provision(interruptedTarget)).env,privateKey);
  const recovered=await glitchtip(interruptedRoute);
  assert.equal(recovered.id,interrupted.id);assert.equal(recovered.slug,interrupted.slug);assert.equal(recovered.name,'interrupted.capsules.example.test');
  assert.ok(JSON.stringify(await glitchtip(interruptedRoute+'keys/'))===JSON.stringify(interruptedKeys),'Retry preserves keys from create');
  assert.deepEqual(unsealServerEnv((await provision(interruptedTarget)).env,privateKey),retried);
  // Human-selected names are not managed defaults.
  const operatorName='Operator-selected disposable Capsule';
  await glitchtip(route,'PUT',{name:operatorName,slug});
  await provision(target);
  assert.equal((await glitchtip(route)).name,operatorName);
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Operator name reconciliation preserves keys');
  const other = unsealServerEnv((await provision({...target,domain:'another.example.test'})).env,privateKey);
  assert.notEqual(other.ANALYTICS_WEBSITE_ID,values.ANALYTICS_WEBSITE_ID);
  assert.notEqual(other.ERROR_DSN,values.ERROR_DSN);
  const projects=await glitchtip('organizations/sporades/projects/');
  assert.equal(projects.length,3,'Create, migration and retries do not duplicate projects');
  assert.equal(projects.find(p=>p.name==='test.another.example.test')?.id,new URL(other.ERROR_DSN).pathname.slice(1));
  const dsn = new URL(values.ERROR_DSN);
  dsn.protocol='http:'; dsn.hostname='127.0.0.1'; dsn.port=String(observabilityPort(host,'web'));
  const projectId = dsn.pathname.slice(1);
  assert.match(projectId, /^\d+$/);
  const config = { name:'test',release:{id:marker},observability:{errors:{protocol:'sentry',dsnEnv:'ERROR_DSN',client:true,environment:'local-acceptance'}},analytics:{provider:'umami',endpointEnv:'ANALYTICS_ENDPOINT',websiteIdEnv:'ANALYTICS_WEBSITE_ID'} };
  const serverEnv = {...values,ERROR_DSN:dsn.href,ANALYTICS_ENDPOINT:`http://127.0.0.1:${observabilityPort(host,'umami')}/api/send`};
  const { origin } = await startCollectionCapsule(fixture, { config, serverEnv, failureMarker: marker });
  const failureBody = await assertCollectionBusinessSemantics(origin);
  const browserMarkers = await emitCollectionBrowserFailures(fixture, origin, marker);
  process.stdout.write('Real generated Capsule HTTP failure, rollback, subsequent commits and browser hooks exercised.\n');
  // Keep lower-level envelope coverage, with a distinct marker and evidence.
  const runtime = createRuntimeObservability(config,serverEnv);
  fixture.after(() => runtime.close());
  runtime.capture(new Error(`${marker}-direct`),'query');
  await runtime.flush();
  await runtime.collect({type:'pageview',url:'/acceptance?secret=concealed#fragment'},'https://test.capsules.example.test',{headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'}},{});
  runtime.close();
  process.stdout.write("API provisioning and sealed env verified; awaiting stored events.\n");
  const deadline=Date.now()+90_000;
  let events=[],views=0;
  do {
    // GlitchTip v5.2.1 stores full event data separately from grouped Issue totals.
    events=JSON.parse(sql('errors-db','glitchtip',`SELECT COALESCE(json_agg(json_build_object('project', i.project_id, 'message', e.data #>> '{exception,values,0,value}', 'tags', e.tags, 'release', r.version, 'data', e.data)), '[]'::json) FROM issue_events_issueevent e JOIN issue_events_issue i ON i.id=e.issue_id LEFT JOIN releases_release r ON r.id=e.release_id WHERE e.data #>> '{exception,values,0,value}' LIKE '${marker}%'`,deadline));
    views=Number(sql('analytics-db','umami',"SELECT count(*) FROM website_event WHERE url_path='/acceptance'",deadline));
    if(events.length>=4&&views>0)break;
    await new Promise(r=>setTimeout(r,1000));
  }while(Date.now()<deadline);
  assert.equal(events.length,4,'GlitchTip stores the exact runtime, browser and direct-capture events');
  for (const [eventMarker, surface, platform] of [[marker,'endpoint','node'],...browserMarkers.map(value=>[value,'client','javascript']),[`${marker}-direct`,'query','node']]) {
    const matching = events.filter(event => event.message === eventMarker || event.message.startsWith(eventMarker + ' '));
    assert.equal(matching.length,1,`Exact ${surface} event stored once`);
    const event = matching[0];
    assert.equal(String(event.project),projectId);
    assert.equal(event.tags.surface,surface);
    assert.equal(event.tags.capsule,config.name);
    assert.equal(event.release,config.release.id);
    assert.equal(event.tags.environment,'local-acceptance');
    assert.equal(event.data.environment,'local-acceptance');
    assert.equal(event.data.platform,platform);
    if(surface==='client') {
      assert.match(event.message,/REDACTED/);
      // This pinned provider normalizes browser stack filenames to URL paths.
      assert.deepEqual(event.data.exception.values[0].stacktrace.frames.map(frame=>frame.filename),['/client.js']);
    }
  }
  assert.doesNotMatch(JSON.stringify(events),/synthetic-(password|query|fragment|stack|location)/);
  assert.ok(issueIds().split('\n').length>history.split('\n').length,'Original DSN continues ingesting after rename');
  assert.ok(history.split('\n').every(id=>issueIds().split('\n').includes(id)),'Original issue history remains');
  assert.ok(JSON.stringify(await glitchtip(route+'keys/'))===JSON.stringify(originalKeys),'Ingestion and retries retain all keys');
  assert.ok(views>0,'Umami stores the query-free pageview');
  assert.equal((await statusObservability(host)).healthy,true);
  process.stdout.write('Stored exact endpoint failure and browser error/rejection verified in the provisioned GlitchTip project, with Capsule/release/environment and redaction; direct capture verified separately. Umami pageview stored.\n');
  await smtp?.apply();
  await smtp?.trust();
  await smtp?.notify();
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
    await smtp?.rotate(); // Restore must retain the destination credential, not a snapshot-era value.
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
  assert.equal(await assertCollectionBusinessSemantics(origin,2),failureBody,'Provider outage preserves the same opaque failure and rollback/commit semantics');
  const dormant = await startCollectionCapsule(fixture, { config:{name:'no-integration-acceptance'}, serverEnv:{} });
  assert.equal(await assertCollectionBusinessSemantics(dormant.origin),failureBody);
  assert.equal((await fetch(dormant.origin+'/__sporades/observe.js',{signal:AbortSignal.timeout(5000)})).status,404);
  assert.equal((await fetch(dormant.origin+'/__sporades/collect',{method:'POST',signal:AbortSignal.timeout(5000)})).status,404);
  process.stdout.write('Provider stopped and no-integration Capsules preserve opaque failures, rollback, later commits and health.\n');
  assert.equal((await provision(target)).connected,false);
  await disableObservability(host,async()=>{});
  await enableObservability(host,async()=>{});
  assert.equal((await statusObservability(host)).healthy,true);
  await smtp?.trust();
  await smtp?.notify();
  assert.ok(Number(sql('errors-db','glitchtip','SELECT count(*) FROM issue_events_issue'))>0);
  assert.ok(Number(sql('analytics-db','umami',"SELECT count(*) FROM website_event WHERE url_path='/acceptance'"))>0);
  assert.deepEqual(unsealServerEnv((await provision(target)).env,privateKey),values);
  await smtp?.stop();
  await disableObservability(host,async()=>{},true);
  assert.ok(await readFile(path.join(observabilityDirectory(host),'secrets.json')));
  process.stdout.write('PASS: real pinned providers, generated Capsule handler capture, browser error/rejection redaction, exact project events, independent direct capture, rollback/commit/outage/no-integration semantics, readable names with preserved IDs/slugs/keys/history, rename retries, operator names, no duplicate projects, isolated sealed identities, continued DSN ingestion, pageview, disable/re-enable/uninstall.\n');
} finally {
  try {
    try {
      const results = await Promise.allSettled(cleanup.reverse().map(callback => Promise.resolve().then(callback)));
      assert.ok(results.every(result => result.status === 'fulfilled'),'Synthetic Capsule cleanup completed');
    }
    finally { observabilityDocker(host,['down','--volumes','--remove-orphans']); }
  }
  finally { await rm(directory,{recursive:true,force:true}); }
}
