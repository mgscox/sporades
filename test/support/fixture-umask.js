// Synthetic Hosts model protected installation paths. A desk's inherited 0002
// umask must not turn their default-created files/directories into writable Host
// state. Keep explicit chmod/umask attacks and restrictive-mode cases effective.
// These helpers are process-wide: use only in serial fixture/test lifecycles.
export async function withFixtureUmask(operation) {
  const previous = process.umask(0o022);
  try { return await operation(); }
  finally { process.umask(previous); }
}

export function useFixtureUmask(t) {
  const previous = process.umask(0o022);
  t.after(() => process.umask(previous));
}
