import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { probeAppBinding, expectedAppBinding } from './support/app-binding-probe.js';

const run = promisify(execFile);
test('generated Bundles preserve readonly app bindings in registration and table ACL callbacks', { timeout: 60000 }, async t => {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/origin-callback-bundle-'));
  const serverSource = `import { capsule, query, table, String as Text } from 'sporades/server';
${probeAppBinding.toString()}
const observations = {};
export default capsule({name:'origin-callback-bundle',
  schema:{proofs:table({origin:Text()}).acl({read:({ctx})=>{observations.acl=probeAppBinding(ctx);return true;}})},
  auth:{registration:{
    admit(ctx){observations.admit=probeAppBinding(ctx);return {allow:true};},
    async finalize(ctx){observations.finalize=probeAppBinding(ctx);await ctx.db.proofs.insert({origin:ctx.app.publicOrigin});}
  }},
  queries:{proofs:query(async ctx=>({origins:(await ctx.db.proofs.all()).map(row=>row.origin),observations}))}
});`;
  try {
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    const source = await createServerBundleModuleSource({ config: { name: 'origin-callback-bundle', auth: { providers: { anonymous: true, email: true } } },
      serverEnv: {}, serverSource, serverModuleSource,
      epilogue: `import {resolveAnonymousSession as probeGuest,signUpWithEmail as probeSignup,runQuery as probeQuery} from '../server-runtime-source.js';
const owner=await probeSignup(database,await probeGuest(database,null),'email',{email:'bundle@example.com',password:'password-123'});
if(!owner.ok) throw new Error(JSON.stringify(owner.error));
const result=await probeQuery(database,owner.auth,'proofs');
if(result.error) throw new Error(JSON.stringify(result.error));
process.stdout.write(JSON.stringify({callbackProbe:result.data})+'\\n');
await new Promise(resolve=>server.close(resolve));
await database.close();
process.exit(0);`,
    });
    for (const session of ['container', 'hosted']) await t.test(session, async () => {
      const dir = path.join(root, session); await mkdir(dir);
      await writeFile(path.join(dir, 'server.mjs'), source);
      const origin = `https://${session}.example`;
      const env = { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(dir, 'config'),
        SPORADES_SECURITY_SESSION: session, SPORADES_PUBLIC_ORIGIN: origin };
      delete env.SPORADES_CONTAINER_PUBLIC_ORIGIN;
      const { stdout } = await run(process.execPath, ['server.mjs'], { cwd: dir, env, timeout: 20000 });
      const result = stdout.split('\n').map(line => { try { return JSON.parse(line).callbackProbe; } catch { return null; } }).find(Boolean);
      assert.deepEqual(result, { origins: [origin], observations: {
        admit: expectedAppBinding(origin), finalize: expectedAppBinding(origin), acl: expectedAppBinding(origin),
      } });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
