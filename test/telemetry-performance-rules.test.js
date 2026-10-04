import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { performanceRules, parseAlertPolicy } from '../monitoring/trace/performance-policy.mjs';

await mkdir(new URL('../.sporades/issue-121/', import.meta.url), { recursive: true });

const promtool = process.env.SPORADES_PROMTOOL_BIN;
test('shipped starting rules equal the operator-policy generator', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('../monitoring/trace/performance-rules.yaml', import.meta.url), 'utf8')), performanceRules());
});

test('Prometheus evaluates sustained pressure, API sample guards, streams, route overrides and recovery', { skip: !promtool && process.env.SPORADES_REAL_PROMTOOL !== '1' && 'Set SPORADES_PROMTOOL_BIN or SPORADES_REAL_PROMTOOL=1.', timeout: 60000 }, async t => {
  const dir = await mkdtemp(new URL('../.sporades/issue-121/rules-', import.meta.url).pathname);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const expected = (name, labels = {}) => ({ labels: `ALERTS{alertname="${name}",alertstate="firing",category="${name.startsWith('SporadesApi') ? 'api' : 'resource'}",severity="${name === 'SporadesHostMemoryCritical' ? 'critical' : 'warning'}"${Object.entries(labels).map(([key,value]) => `,${key}="${value}"`).join('')}}`, value: 1 });
  const check = (name, time, labels) => ({ expr: `ALERTS{alertname="${name}",alertstate="firing"}`, eval_time: time, exp_samples: labels ? [expected(name, labels)] : [] });
  const apiLabels = { service_name: 'demo', deployment_environment_name: 'hosted', http_route: '/work' };
  const series = (name, labels, values) => ({ series: `${name}{${Object.entries(labels).map(([key,value])=>`${key}="${value}"`).join(',')}}`, values });
  const request = (service, errors, count = '0+30x25') => [
    series('sporades_expected_capsule', { service_name: service, host: 'one' }, '1+0x25'),
    series('http_server_request_count_total', { ...apiLabels, service_name: service, http_response_status_code: '2xx' }, count),
    series('http_server_request_count_total', { ...apiLabels, service_name: service, http_response_status_code: '5xx' }, errors),
  ];
  const histogram = (labels, le1 = '0+0x15 30+30x9') => [
    series('http_server_request_duration_seconds_count', labels, '0+30x25'),
    series('http_server_request_duration_seconds_bucket', { ...labels, le: '1' }, le1),
    series('http_server_request_duration_seconds_bucket', { ...labels, le: '2.5' }, '0+30x25'),
    series('http_server_request_duration_seconds_bucket', { ...labels, le: '+Inf' }, '0+30x25'),
  ];
  const rules = performanceRules(parseAlertPolicy('{"streamRoutes":["/events"],"routeBudgets":[{"service":"budget","route":"/work","seconds":3}],"expectedJobServices":["batch"]}'));
  await writeFile(dir + '/rules.yaml', JSON.stringify(rules));
  const host = { sporades_host: 'one' };
  const tests = [
    { name: 'Host pressure requires contention and sustained windows; recovery clears', interval: '1m', input_series: [
      series('node_cpu_seconds_total', {...host,mode:'idle',cpu:'0'}, '0+3x20 120+60x4'),
      series('node_pressure_cpu_waiting_seconds_total', host, '0+12x20 240+0x4'),
      series('node_memory_MemAvailable_bytes', host, '3+0x20 90+0x4'),
      series('node_memory_MemTotal_bytes', host, '100+0x25'),
      series('node_vmstat_pswpout', host, '0+120x20 2400+0x4'),
      series('node_pressure_io_stalled_seconds_total', host, '0+18x20 360+0x4'),
    ], promql_expr_test: [
      check('SporadesHostCpuContention','5m'), check('SporadesHostCpuContention','10m',host), check('SporadesHostCpuContention','25m'),
      check('SporadesHostMemoryLow','9m'), check('SporadesHostMemoryLow','10m',host), check('SporadesHostMemoryLow','25m'),
      check('SporadesHostMemoryCritical','1m'), check('SporadesHostMemoryCritical','2m',host), check('SporadesHostMemoryCritical','25m'),
      check('SporadesHostSwapPressure','20m',host), check('SporadesHostSwapPressure','25m'),
      check('SporadesHostIoPressure','20m',host), check('SporadesHostIoPressure','25m'),
    ] },
    { name: 'Busy CPU alone does not page, idle services and quiet errors do not page', interval:'1m', input_series: [
      series('node_cpu_seconds_total',{...host,mode:'idle',cpu:'0'},'0+0x25'),
      series('node_pressure_cpu_waiting_seconds_total',host,'0+0x25'),
      ...request('quiet','0+1x25','0+0x25'), ...request('idle','0+0x25','0+0x25'),
    ], promql_expr_test:[check('SporadesHostCpuContention','20m'),check('SporadesApiErrors','20m')] },
    { name:'API failure ratio and independent histogram fire and resolve', interval:'1m', input_series:[
      ...request('demo','0+3x8 24+0x16'), ...histogram(apiLabels),
    ], promql_expr_test:[check('SporadesApiErrors','2m'),check('SporadesApiErrors','5m',{service_name:'demo',deployment_environment_name:'hosted'}),check('SporadesApiErrors','15m'),check('SporadesApiLatency','10m'),check('SporadesApiLatency','15m',apiLabels),check('SporadesApiLatency','22m')] },
    { name:'API failure sample floor applies across routes in one Capsule environment',interval:'1m',input_series:[
      series('sporades_expected_capsule',{service_name:'wide',host:'one'},'1+0x10'),
      series('http_server_request_count_total',{service_name:'wide',deployment_environment_name:'hosted',http_route:'/a',http_response_status_code:'2xx'},'0+12x10'),
      series('http_server_request_count_total',{service_name:'wide',deployment_environment_name:'hosted',http_route:'/b',http_response_status_code:'2xx'},'0+12x10'),
      series('http_server_request_count_total',{service_name:'wide',deployment_environment_name:'hosted',http_route:'/a',http_response_status_code:'5xx'},'0+2x10'),
    ],promql_expr_test:[check('SporadesApiErrors','5m',{service_name:'wide',deployment_environment_name:'hosted'})]},
    { name:'Streams, budgets and lifecycle acknowledgement suppress latency pages', interval:'1m', input_series:[
      ...request('budget','0+0x25'),...histogram({...apiLabels,service_name:'budget'},'0+0x25'),
      ...request('events','0+0x25'),...histogram({...apiLabels,service_name:'events',http_route:'/events'},'0+0x25'),
      series('sporades_expected_capsule',{service_name:'stopped',host:'one'},'1+0x8 0+0x16'),
      ...histogram({...apiLabels,service_name:'stopped'},'0+0x25'),
    ], promql_expr_test:[check('SporadesApiLatency','20m')] },
    { name:'An exact operator budget still pages above its own threshold', interval:'1m', input_series:[
      ...request('budget','0+0x25'), ...histogram({...apiLabels,service_name:'budget'},'0+0x25').map(item=>({...item,series:item.series.replace('le="2.5"','le="10"')})),
    ], promql_expr_test:[check('SporadesApiLatency','15m',{...apiLabels,service_name:'budget'})] },
    { name:'Expected Jobs stay distinct from process pressure candidates', interval:'1m', input_series:[
      ...['batch','demo'].flatMap(service=>[
        ...request(service,'0+3x25'),
        series('process_cpu_time_seconds_total',{service_name:service,deployment_environment_name:'hosted',instance:'a',type:'user'},'0+60x25'),
        series('process_event_loop_delay_p99_milliseconds',{service_name:service,deployment_environment_name:'hosted',instance:'a'},'200+0x25'),
      ]),
    ], promql_expr_test:[check('SporadesProcessPressureCandidate','10m',{service_name:'demo',deployment_environment_name:'hosted',instance:'a'})] },
    { name:'Writable disk, inodes and monitoring backend capacity fire and recover', interval:'1m',input_series:[
      ...['avail_bytes','size_bytes','files_free','files','readonly'].map((suffix,i)=>series('node_filesystem_'+suffix,{...host,mountpoint:'/data',fstype:'ext4',device:'/disk'},['100+0x8 2000000000+0x16','10000000000+0x25','5+0x8 90+0x16','100+0x25','0+0x25'][i])),
      series('sporades_monitoring_storage_available_bytes',{backend:'metrics'},'100+0x8 2000000000+0x16'),
      series('sporades_monitoring_storage_size_bytes',{backend:'metrics'},'10000000000+0x25'),
    ],promql_expr_test:[check('SporadesHostDiskLow','4m'),check('SporadesHostDiskLow','5m',{...host,mountpoint:'/data',fstype:'ext4',device:'/disk'}),check('SporadesHostDiskLow','10m'),check('SporadesHostInodesLow','5m',{...host,mountpoint:'/data',fstype:'ext4',device:'/disk'}),check('SporadesMonitoringDiskLow','5m',{backend:'metrics'}),check('SporadesMonitoringDiskLow','10m')] },
    { name:'Unavailable backend disk fires after one minute and resolves when measurements return', interval:'15s', input_series:[
      series('sporades_monitoring_storage_stat_ok',{backend:'traces'},'0+0x4 1+0x4'),
    ], promql_expr_test:[check('SporadesMonitoringDiskUnknown','45s'),check('SporadesMonitoringDiskUnknown','60s',{backend:'traces'}),check('SporadesMonitoringDiskUnknown','90s')] },
  ];
  const dashboard = JSON.parse(await readFile(new URL('../monitoring/trace/fleet-dashboard.json', import.meta.url), 'utf8'));
  tests.push({ name:'Acknowledged lifecycle annotations preserve timestamps without idle marker floods', interval:'15s', input_series:[
    series('sporades_capsule_lifecycle_changed_seconds',{host:'one',service_name:'demo',state:'running'},'15+0x4 90+0x16'),
  ], promql_expr_test:[
    {expr:dashboard.annotations.list[0].expr,eval_time:'60s',exp_samples:[{labels:'{host="one",service_name="demo",state="running"}',value:15}]},
    {expr:dashboard.annotations.list[0].expr,eval_time:'90s',exp_samples:[{labels:'{host="one",service_name="demo",state="running"}',value:90}]},
    {expr:dashboard.annotations.list[0].expr,eval_time:'240s',exp_samples:[]},
  ]});
  await writeFile(dir + '/tests.yaml', JSON.stringify({ rule_files: ['rules.yaml'], evaluation_interval:'15s', tests }));
  // Mount only readable synthetic rules/fixtures, never operator configuration.
  await chmod(dir, 0o755);
  const name = `sporades-performance-promtool-${process.pid}`;
  const args = promtool ? ['test','rules',dir + '/tests.yaml'] : ['run','--rm','--name',name,'--network','none','--mount',`type=bind,src=${dir},dst=/fixtures,readonly`,'--entrypoint','promtool','prom/prometheus:v3.13.3','test','rules','/fixtures/tests.yaml'];
  const result = spawnSync(promtool || 'docker', args, {encoding:'utf8',timeout:55000});
  if (!promtool && result.error) spawnSync('docker',['rm','--force',name],{timeout:5000,encoding:'utf8'});
  assert.equal(result.status,0,`${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
