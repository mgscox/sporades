// Prometheus remains the only rule owner. JSON is a YAML-compatible rule file.
export const startingPolicy = Object.freeze({
  hostCpuBusyRatio: 0.9, hostCpuWaitRatio: 0.1, hostCpuForSeconds: 300,
  memoryAvailableRatio: 0.15, memoryForSeconds: 600,
  memoryCriticalRatio: 0.05, memoryCriticalForSeconds: 120,
  swapPagesPerSecond: 1, ioPressureRatio: 0.2, pressureForSeconds: 600,
  diskFreeRatio: 0.1, diskFreeBytes: 1073741824, inodeFreeRatio: 0.1, diskForSeconds: 300,
  apiErrorRatio: 0.05, apiMinRequests: 100, apiBudgetSeconds: 1, apiLatencyForSeconds: 600,
  processCpuCores: 0.9, eventLoopDelayMs: 100, processForSeconds: 300,
  routeBudgets: [], streamRoutes: [], expectedJobServices: [],
});
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,316}$/.test(value);
const route = value => typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9_/:.*{}-]*$/.test(value) && !value.includes('//');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function parseAlertPolicy(source = '{}') {
  try {
    if (Buffer.byteLength(source) > 16384) throw new Error();
    const input = JSON.parse(source);
    if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(startingPolicy, key))) throw new Error();
    const policy = { ...startingPolicy, ...input };
    for (const [key, value] of Object.entries(policy)) {
      if (Array.isArray(startingPolicy[key])) {
        if (!Array.isArray(value) || value.length > 64) throw new Error();
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (key.endsWith('Ratio') ? 1 : key.endsWith('ForSeconds') ? 86400 : 1e12)
        || (key.endsWith('ForSeconds') && (!Number.isInteger(value) || value < 15))
        || (key === 'apiMinRequests' && !Number.isInteger(value))) throw new Error();
    }
    if (policy.memoryCriticalRatio >= policy.memoryAvailableRatio) throw new Error();
    const seen = new Set();
    for (const budget of policy.routeBudgets) {
      if (!object(budget) || Object.keys(budget).sort().join(',') !== 'route,seconds,service' || !identity(budget.service) || !route(budget.route)
        || !Number.isFinite(budget.seconds) || budget.seconds <= 0 || budget.seconds > 86400) throw new Error();
      const key = JSON.stringify([budget.service, budget.route]);
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    if (!policy.streamRoutes.every(route) || !policy.expectedJobServices.every(identity)) throw new Error();
    return policy;
  } catch { throw new Error('Invalid ALERT_POLICY_JSON'); }
}
const quote = JSON.stringify;
const regex = values => values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
export function performanceRules(policy = startingPolicy, publicUrl = '__MONITORING_PUBLIC_URL__') {
  const rules = [];
  const add = (alert, expr, seconds, summary, action, view, severity = 'warning') => rules.push({
    alert, expr, for: `${seconds}s`, labels: { severity, category: view === 'api' ? 'api' : 'resource' },
    annotations: { summary, action, window: `Inspect the last 30 minutes; sustained window ${seconds}s.`,
      dashboard: `${publicUrl}/grafana/d/sporades-${view}?${view === 'hosts' ? 'var-host={{ $labels.sporades_host }}' : view === 'pipeline' ? '' : 'var-service={{ $labels.service_name }}&var-environment={{ $labels.deployment_environment_name }}'}&from=now-30m&to=now`,
      fleet: `${publicUrl}/grafana/d/sporades-fleet?from=now-30m&to=now` },
  });
  const p = policy;
  const cpu = '1 - avg by (sporades_host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))';
  const wait = 'avg by (sporades_host) (rate(node_pressure_cpu_waiting_seconds_total[5m]))';
  add('SporadesHostCpuContention', `(${cpu} > ${p.hostCpuBusyRatio}) and on (sporades_host) (${wait} > ${p.hostCpuWaitRatio})`, p.hostCpuForSeconds,
    'Host CPU contention for {{ $labels.sporades_host }}', 'Check CPU PSI, load, iowait and steal before attributing contention to a Capsule. Missing PSI is unsupported, not zero.', 'hosts');
  const ram = 'node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes';
  add('SporadesHostMemoryLow', `${ram} < ${p.memoryAvailableRatio}`, p.memoryForSeconds, 'Low available Host RAM', 'Inspect available RAM, swap and memory PSI; RSS is not a container limit.', 'hosts');
  add('SporadesHostMemoryCritical', `${ram} < ${p.memoryCriticalRatio}`, p.memoryCriticalForSeconds, 'Critically low available Host RAM', 'Check memory pressure and working sets; no automatic restart is performed.', 'hosts', 'critical');
  add('SporadesHostSwapPressure', `(rate(node_vmstat_pswpout[5m]) > ${p.swapPagesPerSecond}) and on (sporades_host) (${ram} < ${p.memoryAvailableRatio})`, p.pressureForSeconds, 'Host swapping with low available RAM', 'Inspect paging, swap capacity and memory PSI.', 'hosts');
  add('SporadesHostIoPressure', `rate(node_pressure_io_stalled_seconds_total[5m]) > ${p.ioPressureRatio}`, p.pressureForSeconds, 'Host I/O stalls', 'Inspect disk latency, throughput and backing filesystems.', 'hosts');
  const fs = '{fstype!~"tmpfs|devtmpfs|overlay|squashfs|nsfs|proc|sysfs",mountpoint!~"/proc(/.*)?|/sys(/.*)?|/dev(/.*)?"}';
  const available = `node_filesystem_avail_bytes${fs}`;
  add('SporadesHostDiskLow', `((${available} / node_filesystem_size_bytes${fs} < ${p.diskFreeRatio}) or (${available} < ${p.diskFreeBytes})) and (node_filesystem_readonly${fs} == 0)`, p.diskForSeconds, 'Low writable Host disk capacity', 'Inspect {{ $labels.mountpoint }} and Docker/Sporades data retention. Preserve Capsule data.', 'hosts');
  add('SporadesHostInodesLow', `(node_filesystem_files_free${fs} / node_filesystem_files${fs} < ${p.inodeFreeRatio}) and (node_filesystem_readonly${fs} == 0)`, p.diskForSeconds, 'Low Host filesystem inodes', 'Inspect file growth on {{ $labels.mountpoint }}; bytes alone do not show inode exhaustion.', 'hosts');
  add('SporadesMonitoringDiskLow', `(sporades_monitoring_storage_available_bytes / sporades_monitoring_storage_size_bytes < ${p.diskFreeRatio}) or (sporades_monitoring_storage_available_bytes < ${p.diskFreeBytes})`, p.diskForSeconds, 'Low monitoring storage capacity', 'Inspect {{ $labels.backend }} storage and retention; back up before maintenance. Shared filesystems are not additive.', 'pipeline');
  add('SporadesMonitoringDiskUnknown', 'sporades_monitoring_storage_stat_ok == 0', 60, 'Monitoring storage capacity unavailable', 'Verify read-only backend filesystem mounts; unavailable measurements are not healthy zero.', 'pipeline');
  const dimensions = 'service_name, deployment_environment_name, http_route';
  const eligible = 'and on (service_name) (max by (service_name) (sporades_expected_capsule) == 1)';
  const apiDimensions = 'service_name, deployment_environment_name';
  const requests = `sum by (${apiDimensions}) (increase(http_server_request_count_total[5m]))`;
  const errors = `sum by (${apiDimensions}) (increase(http_server_request_count_total{http_response_status_code="5xx"}[5m]))`;
  add('SporadesApiErrors', `((${errors}) / (${requests}) > ${p.apiErrorRatio}) and (${requests} >= ${p.apiMinRequests}) ${eligible}`, 0,
    'Sustained API 5xx for {{ $labels.service_name }}', 'Inspect errors and deployments. Quiet services use independent probes rather than error percentages.', 'api');
  const excludes = `sporades_http_outcome!="abort"${p.streamRoutes.length ? `,http_route!~${quote(regex(p.streamRoutes))}` : ''}`;
  const latency = (selector, seconds) => {
    const labels = selector ? excludes + ',' + selector : excludes;
    const histogram = `histogram_quantile(0.95, sum by (le, ${dimensions}) (rate(http_server_request_duration_seconds_bucket{${labels}}[5m])))`;
    const samples = `sum by (${dimensions}) (increase(http_server_request_duration_seconds_count{${labels}}[5m]))`;
    return `(${histogram} > ${seconds}) and (${samples} >= ${p.apiMinRequests})`;
  };
  let base = latency('', p.apiBudgetSeconds);
  for (const budget of p.routeBudgets) base += ` unless on (service_name,http_route) http_server_request_duration_seconds_count{service_name=${quote(budget.service)},http_route=${quote(budget.route)}}`;
  add('SporadesApiLatency', `(${base}) ${eligible}`, p.apiLatencyForSeconds, 'API p95 over route budget', 'Inspect the independent request histogram, route budget and recent deployments. Deliberate streams are excluded.', 'api');
  for (const budget of p.routeBudgets) add('SporadesApiLatency', `${latency(`service_name=${quote(budget.service)},http_route=${quote(budget.route)}`, budget.seconds)} ${eligible}`, p.apiLatencyForSeconds, 'API p95 over route budget', 'Inspect the independent request histogram, route budget and recent deployments. Deliberate streams are excluded.', 'api');
  const processDimensions = 'service_name, deployment_environment_name, instance';
  const expectedJobs = p.expectedJobServices.length ? `,service_name!~${quote(regex(p.expectedJobServices))}` : '';
  const impact = `sum by (service_name,deployment_environment_name) (rate(http_server_request_count_total{http_response_status_code="5xx"}[5m])) > 0`;
  add('SporadesProcessPressureCandidate', `(sum by (${processDimensions}) (rate(process_cpu_time_seconds_total{service_name!="sporades-stack-health"${expectedJobs}}[5m])) > ${p.processCpuCores}) and on (${processDimensions}) (process_event_loop_delay_p99_milliseconds > ${p.eventLoopDelayMs}) and on (service_name,deployment_environment_name) (${impact}) ${eligible}`, p.processForSeconds,
    'Process pressure with event-loop delay and API failures', 'Candidate for investigation, not proof of a runaway. One CPU core is not total Host saturation; inspect expected Jobs and Host pressure.', 'resources');
  return { groups: [{ name: 'sporades-performance', interval: '15s', rules }] };
}
