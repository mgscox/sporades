# Generated artifacts

`dist/` and `bin/` stay tracked so tooling can use the latest built copy on
main. Never commit changes under either directory in a PR. Update source,
public declarations in `src/types/`, canonical docs, and focused parity tests
together. Run `npm ci`, `npm run typecheck`, and `npm test` locally; `pretest`
builds fresh output and checks its manifest against the local files, without
comparing them to Git. Older committed output on a PR branch is expected.

This exception applies only to `dist/` and `bin/`. Other shipped build outputs,
such as `monitoring/trace/inventory-contract.mjs`, still accompany their source
changes in a PR. Release metadata such as `src/cli/cli-version.ts` remains owned
by the direct-to-main release flow.

Before committing, restore generated files:

```sh
git fetch origin main
git checkout origin/main -- dist bin
```

Commit that restoration if generated files were already committed. Remove any
new generated files absent from main with `git rm`. The PR check rejects
generated additions, edits, deletions, and renames relative to the merge base,
while allowing restoration from current main even if it has advanced.

`.github/workflows/generated-artifacts.yml` uses the repository's local runners
(`self-hosted, linux, x64, sporades`) and Node selected from `package.json`'s
engine range. After a main push, serialized jobs check out the latest main,
run `npm ci` and `npm run build`, then commit only `dist/` and `bin/` as
`chore: regenerate dist and bin [skip ci]` using `GITHUB_TOKEN` with
`contents: write`. Main must permit this token to push; branch protection must
allow the automation. The job does not bypass protections. Token pushes do not
start another workflow; the skip marker, generated-only path exclusion, and bot
actor guard also prevent a loop.

The PR job checks out the trusted base and fetches PR history without checking
out or executing PR scripts on the local runner. Its inline checker is kept in
parity with the standalone local checker by a focused test.

If a concurrent merge rejects the push, the script fetches main, discards its
own generated commit, rebases the source checkout, and installs/builds again.
It retries the push once and fails visibly on another rejection. Rebuilding
after the rebase ensures the manifest seals the latest sources. A no-op build
creates no commit.

Release operators run `scripts/package.mjs` through `npm run package` from a
synchronized **main** checkout, pushing the release commit and tag directly to
main as before. The script still builds and commits release metadata, `dist/`
and `bin/`, and packs those files plus `dist/generated-source-manifest.json`.
There is no PR exemption by label or branch name: release commits go directly
to main. The main workflow can then verify the build without another commit.
`npm run package` publishes; use `npm pack --json --ignore-scripts` after a local
build to inspect a tarball without publishing or tagging.

The focused `node --test test/generated-artifacts-ci.test.js` checks PR history
and runs the regeneration steps against disposable local Git remotes, including
one and two concurrent push races. It does not establish GitHub token or branch
protection permissions; those require the first main workflow run.
