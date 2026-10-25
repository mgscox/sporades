// Inputs accepted by official Compose whose resolved representation differs.
export const composeEquivalenceCases = [
  { name: 'zero cpus', compose: { cpus: 0 }, resolved: {} },
  { name: 'zero oom_score_adj', compose: { oom_score_adj: 0 }, resolved: {} },
  { name: 'zero pids_limit', compose: { pids_limit: 0 }, resolved: {} },
  { name: 'zero mem_swappiness', compose: { mem_swappiness: 0 }, resolved: {} },
  { name: 'empty dns', compose: { dns: [] }, resolved: {} },
  { name: 'empty dns_search', compose: { dns_search: [] }, resolved: {} },
  { name: 'empty depends_on', compose: { depends_on: [] }, resolved: {} },
  { name: 'list sysctls', compose: { sysctls: ['net.core.somaxconn=1024'] }, resolved: { sysctls: { 'net.core.somaxconn': '1024' } }, elevated: ['sysctls'] },
  { name: 'numeric supplementary group', compose: { group_add: [1234] }, resolved: { group_add: ['1234'] }, elevated: ['group_add'] },
  { name: 'tty false', compose: { tty: false }, resolved: {} },
  { name: 'stdin_open false', compose: { stdin_open: false }, resolved: {} },
  { name: 'extension metadata', compose: { 'x-note': { purpose: 'reviewed metadata' } }, resolved: {} },
  { name: 'bracketed IPv6 host', compose: { extra_hosts: ['ipv6:[::1]'] }, resolved: { extra_hosts: ['ipv6=::1'] }, elevated: ['extra_hosts'] },
  { name: 'empty logging options', compose: { logging: { driver: 'json-file', options: {} } }, resolved: { logging: { driver: 'json-file' } } },
];
