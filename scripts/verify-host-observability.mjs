// Disposable LOCAL Docker acceptance. Never connects to a Host, SSH or cloud.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { enableObservability, disableObservability, provisionObservability, statusObservability, observabilityDocker, observabilityPort, observabilityDirectory, backupObservability, listObservabilityBackups, restoreObservability } from '../dist/cli/host-observability.js';
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
  const connection = await provisionObservability(host,target);
  const values = unsealServerEnv(connection.env,privateKey);
  const again = await provisionObservability(host,target);
  assert.deepEqual(unsealServerEnv(again.env,privateKey),values);
  const other = unsealServerEnv((await provisionObservability(host,{...target,domain:'another.example.test'})).env,privateKey);
  assert.notEqual(other.ANALYTICS_WEBSITE_ID,values.ANALYTICS_WEBSITE_ID);
  assert.notEqual(other.ERROR_DSN,values.ERROR_DSN);
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
    if(errors>0&&views>0)break;
    await new Promise(r=>setTimeout(r,1000));
  }while(Date.now()<deadline);
  assert.ok(errors>0,'GlitchTip stores the runtime error');
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
  process.stdout.write('PASS: real pinned providers, interrupted enable recovery, idempotence, isolated identities, sealed env, stored runtime error + pageview, disable/re-enable/uninstall.\n');
} finally {
  try { observabilityDocker(host,['down','--volumes','--remove-orphans']); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
