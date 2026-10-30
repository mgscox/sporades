# Generated artifacts

`dist/` and `bin/` stay tracked so tooling can use the latest built copy on
main. Never commit changes under either directory in a PR. Update source,
public declarations in `src/types/`, canonical docs, and focused parity tests
together. Run `npm ci`, `npm run typecheck`, and `npm test` locally; `pretest`
builds fresh output and checks its manifest against the local files, without
comparing them to Git. Older committed output on a PR branch is expected.
See the [native-capability and offline-cache prerequisites](runtime-flake-testing.md#native-capabilities-and-offline-package-installs)
before running the CLI and packed-Capsule tests in a restricted environment.

This exception applies only to `dist/` and `bin/`. Other shipped build outputs,
such as `monitoring/trace/inventory-contract.mjs`, still accompany their source
changes in a PR. Release metadata such as `src/cli/cli-version.ts` remains owned
by the direct-to-main release flow.
CI refuses to commit if a build changes tracked files outside `dist/` and
`bin/`, so the manifest cannot seal uncommitted changes to those files.

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
run `npm ci`, clear the generated directories, and run `npm run build`, then
commit only `dist/` and `bin/` as
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

Clearing the generated directories before each CI build also removes obsolete
tracked files for sources that TypeScript no longer emits.

Release operators normally open a **Release Sporades** issue, retain
`ready-for-human`, then have mgscox or a repository administrator apply exactly
one `release:patch`, `release:minor`, or `release:major` label. The dropdown does
not apply the label automatically. Create the labels once in GitHub's Labels UI;
CI never creates them. See [npm publishing](npm-publishing.md) for authorization,
serialization and recovery. `publish.yml` prepares on main with `contents: write`
using the same code path as the local fallback, `npm run release -- --patch`
(or `--minor` / `--major`) from a clean, synchronized **main** checkout.
Both entry points use `scripts/package.mjs --ci-publish`: it prepares and
atomically pushes the release
commit and annotated tag, then hands publication to
`.github/workflows/publish.yml`. It does not require local `npm login` or call
local `npm publish`. A successful command means the release was queued; verify
the completed Actions run and registry version before upgrading a Host.

The workflow validates the stable tag against both manifests, the canonical
repository, its release commit, and main ancestry. On a fresh standard
GitHub-hosted Ubuntu runner it builds, primes the offline smoke-test cache,
runs typecheck, the full test suite and docs checks, then packs and publishes
the tested output with OIDC and provenance. It does not commit generated output.
The publishing step skips npm lifecycle scripts because `npm test` (normally
invoked by `prepublishOnly`) has already passed in that same job. The single
publish job serves both issue-triggered preparation and manual tag pushes; PR
checks exercise guard, reporting, version preparation and retries
without npm publishing permissions. Issue releases record the issue and bump in
the release commit so reruns reuse the same tag, and report success/failure on
the issue. A token tag push cannot start a second workflow, so preparation and
publication both stay in `publish.yml`.
See [npm publishing setup and recovery](npm-publishing.md).

For explicit interactive local publishing, `npm run package` remains available from a
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
