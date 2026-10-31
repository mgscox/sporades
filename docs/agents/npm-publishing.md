# npm publishing

The preferred entry point is a **Release Sporades** GitHub issue, created from
[the release template](https://github.com/mgscox/sporades/issues/new?template=release.yml).
Choose the bump in the form and retain `ready-for-human`, which keeps office
agents from picking up the request. The form cannot apply a label from a dropdown.
After opening the issue, **mgscox or a repository administrator** deliberately
applies exactly one of `release:patch`, `release:minor`, or `release:major`.
The label is authoritative; the dropdown is context only. A 0.x minor bump may
break compatibility, so no bump is inferred from merged PRs.

An administrator must first create these repository labels in GitHub's Labels UI:

| Label | Purpose |
| --- | --- |
| `release:patch` | Explicit patch version bump |
| `release:minor` | Explicit minor version bump |
| `release:major` | Explicit major version bump |
| `ready-for-human` | Reserve the issue for human action (if not already present) |

CI never creates labels. Use one issue per release and keep one release request
active at a time, including manual tag pushes: preparation and publication each
serialize their jobs with cancellation disabled, but publication order across
multiple queued releases is not guaranteed. GitHub may replace an older pending
job if multiple requests queue. Only authorized issues enter the preparation
queue, so unrelated or rejected label events cannot displace pending releases.
Closed issues, conflicting labels, stale label events and unauthorized senders
cannot prepare a release. Rejections of `release:*` labels get an explanation
comment; other labels only produce a workflow notice.

`publish.yml` runs guard → prepare → publish → report on GitHub-hosted runners.
Guard checks the original event sender (not the person clicking rerun), including
an API permission check for administrators other than mgscox, and fetches the
current issue state/labels. Prepare rechecks this authorization, checks out main,
and calls the same `scripts/package.mjs --ci-publish` preparation used locally.
It atomically pushes the release commit and annotated tag with `GITHUB_TOKEN`.
Main branch rules must allow that push, as for generated-artifacts automation;
the workflow does not bypass branch protection. A concurrent main push causes a
safe failure; rerun after it settles. The same publish job serves issue and tag
triggers, explicitly checking out the prepared tag. This is necessary because a
tag pushed by `GITHUB_TOKEN` does not start another workflow, and npm trusts the
`publish.yml` filename. Success comments include the version, npm link and run
link, then close the issue. Failure comments link the run and leave it open.

For an issue-triggered run, GitHub's event ref/SHA identify the main revision
that started the run; checking out the prepared tag does not change that identity.
[npm's provenance generator](https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/provenance.js)
records those event values. The tagged source is independently checked by the
release identity/main-ancestry validation and the checkout SHA in the run log;
registry verification matches the exact tested tarball. The manager's first
labelled release acceptance should inspect the live provenance as well as the
reported tag and npm version. Manual tag-triggered runs retain tag event identity.

The local fallback remains:

```sh
git switch main
git pull --ff-only
npm ci
npm run release -- --patch
```

Use `--minor` or `--major` for those version bumps. The command checks a clean,
synchronized main checkout with the canonical GitHub push remote, updates release
notes/API docs/version metadata, builds, and atomically pushes the release commit
and annotated `vX.Y.Z` tag. GitHub Actions then tests and publishes. It never
requires a local npm login. Pushing a stable release tag manually also triggers
the workflow, but the tag must target the matching `Release vX.Y.Z` commit on main.
Publication does not happen on a normal main push or a PR.

## One-time package configuration

On [Sporades package settings](https://www.npmjs.com/package/sporades/access),
add a GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `mgscox` |
| Repository | `sporades` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allow direct `npm publish` | Enabled |
| Allow `npm dist-tag` | Disabled; this workflow does not use it |

Confirm using the npm account's passkey when prompted. No `NPM_TOKEN` repository
secret is needed. Keep account 2FA enabled. `package.json` declares
`git+https://github.com/mgscox/sporades.git` for provenance.

The workflow uses Node 24 and verifies npm >=11.5.1. npm trusted publishing
requires a supported cloud-hosted runner; the repository's existing LAN runners
continue serving generated-artifact and documentation jobs. Standard
GitHub-hosted runners are free for this public repository, so an Actions spending
budget of zero can remain. The publishing workflow does not upload artifacts or
restore/save npm caches. It uses an isolated runner-local cache for offline tests.

According to [npm's trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/),
a new connection must complete its first successful publish within two days.
Configure it near the first release; if it expires, recreate it before retrying.
Saving the connection alone does not prove OIDC authentication. The first actual
release establishes that evidence.

## Validation and recovery

Check [Publish npm package runs](https://github.com/mgscox/sporades/actions/workflows/publish.yml)
after applying the label or pushing the tag. The release job validates identity before dependency
installation, runs the complete default suite plus typecheck and docs checks,
and publishes only after those steps succeed. Existing optional-service/browser
tests retain their explicit guards; skipped tests are not live-service evidence.
No package publish or Host upgrade is performed by a PR validation run.

The local command reports **pending** publication after the Git push. A failed
job leaves the release commit/tag in Git, and the npm version absent if publication
was never reached. Fix the problem, then re-run the failed Actions job on that
same tag. Issue releases record their issue URL and explicit bump in the release
commit. Rerunning preparation finds that commit on main and reuses its annotated
tag, even if main has advanced; it never bumps again for that issue. Do not change
the bump label to recover. If preparation failed before the atomic push, a rerun
can prepare again. Missing/mismatched tags or duplicate issue commits fail for
manual inspection. Do not delete or move a published tag. If source changes are required,
merge the fix and prepare a new patch release with a new issue.

If the publish step succeeded but a later verification failed, first check
`npm view sporades@X.Y.Z version dist.integrity dist.attestations --json`.
Do not try to replace that version: npm versions are immutable. Compare the
published version/provenance with its tag and the successful publish log.
The workflow retries these read-only checks for up to ten minutes after upload,
plus any already in-flight bounded registry request. npm can acknowledge a
publish before the version and its provenance are visible to registry readers;
the first OIDC release exposed this delay beyond the original 30-second window.
The workflow can then be retried: it skips publishing an existing version only
when its integrity matches the rebuilt tarball and provenance metadata is present.
Different bytes or unavailable provenance fail visibly without another upload.

`npm run package` and its `--resume` mode remain the interactive local fallback;
they still require npm authentication. Do not use that resume path for an Actions
release, because independently built local and Linux tarballs need not be
byte-for-byte identical. Use the Actions retry flow above.

For a local inspection without pushing or publishing, run `npm run build` then
`npm pack --json --ignore-scripts`.

## Local registry rehearsal

The optional service rehearsal reuses Verdaccio 7.0.2 in a disposable loopback
instance with no upstream registry proxy. Install its tools in a disposable worktree-local directory:

```sh
mkdir -p .tmp
rehearsal_tools=$(mktemp -d "$PWD/.tmp/npm-rehearsal.XXXXXX")
npm install --prefix "$rehearsal_tools" --ignore-scripts --no-audit --no-fund verdaccio@7.0.2
node scripts/rehearse-npm-publishing.mjs "$rehearsal_tools"
rm -rf "$rehearsal_tools"
```

The script redirects the actual publication orchestration to the instance,
uses only synthetic local credentials, and exercises denied anonymous publish,
authenticated publish/read/download with exact tarball bytes, duplicate rejection,
and fail-closed retry when provenance is absent. Its registry, credentials, cache,
and package state are removed on exit. Unit tests separately cover retrying a
matching published artifact with synthetic provenance metadata. Neither check
emulates GitHub OIDC, npm account permissions, or real provenance generation;
those require the first actual release.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
