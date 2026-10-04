import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Refresh is triggered by Prometheus discovery, never an outbound probe loop.
// The scrape URL and module stay stable: changing discovery parameters would
// retire the scrape and reset pending alerts. One loaded module pairs its nonce
// header with an exact body match, including across in-flight configuration reloads.
export function createBlackboxDiscovery(directory, reloadUrl) {
  let pending;
  let current;
  return async () => {
    const epoch = Math.floor(Date.now() / 30_000);
    if (current?.epoch === epoch) return current;
    if (pending) return pending;
    pending = (async () => {
      let stored;
      try { stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stored && (!Number.isSafeInteger(stored.epoch) || !/^[a-f0-9]{32}$/.test(stored.nonce))) throw new Error('Invalid probe configuration.');
      const slot = stored?.epoch === epoch ? stored : { epoch, nonce: randomBytes(16).toString('hex') };
      const template = await readFile(new URL('./blackbox.yaml', import.meta.url), 'utf8');
      const write = async (name, body) => { const filename = join(directory, name); await writeFile(filename + '.tmp', body, { mode: 0o644 }); await rename(filename + '.tmp', filename); };
      await write('state.json', JSON.stringify(slot));
      await write('blackbox.yaml', template.replace('__NONCE__', slot.nonce).replace('[a-f0-9]{32}', slot.nonce));
      const response = await fetch(reloadUrl, { method: 'POST', signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Probe configuration reload unavailable.');
      current = slot;
      return slot;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
