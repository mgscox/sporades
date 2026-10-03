import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
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
for (const session of ['container', 'hosted']) {
test(`real generated ${session} session enforces immutable read-only policy generations across reload and restart`, {skip:!enabled,timeout:120000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'sporades-admission-container-'));
  const containers = [];
  const app = `import {capsule,endpoint} from 'sporades/server'; export default capsule({name:'admission-acceptance',schema:{},endpoints:{
    blocked:endpoint({path:'/blocked',method:'GET'},async()=>{globalThis.process.getBuiltinModule('node:fs').appendFileSync('/app/data/app-called','called\\n');return {status:200,body:'unchanged app bytes'};}),
    allowed:endpoint({path:'/allowed',method:'POST'},ctx=>({status:201,headers:{'x-application':'unchanged'},body:{method:ctx.request.method,path:ctx.request.path,query:ctx.request.query.source,header:ctx.request.headers['x-source'],body:ctx.request.body}}))
  }});`;
  try {
    const serverModuleSource = await bundleServerCapsuleModule({serverSource:app,serverSourcePath:path.join(root,'server','index.ts')});
    const source = await createServerBundleModuleSource({config:{name:'admission-acceptance',admissionPolicy:{path:'policy.json'}},serverEnv:{},serverSource:app,serverModuleSource});
    await writeFile(path.join(root,'server.mjs'),source);
    const storage = path.join(root,'policy'); await mkdir(storage); await chmod(storage,0o755);
    const target = preservedDeployFilePath(storage,'policy.json'); await writeFile(target,policy('initial'),{mode:0o444}); await chmod(target,0o444);
    const publicDir = path.join(root,'public'); await mkdir(publicDir); await writeFile(path.join(publicDir,'index.html'),'plain bytes');
      const data = path.join(root,session); await mkdir(data); await chmod(data,0o777);
      const marker = path.join(data,'app-called');
      const name = `sporades-admission-${session}-${randomBytes(5).toString('hex')}`; containers.push(name);
      await run('docker',['run','-d','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',baseImageRuntimeUser(),'--tmpfs','/tmp:rw,nosuid,nodev,noexec','-p','127.0.0.1::5688','-v',`${root}/server.mjs:/app/server.mjs:ro`,'-v',`${publicDir}:/app/public:ro`,'-v',`${data}:/app/data:rw`,'-v',`${storage}:/run/sporades-admission:ro`,'-w','/app','-e','PORT=5688','-e',`SPORADES_SECURITY_SESSION=${session}`,'-e','SPORADES_ADMISSION_POLICY_PATH=policy.json','-e',`SPORADES_RUNTIME_PROBE_TOKEN=${'a'.repeat(64)}`,baseImageMetadata().image],{timeout:60000});
      const bound = (await run('docker',['port',name,'5688/tcp'])).stdout.trim(); let origin = `http://${bound}`;
      const health = async () => (await (await fetch(`${origin}/__sporades/health/runtime`,{headers:{'x-sporades-host-probe':'a'.repeat(64)}})).json()).data.runtime.admissionPolicy;
      const wait = async predicate => { const deadline=Date.now()+9000; while(Date.now()<deadline) { try { if(await predicate()) return; } catch {} await new Promise(resolve=>setTimeout(resolve,100)); } assert.fail(`policy did not converge: ${(await run('docker',['logs',name])).stderr}`); };
      const denied = async () => {
        const response = await fetch(`${origin}/blocked?private=opaque`);
        assert.equal(response.status,403);
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('content-length'),'10');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from('Forbidden\n'));
        await assert.rejects(readFile(marker),{code:'ENOENT'});
      };
      const allowed = async () => {
        const response = await fetch(`${origin}/allowed?source=unchanged`,{method:'POST',headers:{'x-source':'original','content-type':'application/json'},body:JSON.stringify({text:'untouched bytes'})});
        assert.equal(response.status,201);
        assert.equal(response.headers.get('x-application'),'unchanged');
        assert.deepEqual(await response.json(),{method:'POST',path:'/allowed',query:'unchanged',header:'original',body:{text:'untouched bytes'}});
      };
      const admitted = async () => {
        const response = await fetch(`${origin}/blocked`);
        assert.equal(response.status,200);
        assert.equal(await response.text(),'unchanged app bytes');
        assert.equal(await readFile(marker,'utf8'),'called\n');
        await rm(marker);
      };
      const restart = async () => {
        await run('docker',['restart',name]);
        origin = `http://${(await run('docker',['port',name,'5688/tcp'])).stdout.trim()}`;
      };
      await wait(async()=> (await health()).state==='healthy');
      await denied(); await allowed();
      await assert.rejects(run('docker',['exec',name,'node','-e',`require('node:fs').writeFileSync('/run/sporades-admission/${path.basename(target)}','tamper')`]),error=>{assert.match(error.stderr,/EROFS|EACCES/);return true;});
      const old = (await health()).digest;
      await chmod(target,0o644); await writeFile(target,'{'); await chmod(target,0o444);
      await wait(async()=> (await health()).state==='degraded'); assert.equal((await health()).digest,old);
      await denied(); await allowed();
      const next = policy(`updated-${session}`); await publishAdmissionPolicy(storage,'policy.json',next);
      await wait(async()=> (await health()).digest===parseAdmissionPolicy(next).digest && (await health()).state==='healthy');
      await denied(); await allowed();
      await restart();
      await wait(async()=> (await health()).digest===parseAdmissionPolicy(next).digest && (await health()).state==='healthy');
      await denied(); await allowed();
      await publishAdmissionPolicy(storage,'policy.json',null); await wait(async()=> (await health()).state==='disabled');
      assert.equal((await health()).digest,null); await admitted(); await allowed();
      await restart(); await wait(async()=> (await health()).state==='disabled');
      assert.equal((await health()).digest,null); await admitted(); await allowed();
      await publishAdmissionPolicy(storage,'policy.json',policy('initial')); await wait(async()=> (await health()).state==='healthy');
      await denied();
      await run('docker',['stop',name]);
      await chmod(target,0o644); await writeFile(target,'{'); await chmod(target,0o444);
      await run('docker',['start',name]);
      await wait(async()=> (await run('docker',['inspect','--format','{{.State.Status}}',name])).stdout.trim()==='exited');
      assert.equal((await run('docker',['inspect','--format','{{.State.ExitCode}}',name])).stdout.trim(),'1');
      await assert.rejects(fetch(`${origin}/blocked`));
      assert.match((await run('docker',['logs',name])).stderr,/Configured admission policy could not be loaded/);
      await run('docker',['rm','-f',name]); containers.splice(containers.indexOf(name),1);
  } finally { for (const name of containers) await run('docker',['rm','-f',name]).catch(()=>{}); await rm(root,{recursive:true,force:true}); }
});
}
