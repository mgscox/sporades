import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, rm, chown } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inventoryHost } from './inventory-contract.mjs';

const invalid = () => { throw new Error('Invalid protected sender registry.'); };
const nameValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
const MAX_REGISTRY_BYTES = 1024 * 1024;
const empty = () => ({ schemaVersion: 1, revision: 0, legacyIngest: true, legacyInventoryDisabled: [], senders: [] });

export function validateSenderRegistry(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.legacyIngest !== 'boolean' || !Array.isArray(value.legacyInventoryDisabled) ||
      value.legacyInventoryDisabled.some(host => !inventoryHost(host)) ||
      !Array.isArray(value.senders) || value.senders.length > 1000) invalid();
  const names = new Set(), hosts = new Set(), secrets = new Set();
  for (const sender of value.senders) {
    if (!sender || !nameValid(sender.name) || names.has(sender.name) || !['applied', 'pending', 'revoked'].includes(sender.state) ||
        !Number.isSafeInteger(sender.generation) || sender.generation < 1 ||
        !Number.isSafeInteger(sender.issuedGeneration) || sender.issuedGeneration < sender.generation ||
        (sender.host !== null && !inventoryHost(sender.host))) invalid();
    names.add(sender.name);
    if (sender.host && sender.state !== 'revoked') {
      if (hosts.has(sender.host)) invalid();
      hosts.add(sender.host);
    }
    if (sender.state === 'revoked') { if (sender.active !== null || sender.pending !== null) invalid(); continue; }
    if (!sender.active || (sender.state === 'pending' ? !sender.pending : sender.pending !== null)) invalid();
    for (const [offset, pair] of [[0, sender.active], [1, sender.pending]]) {
      if (!pair) continue;
      if (pair.generation !== (offset ? sender.issuedGeneration : sender.generation) || (offset && pair.generation <= sender.generation)) invalid();
      for (const role of ['ingest', 'inventory']) {
        const secret = pair[role];
        if (role === 'inventory' && !sender.host) { if (secret !== null) invalid(); continue; }
        if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret) || secrets.has(secret)) invalid();
        secrets.add(secret);
      }
    }
  }
  return value;
}

async function protectedDirectory(directory, create = false, owner) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) invalid();
  if (owner?.transferOwnership) await chown(directory, owner.uid, owner.gid);
}

export async function readSenderRegistry(directory) {
  await protectedDirectory(directory);
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await open(join(directory, 'registry.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      // Atomic publication can unlink the inode after open. Reopen the current
      // path rather than denying unrelated senders or authorizing stale state.
      if (stat.nlink === 0) continue;
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > MAX_REGISTRY_BYTES) invalid();
      const serialized = await file.readFile('utf8');
      const afterRead = await file.stat();
      if (afterRead.nlink === 0) continue;
      if (!afterRead.isFile() || afterRead.nlink !== 1 || afterRead.mode & 0o077 || afterRead.size > MAX_REGISTRY_BYTES) invalid();
      let value;
      try { value = JSON.parse(serialized); } catch { invalid(); }
      return validateSenderRegistry(value);
    } finally { await file.close(); }
  }
  invalid();
}

async function publish(directory, value, owner) {
  validateSenderRegistry(value);
  const serialized = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) throw new Error('Protected sender registry is full; preserve it and review retired sender history before issuing more credentials.');
  const temporary = join(directory, `.registry-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      if (owner?.transferOwnership) await file.chown(owner.uid, owner.gid);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, join(directory, 'registry.json'));
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temporary, { force: true }); }
}

// No stale-lock timeout may evict a live operator. After a killed writer, the
// operator confirms the PID in owner.json has exited before removing .lock.
async function exclusive(directory, operation, owner) {
  await protectedDirectory(directory, true, owner);
  const lock = join(directory, '.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Sender registry is locked. Inspect .private/senders/.lock/owner.json; remove the lock only after its writer has exited.');
    throw error;
  }
  try {
    const file = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); } finally { await file.close(); }
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function initializeSenderRegistry(directory, owner) {
  return exclusive(directory, async () => {
    try { return await readSenderRegistry(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = empty();
    await publish(directory, value, owner);
    return value;
  }, owner);
}

const generation = (number, host) => ({ generation: number, ingest: randomBytes(32).toString('hex'), inventory: host ? randomBytes(32).toString('hex') : null });
const summary = sender => ({ name: sender.name, host: sender.host, state: sender.state, generation: sender.generation, pendingGeneration: sender.pending?.generation ?? null });

/** Operator-local lifecycle only: no network administration and no secret output. */
export async function manageSenderCredentials(directory, action, options = {}, owner) {
  const operations = ['issue', 'rotate', 'commit', 'cancel', 'revoke', 'export', 'status', 'legacy-revoke'];
  if (!operations.includes(action)) throw new Error('Unknown sender credential operation.');
  if (!['status', 'legacy-revoke'].includes(action) && !nameValid(options.sender)) throw new Error('Use a lowercase sender name of at most 63 characters.');
  if (options.host !== undefined && !inventoryHost(options.host)) throw new Error('Use an exact canonical inventory Host identity.');
  if (action === 'export' && !options.out) throw new Error('Credential export requires --out; secrets are never printed.');
  if (action === 'commit' && (!Number.isSafeInteger(options.generation) || options.generation < 2)) throw new Error('Commit requires the pending --generation number.');
  return exclusive(directory, async () => {
    const value = await readSenderRegistry(directory);
    let sender = value.senders.find(item => item.name === options.sender);
    if (options.sender !== undefined && action === 'status' && !sender) throw new Error('Unknown sender.');
    let changed = false;
    if (action === 'issue') {
      if (sender) {
        if (sender.state === 'revoked' || sender.host !== (options.host ?? null)) throw new Error('Sender name is already reserved; use a new name for a different scope or revoked sender.');
      } else {
        if (options.host && value.senders.some(item => item.host === options.host && item.state !== 'revoked')) throw new Error('Inventory Host already has a sender.');
        sender = { name: options.sender, host: options.host ?? null, state: 'applied', generation: 1, issuedGeneration: 1, active: generation(1, options.host), pending: null };
        value.senders.push(sender); changed = true;
      }
    } else if (action === 'legacy-revoke') {
      if (options.host) {
        if (!value.legacyInventoryDisabled.includes(options.host)) { value.legacyInventoryDisabled.push(options.host); changed = true; }
      } else if (options.ingest === true) { changed = value.legacyIngest; value.legacyIngest = false; }
      else throw new Error('Legacy revocation requires --ingest or an exact --host.');
    } else if (action !== 'status') {
      if (!sender) throw new Error('Unknown sender.');
      if (action !== 'revoke' && sender.state === 'revoked') throw new Error('Sender is revoked; issue a new sender name.');
      if (action === 'rotate' && !sender.pending) {
        sender.issuedGeneration++; sender.pending = generation(sender.issuedGeneration, sender.host); sender.state = 'pending'; changed = true;
      } else if (action === 'commit') {
        if (sender.pending?.generation === options.generation) {
          sender.active = sender.pending; sender.generation = sender.pending.generation; sender.pending = null; sender.state = 'applied'; changed = true;
        } else if (sender.generation !== options.generation || sender.pending) throw new Error('Pending generation does not match; inspect sender status.');
      } else if (action === 'cancel' && sender.pending) {
        sender.pending = null; sender.state = 'applied'; changed = true;
      } else if (action === 'revoke' && sender.state !== 'revoked') {
        sender.active = null; sender.pending = null; sender.state = 'revoked'; changed = true;
      } else if (action === 'export') {
        const pair = sender.pending ?? sender.active;
        const filename = resolve(options.out);
        const protectedRoot = resolve(directory);
        if (filename === protectedRoot || filename.startsWith(protectedRoot + '/')) throw new Error('Export must be outside the sender registry directory.');
        // Never overwrite an operator file or follow an existing symlink.
        const file = await open(filename, 'wx', 0o600);
        try {
          await file.writeFile(`SPORADES_SENDER_GENERATION=${pair.generation}\nTRACE_INGEST_TOKEN=${pair.ingest}\n${sender.host ? `HOST_INVENTORY_TOKEN=${pair.inventory}\n` : ''}`);
          await file.sync();
        } finally { await file.close(); }
      }
    }
    if (changed) { value.revision++; await publish(directory, value, owner); }
    return { schemaVersion: 1, revision: value.revision, changed, legacyIngestEnabled: value.legacyIngest,
      legacyInventoryDisabled: value.legacyInventoryDisabled, senders: (sender ? [sender] : value.senders).map(summary) };
  }, owner);
}

// Request-local snapshots ensure an atomic replacement cannot mix generations.
export async function senderAuthorization(directory) {
  const value = await readSenderRegistry(directory);
  const ingest = [], inventory = new Map();
  for (const sender of value.senders) {
    if (sender.state === 'revoked') continue;
    for (const pair of [sender.active, sender.pending].filter(Boolean)) {
      ingest.push(pair.ingest);
      if (sender.host) inventory.set(sender.host, [...(inventory.get(sender.host) ?? []), pair.inventory]);
    }
  }
  return { ingest, inventory, legacyIngest: value.legacyIngest, legacyInventoryDisabled: value.legacyInventoryDisabled };
}
