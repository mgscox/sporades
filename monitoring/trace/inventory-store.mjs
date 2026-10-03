import { mkdir, lstat, readFile, readdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { validateInventory, inventoryHost, INVENTORY_MAX_BYTES } from './inventory-contract.mjs';

// expectationSince duplicates only each Capsule's ASCII identity and ISO time,
// less than that Capsule's wire representation. Budget a second wire-sized block
// for metadata plus envelope headroom; keep the public request limit unchanged.
const STORED_MAX_BYTES = 2 * INVENTORY_MAX_BYTES + 8192;
const checkStoredSize = bytes => {
  if (bytes > STORED_MAX_BYTES) throw new Error('Unsafe stored inventory.');
};

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
  const readStoredFile = async filename => {
    const details = await lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077)) throw new Error('Unsafe stored inventory.');
    checkStoredSize(details.size);
    const text = await readFile(filename, 'utf8');
    checkStoredSize(Buffer.byteLength(text));
    return JSON.parse(text);
  };
  const read = async (host, expectations = false) => {
    if (!inventoryHost(host)) throw new Error('Invalid inventory identity.');
    await prepare();
    let stored;
    try { stored = await readStoredFile(filenameFor(host)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const inventory = canonicalInventory(stored.inventory);
    if (inventory.host !== host || typeof stored.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(stored.acknowledgedAt))) throw new Error('Invalid stored inventory.');
    return { inventory, acknowledgedAt: stored.acknowledgedAt, ...(expectations ? { expectationSince: stored.expectationSince ?? {} } : {}) };
  };
  const write = async (filename, value) => {
    // Validate the exact durable bytes before creating/replacing a file or
    // returning an acknowledgement. Readers use this identical envelope bound.
    const serialized = JSON.stringify(value) + '\n';
    checkStoredSize(Buffer.byteLength(serialized));
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filename);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temporary, { force: true }); }
  };
  return {
    async list() {
      await prepare();
      const results = [];
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const stored = await readStoredFile(join(directory, name));
        if (!inventoryHost(stored.inventory?.host) || filenameFor(stored.inventory.host) !== join(directory, name)) throw new Error('Invalid stored inventory.');
        const value = await exclusive(stored.inventory.host, () => read(stored.inventory.host, true));
        if (value) results.push(value);
      }
      return results;
    },
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
        const previous = await read(inventory.host, true);
        if (previous && (inventory.revision < previous.inventory.revision || (inventory.revision === previous.inventory.revision && JSON.stringify(inventory) !== JSON.stringify(previous.inventory)))) {
          return { status: 409, data: null };
        }
        // A matching retry renews contact metadata, never the expected state.
        // A sender must explicitly retain deleted identities as tombstones.
        if (previous && previous.inventory.capsules.some(item => !inventory.capsules.some(next => next.id === item.id))) return { status: 409, data: null };
        const acknowledgedAt = new Date().toISOString();
        const expectationSince = {};
        for (const capsule of inventory.capsules) {
          if (['running', 'failed'].includes(capsule.state)) expectationSince[capsule.id] = previous?.expectationSince?.[capsule.id] ?? acknowledgedAt;
        }
        await write(filenameFor(inventory.host), { inventory, acknowledgedAt, expectationSince });
        return { status: 200, data: { revision: inventory.revision, acknowledgedAt } };
      });
    },
  };
}
