#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAlertPolicy, performanceRules } from './performance-policy.mjs';
import { initializeSenderRegistry } from './sender-credentials.mjs';
import { validateInventoryCredentials } from './inventory-contract.mjs';

const owned = ['TRACE_INGEST_TOKEN', 'TRACE_UI_PASSWORD', 'GRAFANA_ADMIN_PASSWORD'];
const defaults = { TRACE_TLS_MODE: 'tls', TRACE_BIND: '127.0.0.1', TRACE_PORT: '8443', TRACE_UI_USER: 'operator', TRACE_RETENTION: '72h', METRIC_RETENTION: '14d', METRIC_DISK_CAP: '8GB' };

function rejectPlaceholderCredentials(entries) {
  for (const key of owned) {
    if (entries.get(key) === 'REPLACE_WITH_GENERATED_SECRET') {
      throw new Error(`${key} must be replaced with a real credential`);
    }
  }
}

export function gatewayRunIdentity(platform = process.platform, uid = process.getuid(), gid = process.getgid()) {
  if (platform === 'darwin') return { uid: 1000, gid: 1000, transferOwnership: false };
  if (uid === 0) return { uid: 1000, gid: 1000, transferOwnership: true };
  return { uid, gid, transferOwnership: false };
}

export function parseEnvironment(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
    if (!match) continue;
    const value = match[2];
    if (value.startsWith("'")) {
      const close = value.match(/(?<!\\)'(?:\s+#.*)?$/);
      if (!close) throw new Error(`Invalid quoted value for ${match[1]}`);
      entries.set(match[1], value.slice(1, close.index).replaceAll("\\'", "'"));
    } else if (value.startsWith('"')) {
      const close = value.match(/(?<!\\)"(?:\s+#.*)?$/);
      if (!close) throw new Error(`Invalid quoted value for ${match[1]}`);
      try { entries.set(match[1], JSON.parse(value.slice(0, close.index + 1))); }
      catch { throw new Error(`Invalid quoted value for ${match[1]}`); }
    } else entries.set(match[1], value);
  }
  return entries;
}

export function inspectEnvironment(source) {
  const entries = parseEnvironment(source);
  rejectPlaceholderCredentials(entries);
  parseAlertPolicy(entries.get('ALERT_POLICY_JSON'));
  try { validateInventoryCredentials(JSON.parse(entries.get('INVENTORY_HOSTS') ?? '{}')); }
  catch { throw new Error('Invalid INVENTORY_HOSTS: use unique scoped tokens keyed by exact Host identity.'); }
  const mode = entries.get('TRACE_TLS_MODE') ?? defaults.TRACE_TLS_MODE;
  const bind = entries.get('TRACE_BIND') ?? defaults.TRACE_BIND;
  if (!['tls', 'proxy'].includes(mode)) throw new Error('TRACE_TLS_MODE must be tls or proxy');
  if (mode === 'proxy' && !['127.0.0.1', '::1'].includes(bind)) throw new Error('TRACE_BIND must be loopback in proxy mode');
  for (const key of ['ALERT_WEBHOOK_URL', 'MONITORING_PUBLIC_URL']) {
    const value = entries.get(key);
    if (!value) continue;
    let url; try { url = new URL(value); } catch { throw new Error(`Invalid ${key}`); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(value)) throw new Error(`Invalid ${key}`);
    if (key === 'MONITORING_PUBLIC_URL' && (url.search || url.pathname !== '/' || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname))) throw new Error(`Invalid ${key}`);
  }
  if (entries.get('ALERT_WEBHOOK_TOKEN') && /[\x00-\x20\x7f]/.test(entries.get('ALERT_WEBHOOK_TOKEN'))) throw new Error('Invalid ALERT_WEBHOOK_TOKEN');
  return { notificationDelivery: entries.get('ALERT_WEBHOOK_URL') ? 'unverified' : 'disabled', missing: [...owned.filter(key => entries.has(key) && !entries.get(key)),
    ...(entries.get('ALERT_WEBHOOK_URL') && !entries.get('MONITORING_PUBLIC_URL') ? ['MONITORING_PUBLIC_URL'] : []),
    ...(mode === 'tls' ? ['TRACE_CERT_FILE', 'TRACE_KEY_FILE'].filter(key => !entries.get(key)) : [])] };
}

export async function setupEnvironment(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; source = ''; }
  const entries = parseEnvironment(source);
  rejectPlaceholderCredentials(entries);
  for (const key of owned) {
    if (entries.has(key) && !entries.get(key)) throw new Error(`${key} must not be empty`);
  }
  const additions = [];
  for (const [key, value] of Object.entries(defaults)) if (!entries.has(key)) { additions.push(`${key}=${value}`); entries.set(key, value); }
  if (!entries.has('GRAFANA_ROOT_URL')) {
    const value = `${entries.get('TRACE_TLS_MODE') === 'proxy' ? 'http' : 'https'}://127.0.0.1:${entries.get('TRACE_PORT')}/grafana/`;
    additions.push(`GRAFANA_ROOT_URL=${value}`);
    entries.set('GRAFANA_ROOT_URL', value);
  }
  for (const key of owned) if (!entries.has(key)) { const value = randomBytes(32).toString('hex'); additions.push(`${key}=${value}`); entries.set(key, value); }
  const { missing, notificationDelivery } = inspectEnvironment(`${source}${source && !source.endsWith('\n') ? '\n' : ''}${additions.join('\n')}`);
  if (additions.length) {
    await writeFile(path, `${source}${source && !source.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`, { mode: 0o600 });
  }
  await chmod(path, 0o600);
  const identity = gatewayRunIdentity();
  const privateDir = join(dirname(path), '.private');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(privateDir, 0o700);
  if (identity.transferOwnership) await chown(privateDir, 0, 0);
  await initializeSenderRegistry(join(privateDir, 'senders'), identity);
  const credentialsPath = join(privateDir, 'credentials.json');
  await writeFile(credentialsPath, `${JSON.stringify({
    ingestToken: entries.get('TRACE_INGEST_TOKEN'), uiUser: entries.get('TRACE_UI_USER'),
    uiPassword: entries.get('TRACE_UI_PASSWORD'),
    inventoryHosts: validateInventoryCredentials(JSON.parse(entries.get('INVENTORY_HOSTS') ?? '{}')),
  })}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  if (identity.transferOwnership) await chown(credentialsPath, identity.uid, identity.gid);
  const grafanaSecretPath = join(privateDir, 'grafana-admin-password');
  await writeFile(grafanaSecretPath, `${entries.get('GRAFANA_ADMIN_PASSWORD')}\n`, { mode: 0o600 });
  await chmod(grafanaSecretPath, 0o600);
  if (identity.transferOwnership) await chown(grafanaSecretPath, identity.uid, identity.gid);
  const blackboxDir = join(privateDir, 'blackbox');
  await mkdir(blackboxDir, { recursive: true, mode: 0o700 });
  await chmod(blackboxDir, 0o700);
  if (identity.transferOwnership) await chown(blackboxDir, identity.uid, identity.gid);
  try { await readFile(join(blackboxDir, 'blackbox.yaml')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(join(blackboxDir, 'blackbox.yaml'), await readFile(new URL('./blackbox.yaml', import.meta.url)), { mode: 0o644 });
  }
  const notificationPath = join(privateDir, 'alertmanager.yaml');
  const webhook = entries.get('ALERT_WEBHOOK_URL');
  const notifications = `route:\n  receiver: operator\n  group_by: [alertname, host, sporades_host, service_name]\n  group_wait: 5s\n  group_interval: 15s\n  repeat_interval: 4h\nreceivers:\n  - name: operator\n${webhook ? `    webhook_configs:\n      - url: ${JSON.stringify(webhook)}\n        send_resolved: true\n        max_alerts: 100\n${entries.get('ALERT_WEBHOOK_TOKEN') ? `        http_config:\n          authorization:\n            type: Bearer\n            credentials: ${JSON.stringify(entries.get('ALERT_WEBHOOK_TOKEN'))}\n` : ''}` : ''}`;
  await writeFile(notificationPath, notifications, { mode: 0o600 });
  await chmod(notificationPath, 0o600);
  if (identity.transferOwnership) await chown(notificationPath, identity.uid, identity.gid);
  const rules = await readFile(new URL('./availability-rules.yaml', import.meta.url), 'utf8');
  const publicUrl = (entries.get('MONITORING_PUBLIC_URL') ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
  const rulesPath = join(privateDir, 'availability-rules.yaml');
  await writeFile(rulesPath, rules.replaceAll('__MONITORING_PUBLIC_URL__', publicUrl), { mode: 0o600 });
  await chmod(rulesPath, 0o644);
  if (identity.transferOwnership) await chown(rulesPath, identity.uid, identity.gid);
  const performancePath = join(privateDir, 'performance-rules.yaml');
  await writeFile(performancePath, JSON.stringify(performanceRules(parseAlertPolicy(entries.get('ALERT_POLICY_JSON')), publicUrl), null, 2) + '\n', { mode: 0o600 });
  await chmod(performancePath, 0o644);
  if (identity.transferOwnership) await chown(performancePath, identity.uid, identity.gid);
  const composeKeys = ['TRACE_TLS_MODE', 'TRACE_BIND', 'TRACE_PORT', 'TRACE_CERT_FILE', 'TRACE_KEY_FILE', 'TRACE_RETENTION', 'METRIC_RETENTION', 'METRIC_DISK_CAP', 'GRAFANA_ROOT_URL'];
  const composePath = join(dirname(path), '.compose.env');
  const quote = value => `'${String(value ?? '').replaceAll("'", "\\'")}'`;
  await writeFile(composePath, `${composeKeys.map(key => `${key}=${quote(entries.get(key))}`).join('\n')}\nTRACE_RUN_UID=${identity.uid}\nTRACE_RUN_GID=${identity.gid}\n`, { mode: 0o600 });
  await chmod(composePath, 0o600);
  return { missing, notificationDelivery };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const path = resolve(process.argv[2] ?? fileURLToPath(new URL('./.env', import.meta.url)));
  const { missing } = await setupEnvironment(path);
  if (missing.length) {
    process.stderr.write(`Missing external settings: ${missing.join(', ')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Monitoring stack environment ready.\n');
}
