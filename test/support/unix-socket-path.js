import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

let aliasesRoot;
const aliases = new Map();

// Unix sun_path limits count the supplied pathname, including relative names.
// An owned short alias keeps the actual socket in job-backed scratch even when
// both checkout and TMPDIR prefixes are longer than the OS permits.
// All listeners and clients (including children) must retain the same cwd.
export function unixSocketPath(filename) {
  const absolute = path.resolve(filename);
  if (Buffer.byteLength(absolute) <= 100) return absolute;
  const relative = path.relative(process.cwd(), absolute);
  if (Buffer.byteLength(relative) <= 100) return relative;
  if (!aliasesRoot) {
    if (process.env.SPORADES_TEST_SOCKET_ALIASES) {
      aliasesRoot = process.env.SPORADES_TEST_SOCKET_ALIASES;
    } else {
      mkdirSync('.tmp', { recursive: true });
      aliasesRoot = mkdtempSync(path.resolve('.tmp/socket-alias-'));
      process.once('exit', () => rmSync(aliasesRoot, { recursive: true, force: true }));
    }
  }
  const directory = path.dirname(absolute);
  if (!aliases.has(directory)) {
    const alias = path.join(aliasesRoot, `${process.pid}-${aliases.size}`);
    symlinkSync(directory, alias, 'dir');
    aliases.set(directory, alias);
  }
  const short = path.relative(process.cwd(), path.join(aliases.get(directory), path.basename(absolute)));
  if (Buffer.byteLength(short) > 100) throw Error('Unix socket fixture needs a short socket name and a shared checkout cwd');
  return short;
}
