import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('shipped Bundle protects launch-owned public origin, preserves local fallback and logs unresolved deployed origin', { timeout: 90000 }, async t => {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/origin-bundle-'));
  try {
    for (const withMiddleware of [false, true]) {
      const serverSource = `import { capsule, endpoint } from 'sporades/server';
  export default capsule({name:'origin-bundle', middleware:${withMiddleware ? '[ctx => ({ ...ctx })]' : '[]'},
    endpoints:{ origin:endpoint({method:'GET',path:'/origin'},ctx=>{
      const app = ctx.app;
      const { writable, configurable } = Object.getOwnPropertyDescriptor(ctx, 'app');
      const forged = { publicOrigin: 'https://forged.example' };
      const attempts = [];
      for (const operation of [
        () => Reflect.set(ctx, 'app', forged),
        () => Reflect.deleteProperty(ctx, 'app'),
        () => Reflect.defineProperty(ctx, 'app', { value: forged }),
      ]) {
        const accepted = operation();
        attempts.push({ accepted, unchanged: ctx.app === app, origin: ctx.app?.publicOrigin });
      }
      return {status:200,body:{origin:ctx.app.publicOrigin,frozen:Object.isFrozen(ctx.app),writable,configurable,attempts}};
    }) }});`;
      const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
      for (const item of [
        { name: 'container config', session: 'container', deploy: { publicOrigin: 'https://configured.example' }, envOrigin: 'https://env.example', expected: 'https://configured.example' },
        { name: 'container launch snapshot', session: 'container', deploy: { publicOrigin: 'https://changed-after-deploy.example' }, launchOrigin: 'https://deployed.example', expected: 'https://deployed.example' },
        { name: 'container env', session: 'container', envOrigin: 'https://env.example', expected: 'https://env.example' },
        { name: 'hosted alias', session: 'hosted', deploy: { publicOrigin: 'https://ignored.example' }, envOrigin: 'https://canonical.example', expected: 'https://canonical.example' },
        { name: 'hosted subdomain', session: 'hosted', envOrigin: 'https://capsule.host.example', expected: 'https://capsule.host.example' },
        { name: 'container fallback', session: 'container', deploy: { port: 5689 }, expected: 'http://localhost:5689', warning: true },
      ]) await t.test(`${item.name} ${withMiddleware ? 'with' : 'without'} middleware`, async () => {
        const dir = path.join(root, `${item.name.replaceAll(' ', '-')}-${withMiddleware}`);
        await mkdir(dir);
        const source = await createServerBundleModuleSource({ config: { name: 'origin-bundle', deploy: item.deploy }, serverEnv: {}, serverSource, serverModuleSource,
          epilogue: 'process.stdout.write(JSON.stringify({listening:server.address().port})+"\\n");' });
        await writeFile(path.join(dir, 'server.mjs'), source);
        const env = { ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: item.session, SPORADES_CONFIG_DIR: path.join(dir, 'config') };
        delete env.SPORADES_PUBLIC_ORIGIN;
        if (item.envOrigin) env.SPORADES_PUBLIC_ORIGIN = item.envOrigin;
        if (item.launchOrigin) env.SPORADES_CONTAINER_PUBLIC_ORIGIN = item.launchOrigin;
        let output = '', errors = '';
        const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env });
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
        try {
          let port;
          const deadline = Date.now() + 20000;
          while (!port && Date.now() < deadline) {
            port = output.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
            if (child.exitCode !== null) assert.fail(output + errors);
            if (!port) await pause(30);
          }
          assert(port, output + errors);
          const result = await fetch(`http://127.0.0.1:${port}/origin`);
          assert.equal(result.status, 200);
          assert.deepEqual(await result.json(), { origin: item.expected, frozen: true, writable: false, configurable: false,
            attempts: Array.from({ length: 3 }, () => ({ accepted: false, unchanged: true, origin: item.expected })) });
          // Hosted CORS must still admit the Host subdomain as well as the canonical alias.
          if (item.warning) {
            const { readFile } = await import('node:fs/promises');
            assert.match(await readFile(path.join(dir, 'data/logs/events.jsonl'), 'utf8'), /app.publicOrigin.unresolved/);
          }
        } finally {
          child.kill('SIGTERM');
          await Promise.race([once(child, 'exit'), pause(3000)]);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
