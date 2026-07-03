# Generate GitHub Actions autodeploy workflow

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Add a CLI command that generates an inspectable GitHub Actions workflow for
branch-based Hosted Capsule autodeploy. The workflow should run the project's
normal checks, run Sporades release verification, push to the configured Host
server, and rely on the existing Host server release path rather than inventing
a second deployment system.

Define the generated workflow contract in the CLI. The command should accept at
least `--host <alias>`, `--subname <capsule-subname>`, `--branch <branch>`,
`--file <path>`, `--dry-run`, and `--force`. The default file path should be
`.github/workflows/sporades-autodeploy.yml`. The workflow should use Node 22,
install dependencies with `npm ci` when a lockfile exists and `npm install`
otherwise, run `npm test` when the project declares a test script, then run the
existing Sporades release path with `sporades host push --verify`.

The generated workflow must document the required GitHub configuration without
printing secret values. Use stable names unless the command accepts overrides:
`SPORADES_HOST_SSH_PRIVATE_KEY`, `SPORADES_HOST_SERVER`,
`SPORADES_HOST_DOMAIN`, `SPORADES_HOST_REMOTE_ROOT`, and
`SPORADES_HOST_ALIAS`/`SPORADES_HOST_SUBNAME` as variables or command inputs as
appropriate.

## Acceptance criteria

- [ ] `sporades host github workflow write` creates or updates an inspectable GitHub Actions workflow for a selected Hosted Capsule and branch.
- [ ] The command supports explicit `--host`, `--subname`, `--branch`, `--file`, `--dry-run`, and `--force` inputs, with `.github/workflows/sporades-autodeploy.yml` as the default output path.
- [ ] The generated workflow installs dependencies, runs the project test command when present, runs a Sporades release check or equivalent preflight, and runs verified Host push.
- [ ] The generated workflow provisions SSH from GitHub secrets without printing private key material and uses the existing Host profile/release path rather than duplicating deployment logic.
- [ ] Required GitHub secrets and variables are documented in command output without printing secret values.
- [ ] The command supports dry-run or print mode so users and agents can inspect the workflow before writing it.
- [ ] Existing workflow files are not overwritten without an explicit confirmation or force flag.
- [ ] Tests cover workflow generation, branch/subname/profile inputs, dry-run output, existing-file behavior, and generated command structure.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/05-add-hosted-capsule-rollback-command.md
- .scratch/sporades-host-ops-and-autodeploy/issues/06-add-release-verification-around-host-push.md
