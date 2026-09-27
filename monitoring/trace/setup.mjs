#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const owned = ['TRACE_INGEST_TOKEN', 'TRACE_UI_PASSWORD'];
const defaults = { TRACE_TLS_MODE: 'tls', TRACE_BIND: '127.0.0.1', TRACE_PORT: '8443', TRACE_UI_USER: 'operator', TRACE_RETENTION: '168h' };

export async function setupEnvironment(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; source = ''; }
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
    if (match) entries.set(match[1], match[2]);
  }
  const additions = [];
  for (const [key, value] of Object.entries(defaults)) if (!entries.has(key)) additions.push(`${key}=${value}`);
  for (const key of owned) if (!entries.has(key)) additions.push(`${key}=${randomBytes(32).toString('hex')}`);
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
