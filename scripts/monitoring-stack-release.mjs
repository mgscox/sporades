#!/usr/bin/env node
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ASSETS, STACK_SCHEMA } from '../dist/cli/monitoring-stack.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'monitoring', 'trace');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[2] ?? join(root, `sporades-monitoring-trace-${version}.tar.gz`));
const temporary = await mkdtemp(join(tmpdir(), 'sporades-trace-release-'));
const basename = `sporades-monitoring-trace-${version}`;
try {
  const directory = join(temporary, basename);
  await mkdir(directory);
  const assets = {};
  for (const name of ASSETS) {
    await cp(join(source, name === '.gitignore' ? 'gitignore.template' : name), join(directory, name));
    assets[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
  }
  await writeFile(join(directory, 'stack-manifest.json'), `${JSON.stringify({ schemaVersion: STACK_SCHEMA, packageVersion: version, assets }, null, 2)}\n`);
  const packed = spawnSync('tar', ['-czf', output, '-C', temporary, basename], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (packed.status !== 0) throw new Error(packed.stderr.trim() || 'tar failed');
  process.stdout.write(`${output}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
