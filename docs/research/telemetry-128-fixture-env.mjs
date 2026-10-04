import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// Short relative Unix-socket paths; fixture files still live inside this worktree.
// Other test files retain absolute paths for their child-process cwd contracts.
if (path.basename(process.argv[1] ?? '') === 'file-ingress.test.js') {
  process.env.TMPDIR = fileURLToPath(new URL('../issue-128-tmp', import.meta.url));
  const worktree = fileURLToPath(new URL('../../', import.meta.url));
  const socketPath = (value) => typeof value === 'string' && value.startsWith(worktree) && Buffer.byteLength(value) > 100 ? path.relative(process.cwd(), value) : value;
  const address = (value) => value && typeof value === 'object' && typeof value.path === 'string' ? {...value, path: socketPath(value.path)} : socketPath(value);
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) { args[0] = address(args[0]); return originalListen.apply(this, args); };
  const originalCreateConnection = net.createConnection;
  net.createConnection = (...args) => { args[0] = address(args[0]); return originalCreateConnection(...args); };
  net.connect = net.createConnection;
  syncBuiltinESMExports();
} else if (path.basename(process.argv[1] ?? '') === 'generated-source-manifest.test.js') {
  process.env.TMPDIR = fileURLToPath(new URL('../issue-128-esm-tmp', import.meta.url));
} else {
  process.env.TMPDIR = fileURLToPath(new URL('../issue-128-tmp', import.meta.url));
}
