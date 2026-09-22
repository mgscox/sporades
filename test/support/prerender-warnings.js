import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function installPrerenderWarnings(projectDir) {
  const configPath = path.join(projectDir, 'sporades.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.client.prerender = [{ name:'landing', module:'render.mjs' }, { name:'unused', module:'render.mjs' }];
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(projectDir, 'render.mjs'), 'export default () => "<main>Static shell</main>";');
  const htmlPath = path.join(projectDir, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, html.replace('<body>', '<body><!-- sporades:prerender landing --><!-- sporades:prerender landing --><!-- sporades:prerender typo -->'));
}

export function assertPrerenderWarnings(result, json) {
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const expected = [
    {code:'PRERENDER_UNKNOWN_MARKER', fragment:'typo', message:'Unknown prerender marker "typo" remains a comment in index.html.'},
    {code:'PRERENDER_DUPLICATE_PLACEMENT', fragment:'landing', message:'Prerender fragment "landing" is placed 2 times in index.html.'},
    {code:'PRERENDER_UNUSED_FRAGMENT', fragment:'unused', message:'Configured prerender fragment "unused" has no placement in index.html.'},
  ];
  if (json) {
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.warnings, expected);
  } else {
    for (const warning of expected) assert.ok(result.stdout.includes(`Warning [${warning.code}]: ${warning.message}`), result.stdout);
  }
}
