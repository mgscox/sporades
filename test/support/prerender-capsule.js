import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// One renderer fixture shared by Dev, real Container and local Hosted-release tests.
export async function installPrerenderFixture(projectDir) {
  const configPath = path.join(projectDir, 'sporades.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.client = { ...config.client, toolchain: 'vite', prerender: [{ name: 'landing', module: 'render/landing.ts' }] };
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(path.join(projectDir, 'render'), {recursive:true});
  await writeFile(path.join(projectDir, 'render/copy.ts'), 'export const copy: string = "Useful before JavaScript";');
  await writeFile(path.join(projectDir, 'render/landing.ts'), `import { copy } from './copy.ts';
export default () => '<main id="prerender-static">' + copy + '</main><footer>Static fallback remains</footer>'
  + (process.env.PRERENDER_FIXTURE_SECRET ?? '') + (process.env.VITE_PRERENDER_FIXTURE_SECRET ?? '');`);
  for (const [file, value] of [
    ['.env', 'VITE_PRERENDER_FIXTURE_SECRET=project-env-prerender-must-not-ship'],
    ['.env.sporades.server', 'PRERENDER_FIXTURE_SECRET=server-env-prerender-must-not-ship'],
  ]) {
    const previous = await readFile(path.join(projectDir, file), 'utf8').catch(() => '');
    await writeFile(path.join(projectDir, file), `${previous}\n${value}\n`);
  }
  return config;
}
