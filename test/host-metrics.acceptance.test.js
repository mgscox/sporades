import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('installed CLI preserves Host/Caddy config and delivers independent Host metrics', {
  skip: process.env.SPORADES_HOST_METRICS_TEST_ROOT ? false : 'Set SPORADES_HOST_METRICS_TEST_ROOT and SPORADES_HOST_METRICS_TEST_URL for the disposable Linux VM harness.',
  timeout: 360_000,
}, async () => {
  await run(process.execPath, ['scripts/verify-host-metrics.mjs'], { timeout: 350_000, maxBuffer: 2 * 1024 * 1024 });
});
