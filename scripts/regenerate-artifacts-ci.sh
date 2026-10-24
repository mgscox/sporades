#!/usr/bin/env bash
# Run only in CI's disposable main checkout (or a disposable local test clone).
set -euo pipefail

if [[ "$(git branch --show-current)" != main ]]; then
  echo 'Regeneration requires a disposable main checkout.' >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Regeneration requires a clean checkout.' >&2
  exit 1
fi

for attempt in 1 2; do
  npm ci
  npm run build
  git add -A -- dist bin
  if git diff --cached --quiet; then
    echo 'Generated dist/bin are current.'
    exit 0
  fi
  git commit -m 'chore: regenerate dist and bin [skip ci]'
  if git push origin HEAD:refs/heads/main; then
    exit 0
  fi
  if [[ "$attempt" == 2 ]]; then
    echo 'Generated artifact push failed after one retry.' >&2
    exit 1
  fi
  git fetch origin main
  # Rebase the source checkout, not the generated commit: replaying generated
  # bytes could conflict or seal a build of the previous source generation.
  git reset --hard HEAD^
  git rebase origin/main
  # Discard any auxiliary build output before rebuilding the new source tree.
  git restore --worktree -- .
done
