import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';

// Persist ownership before launching anything. Removal failure never relinquishes
// ownership, and another cleanup pass can retry it (including after interruption).
export function lifecycleOwnership(journal) {
  const owned = [];
  let pending = Promise.resolve();
  const snapshot = () => owned.map(({ remove, ...record }) => structuredClone(record));
  const persist = () => {
    pending = pending.catch(() => {}).then(async () => {
      await writeFile(journal + '.candidate', JSON.stringify(snapshot(), null, 2) + '\n');
      await rename(journal + '.candidate', journal);
    });
    return pending;
  };
  async function persistRecord(record) {
    try { await persist(); }
    catch (error) {
      record.journalErrors ??= [];
      if (record.journalErrors.length < 8) record.journalErrors.push(error.message);
      throw error;
    }
  }
  async function register(kind, name, remove, details = {}) {
    const record = { ...details, kind, name, removed: false, attempts: [], remove };
    owned.push(record); await persistRecord(record);
    const cleanup = async () => {
      if (record.removed) return;
      try {
        await remove();
        record.removed = true;
        record.attempts.push({ removed: true });
      } catch (error) {
        record.attempts.push({ removed: false, error: error.message });
        await persistRecord(record).catch(() => {}); throw error;
      }
      await persistRecord(record);
    };
    cleanup.identifyProcess = async pid => { record.pid = pid; await persistRecord(record); };
    return cleanup;
  }
  async function cleanup(attempts = 2, select = () => true) {
    for (const record of [...owned].reverse().filter(select)) {
      for (let attempt = 0; !record.removed && attempt < attempts; attempt++) {
        try {
          await record.remove(); record.removed = true;
          record.attempts.push({ removed: true });
        } catch (error) { record.attempts.push({ removed: false, error: error.message }); }
        // Journal failure must not strand the remaining resources. Retain its
        // error in the report and let subsequent writes recover the queue.
        await persistRecord(record).catch(() => {});
      }
      await persistRecord(record).catch(() => {});
    }
    return snapshot();
  }
  return { register, cleanup, snapshot };
}

export async function removeOwnedDockerContainer(command, name) {
  try { await command(['rm', '-f', name]); }
  catch (error) {
    // Startup can fail before creation. A failed rm is not confirmation of
    // absence; accept only Docker's explicit missing-object inspection result.
    try { await command(['inspect', name]); }
    catch (inspection) {
      if (inspection.code === 1 && /No such (object|container)/i.test(inspection.stderr || '')) return;
    }
    throw error;
  }
}

export function lifecycleDockerNetworkArgs(network) {
  if (!network) return [];
  assert.match(network, /^sporades-proof-network-[a-f0-9]{12}$/, 'Expected the owned per-run proof network');
  return ['--network', network];
}

export async function lifecycleDockerEndpoint(command, name, network) {
  lifecycleDockerNetworkArgs(network);
  const published = (await command(['port', name, '5688/tcp'])).trim();
  assert.match(published, /^127\.0\.0\.1:\d+$/, 'Fixture publication must remain loopback-only');
  // A tools container's loopback is not the Docker daemon host's loopback.
  // Docker DNS resolves sibling Capsule names on the shared user-defined bridge.
  return network ? `http://${name}:5688` : `http://${published}`;
}

export function assertGenerationObservation(generations, observation, probe, response) {
  const deniedGroup = generations.get(observation.digest);
  assert.ok(deniedGroup, 'decision used an unknown/partial generation');
  const denied = probe.group === deniedGroup;
  assert.equal(observation.transport, probe.transport);
  assert.equal(observation.outcome, denied ? 'denied' : 'admitted', 'mixed generation decision');
  assert.equal(response.status, denied ? 403 : probe.transport === 'http' ? 200 : 101, 'mixed generation response');
  return denied;
}
