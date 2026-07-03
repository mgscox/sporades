# Report GitHub autodeploy results back to commits or PRs

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Extend the generated GitHub autodeploy workflow so deploy outcomes are visible
from GitHub commit or pull request context. A developer or agent should be able
to see whether the autodeploy succeeded or failed verification without SSHing
into the Host server.

This issue should not add automatic rollback. Reporting should include explicit
rollback guidance when a previous release is available, using the command from
the rollback issue, but the workflow must not run rollback automatically unless
a separate future issue defines that policy.

## Acceptance criteria

- [ ] The generated workflow publishes a GitHub-visible summary for successful deploys, verification failures, and command failures.
- [ ] The summary includes the Hosted Capsule URL, release ID, verification state, and rollback guidance when relevant.
- [ ] When the workflow runs in pull request context, deploy results are associated with the pull request through a supported GitHub Actions mechanism.
- [ ] When the workflow runs on branch push context, deploy results are associated with the commit or workflow run summary.
- [ ] Verification failure reporting suggests an explicit `sporades host rollback <subname> <previous-release-id>` command when a previous release is known, but does not perform rollback.
- [ ] Failure reporting does not expose Host server secrets, SSH material, session tokens, or raw Server env values.
- [ ] Tests cover generated workflow result reporting for success, verification failure, rollback command suggestion, pull request context, and branch push context.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/07-generate-github-actions-autodeploy-workflow.md
