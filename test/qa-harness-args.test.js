import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testHarnessArgs } from '../scripts/test-harness-args.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('the gate passes its custom reporter as a file:// URL module identifier', () => {
  const reporterPath = path.join(root, 'scripts/test-reporter.mjs');
  const testFile = path.join(root, 'test/qa-runner.test.js');
  const args = testHarnessArgs({ reporter: reporterPath, file: testFile });
  assert.equal(args[0], '--test');
  assert.equal(args[1], '--test-concurrency=1');
  assert.equal(args[2], `--test-reporter=${pathToFileURL(reporterPath).href}`);
  assert.ok(args[2].startsWith('--test-reporter=file://'), args[2]);
  assert.deepEqual(args.slice(3), [testFile]);
});

test('a Windows-shaped reporter path is never passed raw as a module identifier', () => {
  const args = testHarnessArgs({ reporter: 'C:\\sporades\\scripts\\test-reporter.mjs', file: 'test/x.test.js' });
  const reporter = args.find(a => a.startsWith('--test-reporter='));
  assert.match(reporter, /^--test-reporter=file:\/\//);
  assert.ok(!/[A-Za-z]:\\/.test(reporter), reporter);
});