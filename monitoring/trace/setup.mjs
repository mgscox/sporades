#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const owned = ['TRACE_INGEST_TOKEN', 'TRACE_UI_PASSWORD'];
const defaults = { TRACE_TLS_MODE: 'tls', TRACE_BIND: '127.0.0.1', TRACE_PORT: '8443', TRACE_UI_USER: 'operator', TRACE_RETENTION: '168h' };

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

export async function setupEnvironment(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; source = ''; }
  const entries = parseEnvironment(source);
  const additions = [];
  for (const [key, value] of Object.entries(defaults)) if (!entries.has(key)) { additions.push(`${key}=${value}`); entries.set(key, value); }
  for (const key of owned) if (!entries.has(key)) { const value = randomBytes(32).toString('hex'); additions.push(`${key}=${value}`); entries.set(key, value); }
  const mode = entries.get('TRACE_TLS_MODE') ?? defaults.TRACE_TLS_MODE;
  const bind = entries.get('TRACE_BIND') ?? defaults.TRACE_BIND;
  if (!['tls', 'proxy'].includes(mode)) throw new Error('TRACE_TLS_MODE must be tls or proxy');
  if (mode === 'proxy' && !['127.0.0.1', '::1'].includes(bind)) throw new Error('TRACE_BIND must be loopback in proxy mode');
  const missing = [...owned.filter(key => entries.has(key) && !entries.get(key)),
    ...(mode === 'tls' ? ['TRACE_CERT_FILE', 'TRACE_KEY_FILE'].filter(key => !entries.get(key)) : [])];
  if (additions.length) {
    await writeFile(path, `${source}${source && !source.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`, { mode: 0o600 });
  }
  await chmod(path, 0o600);
  const identity = gatewayRunIdentity();
  const privateDir = join(dirname(path), '.private');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(privateDir, 0o700);
  if (identity.transferOwnership) await chown(privateDir, 0, 0);
  const credentialsPath = join(privateDir, 'credentials.json');
  await writeFile(credentialsPath, `${JSON.stringify({
    ingestToken: entries.get('TRACE_INGEST_TOKEN'), uiUser: entries.get('TRACE_UI_USER'),
    uiPassword: entries.get('TRACE_UI_PASSWORD'),
  })}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  if (identity.transferOwnership) await chown(credentialsPath, identity.uid, identity.gid);
  const composeKeys = ['TRACE_TLS_MODE', 'TRACE_BIND', 'TRACE_PORT', 'TRACE_CERT_FILE', 'TRACE_KEY_FILE', 'TRACE_RETENTION'];
  const composePath = join(dirname(path), '.compose.env');
  const quote = value => `'${String(value ?? '').replaceAll("'", "\\'")}'`;
  await writeFile(composePath, `${composeKeys.map(key => `${key}=${quote(entries.get(key))}`).join('\n')}\nTRACE_RUN_UID=${identity.uid}\nTRACE_RUN_GID=${identity.gid}\n`, { mode: 0o600 });
  await chmod(composePath, 0o600);
  return { missing };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const path = resolve(process.argv[2] ?? new URL('./.env', import.meta.url).pathname);
  const { missing } = await setupEnvironment(path);
  if (missing.length) {
    process.stderr.write(`Missing external settings: ${missing.join(', ')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Trace stack environment ready.\n');
}
