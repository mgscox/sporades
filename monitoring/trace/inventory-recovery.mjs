#!/usr/bin/env node
// Recovery uses the same exact Host authority and revision validation as live delivery.
import { validateInventory, inventoryHostPattern } from './inventory.mjs';
const [operation, host] = process.argv.slice(2);
if (!['export', 'import'].includes(operation) || !inventoryHostPattern.test(host ?? '')) throw new Error('Use inventory-recovery.mjs export|import <host>');
const origin = new URL(process.env.INVENTORY_ORIGIN ?? '');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('INVENTORY_ORIGIN must be a verified HTTPS origin');
const token = process.env.INVENTORY_TOKEN;
if (!token || /[\x00-\x1f\x7f]/.test(token)) throw new Error('Set INVENTORY_TOKEN to the exact Host inventory credential');
let body;
if (operation === 'import') {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Inventory recovery input too large'); }
  body = JSON.stringify(validateInventory(JSON.parse(text)));
}
const res = await fetch(new URL(`/v1/inventory/${host}`, origin), { method: operation === 'import' ? 'PUT' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(6000) });
if (!res.ok) throw new Error(`Inventory recovery refused (${res.status})`);
process.stdout.write(JSON.stringify(await res.json()) + '\n');
