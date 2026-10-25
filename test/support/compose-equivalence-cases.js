// Inputs accepted by official Compose whose resolved representation differs.
export const composeEquivalenceCases = [
  { name: 'tty false', compose: { tty: false }, resolved: {}, tamper: service => { service.tty = true; } },
  { name: 'stdin_open false', compose: { stdin_open: false }, resolved: {}, tamper: service => { service.stdin_open = true; } },
  { name: 'extension metadata', compose: { 'x-note': { purpose: 'reviewed metadata' } }, resolved: {}, tamper: service => { service.privileged = true; } },
  { name: 'bracketed IPv6 host', compose: { extra_hosts: ['ipv6:[::1]'] }, resolved: { extra_hosts: ['ipv6=::1'] }, elevated: ['extra_hosts'], tamper: service => { service.extra_hosts = ['ipv6=::2']; } },
  { name: 'empty logging options', compose: { logging: { driver: 'json-file', options: {} } }, resolved: { logging: { driver: 'json-file' } }, tamper: service => { service.logging.options = { 'max-size': '1m' }; } },
];
