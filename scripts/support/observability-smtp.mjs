import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { configureObservabilityMail } from '../../dist/cli/host-observability-mail.js';
import { applyObservabilityMail, observabilityDocker, observabilityPort, observabilityProject } from '../../dist/cli/host-observability.js';

export async function smtpAcceptance(host) {
 const directory=path.join(host.remoteRoot,'smtp-receiver');await mkdir(directory,{mode:0o700});
 const mail={version:1,transport:'smtp-ssl',host:'smtp.example.test',port:465,username:'synthetic@example.test',password:'synthetic@:/?#%$! space',from:'alerts@example.test'};
 const staged=path.join(directory,'receiver.json');await writeFile(staged,JSON.stringify(mail),{mode:0o600});
 await configureObservabilityMail(host,staged);
 const run=(cmd,args,input)=>{
  const r=spawnSync(cmd,args,{input,encoding:'utf8',timeout:120000});
  assert.equal(r.status,0,`${cmd} acceptance fixture command failed (diagnostics omitted)`);return r.stdout;
 };
 run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=smtp.example.test','-addext','subjectAltName=DNS:smtp.example.test','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem')]);
 let started=false, checkedUntrusted=false;
 const name=`sporades-ken-smtp-${path.basename(host.remoteRoot).toLowerCase()}`;
 const hostPath=p=>process.env.SPORADES_TEST_HOST_WORKTREE?p.replace(process.cwd(),process.env.SPORADES_TEST_HOST_WORKTREE):p;
 const docker=args=>run('docker',args);
 const ca=await readFile(path.join(directory,'cert.pem'));
 const shell=(role,code,input)=>observabilityDocker(host,['exec','-T',role,'./manage.py','shell','-c',code],input);
 const secureCheck=`from django.conf import settings\nfrom django.core.mail import get_connection\nimport ssl\nassert settings.EMAIL_USE_SSL and not settings.EMAIL_USE_TLS\nassert settings.EMAIL_PORT==465\nassert settings.DEFAULT_FROM_EMAIL=='alerts@example.test'\ntry:\n get_connection().open()\nexcept ssl.SSLCertVerificationError:\n pass\nelse:\n raise RuntimeError('Untrusted certificate was accepted')\n`;
 return {
  async start(){
   docker(['run','-d','--name',name,'--network',`${observabilityProject(host)}_default`,'--network-alias',mail.host,'--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,source=${hostPath(directory)},target=/fixture`,'--mount',`type=bind,source=${hostPath(path.join(process.cwd(),'test/support/tls-smtp-receiver.mjs'))},target=/receiver.mjs,readonly`,'node:24.22.1-bookworm-slim','node','/receiver.mjs','/fixture']);
   started=true;
   for(let i=0;i<30;i++){
    if(docker(['logs',name]).includes('ready'))return;
    await new Promise(r=>setTimeout(r,1000));
   }
   assert.fail('Isolated receiver startup timed out');
  },
  async trust(){
   for(const role of ['web','worker']){
    if(!checkedUntrusted) shell(role,secureCheck);
    // Trust only this disposable receiver's CA in these disposable containers.
    observabilityDocker(host,['exec','-T','--user','0',role,'python','-c',"import sys,ssl;open(ssl.get_default_verify_paths().cafile,'ab').write(sys.stdin.buffer.read())"],ca);
    const opened=shell(role,`from django.core.mail import get_connection\ntry:\n c=get_connection();assert c.open();c.close();print('SMTP_ACCEPTANCE_OPEN')\nexcept Exception as e:\n print('SMTP_ACCEPTANCE_ERROR_'+type(e).__name__)\n`).toString();
    assert.ok(opened.includes('SMTP_ACCEPTANCE_OPEN'),opened.match(/SMTP_ACCEPTANCE_ERROR_[A-Za-z]+/)?.[0]??'SMTP open failed (diagnostics omitted)');
   }
   checkedUntrusted=true;
  },
  async apply(){
   const others=['errors-db','analytics-db','valkey','umami'];
   const before=others.map(role=>observabilityDocker(host,['ps','-q',role]).toString().trim());
   const port=observabilityPort(host,"web");
   await applyObservabilityMail(host);
   assert.equal(observabilityPort(host,"web"),port);
   assert.deepEqual(others.map(role=>observabilityDocker(host,['ps','-q',role]).toString().trim()),before);
   checkedUntrusted=false;
  },
  async rotate(){
   mail.password+='-rotated';
   await writeFile(staged,JSON.stringify(mail));
   await configureObservabilityMail(host,staged);
  },
  async notify(){
   const before=await readFile(path.join(directory,'accepted.jsonl'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
   // Use GlitchTip's real alert task and templates for a stored issue; the worker
   // must resolve subscribed team members and deliver through the configured backend.
   shell('web',`from apps.issue_events.models import Issue\nfrom apps.alerts.models import ProjectAlert,Notification\nfrom apps.alerts.tasks import send_notification\nfrom apps.organizations_ext.models import OrganizationUser\nfrom django.contrib.auth import get_user_model\ni=Issue.objects.first();p=i.project\nu=get_user_model().objects.get(email='ops@${host.domain}');u.subscribe_by_default=True;u.save()\nou,_=OrganizationUser.objects.get_or_create(user=u,organization=p.organization)\nfor team in p.teams.all(): ou.teams.add(team)\na=ProjectAlert.objects.create(project=p,name='Synthetic SMTP acceptance')\nn=Notification.objects.create(project_alert=a);n.issues.add(i)\nassert get_user_model().objects.alert_notification_recipients(n).exists()\nsend_notification.delay(n.pk)\n`);
   const deadline=Date.now()+60000;
   while(Date.now()<deadline){
    const after=await readFile(path.join(directory,'accepted.jsonl'),'utf8').catch(()=> '');
    if(after.length>before.length){
     const accepted=JSON.parse(after.trim().split('\n').at(-1));
     assert.match(accepted.body,/X-Mailer: GlitchTip/);assert.match(accepted.body,/From: alerts@example.test/);assert.match(accepted.body,/disposable observability acceptance/);
     process.stdout.write('Authenticated TLS SMTP accepted a real GlitchTip worker notification (synthetic receiver only).\n');return;
    }
    await new Promise(r=>setTimeout(r,1000));
   }
   assert.fail('GlitchTip worker notification was not accepted by the isolated SMTP receiver');
  },
  async stop(){if(started){docker(['rm','-f',name]);started=false;}},
 };
}
