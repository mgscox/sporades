---
name: generate-changes
description: Generate or update a root CHANGES.md from recent Git history and working tree changes. Use when the user asks to create release notes, update CHANGES.md or CHANGELOG.md, summarize changes since the last release, or run /create-changes.
---

# Generate Changes

## Workflow

1. Prefer the bundled script for deterministic repository changelog generation:

   ```bash
   node ./skills/generate-changes/scripts/generate-changes.mjs
   ```

2. Inspect the resulting `CHANGES.md` before finishing. Tighten wording manually when the generated grouping is too mechanical, especially for user-facing features and breaking changes.

3. Treat the most recent Git tag reachable from `HEAD` as the last release. If no release tag exists, use the latest release-like commit whose subject mentions release or publish. If neither exists, summarize all reachable commits and clearly say that no release baseline was found.

4. Include uncommitted tracked and untracked changes so release notes cover the current working tree.

5. Keep the newest generated section at the top of `CHANGES.md`. If the file already exists, replace the top generated section for the same heading instead of duplicating it.

## Formatting

Use concise Markdown with these categories under the generated release section when populated:

- `### 🚀 Features`
- `### 🐛 Bug Fixes`
- `### 🔧 Improvements`
- `### ⚠️ Breaking Changes`
- `### 📝 Documentation`
- `### 🧪 Tests`
- `### 📦 Packaging`

Write entries as user-facing summaries, not raw commit dumps. Keep commit hashes as secondary context in parentheses.

## Package Flow

The repository `npm run package` command runs this skill's script before bumping the package version and publishing, so `CHANGES.md` reflects source changes since the previous release rather than the release commit itself. After `npm publish` succeeds, the package script creates an annotated `vX.Y.Z` Git tag for the published version. The next `/generate-changes` run uses that tag as its release baseline.
