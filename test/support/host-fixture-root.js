import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

// CLI configuration remains worktree-local even when the simulated Host's
// protected remote filesystem needs a different temporary base.
export function hostFixtureConfig(root, name = 'config') {
  return path.join(repo, '.tmp', 'host-fixture-configs', path.basename(root), name);
}

export async function removeHostFixture(root) {
  await Promise.all([rm(root, { recursive: true, force: true }),
    rm(path.dirname(hostFixtureConfig(root)), { recursive: true, force: true })]);
}

async function trustedBase(base, privateAncestors) {
  const uid = process.geteuid?.();
  for (let current = base; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) return false;
    // Host routes permit a root-owned sticky temporary ancestor. Backup secret
    // paths deliberately have the stricter no-writable-ancestor contract.
    if ((stat.mode & 0o022) && (privateAncestors || stat.uid !== 0 || !(stat.mode & 0o1000))) return false;
    if (current === path.dirname(current)) return true;
  }
}

// Use the requested temporary root when it models a protected Host installation.
// Desk checkouts often have shared ancestors; never chmod those ancestors or
// mock away the real trust checks. Allocate only a fresh owned directory, and
// let each fixture remove that exact directory in its existing cleanup hook.
export async function createHostFixture(prefix, { privateAncestors = false } = {}) {
  for (const candidate of new Set([tmpdir(), '/tmp', homedir()])) {
    try {
      const base = await realpath(candidate);
      if (!await trustedBase(base, privateAncestors)) continue;
      return await mkdtemp(path.join(base, prefix));
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) continue;
      throw error;
    }
  }
  throw new Error('Host fixtures require a user/root-owned temporary base with protected ancestors' + (privateAncestors ? ' (backup secrets cannot use writable sticky ancestors)' : ''));
}
