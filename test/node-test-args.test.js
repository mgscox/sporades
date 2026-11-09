import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { nodeTestArgs } from '../scripts/node-test-args.mjs';

test('nodeTestArgs passes the custom reporter as a file: URL the ESM loader accepts', () => {
  const args = nodeTestArgs({ reporterPath: path.join('/repo', 'scripts', 'test-reporter.mjs'), file: path.join('/repo', 'test', 'example.test.js') });
  assert.deepEqual(args.slice(0, 2), ['--test', '--test-concurrency=1']);
  const reporterArg = args[2];
  assert.ok(reporterArg.startsWith('--test-reporter=file://'), `reporter must be a file: URL, got ${reporterArg}`);
  assert.equal(new URL(reporterArg.slice('--test-reporter='.length)).protocol, 'file:');
});

test('nodeTestArgs keeps a Windows drive-letter reporter path loadable instead of raw', () => {
  // A raw `C:\...` value here is what Node rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const windowsReporter = 'C:\\repo\\scripts\\test-reporter.mjs';
  const [reporterArg, fileArg] = nodeTestArgs({ reporterPath: windowsReporter, file: 'C:\\repo\\test\\example.test.js' }).slice(2);
  assert.ok(reporterArg.startsWith('--test-reporter=file:///'), `reporter must be a file: URL, got ${reporterArg}`);
  const url = new URL(reporterArg.slice('--test-reporter='.length));
  assert.equal(url.protocol, 'file:');
  // The raw drive-letter path is exactly what Node's ESM loader rejects.
  assert.notEqual(reporterArg, `--test-reporter=${windowsReporter}`);
  // The test file stays a positional plain path, which node --test accepts as a path.
  assert.equal(fileArg, 'C:\\repo\\test\\example.test.js');
});

test('nodeTestArgs reporter URL round-trips to the reporter module', () => {
  const args = nodeTestArgs({ reporterPath: path.join('/repo', 'scripts', 'test-reporter.mjs'), file: 'x.test.js' });
  assert.equal(new URL(args[2].slice('--test-reporter='.length)).href, pathToFileURL(path.join('/repo', 'scripts', 'test-reporter.mjs')).href);
});