import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('installed Host bootstrap resumes eligible Capsules after a real VM reboot', {
  skip: process.env.SPORADES_HOST_AUTOSTART_TEST_ROOT ? false : 'Set SPORADES_HOST_AUTOSTART_TEST_ROOT for the prepared disposable VM harness.',
  timeout: 200_000,
}, async () => {
  await run(process.execPath, ['scripts/verify-host-autostart.mjs'], { timeout: 190_000, maxBuffer: 1024 * 1024 });
});
