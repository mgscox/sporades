import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { baseImageMetadata, baseImageRuntimeUser } from '../dist/base-image.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';
import { preservedDeployFilePath } from '../dist/deploy-files.js';
import { resetWebSocketUpgrade } from './helpers/reset-websocket-upgrade.js';

const run = promisify(execFile);
const enabled = process.env.SPORADES_REAL_ADMISSION_CONTAINER === '1';
for (const status of [403, 429]) {
  test(`real Base image survives reset clients during ${status} generated upgrade denial`, { skip: !enabled, timeout: 60000 }, async t => {
    const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ws-container-'));
    const name = `sporades-ws-reset-${status}-${randomBytes(5).toString('hex')}`;
    let started = false;
    try {
      const serverSource = `import {capsule} from 'sporades/server'; export default capsule({name:'reset',schema:{}});`;
      const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
      await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({
        config: { name: 'reset', admissionPolicy: { path: 'policy.json' } }, serverEnv: {}, serverSource, serverModuleSource,
      }));
      const policyDir = path.join(root, 'policy');
      await mkdir(policyDir);
      await writeFile(preservedDeployFilePath(policyDir, 'policy.json'), JSON.stringify({ version: 1, rules: [{
        id: 'reset-denial', enabled: true, conditions: [{ kind: 'pathname', exact: '/__sporades/ws' }],
        action: status === 403 ? { kind: 'deny' } : { kind: 'rate-limit', limit: 1, windowMs: 60000 },
      }] }), { mode: 0o444 });
      const dataDir = path.join(root, 'data'); await mkdir(dataDir); await chmod(dataDir, 0o777);
      const probe = 'a'.repeat(64);
      // The 429 uses a local fake Host capability: Dev/Container address quotas
      // intentionally fail closed with 403 when trusted Hosted identity is absent.
      await run('docker', ['run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', baseImageRuntimeUser(),
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec', '-v', `${root}/server.mjs:/app/server.mjs:ro`,
        '-v', `${dataDir}:/app/data:rw`, '-v', `${policyDir}:/run/sporades-admission:ro`,
        '-e', 'PORT=5688', '-e', `SPORADES_SECURITY_SESSION=${status === 429 ? 'hosted' : 'container'}`,
        '-e', 'SPORADES_ADMISSION_POLICY_PATH=policy.json', '-e', `SPORADES_RUNTIME_PROBE_TOKEN=${probe}`,
        baseImageMetadata().image], { timeout: 30000 });
      started = true;
      // Run on container loopback: Docker's published-port proxy can absorb RST.
      const script = `
        import assert from 'node:assert/strict';
        import {request} from 'node:http';
        const base = 'http://127.0.0.1:5688';
        const target = '/__sporades/ws';
        const headers = ${JSON.stringify(status === 429 ? {
          'x-sporades-client-address': '192.0.2.1', 'x-sporades-client-address-token': clientAddressBoundaryToken(probe),
        } : {})};
        const health = async () => {
          const response = await fetch(base + '/__sporades/health/runtime', {headers:{'x-sporades-host-probe':'${probe}'}});
          assert.equal(response.status, 200); await response.json();
        };
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) {
          try { await health(); ready = true; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
        }
        assert.ok(ready, 'runtime did not start');
        if (${status} === 429) assert.equal((await fetch(base + target, {headers})).status, 404);
        const denial = () => new Promise((resolve, reject) => {
          const req = request(base + target, {headers:{...headers,connection:'Upgrade',upgrade:'websocket',
            'sec-websocket-version':'13','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ=='}}, res => {
              let body = ''; res.on('data', chunk => body += chunk);
              res.on('end', () => resolve({status:res.statusCode, body}));
            });
          req.on('upgrade', (_, socket) => {socket.destroy(); reject(new Error('unexpected protocol switch'));});
          req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('denial timeout'))); req.end();
        });
        assert.deepEqual(await denial(), {status:${status},body:${JSON.stringify(status === 403 ? 'Forbidden\n' : 'Too Many Requests\n')}});
        const reset = ${resetWebSocketUpgrade.toString()};
        for (let i = 0; i < 20; i++) { await reset(base, target, headers); await health(); }
        assert.equal((await denial()).status, ${status});
        console.log('Node ' + process.versions.node + ': ${status} reset survival passed');
      `;
      const result = await run('docker', ['exec', name, 'node', '--input-type=module', '-e', script], { timeout: 20000 });
      assert.match(result.stdout, /reset survival passed/);
      t.diagnostic(result.stdout.trim());
      assert.equal((await run('docker', ['inspect', '--format', '{{.State.Running}}', name])).stdout.trim(), 'true');
    } catch (error) {
      if (started) error.message += '\n' + (await run('docker', ['logs', name])).stderr;
      throw error;
    } finally {
      if (started) await run('docker', ['rm', '-f', name]);
      await rm(root, { recursive: true, force: true });
    }
  });
}
