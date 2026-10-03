#!/usr/bin/env node
// Recovery only; uses the identical Host-scoped gateway interface as automatic sync.
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { inventoryHost, validateInventory, INVENTORY_MAX_BYTES } from './inventory-contract.mjs';
import { parseEnvironment } from './setup.mjs';

const [operation, endpoint, host, filename, caFile] = process.argv.slice(2);
if (!['export', 'import'].includes(operation) || !inventoryHost(host) || !filename) throw new Error('Use node inventory.mjs export|import https://monitor.example host-identity file.json [ca.pem]');
let origin;
try { origin = new URL(endpoint); } catch { throw new Error('Use a verified HTTPS origin.'); }
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Use a verified HTTPS origin.');
const env = parseEnvironment(await readFile(new URL('./.env', import.meta.url), 'utf8'));
let token;
try { token = JSON.parse(env.get('INVENTORY_HOSTS') ?? '{}')[host]; }
catch { throw new Error('Invalid INVENTORY_HOSTS configuration.'); }
token = process.env.HOST_INVENTORY_TOKEN ?? token;
if (typeof token !== 'string' || token.length < 16 || /[\x00-\x20\x7f]/.test(token)) throw new Error('No scoped inventory credential for this Host.');
let body;
const ca = caFile ? await readFile(caFile) : undefined;
if (operation === 'import') {
  const input = await readFile(filename, 'utf8');
  if (Buffer.byteLength(input) > INVENTORY_MAX_BYTES) throw new Error('Inventory exceeds recovery limit.');
  let parsed;
  try { parsed = JSON.parse(input); } catch { throw new Error('Invalid inventory recovery file.'); }
  const inventory = validateInventory(parsed.data?.inventory ?? parsed.inventory ?? parsed);
  if (inventory.host !== host) throw new Error('Cross-Host recovery denied.');
  body = JSON.stringify(inventory);
}
const result = await new Promise((resolve, reject) => {
  const req = request(new URL(`/v1/inventory/${host}`, origin), { method: operation === 'import' ? 'PUT' : 'GET', ...(ca ? { ca } : {}), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
    let text = '';
    res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > INVENTORY_MAX_BYTES + 8192) req.destroy(new Error('Recovery response exceeds limit.')); });
    res.on('end', () => {
      if (res.statusCode !== 200) { reject(new Error(`Inventory recovery rejected (${res.statusCode}).`)); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error('Invalid inventory recovery response.')); }
    });
  });
  const deadline = setTimeout(() => req.destroy(new Error('Recovery timed out.')), 5000);
  req.on('close', () => clearTimeout(deadline));
  req.on('error', reject);
  req.end(body);
});
if (operation === 'export') await writeFile(filename, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
else process.stdout.write('Inventory recovery acknowledged.\n');
