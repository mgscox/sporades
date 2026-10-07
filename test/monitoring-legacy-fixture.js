import { readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ASSETS } from '../dist/cli/monitoring-stack.js';

export async function legacyPipelineGeneration(stack) {
  const fixture = JSON.parse(gunzipSync(await readFile(new URL('./fixtures/monitoring-schema4/assets.json.gz', import.meta.url))));
  for (const name of ASSETS) {
    if (!(name in fixture.files)) await rm(path.join(stack, name), { force: true });
  }
  for (const [name, bytes] of Object.entries(fixture.files)) {
    await writeFile(path.join(stack, name), bytes);
    await chmod(path.join(stack, name), 0o644);
  }
  const manifest = {
    schemaVersion: fixture.schemaVersion,
    packageVersion: fixture.packageVersion,
    assets: Object.fromEntries(Object.entries(fixture.files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  };
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify(manifest));
  return fixture.files;
}
