import path from 'node:path';

// Unix sun_path limits count pathname bytes, even when the filesystem accepts
// a much longer path. Keep sockets in their owned fixture and use a relative
// name when the checkout/TMPDIR prefix would exceed Darwin's or Linux's limit.
// The listener and all clients must retain the same cwd (including children).
export function unixSocketPath(filename) {
  const absolute = path.resolve(filename);
  if (Buffer.byteLength(absolute) <= 100) return absolute;
  const relative = path.relative(process.cwd(), absolute);
  if (Buffer.byteLength(relative) > 100) {
    throw new Error('Unix socket fixture needs a directory within 100 pathname bytes of cwd');
  }
  return relative;
}
