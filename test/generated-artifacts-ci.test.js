import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parsePackedArtifact } from '../scripts/package.mjs';

const check = path.resolve('scripts/check-pr-generated-artifacts.mjs');
const regenerate = path.resolve('scripts/regenerate-artifacts-ci.sh');
function run(cwd, command, args, ok = true) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'CI test', GIT_AUTHOR_EMAIL: 'ci@example.test', GIT_COMMITTER_NAME: 'CI test', GIT_COMMITTER_EMAIL: 'ci@example.test' } });
  if (ok) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const git = (cwd, ...args) => run(cwd, 'git', args).stdout.trim();

test('local-runner PR check uses trusted base code and an inline checker identical to the tested script', async () => {
  const workflow = await readFile('.github/workflows/generated-artifacts.yml', 'utf8');
  const inline = workflow.match(/<<'NODE'\n([\s\S]*?)\n          NODE/);
  assert(inline, 'inline checker is missing');
  assert.equal(inline[1].split('\n').map(line => line.slice(10)).join('\n') + '\n', await readFile(check, 'utf8'));
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(workflow, /git fetch --no-tags origin "refs\/pull\/\$PR_NUMBER\/head"/);
  assert.doesNotMatch(workflow, /run: node scripts\/check-pr-generated-artifacts/);
});

test('release packing includes CLI, dist, and the generated source manifest', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sporades-release-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Same packing primitive as package.mjs, without publication or tagging.
  const packed = run(process.cwd(), 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root]);
  const artifact = parsePackedArtifact(packed.stdout);
  const contents = run(root, 'tar', ['-tzf', artifact.filename]).stdout.split('\n');
  for (const file of ['bin/sporades.js', 'bin/sporades-host-helper.js', 'dist/server.js', 'dist/generated-source-manifest.json']) {
    assert(contents.includes(`package/${file}`), `${file} is absent from the release tarball`);
  }
});
async function commit(root, file, contents) {
  await writeFile(path.join(root, file), contents);
  git(root, 'add', '--', file);
  git(root, 'commit', '-m', `Update ${file}`);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sporades-artifacts-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  for (const dir of ['src', 'dist', 'bin']) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ci-fixture', version: '1.0.0', scripts: { build: 'node build.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'ci-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'ci-fixture', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'build.mjs'), `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
for (const dir of ['dist', 'bin']) { mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/output.js', readFileSync('src/input.ts')); }
`);
  await writeFile(path.join(root, 'src/input.ts'), 'old\n');
  run(root, 'npm', ['run', 'build']);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial');
  return root;
}

test('PR check accepts source-only changes with older committed generated files', async t => {
  const root = await fixture(t);
  const base = git(root, 'rev-parse', 'HEAD');
  await commit(root, 'src/input.ts', 'new\n');
  run(root, 'node', [check, base, 'HEAD']);
  // A later main regeneration must not make an unchanged PR fail either.
  git(root, 'branch', 'pr');
  git(root, 'checkout', '-b', 'base', base);
  await commit(root, 'dist/output.js', 'main build\n');
  run(root, 'node', [check, 'base', 'pr']);
  git(root, 'checkout', 'pr');
  git(root, 'checkout', 'base', '--', 'dist', 'bin');
  git(root, 'commit', '-m', 'Restore generated files from main');
  run(root, 'node', [check, 'base', 'HEAD']);
});

test('restoring a generated filename with wildcard characters compares only that literal path', async t => {
  const root = await fixture(t);
  await commit(root, 'dist/a.js', 'old\n');
  await commit(root, 'dist/[ab].js', 'old\n');
  const ancestor = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-c', 'pr');
  await commit(root, 'src/input.ts', 'new source\n');
  git(root, 'switch', '-c', 'base', ancestor);
  await commit(root, 'dist/a.js', 'main build\n');
  await commit(root, 'dist/[ab].js', 'main build\n');
  git(root, 'switch', 'pr');
  git(root, '--literal-pathspecs', 'checkout', 'base', '--', 'dist/[ab].js');
  git(root, 'commit', '-m', 'Restore literal generated path');
  run(root, 'node', [check, 'base', 'HEAD']);
});

test('PR check rejects generated additions, edits, deletions and renames with recovery instructions', async t => {
  const root = await fixture(t);
  const base = git(root, 'rev-parse', 'HEAD');
  for (const kind of ['addition', 'wildcard addition', 'edit', 'deletion', 'rename']) {
    git(root, 'reset', '--hard', base);
    if (kind === 'addition') await writeFile(path.join(root, 'dist/new.js'), 'new');
    if (kind === 'wildcard addition') await writeFile(path.join(root, 'dist/[ab].js'), 'new');
    if (kind === 'edit') await writeFile(path.join(root, 'bin/output.js'), 'edited');
    if (kind === 'deletion') await rm(path.join(root, 'dist/output.js'));
    if (kind === 'rename') git(root, 'mv', 'bin/output.js', 'src/moved.ts');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', kind);
    const result = run(root, 'node', [check, base, 'HEAD'], false);
    assert.equal(result.status, 1, kind);
    assert.match(result.stderr, /git checkout origin\/main -- dist bin/);
  }
});

test('regeneration refuses a PR checkout or dirty tracked files before building', async t => {
  const root = await fixture(t);
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-c', 'feature');
  const branchResult = run(root, 'bash', [regenerate], false);
  assert.equal(branchResult.status, 1);
  assert.match(branchResult.stderr, /main checkout/);
  git(root, 'switch', 'main');
  await writeFile(path.join(root, 'src/input.ts'), 'uncommitted\n');
  const dirtyResult = run(root, 'bash', [regenerate], false);
  assert.equal(dirtyResult.status, 1);
  assert.match(dirtyResult.stderr, /clean checkout/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(root, 'src/input.ts'), 'utf8'), 'uncommitted\n');
});

test('a failed build leaves main without an artifact commit or push', async t => {
  const root = await fixture(t);
  await commit(root, 'build.mjs', 'process.exit(7);\n');
  const head = git(root, 'rev-parse', 'HEAD');
  const result = run(root, 'bash', [regenerate], false);
  assert.notEqual(result.status, 0);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});

test('main regeneration removes obsolete tracked outputs that the compiler no longer emits', async t => {
  const root = await fixture(t);
  for (const dir of ['dist', 'bin']) await commit(root, `${dir}/obsolete.js`, 'obsolete\n');
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  run(root, 'bash', [regenerate]);
  for (const dir of ['dist', 'bin']) {
    await assert.rejects(access(path.join(root, dir, 'obsolete.js')), { code: 'ENOENT' });
  }
  assert.equal(git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'origin/main'));
});

test('regeneration never seals uncommitted build changes outside dist and bin', async t => {
  const root = await fixture(t);
  await commit(root, 'owned-source.txt', 'committed source\n');
  const build = await readFile(path.join(root, 'build.mjs'), 'utf8');
  await commit(root, 'build.mjs', build + "writeFileSync('owned-source.txt', 'changed by build');\n");
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  const head = git(root, 'rev-parse', 'HEAD');
  const result = run(root, 'bash', [regenerate], false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside dist\/bin/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'origin/main'), head);
});

for (const race of ['none', 'once', 'twice']) {
  test(`main regeneration dry run: push race ${race}`, async t => {
    const root = await fixture(t);
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
    const publisher = path.join(root, 'publisher');
    git(root, 'clone', '-b', 'main', remote, publisher);
    await commit(root, 'src/input.ts', 'new\n');
    git(root, 'push', 'origin', 'main');
    if (race !== 'none') {
      const hook = `#!/usr/bin/env bash
set -eu
count_file="$(git rev-parse --git-dir)/race-count"
count=0
if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi
if (( count < ${race === 'once' ? 1 : 2} )); then
  echo $((count + 1)) > "$count_file"
  git -C '${publisher}' pull --ff-only origin main >&2
  echo "race-$count" > '${publisher}/src/input.ts'
  git -C '${publisher}' add src/input.ts
  git -C '${publisher}' commit -m 'Concurrent merge' >&2
  git -C '${publisher}' push origin main >&2
fi
`;
      await writeFile(path.join(root, '.git/hooks/pre-push'), hook, { mode: 0o755 });
    }
    const result = run(root, 'bash', [regenerate], false);
    if (race === 'twice') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /retry|rejected/i);
      return;
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    git(root, 'fetch', 'origin', 'main');
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'origin/main'));
    assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore: regenerate dist and bin [skip ci]');
    assert.equal(await readFile(path.join(root, 'dist/output.js'), 'utf8'), await readFile(path.join(root, 'src/input.ts'), 'utf8'));
    assert.equal(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'bin/output.js\ndist/output.js');
    const head = git(root, 'rev-parse', 'HEAD');
    run(root, 'bash', [regenerate]);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'no-op build must not commit again');
  });
}
