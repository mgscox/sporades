import { pathToFileURL } from 'node:url';

// Node resolves --test-reporter through the ESM loader, which rejects a bare
// Windows drive path (C:\...) as a "c:" URL scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// The reporter is always a file:// URL; positional test file arguments stay paths.
export function testHarnessArgs({ reporter, file }) {
  return ['--test', '--test-concurrency=1', `--test-reporter=${pathToFileURL(reporter).href}`, file];
}