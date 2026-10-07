// Real local proxy evidence using the existing shipped-route acceptance check.
// Host orchestration is fake; no real Host, SSH or provider is contacted.
import { run } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRequiredCaddyProof } from '../test/support/admission-lifecycle-proof.js';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.join(repo, '.sporades/issue-73');
await mkdir(root, { recursive: true });
process.env.SPORADES_CONFIG_DIR = path.join(root, 'config');
const name = 'real Caddy rewrites Hosted identity and gates simulated Cloudflare traffic before admission';
const report = { mode: 'local-caddy-route', status: 'incomplete',
  check: name, results: { passed: 0, failed: 0, skipped: 0, cancelled: 0 },
  pending: ['actual Host deployment/readiness/route publication; this check stubs Docker and Host service management',
    'real Cloudflare-origin infrastructure; the allowed-source case is explicitly simulated'] };
try {
  if (!process.env.SPORADES_CADDY_ACCEPTANCE_BIN) throw new Error('A local Caddy executable is required');
  report.caddyVersion = (await promisify(execFile)(process.env.SPORADES_CADDY_ACCEPTANCE_BIN, ['version'], { timeout: 5000 })).stdout.trim();
  for await (const event of run({ files: [path.join(repo, 'test/host.test.js')],
    testNamePatterns: [new RegExp('^' + name + '$')], concurrency: 1 })) {
    if (event.type === 'test:fail') report.results.failed++;
    if (event.data.name === name) {
      if (event.data.skip || event.data.todo) report.results.skipped++;
      else if (event.type === 'test:pass') report.results.passed++;
      if (event.type === 'test:fail') process.stderr.write(String(event.data.details?.error) + '\n');
    }
    if (event.type === 'test:summary') report.results.cancelled = Math.max(report.results.cancelled, event.data.counts.cancelled);
  }
  assertRequiredCaddyProof(report.results);
  report.status = 'proxy-boundary-passed';
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'caddy-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
