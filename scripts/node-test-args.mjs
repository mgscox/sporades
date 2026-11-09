import { pathToFileURL } from 'node:url';

// `node --test` loads the --test-reporter module through the ESM loader, which
// on Windows rejects drive-letter paths (ERR_UNSUPPORTED_ESM_URL_SCHEME) and on
// every platform accepts a file: URL. Test file paths stay positional plain
// paths; only module specifiers need the URL form.
export function nodeTestArgs({ reporterPath, file }) {
  return ['--test', '--test-concurrency=1', `--test-reporter=${pathToFileURL(reporterPath).href}`, file];
}