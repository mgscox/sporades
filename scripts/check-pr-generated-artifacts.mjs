import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) throw new Error('Usage: node scripts/check-pr-generated-artifacts.mjs <base-sha> <head-sha>');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const ancestor = git('merge-base', base, head).trim();
const changed = git('diff', '--no-renames', '--name-only', '-z', ancestor, head, '--', 'dist/', 'bin/').split('\0').filter(Boolean);
// Main may have regenerated since the PR forked. Unchanged old output is fine;
// restoring files from current main (the fix below) is also fine.
const forbidden = changed.filter(file => git('diff', '--no-renames', '--name-only', '-z', base, head, '--', file).length > 0);
if (forbidden.length) {
  console.error('PRs must not change generated dist/ or bin/ files. CI regenerates them on main.');
  console.error('Run `git fetch origin main`, then `git checkout origin/main -- dist bin` and commit the result.');
  console.error('Remove newly added generated files absent from origin/main with git rm.');
  console.error(`Generated paths changed: ${forbidden.map(file => JSON.stringify(file)).join(', ')}`);
  process.exitCode = 1;
}
