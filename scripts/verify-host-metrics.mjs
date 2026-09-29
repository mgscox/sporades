// Destructive acceptance against a disposable VM only; hostname assertion precedes mutations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import {execFileSync,spawn} from 'node:child_process';
const root=process.env.SPORADES_HOST_METRICS_TEST_ROOT;
assert(root, 'Set SPORADES_HOST_METRICS_TEST_ROOT to a prepared disposable acceptance directory.');
const evidence=process.env.SPORADES_HOST_METRICS_TEST_EVIDENCE ?? root+'/evidence';
fs.mkdirSync(evidence,{recursive:true});
const exec=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',timeout:180000,...opts}).trim();
const ssh=(s)=>exec('ssh',['-F',root+'/ssh_config','sporades119',s]);
const cli=(...args)=>{const text=exec(root+'/cli',args);const r=JSON.parse(text);assert(r.ok,JSON.stringify(r.error));return r.data;};
const creds=JSON.parse(fs.readFileSync(root+'/monitoring/.private/credentials.json'));
const ca=fs.readFileSync(root+'/certs/cert.pem');
const query=expr=>new Promise((resolve,reject)=>{const u=new URL('/grafana/api/datasources/proxy/uid/sporades-prometheus/api/v1/query',process.env.SPORADES_HOST_METRICS_TEST_URL);u.searchParams.set('query',expr);https.get(u,{agent:false,ca,auth:creds.uiUser+':'+creds.uiPassword},r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{try{const d=JSON.parse(s);assert.equal(d.status,'success');resolve(d.data.result);}catch(e){reject(e);}});}).on('error',reject);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,seconds=65){const end=Date.now()+seconds*1000;do{const result=await f();if(result)return result;await delay(3000);}while(Date.now()<end);throw Error('Acceptance condition timed out');}
const proof={startedAt:new Date().toISOString(),checks:[]};
function passed(name,data={}){proof.checks.push({name,at:new Date().toISOString(),...data});fs.writeFileSync(evidence+'/acceptance.json',JSON.stringify(proof,null,2));console.log(name);}
assert.equal(ssh('hostname'),'sporades-119-test');
const identity='sporades_host="acceptance119.example"';
const sumValue=r=>r.reduce((n,x)=>n+Number(x.value[1]),0);
let status=cli('host','telemetry','status','--host','acceptance','--json');assert.equal(status.resources.psi,'supported');
const up=await until(async()=>{const r=await query(`up{${identity}}`);return r.length===2&&r.every(x=>x.value[1]==='1')&&r;});passed('Separate-machine scrape-to-storage', {sources:up});
const mem=await query(`node_memory_MemTotal_bytes{${identity}}`);assert.equal(sumValue(mem),Number(ssh("awk '/^MemTotal:/ {print $2*1024}' /proc/meminfo")));assert(sumValue(mem)>1024**3);
const disk=await query(`node_filesystem_size_bytes{${identity},mountpoint="/srv/119-data"}`);assert.equal(disk.length,1);assert(Number(disk[0].value[1])>90*1024**2);passed('Actual Host memory and separate mounted volume', {ram:mem,volume:disk});
const before=ssh('sha256sum /srv/sporades/caddy/Caddyfile; docker inspect --format "{{.State.StartedAt}}" sporades-telemetry-relay sporades-node-exporter');
cli('host','telemetry','reconcile','--host','acceptance','--json');cli('host','bootstrap','--host','acceptance','--json');
assert.equal(ssh('sha256sum /srv/sporades/caddy/Caddyfile; docker inspect --format "{{.State.StartedAt}}" sporades-telemetry-relay sporades-node-exporter'),before);passed('Idempotent reconcile/bootstrap preserve config and running agents');
cli('host','telemetry','resources-disable','--host','acceptance','--json');
ssh("cp /srv/sporades/caddy/Caddyfile /root/119-good-caddy; python3 - <<'PYCODE'\nfrom pathlib import Path\np=Path('/srv/sporades/caddy/Caddyfile');p.write_text(p.read_text().replace('{','{\\n nonexistent_global_option',1))\nPYCODE");
const invalid=ssh('sha256sum /srv/sporades/caddy/Caddyfile');
let bad; try { bad=JSON.parse(exec(root+'/cli',['host','telemetry','resources-enable','--host','acceptance','--json'])); } catch(e) { bad=JSON.parse(e.stdout); }assert.equal(bad.ok,false);assert.equal(ssh('sha256sum /srv/sporades/caddy/Caddyfile'),invalid);
ssh('cp /root/119-good-caddy /srv/sporades/caddy/Caddyfile');passed('Invalid Caddy candidate rejected without replacing operator file');
// Keep an operator option in the existing global block, including nested servers options.
ssh("python3 - <<'PY'\nfrom pathlib import Path\np=Path('/srv/sporades/caddy/Caddyfile');s=p.read_text();s=s if 'read_body 15s' in s else s.replace('{','{\\n local_certs\\n servers {\\n timeouts {\\n read_body 15s\\n }\\n }',1);p.write_text(s)\nPY");
cli('host','telemetry','resources-enable','--host','acceptance','--json');
assert.match(ssh('cat /srv/sporades/caddy/Caddyfile'),/read_body 15s/);assert(Object.values(JSON.parse(ssh('caddy adapt --config /srv/sporades/caddy/Caddyfile --adapter caddyfile 2>/dev/null')).apps.http.servers).every(s=>s.read_timeout===15000000000));passed('Existing nested Caddy options preserved');
// Simulate a kernel without PSI files without rebooting into another kernel.
ssh('mount -t tmpfs -o size=64k tmpfs /proc/pressure');
try{status=cli('host','telemetry','reconcile','--host','acceptance','--json');assert.equal(status.resources.psi,'unsupported');passed('Unsupported PSI reported explicitly');}finally{ssh('umount /proc/pressure');cli('host','telemetry','reconcile','--host','acceptance','--json');}
ssh('docker stop sporades-node-exporter >/dev/null');
await until(async()=>{const r=await query(`up{${identity},telemetry_source="node"}`);return r[0]?.value[1]==='0';});passed('Exporter outage becomes scrape failure rather than zero resources');
cli('host','telemetry','reconcile','--host','acceptance','--json');
await until(async()=>{const r=await query(`up{${identity},telemetry_source="node"}`);return r[0]?.value[1]==='1';});
cli('host','telemetry','resources-remove','--host','acceptance','--json');
assert.equal(ssh('docker ps -a --filter name=sporades-node-exporter --format "{{.Names}}"'),'');
cli('host','bootstrap','--host','acceptance','--json');assert.equal(cli('host','telemetry','status','--host','acceptance','--json').resources.enabled,false);passed('Remove and repeated bootstrap retain disabled policy');
cli('host','telemetry','resources-enable','--host','acceptance','--json');
proof.finishedAt=new Date().toISOString();fs.writeFileSync(evidence+'/acceptance.json',JSON.stringify(proof,null,2));
