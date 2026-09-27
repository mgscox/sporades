#!/usr/bin/env node
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  for (const name of ['.dockerignore', '.env.example', 'Dockerfile.gateway', 'README.md', 'collector.yaml', 'compose.yaml', 'gateway.mjs', 'jaeger.yaml', 'setup.mjs', 'smoke.mjs']) {
    await cp(join(source, name), join(directory, name));
  }
  await cp(join(source, 'gitignore.template'), join(directory, '.gitignore'));
  await writeFile(join(directory, 'stack-manifest.json'), `${JSON.stringify({ schemaVersion: 1, packageVersion: version }, null, 2)}\n`);
  const packed = spawnSync('tar', ['-czf', output, '-C', temporary, basename], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (packed.status !== 0) throw new Error(packed.stderr.trim() || 'tar failed');
  process.stdout.write(`${output}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
