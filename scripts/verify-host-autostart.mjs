// Disposable Linux VM acceptance. Never point this at a production Host.
import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const root=process.env.SPORADES_HOST_AUTOSTART_TEST_ROOT;assert(root,'Set SPORADES_HOST_AUTOSTART_TEST_ROOT to a prepared disposable VM harness.');const ssh=s=>execFileSync('ssh',['-o','ConnectTimeout=4','-F',root+'/ssh_config','sporadesautostart',s],{encoding:'utf8',timeout:20000,stdio:['pipe','pipe','pipe']}).trim();
assert.equal(ssh('hostname'),'sporades-autostart-test');
const before=ssh('cat /proc/sys/kernel/random/boot_id');ssh('systemctl reboot');
const end=Date.now()+150000;let result;
while(Date.now()<end){await new Promise(r=>setTimeout(r,2500));try{
 const boot=ssh('cat /proc/sys/kernel/random/boot_id');if(boot===before)continue;
 const unit=ssh('systemctl show sporades-capsules-209775c142f0f635.service --property=ActiveState --value');if(unit!=='active')continue;
 const awake=ssh('curl -ks --resolve awake.autostart.example:443:127.0.0.1 -o /dev/null -w "%{http_code}" https://awake.autostart.example/');assert.equal(awake,'200');
 const containers=JSON.parse(ssh('docker inspect sporades-autostart-example-awake sporades-autostart-example-doomed'));
 assert.equal(containers[0].State.Running,true);assert.equal(containers[0].HostConfig.RestartPolicy.Name,'on-failure');assert.equal(containers[0].HostConfig.RestartPolicy.MaximumRetryCount,3);
 assert.equal(containers[1].State.Running,false);assert.equal(containers[1].RestartCount,3);
 assert.equal(ssh('docker ps -a --filter name=sporades-autostart-example-asleep --format "{{.Names}}"'),'');assert.equal(ssh('docker ps -a --filter name=sporades-autostart-example-newborn --format "{{.Names}}"'),'');
 const original=containers[0].State.StartedAt;ssh('systemctl restart sporades-capsules-209775c142f0f635.service');assert.equal(ssh('docker inspect sporades-autostart-example-awake --format "{{.State.StartedAt}}"'),original);
 result={at:new Date().toISOString(),bootChanged:true,awakeHttp:awake,stoppedRemainsStopped:true,neverStartedRemainsStopped:true,crashExhaustedRemainsStopped:true,crashRetries:containers[1].RestartCount,repeatPreservesRunningInstance:true};break;
 }catch(e){if(e.code==='ERR_ASSERTION')throw e;}}
assert(result,'Boot recovery did not complete');fs.writeFileSync(root+'/reboot-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
