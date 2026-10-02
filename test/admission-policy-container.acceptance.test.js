import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { publishAdmissionPolicy, parseAdmissionPolicy } from '../dist/admission-policy.js';
import { preservedDeployFilePath } from '../dist/deploy-files.js';
import { baseImageMetadata, baseImageRuntimeUser } from '../dist/base-image.js';
const run = promisify(execFile);
const enabled = process.env.SPORADES_REAL_ADMISSION_CONTAINER === '1';
const policy = id => Buffer.from(JSON.stringify({version:1,rules:[{id,enabled:true,conditions:[{kind:'pathname',exact:'/blocked'}],action:{kind:'deny'}}]}));
test('real generated Container and Hosted sessions load immutable read-only policy generations', {skip:!enabled,timeout:120000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'sporades-admission-container-'));
  const containers = [];
  const app = `import {capsule,endpoint} from 'sporades/server'; export default capsule({name:'admission-acceptance',schema:{},endpoints:{blocked:endpoint({path:'/blocked',method:'GET'},async()=>({status:200,body:'unchanged app bytes'}))}});`;
  try {
    const serverModuleSource = await bundleServerCapsuleModule({serverSource:app,serverSourcePath:path.join(root,'server','index.ts')});
    const source = await createServerBundleModuleSource({config:{name:'admission-acceptance',admissionPolicy:{path:'policy.json'}},serverEnv:{},serverSource:app,serverModuleSource});
    await writeFile(path.join(root,'server.mjs'),source);
    const storage = path.join(root,'policy'); await mkdir(storage); await chmod(storage,0o755);
    const target = preservedDeployFilePath(storage,'policy.json'); await writeFile(target,policy('initial'),{mode:0o444}); await chmod(target,0o444);
    const publicDir = path.join(root,'public'); await mkdir(publicDir); await writeFile(path.join(publicDir,'index.html'),'plain bytes');
    for (const session of ['container','hosted']) {
      const data = path.join(root,session); await mkdir(data); await chmod(data,0o777);
      const name = `sporades-admission-${session}-${randomBytes(5).toString('hex')}`; containers.push(name);
      await run('docker',['run','-d','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',baseImageRuntimeUser(),'--tmpfs','/tmp:rw,nosuid,nodev,noexec','-p','127.0.0.1::5688','-v',`${root}/server.mjs:/app/server.mjs:ro`,'-v',`${publicDir}:/app/public:ro`,'-v',`${data}:/app/data:rw`,'-v',`${storage}:/run/sporades-admission:ro`,'-w','/app','-e','PORT=5688','-e',`SPORADES_SECURITY_SESSION=${session}`,'-e','SPORADES_ADMISSION_POLICY_PATH=policy.json','-e',`SPORADES_RUNTIME_PROBE_TOKEN=${'a'.repeat(64)}`,baseImageMetadata().image],{timeout:60000});
      const bound = (await run('docker',['port',name,'5688/tcp'])).stdout.trim(); let origin = `http://${bound}`;
      const health = async () => (await (await fetch(`${origin}/__sporades/health/runtime`,{headers:{'x-sporades-host-probe':'a'.repeat(64)}})).json()).data.runtime.admissionPolicy;
      const wait = async predicate => { const deadline=Date.now()+9000; while(Date.now()<deadline) { try { if(await predicate()) return; } catch {} await new Promise(resolve=>setTimeout(resolve,100)); } assert.fail(`policy did not converge: ${(await run('docker',['logs',name])).stderr}`); };
      await wait(async()=> (await health()).state==='healthy');
      assert.equal(await (await fetch(`${origin}/blocked`)).text(),'unchanged app bytes');
      await assert.rejects(run('docker',['exec',name,'node','-e',`require('node:fs').writeFileSync('/run/sporades-admission/${path.basename(target)}','tamper')`]),error=>{assert.match(error.stderr,/EROFS|EACCES/);return true;});
      const old = (await health()).digest;
      await chmod(target,0o644); await writeFile(target,'{'); await chmod(target,0o444);
      await wait(async()=> (await health()).state==='degraded'); assert.equal((await health()).digest,old);
      const next = policy(`updated-${session}`); await publishAdmissionPolicy(storage,'policy.json',next);
      await wait(async()=> (await health()).digest===parseAdmissionPolicy(next).digest && (await health()).state==='healthy');
      await publishAdmissionPolicy(storage,'policy.json',null); await wait(async()=> (await health()).state==='disabled');
      await run('docker',['restart',name]); origin = `http://${(await run('docker',['port',name,'5688/tcp'])).stdout.trim()}`; await wait(async()=> (await health()).state==='disabled');
      await publishAdmissionPolicy(storage,'policy.json',policy('initial')); await wait(async()=> (await health()).state==='healthy');
      await run('docker',['stop',name]);
      await chmod(target,0o644); await writeFile(target,'{'); await chmod(target,0o444);
      await run('docker',['start',name]);
      await wait(async()=> (await run('docker',['inspect','--format','{{.State.Status}}',name])).stdout.trim()==='exited');
      assert.equal((await run('docker',['inspect','--format','{{.State.ExitCode}}',name])).stdout.trim(),'1');
      await assert.rejects(fetch(`${origin}/blocked`));
      assert.match((await run('docker',['logs',name])).stderr,/Configured admission policy could not be loaded/);
      await publishAdmissionPolicy(storage,'policy.json',policy('initial'));
      await run('docker',['rm','-f',name]); containers.splice(containers.indexOf(name),1);
    }
  } finally { for (const name of containers) await run('docker',['rm','-f',name]).catch(()=>{}); await rm(root,{recursive:true,force:true}); }
});
