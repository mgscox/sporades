import { mkdir, lstat, readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { validateInventory, inventoryHost } from './inventory-contract.mjs';

// JSON object field order has no semantic meaning. Normalize it before revision
// equality checks so logically identical retries cannot become conflicts.
const canonicalInventory = value => {
  const inventory = validateInventory(value);
  inventory.capsules = inventory.capsules.map(({ id, state, changedAt, release, targets }) => ({ id, state, changedAt, release, targets }));
  return inventory;
};

// One gateway owns this volume. Per-Host queues serialize concurrent requests;
// atomic replacement and fsync make acknowledgements survive process restarts.
export function createInventoryStore(directory) {
  const filenameFor = host => join(directory, `${createHash('sha256').update(host).digest('hex')}.json`);
  const queues = new Map();
  const exclusive = async (host, operation) => {
    const previous = queues.get(host) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(host, next);
    try { return await next; } finally { if (queues.get(host) === next) queues.delete(host); }
  };
  const prepare = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077)) throw new Error('Unsafe inventory storage.');
  };
  const read = async host => {
    if (!inventoryHost(host)) throw new Error('Invalid inventory identity.');
    await prepare();
    let text;
    try {
      const filename = filenameFor(host);
      const details = await lstat(filename);
      if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) || details.size > 1024 * 1024 + 8192) throw new Error('Unsafe stored inventory.');
      text = await readFile(filename, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const stored = JSON.parse(text);
    const inventory = canonicalInventory(stored.inventory);
    if (inventory.host !== host || typeof stored.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(stored.acknowledgedAt))) throw new Error('Invalid stored inventory.');
    return { inventory, acknowledgedAt: stored.acknowledgedAt };
  };
  const write = async (filename, value) => {
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filename);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  };
  return {
    read: host => exclusive(host, () => read(host)),
    async ready() {
      try {
        await prepare();
        const filename = join(directory, `.readiness-${randomBytes(8).toString('hex')}`);
        await write(filename, { ok: true });
        await rm(filename);
        return true;
      } catch { return false; }
    },
    update(value) {
      const inventory = canonicalInventory(value);
      return exclusive(inventory.host, async () => {
        const previous = await read(inventory.host);
        if (previous && (inventory.revision < previous.inventory.revision || (inventory.revision === previous.inventory.revision && JSON.stringify(inventory) !== JSON.stringify(previous.inventory)))) {
          return { status: 409, data: null };
        }
        // A matching retry renews contact metadata, never the expected state.
        // A sender must explicitly retain deleted identities as tombstones.
        if (previous && previous.inventory.capsules.some(item => !inventory.capsules.some(next => next.id === item.id))) return { status: 409, data: null };
        const acknowledgedAt = new Date().toISOString();
        await write(filenameFor(inventory.host), { inventory, acknowledgedAt });
        return { status: 200, data: { revision: inventory.revision, acknowledgedAt } };
      });
    },
  };
}
